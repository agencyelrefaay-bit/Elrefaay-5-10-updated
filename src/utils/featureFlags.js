// utils/featureFlags.js
// تفعيل تحسينات الأداء/تجربة الموبايل تدريجياً: الأول لحساب المالكة "شروق"
// (username = shrouk) فقط عشان تتقارن مع باقي الحسابات، وبعد الموافقة تتعمّم
// بضبط متغير البيئة  FAST_LISTS=all  من غير أي تعديل في الكود.
function isShroukUser(user) {
  return !!user && user.role === 'owner' && String(user.username || '').trim().toLowerCase() === 'shrouk';
}
function useFastLists(user) {
  return process.env.FAST_LISTS === 'all' || isShroukUser(user);
}
module.exports = { isShroukUser, useFastLists };
