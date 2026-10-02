// ui.js — أدوات واجهة صغيرة: بناء عناصر آمن (من غير innerHTML)، توست، اهتزاز، كونفيتي، ضغط صور
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') throw new Error('innerHTML غير مسموح');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export const fmt = n => Number(n).toLocaleString('en-US');
export const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function haptic(kind = 'tap') {
  try { navigator.vibrate && navigator.vibrate(kind === 'success' ? [18, 40, 28] : kind === 'error' ? [60] : 12); } catch { /* iOS Safari بيتجاهلها */ }
}

export function toast(msg, isErr = false, ms = 2600) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

const root = () => document.getElementById('overlay-root');
export function closeOverlays() { root().replaceChildren(); }

export function dialog({ title, message, ok = 'تمام', cancel = 'رجوع' }) {
  return new Promise(resolve => {
    const done = v => { ov.remove(); resolve(v); };
    const ov = h('div', { class: 'ov', role: 'dialog' },
      h('div', { class: 'dialog stack' },
        title && h('h2', null, title), h('div', { class: 'q', style: { margin: 0 } }, message),
        h('button', { class: 'btn primary', onclick: () => done(true) }, ok),
        cancel && h('button', { class: 'btn ghost', onclick: () => done(false) }, cancel)));
    root().append(ov);
  });
}

export function sheet(children) {
  const ov = h('div', { class: 'ov sheet', onclick: e => { if (e.target === ov) ov.remove(); } }, h('div', { class: 'sheet-body stack' }, children));
  root().append(ov);
  return ov;
}

export function zoomImage(src) {
  const img = h('img', { src, alt: '' });
  img.addEventListener('click', () => img.classList.toggle('big'));
  const ov = h('div', { class: 'zoomov' }, h('button', { class: 'icon-btn x', 'aria-label': 'إغلاق', onclick: () => ov.remove() }, '✕'), img);
  document.body.append(ov);
}

export function confetti(ms = 1800) {
  if (reduced()) return;
  const c = h('canvas', { class: 'confetti' });
  c.width = innerWidth; c.height = innerHeight;
  document.body.append(c);
  const ctx = c.getContext('2d');
  const colors = ['#e0ab48', '#f3cf7a', '#3ecf8e', '#ffffff', '#ff8a65'];
  const ps = Array.from({ length: 90 }, () => ({ x: c.width / 2, y: c.height * 0.4, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4, s: 5 + Math.random() * 6, col: colors[(Math.random() * colors.length) | 0], r: Math.random() * 6 }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of ps) { p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.r += 0.2; ctx.fillStyle = p.col; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore(); }
    if (t - t0 < ms) requestAnimationFrame(frame); else c.remove();
  })(t0);
}

// ضغط الصورة قبل الرفع: أقصى بعد 1600px وجودة 82% — بيصحّح اتجاه كاميرا الموبايل كمان
export async function compressImage(file, max = 1600, quality = 0.82) {
  if (!file || !file.type.startsWith('image/')) throw new Error('الملف ده مش صورة.');
  if (file.size > 40 * 1024 * 1024) throw new Error('الصورة كبيرة أوي.');
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('مقدرناش نقرا الصورة.')); i.src = URL.createObjectURL(file); });
  }
  const w = bmp.width || bmp.naturalWidth, hgt = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, max / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(hgt * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('مقدرناش نجهّز الصورة.');
  return blob;
}
