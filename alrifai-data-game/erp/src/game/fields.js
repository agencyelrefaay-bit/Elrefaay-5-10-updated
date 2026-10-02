// game/fields.js — تعريف "إيه اللي يعتبر ناقص/محتاج تأكيد" لكل حقل، كأجزاء SQL ثابتة
// (لا تحتوي على أي مدخل مستخدم). المصدر الوحيد لمنطق الاكتمال.
const { FIELDS, ALL_FIELDS } = require('./config');

// قيمة الحقل كنص — بتتخزن كـ snapshot وقت التأكيد وتتقارن لاحقاً
const VALUE = {
  name:       'p.name',
  sale_price: 'p.sale_price::text',
  cost_price: 'p.cost_price::text',
  category:   'p.category_id::text',
  color:      "(p.color_preset || ':' || coalesce(p.color_hex, ''))",
  image:      "coalesce(p.image_path, '')",
};

const MISSING = {
  name:       "btrim(coalesce(p.name, '')) = ''",
  sale_price: 'coalesce(p.sale_price, 0) <= 0',
  cost_price: 'coalesce(p.cost_price, 0) <= 0',
  category:   'p.category_id IS NULL',
  color:      "p.color_preset = 'none'",
  image:      "btrim(coalesce(p.image_path, '')) = ''",
};

function state(field, status) {
  return `EXISTS (SELECT 1 FROM game_field_state s WHERE s.product_id = p.id AND s.field = '${field}' AND s.status = '${status}' AND s.value_snapshot = ${VALUE[field]})`;
}

const verifiedExpr = f => state(f, 'verified');
const rejectedExpr = f => state(f, 'rejected');

// الحقل محتاج شغل = مش متأكَّد منه بنفس القيمة الحالية (أو الصورة مرفوضة/ناقصة)
function needExpr(f) {
  if (f === 'image') return `(${MISSING.image} OR ${rejectedExpr('image')} OR NOT ${verifiedExpr('image')})`;
  return `NOT ${verifiedExpr(f)}`;
}

function kindExpr(f) {
  if (f === 'image') return `(CASE WHEN ${MISSING.image} THEN 'missing' WHEN ${rejectedExpr('image')} THEN 'replace' ELSE 'verify' END)`;
  return `(CASE WHEN ${MISSING[f]} THEN 'missing' ELSE 'verify' END)`;
}

function prioExpr(f) {
  const { missingPrio, verifyPrio } = FIELDS[f];
  const miss = f === 'image' ? `(${MISSING.image} OR ${rejectedExpr('image')})` : MISSING[f];
  return `(CASE WHEN ${miss} THEN ${missingPrio} ELSE ${verifyPrio} END)`;
}

const anyNeedExpr = (fields = ALL_FIELDS) => '(' + fields.map(needExpr).join(' OR ') + ')';

module.exports = { VALUE, MISSING, verifiedExpr, rejectedExpr, needExpr, kindExpr, prioExpr, anyNeedExpr };
