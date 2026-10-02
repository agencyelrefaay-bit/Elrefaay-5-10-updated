// اختبارات وحدة نقية — بدون داتابيز. التشغيل: npm run test:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/game/validation');
const G = require('../src/game/gamification');
const C = require('../src/game/config');
const F = require('../src/game/fields');

test('parseNumber: أرقام عربية وفواصل آلاف', () => {
  assert.equal(V.parseNumber('2,500'), 2500);
  assert.equal(V.parseNumber('٢٬٥٠٠'), 2500);
  assert.equal(V.parseNumber('١٢٫٥'), 12.5);
  assert.equal(V.parseNumber(' 7 '), 7);
  for (const bad of ['', 'abc', '1e5', '-5', '12.5.1', null, undefined, {}]) assert.ok(Number.isNaN(V.parseNumber(bad)), String(bad));
});

test('validatePrice: حدود وتأكيدات', () => {
  assert.deepEqual(V.validatePrice('2500'), { ok: true, value: 2500 });
  assert.equal(V.validatePrice('0').ok, false);
  assert.equal(V.validatePrice('999999999999').code, 'INVALID');
  assert.equal(V.validatePrice('5000000').code, 'CONFIRM_REQUIRED');
  assert.equal(V.validatePrice('5000000', { confirmed: true }).ok, true);
  assert.equal(V.validatePrice('100', { otherPrice: 200, isSale: true }).code, 'CONFIRM_REQUIRED'); // بيع < تكلفة
  assert.equal(V.validatePrice('300', { otherPrice: 200, isSale: false }).code, 'CONFIRM_REQUIRED'); // تكلفة > بيع
  assert.equal(V.validatePrice('150', { otherPrice: 0, isSale: true }).ok, true);
  assert.equal(V.validatePrice('10.456').value, 10.46);
});

test('validateQuantity: صفر مسموح، سالب ممنوع، كسور حسب المنتج، تأكيد للكميات الكبيرة', () => {
  assert.equal(V.validateQuantity('0').value, 0);
  assert.equal(V.validateQuantity('-1').ok, false);
  assert.equal(V.validateQuantity('2.5').ok, false);
  assert.equal(V.validateQuantity('2.5', { allowFractional: true }).value, 2.5);
  assert.equal(V.validateQuantity('7', { systemQty: 5 }).value, 7);
  assert.equal(V.validateQuantity('500').code, 'CONFIRM_REQUIRED');
  assert.equal(V.validateQuantity('500', { confirmed: true }).ok, true);
  assert.equal(V.validateQuantity('60', { systemQty: 2 }).code, 'CONFIRM_REQUIRED');   // أكبر بكتير من المعتاد
  assert.equal(V.validateQuantity('60', { systemQty: 40 }).ok, true);                 // قريب من المعتاد — ما نزعجش
  assert.equal(V.validateQuantity('99999999').code, 'INVALID');
});

test('validateName / validateColor', () => {
  assert.equal(V.validateName('  نجفة   مودرن  120 سم ').value, 'نجفة مودرن 120 سم');
  assert.equal(V.validateName('ا').ok, false);
  assert.equal(V.validateName('x'.repeat(201)).ok, false);
  assert.deepEqual(V.validateColor({ preset: 'gold' }).value, { preset: 'gold', hex: null });
  assert.deepEqual(V.validateColor({ preset: 'custom', hex: '#AABBCC' }).value, { preset: 'custom', hex: '#aabbcc' });
  assert.equal(V.validateColor({ preset: 'custom', hex: 'red' }).ok, false);
  assert.equal(V.validateColor({ preset: 'pink' }).ok, false);
  assert.equal(V.validateColor({ preset: 'none' }).ok, true);
});

test('detectImageType: من المحتوى مش من الامتداد', () => {
  assert.equal(V.detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).ext, 'jpg');
  assert.equal(V.detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])).ext, 'png');
  assert.equal(V.detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).ext, 'webp');
  assert.equal(V.detectImageType(Buffer.from('<?php echo 1; ?> not an image')), null);
  assert.equal(V.detectImageType(Buffer.from('GIF89a......')), null);
});

