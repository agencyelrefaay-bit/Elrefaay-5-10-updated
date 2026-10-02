// inventory.js — لعبة الجرد: اختار المكان، وبعدين منتج واحد في المرة
import { api } from './api.js';
import { h, fmt, uuid, toast, haptic } from './ui.js';
import { S, mount, productCard, topBar, skeleton, errorScreen, celebrate, submitFlow, startHeartbeat, stopHeartbeat, parseNum } from './state.js';

export async function runInventory() {
  for (;;) {
    mount(skeleton());
    let locs;
    try { locs = await api.invLocations(); }
    catch (e) {
      if (e.code === 'AUTH') return;
      const a = await new Promise(res => mount(errorScreen(e.message, () => res('retry'), () => res('home'))));
      if (a === 'home') return S.goHome(); continue;
    }
    const chosen = await new Promise(res => mount(locationScreen(locs, res)));
    if (chosen === 'home') return S.goHome();
    let start;
    try { start = await api.invStart(chosen); } catch (e) { if (e.code === 'AUTH') return; toast(e.message, true); continue; }
    const out = await countLoop(start);
    if (out === 'home') return S.goHome();
    // 'locations' → نرجع لاختيار المكان
  }
}

function locationScreen(locs, done) {
  return h('div', { class: 'screen stack' },
    topBar({ onBack: () => done('home'), label: 'الجرد' }),
    h('h1', null, 'اختار مكان الجرد'), h('p', { class: 'muted' }, 'هتعدّ المنتجات واحد واحد في المكان اللي تختاره.'),
    locs.length ? locs.map(l => {
      const pct = l.total ? Math.round((l.counted / l.total) * 100) : 0;
      return h('button', { class: 'card opt', style: { display: 'block', width: '100%', textAlign: 'right' }, onclick: () => done(l.id) },
        h('div', { class: 'row between' }, h('h3', null, `${l.type === 'showroom' ? '🏪' : '🏬'} ${l.name}`), h('span', { class: 'chip' }, `${fmt(l.counted)} / ${fmt(l.total)}`)),
        h('div', { class: 'bar', style: { marginTop: '10px' } }, h('i', { style: { width: pct + '%' } })));
    }) : h('div', { class: 'card muted center' }, 'مفيش أماكن متاحة ليك. كلّم المدير.'));
}

async function countLoop(start) {
  for (;;) {
    mount(skeleton());
    let r;
    try { r = await api.invNext(start.session_id); }
    catch (e) {
      if (e.code === 'AUTH') return;
      if (e.code === 'SESSION_CLOSED') { toast(e.message, true); return 'locations'; }
      const a = await new Promise(res => mount(errorScreen(e.message, () => res('retry'), () => res('home'))));
      if (a === 'home') return 'home'; continue;
    }
    if (r.empty) {
      const a = await new Promise(res => mount(h('div', { class: 'screen center stack', style: { justifyContent: 'center' } },
        h('div', { style: { fontSize: '72px' } }, '📦'), h('h1', null, 'خلصت اللي متاح ليك'),
        h('p', { class: 'muted' }, `اتعدّ ${fmt(r.progress.counted)} من ${fmt(r.progress.total)} منتج في ${r.location.name}. المنتجات اللي اتخطيت ممكن ترجعلها بعد شوية.`),
        h('button', { class: 'btn primary', onclick: () => res('locations') }, 'مكان تاني'), h('button', { class: 'btn ghost', onclick: () => res('home') }, 'الرئيسية'))));
      return a;
    }
    const out = await countScreen(r.task, r.progress);
    if (out === 'home') return 'home';
  }
}

function countScreen(task, progress) {
  return new Promise(resolve => {
    let finished = false, busy = false;
    const finish = o => { if (finished) return; finished = true; stopHeartbeat(); resolve(o); };
    const p = task.product;
    const card = productCard({ name: p.name, sku: p.sku, category: p.category_name, imageUrl: p.image_url, showImage: !!p.image_url });
    const body = h('div', { class: 'actions' });
    const root = h('div', { class: 'screen' }, topBar({ onBack: () => { api.release(task.claim_id); finish('home'); }, label: task.location.name }),
      h('div', { class: 'bar', style: { marginBottom: '12px' } }, h('i', { style: { width: (progress.total ? (progress.counted / progress.total) * 100 : 0) + '%' } })), card.node, body);
    mount(root);
    startHeartbeat(task.claim_id, () => { toast('المهمة اتحوّلت لزميل — هنجيبلك منتج تاني', true); finish('reload'); });

    const send = async (qty, onInvalid) => {
      if (busy) return; busy = true; root.style.pointerEvents = 'none';
      const out = await submitFlow({ kind: 'inv', claimId: task.claim_id, payload: { qty: String(qty), request_id: uuid() }, send: pl => api.invAnswer(task.claim_id, pl), onInvalid });
      busy = false; root.style.pointerEvents = '';
      if (out.ok) { const ip = out.res.inventory_progress; await celebrate(out.res, { sub: ip ? `${fmt(ip.counted)} من ${fmt(ip.total)} اتعدّوا` : '' }); return finish('done'); }
      if (out.reload) finish('reload');
    };
    const skip = async () => {
      if (busy) return; busy = true;
      try { await api.skip(task.claim_id, uuid()); haptic(); finish('skip'); } catch (e) { busy = false; if (e.code !== 'AUTH') toast(e.message, true); }
    };

    const qtyView = () => {
      const input = h('input', { class: 'field', type: 'text', inputmode: p.allow_fractional ? 'decimal' : 'numeric', value: '1', dir: 'ltr', autocomplete: 'off', 'aria-label': 'الكمية' });
      const err = h('div', { class: 'hint center err' });
      const bump = d => { const v = parseNum(input.value); input.value = String(Math.max(0, (Number.isFinite(v) ? v : 0) + d)); haptic(); };
      const save = () => {
        const v = parseNum(input.value);
        if (!Number.isFinite(v)) { err.textContent = 'خلينا نتأكد من الرقم ده — اكتبه بالأرقام بس.'; haptic('error'); return; }
        send(v, m => { err.textContent = m; });
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
      body.replaceChildren(h('div', { class: 'q' }, 'كام قطعة موجودة؟'),
        h('div', { class: 'row' }, h('button', { class: 'icon-btn', style: { width: '68px', height: '68px', fontSize: '32px' }, 'aria-label': 'أقل', onclick: () => bump(-1) }, '−'), h('div', { class: 'grow' }, input),
          h('button', { class: 'icon-btn', style: { width: '68px', height: '68px', fontSize: '32px' }, 'aria-label': 'أكتر', onclick: () => bump(1) }, '+')),
        err, h('button', { class: 'btn primary', onclick: save }, 'حفظ الكمية ✓'), h('button', { class: 'btn ghost', onclick: mainView }, 'رجوع'));
      setTimeout(() => { input.focus(); input.select(); }, 60);
    };
    const mainView = () => body.replaceChildren(h('div', { class: 'q' }, `المنتج ده موجود في ${task.location.name}؟`),
      h('button', { class: 'btn ok', onclick: qtyView }, '✓ أيوه، موجود'),
      h('button', { class: 'btn', onclick: () => send(0) }, '✗ لأ، مش موجود (٠)'),
      h('button', { class: 'btn ghost', onclick: skip }, '⏭️ مش عارف / تخطي'));
    mainView();
  });
}
