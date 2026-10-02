// game/inventoryService.js — جرد المخزون بالمهام. بيستخدم نفس جداول الجرد الموجودة في الـ ERP
// (inventory_count_sessions / inventory_count_entries) — الأرقام بتتحفظ كمسودة، والاعتماد
// الفعلي على المخزون بيتم من شاشة الجرد الحالية في الـ ERP (finalize) زي ما هو.
const { all, get, run, insert, transaction } = require('../db/database');
const { logAction } = require('../utils/auditLog');
const { getAllowedLocationIds } = require('../utils/locationPermissions');
const cfg = require('./config');
const { GameError } = require('./errors');
const V = require('./validation');
const T = require('./taskService');

async function assertLocationAllowed(user, locationId) {
  const allowed = await getAllowedLocationIds(user);
  if (allowed && !allowed.includes(Number(locationId))) throw new GameError(403, 'FORBIDDEN', 'مش مسموحلك بالمكان ده.');
}

async function sessionProgress(sessionId) {
  const [t, c] = await Promise.all([
    get(`SELECT count(*)::int AS c FROM products WHERE is_active = 1`),
    get(`SELECT count(*)::int AS c FROM inventory_count_entries WHERE session_id = ?`, [sessionId]),
  ]);
  return { counted: c.c, total: t.c, remaining: Math.max(0, t.c - c.c) };
}

async function listLocations(user) {
  const allowed = await getAllowedLocationIds(user);
  const rows = await all(`SELECT l.id, l.name, l.type,
      s.id AS session_id,
      (SELECT count(*) FROM inventory_count_entries e WHERE e.session_id = s.id)::int AS counted
    FROM locations l
    LEFT JOIN inventory_count_sessions s ON s.location_id = l.id AND s.status = 'in_progress'
    WHERE l.is_active = 1 ORDER BY l.id`);
  const total = (await get(`SELECT count(*)::int AS c FROM products WHERE is_active = 1`)).c;
  return rows.filter(r => !allowed || allowed.includes(r.id)).map(r => ({ ...r, counted: r.session_id ? r.counted : 0, total }));
}

async function startSession(user, locationId) {
  const id = parseInt(locationId, 10);
  if (!Number.isInteger(id)) throw new GameError(400, 'INVALID', 'اختار المكان.');
  await assertLocationAllowed(user, id);
  const loc = await get(`SELECT id, name FROM locations WHERE id = ? AND is_active = 1`, [id]);
  if (!loc) throw new GameError(404, 'NOT_FOUND', 'المكان ده مش موجود.');
  let s = await get(`SELECT id FROM inventory_count_sessions WHERE location_id = ? AND status = 'in_progress'`, [id]);
  if (!s) {
    // الـ unique partial index بيضمن جلسة نشطة واحدة لكل مخزن حتى لو اتنين ضغطوا مع بعض
    await run(`INSERT INTO inventory_count_sessions (location_id, started_by) VALUES (?, ?) ON CONFLICT (location_id) WHERE status = 'in_progress' DO NOTHING`, [id, user.id]);
    s = await get(`SELECT id FROM inventory_count_sessions WHERE location_id = ? AND status = 'in_progress'`, [id]);
    if (s) await logAction(user.id, 'game_start_count_session', 'location', id, { session_id: s.id });
  }
  if (!s) throw new GameError(409, 'CONFLICT', 'حصلت مشكلة في بدء الجرد — جرّب تاني.');
  return { session_id: s.id, location: loc, progress: await sessionProgress(s.id) };
}

async function loadSession(user, sessionId) {
  const s = await get(`SELECT s.*, l.name AS location_name FROM inventory_count_sessions s JOIN locations l ON l.id = s.location_id WHERE s.id = ?`, [sessionId]);
  if (!s) throw new GameError(404, 'NOT_FOUND', 'جلسة الجرد مش موجودة.');
  if (s.status !== 'in_progress') throw new GameError(409, 'SESSION_CLOSED', 'جلسة الجرد دي اتقفلت.');
  await assertLocationAllowed(user, s.location_id);
  return s;
}

const PRODUCT_SQL = `SELECT p.id, p.sku, p.name, p.image_path, p.unit, p.allow_fractional_qty, c.name AS category_name
  FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`;

