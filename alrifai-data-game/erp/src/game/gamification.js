// game/gamification.js — منطق نقي: المستويات، السلسلة (streak)، الإنجازات
const { LEVELS, ACHIEVEMENTS, XP } = require('./config');

function levelForXp(xp) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (xp >= l.min) cur = l;
  const next = LEVELS.find(l => l.min > cur.min) || null;
  const progress = next ? (xp - cur.min) / (next.min - cur.min) : 1;
  return { level: cur.level, title: cur.title, xp, min: cur.min, next_min: next ? next.min : null, next_title: next ? next.title : null, progress: Math.min(1, Math.max(0, progress)) };
}

// days: مصفوفة 'YYYY-MM-DD' (أيام فيها نشاط). today: 'YYYY-MM-DD'.
// السلسلة لا تنكسر لو اليوم لسه ما اتعملش فيه شغل (بنبدأ العدّ من امبارح) — عشان مفيش ضغط.
function computeStreak(days, today) {
  const set = new Set(days);
  const dayMs = 86400000;
  const toStr = t => new Date(t).toISOString().slice(0, 10);
  let cursor = Date.parse(today + 'T00:00:00Z');
  if (!set.has(today)) cursor -= dayMs;
  let streak = 0;
  while (set.has(toStr(cursor))) { streak++; cursor -= dayMs; }
  return streak;
}

function xpForAction({ field, kind, action }) {
  if (action === 'count') return XP.count;
  if (action === 'upload') return XP.image[kind === 'verify' ? 'replace' : (kind || 'missing')] || XP.image.replace;
  const table = XP[field];
  if (!table) return 0;
  if (action === 'set') return table.missing;
  if (action === 'confirm') return table.verify;
  return 0;
}

function achievementsUnlocked(counts) {
  return ACHIEVEMENTS.filter(a => a.test(counts)).map(a => a.code);
}

module.exports = { levelForXp, computeStreak, xpForAction, achievementsUnlocked };