test('levelForXp: المستويات والتقدّم', () => {
  assert.equal(G.levelForXp(0).title, 'مبتدئ');
  assert.equal(G.levelForXp(99).level, 1);
  assert.equal(G.levelForXp(100).title, 'محقق الأسعار');
  assert.equal(G.levelForXp(200).progress, 0.5);
  assert.equal(G.levelForXp(99999).level, 6);
  assert.equal(G.levelForXp(99999).next_min, null);
});

test('computeStreak: لا ينكسر لو النهاردة لسه فاضي', () => {
  assert.equal(G.computeStreak([], '2026-10-01'), 0);
  assert.equal(G.computeStreak(['2026-09-30', '2026-09-29', '2026-09-28'], '2026-10-01'), 3);
  assert.equal(G.computeStreak(['2026-10-01', '2026-09-30'], '2026-10-01'), 2);
  assert.equal(G.computeStreak(['2026-09-29'], '2026-10-01'), 0);           // فاتك يوم → اتكسرت
  assert.equal(G.computeStreak(['2026-09-30', '2026-09-28'], '2026-10-01'), 1);
  assert.equal(G.computeStreak(['2026-02-28', '2026-03-01', '2026-03-02'], '2026-03-02'), 3); // عبور الشهر (2026 مش سنة كبيسة)
  assert.equal(G.computeStreak(['2028-02-28', '2028-03-01'], '2028-03-01'), 1);                // 2028 كبيسة: فيه 29 فبراير ناقص
});

test('XP: القيم من الجدول لا من العميل', () => {
  assert.equal(G.xpForAction({ field: 'sale_price', kind: 'verify', action: 'confirm' }), 5);
  assert.equal(G.xpForAction({ field: 'sale_price', kind: 'missing', action: 'set' }), 10);
  assert.equal(G.xpForAction({ field: 'image', kind: 'missing', action: 'upload' }), 20);
  assert.equal(G.xpForAction({ field: 'image', kind: 'replace', action: 'upload' }), 20);
  assert.equal(G.xpForAction({ field: 'image', kind: 'verify', action: 'confirm' }), 5);
  assert.equal(G.xpForAction({ field: 'count', kind: 'count', action: 'count' }), 10);
  assert.equal(G.xpForAction({ field: 'name', kind: 'verify', action: 'skip' }), 0);
  assert.equal(G.xpForAction({ field: 'bogus', kind: 'x', action: 'set' }), 0);
});

test('achievements: تتفتح عند العتبات', () => {
  const c = { total: 10, price: 0, image: 0, inventory: 0, products: 0, streak: 3 };
  assert.deepEqual(G.achievementsUnlocked(c).sort(), ['first_task', 'streak_3', 'tasks_10'].sort());
  assert.equal(G.achievementsUnlocked({ total: 0, price: 0, image: 0, inventory: 0, products: 0, streak: 0 }).length, 0);
  assert.ok(G.achievementsUnlocked({ total: 500, price: 50, image: 50, inventory: 100, products: 25, streak: 7 }).length === C.ACHIEVEMENTS.length);
});

test('fields SQL: كل الحقول معرّفة، الأقواس متوازنة، ومفيش علامة ? (الـ shim بيحوّلها لـ $n)', () => {
  for (const f of C.ALL_FIELDS) {
    for (const sql of [F.needExpr(f), F.kindExpr(f), F.prioExpr(f)]) {
      assert.ok(!sql.includes('?'), f);
      assert.equal(sql.split('(').length, sql.split(')').length, `${f}: أقواس غير متوازنة`);
    }
  }
  assert.ok(F.anyNeedExpr().includes('image_path'));
  assert.ok(F.kindExpr('image').includes("'replace'"));
});

test('config: عدد حقول وأولويات منطقي (الاسم الناقص أعلى من تأكيد اللون)', () => {
  assert.ok(C.FIELDS.name.missingPrio > C.FIELDS.color.verifyPrio);
  assert.ok(C.FIELDS.cost_price.costOnly);
  for (const f of C.ALL_FIELDS) assert.ok(C.XP[f], f);
});
