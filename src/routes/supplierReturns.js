const express = require('express');
const router = express.Router();
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize } = require('../middleware/auth');
const { getAllowedLocationIds } = require('../utils/locationPermissions');
const { nextDocumentNumber } = require('../utils/sequenceGenerator');
const { logAction } = require('../utils/auditLog');

router.use(authenticate);

router.get('/', async (req, res) => {
  const { supplier_id, status } = req.query;
  let sql = `SELECT sr.*, s.name AS supplier_name, s.code AS supplier_code, l.name AS location_name,
      u.full_name AS created_by, au.full_name AS approved_by_name, cr.return_number AS sales_return_number,
      (SELECT COUNT(*) FROM supplier_return_items sri WHERE sri.return_id=sr.id) AS item_count
    FROM supplier_returns sr JOIN suppliers s ON s.id=sr.supplier_id
    JOIN locations l ON l.id=sr.location_id LEFT JOIN users u ON u.id=sr.user_id
    LEFT JOIN users au ON au.id=sr.approved_by LEFT JOIN sales_returns cr ON cr.id=sr.sales_return_id WHERE 1=1`;
  const params = [];
  if (supplier_id) { sql += ' AND sr.supplier_id=?'; params.push(supplier_id); }
  if (status) { sql += ' AND sr.status=?'; params.push(status); }
  sql += ' ORDER BY sr.created_at DESC LIMIT 500';
  const returns = await all(sql, params);
  res.json({ returns, count: returns.length });
});

router.get('/:id', async (req, res) => {
  const record = await get(`SELECT sr.*, s.name AS supplier_name, l.name AS location_name,
      u.full_name AS created_by, au.full_name AS approved_by_name, cr.return_number AS sales_return_number
    FROM supplier_returns sr JOIN suppliers s ON s.id=sr.supplier_id
    JOIN locations l ON l.id=sr.location_id LEFT JOIN users u ON u.id=sr.user_id
    LEFT JOIN users au ON au.id=sr.approved_by LEFT JOIN sales_returns cr ON cr.id=sr.sales_return_id WHERE sr.id=?`, [req.params.id]);
  if (!record) return res.status(404).json({ error: 'مرتجع المورد غير موجود' });
  const items = await all(`SELECT sri.*, p.name AS product_name, p.sku, poi.po_id, po.po_number
    FROM supplier_return_items sri JOIN products p ON p.id=sri.product_id
    LEFT JOIN purchase_order_items poi ON poi.id=sri.purchase_order_item_id
    LEFT JOIN purchase_orders po ON po.id=poi.po_id WHERE sri.return_id=? ORDER BY sri.id`, [record.id]);
  res.json({ return: record, items });
});

