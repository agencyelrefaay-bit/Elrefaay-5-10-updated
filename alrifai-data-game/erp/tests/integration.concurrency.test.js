// اختبار تكامل حقيقي على PostgreSQL — بيثبت التزامن فعلياً (5-10 مستخدمين في نفس اللحظة).
// ⚠️ شغّله على قاعدة بيانات اختبار منفصلة فقط (اسمها لازم يحتوي على "test")، مش على الإنتاج:
//   TEST_DATABASE_URL=postgresql://.../erp_test npm run test:integration
// من غير TEST_DATABASE_URL بيتخطّى نفسه.
const test = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'TEST_DATABASE_URL غير معرّف — اختبار التكامل اتخطّى';
if (URL) { process.env.DATABASE_URL = URL; process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48); }

const N_USERS = 10, N_PRODUCTS = 40;
const ctx = { users: [], productIds: [], locationId: null, tag: 'tg' + Date.now() };

test('integration: setup', { skip }, async () => {
  const db = require('../src/db/database');
  const S = require('../src/db/schema');
  const { migrateGameSchema } = require('../src/db/gameSchema');
  await db.initDatabase();
  const { name } = await db.get(`SELECT current_database() AS name`);
  assert.ok(/test/i.test(name), `رفض التشغيل: اسم الداتابيز "${name}" لازم يحتوي على test`);
  // نفس ترتيب startServer() في server.js بالظبط
  for (const fn of ['createSchema', 'createProcurementSchema', 'createSalesSchema', 'createPhase4Schema', 'migrateProcurementSchema',
    'migrateInventoryAlertsSchema', 'migratePurchasingSchema', 'migrateCollectionSchema', 'migrateNotificationsSchema', 'migrateReturnsSchema',
    'migratePerformanceIndexes', 'migrateProductListPerformanceIndexes', 'migrateSupplierProductLinks', 'migrateInventoryCountSchema',
    'migrateProductAttributesSchema']) await S[fn]();
  await migrateGameSchema();

  for (let i = 0; i < N_USERS + 2; i++) {
    const id = await db.insert(`INSERT INTO users (full_name, username, password_hash, role) VALUES (?, ?, 'x', 'warehouse')`, [`موظف ${i}`, `${ctx.tag}_${i}`]);
    ctx.users.push({ id, role: 'warehouse', full_name: `موظف ${i}`, can_view_cost_price: false });
  }
  for (let i = 0; i < N_PRODUCTS; i++) {
    ctx.productIds.push(await db.insert(`INSERT INTO products (sku, name, sale_price, cost_price) VALUES (?, ?, 0, 0)`, [`${ctx.tag}-${i}`, `منتج اختبار ${i}`]));
  }
  ctx.locationId = await db.insert(`INSERT INTO locations (name, type) VALUES (?, 'warehouse')`, [`${ctx.tag}-loc`]);
});

test('10 مستخدمين يطلبوا مهمة في نفس اللحظة → ولا مهمتين متطابقتين', { skip }, async () => {
  const db = require('../src/db/database'), tasks = require('../src/game/taskService');
  const users = ctx.users.slice(0, N_USERS);
  const results = await Promise.all(users.map(u => tasks.claimNext(u, 'prices')));
  assert.ok(results.every(r => !r.empty), 'كل مستخدم لازم ياخد مهمة');
  const keys = results.map(r => `${r.task.claim_id}`);
  assert.equal(new Set(keys).size, N_USERS, 'claim_id مكرر');
  const dup = await db.all(`SELECT product_id, task_key, count(*)::int c FROM game_task_claims WHERE status = 'active' AND user_id = ANY(?) GROUP BY 1, 2 HAVING count(*) > 1`, [users.map(u => u.id)]);
  assert.equal(dup.length, 0, 'فيه (منتج، مهمة) متحجزة مرتين');
  // استئناف: نفس المستخدم يطلب تاني → نفس المهمة (مش مهمة جديدة)
  const again = await tasks.claimNext(users[0], 'prices');
  assert.equal(again.task.claim_id, results[0].task.claim_id);
});

test('نفس الإجابة مرتين في نفس اللحظة (request_id واحد) → تتسجل مرة واحدة وXP مرة واحدة', { skip }, async () => {
  const db = require('../src/db/database'), tasks = require('../src/game/taskService');
  const u = ctx.users[0];
  const { task } = await tasks.claimNext(u, 'prices');
  const body = { action: 'set', value: '2500', request_id: 'idem-' + ctx.tag, token: task.token };
  const [a, b] = await Promise.all([tasks.submitAnswer(u, task.claim_id, body), tasks.submitAnswer(u, task.claim_id, body)]);
  assert.equal(a.ok && b.ok, true);
  const rows = await db.all(`SELECT xp FROM game_actions WHERE request_id = ?`, [body.request_id]);
  assert.equal(rows.length, 1);
  const row = await db.get(`SELECT sale_price FROM products p JOIN game_task_claims c ON c.product_id = p.id WHERE c.id = ?`, [task.claim_id]);
  assert.equal(row.sale_price, 2500);
});

test('skip: المهمة تفضل مش محلولة، والمستخدم ما يشوفهاش فوراً', { skip }, async () => {
  const db = require('../src/db/database'), tasks = require('../src/game/taskService');
  const u = ctx.users[1];
  const cur = await db.get(`SELECT * FROM game_task_claims WHERE user_id = ? AND status = 'active'`, [u.id]);
  await tasks.skipTask(u, cur.id, 'skip-' + ctx.tag);
  const p = await db.get(`SELECT sale_price FROM products WHERE id = ?`, [cur.product_id]);
  assert.equal(p.sale_price, 0, 'التخطي ما يغيّرش القيمة');
  const next = await tasks.claimNext(u, 'prices');
  assert.notEqual(next.task.claim_id, cur.id);
  assert.notEqual(`${next.task.product.sku}`, `${(await db.get('SELECT sku FROM products WHERE id = ?', [cur.product_id])).sku}`);
});

