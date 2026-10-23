/* ═══════════════════════════════════════════════════════════════════════
   shrouk-mobile.js — طبقة تحسين الموبايل/iOS (حساب المالكة "شروق" أولاً)
   ───────────────────────────────────────────────────────────────────────
   • لا تعدّل منطق النظام: بتغلّف دوال موجودة (API.req, navigate, load*, filter*,
     renderResponsiveDataView) وتفعّل نفسها فقط لو role=owner و username=shrouk.
   • أي حساب تاني: الملف بيخرج فوراً بدون أي أثر.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ───────── 0) التفعيل ───────── */
  function isShroukUser(u) {
    return !!u && u.role === 'owner' && String(u.username || '').trim().toLowerCase() === 'shrouk';
  }
  function currentUser() {
    try { if (typeof state !== 'undefined' && state && state.user) return state.user; } catch (_) {}
    try { return JSON.parse(localStorage.getItem('arUser') || 'null'); } catch (_) { return null; }
  }
  const ROOT = document.documentElement;
  let installed = false;
  const startedAt = Date.now();

  function boot() {
    if (!isShroukUser(currentUser())) return;
    activate();
  }
  function activate() {
    ROOT.classList.add('shrouk-ux');
    if (installed) return;
    installed = true;
    setViewportCover();
    const steps = [installApiLayer, installSearch, installLoaders, installProgressiveRender, installPageFx,
      installPullToRefresh, installSheetDrag, installKeyboardAwareness, installInputHints,
      installHaptics, installPalette, installFilterBars, installFabAutoHide, installDashboardHero, installVisibilityRefresh, hideSplashWhenReady, prefetchLists];
    steps.forEach(fn => { try { fn(); } catch (e) { console.warn('[shrouk-ux]', fn.name, e); } });
  }

  // تسجيل الدخول لأول مرة (بعد تحميل الصفحة): initApp بتتنادى تاني، نفعّل وقتها
  const wrapInit = () => {
    if (typeof window.initApp !== 'function' || window.initApp.__sx) return;
    const orig = window.initApp;
    window.initApp = function () { const r = orig.apply(this, arguments); setTimeout(boot, 0); return r; };
    window.initApp.__sx = true;
  };

  /* ───────── أدوات صغيرة ───────── */
  const $ = (s, r) => (r || document).querySelector(s);
  const val = id => (document.getElementById(id) || {}).value || '';
  const raf = fn => requestAnimationFrame(fn);
  const idle = fn => ('requestIdleCallback' in window) ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 250);
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function debounce(fn, ms) { let t; const d = function () { const a = arguments, self = this; clearTimeout(t); t = setTimeout(() => fn.apply(self, a), ms); }; d.flush = () => { clearTimeout(t); }; return d; }
  function isMobileWidth() { return window.innerWidth < 900; }
  function fmtMoney(n) { try { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); } catch (_) { return String(n); } }

  function setViewportCover() {
    // مهم لـ iOS: من غير viewport-fit=cover قيم env(safe-area-inset-*) بتبقى صفر
    // فالشريط السفلي بيتغطى بشريط الـ Home وشريط الحالة بيتداخل مع الهيدر.
    const m = document.querySelector('meta[name="viewport"]');
    if (m && !/viewport-fit/.test(m.content)) m.content = m.content.replace(/\s*$/, '') + ', viewport-fit=cover';
  }

  /* ───────── 1) الطبقة السريعة للـ API: نتيجة فورية + تحديث في الخلفية ─────────
     قرار أمان مقصود: الكاش في ذاكرة الصفحة فقط (مش IndexedDB ولا الـ Service
     Worker) وعمره 10 دقايق بحد أقصى، وأي عملية كتابة (POST/PUT/DELETE) بتمسحه كله،
     والقايمة بتتحدّث من السيرفر في الخلفية فوراً وبتتبدّل لو اتغيّرت. يعني قاعدة
     "مفيش بيانات مالية قديمة" في sw.js فاضلة محترمة. */
  const SWR_PATHS = new Set(['/customers', '/suppliers', '/products']);
  const SWR_TTL = 10 * 60 * 1000, SWR_RECHECK = 1500;
  const swr = new Map(), revalidating = new Set();
  let inflight = 0, barTimer = 0, firstDataDone = false;

  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i += 7) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ':' + s.length; }
  function barOn() { if (!inflight) return; const b = $('#sxBar'); if (b) b.classList.add('on'); }
  function barOff() { const b = $('#sxBar'); if (b) b.classList.remove('on'); }

  function installApiLayer() {
    if (typeof API === 'undefined' || API.__sx) return;
    const origReq = API.req;
    const track = async (fn) => {
      inflight++; if (!barTimer) barTimer = setTimeout(() => { barTimer = 0; barOn(); }, 140);
      try { return await fn(); }
      finally { inflight--; if (!inflight) { clearTimeout(barTimer); barTimer = 0; barOff(); } }
    };
    API.req = function (method, path, body) {
      const self = this;
      if (method === 'GET' && SWR_PATHS.has(path)) {
        const hit = swr.get(path), now = Date.now();
        if (hit && now - hit.at < SWR_TTL) {
          if (now - hit.checked > SWR_RECHECK && !revalidating.has(path)) revalidate(path);
          return Promise.resolve(hit.data);
        }
        return track(() => origReq.call(self, method, path, body)).then(data => {
          swr.set(path, { data, at: Date.now(), checked: Date.now(), sig: hashStr(JSON.stringify(data)) });
          if (path === '/products') firstDataDone = true;
          return data;
        });
      }
      const isWrite = method !== 'GET';
      return track(() => origReq.call(self, method, path, body)).finally(() => { if (isWrite) swr.clear(); });
    };
    API.__sx = true;
    API.__sxClear = () => swr.clear();

    function revalidate(path) {
      revalidating.add(path);
      origReq.call(API, 'GET', path).then(data => {
        const sig = hashStr(JSON.stringify(data)), prev = swr.get(path);
        swr.set(path, { data, at: Date.now(), checked: Date.now(), sig });
        if (prev && prev.sig !== sig) {
          // البيانات اتغيّرت في السيرفر: ارسم الصفحة المفتوحة بالجديد
          const pageForPath = { '/customers': 'customers', '/suppliers': 'suppliers', '/products': 'products' }[path];
          try { if (typeof state !== 'undefined' && state.currentPage === pageForPath) window.refreshActiveRouteAfterRemoteChange && window.refreshActiveRouteAfterRemoteChange(); } catch (_) {}
        }
      }).catch(() => {}).finally(() => revalidating.delete(path));
    }
  }

  function prefetchLists() {
    idle(() => { try {
      if (typeof API === 'undefined' || typeof state === 'undefined' || !state.token) return;
      API.get('/customers').catch(() => {});
      API.get('/suppliers').catch(() => {});
    } catch (_) {} });
  }

  /* ───────── 2) بحث سريع ومميز (عربي ذكي + Debounce) ───────── */
  const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[٠-٩۰-۹]/g, d => AR_DIGITS[d])
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
      .replace(/\s+/g, ' ').trim();
  }
  const hayCache = new WeakMap();
  function hay(o, kind) {
    let h = hayCache.get(o);
    if (h === undefined) {
      const parts = kind === 'p' ? [o.name, o.sku, o.barcode, o.category_name, (o.suppliers || []).map(s => s.name).join(' ')]
        : kind === 's' ? [o.name, o.name_en, o.code, o.phone, o.contact_person]
        : [o.name, o.code, o.phone, o.phone2, o.governorate, o.area, o.contact_person];
      h = norm(parts.filter(Boolean).join(' '));
      hayCache.set(o, h);
    }
    return h;
  }
  function tokensMatch(h, q) { if (!q) return true; const t = q.split(' '); for (let i = 0; i < t.length; i++) if (!h.includes(t[i])) return false; return true; }

  window.ShroukSearch = {
    on: () => installed,
    norm,
    product(p, search, field) {
      const q = norm(search); if (!q) return true;
      if (field === 'name') return tokensMatch(norm(p.name), q);
      if (field === 'sku') return norm(p.sku).includes(q.replace(/ /g, ''));
      if (field === 'barcode') return String(p.barcode || '').includes(q.replace(/ /g, ''));
      return tokensMatch(hay(p, 'p'), q);
    },
    supplier(s, search) { return tokensMatch(hay(s, 's'), norm(search)); },
    customer(c, search) { return tokensMatch(hay(c, 'c'), norm(search)); },
  };

  function installSearch() {
    const wrap = (name, delay) => {
      const orig = window[name]; if (typeof orig !== 'function' || orig.__sx) return;
      const d = debounce(function () { orig.apply(null, arguments); }, delay);
      const w = function () { d(); }; w.__sx = true; window[name] = w;
    };
    wrap('filterProducts', 120); wrap('filterSuppliers', 120); wrap('filterInvoices', 120); wrap('filterInventory', 120);

    // العملاء: بحث عربي ذكي + تحميل يحترم الفلتر الحالي بعد أي تحديث
    if (typeof window.filterCustomers === 'function' && !window.filterCustomers.__sx) {
      const run = function () {
        const q = val('customerSearch'), type = val('customerTypeFilter');
        let list = (typeof _allCustomers !== 'undefined' && _allCustomers) || [];
        if (q.trim()) list = list.filter(c => window.ShroukSearch.customer(c, q));
        if (type) list = list.filter(c => c.type === type);
        renderCustomers(list);
      };
      const d = debounce(run, 110);
      window.filterCustomers = function () { d(); }; window.filterCustomers.__sx = true;
      window.__sxRunCustomers = run;
      window.loadCustomers = async function () {
        try { const { customers } = await API.get('/customers'); _allCustomers = customers; run(); }
        catch (e) { toast(e.message, 'danger'); }
      };
    }
  }

  /* ───────── 3) الـ Loader: شريط علوي + شروق الشمس + شاشة الافتتاح ───────── */
  function installLoaders() {
    if (!$('#sxBar')) { const b = document.createElement('div'); b.id = 'sxBar'; b.setAttribute('aria-hidden', 'true'); document.body.appendChild(b); }
  }
  function hideSplashWhenReady() {
    const sp = $('#sxSplash'); if (!sp || !ROOT.hasAttribute('data-sx-splash')) return;
    const MIN = 1900, MAX = 4800;
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      const ready = firstDataDone || (typeof state !== 'undefined' && state.products && state.products.length);
      if ((elapsed >= MIN && ready) || elapsed >= MAX) {
        sp.classList.add('hide'); try { installDashboardHero(); } catch (_) {} setTimeout(() => { ROOT.removeAttribute('data-sx-splash'); sp.remove(); }, 650);
      } else setTimeout(tick, 120);
    };
    tick();
  }

  /* ───────── 4) رسم تدريجي للقوائم الطويلة (عملاء/موردين/فواتير…) ───────── */
  function installProgressiveRender() {
    if (typeof window.renderResponsiveDataView !== 'function' || window.renderResponsiveDataView.__sx) return;
    const orig = window.renderResponsiveDataView;
    const FIRST = 36, STEP = 40;
    const cleanup = el => { if (el && el.__sxIO) { el.__sxIO.disconnect(); el.__sxIO = null; } };

    const wrapped = function (container, opts) {
      const el = typeof container === 'string' ? document.getElementById(container) : container;
      cleanup(el);
      if (!el || !opts || !opts.rows || opts.rows.length <= FIRST || typeof getDataViewMode !== 'function' || getDataViewMode() !== 'cards') {
        return orig.apply(this, arguments);
      }
      const cid = el.id || '';
      const sorted = (window.TableSort && cid) ? TableSort.sortRowsFor(opts, cid) : opts.rows;
      const full = { ...opts, rows: sorted };
      orig.call(this, container, { ...opts, rows: sorted.slice(0, FIRST) });
      el.__rdvOpts = full; // نحتفظ بالقايمة الكاملة (ترتيب الأعمدة بيعتمد عليها)
      let shown = FIRST;
      const sentinel = document.createElement('div');
      sentinel.className = 'sx-more'; sentinel.innerHTML = '<div class="spinner"></div><span>جاري تحميل المزيد…</span>';
      el.appendChild(sentinel);
      const actions = (full.actions || []).filter(a => !a.hideOn || !a.hideOn.includes('cards'));
      const loadMore = () => {
        const list = el.querySelector('.rdv-card-list'); if (!list) return;
        const chunk = full.rows.slice(shown, shown + STEP);
        const t = document.createElement('template');
        t.innerHTML = rdvCardsHTML(full.columns, chunk, actions, { ...full, _cid: cid });
        const frag = document.createDocumentFragment();
        const src = t.content.querySelector('.rdv-card-list');
        while (src && src.firstChild) frag.appendChild(src.firstChild);
        list.appendChild(frag);
        shown += STEP;
        if (shown >= full.rows.length) { cleanup(el); sentinel.remove(); }
      };
      if ('IntersectionObserver' in window) {
        el.__sxIO = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadMore(); }, { rootMargin: '700px 0px' });
        el.__sxIO.observe(sentinel);
      } else { while (shown < full.rows.length) loadMore(); }
    };
    wrapped.__sx = true;
    window.renderResponsiveDataView = wrapped;
  }

  /* ───────── 5) حركة الانتقال بين الصفحات + نعومة ───────── */
  function installPageFx() {
    if (typeof window.navigate !== 'function' || window.navigate.__sx) return;
    const orig = window.navigate; let last = null;
    window.navigate = function (page) {
      const r = orig.apply(this, arguments);
      try {
        const el = document.getElementById('page-' + page);
        if (el) {
          el.classList.remove('sx-enter'); void el.offsetWidth; el.classList.add('sx-enter');
          setTimeout(() => el.classList.remove('sx-enter'), 340);
        }
        if (page !== last) { scrollTopSmooth(); last = page; }
        if (page === 'dashboard') installDashboardHero();
        if (page === 'import') swr.clear();
        document.getElementById('sxPalette')?.classList.remove('open');
      } catch (_) {}
      return r;
    };
    window.navigate.__sx = true;
  }
  function scrollTopSmooth() {
    ['.main', '.page-content'].forEach(s => { const e = $(s); if (e && e.scrollTop) e.scrollTop = 0; });
    window.scrollTo(0, 0);
  }

  /* ───────── 6) اسحب للتحديث (شمس بتطلع) ───────── */
  function findScroller(node) {
    for (let e = node; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2) return e;
    }
    return document.scrollingElement || document.documentElement;
  }
  function installPullToRefresh() {
    const ind = document.createElement('div'); ind.id = 'sxPtr'; ind.innerHTML = '<div class="sx-ptr-disc"></div>'; document.body.appendChild(ind);
    const TRIG = 66, MAX = 96;
    let startY = 0, startX = 0, pulling = false, scroller = null, dist = 0, busy = false;
    const reset = () => { ind.style.transition = 'transform .28s ease, opacity .28s ease'; ind.style.opacity = '0'; ind.style.transform = 'translateY(-70px)'; ind.classList.remove('loading'); pulling = false; dist = 0; };
    document.addEventListener('touchstart', e => {
      if (busy || e.touches.length !== 1 || !isMobileWidth()) return;
      if (document.querySelector('.modal-overlay.open, #sxPalette.open, #ownerStudioPanel.open, .more-page.open')) return;
      if (e.target.closest('input, textarea, select, .filters-bar, .rdv-sort-bar, canvas')) return;
      scroller = findScroller(e.target);
      if (scroller && scroller.scrollTop > 0) { pulling = false; return; }
      startY = e.touches[0].clientY; startX = e.touches[0].clientX; pulling = true; dist = 0; ind.style.transition = 'none';
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY, dx = Math.abs(e.touches[0].clientX - startX);
      if (dy <= 0 || dx > dy) { if (dy <= 0) reset(); return; }
      if (scroller && scroller.scrollTop > 0) { reset(); return; }
      dist = Math.min(MAX, dy * 0.5);
      ind.style.opacity = String(Math.min(1, dist / 36));
      ind.style.transform = 'translateY(' + (dist - 70) + 'px)';
      ind.style.setProperty('--p', String(Math.min(1, dist / TRIG)));
    }, { passive: true });
    const end = async () => {
      if (!pulling) return;
      if (dist >= TRIG && !busy) {
        busy = true; ind.classList.add('loading'); ind.style.transition = 'transform .2s ease'; ind.style.transform = 'translateY(' + (TRIG - 66) + 'px)';
        haptic();
        try { swr.clear(); if (typeof window.refreshActiveRouteAfterRemoteChange === 'function') await window.refreshActiveRouteAfterRemoteChange(); } catch (_) {}
        await new Promise(r => setTimeout(r, 800));
        busy = false;
      }
      reset();
    };
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', reset, { passive: true });
  }

  /* ───────── 7) Bottom Sheet: اسحب لتقفل ───────── */
  function installSheetDrag() {
    let m = null, ov = null, startY = 0, dy = 0, t0 = 0;
    const syncOpenClass = (() => { let q = false; return () => { if (q) return; q = true; raf(() => { q = false; ROOT.classList.toggle('sx-modal-open', !!document.querySelector('.modal-overlay.open')); }); }; })();
    new MutationObserver(syncOpenClass).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });

    document.addEventListener('touchstart', e => {
      if (window.innerWidth >= 600 || e.touches.length !== 1) return;
      const mm = e.target.closest('.modal-overlay.open .modal'); if (!mm) return;
      const o = mm.closest('.modal-overlay'); if (!o || o.dataset.mobilePresentation === 'fullpage') return;
      const top = e.touches[0].clientY - mm.getBoundingClientRect().top;
      if (!(e.target.closest('.modal-header') || top < 30)) return;
      m = mm; ov = o; startY = e.touches[0].clientY; dy = 0; t0 = Date.now();
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!m) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      m.classList.add('sx-dragging'); m.style.transform = 'translateY(' + dy + 'px)';
      ov.style.background = 'rgba(0,0,0,' + Math.max(0.05, 0.55 - dy / 600) + ')';
    }, { passive: true });
    const finish = () => {
      if (!m) return;
      const fast = dy / Math.max(1, Date.now() - t0) > 0.6;
      const mm = m, oo = ov; m = null; ov = null;
      mm.classList.remove('sx-dragging');
      if (dy > 110 || (fast && dy > 40)) {
        haptic();
        if (oo.id && typeof closeModal === 'function') closeModal(oo.id); else oo.classList.remove('open');
        setTimeout(() => { mm.style.transform = ''; oo.style.background = ''; }, 400);
      } else { mm.style.transform = ''; oo.style.background = ''; }
    };
    document.addEventListener('touchend', finish, { passive: true });
    document.addEventListener('touchcancel', finish, { passive: true });
  }

  /* ───────── 8) الكيبورد (iOS) ───────── */
  function installKeyboardAwareness() {
    const vv = window.visualViewport; if (!vv) return;
    let t = 0;
    const onResize = () => {
      clearTimeout(t); t = setTimeout(() => {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        ROOT.style.setProperty('--sx-kb', kb + 'px');
        ROOT.classList.toggle('sx-kb-open', kb > 140);
      }, 30);
    };
    vv.addEventListener('resize', onResize); vv.addEventListener('scroll', onResize);
    // اقفل الكيبورد لما المستخدم يسحب القايمة (بدل ما يفضل مغطي نص الشاشة)
    document.addEventListener('touchmove', e => {
      const a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !e.target.closest('.modal, #sxPalette .sx-p-input') && ROOT.classList.contains('sx-kb-open')) a.blur();
    }, { passive: true });
  }

  /* ───────── 9) خصائص الإدخال الذكية + صور lazy ───────── */
  function decorate(node) {
    if (node.nodeType !== 1) return;
    const inputs = node.matches && node.matches('input') ? [node] : (node.querySelectorAll ? Array.from(node.querySelectorAll('input')) : []);
    inputs.forEach(i => {
      if (i.__sxd) return; i.__sxd = true;
      const id = (i.id || '') + ' ' + (i.name || ''), ph = i.placeholder || '';
      if (i.type === 'number') { if (!i.getAttribute('inputmode')) i.setAttribute('inputmode', 'decimal'); i.setAttribute('enterkeyhint', 'next'); }
      else if (/phone|mobile|tel|هاتف|موبايل/i.test(id + ph)) { i.setAttribute('inputmode', 'tel'); i.setAttribute('autocomplete', 'off'); i.setAttribute('enterkeyhint', 'next'); }
      else if (/search|بحث/i.test(id + ph)) { i.setAttribute('enterkeyhint', 'search'); i.setAttribute('autocomplete', 'off'); i.setAttribute('autocorrect', 'off'); i.setAttribute('autocapitalize', 'off'); i.setAttribute('spellcheck', 'false'); }
      else if (i.type === 'text' && !i.getAttribute('enterkeyhint')) i.setAttribute('enterkeyhint', 'next');
    });
    const imgs = node.tagName === 'IMG' ? [node] : (node.querySelectorAll ? Array.from(node.querySelectorAll('img')) : []);
    imgs.forEach(img => { if (!img.hasAttribute('loading') && !img.closest('#sxSplash')) { img.loading = 'lazy'; img.decoding = 'async'; } });
  }
  function installInputHints() {
    decorate(document.body);
    new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(decorate); }).observe(document.body, { childList: true, subtree: true });
  }

  /* ───────── 10) لمسة اهتزاز خفيفة (iOS 17.4+ عبر switch، Android عبر vibrate) ───────── */
  let hapticLabel = null;
  function haptic() {
    try {
      if (navigator.vibrate) { navigator.vibrate(8); return; }
      if (!hapticLabel) {
        hapticLabel = document.createElement('label'); hapticLabel.setAttribute('aria-hidden', 'true');
        hapticLabel.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
        const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); hapticLabel.appendChild(i); document.body.appendChild(hapticLabel);
      }
      hapticLabel.click();
    } catch (_) {}
  }
  function installHaptics() {
    document.addEventListener('click', e => {
      if (e.target.closest('.bnav-item, .btn-primary, .sx-quick button, #sxFab, .sx-p-item, .modal-footer .btn')) haptic();
    }, { capture: true, passive: true });
  }

  /* ───────── 11) البحث الشامل (Spotlight) — منتجات + عملاء + موردين لحظياً ───────── */
  const PAL = { el: null, input: null, body: null };
  const CMDS = {
    inv: () => openInvoiceModal(), cust: () => openCustomerModal(), prod: () => openProductModal(),
    inst: () => navigate('cust-installments'), rep: () => navigate('reports'), stock: () => navigate('inventory'),
  };
  const CMD_LIST = [['inv', '🧾', 'فاتورة جديدة'], ['cust', '👤', 'عميل جديد'], ['prod', '📦', 'منتج جديد'], ['inst', '💰', 'أقساط العملاء'], ['rep', '📊', 'التقارير'], ['stock', '🏬', 'المخزون']];
  function hl(text, q) {
    const t = String(text == null ? '' : text); if (!q) return esc(t);
    const first = q.split(' ').filter(Boolean)[0]; if (!first) return esc(t);
    const i = norm(t).indexOf(first);
    if (i < 0 || norm(t).length !== t.length) return esc(t); // لو التطبيع غيّر الطول نتفادى تمييز غلط
    return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + first.length)) + '</mark>' + esc(t.slice(i + first.length));
  }
  function buildPalette() {
    if (PAL.el) return;
    const el = document.createElement('div'); el.id = 'sxPalette'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'بحث شامل');
    el.innerHTML = '<div class="sx-p-top"><input class="sx-p-input" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="ابحث عن منتج، عميل، مورد، رقم هاتف…" aria-label="بحث"/><button type="button" class="sx-p-close">إغلاق</button></div><div class="sx-p-body"></div>';
    document.body.appendChild(el);
    PAL.el = el; PAL.input = el.querySelector('.sx-p-input'); PAL.body = el.querySelector('.sx-p-body');
    el.querySelector('.sx-p-close').addEventListener('click', closePalette);
    PAL.input.addEventListener('input', debounce(() => renderPalette(PAL.input.value), 90));
    PAL.body.addEventListener('click', e => {
      const b = e.target.closest('.sx-p-item'); if (!b) return;
      const act = b.dataset.act, id = b.dataset.id;
      closePalette();
      try {
        if (act === 'customer') viewCustomerDetail(Number(id));
        else if (act === 'supplier') viewSupplier(Number(id));
        else if (act === 'product') { navigate('products'); const s = document.getElementById('productSearch'); if (s) { s.value = b.dataset.q || ''; const f = document.getElementById('productSearchField'); if (f) f.value = ''; filterProducts(); } }
        else if (act === 'run' && CMDS[id]) CMDS[id]();
      } catch (err) { console.warn(err); }
    });
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
      if (e.key === 'Escape' && el.classList.contains('open')) closePalette();
    });
  }
  function openPalette() {
    buildPalette(); PAL.el.classList.add('open'); PAL.input.value = ''; renderPalette('');
    setTimeout(() => PAL.input.focus(), 60);
    // تأكيد جاهزية البيانات (من الكاش غالباً)
    Promise.all([ API.get('/customers').then(d => { if (typeof _allCustomers !== 'undefined' && (!_allCustomers || !_allCustomers.length)) _allCustomers = d.customers || []; }).catch(() => {}),
      API.get('/suppliers').then(d => { if (!state.suppliers || !state.suppliers.length) state.suppliers = d.suppliers || []; }).catch(() => {}) ])
      .then(() => { if (PAL.el.classList.contains('open')) renderPalette(PAL.input.value); });
  }
  function closePalette() { if (PAL.el) { PAL.input.blur(); PAL.el.classList.remove('open'); } }
  window.ShroukPalette = { open: openPalette, close: closePalette };

  function renderPalette(raw) {
    const q = norm(raw); let html = '';
    const item = (act, id, ico, title, sub, meta, extra) =>
      '<button type="button" class="sx-p-item" data-act="' + act + '" data-id="' + esc(id) + '"' + (extra || '') + '><span class="sx-p-ico">' + ico + '</span><span class="sx-p-main"><div class="sx-p-title">' + title + '</div><div class="sx-p-sub">' + sub + '</div></span>' + (meta ? '<span class="sx-p-meta">' + meta + '</span>' : '') + '</button>';
    if (!q) {
      html += '<div class="sx-p-group">إجراءات سريعة</div>' + CMD_LIST.map(c => item('run', c[0], c[1], c[2], 'اضغط للتنفيذ', '')).join('');
      html += '<div class="sx-p-empty">اكتب اسم منتج أو كود أو اسم عميل أو رقم تليفون…<br><small>البحث بيتجاهل الهمزات والتشكيل ويفهم الأرقام العربية</small></div>';
    } else {
      const P = (typeof state !== 'undefined' && state.products) || [], C = (typeof _allCustomers !== 'undefined' && _allCustomers) || [], S = (typeof state !== 'undefined' && state.suppliers) || [];
      const rank = (name) => { const n = norm(name); return n.startsWith(q) ? 0 : (n.includes(q) ? 1 : 2); };
      const pick = (arr, kind, cap) => { const out = []; for (let i = 0; i < arr.length && out.length < 120; i++) if (tokensMatch(hay(arr[i], kind), q)) out.push(arr[i]); return out.sort((a, b) => rank(a.name) - rank(b.name)).slice(0, cap); };
      const ps = pick(P, 'p', 6), cs = pick(C, 'c', 6), ss = pick(S, 's', 4);
      const balOf = c => { const b = c.balance; return (b && typeof b === 'object') ? (b.balance || 0) : (b || 0); };
      if (cs.length) html += '<div class="sx-p-group">العملاء</div>' + cs.map(c => item('customer', c.id, '👤', hl(c.name, q), esc([c.phone, c.code, c.governorate].filter(Boolean).join(' • ')) || '—', fmtMoney(balOf(c)))).join('');
      if (ps.length) html += '<div class="sx-p-group">المنتجات</div>' + ps.map(p => item('product', p.id, '📦', hl(p.name, q), esc([p.sku, 'مخزون: ' + (p.total_quantity ?? 0)].filter(Boolean).join(' • ')), fmtMoney(p.sale_price), ' data-q="' + esc(p.sku || p.name) + '"')).join('');
      if (ss.length) html += '<div class="sx-p-group">الموردون</div>' + ss.map(s => item('supplier', s.id, '🏢', hl(s.name, q), esc([s.phone, s.code].filter(Boolean).join(' • ')) || '—', '')).join('');
      if (!html) html = '<div class="sx-p-empty">مفيش نتائج لـ «' + esc(raw) + '»<br><small>جرّب جزء أقصر من الاسم أو الكود</small></div>';
    }
    PAL.body.innerHTML = html;
  }
  function installPalette() {
    buildPalette();
    if (!$('#sxFab')) {
      const f = document.createElement('button'); f.id = 'sxFab'; f.type = 'button'; f.setAttribute('aria-label', 'بحث شامل');
      f.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>';
      f.addEventListener('click', openPalette); document.body.appendChild(f);
    }
    // زرار البحث في الهيدر + حقل البحث العام يفتحوا البحث الشامل بدل ما يتفرجوا بدون وظيفة واضحة
    const mob = $('#mobSearchBtn'); if (mob) mob.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); openPalette(); }, true);
    const gs = $('#globalSearch'); if (gs) gs.addEventListener('focus', () => { if (isMobileWidth()) { gs.blur(); openPalette(); } });
  }

  /* ───────── 11.5) شريط الفلاتر: البحث فوق + شرائح قابلة للسحب (نفس الـ ids، لا تغيير في المنطق) ───────── */
  function balanceHeaderButtons(root) {
    // لو عدد الأزرار الثانوية فردي، آخر واحد ياخد الصف كله (مفيش زرار يتيم نص عرض)
    (root || document).querySelectorAll('.page-header').forEach(h => {
      const box = Array.from(h.children).find(c => c.querySelector && c.querySelector(':scope > .btn') && !c.querySelector('.page-title'));
      if (!box) return;
      const btns = Array.from(box.children).filter(b => b.classList && b.classList.contains('btn') && b.offsetParent !== null);
      const sec = btns.filter(b => !b.classList.contains('btn-primary'));
      btns.forEach(b => b.classList.remove('sx-span2'));
      if (sec.length % 2 === 1) sec[sec.length - 1].classList.add('sx-span2');
    });
  }
  function restructureFilterBars(root) {
    balanceHeaderButtons(root);
    (root || document).querySelectorAll('.filters-bar:not(.sx-ready)').forEach(bar => {
      const search = bar.querySelector(':scope > .filter-search');
      const rest = Array.from(bar.children).filter(c => c !== search);
      if (!search || !rest.length) return;
      const wrap = document.createElement('div'); wrap.className = 'sx-chips';
      rest.forEach(c => wrap.appendChild(c));
      bar.appendChild(wrap); bar.classList.add('sx-ready');
    });
  }
  function installFilterBars() {
    restructureFilterBars();
    const orig = window.navigate; // بعد كل تنقل (صفحات اتبنت ديناميكياً)
    if (typeof orig === 'function' && !orig.__sxF) {
      const w = function () { const r = orig.apply(this, arguments); try { restructureFilterBars(); } catch (_) {} return r; }; w.__sxF = true; w.__sx = orig.__sx; window.navigate = w;
    }
  }
  function installFabAutoHide() {
    let last = 0, t = 0;
    document.addEventListener('scroll', e => {
      const el = e.target === document ? document.scrollingElement : e.target; if (!el || el.scrollTop === undefined) return;
      const y = el.scrollTop, d = y - last; last = y;
      if (d > 10 && y > 120) ROOT.classList.add('sx-fab-hide');
      else if (d < -6) ROOT.classList.remove('sx-fab-hide');
      clearTimeout(t); t = setTimeout(() => ROOT.classList.remove('sx-fab-hide'), 1400);
    }, { capture: true, passive: true });
  }

  /* ───────── 12) بطاقة "صباح الخير" في لوحة التحكم ───────── */
  function installDashboardHero() {
    const host = document.getElementById('page-dashboard'); if (!host) return;
    let hero = host.querySelector('.sx-hero');
    if (!hero) {
      hero = document.createElement('section'); hero.className = 'sx-hero';
      hero.innerHTML = '<h2></h2><p></p><div class="sx-quick">' +
        '<button type="button" data-a="inv"><span class="sx-qi">🧾</span>فاتورة</button>' +
        '<button type="button" data-a="search"><span class="sx-qi">🔍</span>بحث</button>' +
        '<button type="button" data-a="cust"><span class="sx-qi">👥</span>العملاء</button>' +
        '<button type="button" data-a="prod"><span class="sx-qi">📦</span>المنتجات</button></div>' +
        '<div class="sx-sky-line"></div><div class="sx-hero-sun"></div>';
      host.insertBefore(hero, host.firstChild);
      hero.addEventListener('click', e => {
        const b = e.target.closest('button[data-a]'); if (!b) return;
        ({ inv: () => openInvoiceModal(), search: openPalette, cust: () => navigate('customers'), prod: () => navigate('products') })[b.dataset.a]();
      });
    }
    const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
    const isNight = h < 5.5 || h >= 18.5, isDay = h >= 9 && h < 16;
    hero.classList.toggle('is-night', isNight); hero.classList.toggle('is-day', isDay);
    const greet = h < 5.5 ? 'سهرانة النهارده؟' : h < 12 ? 'صباح الخير' : h < 18.5 ? 'نهارك سعيد' : 'مساء الخير';
    let name = 'شروق';
    try { const u = state.user; name = (typeof normalizeUserDisplayName === 'function' ? normalizeUserDisplayName(u.full_name) : u.full_name) || 'شروق'; name = String(name).trim().split(/\s+/)[0]; } catch (_) {}
    hero.querySelector('h2').textContent = greet + ' يا ' + name + (isNight ? ' 🌙' : ' ☀️');
    let low = 0; try { low = (state.products || []).filter(p => p.is_low_stock).length; } catch (_) {}
    const date = now.toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
    hero.querySelector('p').textContent = date + (low ? ' • ' + low + ' منتج محتاج تجديد مخزون' : '');
    // الشمس في ركن البطاقة (مش فوق النص): بتعلى وتنزل حسب الوقت (شروق 6 → غروب 18)
    const sun = hero.querySelector('.sx-hero-sun'), p = Math.min(1, Math.max(0, (h - 6) / 12));
    sun.style.left = '40px'; sun.style.top = (isNight ? 30 : 70 - Math.sin(Math.PI * p) * 44) + 'px';
  }

  /* ───────── 13) رجوع التطبيق من الخلفية → تحديث هادي ───────── */
  function installVisibilityRefresh() {
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 45000) {
        swr.clear();
        try { if (typeof state !== 'undefined' && state.token && typeof window.refreshActiveRouteAfterRemoteChange === 'function') window.refreshActiveRouteAfterRemoteChange(); } catch (_) {}
      }
      hiddenAt = 0;
    });
  }

  /* ───────── تشغيل ───────── */
  wrapInit();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
