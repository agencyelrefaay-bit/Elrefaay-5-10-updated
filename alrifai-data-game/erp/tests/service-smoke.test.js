// Smoke test بدون Postgres: بنحقن "داتابيز مزيّفة" مكان src/db/database ونشغّل مسارات الخدمات كاملة.
// بيثبت: مفيش أخطاء JS في المسارات، وإن عدد علامات ? في كل استعلام = عدد الـ params (أشهر مصدر
// أخطاء مع الـ shim). مش بيثبت صحة SQL نفسه — ده شغل tests/integration.concurrency.test.js على Postgres حقيقي.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const calls = [];
const claim = { id: 1, user_id: 7, product_id: 5, task_key: 'sale_price', kind: 'missing', status: 'active', expires_at: new Date() };
const product = { id: 5, sku: 'S1', name: 'نجفة', sale_price: 0, cost_price: 0, category_id: null, color_preset: 'none', color_hex: null, image_path: null, is_active: 1, category_name: null,
  tok_name: 'نجفة', tok_sale_price: '0', tok_cost_price: '0', tok_category: null, tok_color: 'none:', tok_image: '' };
const check = (sql, params) => {
  const q = (sql.match(/\?/g) || []).length;
  assert.equal(q, (params || []).length, `عدد ? (${q}) ≠ عدد params (${(params || []).length}) في:\n${sql.slice(0, 200)}`);
  calls.push(sql);
};
const hooks = {};
const fake = {
  async all(sql, p = []) {
    check(sql, p);
    if (hooks.all) { const o = hooks.all(sql, p); if (o !== undefined) return o; }
    if (/INSERT INTO game_achievements/.test(sql)) return [{ code: 'first_task' }];
    if (/UPDATE game_task_claims .*RETURNING \*/s.test(sql)) return [claim];
    if (/ORDER BY prio DESC, product_id LIMIT 40/.test(sql)) return [{ product_id: 5, task_key: 'sale_price', kind: 'missing', prio: 90 }];
    if (/SELECT p\.id FROM products p/.test(sql)) return [{ id: 5 }];
    if (/SELECT \* FROM game_task_claims WHERE user_id/.test(sql)) return [];
    return [];
  },
  async get(sql, p = []) {
    check(sql, p);
    if (hooks.get) { const o = hooks.get(sql, p); if (o !== undefined) return o; }
    if (/FROM game_task_claims WHERE id = \? FOR UPDATE/.test(sql)) return claim;
    if (/FROM game_task_claims WHERE id = \?$/.test(sql.trim())) return claim;
    if (/SELECT result FROM game_actions/.test(sql)) return null;
    if (/FROM products p LEFT JOIN categories c/.test(sql)) return product;
    if (/AS tok FROM products p/.test(sql)) return { tok: '2700' };
    if (/AS need FROM products/.test(sql)) return { need: true };
    if (/AS done FROM products/.test(sql)) return { done: true };
    if (/COALESCE\(SUM\(xp\)/.test(sql)) return { xp: 35 };
    if (/FILTER \(WHERE action IN/.test(sql)) return { total: 1, price: 1, image: 0, inventory: 0, products: 1 };
    if (/AS today/.test(sql)) return { today: '2026-10-01' };
    if (/AS c FROM game_actions/.test(sql)) return { c: 1 };
    if (/FROM locations WHERE id/.test(sql)) return { id: 1, name: 'المعرض' };
    if (/FROM inventory_count_sessions s JOIN locations/.test(sql)) return { id: 3, location_id: 1, location_name: 'المعرض', status: 'in_progress' };
    if (/FROM inventory_count_sessions WHERE location_id/.test(sql)) return { id: 3, location_id: 1, status: 'in_progress' };
    if (/count\(\*\)::int AS c FROM products/.test(sql)) return { c: 100 };
    if (/FROM inventory_count_entries WHERE session_id = \? AND product_id/.test(sql)) return null;
    if (/count\(\*\)::int AS c FROM inventory_count_entries/.test(sql)) return { c: 4 };
    if (/FROM products WHERE id = \? FOR UPDATE/.test(sql)) return { id: 5, allow_fractional_qty: 0, is_active: 1 };
    if (/FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = \?$/.test(sql.trim())) return { id: 5, name: 'نجفة', sku: 'S1', unit: 'piece', allow_fractional_qty: 0 };
    return null;
  },
  async run(sql, p = []) { check(sql, p); },
  async insert(sql, p = []) { check(sql, p); return 99; },
  async transaction(fn) { return fn(); },
};
const dbPath = require.resolve('../src/db/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake };

const user = { id: 7, role: 'warehouse', full_name: 'موظف', can_view_cost_price: false };
const tasks = require('../src/game/taskService');
const inv = require('../src/game/inventoryService');
const stats = require('../src/game/statsService');

test('claimNext يرجّع مهمة ويبني payload', async () => {
  const r = await tasks.claimNext(user, 'prices');
  assert.equal(r.empty, false);
  assert.equal(r.task.field, 'sale_price');
  assert.equal(r.task.claim_id, 1);
  assert.ok(calls.some(s => /ON CONFLICT \(product_id, task_key\) WHERE status = 'active' DO NOTHING/.test(s)), 'لازم الحجز يعتمد على الـ unique partial index');
});

test('claimNext: موظف بدون صلاحية التكلفة ما يشوفش cost_price في الاستعلام', async () => {
  calls.length = 0;
  await tasks.claimNext(user, 'prices');
  const union = calls.find(s => /UNION ALL|FROM \(/.test(s)) || calls.find(s => /task_key AS|'sale_price'::text/.test(s));
  assert.ok(union && !/'cost_price'::text/.test(union));
  calls.length = 0;
  await tasks.claimNext({ ...user, role: 'manager' }, 'prices');
  assert.ok(calls.some(s => /'cost_price'::text/.test(s)), 'المدير لازم يشوف cost_price');
});

test('submitAnswer set سعر: يكتب المنتج + الحالة + الإجراء + يكمّل الـ claim ويرجّع XP', async () => {
  calls.length = 0;
  const r = await tasks.submitAnswer(user, 1, { action: 'set', value: '2700', request_id: 'req-1', token: '0' });
  assert.equal(r.ok, true);
  assert.equal(r.xp_gained, 10);
  assert.equal(r.bonus_xp, 25);
  assert.equal(r.product_completed, true);
  assert.equal(r.total_xp, 35);
  assert.ok(calls.some(s => /UPDATE products SET sale_price/.test(s)));
  assert.ok(calls.some(s => /INSERT INTO game_field_state/.test(s)));
  assert.ok(calls.some(s => /INSERT INTO audit_log/.test(s)), 'لازم يتسجل في audit_log بتاع الـ ERP');
  assert.ok(calls.some(s => /SET status = 'completed'/.test(s)));
});

test('submitAnswer: مدخلات غير صالحة', async () => {
  await assert.rejects(() => tasks.submitAnswer(user, 1, { action: 'hack', request_id: 'x' }), { code: 'INVALID' });
  await assert.rejects(() => tasks.submitAnswer(user, 1, { action: 'set', value: '2700' }), { code: 'INVALID' });          // من غير request_id
  await assert.rejects(() => tasks.submitAnswer(user, 1, { action: 'set', value: '-5', request_id: 'r2', token: '0' }), { code: 'INVALID' });
  await assert.rejects(() => tasks.submitAnswer(user, 1, { action: 'set', value: '5000000', request_id: 'r3', token: '0' }), { code: 'CONFIRM_REQUIRED' });
  await assert.rejects(() => tasks.submitAnswer(user, 1, { action: 'confirm', request_id: 'r4', token: '0' }), { code: 'INVALID' }); // kind=missing مينفعش confirm
  await assert.rejects(() => tasks.submitAnswer(user, 1, { action: 'set', value: '10', request_id: 'r5', token: 'STALE' }), { code: 'STALE_VALUE' });
});

test('skipTask / heartbeat / release بتنفّذ بدون أخطاء', async () => {
  assert.deepEqual(await tasks.skipTask(user, 1, 'skip-1'), { ok: true });
  assert.deepEqual(await tasks.releaseTask(user, 1), { ok: true });
  await assert.rejects(() => tasks.heartbeat(user, 1)); // all() المزيّفة بترجّع [] لـ UPDATE بدون RETURNING * → CLAIM_LOST
});

test('رفع صورة: يرفض ملف مش صورة، ويقبل JPEG ويكتب ملف باسم آمن ثم يحدّث image_path', async () => {
  await assert.rejects(() => tasks.completeImageUpload(user, 1, Buffer.from('not an image at all'), 'u1'), { code: 'INVALID_IMAGE' });
  const imgClaim = { ...claim, task_key: 'image', kind: 'missing' };
  hooks.get = sql => (/FROM game_task_claims WHERE id = \?/.test(sql) ? imgClaim : undefined);
  try {
    calls.length = 0;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const r = await tasks.completeImageUpload(user, 1, jpeg, 'u2');
    assert.match(r.image_path, /^\/uploads\/products\/p5-\d+-[0-9a-f]{8}\.jpg$/);
    assert.ok(calls.some(s => /UPDATE products SET image_path/.test(s)));
    const file = path.join(__dirname, '../src/uploads/products', path.basename(r.image_path));
    assert.ok(fs.existsSync(file)); fs.unlinkSync(file);
  } finally { delete hooks.get; }
});

test('الجرد: start / next / answer', async () => {
  const s = await inv.startSession({ ...user, role: 'admin' }, 1);
  assert.equal(s.session_id, 3);
  const cclaim = { id: 2, user_id: 7, product_id: 5, task_key: 'count:1', kind: 'count', status: 'active', expires_at: new Date() };
  hooks.get = sql => (/FROM game_task_claims WHERE id = \?/.test(sql) ? cclaim : undefined);
  hooks.all = sql => (/SELECT \* FROM game_task_claims WHERE user_id = \? AND status = 'active' AND task_key = \?/.test(sql) ? [] : undefined);
  try {
    const n = await inv.nextProduct({ ...user, role: 'admin' }, 3);
    assert.equal(n.empty, false); assert.equal(n.task.kind, 'count');
    const r = await inv.answerCount({ ...user, role: 'admin' }, 2, { qty: '7', request_id: 'c1' });
    assert.equal(r.xp_gained, 10);
    assert.ok(r.inventory_progress);
    await assert.rejects(() => inv.answerCount({ ...user, role: 'admin' }, 2, { qty: '-1', request_id: 'c2' }), { code: 'INVALID' });
    await assert.rejects(() => inv.answerCount({ ...user, role: 'admin' }, 2, { qty: '800', request_id: 'c3' }), { code: 'CONFIRM_REQUIRED' });
  } finally { delete hooks.get; delete hooks.all; }
});

test('stats: getMe و getAdminStats بيشتغلوا (تحقق من الـ params فقط)', async () => {
  hooks.get = (sql) => {
    if (/count\(\*\)::int AS total/.test(sql)) {
      const row = { total: 10, complete: 2 };
      for (const f of ['name', 'sale_price', 'cost_price', 'category', 'color', 'image']) { row[f + '_missing'] = 1; row[f + '_unverified'] = 2; }
      return row;
    }
    if (/count\(DISTINCT user_id\)|count\(\*\)::int AS c FROM game_task_claims/.test(sql)) return { c: 3 };
    return undefined;
  };
  try {
    const me = await stats.getMe(user);
    assert.equal(me.overall.total_products, 10);
    assert.equal(me.achievements.length, 10);
    const a = await stats.getAdminStats();
    assert.equal(a.pending_tasks, 18);
  } finally { delete hooks.get; }
});
