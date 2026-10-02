// db/gameSchema.js — يطبّق migration لعبة البيانات (additive فقط) عند تشغيل السيرفر.
// مصدر الحقيقة الوحيد هو ملف SQL: supabase/migrations/20260930000000_game_schema.sql
const fs = require('fs');
const path = require('path');
const { run } = require('./database');

async function migrateGameSchema() {
  const file = path.join(__dirname, '../../supabase/migrations/20260930000000_game_schema.sql');
  const sql = fs.readFileSync(file, 'utf8');
  // بدون params → simple query protocol → يقبل عدة statements في استدعاء واحد
  await run(sql);
  console.log('✓ تم التأكد من جداول لعبة البيانات (game_*)');
}

module.exports = { migrateGameSchema };
