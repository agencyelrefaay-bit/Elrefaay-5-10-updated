// game/config.js — كل الثوابت في مكان واحد (قابلة للضبط عبر env)
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

const FIELDS = {
  name:       { label: 'اسم المنتج',   missingPrio: 100, verifyPrio: 35, group: 'details' },
  sale_price: { label: 'سعر البيع',    missingPrio: 90,  verifyPrio: 40, group: 'prices'  },
  category:   { label: 'التصنيف',      missingPrio: 80,  verifyPrio: 25, group: 'details' },
  image:      { label: 'صورة المنتج',  missingPrio: 70,  verifyPrio: 30, group: 'images'  },
  cost_price: { label: 'سعر التكلفة',  missingPrio: 60,  verifyPrio: 20, group: 'prices', costOnly: true },
  color:      { label: 'اللون',        missingPrio: 50,  verifyPrio: 10, group: 'details' },
};
const ALL_FIELDS = Object.keys(FIELDS);

const MODES = {
  all:     ['name', 'sale_price', 'category', 'image', 'cost_price', 'color'],
  prices:  ['sale_price', 'cost_price'],
  images:  ['image'],
  details: ['name', 'category', 'color'],
};

// XP: 'verify' = تأكيد قيمة موجودة، 'missing' = إدخال/تصحيح قيمة، 'replace' = صورة جديدة
const XP = {
  name:       { verify: 3, missing: 10 },
  sale_price: { verify: 5, missing: 10 },
  cost_price: { verify: 5, missing: 10 },
  category:   { verify: 3, missing: 8 },
  color:      { verify: 3, missing: 5 },
  image:      { verify: 5, missing: 20, replace: 20 },
  count: 10,
  product_complete: 25,
};

const LEVELS = [
  { level: 1, min: 0,    title: 'مبتدئ' },
  { level: 2, min: 100,  title: 'محقق الأسعار' },
  { level: 3, min: 300,  title: 'خبير المنتجات' },
  { level: 4, min: 700,  title: 'بطل المخازن' },
  { level: 5, min: 1500, title: 'فنان الإضاءة' },
  { level: 6, min: 3000, title: 'أسطورة الرفاعي' },
];

const ACHIEVEMENTS = [
  { code: 'first_task',  icon: '🌱', title: 'أول خطوة',          desc: 'أنجزت أول مهمة',                 test: c => c.total >= 1 },
  { code: 'tasks_10',    icon: '🏆', title: 'أول ١٠ مهام',        desc: 'أنجزت ١٠ مهام',                  test: c => c.total >= 10 },
  { code: 'tasks_100',   icon: '💯', title: '١٠٠ مهمة',           desc: 'أنجزت ١٠٠ مهمة',                 test: c => c.total >= 100 },
  { code: 'tasks_500',   icon: '🚀', title: '٥٠٠ مهمة',           desc: 'أنجزت ٥٠٠ مهمة',                 test: c => c.total >= 500 },
  { code: 'price_50',    icon: '💰', title: 'محقق الأسعار',       desc: 'راجعت ٥٠ سعر',                   test: c => c.price >= 50 },
  { code: 'image_50',    icon: '📸', title: 'عين الصقر',          desc: 'راجعت أو صوّرت ٥٠ صورة',         test: c => c.image >= 50 },
  { code: 'products_25', icon: '✨', title: 'منتجات مكتملة',      desc: 'كمّلت بيانات ٢٥ منتج بالكامل',   test: c => c.products >= 25 },
  { code: 'inventory_100', icon: '📦', title: 'بطل الجرد',        desc: 'عدّيت ١٠٠ منتج في الجرد',        test: c => c.inventory >= 100 },
  { code: 'streak_3',    icon: '🔥', title: '٣ أيام متتالية',     desc: 'اشتغلت ٣ أيام ورا بعض',          test: c => c.streak >= 3 },
  { code: 'streak_7',    icon: '👑', title: 'أسبوع كامل',         desc: 'اشتغلت ٧ أيام ورا بعض',          test: c => c.streak >= 7 },
];

module.exports = {
  FIELDS, ALL_FIELDS, MODES, XP, LEVELS, ACHIEVEMENTS,
  LEASE_SECONDS: int(process.env.GAME_LEASE_SECONDS, 300),
  SKIP_COOLDOWN_HOURS: int(process.env.GAME_SKIP_COOLDOWN_HOURS, 12),
  DAILY_GOAL: int(process.env.GAME_DAILY_GOAL, 25),
  TIMEZONE: process.env.GAME_TIMEZONE || 'Africa/Cairo',
  DATA_ROLES: (process.env.GAME_DATA_ROLES || 'admin,manager,sales,warehouse').split(',').map(s => s.trim()),
  INVENTORY_ROLES: (process.env.GAME_INVENTORY_ROLES || 'admin,manager,warehouse').split(',').map(s => s.trim()),
  MAX_PRICE: 10000000,
  CONFIRM_PRICE_ABOVE: 1000000,
  MAX_QTY: 1000000,
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
};
