// routes/purchaseOrders.js
const express = require('express');
const router  = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const XLSX = require('xlsx');
const { all, get, run, insert, transaction } = require('../db/database');
const { authenticate, authorize }            = require('../middleware/auth');
const { logAction }                          = require('../utils/auditLog');
const { getAllowedLocationIds }              = require('../utils/locationPermissions');
const { round2 }                             = require('../utils/money');
const { validateInstallmentSchedule }        = require('../utils/installmentEngine');
const { buildFileUrl }                       = require('../utils/fileUrl');
const eventBus = require('../utils/eventBus');
const { getSupplierBalance, getPOPreviousBalance, checkSupplierCreditLimit } = require('../utils/supplierLedger');
const { recognizeSupplierInvoice } = require('../services/supplierInvoiceOcr');

// أنواع الشراء المدعومة: نقدي / آجل (من غير جدول أقساط — بتاريخ استحقاق واحد) / تقسيط (بجدول أقساط)
const PO_TYPES = ['cash', 'credit', 'installment'];
const isIsoDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}
const todayISO = () => new Date().toISOString().split('T')[0];

router.use(authenticate);

const invoiceFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = String(file.originalname || '').split('.').pop().toLowerCase();
    cb(null, ['xlsx', 'xls', 'csv'].includes(ext));
  },
});

const invoiceOCRFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = String(file.originalname || '').split('.').pop().toLowerCase();
    cb(null, ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext));
  },
});

function handleInvoiceOCRUpload(req, res, next) {
  invoiceOCRFileUpload.single('invoice')(req, res, error => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? 'حجم الفاتورة أكبر من 15 ميجابايت. قلل حجم الملف ثم أعد المحاولة.'
        : 'تعذر استقبال الملف. اختر صورة أو PDF صالحاً ثم أعد المحاولة.',
    });
  });
}

const invoiceOCRLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تم الوصول إلى حد تحليل الفواتير مؤقتاً. انتظر دقيقة ثم أعد المحاولة.' },
});

function invoiceNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let text = String(value ?? '').trim()
    .replace(/[٠-٩۰-۹]/g, digit => String(digit >= '۰' && digit <= '۹' ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) : '٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[٬\s]/g, '').replace(/[٫]/g, '.').replace(/[^\d.,+-]/g, '');
  if (text.includes(',') && text.includes('.')) {
    const decimal = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    text = decimal === ',' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    const tail = text.length - text.lastIndexOf(',') - 1;
    text = tail === 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  }
  return text && Number.isFinite(Number(text)) ? Number(text) : NaN;
}

function invoiceHeaderKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_\-()٪%]/g, '');
}

function findInvoiceColumn(headers, candidates) {
  const keys = headers.map(invoiceHeaderKey);
  const found = keys.findIndex(key => candidates.some(candidate => key === invoiceHeaderKey(candidate) || key.includes(invoiceHeaderKey(candidate))));
  return found;
}

// Preview supplier invoice rows from Excel/CSV. This endpoint never writes products,
// purchase orders, inventory, or supplier balances; the reviewed rows are submitted
// through the existing purchase-order workflow after warehouse assignment.
router.post('/ocr-invoice', invoiceOCRLimiter, authorize('admin', 'manager'), handleInvoiceOCRUpload, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'اختر صورة أو PDF صالحاً بحجم لا يتجاوز 15 ميجابايت' });

  const extension = String(file.originalname || '').split('.').pop().toLowerCase();
  let result;
  try {
    result = await recognizeSupplierInvoice({ buffer: file.buffer, extension });
  } catch (error) {
    return res.status(422).json({ error: error.message || 'تعذر تحليل الملف. جرّب صورة أوضح أو ملف Excel/CSV.' });
  }

  const products = await all(`SELECT id, name, sku, barcode, category_id, unit, cost_price FROM products WHERE is_active=1`);
  const normalizeCode = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9\u0600-\u06FF]/g, '');
  const byCode = new Map();
  for (const product of products) {
    for (const value of [product.sku, product.barcode]) {
      const key = normalizeCode(value);
      if (key) byCode.set(key, product);
    }
  }
  const byName = new Map(products.map(product => [String(product.name || '').trim().toLocaleLowerCase(), product]));
  const items = result.items.map(item => {
    const product = (item.code && byCode.get(normalizeCode(item.code))) || byName.get(item.name.toLocaleLowerCase()) || null;
    return {
      ...item,
      product_id: product?.id || null,
      matched_product: product ? { id: product.id, name: product.name, sku: product.sku, unit: product.unit } : null,
    };
  });
  return res.json({ ...result, file_name: file.originalname, items });
});

