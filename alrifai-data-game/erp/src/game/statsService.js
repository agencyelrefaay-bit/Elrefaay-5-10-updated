// game/statsService.js — كل الأرقام بتيجي من الداتابيز (مفيش أرقام وهمية)
const { all, get, insert } = require('../db/database');
const { ALL_FIELDS, FIELDS, ACHIEVEMENTS, DAILY_GOAL, TIMEZONE } = require('./config');
const { needExpr, kindExpr, anyNeedExpr } = require('./fields');
const { levelForXp, computeStreak, achievementsUnlocked } = require('./gamification');

const TASK_ACTIONS = `('confirm','set','upload','count')`;

function canSeeCost(user) {
  return user.role === 'admin' || user.role === 'manager' || !!user.can_view_cost_price;
}
function allowedFields(user) {
  return ALL_FIELDS.filter(f => !FIELDS[f].costOnly || canSeeCost(user));
}

// ─── ملخص المنتجات (cache 20 ثانية عشان ما نعمل full scan على كل طلب) ───
let overviewCache = { at: 0, data: null };
async function overview(force = false) {
  if (!force && overviewCache.data && Date.now() - overviewCache.at < 20000) return overviewCache.data;
  const cols = ALL_FIELDS.map(f =>
    `count(*) FILTER (WHERE ${needExpr(f)} AND ${kindExpr(f)} <> 'verify')::int AS ${f}_missing,
     count(*) FILTER (WHERE ${needExpr(f)} AND ${kindExpr(f)} = 'verify')::int AS ${f}_unverified`
  ).join(',\n');
  const row = await get(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE NOT ${anyNeedExpr()})::int AS complete,
      ${cols}
    FROM products p WHERE p.is_active = 1`);
  const fields = {};
  for (const f of ALL_FIELDS) {
    const missing = row[`${f}_missing`], unverified = row[`${f}_unverified`];
    fields[f] = { missing, unverified, verified: row.total - missing - unverified };
  }
  const data = { total: row.total, complete: row.complete, fields };
  overviewCache = { at: Date.now(), data };
  return data;
}
function invalidateOverview() { overviewCache = { at: 0, data: null }; }

// ─── تقدّم مستخدم: XP، مستوى، سلسلة، هدف يومي، وفتح الإنجازات ───
async function userProgress(userId, { unlock = false } = {}) {
  const xpRow = await get(`SELECT COALESCE(SUM(xp), 0)::int AS xp FROM game_actions WHERE user_id = ?`, [userId]);
  const counts = await get(`SELECT
      count(*) FILTER (WHERE action IN ${TASK_ACTIONS})::int AS total,
      count(*) FILTER (WHERE action IN ('confirm','set') AND task_key IN ('sale_price','cost_price'))::int AS price,
      count(*) FILTER (WHERE task_key = 'image' AND action IN ('confirm','upload'))::int AS image,
      count(*) FILTER (WHERE action = 'count')::int AS inventory,
      count(*) FILTER (WHERE action = 'product_complete')::int AS products
    FROM game_actions WHERE user_id = ?`, [userId]);
  const days = await all(`SELECT DISTINCT ((created_at AT TIME ZONE ?)::date)::text AS d
      FROM game_actions WHERE user_id = ? AND action IN ${TASK_ACTIONS} AND created_at > now() - interval '120 days'`, [TIMEZONE, userId]);
  const t = await get(`SELECT ((now() AT TIME ZONE ?)::date)::text AS today`, [TIMEZONE]);
  const todayRow = await get(`SELECT count(*)::int AS c FROM game_actions
      WHERE user_id = ? AND action IN ${TASK_ACTIONS} AND (created_at AT TIME ZONE ?)::date = (now() AT TIME ZONE ?)::date`, [userId, TIMEZONE, TIMEZONE]);

  const streak = computeStreak(days.map(r => r.d), t.today);
  const level = levelForXp(xpRow.xp);

  let newlyUnlocked = [];
  if (unlock) {
    for (const code of achievementsUnlocked({ ...counts, streak })) {
      const rows = await all(`INSERT INTO game_achievements (user_id, code) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING code`, [userId, code]);
      if (rows.length) {
        const def = ACHIEVEMENTS.find(a => a.code === code);
        newlyUnlocked.push({ code, icon: def.icon, title: def.title });
      }
    }
  }
  return {
    total_xp: xpRow.xp, level, streak,
    today: { count: todayRow.c, goal: DAILY_GOAL, remaining: Math.max(0, DAILY_GOAL - todayRow.c) },
    totals: counts, achievements: newlyUnlocked,
  };
}

async function getMe(user) {
  const [p, ov, unlockedRows] = await Promise.all([
    userProgress(user.id),
    overview(),
    all(`SELECT code, unlocked_at FROM game_achievements WHERE user_id = ?`, [user.id]),
  ]);
  const fields = allowedFields(user);
  const remaining = fields.reduce((s, f) => s + ov.fields[f].missing + ov.fields[f].unverified, 0);
  const slots = ov.total * fields.length;
  const unlocked = new Map(unlockedRows.map(r => [r.code, r.unlocked_at]));
  return {
    user: { id: user.id, name: user.full_name, role: user.role },
    ...p,
    achievements: ACHIEVEMENTS.map(a => ({ code: a.code, icon: a.icon, title: a.title, desc: a.desc, unlocked: unlocked.has(a.code), unlocked_at: unlocked.get(a.code) || null })),
    overall: {
      total_products: ov.total, complete_products: ov.complete, remaining_tasks: remaining,
      percent: slots ? Math.round(((slots - remaining) / slots) * 1000) / 10 : 100,
    },
  };
}

async function getTeam() {
  const rows = await all(`SELECT u.id, u.full_name AS name,
      count(*) FILTER (WHERE a.action IN ${TASK_ACTIONS})::int AS tasks, COALESCE(SUM(a.xp), 0)::int AS xp
    FROM game_actions a JOIN users u ON u.id = a.user_id
    WHERE (a.created_at AT TIME ZONE ?)::date = (now() AT TIME ZONE ?)::date
    GROUP BY u.id, u.full_name ORDER BY xp DESC LIMIT 10`, [TIMEZONE, TIMEZONE]);
  return { today: rows, team_tasks_today: rows.reduce((s, r) => s + r.tasks, 0) };
}

async function getAdminStats() {
  const ov = await overview(true);
  const [workers, recent, claims, locations, daily, conflicts] = await Promise.all([
    get(`SELECT count(DISTINCT user_id)::int AS c FROM game_task_claims WHERE status = 'active' AND expires_at > now()`),
    get(`SELECT count(DISTINCT user_id)::int AS c FROM game_actions WHERE created_at > now() - interval '15 minutes'`),
    get(`SELECT count(*)::int AS c FROM game_task_claims WHERE status = 'active' AND expires_at > now()`),
    all(`SELECT l.id, l.name, s.id AS session_id, s.status,
           (SELECT count(*) FROM inventory_count_entries e WHERE e.session_id = s.id)::int AS counted
         FROM locations l
         LEFT JOIN LATERAL (SELECT * FROM inventory_count_sessions WHERE location_id = l.id
                            ORDER BY (status = 'in_progress') DESC, id DESC LIMIT 1) s ON true
         WHERE l.is_active = 1 ORDER BY l.id`),
    all(`SELECT ((created_at AT TIME ZONE ?)::date)::text AS day,
           count(*) FILTER (WHERE action IN ${TASK_ACTIONS})::int AS tasks, count(DISTINCT user_id)::int AS users
         FROM game_actions WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`, [TIMEZONE]),
    all(`SELECT a.created_at, u.full_name AS user_name, a.task_key, a.detail
         FROM game_actions a JOIN users u ON u.id = a.user_id
         WHERE a.action = 'conflict' ORDER BY a.created_at DESC LIMIT 30`),
  ]);
  const pending = ALL_FIELDS.reduce((s, f) => s + ov.fields[f].missing + ov.fields[f].unverified, 0);
  const verifiedFields = ALL_FIELDS.reduce((s, f) => s + ov.fields[f].verified, 0);
  return {
    total_products: ov.total, complete_products: ov.complete, fields: ov.fields,
    pending_tasks: pending, verified_fields: verifiedFields,
    active_workers: workers.c, workers_last_15min: recent.c, active_claims: claims.c,
    inventory: locations.map(l => ({ ...l, total: ov.total })),
    daily, conflicts,
  };
}

module.exports = { canSeeCost, allowedFields, overview, invalidateOverview, userProgress, getMe, getTeam, getAdminStats, TASK_ACTIONS };
