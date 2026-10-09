const express = require('express');
const router = express.Router();
const { all, get, insert, run, transaction } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { logAction } = require('../utils/auditLog');
const multer = require('multer');
const { createOutstandingPdf } = require('../utils/outstandingPdf');
const { sendDocument, isTelegramConfigured } = require('../notifications/telegramNotifier');

router.use(authenticate);

const TYPES = {
  customers: { table: 'customers', group: 'customer_groups', fk: 'customer_group_id', label: 'عميل', manageRoles: ['admin','manager','sales'], balanceSql: `COALESCE(p.opening_balance,0)+COALESCE(billed.total,0)-COALESCE(paid.total,0)-COALESCE(refunded.total,0)`, joins: `LEFT JOIN (SELECT customer_id,SUM(total) total FROM invoices WHERE status NOT IN ('draft','cancelled') GROUP BY customer_id) billed ON billed.customer_id=p.id LEFT JOIN (SELECT customer_id,SUM(amount) total FROM customer_payments GROUP BY customer_id) paid ON paid.customer_id=p.id LEFT JOIN (SELECT customer_id,SUM(total_refund) total FROM sales_returns WHERE status='completed' GROUP BY customer_id) refunded ON refunded.customer_id=p.id` },
  suppliers: { table: 'suppliers', group: 'supplier_groups', fk: 'supplier_group_id', label: 'مورد', manageRoles: ['admin','manager'], balanceSql: `COALESCE(p.opening_balance,0)+COALESCE(billed.total,0)-COALESCE(paid.total,0)`, joins: `LEFT JOIN (SELECT supplier_id,SUM(total) total FROM purchase_orders WHERE status NOT IN ('draft','cancelled') GROUP BY supplier_id) billed ON billed.supplier_id=p.id LEFT JOIN (SELECT supplier_id,SUM(amount) total FROM supplier_payments GROUP BY supplier_id) paid ON paid.supplier_id=p.id` },
};
function config(type) { return TYPES[type] || null; }
function canManage(typeConfig, user) {
  return user?.role === 'owner' || typeConfig.manageRoles.includes(user?.role);
}

const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 40, fileSize: 1024 * 1024, fields: 1, fieldSize: 2048 },
  fileFilter: (_req, file, callback) => file.mimetype === 'image/jpeg'
    ? callback(null, true)
    : callback(new Error('صيغة الصورة غير مدعومة')),
}).array('pages', 40);

function parseReportUpload(req, res, next) {
  reportUpload(req, res, error => {
    if (error) return res.status(400).json({ error: 'تعذر استقبال صفحات التقرير. أرسل حتى 40 صفحة بصيغة JPEG.' });
    next();
  });
}

router.post('/:type/report/telegram', parseReportUpload, async (req, res) => {
  const c = config(req.params.type);
  if (!c) return res.status(400).json({ error: 'نوع كشف الأرصدة غير صحيح' });
  if (!isTelegramConfigured()) return res.status(503).json({ error: 'إعدادات تيليجرام غير مكتملة. أضف TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID.' });

  const pages = Array.isArray(req.files) ? req.files : [];
  if (!pages.length) return res.status(400).json({ error: 'لا توجد صفحات لإرسالها' });
  if (pages.some(file => file.mimetype !== 'image/jpeg' || file.size < 3 || file.buffer[0] !== 0xff || file.buffer[1] !== 0xd8 || file.buffer[2] !== 0xff)) {
    return res.status(400).json({ error: 'صيغة إحدى صفحات التقرير غير صحيحة' });
  }

  try {
    const pdf = await createOutstandingPdf(pages.map(file => file.buffer));
    const typeLabel = req.params.type === 'customers' ? 'العملاء' : 'الموردين';
    const date = new Date().toISOString().slice(0, 10);
    const caption = String(req.body.caption || `كشف أرصدة ${typeLabel}`).trim().slice(0, 1024);
    const sent = await sendDocument(pdf, `outstanding-${req.params.type}-${date}.pdf`, caption);
    if (!sent) return res.status(502).json({ error: 'تعذر إرسال التقرير إلى تيليجرام. تحقق من اتصال البوت وإعدادات الإشعارات.' });
    return res.json({ message: 'تم إرسال التقرير إلى تيليجرام كملف PDF' });
  } catch (error) {
    console.error('[Outstanding report] PDF/Telegram error:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تجهيز أو إرسال ملف التقرير' });
  }
});

router.get('/report/:type', async (req, res) => {
  const c = config(req.params.type);
  if (!c) return res.status(400).json({ error: 'نوع كشف الأرصدة غير صحيح' });
  const people = await all(`SELECT p.id,p.code,p.name,p.phone,p.address,p.${c.fk} AS group_id,g.name AS group_name,${c.balanceSql} AS balance FROM ${c.table} p ${c.joins} LEFT JOIN ${c.group} g ON g.id=p.${c.fk} WHERE p.is_active=1 ORDER BY g.name NULLS LAST,p.name ASC`);
  const groups = await all(`SELECT id,name,description FROM ${c.group} ORDER BY name ASC`);
  res.json({ people, groups, type: req.params.type });
});