router.post('/import-invoice', authorize('admin', 'manager'), invoiceFileUpload.single('invoice'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'اختر ملف Excel أو CSV صحيحاً' });

  let matrix;
  try {
    const workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) return res.status(400).json({ error: 'الملف لا يحتوي على ورقة بيانات' });
    matrix = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1, defval: '', blankrows: false });
  } catch (_error) {
    return res.status(400).json({ error: 'تعذرت قراءة الملف. تأكد أنه Excel أو CSV صالح' });
  }

  const nameKeys = ['اسم المنتج', 'المنتج', 'الصنف', 'بيان الصنف', 'product name', 'item name', 'description', 'product'];
  const codeKeys = ['كود المنتج', 'كود', 'الكود', 'sku', 'product code', 'item code', 'barcode'];
  const qtyKeys = ['الكمية', 'كمية', 'عدد', 'qty', 'quantity'];
  const costKeys = ['سعر الوحدة', 'سعر التكلفة', 'التكلفة', 'unit cost', 'cost', 'price'];
  const discountKeys = ['خصم %', 'نسبة الخصم', 'discount %', 'discount pct'];
  let headerRow = -1, columns = null;
  for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 25); rowIndex++) {
    const row = matrix[rowIndex] || [];
    const name = findInvoiceColumn(row, nameKeys);
    const qty = findInvoiceColumn(row, qtyKeys);
    let cost = findInvoiceColumn(row, costKeys);
    if (cost < 0) cost = row.findIndex(header => /سعر|price/i.test(String(header ?? '')) && !/بيع|sale/i.test(String(header ?? '')));
    if (name >= 0 && qty >= 0 && cost >= 0) {
      headerRow = rowIndex;
      columns = { name, code: findInvoiceColumn(row, codeKeys), qty, cost, discount: findInvoiceColumn(row, discountKeys) };
      break;
    }
  }
  if (headerRow < 0) return res.status(400).json({ error: 'لم أجد أعمدة واضحة لاسم المنتج والكمية وسعر الوحدة. استخدم ملفاً بعناوين أعمدة ثم أعد المحاولة' });

  const rows = [];
  const issues = [];
  for (let rowIndex = headerRow + 1; rowIndex < matrix.length; rowIndex++) {
    const row = matrix[rowIndex] || [];
    const name = String(row[columns.name] ?? '').trim();
    const code = columns.code >= 0 ? String(row[columns.code] ?? '').trim() : '';
    const rawQty = row[columns.qty];
    const rawCost = row[columns.cost];
    const rawDiscount = columns.discount >= 0 ? row[columns.discount] : 0;
    if (!name && !code && rawQty === '' && rawCost === '') continue;
    const qty = invoiceNumber(rawQty);
    const unitCost = invoiceNumber(rawCost);
    const discountPct = rawDiscount === '' || rawDiscount == null ? 0 : invoiceNumber(rawDiscount);
    if (!name || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
      issues.push({ row: rowIndex + 1, message: `راجع اسم المنتج والكمية والسعر والخصم في الصف ${rowIndex + 1}` });
      continue;
    }
    rows.push({ source_row: rowIndex + 1, name, code, qty_ordered: qty, unit_cost: round2(unitCost), discount_pct: discountPct, line_total: round2(qty * unitCost * (1 - discountPct / 100)) });
  }
  if (!rows.length) return res.status(400).json({ error: issues[0]?.message || 'لم أجد بنوداً صالحة في الملف', issues });

  const products = await all(`SELECT id, name, sku, barcode, category_id, unit, cost_price FROM products WHERE is_active=1`);
  const normalizeCode = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9\u0600-\u06FF]/g, '');
  const byCode = new Map();
  for (const product of products) {
    for (const value of [product.sku, product.barcode]) {
      const key = normalizeCode(value);
      if (key) byCode.set(key, product);
    }
  }
  const byName = new Map(products.map(product => [String(product.name || '').trim().toLocaleLowerCase(), product]));
  const matched = rows.map(row => {
    const product = (row.code && byCode.get(normalizeCode(row.code))) || byName.get(row.name.toLocaleLowerCase()) || null;
    return { ...row, product_id: product?.id || null, matched_product: product ? { id: product.id, name: product.name, sku: product.sku, unit: product.unit } : null };
  });
  res.json({ file_name: file.originalname, items: matched, issues, subtotal: round2(matched.reduce((sum, row) => sum + row.line_total, 0)), unmatched_count: matched.filter(row => !row.product_id).length });
});

