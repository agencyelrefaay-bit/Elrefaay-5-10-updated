// app.js — الإقلاع، تسجيل الدخول، الرئيسية، الإنجازات، الفريق، لوحة الإدارة
import { api, auth } from './api.js';
import { h, fmt, toast, sheet, closeOverlays, uuid } from './ui.js';
import { S, mount, skeleton, errorScreen, pending } from './state.js';
import { runTasks } from './tasks.js';
import { runInventory } from './inventory.js';

const CAN_INV = ['admin', 'manager', 'warehouse'];
const CAN_ADMIN = ['admin', 'manager'];

// ───────── تسجيل الدخول ─────────
function loginScreen(msg) {
  const u = h('input', { class: 'field text', type: 'text', autocomplete: 'username', autocapitalize: 'none', 'aria-label': 'اسم المستخدم', placeholder: 'اسم المستخدم' });
  const p = h('input', { class: 'field text', type: 'password', autocomplete: 'current-password', 'aria-label': 'كلمة المرور', placeholder: 'كلمة المرور' });
  const err = h('div', { class: 'hint err center' }, msg || '');
  const go = async () => {
    if (!u.value.trim() || !p.value) { err.textContent = 'اكتب اسم المستخدم وكلمة المرور.'; return; }
    btn.disabled = true; err.textContent = '';
    try { const r = await api.login(u.value.trim(), p.value); auth.set(r.user, r.token); boot(); }
    catch (e) { err.textContent = e.code === 'NETWORK' ? e.message : (e.message || 'مقدرناش ندخلك.'); btn.disabled = false; }
  };
  const btn = h('button', { class: 'btn primary', onclick: go }, 'دخول');
  p.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  return h('div', { class: 'screen stack', style: { justifyContent: 'center' } },
    h('div', { class: 'center' }, h('div', { style: { fontSize: '64px' } }, '💡'), h('h1', null, 'أهلاً بيك في الرفاعي'), h('p', { class: 'muted' }, 'ادخل بنفس اسم المستخدم بتاع النظام')),
    u, p, err, btn);
}
window.addEventListener('auth-expired', () => { auth.clear(); S.me = null; mount(loginScreen('الجلسة خلصت — ادخل تاني. شغلك المحفوظ مش هيضيع.')); });

// ───────── الرئيسية ─────────
function greeting() { const hr = new Date().getHours(); return hr < 12 ? 'صباح الخير' : hr < 18 ? 'مساء الخير' : 'مساء النور'; }

function ring(count, goal) {
  const r = 44, c = 2 * Math.PI * r, pct = Math.min(1, goal ? count / goal : 0);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', 104); svg.setAttribute('height', 104); svg.setAttribute('viewBox', '0 0 104 104');
  for (const [stroke, off] of [['#322b36', 0], ['#e0ab48', c * (1 - pct)]]) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [k, v] of Object.entries({ cx: 52, cy: 52, r, fill: 'none', stroke, 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-dasharray': c, 'stroke-dashoffset': off })) el.setAttribute(k, v);
    svg.append(el);
  }
  return h('div', { class: 'ring' }, svg, h('div', { class: 'n' }, `${count}/${goal}`));
}

function tabs(active) {
  const u = auth.user;
  const items = [['home', '🏠', 'الرئيسية', home], ['me', '🏆', 'إنجازاتي', profile], ['team', '👥', 'الفريق', team]];
  if (u && CAN_ADMIN.includes(u.role)) items.push(['admin', '📊', 'الإدارة', adminScreen]);
  return h('nav', { class: 'tabs' }, items.map(([k, e, t, fn]) => h('button', { class: 'tab' + (k === active ? ' on' : ''), onclick: fn, 'aria-label': t }, h('b', null, e), t)));
}

async function home() {
  mount(skeleton());
  try { S.me = await api.me(); } catch (e) { if (e.code === 'AUTH') return; return mount(errorScreen(e.message, home)); }
  const m = S.me, u = auth.user || {};
  const first = (m.user.name || '').split(' ')[0];
  const t = m.today, lv = m.level, ov = m.overall;
  const goalText = t.remaining > 0 ? `باقي ${t.remaining} مهمة للوصول لهدفك اليومي` : 'حققت هدفك اليومي 🎉';
  mount(h('div', { class: 'screen stack' },
    h('div', null, h('h1', null, `${greeting()} ${first} 👋`), h('div', { class: 'muted' }, 'جاهز نكمّل شغل الرفاعي؟')),
    h('div', { class: 'card row' }, ring(t.count, t.goal), h('div', { class: 'grow' },
      h('div', { style: { fontWeight: 800, fontSize: '22px' } }, `أنجزت ${t.count} مهمة النهاردة`), h('div', { class: 'muted' }, goalText),
      h('div', { style: { marginTop: '8px' } }, m.streak > 0 ? h('span', { class: 'chip' }, `🔥 ${m.streak} ${m.streak > 10 ? 'يوم' : 'أيام'} متتالية`) : h('span', { class: 'chip' }, '🔥 ابدأ سلسلتك النهاردة')))),
    h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h3', null, `⭐ ${lv.title}`), h('span', { class: 'chip' }, `${fmt(m.total_xp)} XP`)),
      h('div', { class: 'bar' }, h('i', { style: { width: Math.round(lv.progress * 100) + '%' } })),
      h('div', { class: 'muted', style: { fontSize: '16px' } }, lv.next_title ? `باقي ${fmt(lv.next_min - m.total_xp)} XP للمستوى "${lv.next_title}"` : 'وصلت لأعلى مستوى!')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h3', null, `🔥 باقي ${fmt(ov.remaining_tasks)} مهمة`), h('span', { class: 'chip' }, `${ov.percent}%`)),
      h('div', { class: 'bar' }, h('i', { style: { width: ov.percent + '%' } })),
      h('div', { class: 'muted', style: { fontSize: '16px' } }, `تم إنجاز ${ov.percent}% من بيانات ${fmt(ov.total_products)} منتج — ${fmt(ov.complete_products)} منتج مكتمل بالكامل`)),
    h('button', { class: 'btn primary', onclick: modeSheet }, 'ابدأ مراجعة المنتجات'),
    CAN_INV.includes(m.user.role) && h('button', { class: 'btn', onclick: runInventory }, '📦 ابدأ الجرد'),
    tabs('home')));
}

