// game/validation.js — دوال نقية (من غير DB) قابلة للاختبار المباشر
const { MAX_PRICE, CONFIRM_PRICE_ABOVE, MAX_QTY } = require('./config');

// يحوّل الأرقام العربية/الفارسية وفواصل الآلاف إلى رقم JS. يرجّع NaN لو مش رقم صالح.
function parseNumber(input) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return NaN;
  let s = input.trim();
  if (!s) return NaN;
  s = s
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u066C,\u060C\s]/g, '')   // فاصلة آلاف عربية / لاتينية / مسافات
    .replace(/\u066B/g, '.');            // الفاصلة العشرية العربية
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return parseFloat(s);
}

const fmt = n => Number(n).toLocaleString('en-US');

function validatePrice(input, { confirmed = false, otherPrice = null, isSale = true } = {}) {
  const v = parseNumber(input);
  if (!Number.isFinite(v)) return { ok: false, code: 'INVALID', message: 'خلينا نتأكد من الرقم ده — اكتب السعر بالأرقام بس.' };
  if (v <= 0) return { ok: false, code: 'INVALID', message: 'السعر لازم يكون أكبر من صفر.' };
  if (v > MAX_PRICE) return { ok: false, code: 'INVALID', message: 'الرقم ده كبير أوي — راجعه تاني.' };
  const rounded = Math.round(v * 100) / 100;
  if (!confirmed) {
    if (rounded > CONFIRM_PRICE_ABOVE) {
      return { ok: false, code: 'CONFIRM_REQUIRED', message: `متأكد إن السعر ${fmt(rounded)} جنيه؟` };
    }
    if (isSale && otherPrice > 0 && rounded < otherPrice) {
      return { ok: false, code: 'CONFIRM_REQUIRED', message: `سعر البيع (${fmt(rounded)}) أقل من التكلفة (${fmt(otherPrice)}). متأكد؟` };
    }
    if (!isSale && otherPrice > 0 && rounded > otherPrice) {
      return { ok: false, code: 'CONFIRM_REQUIRED', message: `التكلفة (${fmt(rounded)}) أعلى من سعر البيع (${fmt(otherPrice)}). متأكد؟` };
    }
  }
  return { ok: true, value: rounded };
}

function validateQuantity(input, { allowFractional = false, systemQty = null, confirmed = false } = {}) {
  const v = parseNumber(input);
  if (!Number.isFinite(v)) return { ok: false, code: 'INVALID', message: 'خلينا نتأكد من الرقم ده — اكتب الكمية بالأرقام بس.' };
  if (v < 0) return { ok: false, code: 'INVALID', message: 'الكمية مينفعش تكون بالسالب.' };
  if (v > MAX_QTY) return { ok: false, code: 'INVALID', message: 'الكمية دي كبيرة أوي — راجعها تاني.' };
  if (!allowFractional && v % 1 !== 0) return { ok: false, code: 'INVALID', message: 'المنتج ده بيتعد بالقطعة — اكتب رقم صحيح.' };
  const q = Math.round(v * 1000) / 1000;
  if (!confirmed) {
    const base = Number(systemQty) || 0;
    if (q >= 500 || (q > 20 && q > base * 5)) {
      return { ok: false, code: 'CONFIRM_REQUIRED', message: `متأكد إن الكمية ${fmt(q)}؟` };
    }
  }
  return { ok: true, value: q };
}

function validateName(input) {
  if (typeof input !== 'string') return { ok: false, code: 'INVALID', message: 'اكتب اسم المنتج.' };
  const v = input.replace(/\s+/g, ' ').trim();
  if (v.length < 2) return { ok: false, code: 'INVALID', message: 'الاسم قصير أوي — اكتبه كامل.' };
  if (v.length > 200) return { ok: false, code: 'INVALID', message: 'الاسم طويل أوي.' };
  return { ok: true, value: v };
}

const COLOR_PRESETS = ['white', 'black', 'gold', 'none', 'custom'];
function validateColor(input) {
  if (!input || typeof input !== 'object') return { ok: false, code: 'INVALID', message: 'اختار لون.' };
  const preset = input.preset;
  if (!COLOR_PRESETS.includes(preset)) return { ok: false, code: 'INVALID', message: 'اللون ده مش معروف.' };
  if (preset === 'custom') {
    if (typeof input.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(input.hex)) {
      return { ok: false, code: 'INVALID', message: 'اختار لون من القائمة.' };
    }
    return { ok: true, value: { preset, hex: input.hex.toLowerCase() } };
  }
  return { ok: true, value: { preset, hex: null } };
}

// فحص الصورة من محتواها الفعلي (magic bytes) مش من الـ mimetype اللي بيبعته العميل
function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

module.exports = { parseNumber, validatePrice, validateQuantity, validateName, validateColor, detectImageType };
