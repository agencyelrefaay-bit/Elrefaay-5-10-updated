// game/taskService.js — مطالبة (claim) المهام، حفظ الإجابات، التخطي، رفع الصور
// كل ضمانات التزامن في الداتابيز:
//   • uq_game_active_claim (unique partial index) يمنع claim نشط ثاني لنفس (منتج، مهمة)
//   • SELECT ... FOR UPDATE على صف الـ claim وصف المنتج داخل transaction
//   • request_id فريد ← الإرسال المكرر يرجّع نفس النتيجة (idempotent)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { all, get, run, insert, transaction } = require('../db/database');
const { logAction } = require('../utils/auditLog');
const cfg = require('./config');
const { GameError } = require('./errors');
const F = require('./fields');
const V = require('./validation');
const { xpForAction } = require('./gamification');
const stats = require('./statsService');

const UPLOAD_DIR = path.join(__dirname, '../uploads/products');
const CONFLICT_CODES = ['CLAIM_LOST', 'STALE_VALUE', 'TASK_GONE'];

const CUR_SQL = `SELECT p.id, p.sku, p.name, p.sale_price, p.cost_price, p.category_id, p.color_preset, p.color_hex,
    p.image_path, p.is_active, c.name AS category_name,
    ${cfg.ALL_FIELDS.map(f => `${F.VALUE[f]} AS tok_${f}`).join(', ')}
  FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`;

function leaseSql() { return `now() + make_interval(secs => ?)`; }

function buildPayload(claim, row) {
  const field = claim.task_key;
  const current = {
    name: row.name, sale_price: row.sale_price, cost_price: row.cost_price,
    category_id: row.category_id, color: { preset: row.color_preset, hex: row.color_hex }, image_path: row.image_path,
  }[{ name: 'name', sale_price: 'sale_price', cost_price: 'cost_price', category: 'category_id', color: 'color', image: 'image_path' }[field]];
  return {
    claim_id: Number(claim.id), field, kind: claim.kind, token: row['tok_' + field],
    expires_at: claim.expires_at, lease_seconds: cfg.LEASE_SECONDS,
    product: { name: row.name, sku: row.sku, category_name: row.category_name, image_path: row.image_path },
    current,
  };
}

async function needsNow(productId, field) {
  const r = await get(`SELECT ${F.needExpr(field)} AS need FROM products p WHERE p.id = ? AND p.is_active = 1`, [productId]);
  return !!(r && r.need);
}

// ─── مطالبة المهمة التالية ───
async function claimNext(user, mode = 'all') {
  const wanted = cfg.MODES[mode] || cfg.MODES.all;
  const fields = wanted.filter(f => stats.allowedFields(user).includes(f));

  const claimed = await transaction(async () => {
    await run(`UPDATE game_task_claims SET status = 'expired', finished_at = now() WHERE status = 'active' AND expires_at <= now()`);

    // 1) استئناف: لو عند المستخدم مهمة شغالة (قفل التطبيق/غيّر الجهاز) نرجّعله نفس المهمة
    const mine = await all(`SELECT * FROM game_task_claims WHERE user_id = ? AND status = 'active' AND task_key NOT LIKE 'count:%' ORDER BY claimed_at`, [user.id]);
    for (const c of mine) {
      if (fields.includes(c.task_key) && await needsNow(c.product_id, c.task_key)) {
        const [fresh] = await all(`UPDATE game_task_claims SET expires_at = ${leaseSql()} WHERE id = ? RETURNING *`, [cfg.LEASE_SECONDS, c.id]);
        return fresh;
      }
      await run(`UPDATE game_task_claims SET status = 'released', finished_at = now() WHERE id = ?`, [c.id]);
    }

    if (!fields.length) return null;

    // 2) مرشحين بالأولوية — اختيار من الداتابيز، مش من الفرونت
    const params = [];
    const branches = fields.map(f => {
      params.push(user.id, cfg.SKIP_COOLDOWN_HOURS);
      return `(SELECT p.id AS product_id, '${f}'::text AS task_key, ${F.kindExpr(f)}::text AS kind, ${F.prioExpr(f)} AS prio
        FROM products p
        WHERE p.is_active = 1 AND ${F.needExpr(f)}
          AND NOT EXISTS (SELECT 1 FROM game_task_claims c WHERE c.product_id = p.id AND c.task_key = '${f}' AND c.status = 'active' AND c.expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM game_task_skips k WHERE k.product_id = p.id AND k.task_key = '${f}' AND k.user_id = ? AND k.last_skipped_at > now() - make_interval(hours => ?))
        ORDER BY prio DESC, p.id LIMIT 25)`;
    });
    const candidates = await all(`SELECT * FROM (${branches.join(' UNION ALL ')}) t ORDER BY prio DESC, product_id LIMIT 40`, params);

    for (const c of candidates) {
      // نحرّر claim منتهي على نفس المهمة (لو لسه ما اتكنّسش) عشان الـ unique index يسمح
      await run(`UPDATE game_task_claims SET status = 'expired', finished_at = now() WHERE product_id = ? AND task_key = ? AND status = 'active' AND expires_at <= now()`, [c.product_id, c.task_key]);
      const id = await insert(
        `INSERT INTO game_task_claims (product_id, task_key, kind, user_id, expires_at)
         VALUES (?, ?, ?, ?, ${leaseSql()}) ON CONFLICT (product_id, task_key) WHERE status = 'active' DO NOTHING RETURNING id`,
        [c.product_id, c.task_key, c.kind, user.id, cfg.LEASE_SECONDS]);
      if (!id) continue;                              // واحد تاني سبقنا — جرّب اللي بعده
      if (!(await needsNow(c.product_id, c.task_key))) { // اتحلّت بين الاختيار والحجز
        await run(`UPDATE game_task_claims SET status = 'released', finished_at = now() WHERE id = ?`, [id]);
        continue;
      }
      return get(`SELECT * FROM game_task_claims WHERE id = ?`, [id]);
    }
    return null;
  });

  if (!claimed) return { empty: true };
  const row = await get(CUR_SQL, [claimed.product_id]);
  if (!row) return { empty: true };
  return { empty: false, task: buildPayload(claimed, row) };
}

