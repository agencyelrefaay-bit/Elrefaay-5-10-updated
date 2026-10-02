// tasks.js — مسار مراجعة بيانات المنتجات: سؤال واحد في المرة
import { api } from './api.js';
import { h, fmt, uuid, toast, haptic, compressImage } from './ui.js';
import { S, mount, productCard, topBar, skeleton, errorScreen, celebrate, submitFlow, startHeartbeat, stopHeartbeat, numberEditor } from './state.js';

const COLOR_NAMES = { white: 'أبيض', black: 'أسود', gold: 'دهبي' };
const COLOR_HEX = { white: '#ffffff', black: '#111111', gold: '#d4a017' };
const PALETTE = [['#d32f2f', 'أحمر'], ['#1976d2', 'أزرق'], ['#388e3c', 'أخضر'], ['#f9a825', 'أصفر'], ['#ef6c00', 'برتقالي'], ['#8d6e63', 'بني'],
  ['#9e9e9e', 'رمادي'], ['#c0c0c0', 'فضي'], ['#e91e63', 'وردي'], ['#7b1fa2', 'بنفسجي'], ['#d7ccc8', 'بيج'], ['#00897b', 'تركواز']];

export async function runTasks(mode) {
  for (;;) {
    mount(skeleton());
    let r;
    try { r = await api.next(mode); }
    catch (e) {
      if (e.code === 'AUTH') return;
      const retry = new Promise(res => mount(errorScreen(e.message, () => res('retry'), () => res('home'))));
      if ((await retry) === 'home') return S.goHome();
      continue;
    }
    if (r.empty) return mount(emptyScreen());
    const out = await taskScreen(r.task, mode);
    if (out === 'home') return S.goHome();
  }
}

function emptyScreen() {
  return h('div', { class: 'screen center stack', style: { justifyContent: 'center' } },
    h('div', { style: { fontSize: '72px' } }, '🎉'), h('h1', null, 'خلصت كل المهام المتاحة!'),
    h('p', { class: 'muted' }, 'مفيش حاجة تانية محتاجة مراجعة دلوقتي. لو في مهام اتعمل لها تخطي أو زملاءك شغالين عليها، هترجع تظهر بعدين.'),
    h('button', { class: 'btn primary', onclick: () => S.goHome() }, 'الرئيسية'));
}

const money = n => `${fmt(n)} جنيه`;