router.get('/:type', async (req, res) => {
  const c = config(req.params.type);
  if (!c) return res.status(400).json({ error: 'نوع المجموعات غير صحيح' });
  const groups = await all(`SELECT g.*, COUNT(p.id) AS member_count FROM ${c.group} g LEFT JOIN ${c.table} p ON p.${c.fk}=g.id GROUP BY g.id ORDER BY g.name ASC`);
  const people = await all(`SELECT id,code,name,phone,${c.fk} AS group_id FROM ${c.table} WHERE is_active=1 ORDER BY name ASC`);
  res.json({ groups, people });
});

router.post('/:type', async (req, res) => {
  const c = config(req.params.type);
  if (!c) return res.status(400).json({ error: 'نوع المجموعات غير صحيح' });
  if (!canManage(c, req.user)) return res.status(403).json({ error: 'ليس لديك صلاحية إدارة مجموعات هذا النوع' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم المجموعة مطلوب' });
  if (name.length > 80) return res.status(400).json({ error: 'اسم المجموعة يجب ألا يتجاوز 80 حرفاً' });
  try {
    const id = await insert(`INSERT INTO ${c.group} (name,description) VALUES (?,?)`, [name, String(req.body.description || '').trim() || null]);
    await logAction(req.user.id, 'create', `${req.params.type}_group`, id, { name });
    res.status(201).json({ group: { id, name, description: req.body.description || null, member_count: 0 } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'يوجد مجموعة بهذا الاسم بالفعل' });
    throw e;
  }
});

router.put('/:type/:id/members', async (req, res) => {
  const c = config(req.params.type);
  if (!c) return res.status(400).json({ error: 'نوع المجموعات غير صحيح' });
  if (!canManage(c, req.user)) return res.status(403).json({ error: 'ليس لديك صلاحية إدارة مجموعات هذا النوع' });
  const group = await get(`SELECT id FROM ${c.group} WHERE id=?`, [req.params.id]);
  if (!group) return res.status(404).json({ error: 'المجموعة غير موجودة' });
  const ids = [...new Set((Array.isArray(req.body.person_ids) ? req.body.person_ids : []).map(Number))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ error: 'قائمة الأعضاء غير صحيحة' });
  if (ids.length) {
    const found = await all(`SELECT id FROM ${c.table} WHERE is_active=1 AND id IN (${ids.join(',')})`);
    if (found.length !== ids.length) return res.status(409).json({ error: `بعض ${c.label} غير موجود أو غير نشط. حدّث القائمة وحاول مرة أخرى.` });
  }
  await transaction(async () => {
    await run(`UPDATE ${c.table} SET ${c.fk}=NULL WHERE ${c.fk}=?`, [req.params.id]);
    if (ids.length) await run(`UPDATE ${c.table} SET ${c.fk}=? WHERE id IN (${ids.join(',')})`, [req.params.id]);
  });
  await logAction(req.user.id, 'update_members', `${req.params.type}_group`, Number(req.params.id), { person_ids: ids });
  res.json({ message: 'تم حفظ أعضاء المجموعة', member_count: ids.length });
});

router.put('/:type/:id', async (req, res) => {
  const c = config(req.params.type);
  if (!c) return res.status(400).json({ error: 'نوع المجموعات غير صحيح' });
  if (!canManage(c, req.user)) return res.status(403).json({ error: 'ليس لديك صلاحية إدارة مجموعات هذا النوع' });
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 80) return res.status(400).json({ error: 'أدخل اسم مجموعة صحيحاً (حتى 80 حرفاً)' });
  try {
    const existing = await get(`SELECT id FROM ${c.group} WHERE id=?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'المجموعة غير موجودة' });
    await run(`UPDATE ${c.group} SET name=?,description=?,updated_at=datetime('now') WHERE id=?`, [name, String(req.body.description || '').trim() || null, req.params.id]);
    await logAction(req.user.id, 'update', `${req.params.type}_group`, Number(req.params.id), { name });
    res.json({ message: 'تم تحديث المجموعة' });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'يوجد مجموعة بهذا الاسم بالفعل' });
    throw e;
  }
});

router.delete('/:type/:id', async (req, res) => {
  const c = config(req.params.type);
  if (!c) return res.status(400).json({ error: 'نوع المجموعات غير صحيح' });
  if (!canManage(c, req.user)) return res.status(403).json({ error: 'ليس لديك صلاحية إدارة مجموعات هذا النوع' });
  const group = await get(`SELECT id FROM ${c.group} WHERE id=?`, [req.params.id]);
  if (!group) return res.status(404).json({ error: 'المجموعة غير موجودة' });
  const count = await get(`SELECT COUNT(*) AS c FROM ${c.table} WHERE ${c.fk}=?`, [req.params.id]);
  if (Number(count.c) > 0) return res.status(409).json({ error: `انقل ${c.label} المجموعة إلى مجموعة أخرى أو أزل ارتباطه قبل الحذف` });
  await run(`DELETE FROM ${c.group} WHERE id=?`, [req.params.id]);
  await logAction(req.user.id, 'delete', `${req.params.type}_group`, Number(req.params.id), {});
  res.json({ message: 'تم حذف المجموعة' });
});

module.exports = router;