test('lease: claim منتهي يترجّع متاح لمستخدم تاني، ومفيش تكرار', { skip }, async () => {
  const db = require('../src/db/database'), tasks = require('../src/game/taskService');
  const abandoned = ctx.users.slice(2, 6);
  await db.run(`UPDATE game_task_claims SET expires_at = now() - interval '1 minute' WHERE user_id = ANY(?) AND status = 'active'`, [abandoned.map(u => u.id)]);
  await Promise.all(ctx.users.slice(6, 10).map(u => tasks.claimNext(u, 'prices')));
  const expired = await db.all(`SELECT status FROM game_task_claims WHERE user_id = ANY(?) AND status = 'expired'`, [abandoned.map(u => u.id)]);
  assert.ok(expired.length >= 1, 'الـ claims المنتهية لازم تتعلّم expired');
  const dup = await db.all(`SELECT 1 FROM game_task_claims WHERE status = 'active' GROUP BY product_id, task_key HAVING count(*) > 1`);
  assert.equal(dup.length, 0);
});

test('التحقق بيتبطل لو الـ ERP غيّر القيمة بعد التأكيد (snapshot)', { skip }, async () => {
  const db = require('../src/db/database'), tasks = require('../src/game/taskService'), F = require('../src/game/fields');
  const pid = ctx.productIds[N_PRODUCTS - 1];
  await db.run(`UPDATE products SET sale_price = 3000 WHERE id = ?`, [pid]);
  const u = ctx.users[10];
  const cid = await db.insert(`INSERT INTO game_task_claims (product_id, task_key, kind, user_id, expires_at) VALUES (?, 'sale_price', 'verify', ?, now() + interval '5 minutes')`, [pid, u.id]);
  await tasks.submitAnswer(u, cid, { action: 'confirm', request_id: 'c-' + ctx.tag, token: '3000' });
  const q = () => db.get(`SELECT ${F.needExpr('sale_price')} AS need FROM products p WHERE p.id = ?`, [pid]);
  assert.equal((await q()).need, false, 'بعد التأكيد مفيش مهمة');
  await db.run(`UPDATE products SET sale_price = 3200 WHERE id = ?`, [pid]); // ERP عدّل
  assert.equal((await q()).need, true, 'تعديل الـ ERP لازم يرجّع المهمة');
  const cid2 = await db.insert(`INSERT INTO game_task_claims (product_id, task_key, kind, user_id, expires_at) VALUES (?, 'sale_price', 'verify', ?, now() + interval '5 minutes')`, [pid, u.id]);
  await assert.rejects(() => tasks.submitAnswer(u, cid2, { action: 'confirm', request_id: 'c2-' + ctx.tag, token: '3000' }), { code: 'STALE_VALUE' });
});

test('الجرد: مستخدمين متزامنين ما ياخدوش نفس المنتج، والإجابة المكررة تتسجل مرة', { skip }, async () => {
  const db = require('../src/db/database'), inv = require('../src/game/inventoryService');
  const admin = { ...ctx.users[0], role: 'admin' };
  const [s1, s2] = await Promise.all([inv.startSession(admin, ctx.locationId), inv.startSession(admin, ctx.locationId)]);
  assert.equal(s1.session_id, s2.session_id, 'جلسة نشطة واحدة لكل مكان');
  const users = ctx.users.slice(0, 8).map(u => ({ ...u, role: 'admin' }));
  const rs = await Promise.all(users.map(u => inv.nextProduct(u, s1.session_id)));
  const ids = rs.map(r => r.task.claim_id);
  assert.equal(new Set(ids).size, users.length);
  const body = { qty: '4', request_id: 'cnt-' + ctx.tag };
  await Promise.all([inv.answerCount(users[0], rs[0].task.claim_id, body), inv.answerCount(users[0], rs[0].task.claim_id, body)]);
  const n = await db.get(`SELECT count(*)::int c FROM game_actions WHERE request_id = ?`, [body.request_id]);
  assert.equal(n.c, 1);
  const e = await db.get(`SELECT count(*)::int c FROM inventory_count_entries WHERE session_id = ?`, [s1.session_id]);
  assert.equal(e.c, 1);
});

test('integration: cleanup', { skip }, async () => {
  const db = require('../src/db/database');
  const uids = ctx.users.map(u => u.id);
  await db.run(`DELETE FROM game_actions WHERE user_id = ANY(?)`, [uids]);
  await db.run(`DELETE FROM game_achievements WHERE user_id = ANY(?)`, [uids]);
  await db.run(`DELETE FROM game_task_skips WHERE user_id = ANY(?)`, [uids]);
  await db.run(`DELETE FROM game_task_claims WHERE user_id = ANY(?)`, [uids]);
  await db.run(`DELETE FROM game_field_state WHERE actor_id = ANY(?)`, [uids]);
  await db.run(`DELETE FROM inventory_count_sessions WHERE location_id = ?`, [ctx.locationId]);
  await db.run(`DELETE FROM audit_log WHERE user_id = ANY(?)`, [uids]);
  await db.run(`DELETE FROM products WHERE id = ANY(?)`, [ctx.productIds]);
  await db.run(`DELETE FROM locations WHERE id = ?`, [ctx.locationId]);
  await db.run(`DELETE FROM users WHERE id = ANY(?)`, [uids]);
  await db.closeDatabase();
});
