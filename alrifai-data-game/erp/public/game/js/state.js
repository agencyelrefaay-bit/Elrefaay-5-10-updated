// state.js — حالة التطبيق المشتركة، مكوّنات مشتركة، ومكافآت الإنجاز
import { api } from './api.js';
import { h, fmt, haptic, confetti, toast, dialog, sleep, zoomImage } from './ui.js';

export const S = { me: null, goHome: () => {}, cats: null, hb: null };

export function mount(node) {
  document.getElementById('app').replaceChildren(node);
  window.scrollTo(0, 0);
}

// ── إجابة معلّقة (لو النت قطع بعد الضغط): بتتخزن بنفس request_id وتتبعت تاني بأمان (idempotent) ──
const PEND = 'arGamePending';
export const pending = {
  get() { try { return JSON.parse(localStorage.getItem(PEND) || 'null'); } catch { return null; } },
  set(p) { try { localStorage.setItem(PEND, JSON.stringify(p)); } catch { /* */ } },
  clear() { localStorage.removeItem(PEND); },
};

export function startHeartbeat(claimId, onLost) {
  stopHeartbeat();
  S.hb = setInterval(async () => {
    try { await api.heartbeat(claimId); }
    catch (e) { if (['CLAIM_LOST', 'TASK_GONE'].includes(e.code)) { stopHeartbeat(); onLost(); } }
  }, 90000);
}
export function stopHeartbeat() { if (S.hb) clearInterval(S.hb); S.hb = null; }

export function productCard({ name, sku, category, imageUrl, showImage = true, emptyText = 'مفيش صورة' }) {
  const box = h('div', { class: 'pimg' });
  const setImage = (src, label) => {
    box.replaceChildren();
    if (!src) { box.append(h('div', { class: 'ph' }, '🖼️'), h('div', { class: 'muted', style: { position: 'absolute', bottom: '12px' } }, emptyText)); return; }
    const img = h('img', { src, alt: name || 'صورة المنتج', loading: 'eager', decoding: 'async' });
    img.addEventListener('error', () => { box.replaceChildren(h('div', { class: 'ph' }, '🖼️'), h('div', { class: 'muted', style: { position: 'absolute', bottom: '12px' } }, 'الصورة مش بتفتح')); });
    box.append(img, h('div', { class: 'zoom' }, '🔍 اضغط للتكبير'));
    box.onclick = () => zoomImage(src);
  };
  setImage(showImage ? imageUrl : null);
  const meta = [category, sku].filter(Boolean).join(' · ');
  return { node: h('div', null, box, h('div', { class: 'pname' }, name), meta && h('div', { class: 'muted' }, meta)), setImage };
}

export function topBar({ onBack, label }) {
  const p = S.me;
  return h('div', { class: 'row between', style: { marginBottom: '12px' } },
    h('button', { class: 'icon-btn', 'aria-label': 'رجوع', onclick: onBack }, '→'),
    label && h('span', { class: 'chip' }, label),
    p && h('span', { class: 'chip', title: 'مهام النهاردة' }, `🎯 ${p.today.count}/${p.today.goal}`),
    p && h('span', { class: 'chip' }, `⭐ ${fmt(p.total_xp)}`));
}

export function skeleton() {
  return h('div', { class: 'screen stack' }, h('div', { class: 'skel', style: { height: '48px', width: '40%' } }),
    h('div', { class: 'skel', style: { aspectRatio: '4/3' } }), h('div', { class: 'skel', style: { height: '36px' } }),
    h('div', { class: 'skel', style: { height: '64px' } }), h('div', { class: 'skel', style: { height: '64px' } }));
}

export function errorScreen(message, onRetry, onHome) {
  return h('div', { class: 'screen center stack', style: { justifyContent: 'center' } },
    h('div', { style: { fontSize: '64px' } }, '📡'), h('h2', null, 'استنى لحظة'), h('p', { class: 'muted' }, message),
    onRetry && h('button', { class: 'btn primary', onclick: onRetry }, 'حاول تاني'),
    onHome && h('button', { class: 'btn ghost', onclick: onHome }, 'الرئيسية'));
}