router.post('/', authorize('admin','manager','warehouse'), async (req, res) => {
  const { supplier_id, purchase_order_id, sales_return_id, location_id, return_date, settlement_type, reason, notes, items } = req.body;
  if (!supplier_id || !location_id || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'المورد والموقع وبند مرتجع واحد على الأقل مطلوبة' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'سبب الإرجاع مطلوب' });
  if (!['credit','refund'].includes(settlement_type || 'credit')) return res.status(400).json({ error: 'طريقة التسوية غير صحيحة' });
  const supplier = await get('SELECT id FROM suppliers WHERE id=? AND is_active=1', [supplier_id]);
  const location = await get('SELECT id FROM locations WHERE id=? AND is_active=1', [location_id]);
  if (!supplier || !location) return res.status(404).json({ error: 'المورد أو الموقع غير موجود أو غير نشط' });
  const allowedIds = await getAllowedLocationIds(req.user);
  if (allowedIds && !allowedIds.includes(Number(location_id))) return res.status(403).json({ error: 'ليس لديك صلاحية على الموقع المحدد' });
  if (purchase_order_id) {
    const po = await get(`SELECT id FROM purchase_orders WHERE id=? AND supplier_id=? AND status NOT IN ('draft','cancelled')`, [purchase_order_id, supplier_id]);
    if (!po) return res.status(400).json({ error: 'أمر الشراء غير صالح أو لا يتبع المورد المحدد' });
  }
  let customerReturn = null;
  if (sales_return_id) {
    customerReturn = await get(`SELECT id, return_number, status, location_id FROM sales_returns WHERE id=?`, [sales_return_id]);
    if (!customerReturn || customerReturn.status !== 'completed') return res.status(400).json({ error: 'اربط مرتجع عميل مكتمل فقط' });
    if (Number(customerReturn.location_id) !== Number(location_id)) return res.status(400).json({ error: 'اختر نفس الموقع المسجل في مرتجع العميل المرتبط' });
  }

  let total = 0;
  const normalized = [];
  for (const raw of items) {
    const productId = Number(raw.product_id);
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(productId) || !Number.isFinite(quantity) || quantity <= 0)
      return res.status(400).json({ error: 'تأكد من اختيار منتج وكمية أكبر من صفر لكل بند' });
    let product = await get('SELECT id, cost_price, allow_fractional_qty FROM products WHERE id=?', [productId]);
    if (!product) return res.status(400).json({ error: `المنتج رقم ${productId} غير موجود` });
    if (!product.allow_fractional_qty && quantity % 1 !== 0) return res.status(400).json({ error: `المنتج رقم ${productId} لا يقبل كمية كسرية` });
    const poItemId = raw.purchase_order_item_id ? Number(raw.purchase_order_item_id) : null;
    let sourceCondition = null;
    if (customerReturn) {
      const customerQty = await get(`SELECT COALESCE(SUM(quantity),0) AS quantity,
          BOOL_OR(condition <> 'good') AS needs_quarantine,
          CASE WHEN BOOL_OR(condition='repair') THEN 'repair' WHEN BOOL_OR(condition='damaged') OR BOOL_OR(restock=0) THEN 'damaged' ELSE 'good' END AS source_condition
        FROM sales_return_items WHERE return_id=? AND product_id=?`, [customerReturn.id, productId]);
      sourceCondition = customerQty?.source_condition || 'damaged';
      const supplierQty = await get(`SELECT COALESCE(SUM(sri.quantity),0) AS quantity FROM supplier_return_items sri
        JOIN supplier_returns sr ON sr.id=sri.return_id WHERE sr.sales_return_id=? AND sr.status='approved' AND sri.product_id=?`, [customerReturn.id, productId]);
      const inCurrentRequest = normalized.filter((x) => x.productId === productId).reduce((sum, x) => sum + x.quantity, 0);
      const available = Number(customerQty?.quantity || 0) - Number(supplierQty?.quantity || 0) - inCurrentRequest;
      if (quantity > available) return res.status(400).json({ error: `الكمية المرتبطة بمرتجع العميل المتاحة للإرجاع للمورد هي ${Math.max(0, available)}` });
    }
    let unitCost = raw.unit_cost === '' || raw.unit_cost === undefined ? Number(product.cost_price || 0) : Number(raw.unit_cost);
    if (!Number.isFinite(unitCost) || unitCost < 0) return res.status(400).json({ error: 'تكلفة الوحدة غير صحيحة' });
    if (purchase_order_id) {
      if (!poItemId) return res.status(400).json({ error: 'حدد بند أمر الشراء لكل صنف ليتم التحقق من الكمية والتكلفة' });
      const poItem = await get('SELECT * FROM purchase_order_items WHERE id=? AND po_id=? AND product_id=?', [poItemId, purchase_order_id, productId]);
      if (!poItem) return res.status(400).json({ error: `بند أمر الشراء غير مطابق للمنتج رقم ${productId}` });
      const returned = await get(`SELECT COALESCE(SUM(sri.quantity),0) AS quantity FROM supplier_return_items sri
        JOIN supplier_returns sr ON sr.id=sri.return_id WHERE sri.purchase_order_item_id=? AND sr.status='approved'`, [poItemId]);
      const inCurrentRequest = normalized.filter((x) => x.poItemId === poItemId).reduce((sum, x) => sum + x.quantity, 0);
      const available = Number(poItem.qty_received || 0) - Number(returned?.quantity || 0) - inCurrentRequest;
      if (quantity > available) return res.status(400).json({ error: `الكمية المتاحة للإرجاع من بند أمر الشراء هي ${Math.max(0, available)}` });
      unitCost = Number(poItem.unit_cost || 0) * (1 - Number(poItem.discount_pct || 0) / 100);
    }
    const condition = sourceCondition || (['good','damaged','repair'].includes(raw.condition) ? raw.condition : 'damaged');
    normalized.push({ productId, quantity, unitCost, poItemId, condition, notes: raw.notes || null });
    total += quantity * unitCost;
  }

  const id = await transaction(async () => {
    const returnNumber = await nextDocumentNumber('supplier_return_number_seq', 'SRN', 5, async () => {
      const count = await get('SELECT COUNT(*) AS c FROM supplier_returns'); return Number(count?.c || 0) + 1;
    });
    const returnId = await insert(`INSERT INTO supplier_returns
      (return_number,supplier_id,purchase_order_id,location_id,return_date,status,settlement_type,total_amount,reason,notes,user_id)
      VALUES (?,?,?,?,?,'pending',?,?,?,?,?)`,
      [returnNumber, supplier_id, purchase_order_id || null, location_id, return_date || new Date().toISOString().slice(0,10), settlement_type || 'credit', total, String(reason).trim(), notes || null, req.user.id]);
    if (customerReturn) await run('UPDATE supplier_returns SET sales_return_id=? WHERE id=?', [customerReturn.id, returnId]);
    for (const item of normalized) await insert(`INSERT INTO supplier_return_items
      (return_id,purchase_order_item_id,product_id,quantity,unit_cost,condition,notes) VALUES (?,?,?,?,?,?,?)`,
      [returnId, item.poItemId, item.productId, item.quantity, item.unitCost, item.condition, item.notes]);
    return returnId;
  });
  await logAction(req.user.id, 'create', 'supplier_return', id, { supplier_id, total_amount: total, purchase_order_id: purchase_order_id || null, sales_return_id: customerReturn?.id || null });
  const created = await get(`SELECT sr.*, s.name AS supplier_name FROM supplier_returns sr JOIN suppliers s ON s.id=sr.supplier_id WHERE sr.id=?`, [id]);
  res.status(201).json({ message: 'تم تسجيل طلب مرتجع المورد بانتظار الاعتماد', return: created });
});

