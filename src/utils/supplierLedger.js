// utils/supplierLedger.js
// حساب رصيد المورد في الوقت الفعلي من مجموع الأوامر والمدفوعات
const { get, all } = require('../db/database');
const { round2 } = require('./money');

async function getSupplierBalance(supplierId) {
  const supplier = await get(`SELECT opening_balance FROM suppliers WHERE id = ?`, [supplierId]);
  if (!supplier) return null;

  // ملحوظة معمارية مهمة: كان هنا باج تضارب حسابي حقيقي — الفلتر القديم كان
  // IN ('partial','received') يعني أمر الشراء مايتحسبش كالتزام مالي على المورد
  // إلا لو استُلمت بضاعته (جزئياً أو كلياً)، بينما شاشة أوامر الشراء نفسها
  // بتعرض "الإجمالي/المدفوع/المتبقي" لكل أمر بغض النظر عن حالته. النتيجة:
  // أمر شراء بحالة "مرسل" (sent) لسه ماوصلتش بضاعته، لو اتسجلت عليه دفعة،
  // كان بيظهر "إجمالي مشتريات = 0" في بروفايل المورد بينما شاشة الأوامر
  // بتوريه إجمالي حقيقي — تناقض تام في نفس اللحظة بين شاشتين لنفس البيانات.
  // الحل: نفس مبدأ دفتر أستاذ العميل بالظبط (customerLedger.js) — الالتزام
  // يتحسب بمجرد خروج الأمر من "مسودة" (draft)، مش بس عند الاستلام؛ لأن
  // "مسودة" فقط هي المرحلة اللي لسه مش التزام حقيقي تجاه المورد.
  const poTotals = await get(`
    SELECT COALESCE(SUM(total), 0) as total_invoiced
    FROM purchase_orders
    WHERE supplier_id = ? AND status NOT IN ('draft','cancelled')
  `, [supplierId]);

  // إجمالي المدفوعات
  const payTotals = await get(`
    SELECT COALESCE(SUM(amount), 0) as total_paid
    FROM supplier_payments
    WHERE supplier_id = ?
  `, [supplierId]);

  const returnTotals = await get(`SELECT COALESCE(SUM(total_amount),0) AS total_returns
    FROM supplier_returns WHERE supplier_id=? AND status='approved'`, [supplierId]);
  const refundsReceived = await get(`SELECT COALESCE(SUM(total_amount),0) AS total_refunds_received
    FROM supplier_returns WHERE supplier_id=? AND status='approved' AND settlement_type='refund' AND compensation_status='refunded'`, [supplierId]);

  const openingBalance = round2(supplier.opening_balance || 0);
  const totalInvoiced = round2(poTotals.total_invoiced || 0);
  const totalPaid = round2(payTotals.total_paid || 0);
  const totalReturns = round2(returnTotals.total_returns || 0);
  const totalRefundsReceived = round2(refundsReceived.total_refunds_received || 0);
  const balance = round2(openingBalance + totalInvoiced - totalPaid - totalReturns + totalRefundsReceived);

  return {
    opening_balance: openingBalance,
    total_invoiced: totalInvoiced,
    total_paid: totalPaid,
    total_returns: totalReturns,
    total_refunds_received: totalRefundsReceived,
    balance, // موجب = المورد دائن علينا
    is_overdue:       false,
  };
}


// ── الرصيد "كما كان" قبل لحظة معينة — للأوامر القديمة اللي ماعندهاش لقطة محفوظة.
//    موجب = إحنا مدينين للمورد، سالب = المورد مدين لنا (دفعات مقدّمة). ──
async function getSupplierBalanceAsOf(supplierId, asOf, excludePoId = 0) {
  const supplier = await get(`SELECT opening_balance FROM suppliers WHERE id = ?`, [supplierId]);
  if (!supplier) return null;
  const po = await get(`
    SELECT COALESCE(SUM(total),0) as t FROM purchase_orders
    WHERE supplier_id=? AND status NOT IN ('draft','cancelled') AND id<>? AND created_at < ?`,
    [supplierId, excludePoId || 0, asOf]);
  const pay = await get(`SELECT COALESCE(SUM(amount),0) as t FROM supplier_payments WHERE supplier_id=? AND created_at < ?`, [supplierId, asOf]);
  const returns = await get(`SELECT COALESCE(SUM(total_amount),0) as t FROM supplier_returns WHERE supplier_id=? AND status='approved' AND return_date < ?`, [supplierId, asOf]);
  const refunds = await get(`SELECT COALESCE(SUM(total_amount),0) as t FROM supplier_returns WHERE supplier_id=? AND status='approved' AND settlement_type='refund' AND compensation_status='refunded' AND compensation_received_at < ?`, [supplierId, asOf]);
  return round2((supplier.opening_balance || 0) + (po.t || 0) - (pay.t || 0) - (returns.t || 0) + (refunds.t || 0));
}

// ── الرصيد السابق المطبوع على أمر الشراء (نفس مبدأ الفاتورة): لقطة → حي (مسودة) → تقدير ──
async function getPOPreviousBalance(po) {
  if (po.previous_balance !== null && po.previous_balance !== undefined)
    return { value: round2(po.previous_balance), source: 'snapshot' };
  if (po.status === 'draft') {
    const b = await getSupplierBalance(po.supplier_id);
    return { value: round2(b ? b.balance : 0), source: 'live' };
  }
  const v = await getSupplierBalanceAsOf(po.supplier_id, po.created_at, po.id);
  return { value: v === null ? 0 : v, source: 'estimated' };
}

// ── حد ائتمان المورد (أقصى مبلغ ممكن نكون مدينين به للمورد) — نفس مبدأ checkCreditLimit
//    للعملاء بالظبط: بيتفحص فقط لأوامر الشراء "الآجلة/التقسيط"، وحد = 0 يعني غير مفعّل. ──
async function checkSupplierCreditLimit(supplierId, poTotal, purchaseType) {
  if (purchaseType !== 'credit' && purchaseType !== 'installment') return null;
  const supplier = await get(`SELECT credit_limit FROM suppliers WHERE id=?`, [supplierId]);
  const limit = supplier?.credit_limit || 0;
  if (limit <= 0) return null;
  const ledger = await getSupplierBalance(supplierId);
  const current = ledger?.balance || 0;
  if (current + poTotal > limit) {
    return {
      error: `تجاوز حد ائتمان المورد: المستحق للمورد حالياً ${current.toFixed(2)} ج.م، وحد الائتمان ${limit.toFixed(2)} ج.م، والمتاح ${Math.max(0, limit - current).toFixed(2)} ج.م فقط — قيمة هذا الأمر ${poTotal.toFixed(2)} ج.م تتجاوز المتاح. يمكن لمدير النظام فقط تجاوز هذا الحد.`,
      current_balance: current, credit_limit: limit, available_credit: Math.max(0, limit - current),
    };
  }
  return null;
}

// تحديث حالة القسط لو تجاوز تاريخ الاستحقاق
async function syncInstallmentStatuses(db_run) {
  await db_run(`
    UPDATE payment_installments
    SET status = 'overdue'
    WHERE status = 'pending'
      AND due_date < date('now')
      AND paid_amount < amount
  `);
}

module.exports = { getSupplierBalance, getSupplierBalanceAsOf, getPOPreviousBalance, checkSupplierCreditLimit, syncInstallmentStatuses };