// ── مكافأة بعد كل مهمة ──
export async function celebrate(res, { sub } = {}) {
  const prev = S.me;
  if (S.me) Object.assign(S.me, { total_xp: res.total_xp, level: res.level, streak: res.streak, today: res.today });
  const levelUp = !!(prev && res.level && res.level.level > prev.level.level);
  const gained = (res.xp_gained || 0) + (res.bonus_xp || 0);
  const big = !!res.product_completed || levelUp;
  haptic('success');
  const ov = h('div', { class: 'ov reward' }, h('div', { class: 'box' },
    h('div', { class: 'check' }, '✓'),
    gained > 0 && h('div', { class: 'xp' }, `+${gained} XP`),
    res.product_completed && h('div', { class: 'q gold' }, 'المنتج ده اكتملت بياناته بالكامل 🎉'),
    sub && h('div', { class: 'muted' }, sub)));
  document.getElementById('overlay-root').append(ov);
  if (big) confetti();
  await sleep(big ? 1700 : 800);
  ov.remove();
  for (const a of res.achievements || []) { haptic('success'); toast(`${a.icon} إنجاز جديد: ${a.title}`, false, 2200); await sleep(900); }
  if (res.today && res.today.count === res.today.goal) toast('🎯 حققت هدفك اليومي — برافو!', false, 2400);
  if (levelUp) await dialog({ title: '🎖️ مستوى جديد!', message: `بقيت "${res.level.title}"`, ok: 'كمّل', cancel: null });
}

// ── إرسال إجابة مع كل سيناريوهات الأخطاء. ما بنضيّعش اللي المستخدم كتبه أبداً ──
// بيرجّع { ok:true, res } أو { ok:false, reload?:bool }
export async function submitFlow({ send, kind, claimId, payload, onInvalid }) {
  for (;;) {
    pending.set({ kind, claimId, payload });
    try {
      const res = await send(payload);
      pending.clear();
      return { ok: true, res };
    } catch (e) {
      switch (e.code) {
        case 'NETWORK': {
          haptic('error');
          const again = await dialog({ title: 'النت واقف', message: 'إجابتك محفوظة ومش هتضيع. اضغط "حاول تاني" لما النت يرجع.', ok: 'حاول تاني', cancel: 'لاحقاً' });
          if (again) continue;
          return { ok: false };
        }
        case 'CONFIRM_REQUIRED': {
          const yes = await dialog({ message: e.message, ok: 'أيوه، متأكد', cancel: 'لأ، هراجع' });
          if (yes) { payload = { ...payload, confirm: true }; continue; }
          pending.clear(); return { ok: false };
        }
        case 'AUTH': return { ok: false };
        case 'CLAIM_LOST': case 'STALE_VALUE': case 'TASK_GONE':
          pending.clear(); toast(e.message, true, 3200); return { ok: false, reload: true };
        case 'INVALID': case 'INVALID_IMAGE': case 'FORBIDDEN': case 'SESSION_CLOSED':
          pending.clear(); haptic('error'); (onInvalid || (m => toast(m, true)))(e.message, e.code); return { ok: false };
        default:
          pending.clear(); haptic('error'); toast(e.message || 'حصلت مشكلة. جرّب تاني.', true, 3200); return { ok: false };
      }
    }
  }
}

export function parseNum(s) {
  if (typeof s !== 'string') return NaN;
  const t = s.replace(/[\u0660-\u0669]/g, d => d.charCodeAt(0) - 0x0660).replace(/[\u06F0-\u06F9]/g, d => d.charCodeAt(0) - 0x06F0)
    .replace(/[\u066C,\u060C\s]/g, '').replace(/\u066B/g, '.');
  return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
}

export function numberEditor({ label, unit, initial = '', decimal = true, saveText = 'حفظ ✓', onSave, onCancel }) {
  const input = h('input', { class: 'field', type: 'text', inputmode: decimal ? 'decimal' : 'numeric', autocomplete: 'off', dir: 'ltr', value: initial === '' ? '' : String(initial), 'aria-label': label });
  const hint = h('div', { class: 'hint muted center' });
  const refresh = () => { const v = parseNum(input.value); hint.className = 'hint center muted'; hint.textContent = Number.isFinite(v) && v > 0 || v === 0 ? `${fmt(v)} ${unit || ''}` : ''; };
  input.addEventListener('input', refresh); refresh();
  const save = h('button', { class: 'btn primary', onclick: () => {
    const v = parseNum(input.value);
    if (!Number.isFinite(v)) { hint.className = 'hint center err'; hint.textContent = 'خلينا نتأكد من الرقم ده — اكتبه بالأرقام بس.'; haptic('error'); return; }
    onSave(input.value);
  } }, saveText);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); });
  const node = h('div', { class: 'stack' }, h('div', { class: 'q' }, label), input, hint, save, onCancel && h('button', { class: 'btn ghost', onclick: onCancel }, 'رجوع'));
  setTimeout(() => input.focus(), 60);
  return { node, hint, input, save };
}