// ─── مساعد: تسجيل الإجراء + إنهاء الـ claim + مكافأة اكتمال المنتج + إنجازات ───
async function finishAndBuild({ user, claim, action, field, oldValue, newValue, requestId, locationId = null, completeClaim = true, extra = {} }) {
  const xp = xpForAction({ field, kind: claim.kind, action });
  const actionId = await insert(
    `INSERT INTO game_actions (request_id, user_id, product_id, task_key, action, old_value, new_value, xp, claim_id, location_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [requestId || null, user.id, claim.product_id, claim.task_key, action, oldValue ?? null, newValue ?? null, xp, claim.id, locationId]);

  if (completeClaim) await run(`UPDATE game_task_claims SET status = 'completed', finished_at = now() WHERE id = ?`, [claim.id]);

  let bonus = 0, productCompleted = false;
  if (!claim.task_key.startsWith('count:') && action !== 'reject_image') {
    const d = await get(`SELECT NOT ${F.anyNeedExpr()} AS done FROM products p WHERE p.id = ?`, [claim.product_id]);
    if (d && d.done) {
      const bid = await insert(
        `INSERT INTO game_actions (user_id, product_id, task_key, action, xp, claim_id) VALUES (?, ?, ?, 'product_complete', ?, ?)
         ON CONFLICT (product_id) WHERE action = 'product_complete' DO NOTHING RETURNING id`,
        [user.id, claim.product_id, claim.task_key, cfg.XP.product_complete, claim.id]);
      if (bid) { bonus = cfg.XP.product_complete; productCompleted = true; }
    }
  }
  stats.invalidateOverview();
  const progress = await stats.userProgress(user.id, { unlock: true });
  const result = { ok: true, xp_gained: xp, bonus_xp: bonus, product_completed: productCompleted, ...progress, ...extra };
  await run(`UPDATE game_actions SET result = ?::jsonb WHERE id = ?`, [JSON.stringify(result), actionId]);
  return result;
}

// ─── مساعد: فتح الـ claim بقفل + فحوصات الملكية/التكرار/الصلاحية ───
async function lockClaim(user, claimId, requestId, { expectCount = false } = {}) {
  const claim = await get(`SELECT * FROM game_task_claims WHERE id = ? FOR UPDATE`, [claimId]);
  if (!claim) throw new GameError(410, 'TASK_GONE', 'المهمة دي مبقتش موجودة (ممكن المنتج اتحذف). هنجيبلك اللي بعدها.');
  if (claim.user_id !== user.id) throw new GameError(409, 'CLAIM_LOST', 'المهمة دي اتحوّلت لزميل تاني. هنجيبلك مهمة جديدة.');
  if (requestId) {
    const dup = await get(`SELECT result FROM game_actions WHERE request_id = ?`, [requestId]);
    if (dup && dup.result) return { duplicate: dup.result };
  }
  if (expectCount !== claim.task_key.startsWith('count:')) throw new GameError(400, 'INVALID', 'نوع المهمة غير مناسب.');
  if (claim.status === 'expired') {
    // انتهت المهلة بس محدش خدها: نجددها (لو حد خدها الـ unique index هيرفض → CLAIM_LOST)
    const [c] = await all(`UPDATE game_task_claims SET status = 'active', finished_at = NULL, expires_at = ${leaseSql()}
        WHERE id = ? AND status = 'expired' AND NOT EXISTS (SELECT 1 FROM game_task_claims o WHERE o.product_id = ? AND o.task_key = ? AND o.status = 'active') RETURNING *`,
      [cfg.LEASE_SECONDS, claim.id, claim.product_id, claim.task_key]);
    if (!c) throw new GameError(409, 'CLAIM_LOST', 'المهمة دي اتحوّلت لزميل تاني. هنجيبلك مهمة جديدة.');
    return { claim: c };
  }
  if (claim.status !== 'active') throw new GameError(409, 'CLAIM_LOST', 'المهمة دي اتقفلت قبل كده. هنجيبلك مهمة جديدة.');
  return { claim };
}

async function logConflict(user, claimId, err) {
  try {
    await run(`INSERT INTO game_actions (user_id, task_key, action, claim_id, detail) VALUES (?, NULL, 'conflict', ?, ?)`,
      [user.id, claimId || null, `${err.code}: ${err.message}`]);
  } catch (_) { /* best-effort */ }
}
async function guarded(user, claimId, fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof GameError && CONFLICT_CODES.includes(e.code)) await logConflict(user, claimId, e);
    if (e && e.code === '23505') {
      const ge = new GameError(409, 'CLAIM_LOST', 'المهمة دي اتحوّلت لزميل تاني. هنجيبلك مهمة جديدة.');
      await logConflict(user, claimId, ge);
      throw ge;
    }
    throw e;
  }
}

async function upsertState(productId, field, status, snapshot, userId) {
  await run(`INSERT INTO game_field_state (product_id, field, status, value_snapshot, actor_id, updated_at) VALUES (?, ?, ?, ?, ?, now())
    ON CONFLICT (product_id, field) DO UPDATE SET status = EXCLUDED.status, value_snapshot = EXCLUDED.value_snapshot, actor_id = EXCLUDED.actor_id, updated_at = now()`,
    [productId, field, status, snapshot, userId]);
}

async function applySet(user, field, row, body) {
  const pid = row.id;
  if (field === 'name') {
    const v = V.validateName(body.value); if (!v.ok) throw new GameError(422, v.code, v.message);
    await run(`UPDATE products SET name = ?, updated_at = datetime('now') WHERE id = ?`, [v.value, pid]);
  } else if (field === 'sale_price' || field === 'cost_price') {
    if (field === 'cost_price' && !stats.canSeeCost(user)) throw new GameError(403, 'FORBIDDEN', 'مش مسموحلك تعدّل سعر التكلفة.');
    const isSale = field === 'sale_price';
    const v = V.validatePrice(body.value, { confirmed: !!body.confirm, isSale, otherPrice: isSale ? row.cost_price : row.sale_price });
    if (!v.ok) throw new GameError(422, v.code, v.message);
    if (isSale) await run(`UPDATE products SET sale_price = ?, updated_at = datetime('now') WHERE id = ?`, [v.value, pid]);
    else await run(`UPDATE products SET cost_price = ?, updated_at = datetime('now') WHERE id = ?`, [v.value, pid]);
  } else if (field === 'category') {
    const id = parseInt(body.value, 10);
    const cat = Number.isInteger(id) ? await get(`SELECT id FROM categories WHERE id = ?`, [id]) : null;
    if (!cat) throw new GameError(422, 'INVALID', 'اختار تصنيف من القائمة.');
    await run(`UPDATE products SET category_id = ?, updated_at = datetime('now') WHERE id = ?`, [id, pid]);
  } else if (field === 'color') {
    const v = V.validateColor(body.value); if (!v.ok) throw new GameError(422, v.code, v.message);
    await run(`UPDATE products SET color_preset = ?, color_hex = ?, updated_at = datetime('now') WHERE id = ?`, [v.value.preset, v.value.hex, pid]);
  } else {
    throw new GameError(400, 'INVALID', 'الحقل ده مش بيتعدّل من هنا.');
  }
}

// ─── حفظ إجابة: confirm | set | reject_image ───
async function submitAnswer(user, claimId, body = {}) {
  const { action, request_id: requestId, token } = body;
  if (!['confirm', 'set', 'reject_image'].includes(action)) throw new GameError(400, 'INVALID', 'إجراء غير معروف.');
  if (!requestId || typeof requestId !== 'string' || requestId.length > 80) throw new GameError(400, 'INVALID', 'الطلب ناقص.');

  return guarded(user, claimId, () => transaction(async () => {
    const locked = await lockClaim(user, claimId, requestId);
    if (locked.duplicate) return { ...locked.duplicate, duplicate: true };
    const claim = locked.claim, field = claim.task_key;

    const row = await get(`${CUR_SQL} FOR UPDATE OF p`, [claim.product_id]);
    if (!row || !row.is_active) throw new GameError(410, 'TASK_GONE', 'المنتج ده مبقاش متاح. هنجيبلك اللي بعده.');
    if (token !== undefined && token !== null && String(token) !== String(row['tok_' + field])) {
      throw new GameError(409, 'STALE_VALUE', 'المنتج ده اتعدّل من مكان تاني. هنحدّث البيانات ونسألك تاني.');
    }
    const oldTok = row['tok_' + field];

    if (action === 'reject_image') {
      if (field !== 'image' || !row.image_path) throw new GameError(400, 'INVALID', 'مفيش صورة نرفضها.');
      await upsertState(row.id, 'image', 'rejected', oldTok, user.id);
      await run(`UPDATE game_task_claims SET kind = 'replace', expires_at = ${leaseSql()} WHERE id = ?`, [cfg.LEASE_SECONDS, claim.id]);
      await insert(`INSERT INTO game_actions (request_id, user_id, product_id, task_key, action, old_value, xp, claim_id) VALUES (?, ?, ?, 'image', 'reject_image', ?, 0, ?)`,
        [requestId, user.id, row.id, oldTok, claim.id]);
      await logAction(user.id, 'game_reject_image', 'product', row.id, { old: oldTok });
      return { ok: true, next: 'upload', xp_gained: 0 };
    }

    if (action === 'confirm') {
      if (claim.kind !== 'verify') throw new GameError(400, 'INVALID', 'مفيش قيمة نأكدها — لازم تدخل القيمة.');
      if (field === 'image' && !row.image_path) throw new GameError(400, 'INVALID', 'مفيش صورة نأكدها.');
      await upsertState(row.id, field, 'verified', oldTok, user.id);
      await logAction(user.id, 'game_verify_' + field, 'product', row.id, { value: oldTok });
      return finishAndBuild({ user, claim, action: 'confirm', field, oldValue: oldTok, newValue: oldTok, requestId });
    }

    // set
    if (field === 'image') throw new GameError(400, 'INVALID', 'الصورة بتترفع من شاشة الصورة.');
    await applySet(user, field, row, body);
    const after = await get(`SELECT ${F.VALUE[field]} AS tok FROM products p WHERE p.id = ?`, [row.id]);
    await upsertState(row.id, field, 'verified', after.tok, user.id);
    await logAction(user.id, 'game_set_' + field, 'product', row.id, { old: oldTok, new: after.tok });
    return finishAndBuild({ user, claim, action: 'set', field, oldValue: oldTok, newValue: after.tok, requestId });
  }));
}

async function skipTask(user, claimId, requestId) {
  return guarded(user, claimId, () => transaction(async () => {
    const claim = await get(`SELECT * FROM game_task_claims WHERE id = ? FOR UPDATE`, [claimId]);
    if (!claim) return { ok: true };                     // المنتج اتحذف — نعتبرها تمت
    if (claim.user_id !== user.id) return { ok: true };  // مش بتاعته — مفيش داعي لخطأ
    if (requestId) {
      const dup = await get(`SELECT id FROM game_actions WHERE request_id = ?`, [requestId]);
      if (dup) return { ok: true, duplicate: true };
    }
    if (claim.status === 'active' || claim.status === 'expired') {
      const loc = claim.task_key.startsWith('count:') ? parseInt(claim.task_key.slice(6), 10) : null;
      await run(`UPDATE game_task_claims SET status = 'skipped', finished_at = now() WHERE id = ? AND status IN ('active','expired')`, [claim.id]);
      await run(`INSERT INTO game_task_skips (product_id, task_key, user_id) VALUES (?, ?, ?)
        ON CONFLICT (product_id, task_key, user_id) DO UPDATE SET skip_count = game_task_skips.skip_count + 1, last_skipped_at = now()`,
        [claim.product_id, claim.task_key, user.id]);
      await insert(`INSERT INTO game_actions (request_id, user_id, product_id, task_key, action, xp, claim_id, location_id) VALUES (?, ?, ?, ?, 'skip', 0, ?, ?)`,
        [requestId || null, user.id, claim.product_id, claim.task_key, claim.id, loc]);
    }
    return { ok: true };
  }));
}

async function heartbeat(user, claimId) {
  const rows = await all(`UPDATE game_task_claims SET expires_at = ${leaseSql()} WHERE id = ? AND user_id = ? AND status = 'active' RETURNING id`, [cfg.LEASE_SECONDS, claimId, user.id]);
  if (!rows.length) throw new GameError(409, 'CLAIM_LOST', 'المهمة دي اتحوّلت لزميل تاني. هنجيبلك مهمة جديدة.');
  return { ok: true };
}

async function releaseTask(user, claimId) {
  await run(`UPDATE game_task_claims SET status = 'released', finished_at = now() WHERE id = ? AND user_id = ? AND status = 'active'`, [claimId, user.id]);
  return { ok: true };
}

// ─── رفع صورة المنتج ───
async function completeImageUpload(user, claimId, buffer, requestId) {
  if (!requestId || typeof requestId !== 'string' || requestId.length > 80) throw new GameError(400, 'INVALID', 'الطلب ناقص.');
  const type = V.detectImageType(buffer);
  if (!type) throw new GameError(422, 'INVALID_IMAGE', 'الملف ده مش صورة صالحة. جرّب صورة JPG أو PNG.');

  // فحص مبكر قبل ما نكتب أي ملف على الديسك
  const pre = await get(`SELECT * FROM game_task_claims WHERE id = ?`, [claimId]);
  if (!pre) throw new GameError(410, 'TASK_GONE', 'المنتج ده مبقاش متاح. هنجيبلك اللي بعده.');
  if (pre.user_id !== user.id || pre.task_key !== 'image') throw new GameError(409, 'CLAIM_LOST', 'المهمة دي اتحوّلت لزميل تاني. هنجيبلك مهمة جديدة.');

  // اسم ملف حتمي وآمن: p<id>-<timestamp>-<random>.<ext> — مفيش أي حرف عربي أو مسافات من اسم المنتج
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `p${pre.product_id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${type.ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, buffer, { flag: 'wx' });
  const publicPath = `/uploads/products/${filename}`;

  try {
    const result = await guarded(user, claimId, () => transaction(async () => {
      const locked = await lockClaim(user, claimId, requestId);
      if (locked.duplicate) return { ...locked.duplicate, duplicate: true, _discard: true };
      const claim = locked.claim;
      if (claim.task_key !== 'image') throw new GameError(400, 'INVALID', 'نوع المهمة غير مناسب.');
      const row = await get(`${CUR_SQL} FOR UPDATE OF p`, [claim.product_id]);
      if (!row || !row.is_active) throw new GameError(410, 'TASK_GONE', 'المنتج ده مبقاش متاح. هنجيبلك اللي بعده.');
      const oldPath = row.image_path || '';
      // الصورة القديمة بتفضل على الديسك (مفيش مسح لأي صورة)؛ بس image_path بيشاور على الجديدة
      await run(`UPDATE products SET image_path = ?, updated_at = datetime('now') WHERE id = ?`, [publicPath, row.id]);
      await upsertState(row.id, 'image', 'verified', publicPath, user.id);
      await logAction(user.id, 'game_upload_image', 'product', row.id, { old: oldPath, new: publicPath });
      const res = await finishAndBuild({ user, claim, action: 'upload', field: 'image', oldValue: oldPath, newValue: publicPath, requestId, extra: { image_path: publicPath } });
      return res;
    }));
    if (result._discard) { fs.unlink(filePath, () => {}); delete result._discard; }
    return result;
  } catch (e) {
    fs.unlink(filePath, () => {}); // فشل الحفظ في الداتابيز → منسيبش ملف يتيم
    throw e;
  }
}

module.exports = {
  claimNext, submitAnswer, skipTask, heartbeat, releaseTask, completeImageUpload,
  // مشتركة مع الجرد
  lockClaim, guarded, finishAndBuild, leaseSql, CUR_SQL,
};
