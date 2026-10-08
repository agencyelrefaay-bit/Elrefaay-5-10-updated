// utils/customerLedger.js
// حساب رصيد العميل في الوقت الفعلي
const { get, run } = require('../db/database');
const { round2 } = require('./money');

async function getCustomerBalance(customerId) {
  const customer = await get(`SELECT opening_balance FROM customers WHERE id=?`,[customerId]);
  if (!customer) return null;

  const invTotals = await get(`
    SELECT COALESCE(SUM(total),0) as total_invoiced
    FROM invoices WHERE customer_id=? AND status NOT IN ('draft','cancelled')
  `,[customerId]);

  const payTotals = await get(`
    SELECT COALESCE(SUM(amount),0) as total_paid
    FROM customer_payments WHERE customer_id=?
  `,[customerId]);

  const returnTotals = await get(`
    SELECT COALESCE(SUM(total_refund),0) as total_refunded
    FROM sales_returns WHERE customer_id=? AND status='completed'
  `,[customerId]);

  const openingBalance = round2(customer.opening_balance || 0);
  const totalInvoiced = round2(invTotals.total_invoiced || 0);
  const totalPaid = round2((payTotals.total_paid || 0) + (returnTotals.total_refunded || 0));
  const balance = round2(openingBalance + totalInvoiced - totalPaid); // موجب = العميل مدين لنا

  return {
    opening_balance: openingBalance,
    total_invoiced: totalInvoiced,
    total_paid: round2(payTotals.total_paid || 0),
    total_refunded: round2(returnTotals.total_refunded || 0),
    balance,
  };
}

// ── التحقق من حد الائتمان قبل حفظ فاتورة آجلة/تقسيط ──
// بيتحقق فقط لما نوع الدفع "آجل" أو "تقسيط" (البيع النقدي مايهددش حد الائتمان).
// حد ائتمان = 0 يعني "غير مفعّل" لهذا العميل (مايتمنعش)، حسب الاتفاق الموضح
// في تلميح الحقل بالواجهة ("أقصى مديونية مسموحة... قبل ما النظام ينبّهك").
async function checkCreditLimit(customerId, invoiceTotal, paymentType) {
  if (paymentType !== 'credit' && paymentType !== 'installment') return null;

  const customer = await get(`SELECT credit_limit FROM customers WHERE id=?`,[customerId]);
  const creditLimit = customer?.credit_limit || 0;
  if (creditLimit <= 0) return null; // غير مفعّل لهذا العميل

  const ledger = await getCustomerBalance(customerId);
  const currentBalance   = ledger?.balance || 0;
  const projectedBalance = currentBalance + invoiceTotal;
  const available        = creditLimit - currentBalance;

  if (projectedBalance > creditLimit) {
    return {
      error: `تجاوز حد الائتمان: رصيد العميل الحالي ${currentBalance.toFixed(2)} ج.م، حد الائتمان ${creditLimit.toFixed(2)} ج.م، والمتاح ${Math.max(0, available).toFixed(2)} ج.م فقط — قيمة هذه الفاتورة ${invoiceTotal.toFixed(2)} ج.م تتجاوز المتاح. يمكن لمدير النظام فقط تجاوز هذا الحد.`,
      current_balance: currentBalance,
      credit_limit: creditLimit,
      available_credit: Math.max(0, available),
    };
  }
  return null;
}


// ── الرصيد "كما كان" قبل لحظة معينة (asOf) — بيستخدم لتقدير الرصيد السابق للفواتير
//    القديمة اللي اتأكدت قبل ما نبدأ نخزّن لقطة الرصيد وقت الإصدار. نفس منطق
//    getCustomerBalance بالظبط (نفس الفلاتر)، بس بنستثني الفاتورة نفسها وكل حركة
//    حصلت في/بعد لحظة الإصدار. موجب = العميل مدين لنا، سالب = رصيد دائن للعميل. ──
async function getCustomerBalanceAsOf(customerId, asOf, excludeInvoiceId = 0) {
  const customer = await get(`SELECT opening_balance FROM customers WHERE id=?`, [customerId]);
  if (!customer) return null;
  const inv = await get(`
    SELECT COALESCE(SUM(total),0) as t FROM invoices
    WHERE customer_id=? AND status NOT IN ('draft','cancelled') AND id<>? AND created_at < ?`,
    [customerId, excludeInvoiceId || 0, asOf]);
  const pay = await get(`SELECT COALESCE(SUM(amount),0) as t FROM customer_payments WHERE customer_id=? AND created_at < ?`, [customerId, asOf]);
  const ret = await get(`SELECT COALESCE(SUM(total_refund),0) as t FROM sales_returns WHERE customer_id=? AND status='completed' AND created_at < ?`, [customerId, asOf]);
  return round2((customer.opening_balance || 0) + (inv.t || 0) - (pay.t || 0) - (ret.t || 0));
}

// ── "المديونية السابقة" المطبوعة على الفاتورة (قبل قيمة الفاتورة نفسها):
//    1) لقطة محفوظة وقت التأكيد (الأدق — ماتتغيّرش بعد كده)
//    2) مسودة → الرصيد الحالي الحي (الفاتورة لسه مش محسوبة عليه)
//    3) فاتورة قديمة من غير لقطة → تقدير من الدفتر وقت إصدارها
//    بترجّع { value, source: 'snapshot' | 'live' | 'estimated' } ──
async function getInvoicePreviousBalance(inv) {
  if (inv.previous_balance !== null && inv.previous_balance !== undefined)
    return { value: round2(inv.previous_balance), source: 'snapshot' };
  if (inv.status === 'draft') {
    const b = await getCustomerBalance(inv.customer_id);
    return { value: round2(b ? b.balance : 0), source: 'live' };
  }
  const v = await getCustomerBalanceAsOf(inv.customer_id, inv.created_at, inv.id);
  return { value: v === null ? 0 : v, source: 'estimated' };
}

async function syncCustomerInstallments(run_fn) {
  await require('./installmentEngine').syncOverdueInstallments('customer', run_fn);
}

module.exports = { getCustomerBalance, getCustomerBalanceAsOf, getInvoicePreviousBalance, checkCreditLimit, syncCustomerInstallments };