function taskScreen(task, mode) {
  return new Promise(resolve => {
    const f = task.field, kind = task.kind;
    let finished = false;
    const finish = o => { if (finished) return; finished = true; stopHeartbeat(); resolve(o); };
    const showImg = f === 'image' ? kind === 'verify' : true;
    const card = productCard({
      name: task.product.name, sku: task.product.sku, category: task.product.category_name,
      imageUrl: task.product.image_url, showImage: showImg && !!task.product.image_url,
      emptyText: f === 'image' ? 'مفيش صورة للمنتج ده لسه' : 'مفيش صورة',
    });
    const body = h('div', { class: 'actions' });
    const setBody = (...n) => body.replaceChildren(...n.flat());
    const root = h('div', { class: 'screen' },
      topBar({ onBack: () => { api.release(task.claim_id); finish('home'); } }),
      card.node, body);
    mount(root);
    startHeartbeat(task.claim_id, () => { toast('المهمة اتحوّلت لزميل — هنجيبلك مهمة جديدة', true); finish('reload'); });

    // ---- إجراءات عامة ----
    let busy = false;
    const send = async (payload, onInvalid) => {
      if (busy) return; busy = true; root.style.pointerEvents = 'none';
      const out = await submitFlow({ kind: 'task', claimId: task.claim_id, payload: { ...payload, request_id: uuid(), token: task.token }, send: p => api.answer(task.claim_id, p), onInvalid });
      busy = false; root.style.pointerEvents = '';
      if (out.ok) { await celebrate(out.res); return finish('done'); }
      if (out.reload) return finish('reload');
    };
    const skip = async () => {
      if (busy) return; busy = true;
      try { await api.skip(task.claim_id, uuid()); haptic(); finish('skip'); }
      catch (e) { busy = false; if (e.code !== 'AUTH') toast(e.message, true); }
    };
    const confirm = () => send({ action: 'confirm' });

    const confirmButtons = ({ yes = '✓ أيوه، صحيح', edit = '✏️ تعديل', onEdit, no }) => [
      h('button', { class: 'btn ok', onclick: confirm }, yes),
      h('button', { class: 'btn', onclick: no || onEdit }, edit),
      h('button', { class: 'btn ghost', onclick: skip }, '⏭️ مش متأكد / تخطي'),
    ];
    const askAgain = fn => () => fn();

    // ---- حقول نصية/رقمية ----
    const priceFlow = () => {
      const label = f === 'sale_price' ? 'سعر البيع' : 'سعر التكلفة (سعر الشراء)';
      const edit = () => {
        const ed = numberEditor({
          label: kind === 'verify' ? `${label} الصح كام؟` : `${label} كام؟`, unit: 'جنيه', initial: kind === 'verify' ? task.current : '',
          onCancel: kind === 'verify' ? () => view() : null,
          onSave: v => send({ action: 'set', value: v }, m => { ed.hint.className = 'hint center err'; ed.hint.textContent = m; }),
        });
        setBody(ed.node);
      };
      const view = () => {
        if (kind === 'verify') setBody(h('div', { class: 'q' }, `${label} الحالي ${money(task.current)}، صح؟`), confirmButtons({ yes: '✓ أيوه، صحيح', edit: '✏️ تعديل السعر', onEdit: edit }));
        else edit();
      };
      view();
    };

    const nameFlow = () => {
      const edit = () => {
        const input = h('input', { class: 'field text', type: 'text', value: kind === 'verify' ? task.current : '', maxlength: 200, autocomplete: 'off', 'aria-label': 'اسم المنتج' });
        const err = h('div', { class: 'hint err' });
        const save = () => { const v = input.value.trim(); if (v.length < 2) { err.textContent = 'اكتب اسم المنتج كامل.'; haptic('error'); return; } send({ action: 'set', value: v }, m => { err.textContent = m; }); };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
        setBody(h('div', { class: 'q' }, kind === 'verify' ? 'اسم المنتج الصح إيه؟' : 'اسم المنتج إيه؟'), input, err,
          h('button', { class: 'btn primary', onclick: save }, 'حفظ ✓'), kind === 'verify' && h('button', { class: 'btn ghost', onclick: view }, 'رجوع'));
        setTimeout(() => input.focus(), 60);
      };
      const view = () => kind === 'verify'
        ? setBody(h('div', { class: 'q' }, 'الاسم ده مكتوب صح؟'), confirmButtons({ yes: '✓ أيوه، صحيح', edit: '✏️ تعديل الاسم', onEdit: edit }))
        : edit();
      view();
    };

    // ---- التصنيف ----
    const categoryFlow = () => {
      const pick = async () => {
        setBody(h('div', { class: 'skel', style: { height: '200px' } }));
        try { S.cats = S.cats || await api.categories(); } catch (e) { toast(e.message, true); return view(); }
        const list = h('div', { class: 'grid' });
        const search = h('input', { class: 'field text', type: 'search', placeholder: 'دوّر على التصنيف…', 'aria-label': 'بحث' });
        const paint = () => {
          const q = search.value.trim();
          list.replaceChildren(...S.cats.filter(c => !q || c.name.includes(q)).map(c => h('button', { class: 'opt' + (String(c.id) === String(task.current) ? ' sel' : ''), onclick: () => send({ action: 'set', value: c.id }) }, c.name)));
          if (!list.children.length) list.append(h('div', { class: 'muted' }, 'مفيش تصنيف بالاسم ده.'));
        };
        search.addEventListener('input', paint); paint();
        setBody(h('div', { class: 'q' }, 'المنتج ده تصنيفه إيه؟'), S.cats.length > 8 && search, list, kind === 'verify' && h('button', { class: 'btn ghost', onclick: view }, 'رجوع'));
      };
      const view = () => kind === 'verify'
        ? setBody(h('div', { class: 'q' }, `التصنيف "${task.product.category_name || ''}" صح؟`), confirmButtons({ edit: '✏️ تغيير التصنيف', onEdit: pick }))
        : pick();
      view();
    };

    // ---- اللون ----
    const colorFlow = () => {
      const label = c => c.preset === 'custom' ? (PALETTE.find(p => p[0] === c.hex) || [0, 'لون مخصص'])[1] : COLOR_NAMES[c.preset];
      const sw = hex => h('span', { class: 'sw', style: { background: hex } });
      const pick = () => {
        const presets = ['white', 'black', 'gold'].map(p => h('button', { class: 'opt', onclick: () => send({ action: 'set', value: { preset: p } }) }, sw(COLOR_HEX[p]), COLOR_NAMES[p]));
        const more = () => setBody(h('div', { class: 'q' }, 'اختار اللون'),
          h('div', { class: 'grid' }, PALETTE.map(([hex, nm]) => h('button', { class: 'opt', onclick: () => send({ action: 'set', value: { preset: 'custom', hex } }) }, sw(hex), nm))),
          h('button', { class: 'btn ghost', onclick: pick }, 'رجوع'));
        setBody(h('div', { class: 'q' }, 'لون المنتج إيه؟'), h('div', { class: 'grid' }, presets, h('button', { class: 'opt', onclick: more }, '🎨 لون تاني')),
          h('button', { class: 'btn', onclick: () => send({ action: 'set', value: { preset: 'none' } }) }, 'مفيش لون محدد'),
          h('button', { class: 'btn ghost', onclick: skip }, '⏭️ مش متأكد / تخطي'));
      };
      const view = () => kind === 'verify'
        ? setBody(h('div', { class: 'q row' }, sw(task.current.preset === 'custom' ? task.current.hex : COLOR_HEX[task.current.preset]), `اللون "${label(task.current)}" صح؟`), confirmButtons({ edit: '✏️ تغيير اللون', onEdit: pick }))
        : pick();
      view();
    };

    // ---- الصورة ----
    const imageFlow = () => {
      if (kind === 'verify') {
        const reject = async () => {
          if (busy) return;
          const out = await (async () => { busy = true; root.style.pointerEvents = 'none';
            const o = await submitFlow({ kind: 'task', claimId: task.claim_id, payload: { action: 'reject_image', request_id: uuid(), token: task.token }, send: p => api.answer(task.claim_id, p) });
            busy = false; root.style.pointerEvents = ''; return o; })();
          if (out.ok) { card.setImage(null); card.node.querySelector('.pname').textContent = task.product.name; upload(); }
          else if (out.reload) finish('reload');
        };
        setBody(h('div', { class: 'q' }, 'هل دي صورة المنتج ده؟'), h('button', { class: 'btn ok', onclick: confirm }, '✓ نعم، الصورة صحيحة'),
          h('button', { class: 'btn danger', onclick: reject }, '✗ لا، دي مش صورته'), h('button', { class: 'btn ghost', onclick: skip }, '⏭️ تخطي'));
      } else upload();
    };

    const upload = () => {
      let blob = null, requestId = uuid();
      const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
      const gallery = h('input', { type: 'file', accept: 'image/*', hidden: true });
      const progress = h('div', { class: 'bar', hidden: true }, h('i', { style: { width: '0%' } }));
      const msg = h('div', { class: 'hint center' });
      const pickView = () => {
        blob = null;
        setBody(h('div', { class: 'q' }, 'محتاجين صورة للمنتج ده'), msg, camera, gallery,
          h('button', { class: 'btn primary', onclick: () => camera.click() }, '📷 صوّر دلوقتي'),
          h('button', { class: 'btn', onclick: () => gallery.click() }, '🖼️ اختار من الصور'),
          h('button', { class: 'btn ghost', onclick: skip }, '⏭️ تخطي'));
      };
      const onFile = async e => {
        const file = e.target.files && e.target.files[0]; e.target.value = '';
        if (!file) return;
        msg.className = 'hint center muted'; msg.textContent = 'بنجهّز الصورة…';
        try { blob = await compressImage(file); } catch (err) { msg.className = 'hint center err'; msg.textContent = err.message; haptic('error'); return; }
        requestId = uuid();
        card.setImage(URL.createObjectURL(blob));
        previewView();
      };
      camera.addEventListener('change', onFile); gallery.addEventListener('change', onFile);
      const doUpload = async () => {
        if (busy) return; busy = true;
        progress.hidden = false; setBody(h('div', { class: 'q' }, 'بنرفع الصورة…'), progress);
        try {
          const res = await api.upload(task.claim_id, blob, requestId, p => { progress.firstChild.style.width = Math.round(p * 100) + '%'; });
          busy = false; await celebrate(res); finish('done');
        } catch (e) {
          busy = false; haptic('error');
          if (['CLAIM_LOST', 'TASK_GONE'].includes(e.code)) { toast(e.message, true, 3200); return finish('reload'); }
          if (e.code === 'AUTH') return;
          const retryable = e.code === 'NETWORK' || e.status >= 500 || e.code === 'ERROR';
          setBody(h('div', { class: 'q' }, e.message), retryable && h('button', { class: 'btn primary', onclick: doUpload }, '🔁 حاول تاني'),
            h('button', { class: 'btn', onclick: () => { card.setImage(null); pickView(); } }, retryable ? 'صوّر/اختار صورة تانية' : '📷 صوّر/اختار صورة تانية'));
        }
      };
      const previewView = () => setBody(h('div', { class: 'q' }, 'الصورة دي كويسة؟'), h('button', { class: 'btn ok', onclick: doUpload }, '✓ ارفع الصورة'),
        h('button', { class: 'btn', onclick: () => { card.setImage(null); pickView(); } }, '🔄 غيّر الصورة'));
      pickView();
    };

    if (f === 'sale_price' || f === 'cost_price') priceFlow();
    else if (f === 'name') nameFlow();
    else if (f === 'category') categoryFlow();
    else if (f === 'color') colorFlow();
    else if (f === 'image') imageFlow();
    else finish('reload');
  });
}