router.post('/:id/approve', authorize('admin','manager'), async (req, res) => {
  const id = Number(req.params.id);
  const record = await get('SELECT * FROM supplier_returns WHERE id=?', [id]);
  if (!record) return res.status(404).json({ error: 'مرتجع المورد غير موجود' });
  try {
    await transaction(async () => {
    const locked = await get('SELECT * FROM supplier_returns WHERE id=? FOR UPDATE', [id]);
    if (!locked || locked.status !== 'pending') {
      const err = new Error('يمكن اعتماد الطلبات المعلقة فقط'); err.status = 400; throw err;
    }
    if (locked.sales_return_id) await get('SELECT id FROM sales_returns WHERE id=? FOR UPDATE', [locked.sales_return_id]);
    const items = await all('SELECT * FROM supplier_return_items WHERE return_id=? ORDER BY purchase_order_item_id, product_id, id', [id]);
    const checkedPOItems = new Set();
    const checkedProducts = new Set();
    for (const item of items) {
      if (item.purchase_order_item_id && !checkedPOItems.has(item.purchase_order_item_id)) {
        checkedPOItems.add(item.purchase_order_item_id);
        const poItem = await get('SELECT * FROM purchase_order_items WHERE id=? FOR UPDATE', [item.purchase_order_item_id]);
        const alreadyApproved = await get(`SELECT COALESCE(SUM(sri.quantity),0) AS quantity FROM supplier_return_items sri
          JOIN supplier_returns sr ON sr.id=sri.return_id WHERE sri.purchase_order_item_id=? AND sr.status='approved'`, [item.purchase_order_item_id]);
        const thisReturnQty = items.filter((x) => x.purchase_order_item_id === item.purchase_order_item_id).reduce((sum, x) => sum + Number(x.quantity), 0);
        if (!poItem || Number(alreadyApproved?.quantity || 0) + thisReturnQty > Number(poItem.qty_received || 0)) {
          const err = new Error(`تجاوزت كمية المرتجع الكمية المستلمة في أمر الشراء للمنتج رقم ${item.product_id}`); err.status = 400; throw err;
        }
      }
      if (locked.sales_return_id && !checkedProducts.has(item.product_id)) {
        checkedProducts.add(item.product_id);
        const customerQty = await get('SELECT COALESCE(SUM(quantity),0) AS quantity FROM sales_return_items WHERE return_id=? AND product_id=?', [locked.sales_return_id, item.product_id]);
        const alreadyReturnedToSupplier = await get(`SELECT COALESCE(SUM(sri.quantity),0) AS quantity FROM supplier_return_items sri
          JOIN supplier_returns sr ON sr.id=sri.return_id WHERE sr.sales_return_id=? AND sr.status='approved' AND sri.product_id=?`, [locked.sales_return_id, item.product_id]);
        const thisReturnQty = items.filter((x) => x.product_id === item.product_id).reduce((sum, x) => sum + Number(x.quantity), 0);
        if (Number(alreadyReturnedToSupplier?.quantity || 0) + thisReturnQty > Number(customerQty?.quantity || 0)) {
          const err = new Error(`تجاوزت كمية الإرجاع للمورد الكمية الموجودة في مرتجع العميل للمنتج رقم ${item.product_id}`); err.status = 400; throw err;
        }
      }
      const fromQuarantine = !!locked.sales_return_id && item.condition !== 'good';
      const stock = fromQuarantine
        ? await get('SELECT quantity FROM quarantined_inventory WHERE product_id=? AND location_id=? FOR UPDATE', [item.product_id, locked.location_id])
        : await get('SELECT quantity FROM inventory WHERE product_id=? AND location_id=? FOR UPDATE', [item.product_id, locked.location_id]);
      const before = Number(stock?.quantity || 0);
      if (before < item.quantity) { const err = new Error(`${fromQuarantine ? 'رصيد الحجر الصحي' : 'المخزون'} غير كافٍ للمنتج رقم ${item.product_id} (المتاح ${before})`); err.status = 400; throw err; }
      const after = before - item.quantity;
      if (fromQuarantine) {
        await run(`UPDATE quarantined_inventory SET quantity=?, updated_at=datetime('now') WHERE product_id=? AND location_id=?`, [after, item.product_id, locked.location_id]);
        await insert(`INSERT INTO stock_movements (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,reference_type,reference_id,notes,user_id)
          VALUES (?,?,'adjustment',?,?,?,'supplier_return',?,?,?)`, [item.product_id, locked.location_id, -item.quantity, before, after, id, `إرسال من الحجر الصحي إلى المورد — ${locked.return_number}`, req.user.id]);
      } else {
        await run('UPDATE inventory SET quantity=?, updated_at=datetime(\'now\') WHERE product_id=? AND location_id=?', [after, item.product_id, locked.location_id]);
        await insert(`INSERT INTO stock_movements (product_id,location_id,movement_type,quantity,quantity_before,quantity_after,reference_type,reference_id,notes,user_id)
          VALUES (?,?,'out',?,?,?,'supplier_return',?,?,?)`, [item.product_id, locked.location_id, -item.quantity, before, after, id, `مرتجع مورد — ${locked.return_number}`, req.user.id]);
      }
    }
    await run(`UPDATE supplier_returns SET status='approved', compensation_status=CASE WHEN settlement_type='credit' THEN 'credited' ELSE 'pending' END,
      approved_by=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, [req.user.id, id]);
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
  await logAction(req.user.id, 'approve', 'supplier_return', id, { total_amount: record.total_amount, settlement_type: record.settlement_type });
  res.json({ message: 'تم اعتماد المرتجع وخصم الكمية وتسجيل رصيد المورد', return: await get('SELECT * FROM supplier_returns WHERE id=?', [id]) });
});

router.put('/:id/reject', authorize('admin','manager'), async (req, res) => {
  const record = await get('SELECT * FROM supplier_returns WHERE id=?', [req.params.id]);
  if (!record || record.status !== 'pending') return res.status(400).json({ error: 'يمكن رفض الطلبات المعلقة فقط' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'سبب الرفض مطلوب' });
  await run(`UPDATE supplier_returns SET status='rejected', notes=CASE WHEN notes IS NULL OR notes='' THEN ? ELSE notes || E'\\n' || ? END, updated_at=datetime('now') WHERE id=?`, [
    `سبب الرفض: ${reason}`, `سبب الرفض: ${reason}`, record.id,
  ]);
  await logAction(req.user.id, 'reject', 'supplier_return', record.id, { reason });
  res.json({ message: 'تم رفض طلب المرتجع' });
});

router.post('/:id/confirm-refund', authorize('admin','manager'), async (req, res) => {
  const record = await get(`UPDATE supplier_returns SET compensation_status='refunded', compensation_received_at=datetime('now'), compensation_received_by=?, updated_at=datetime('now')
    WHERE id=? AND status='approved' AND settlement_type='refund' AND compensation_status='pending' RETURNING id,total_amount`, [req.user.id, req.params.id]);
  if (!record) return res.status(400).json({ error: 'لا توجد مطالبة استرداد معلقة لهذا المرتجع' });
  await logAction(req.user.id, 'confirm_refund_received', 'supplier_return', record.id, { amount: record.total_amount });
  res.json({ message: 'تم توثيق استلام مبلغ الاسترداد من المورد' });
});

module.exports = router;