async function nextProduct(user, sessionId) {
  const s = await loadSession(user, sessionId);
  const key = `count:${s.location_id}`;
  const claim = await transaction(async () => {
    await run(`UPDATE game_task_claims SET status = 'expired', finished_at = now() WHERE status = 'active' AND expires_at <= now()`);
    const mine = await all(`SELECT * FROM game_task_claims WHERE user_id = ? AND status = 'active' AND task_key = ?`, [user.id, key]);
    for (const c of mine) {
      const counted = await get(`SELECT 1 AS x FROM inventory_count_entries WHERE session_id = ? AND product_id = ?`, [s.id, c.product_id]);
      if (!counted) {
        const [fresh] = await all(`UPDATE game_task_claims SET expires_at = ${T.leaseSql()} WHERE id = ? RETURNING *`, [cfg.LEASE_SECONDS, c.id]);
        return fresh;
      }
      await run(`UPDATE game_task_claims SET status = 'released', finished_at = now() WHERE id = ?`, [c.id]);
    }
    const cands = await all(`SELECT p.id FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1
        AND NOT EXISTS (SELECT 1 FROM inventory_count_entries e WHERE e.session_id = ? AND e.product_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM game_task_claims g WHERE g.product_id = p.id AND g.task_key = ? AND g.status = 'active' AND g.expires_at > now())
        AND NOT EXISTS (SELECT 1 FROM game_task_skips k WHERE k.product_id = p.id AND k.task_key = ? AND k.user_id = ? AND k.last_skipped_at > now() - make_interval(hours => ?))
      ORDER BY c.name NULLS LAST, p.name, p.id LIMIT 20`,
      [s.id, key, key, user.id, cfg.SKIP_COOLDOWN_HOURS]);
    for (const c of cands) {
      await run(`UPDATE game_task_claims SET status = 'expired', finished_at = now() WHERE product_id = ? AND task_key = ? AND status = 'active' AND expires_at <= now()`, [c.id, key]);
      const id = await insert(`INSERT INTO game_task_claims (product_id, task_key, kind, user_id, expires_at)
        VALUES (?, ?, 'count', ?, ${T.leaseSql()}) ON CONFLICT (product_id, task_key) WHERE status = 'active' DO NOTHING RETURNING id`,
        [c.id, key, user.id, cfg.LEASE_SECONDS]);
      if (!id) continue;
      const counted = await get(`SELECT 1 AS x FROM inventory_count_entries WHERE session_id = ? AND product_id = ?`, [s.id, c.id]);
      if (counted) { await run(`UPDATE game_task_claims SET status = 'released', finished_at = now() WHERE id = ?`, [id]); continue; }
      return get(`SELECT * FROM game_task_claims WHERE id = ?`, [id]);
    }
    return null;
  });
  const progress = await sessionProgress(s.id);
  if (!claim) return { empty: true, progress, location: { id: s.location_id, name: s.location_name } };
  const p = await get(PRODUCT_SQL, [claim.product_id]);
  return {
    empty: false, progress,
    task: {
      claim_id: Number(claim.id), session_id: s.id, kind: 'count', lease_seconds: cfg.LEASE_SECONDS,
      location: { id: s.location_id, name: s.location_name },
      product: { name: p.name, sku: p.sku, category_name: p.category_name, image_path: p.image_path, unit: p.unit, allow_fractional: !!p.allow_fractional_qty },
    },
  };
}

async function answerCount(user, claimId, body = {}) {
  const requestId = body.request_id;
  if (!requestId || typeof requestId !== 'string' || requestId.length > 80) throw new GameError(400, 'INVALID', 'الطلب ناقص.');
  return T.guarded(user, claimId, () => transaction(async () => {
    const locked = await T.lockClaim(user, claimId, requestId, { expectCount: true });
    if (locked.duplicate) return { ...locked.duplicate, duplicate: true };
    const claim = locked.claim;
    const locationId = parseInt(claim.task_key.slice(6), 10);
    const s = await get(`SELECT * FROM inventory_count_sessions WHERE location_id = ? AND status = 'in_progress'`, [locationId]);
    if (!s) throw new GameError(409, 'SESSION_CLOSED', 'جلسة الجرد دي اتقفلت.');
    await assertLocationAllowed(user, locationId);

    const p = await get(`SELECT id, allow_fractional_qty, is_active FROM products WHERE id = ? FOR UPDATE`, [claim.product_id]);
    if (!p || !p.is_active) throw new GameError(410, 'TASK_GONE', 'المنتج ده مبقاش متاح. هنجيبلك اللي بعده.');
    const inv = await get(`SELECT quantity FROM inventory WHERE product_id = ? AND location_id = ?`, [p.id, locationId]);
    const systemQty = inv ? inv.quantity : 0;

    const v = V.validateQuantity(body.qty, { allowFractional: !!p.allow_fractional_qty, systemQty, confirmed: !!body.confirm });
    if (!v.ok) throw new GameError(422, v.code, v.message);

    const prev = await get(`SELECT counted_qty FROM inventory_count_entries WHERE session_id = ? AND product_id = ?`, [s.id, p.id]);
    // system_qty_snapshot بيتسجّل أول مرة بس (مرجع "الرصيد وقت الجرد") — زي منطق الجرد الحالي بالظبط
    await run(`INSERT INTO inventory_count_entries (session_id, product_id, system_qty_snapshot, counted_qty, counted_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id, product_id) DO UPDATE SET counted_qty = EXCLUDED.counted_qty, counted_by = EXCLUDED.counted_by,
        updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')`, [s.id, p.id, systemQty, v.value, user.id]);
    await run(`UPDATE inventory_count_sessions SET updated_at = TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`, [s.id]);
    await logAction(user.id, 'game_inventory_count', 'product', p.id, { session_id: s.id, location_id: locationId, old: prev ? prev.counted_qty : null, new: v.value });

    const extra = { inventory_progress: await sessionProgress(s.id) };
    return T.finishAndBuild({
      user, claim, action: 'count', field: 'count', oldValue: prev ? String(prev.counted_qty) : null,
      newValue: String(v.value), requestId, locationId, extra,
    });
  }));
}

module.exports = { listLocations, startSession, nextProduct, answerCount };