function modeSheet() {
  const ov = sheet([h('h2', null, 'عايز تشتغل على إيه؟'),
    h('button', { class: 'btn primary', onclick: () => { ov.remove(); runTasks('all'); } }, '✨ أهم المهام الأول'),
    h('button', { class: 'btn', onclick: () => { ov.remove(); runTasks('prices'); } }, '💰 مراجعة الأسعار'),
    h('button', { class: 'btn', onclick: () => { ov.remove(); runTasks('images'); } }, '📸 الصور'),
    h('button', { class: 'btn', onclick: () => { ov.remove(); runTasks('details'); } }, '🏷️ الاسم والتصنيف واللون')]);
}

// ───────── إنجازاتي ─────────
async function profile() {
  mount(skeleton());
  try { S.me = await api.me(); } catch (e) { if (e.code === 'AUTH') return; return mount(errorScreen(e.message, profile, home)); }
  const m = S.me;
  mount(h('div', { class: 'screen stack' },
    h('div', { class: 'center' }, h('div', { style: { fontSize: '60px' } }, '🏅'), h('h1', null, m.level.title), h('div', { class: 'muted' }, `المستوى ${m.level.level} · ${fmt(m.total_xp)} XP`)),
    h('div', { class: 'grid' },
      h('div', { class: 'stat' }, h('b', null, fmt(m.totals.total)), 'مهمة اتنجزت'), h('div', { class: 'stat' }, h('b', null, `${m.streak} 🔥`), 'أيام متتالية'),
      h('div', { class: 'stat' }, h('b', null, fmt(m.totals.products)), 'منتج كمّلته'), h('div', { class: 'stat' }, h('b', null, fmt(m.totals.inventory)), 'منتج عدّيته')),
    h('h2', null, 'الإنجازات'),
    h('div', { class: 'badges' }, m.achievements.map(a => h('div', { class: 'badge' + (a.unlocked ? '' : ' lock') }, h('div', { class: 'e' }, a.icon), h('b', null, a.title), h('small', null, a.desc)))),
    h('button', { class: 'btn danger', onclick: () => { auth.clear(); S.me = null; mount(loginScreen()); } }, 'تسجيل الخروج'),
    tabs('me')));
}

// ───────── الفريق ─────────
async function team() {
  mount(skeleton());
  let t; try { t = await api.team(); } catch (e) { if (e.code === 'AUTH') return; return mount(errorScreen(e.message, team, home)); }
  const medals = ['🥇', '🥈', '🥉'];
  mount(h('div', { class: 'screen stack' }, h('h1', null, 'الفريق النهاردة'),
    h('div', { class: 'card center' }, h('div', { style: { fontSize: '40px', fontWeight: 900 } }, fmt(t.team_tasks_today)), h('div', { class: 'muted' }, 'مهمة اتنجزت النهاردة من كل الفريق')),
    t.today.length ? h('div', { class: 'card' }, t.today.map((r, i) => h('div', { class: 'list-row' }, h('span', null, `${medals[i] || (i + 1) + '.'} ${r.name}`), h('b', null, `${r.tasks} مهمة · ${fmt(r.xp)} XP`))))
      : h('div', { class: 'card muted center' }, 'لسه محدش بدأ النهاردة — كن أول واحد! 💪'), tabs('team')));
}