const { nextDocumentNumber } = require('../utils/sequenceGenerator');
// تم استبدال مولّد COUNT(*) غير الآمن تحت التزامن بـ SEQUENCE ذرّي (راجع src/utils/sequenceGenerator.js)
async function genPONumber() {
  return nextDocumentNumber('po_number_seq', 'PO', 5, async () => {
    const r = await get(`SELECT COUNT(*) as c FROM purchase_orders`);
    return (r?.c || 0) + 1;
  });
}

function calcPOTotals(items) {
  let subtotal = 0;
  const enriched = items.map(item => {
    const qty = Number(item.qty_ordered);
    const unitCost = round2(item.unit_cost);
    const discountPct = Number(item.discount_pct || 0);
    const lineBeforeDisc = qty * unitCost;
    const lineTotal = round2(lineBeforeDisc * (1 - discountPct / 100));
    subtotal += lineTotal;
    return { ...item, qty_ordered: qty, unit_cost: unitCost, discount_pct: discountPct, line_total: lineTotal };
  });
  return { enriched, subtotal: round2(subtotal) };
}

// ── GET /api/purchase-orders ──
router.get('/', async (req, res) => {
  const { supplier_id, status, from_date, to_date, purchase_type: typeFilter, overdue } = req.query;
  let sql = `
    SELECT po.*, s.name as supplier_name, s.code as supplier_code,
           l.name as location_name, u.full_name as created_by
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN locations l ON po.location_id = l.id
    LEFT JOIN users u ON po.user_id = u.id
    WHERE 1=1`;
  const params = [];
  if (supplier_id) { sql += ` AND po.supplier_id=?`; params.push(supplier_id); }
  if (status)      { sql += ` AND po.status=?`;      params.push(status); }
  if (from_date)   { sql += ` AND po.order_date>=?`; params.push(from_date); }
  if (to_date)     { sql += ` AND po.order_date<=?`; params.push(to_date); }
  if (typeFilter && PO_TYPES.includes(typeFilter)) { sql += ` AND po.purchase_type=?`; params.push(typeFilter); }
  // المتأخرة فقط: آجل + تاريخ الاستحقاق عدّى + لسه فيه متبقي + مش مسودة/ملغي
  if (overdue === '1') {
    sql += ` AND po.purchase_type='credit' AND po.due_date < ? AND (po.total - po.paid_amount) > 0.01 AND po.status NOT IN ('draft','cancelled')`;
    params.push(todayISO());
  }
  sql += ` ORDER BY po.created_at DESC LIMIT 300`;

  const today = todayISO();
  const orders = (await all(sql, params)).map(po => {
    const balanceDue = round2(po.total - po.paid_amount);
    // متأخر = أمر آجل ليه تاريخ استحقاق عدّى وفيه متبقي ولسه مش ملغي/مسودة
    const overdue = po.purchase_type === 'credit' && po.due_date && po.due_date < today
      && balanceDue > 0.01 && !['cancelled', 'draft'].includes(po.status);
    return {
      ...po,
      balance_due: po.total - po.paid_amount,
      is_overdue: !!overdue,
      days_overdue: overdue ? Math.floor((Date.parse(today) - Date.parse(po.due_date)) / 86400000) : 0,
    };
  });
  res.json({ orders, count: orders.length });
});