// ───────── لوحة الإدارة (إنجليزي/عربي مختلط مقبول) ─────────
async function adminScreen() {
  mount(skeleton());
  let s; try { s = await api.admin(); } catch (e) { if (e.code === 'AUTH') return; return mount(errorScreen(e.message, adminScreen, home)); }
  const L = { name: 'الاسم', sale_price: 'سعر البيع', category: 'التصنيف', image: 'الصور', cost_price: 'سعر التكلفة', color: 'اللون' };
  const pct = s.total_products ? Math.round((s.complete_products / s.total_products) * 1000) / 10 : 0;
  const max = Math.max(1, ...s.daily.map(d => d.tasks));
  mount(h('div', { class: 'screen stack' }, h('h1', null, 'لوحة المتابعة'),
    h('div', { class: 'grid' },
      h('div', { class: 'stat' }, h('b', null, fmt(s.total_products)), 'منتج'), h('div', { class: 'stat' }, h('b', null, `${pct}%`), `${fmt(s.complete_products)} مكتمل`),
      h('div', { class: 'stat' }, h('b', null, fmt(s.pending_tasks)), 'مهمة متبقية'), h('div', { class: 'stat' }, h('b', null, fmt(s.verified_fields)), 'حقل متأكَّد منه'),
      h('div', { class: 'stat' }, h('b', null, s.active_workers), 'شغّالين دلوقتي'), h('div', { class: 'stat' }, h('b', null, s.workers_last_15min), 'نشطين آخر ١٥ دقيقة')),
    h('h2', null, 'حالة كل حقل'),
    h('div', { class: 'card' }, Object.entries(s.fields).map(([k, v]) => h('div', { class: 'stack', style: { padding: '8px 0' } },
      h('div', { class: 'row between' }, h('b', null, L[k]), h('span', { class: 'muted', style: { fontSize: '15px' } }, `ناقص ${fmt(v.missing)} · غير مؤكد ${fmt(v.unverified)} · مؤكد ${fmt(v.verified)}`)),
      h('div', { class: 'bar' }, h('i', { style: { width: (s.total_products ? (v.verified / s.total_products) * 100 : 0) + '%' } }))))),
    h('h2', null, 'الجرد حسب المكان'),
    h('div', { class: 'card' }, s.inventory.map(l => h('div', { class: 'stack', style: { padding: '8px 0' } },
      h('div', { class: 'row between' }, h('b', null, l.name), h('span', { class: 'muted', style: { fontSize: '15px' } }, l.status === 'in_progress' ? `${fmt(l.counted)} / ${fmt(l.total)}` : l.session_id ? 'آخر جلسة اتقفلت' : 'لسه ما بدأش')),
      h('div', { class: 'bar' }, h('i', { style: { width: (l.status === 'in_progress' && l.total ? (l.counted / l.total) * 100 : 0) + '%' } }))))),
    h('h2', null, 'النشاط آخر ١٤ يوم'),
    h('div', { class: 'card' }, h('div', { class: 'bars' }, s.daily.map(d => h('i', { title: `${d.day}: ${d.tasks}`, style: { height: Math.max(3, (d.tasks / max) * 100) + '%' } }))), h('div', { class: 'muted center', style: { fontSize: '14px' } }, s.daily.length ? `آخر يوم: ${s.daily[s.daily.length - 1].tasks} مهمة` : 'لسه مفيش نشاط')),
    h('h2', null, 'Conflicts / errors log'),
    h('div', { class: 'card' }, s.conflicts.length ? s.conflicts.map(c => h('div', { class: 'list-row', style: { fontSize: '15px' } }, h('span', null, `${c.user_name} — ${c.detail || ''}`), h('span', { class: 'muted' }, new Date(c.created_at).toLocaleTimeString('ar-EG')))) : h('div', { class: 'muted center' }, 'مفيش تعارضات مسجّلة ✅')),
    tabs('admin')));
}

// ───────── الإقلاع + استرجاع آخر إجابة معلّقة ─────────
async function resumePending() {
  const p = pending.get();
  if (!p) return;
  try {
    if (p.kind === 'task') await api.answer(p.claimId, p.payload); else await api.invAnswer(p.claimId, p.payload);
    toast('كملنا حفظ آخر إجابة ليك ✓');
  } catch (e) { if (e.code === 'NETWORK' || e.code === 'AUTH') return; /* مهمة اتحوّلت/اتقفلت — نتجاهلها */ }
  pending.clear();
}

async function boot() {
  S.goHome = home;
  if (!auth.token) return mount(loginScreen());
  await resumePending();
  home();
}

const banner = document.getElementById('offline-banner');
const syncNet = () => { banner.hidden = navigator.onLine; };
window.addEventListener('online', syncNet); window.addEventListener('offline', syncNet); syncNet();
boot();