// ── GET /api/purchase-orders/:id ──
router.get('/:id', async (req, res) => {
  const po = await get(`
    SELECT po.*, s.name as supplier_name, s.code as supplier_code,
           l.name as location_name, u.full_name as created_by
    FROM purchase_orders po
    JOIN suppliers s ON po.supplier_id = s.id
    LEFT JOIN locations l ON po.location_id = l.id
    LEFT JOIN users u ON po.user_id = u.id
    WHERE po.id=?`, [req.params.id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });

  const items = await all(`
    SELECT poi.*, p.name as product_name, p.sku, p.unit, l.name as location_name
    FROM purchase_order_items poi
    JOIN products p ON poi.product_id = p.id
    LEFT JOIN locations l ON poi.location_id = l.id
    WHERE poi.po_id=?`, [po.id]);

  const receipts = await all(`
    SELECT pr.*, u.full_name as received_by
    FROM purchase_receipts pr
    LEFT JOIN users u ON pr.user_id = u.id
    WHERE pr.po_id=?`, [po.id]);

  const payments = (await all(`SELECT * FROM supplier_payments WHERE po_id=? ORDER BY payment_date ASC`, [po.id]))
    .map(p => ({ ...p, proof_image_path: buildFileUrl(req, p.proof_image_path) }));
  const installs = await all(`SELECT * FROM payment_installments WHERE po_id=? ORDER BY installment_number ASC`, [po.id]);

  // الرصيد السابق للمورد قبل هذا الأمر (موجب = مستحق للمورد علينا، سالب = رصيد لنا عنده)
  const prev = await getPOPreviousBalance(po);
  const balanceDue = round2(po.total - po.paid_amount);
  const today = todayISO();
  const overdue = po.purchase_type === 'credit' && po.due_date && po.due_date < today
    && balanceDue > 0.01 && !['cancelled', 'draft'].includes(po.status);
  res.json({
    order: {
      ...po,
      balance_due: po.total - po.paid_amount,
      previous_balance: prev.value,
      previous_balance_source: prev.source,
      account_balance_after: round2(prev.value + balanceDue),
      grand_total_with_previous: round2(prev.value + po.total),
      is_overdue: !!overdue,
      days_overdue: overdue ? Math.floor((Date.parse(today) - Date.parse(po.due_date)) / 86400000) : 0,
    },
    items, receipts, payments, installments: installs,
  });
});

// ── POST /api/purchase-orders ──
router.post('/', authorize('admin','manager'), async (req, res) => {
  const { supplier_id, location_id, order_date, expected_date,
          discount_amount, tax_amount, notes, items, installments, purchase_type, due_date,
          override_credit_limit, status: requestedStatus } = req.body;

  if (!supplier_id) return res.status(400).json({ error: 'المورد مطلوب' });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'يجب إضافة منتج واحد على الأقل' });
  for (const [index, item] of items.entries()) {
    const qty = Number(item?.qty_ordered);
    const unitCost = Number(item?.unit_cost);
    const discountPct = Number(item?.discount_pct || 0);
    if (!Number.isFinite(qty) || qty <= 0)
      return res.status(400).json({ error: `كمية البند رقم ${index + 1} يجب أن تكون أكبر من صفر` });
    if (!Number.isFinite(unitCost) || unitCost < 0)
      return res.status(400).json({ error: `تكلفة البند رقم ${index + 1} غير صالحة` });
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100)
      return res.status(400).json({ error: `خصم البند رقم ${index + 1} يجب أن يكون بين 0 و100%` });
    if (!Number.isInteger(Number(item?.product_id)) || Number(item.product_id) <= 0)
      return res.status(400).json({ error: `المنتج في البند رقم ${index + 1} غير صالح` });
  }
  const requestedDiscount = Number(discount_amount || 0);
  const requestedTax = Number(tax_amount || 0);
  if (!Number.isFinite(requestedDiscount) || requestedDiscount < 0 || !Number.isFinite(requestedTax) || requestedTax < 0)
    return res.status(400).json({ error: 'قيمة الخصم أو الضريبة غير صالحة' });
  const supplierRow = await get(`SELECT id, payment_terms FROM suppliers WHERE id=? AND is_active=1`,[supplier_id]);
  if (!supplierRow)
    return res.status(404).json({ error: 'المورد غير موجود أو غير نشط' });

  if (purchase_type !== undefined && purchase_type !== null && purchase_type !== '' && !PO_TYPES.includes(purchase_type))
    return res.status(400).json({ error: 'نوع الشراء غير صحيح — المسموح: نقدي، آجل، تقسيط' });
  const poType = PO_TYPES.includes(purchase_type) ? purchase_type : 'cash';
  const orderDateResolved = order_date || todayISO();
  if (order_date && !isIsoDate(order_date))
    return res.status(400).json({ error: 'تاريخ الأمر غير صالح' });

  // كل بند لازم يكون له مخزن استلام محدد — إما مخزن خاص بيه أو مخزن الأمر
  // الافتراضي (location_id بالهيدر). ده بيسمح إن كل منتج في نفس أمر الشراء
  // يتوجّه لمخزن مختلف عن التاني.
  for (const item of items) {
    if (!item.location_id && !location_id)
      return res.status(400).json({ error: 'يجب تحديد مخزن الاستلام لكل بند (أو مخزن افتراضي للأمر بالكامل)' });
  }

  const { enriched, subtotal } = calcPOTotals(items);
  const discAmt = round2(requestedDiscount);
  const taxAmt  = round2(requestedTax);
  const total   = round2(subtotal - discAmt + taxAmt);
  if (total < 0) return res.status(400).json({ error: 'إجمالي أمر الشراء لا يمكن أن يكون بالسالب — راجع الخصم' });

  // ── تاريخ الاستحقاق (للأمر الآجل فقط): لو ما اتحددش بنحسبه تلقائياً من "أيام السداد"
  //    المسجّلة للمورد (payment_terms) — نفس فكرة due_date في فاتورة العميل الآجلة. ──
  let dueDate = null;
  if (poType === 'credit') {
    if (due_date) {
      if (!isIsoDate(due_date)) return res.status(400).json({ error: 'تاريخ الاستحقاق غير صالح' });
      if (due_date < orderDateResolved)
        return res.status(400).json({ error: 'تاريخ الاستحقاق لا يمكن أن يسبق تاريخ أمر الشراء' });
      dueDate = due_date;
    } else {
      const terms = parseInt(supplierRow.payment_terms, 10);
      dueDate = addDays(orderDateResolved, terms > 0 ? terms : 30);
    }
  }

  // ── حد ائتمان المورد (آجل/تقسيط) — المدير فقط يقدر يتجاوزه صراحةً (نفس قاعدة العملاء) ──
  const creditError = await checkSupplierCreditLimit(supplier_id, total, poType);
  if (creditError && !(req.user.role === 'admin' && override_credit_limit)) {
    return res.status(400).json(creditError);
  }

  // ── فحص جدول أقساط المورد — نفس الفحص المطبّق على أقساط العميل بالظبط.
  //    لو نوع الشراء "تقسيط"، الجدول بقى *إلزامي* (كان اختيارياً تماماً قبل
  //    كده حتى مع اختيار تقسيط، فمكن يتحفظ أمر "تقسيط" من غير أي جدول
  //    أقساط خالص) — بالضبط نفس مبدأ فاتورة المبيعات. ──
  if (poType === 'installment') {
    const installError = validateInstallmentSchedule(installments, total);
    if (installError) return res.status(400).json(installError);
  }

  // الحالة الابتدائية: زرار "إرسال للمورد" بالواجهة كان بيبعت status='sent' بس السيرفر كان بيتجاهله
  // دايماً ويحفظ الأمر "مسودة" (فالمستخدم يضطر يضغط تأكيد تاني). دلوقتي بنحترم الطلب: 'sent' أو 'draft' فقط.
  const initialStatus = requestedStatus === 'sent' ? 'sent' : 'draft';

  const poId = await transaction(async () => {
    const poNumber = await genPONumber();
    // لو الأمر هيتحفظ مُرسَل مباشرة، بنثبّت لقطة الرصيد السابق للمورد قبل إدخاله في دفتره
    let prevSnapshot = null;
    if (initialStatus === 'sent') {
      const b = await getSupplierBalance(supplier_id);
      prevSnapshot = round2(b ? b.balance : 0);
    }
    const id = await insert(`
      INSERT INTO purchase_orders
      (po_number,supplier_id,location_id,order_date,expected_date,purchase_type,due_date,status,previous_balance,
       subtotal,discount_amount,tax_amount,total,paid_amount,notes,user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      [poNumber, supplier_id, location_id||null,
       orderDateResolved,
       expected_date||null, poType, dueDate, initialStatus, prevSnapshot, subtotal, discAmt, taxAmt, total, notes||null, req.user.id]);

    for (const item of enriched) {
      await insert(`INSERT INTO purchase_order_items
        (po_id,product_id,location_id,qty_ordered,unit_cost,discount_pct,line_total)
        VALUES (?,?,?,?,?,?,?)`,
        [id, item.product_id, item.location_id || location_id || null, item.qty_ordered, item.unit_cost,
         item.discount_pct||0, item.line_total]);
    }

    // إنشاء جدول الأقساط (لنوع "تقسيط" فقط)
    if (poType === 'installment' && Array.isArray(installments)) {
      for (let idx = 0; idx < installments.length; idx++) {
        const inst = installments[idx];
        await insert(`INSERT INTO payment_installments
          (supplier_id,po_id,installment_number,amount,due_date,notes)
          VALUES (?,?,?,?,?,?)`,
          [supplier_id, id, idx+1, inst.amount, inst.due_date, inst.notes||null]);
      }
    }

    return id;
  });

  await logAction(req.user.id, 'create', 'purchase_order', poId, { supplier_id, total, purchase_type: poType });
  const created = await get(`SELECT po.*, s.name as supplier_name FROM purchase_orders po JOIN suppliers s ON po.supplier_id=s.id WHERE po.id=?`,[poId]);
  const createdItems = await all(`SELECT poi.*, p.name as product_name FROM purchase_order_items poi JOIN products p ON poi.product_id=p.id WHERE poi.po_id=?`,[poId]);
  eventBus.emit('purchase_order.created', { order: created, items: createdItems, actorName: req.user.full_name });
  res.status(201).json({ message: 'تم إنشاء أمر الشراء بنجاح', order: created });
});

// ── PUT /api/purchase-orders/:id/status ──
// ملحوظة معمارية: 'received' و'partial' حالتين "مُشتقتين" (derived) بيتحكم فيهم
// نظام الاستلام تلقائياً حسب الكميات الفعلية المستلمة (شوف purchaseReceipts.js) —
// مش المفروض يتغيّروا يدوياً من هنا أبداً، وإلا ممكن حالة الـ PO تتناقض مع بيانات
// qty_received الفعلية المخزّنة على بنوده (نفس مبدأ SAP/Dynamics: الحالة نتيجة
// لأحداث العمل الفعلية، مش حقل حر يتعدّل بحرية). المسموح تغييره يدوياً هنا فقط:
// draft → sent (إرسال الأمر للمورد)، وأي حالة → cancelled (بشروط أمان أدناه).
router.put('/:id/status', authorize('admin','manager'), async (req, res) => {
  const { status } = req.body;
  const valid = ['draft','sent','partial','received','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'حالة غير صحيحة' });

  const po = await get(`SELECT * FROM purchase_orders WHERE id=?`,[req.params.id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });

  if ((status === 'received' || status === 'partial') && po.status !== status) {
    return res.status(400).json({
      error: 'حالة "مستلم"/"استلام جزئي" تُحدَّث تلقائياً فقط عند تسجيل إيصال استلام فعلي، ولا يمكن ضبطها يدوياً',
    });
  }

  if (status === 'cancelled') {
    if (po.status === 'cancelled') return res.status(400).json({ error: 'أمر الشراء ملغى بالفعل' });
    if (Number(po.paid_amount) > 0)
      return res.status(400).json({
        error: 'لا يمكن إلغاء أمر شراء عليه دفعات مسجّلة — يجب استرداد/إلغاء الدفعات أولاً حتى لا يفسد رصيد المورد',
      });
    const receiptCount = await get(`SELECT COUNT(*) as c FROM purchase_receipts WHERE po_id=?`,[po.id]);
    if (receiptCount?.c > 0)
      return res.status(400).json({
        error: 'لا يمكن إلغاء أمر شراء تم استلام بضاعة عليه بالفعل — البضاعة أصلاً أُضيفت للمخزون؛ استخدم مرتجع مشتريات بدلاً من ذلك',
      });
  }

  // لقطة الرصيد السابق للمورد لحظة خروج الأمر من "مسودة" (قبل ما يتحسب في دفتره).
  // بتتخزّن مرة واحدة ومابتتغيّرش — فإعادة طباعة الأمر بعد شهور بتطلّع نفس الرصيد السابق وقت الإصدار.
  let snapshot = null;
  if (po.status === 'draft' && status !== 'draft' && status !== 'cancelled' && po.previous_balance == null) {
    const b = await getSupplierBalance(po.supplier_id);
    snapshot = round2(b ? b.balance : 0);
  }
  await run(`UPDATE purchase_orders SET status=?, previous_balance=COALESCE(previous_balance, ?), updated_at=datetime('now') WHERE id=?`,
    [status, snapshot, req.params.id]);
  await logAction(req.user.id, 'status_change', 'purchase_order', req.params.id, { from: po.status, to: status });
  res.json({ message: 'تم تحديث الحالة', status });
});

// ── PUT /api/purchase-orders/:id ── (تعديل الـ PO مع إعادة حساب الإجماليات)
// ── باج كان موجود هنا: الشرط كان بيمنع التعديل فقط لو status==='received'،
//    لكن حالة 'partial' (استلام جزئي) كانت لسه بتسمح بالتعديل! وبما إن التعديل
//    بيعمل DELETE FROM purchase_order_items ثم إعادة إدخال بنود جديدة من الصفر،
//    ده كان بيمسح عمود qty_received (تتبّع الكميات المستلمة فعلياً) لأي بند
//    تم استلامه جزئياً، وبيكسر أي مرجعية لـ purchase_receipt_items القديمة
//    اللي بتشاور على بنود الـ PO المحذوفة دي (FK) — كان بيرمي خطأ قاعدة بيانات
//    غامض للمستخدم بدل رسالة عربية واضحة، وأسوأ من كده: لو حصل أي تعديل يدوي
//    مباشر على قاعدة البيانات أو تغيّر سلوك FK مستقبلاً، ده ممكن يمسح تتبّع
//    الاستلام بصمت ويسمح باستلام نفس الكمية مرتين (تضخيم وهمي للمخزون).
//    الحل: نمنع التعديل الكامل للبنود بمجرد وجود أي إيصال استلام واحد على
//    الـ PO (مش بس لما يكتمل الاستلام)، برسالة عربية واضحة. تعديل PO مستلم
//    جزئياً منطقياً لازم يكون عبر "إضافة بند جديد" وليس استبدال كامل البنود.
router.put('/:id', authorize('admin','manager'), async (req, res) => {
  const { id } = req.params;
  const po = await get(`SELECT * FROM purchase_orders WHERE id=?`,[id]);
  if (!po) return res.status(404).json({ error: 'أمر الشراء غير موجود' });
  // تعديل تاريخ الاستحقاق لوحده (أمر آجل) مسموح حتى بعد اكتمال الاستلام — لأنه مواعيد سداد مش بنود.
  if (req.body && Object.keys(req.body).length === 1 && req.body.due_date !== undefined) {
    if (po.status === 'cancelled') return res.status(400).json({ error: 'لا يمكن تعديل أمر شراء ملغى' });
    if (po.purchase_type !== 'credit') return res.status(400).json({ error: 'تاريخ الاستحقاق متاح فقط لأوامر الشراء الآجلة' });
    if (!isIsoDate(req.body.due_date)) return res.status(400).json({ error: 'تاريخ الاستحقاق غير صالح' });
    if (req.body.due_date < po.order_date) return res.status(400).json({ error: 'تاريخ الاستحقاق لا يمكن أن يسبق تاريخ أمر الشراء' });
    await run(`UPDATE purchase_orders SET due_date=?, updated_at=datetime('now') WHERE id=?`, [req.body.due_date, id]);
    await logAction(req.user.id, 'update', 'purchase_order', id, { due_date: req.body.due_date });
    return res.json({ order: await get(`SELECT * FROM purchase_orders WHERE id=?`,[id]) });
  }
  if (po.status === 'received')
    return res.status(400).json({ error: 'لا يمكن تعديل أمر شراء مكتمل الاستلام' });
  if (po.status === 'cancelled')
    return res.status(400).json({ error: 'لا يمكن تعديل أمر شراء ملغى' });

  const { supplier_id, location_id, order_date, expected_date,
          discount_amount, tax_amount, notes, items, due_date } = req.body;

  if (due_date !== undefined && due_date !== null && due_date !== '') {
    if (po.purchase_type !== 'credit')
      return res.status(400).json({ error: 'تاريخ الاستحقاق متاح فقط لأوامر الشراء الآجلة' });
    if (!isIsoDate(due_date)) return res.status(400).json({ error: 'تاريخ الاستحقاق غير صالح' });
    if (due_date < (order_date || po.order_date))
      return res.status(400).json({ error: 'تاريخ الاستحقاق لا يمكن أن يسبق تاريخ أمر الشراء' });
    await run(`UPDATE purchase_orders SET due_date=?, updated_at=datetime('now') WHERE id=?`, [due_date, id]);
  }

  if (items && items.length > 0) {
    for (const [index, item] of items.entries()) {
      const qty = Number(item?.qty_ordered);
      const unitCost = Number(item?.unit_cost);
      const discountPct = Number(item?.discount_pct || 0);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost < 0 ||
          !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100 ||
          !Number.isInteger(Number(item?.product_id)) || Number(item.product_id) <= 0)
        return res.status(400).json({ error: `راجع الكمية والتكلفة والخصم والمنتج في البند رقم ${index + 1}` });
    }
    const receiptCount = await get(`SELECT COUNT(*) as c FROM purchase_receipts WHERE po_id=?`,[id]);
    if (receiptCount?.c > 0)
      return res.status(400).json({
        error: 'لا يمكن استبدال بنود أمر شراء تم تسجيل استلام عليه بالفعل — أي تعديل ممكن يمسح سجل الكميات المستلمة ويسمح باستلامها مرة أخرى بالخطأ',
      });
  }

  await transaction(async () => {
    if (items && items.length > 0) {
      const { enriched, subtotal } = calcPOTotals(items);
      const rawDiscount = discount_amount !== undefined ? Number(discount_amount) : Number(po.discount_amount);
      const rawTax = tax_amount !== undefined ? Number(tax_amount) : Number(po.tax_amount);
      if (!Number.isFinite(rawDiscount) || rawDiscount < 0 || !Number.isFinite(rawTax) || rawTax < 0) {
        const err = new Error('قيمة الخصم أو الضريبة غير صالحة');
        err.status = 400;
        throw err;
      }
      const discAmt = round2(rawDiscount);
      const taxAmt = round2(rawTax);
      const total   = round2(subtotal - discAmt + taxAmt);

      if (total < 0) {
        const err = new Error('إجمالي أمر الشراء لا يمكن أن يكون بالسالب — راجع الخصم');
        err.status = 400;
        throw err;
      }

      // ── منع خفض الإجمالي لأقل من المبلغ المدفوع فعلاً — وإلا balance_due يبقى سالب
      //    ويوهم إن المورد مدين لينا بينما إحنا فعلياً دفعنا أكتر من قيمة الأمر ──
      if (total < Number(po.paid_amount)) {
        const err = new Error(`لا يمكن تقليل إجمالي أمر الشراء (${total.toFixed(2)}) لأقل من المبلغ المدفوع فعلاً (${Number(po.paid_amount).toFixed(2)})`);
        err.status = 400;
        throw err;
      }

      await run(`UPDATE purchase_orders SET
        supplier_id=?, location_id=?, order_date=?, expected_date=?,
        subtotal=?, discount_amount=?, tax_amount=?, total=?, notes=?, updated_at=datetime('now')
        WHERE id=?`,
        [supplier_id??po.supplier_id, location_id??po.location_id,
         order_date??po.order_date, expected_date??po.expected_date,
         subtotal, discAmt, taxAmt, total, notes??po.notes, id]);

      await run(`DELETE FROM purchase_order_items WHERE po_id=?`,[id]);
      for (const item of enriched) {
        await insert(`INSERT INTO purchase_order_items
          (po_id,product_id,location_id,qty_ordered,unit_cost,discount_pct,line_total)
          VALUES (?,?,?,?,?,?,?)`,
          [id, item.product_id, item.location_id || location_id || po.location_id || null,
           item.qty_ordered, item.unit_cost, item.discount_pct||0, item.line_total]);
      }
    }
  }).catch(err => {
    if (err.status) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  });

  if (res.headersSent) return;
  await logAction(req.user.id, 'update', 'purchase_order', id, { supplier_id, items_replaced: !!(items && items.length) });
  res.json({ order: await get(`SELECT * FROM purchase_orders WHERE id=?`,[id]) });
});

module.exports = router;
