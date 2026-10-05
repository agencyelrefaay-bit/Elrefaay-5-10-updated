/* أرصدة العملاء والموردين ومجموعاتهم — واجهة متوافقة مع محرك التطبيق الحالي. */
(() => {
  const ob = { type: null, people: [], groups: [], groupOrder: [], selected: new Set(), notes: new Map(), groupRows: [], currentGroupId: null, memberSearch: '' };
  const $ = id => document.getElementById(id);
  const typeLabel = type => type === 'customers' ? 'العملاء' : 'الموردين';
  const personLabel = type => type === 'customers' ? 'عميل' : 'مورد';
  const esc = value => window.escHtml ? escHtml(value) : String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => `${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
  const current = () => ob.people.filter(person => ob.selected.has(Number(person.id)));
  const canManage = type => type === 'customers' ? ['admin','manager','sales'].includes(state.user?.role) : ['admin','manager'].includes(state.user?.role);
  window.syncPartyGroupPermissions = role => document.querySelectorAll('[data-group-management]').forEach(button => {
    const kind = button.getAttribute('data-group-management');
    button.hidden = kind === 'both' ? !(['admin','manager','sales'].includes(role) || ['admin','manager'].includes(role)) : !(kind === 'customers' ? ['admin','manager','sales'].includes(role) : ['admin','manager'].includes(role));
  });

  const styles = document.createElement('style');
  styles.textContent = `
    .ob-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s-lg);max-width:900px;margin:var(--s-xl) auto}
    .ob-choice{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:24px;text-align:right;cursor:pointer;color:var(--cream-1);transition:transform .18s,border-color .18s}
    .ob-choice:hover{transform:translateY(-2px);border-color:var(--gold-border)}.ob-choice strong{font-size:1.05rem}.ob-choice>span:last-child{color:var(--cream-4);font-size:.85rem}
    .ob-choice-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--gold-glow-sm);color:var(--gold-0);font-size:1.35rem}
    .ob-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:var(--s-md);flex-wrap:wrap}.ob-toolbar-title{font-weight:700;flex:1}.ob-columns{display:grid;grid-template-columns:minmax(300px,.86fr) minmax(0,1.2fr);gap:var(--s-md);align-items:start}
    .ob-selector,.ob-preview-shell{padding:var(--s-md);min-width:0}.ob-summary,.ob-preview-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.ob-summary{padding-bottom:12px;border-bottom:1px solid var(--border-subtle)}
    .ob-filters{display:grid;grid-template-columns:minmax(0,1fr) 150px auto;gap:8px;padding:12px 0}.ob-filters .form-control{min-width:0}.ob-people-list{display:grid;gap:7px;max-height:66vh;overflow:auto;overscroll-behavior:contain}
    .ob-person{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:10px;padding:11px;border:1px solid var(--border-subtle);border-radius:12px;cursor:pointer;transition:background .15s,border-color .15s}
    .ob-person:hover{border-color:var(--gold-border)}.ob-person.is-selected{background:var(--gold-glow-sm);border-color:var(--gold-border)}.ob-person input{width:18px;height:18px;accent-color:var(--gold-1)}.ob-person-name{font-weight:600;overflow-wrap:anywhere}.ob-person-sub{font-size:.75rem;color:var(--cream-4);margin-top:3px}.ob-person-balance{font-variant-numeric:tabular-nums;white-space:nowrap;font-size:.83rem}
    .ob-preview-actions{padding-bottom:12px;border-bottom:1px solid var(--border-subtle);margin-bottom:12px}.ob-preview-title{font-weight:700;font-size:1rem}.ob-preview{min-height:190px;max-height:70vh;overflow:auto}.ob-preview-company{display:grid;gap:4px;padding:0 8px 12px;border-bottom:1px solid var(--border-subtle);font-size:.8rem}.ob-preview-company strong{font-size:1rem}.ob-preview-company span,.ob-preview-company small{color:var(--cream-4)}.ob-preview-group{margin:12px 0 6px;padding:8px 10px;border-right:3px solid var(--gold-1);background:var(--gold-glow-sm);font-weight:700}.ob-preview-row{display:grid;grid-template-columns:minmax(0,1fr) 125px minmax(130px,.9fr);gap:10px;align-items:center;padding:9px 8px;border-bottom:1px solid var(--border-subtle)}.ob-preview-column-head{font-size:.72rem;color:var(--cream-4);font-weight:600;padding-top:2px;padding-bottom:5px}.ob-preview-subtotal{display:flex;justify-content:space-between;padding:6px 8px;font-size:.78rem;color:var(--cream-3);font-weight:600}
    .ob-note{min-height:38px;width:100%;resize:vertical}.ob-preview-total{display:flex;justify-content:space-between;padding:13px 8px;font-weight:700;border-top:2px solid var(--gold-border);margin-top:8px}
    .ob-group-order{margin:0 0 14px;padding:13px 15px;border:1px solid var(--border-subtle);border-radius:12px;background:var(--ink-3)}.ob-group-order-title{font-weight:700}.ob-group-order-hint{margin:4px 0 10px;font-size:.78rem;color:var(--cream-4);line-height:1.5}.ob-group-order ol{display:grid;gap:6px;list-style:none;margin:0;padding:0}.ob-group-order li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 9px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--ink-2)}.ob-order-actions{display:flex;gap:5px}.ob-order-actions button{width:30px;height:30px;border:1px solid var(--border-subtle);border-radius:7px;background:var(--ink-3);color:var(--cream-1);font-weight:700;cursor:pointer}.ob-order-actions button:disabled{opacity:.35;cursor:default}
    .pg-layout{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(300px,1.2fr);gap:16px}.pg-list{display:grid;align-content:start;gap:8px;max-height:60vh;overflow:auto}.pg-item{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid var(--border-subtle);border-radius:10px}.pg-item-main{flex:1;min-width:0}.pg-member-list{max-height:47vh;overflow:auto;display:grid;gap:5px;margin-top:8px}.pg-person{display:flex;align-items:center;gap:9px;padding:8px;border-radius:8px}.pg-person:hover{background:var(--ink-4)}.pg-person input{width:18px;height:18px;accent-color:var(--gold-1)}
    @media(max-width:800px){.ob-columns{grid-template-columns:1fr}.ob-people-list{max-height:44vh}.ob-preview{max-height:none}.pg-layout{grid-template-columns:1fr}.pg-list{max-height:28vh}}
    @media(max-width:599px){.ob-choice-grid{grid-template-columns:1fr;gap:10px;margin:12px 0}.ob-choice{padding:17px;display:grid;grid-template-columns:40px minmax(0,1fr);column-gap:12px}.ob-choice-icon{grid-row:span 2}.ob-filters{grid-template-columns:1fr 1fr}.ob-filters input{grid-column:1/-1}.ob-filters button{min-height:42px}.ob-person{grid-template-columns:24px minmax(0,1fr)}.ob-person-balance{grid-column:2}.ob-preview-row{grid-template-columns:minmax(0,1fr) auto}.ob-note{grid-column:1/-1}.ob-toolbar{align-items:stretch}.ob-toolbar>*{min-height:42px}.ob-toolbar-title{flex-basis:100%;order:-1}.ob-preview-actions{align-items:flex-start;flex-wrap:wrap}.ob-preview-actions button{width:100%;min-height:46px}}
    @media(prefers-reduced-motion:reduce){.ob-choice{transition:none}.ob-choice:hover{transform:none}}
    @media print{.ob-print{font-family:Arial,Tahoma,sans-serif;color:#171717;direction:rtl}.ob-print-head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #333;padding:0 0 12px;margin-bottom:14px}.ob-print-company{font-size:18px;font-weight:700}.ob-print-title{font-size:20px;font-weight:700;margin:10px 0 4px}.ob-print-meta{font-size:11px;color:#444}.ob-print-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}.ob-print-table th,.ob-print-table td{border:1px solid #aaa;padding:8px 7px;text-align:right;vertical-align:top}.ob-print-table thead{display:table-header-group}.ob-print-table th{background:#eee!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.ob-print-group td{background:#f3f0e8!important;font-weight:bold;padding:7px;-webkit-print-color-adjust:exact;print-color-adjust:exact}.ob-print-note{width:31%;min-width:55mm}.ob-print-note-cell{height:19mm}.ob-print-total{font-weight:bold;background:#f5f5f5!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.ob-print-footer{margin-top:14px;font-size:10px;color:#555;text-align:center}@page{size:A4 portrait;margin:13mm}tr{break-inside:avoid}.ob-print-group{break-after:avoid}}
  `;
  document.head.appendChild(styles);

  window.loadOutstandingBalances = function () {
    $('obChooser')?.removeAttribute('hidden');
    $('obWorkspace')?.setAttribute('hidden', '');
  };

  window.chooseOutstandingType = async function (type) {
    if (!['customers','suppliers'].includes(type)) return;
    const changedType = ob.type !== type;
    ob.type = type;
    if (changedType) { ob.selected.clear(); ob.notes.clear(); ob.groupOrder = []; }
    $('obChooser').setAttribute('hidden', ''); $('obWorkspace').removeAttribute('hidden');
    $('obTypeTitle').textContent = `أرصدة ${typeLabel(type)}`;
    $('obManageGroupsBtn').textContent = `إدارة مجموعات ${typeLabel(type)}`;
    $('obManageGroupsBtn').hidden = !canManage(type);
    $('obPeopleList').innerHTML = '<div class="empty-state"><div class="spinner" style="margin:auto"></div><div class="empty-desc">جاري تحميل الأرصدة</div></div>';
    try {
      const data = await API.get(`/party-groups/report/${type}`);
      ob.people = data.people || []; ob.groups = data.groups || [];
      const validGroupIds = new Set([...ob.groups.map(group => String(group.id)), 'none']);
      ob.groupOrder = [...ob.groupOrder.filter(id => validGroupIds.has(String(id))), ...ob.groups.map(group => String(group.id)).filter(id => !ob.groupOrder.includes(id))];
      if (!ob.groupOrder.includes('none')) ob.groupOrder.push('none');
      const validIds = new Set(ob.people.map(person => Number(person.id)));
      for (const id of ob.selected) if (!validIds.has(id)) ob.selected.delete(id);
      for (const id of ob.notes.keys()) if (!validIds.has(id)) ob.notes.delete(id);
      $('obGroupFilter').innerHTML = '<option value="">كل المجموعات</option><option value="none">بلا مجموعة</option>' + ob.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      renderOutstandingPeople(); renderOutstandingPreview();
    } catch (err) {
      $('obPeopleList').innerHTML = `<div class="empty-state"><div class="empty-title">تعذر تحميل البيانات</div><div class="empty-desc">${esc(err.message)}</div><button class="btn btn-ghost btn-sm" onclick="chooseOutstandingType('${type}')">إعادة المحاولة</button></div>`;
    }
  };

  window.backToOutstandingTypes = () => { $('obWorkspace').setAttribute('hidden', ''); $('obChooser').removeAttribute('hidden'); };

  window.renderOutstandingPeople = function () {
    if (!ob.type) return;
    const q = ($('obSearch').value || '').trim().toLocaleLowerCase();
    const groupId = $('obGroupFilter').value;
    const list = ob.people.filter(p => {
      const matches = !q || [p.name,p.code,p.phone].some(v => String(v || '').toLocaleLowerCase().includes(q));
      return matches && (!groupId || (groupId === 'none' ? !p.group_id : String(p.group_id) === groupId));
    });
    $('obPeopleList').innerHTML = list.length ? list.map(p => {
      const checked = ob.selected.has(Number(p.id));
      return `<label class="ob-person ${checked ? 'is-selected' : ''}"><input type="checkbox" ${checked ? 'checked' : ''} aria-label="اختيار ${esc(p.name)}" onchange="toggleOutstandingPerson(${Number(p.id)},this.checked)"><span><span class="ob-person-name">${esc(p.name)}</span><span class="ob-person-sub">${esc(p.code || 'بدون كود')}${p.phone ? ` · ${esc(p.phone)}` : ''}${p.group_name ? ` · ${esc(p.group_name)}` : ''}</span></span><span class="ob-person-balance" style="color:${Number(p.balance)>0?'var(--danger)':'var(--cream-4)'}">${money(p.balance)}</span></label>`;
    }).join('') : '<div class="empty-state"><div class="empty-title">لا توجد نتائج</div><div class="empty-desc">جرّب تغيير عبارة البحث أو المجموعة المحددة</div></div>';
    $('obSelectedCount').textContent = Number(ob.selected.size).toLocaleString('ar-EG');
  };

  window.toggleOutstandingPerson = (id, checked) => { checked ? ob.selected.add(Number(id)) : ob.selected.delete(Number(id)); renderOutstandingPeople(); renderOutstandingPreview(); };
  window.clearOutstandingSelection = () => { ob.selected.clear(); renderOutstandingPeople(); renderOutstandingPreview(); };
  window.selectVisibleOutstanding = () => {
    const q = ($('obSearch').value || '').trim().toLocaleLowerCase(), groupId = $('obGroupFilter').value;
    ob.people.filter(p => (!q || [p.name,p.code,p.phone].some(v => String(v || '').toLocaleLowerCase().includes(q))) && (!groupId || (groupId === 'none' ? !p.group_id : String(p.group_id) === groupId))).forEach(p => ob.selected.add(Number(p.id)));
    renderOutstandingPeople(); renderOutstandingPreview();
  };

  function renderGroupOrderControls() {
    if (!ob.groups.length) return '';
    const items = ob.groupOrder.map((id, index) => {
      const group = ob.groups.find(item => String(item.id) === id);
      const name = id === 'none' ? 'بدون مجموعة' : group?.name;
      if (!name) return '';
      return `<li><span>${esc(name)}</span><span class="ob-order-actions"><button type="button" aria-label="تقديم ${esc(name)}" title="تقديم" ${index === 0 ? 'disabled' : ''} onclick="moveOutstandingGroup('${id}',-1)">↑</button><button type="button" aria-label="تأخير ${esc(name)}" title="تأخير" ${index === ob.groupOrder.length - 1 ? 'disabled' : ''} onclick="moveOutstandingGroup('${id}',1)">↓</button></span></li>`;
    }).join('');
    return `<section class="ob-group-order"><div class="ob-group-order-title">ترتيب المجموعات في الطباعة</div><div class="ob-group-order-hint">حرّك المجموعات بالأسهم. يطبع التقرير المجموعة كاملة، ويختار مجموعة أخرى عند توفر مساحة مناسبة.</div><ol>${items}</ol></section>`;
  }

  function renderOutstandingPreview() {
    const rows = current();
    $('obPreviewMeta').textContent = rows.length ? `${rows.length.toLocaleString('ar-EG')} ${personLabel(ob.type)} · ${money(rows.reduce((sum,p) => sum + Number(p.balance || 0), 0))}` : 'اختر سجلات لبدء المعاينة';
    if (!rows.length) {
      $('obPreview').innerHTML = `${renderGroupOrderControls()}<div class="empty-state"><div class="empty-title">لم يتم اختيار سجلات</div><div class="empty-desc">حدد العملاء أو الموردين لتظهر المعاينة هنا</div></div>`;
      return;
    }
    const grouped = new Map();
    rows.forEach(p => { const key = p.group_id ? String(p.group_id) : 'none'; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(p); });
    const orderedGroups = [...grouped].sort(([a], [b]) => {
      const ia = ob.groupOrder.indexOf(a), ib = ob.groupOrder.indexOf(b);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    });
    let total = 0;
    const company = state.settings || {};
    const sections = orderedGroups.map(([groupId, people]) => {
      const name = people[0].group_name || 'بدون مجموعة';
      const subtotal = people.reduce((sum,p) => sum + Number(p.balance || 0), 0);
      total += subtotal;
      return `<div class="ob-preview-group">${esc(name)} <span style="font-weight:400;color:var(--cream-4)">· ${people.length.toLocaleString('ar-EG')}</span></div><div class="ob-preview-row ob-preview-column-head"><span>${personLabel(ob.type)} / الكود</span><span>الرصيد</span><span>ملاحظات</span></div>` + people.map(p => `<div class="ob-preview-row"><span><strong>${esc(p.name)}</strong><span class="ob-person-sub" style="display:block">${esc(p.code || '')}${p.phone ? ` · ${esc(p.phone)}` : ''}</span></span><span class="ob-person-balance">${money(p.balance)}</span><textarea class="form-control ob-note" rows="1" aria-label="ملاحظة ${esc(p.name)}" placeholder="ملاحظة أو متابعة بالقلم" oninput="setOutstandingNote(${Number(p.id)},this.value)">${esc(ob.notes.get(Number(p.id)) || '')}</textarea></div>`).join('') + `<div class="ob-preview-subtotal"><span>إجمالي ${esc(name)}</span><span>${money(subtotal)}</span></div>`;
    }).join('');
    $('obPreview').innerHTML = `${renderGroupOrderControls()}<div class="ob-preview-company"><strong>${esc(company.company_name || 'مؤسسة الرفاعي للنجف والإضاءة')}</strong><span>${[company.phone,company.address].filter(Boolean).map(esc).join(' · ')}</span><small>${esc(new Date().toLocaleDateString('ar-EG'))}</small></div>${sections}<div class="ob-preview-total"><span>${ob.type === 'customers' ? 'إجمالي مستحق من العملاء' : 'إجمالي مستحق للموردين'}</span><span>${money(total)}</span></div>`;
  }
  window.setOutstandingNote = (id, value) => ob.notes.set(Number(id), value);
  window.moveOutstandingGroup = (id, direction) => {
    const from = ob.groupOrder.indexOf(String(id)), to = from + Number(direction);
    if (from < 0 || to < 0 || to >= ob.groupOrder.length) return;
    [ob.groupOrder[from], ob.groupOrder[to]] = [ob.groupOrder[to], ob.groupOrder[from]];
    renderOutstandingPreview();
  };

  window.printOutstandingReport = function () {
    const people = current();
    if (!people.length) { toast('حدد سجلاً واحداً على الأقل قبل الطباعة', 'warning'); return; }
    const grouped = new Map();
    people.forEach(p => { const key = p.group_id ? String(p.group_id) : 'none'; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(p); });
    const total = people.reduce((sum,p) => sum + Number(p.balance || 0), 0);
    const title = ob.type === 'customers' ? 'كشف أرصدة العملاء المستحقة' : 'كشف أرصدة الموردين المستحقة';
    const date = new Date().toLocaleDateString('ar-EG', { year:'numeric', month:'long', day:'numeric' });
    const orderedGroups = [...grouped].sort(([a], [b]) => {
      const ia = ob.groupOrder.indexOf(a), ib = ob.groupOrder.indexOf(b);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    }).map(([id, members]) => ({ id, name: members[0].group_name || 'بدون مجموعة', members }));

    // Reserve 7mm for the repeated table header; 17 standard rows then fit cleanly.
    const COLUMN_HEIGHT_MM = 250;
    const ROW_HEIGHT_MM = 13.3;
    const GROUP_HEIGHT_MM = 6.5;
    const TABLE_HEADER_MM = 7;
    const GROUP_CAPACITY = Math.floor((COLUMN_HEIGHT_MM - TABLE_HEADER_MM - GROUP_HEIGHT_MM) / ROW_HEIGHT_MM);
    const groupCost = group => GROUP_HEIGHT_MM + ROW_HEIGHT_MM * group.members.length;
    const pending = orderedGroups.flatMap(group => {
      if (group.members.length <= GROUP_CAPACITY) return [group];
      const chunks = [];
      for (let i = 0; i < group.members.length; i += GROUP_CAPACITY) chunks.push({ ...group, members: group.members.slice(i, i + GROUP_CAPACITY), continuation: i > 0 });
      return chunks;
    });
    const columns = [];
    while (pending.length) {
      const column = { groups: [], used: TABLE_HEADER_MM };
      while (pending.length) {
        const fittingIndex = pending.findIndex(group => column.used + groupCost(group) <= COLUMN_HEIGHT_MM);
        if (fittingIndex < 0) break;
        const [group] = pending.splice(fittingIndex, 1);
        column.groups.push(group);
        column.used += groupCost(group);
      }
      columns.push(column);
    }
    if (columns.length % 2) columns.push({ groups: [], used: TABLE_HEADER_MM });

    let sequence = 0;
    const renderColumn = column => {
      const rows = column.groups.map(group => `<tr class="ob-print-group"><td colspan="4">${esc(group.name)}${group.continuation ? ' <span>· تابع</span>' : ''} <span>· ${group.members.length.toLocaleString('en-US')} ${personLabel(ob.type)}</span></td></tr>` + group.members.map(p => `<tr class="ob-print-person"><td class="ob-print-number">${(++sequence).toLocaleString('en-US')}</td><td class="ob-print-name">${esc(p.name)}</td><td class="ob-print-balance">${money(p.balance)}</td><td class="ob-print-note-cell">${esc(ob.notes.get(Number(p.id)) || '')}</td></tr>`).join('')).join('');
      return `<table class="ob-print-table"><colgroup><col class="number-col"><col class="name-col"><col class="balance-col"><col class="note-col"></colgroup><thead><tr><th>#</th><th>${personLabel(ob.type)}</th><th>الرصيد</th><th>ملاحظات</th></tr></thead><tbody>${rows || '<tr><td class="ob-print-empty" colspan="4"></td></tr>'}</tbody></table>`;
    };
    const pageGroups = [];
    for (let i = 0; i < columns.length; i += 2) pageGroups.push([columns[i], columns[i + 1]]);
    const pages = pageGroups.map((pair, index) => `<article class="ob-print-page"><div class="ob-print-title">${esc(title)}</div><div class="ob-print-meta">تاريخ التقرير: ${esc(date)} &nbsp;·&nbsp; عدد ${personLabel(ob.type)}: ${people.length.toLocaleString('en-US')} &nbsp;·&nbsp; الإجمالي: ${money(total)} &nbsp;·&nbsp; صفحة ${(index + 1).toLocaleString('en-US')}</div><div class="ob-print-columns"><section class="ob-print-column">${renderColumn(pair[0])}</section><section class="ob-print-column">${renderColumn(pair[1])}</section></div></article>`).join('');
    const popup = window.open('', '_blank');
    if (!popup) { toast('اسمح بفتح نافذة الطباعة للمتابعة', 'danger'); return; }
    popup.document.open();
    popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A4 portrait;margin:10mm}*{box-sizing:border-box}html,body{margin:0;color:#17211f;font-family:Arial,Tahoma,sans-serif}.ob-print-page{height:277mm;page-break-after:always;break-after:page;overflow:hidden;padding:0}.ob-print-page:last-child{page-break-after:auto;break-after:auto}.ob-print-title{font-size:17px;font-weight:800;margin:0 0 .5mm;color:#173c37}.ob-print-meta{font-size:9px;color:#47534f;line-height:1.4}.ob-print-columns{height:250mm;display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:2mm;align-items:start}.ob-print-column{min-width:0;height:250mm;padding:0 1.2mm;overflow:hidden}.ob-print-column:first-child{border-left:1.5px solid #176b62}.ob-print-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px}.ob-print-table th,.ob-print-table td{border:1px solid #aab8b4;padding:1mm .8mm;text-align:right;vertical-align:middle;overflow-wrap:anywhere}.ob-print-table th{height:7mm;background:#176b62!important;color:#fff;font-size:12px;font-weight:800;-webkit-print-color-adjust:exact;print-color-adjust:exact}.number-col{width:8%}.name-col{width:47%}.balance-col{width:27%}.note-col{width:18%}.ob-print-person{height:13.3mm;max-height:13.3mm}.ob-print-number{text-align:center!important;font-weight:700;color:#40534e;font-size:12px;font-variant-numeric:tabular-nums}.ob-print-name{font-size:15px;font-weight:700;line-height:1.2}.ob-print-balance{font-size:14px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums;direction:ltr;text-align:right}.ob-print-note-cell{height:13.3mm;max-height:13.3mm}.ob-print-group td{height:6.5mm;background:#e8f1ee!important;color:#174d45;font-size:11px;font-weight:800;padding:.5mm 1mm;border-top:1.5px solid #78a69b;-webkit-print-color-adjust:exact;print-color-adjust:exact}.ob-print-group span{font-weight:500;color:#526d66}.ob-print-empty{border:0!important}@media screen{body{background:#e9eeec}.ob-print-page{width:190mm;margin:8mm auto;background:#fff;padding:0;box-shadow:0 2px 14px #183e3522}.ob-print-column{padding:0 2mm}}</style></head><body>${pages}<script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`);
    popup.document.close();
  };

  window.openPartyGroups = async function (type = ob.type || 'customers') {
    if (!['customers','suppliers'].includes(type)) type = 'customers';
    if (!canManage(type)) { toast('ليس لديك صلاحية إدارة مجموعات هذا النوع', 'danger'); return; }
    try { const data = await API.get(`/party-groups/${type}`); ob.groupRows = data.groups || []; ob.groupPeople = data.people || []; ob.groupType = type; ob.currentGroupId = null; ob.memberSearch = ''; }
    catch (err) { toast(`تعذر تحميل المجموعات: ${esc(err.message)}`, 'danger'); return; }
    $('partyGroupsModal')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="partyGroupsModal" data-dynamic="true" onclick="if(event.target===this)closeModal('partyGroupsModal')"><div class="modal" style="max-width:960px;width:min(96vw,960px)"><div class="modal-header"><div><div class="modal-title">مجموعات ${typeLabel(type)}</div><div class="text-muted" style="font-size:.78rem">كل ${personLabel(type)} ينتمي إلى مجموعة واحدة كحد أقصى</div></div><button class="modal-close" onclick="closeModal('partyGroupsModal')" aria-label="إغلاق">✕</button></div><div class="modal-body"><div class="pg-layout"><section><div class="flex gap-sm" style="margin-bottom:10px"><input class="form-control" id="pgName" maxlength="80" placeholder="اسم المجموعة الجديدة"><button class="btn btn-primary btn-sm" onclick="savePartyGroup()">إضافة</button></div><input class="form-control" id="pgDescription" maxlength="200" placeholder="وصف اختياري" style="margin-bottom:10px"><div id="pgGroupList" class="pg-list"></div></section><section id="pgMembers"><div class="empty-state"><div class="empty-title">اختر مجموعة</div><div class="empty-desc">أنشئ مجموعة أو افتح واحدة لإدارة أعضائها</div></div></section></div></div></div></div>`);
    renderPartyGroups();
  };

  function renderPartyGroups() {
    $('pgGroupList').innerHTML = ob.groupRows.length ? ob.groupRows.map(g => `<div class="pg-item"><button type="button" class="btn btn-ghost btn-sm pg-item-main" onclick="openPartyGroupMembers(${Number(g.id)})"><strong>${esc(g.name)}</strong><span class="text-muted" style="display:block;font-size:.75rem">${Number(g.member_count || 0).toLocaleString('ar-EG')} ${personLabel(ob.groupType)}</span></button><button class="btn btn-icon btn-subtle" title="تعديل الاسم" onclick="editPartyGroup(${Number(g.id)})">✎</button><button class="btn btn-icon btn-subtle" title="حذف المجموعة" onclick="deletePartyGroup(${Number(g.id)})">×</button></div>`).join('') : '<div class="empty-state"><div class="empty-title">لا توجد مجموعات بعد</div><div class="empty-desc">أضف مجموعة لتنظيم الأرصدة حسب خط السير أو المنطقة</div></div>';
  }
  window.openPartyGroupMembers = function (id) {
    ob.currentGroupId = Number(id); const group = ob.groupRows.find(g => Number(g.id) === Number(id)); if (!group) return;
    $('pgName').value = group.name; $('pgDescription').value = group.description || '';
    renderPartyGroupPeople();
  };
  function renderPartyGroupPeople() {
    const group = ob.groupRows.find(g => Number(g.id) === Number(ob.currentGroupId)); if (!group) return;
    const q = ob.memberSearch.toLocaleLowerCase();
    const people = ob.groupPeople.filter(p => !q || [p.name,p.code,p.phone].some(v => String(v || '').toLocaleLowerCase().includes(q)));
    $('pgMembers').innerHTML = `<div style="font-weight:700">أعضاء ${esc(group.name)}</div><p class="text-muted" style="font-size:.78rem;line-height:1.5">عند الحفظ، نقل ${personLabel(ob.groupType)} من مجموعة أخرى يحدّث انتماءه تلقائياً. أزل التحديد لإبقائه بلا مجموعة.</p><div class="flex gap-sm"><input class="form-control" value="${esc(ob.memberSearch)}" placeholder="بحث عن ${personLabel(ob.groupType)}" aria-label="بحث الأعضاء" oninput="setPartyGroupSearch(this.value)"><button class="btn btn-ghost btn-xs" onclick="toggleAllPartyGroupPeople(true)">تحديد الكل</button><button class="btn btn-ghost btn-xs" onclick="toggleAllPartyGroupPeople(false)">مسح</button></div><div class="pg-member-list">${people.length ? people.map(p => `<label class="pg-person"><input type="checkbox" value="${Number(p.id)}" ${Number(p.group_id) === Number(group.id) ? 'checked' : ''} aria-label="${esc(p.name)}"><span><strong>${esc(p.name)}</strong><span class="text-muted" style="display:block;font-size:.73rem">${esc(p.code || '')}${p.group_id && Number(p.group_id) !== Number(group.id) ? ' · سينتقل من مجموعته الحالية' : ''}</span></span></label>`).join('') : '<div class="empty-state"><div class="empty-title">لا توجد نتائج</div></div>'}</div><button class="btn btn-primary" style="margin-top:12px;width:100%" onclick="savePartyGroupMembers()">حفظ الأعضاء</button>`;
  }
  window.setPartyGroupSearch = value => { ob.memberSearch = value; renderPartyGroupPeople(); const input = $('pgMembers').querySelector('input[type=search],input[placeholder^="بحث عن"]'); if (input) { input.focus(); input.setSelectionRange(value.length,value.length); } };
  window.toggleAllPartyGroupPeople = checked => $('pgMembers').querySelectorAll('.pg-person input').forEach(input => { input.checked = checked; });
  window.savePartyGroup = async function () {
    const name = $('pgName').value.trim(); if (!name) { toast('اكتب اسم المجموعة أولاً', 'warning'); $('pgName').focus(); return; }
    try {
      if (ob.currentGroupId) await API.put(`/party-groups/${ob.groupType}/${ob.currentGroupId}`, { name, description: $('pgDescription').value });
      else await API.post(`/party-groups/${ob.groupType}`, { name, description: $('pgDescription').value });
      toast(ob.currentGroupId ? 'تم تحديث المجموعة' : 'تم إنشاء المجموعة');
      const result = await API.get(`/party-groups/${ob.groupType}`); ob.groupRows = result.groups || []; ob.groupPeople = result.people || [];
      ob.currentGroupId = null; $('pgName').value = ''; $('pgDescription').value = ''; renderPartyGroups();
      if (ob.type === ob.groupType) chooseOutstandingType(ob.type);
    } catch (err) { toast(esc(err.message), 'danger'); }
  };
  window.savePartyGroupMembers = async function () {
    if (!ob.currentGroupId) return;
    const ids = [...$('pgMembers').querySelectorAll('.pg-person input:checked')].map(input => Number(input.value));
    try {
      await API.put(`/party-groups/${ob.groupType}/${ob.currentGroupId}/members`, { person_ids: ids });
      toast('تم حفظ أعضاء المجموعة');
      const result = await API.get(`/party-groups/${ob.groupType}`); ob.groupRows = result.groups || []; ob.groupPeople = result.people || [];
      renderPartyGroups(); openPartyGroupMembers(ob.currentGroupId);
      if (ob.type === ob.groupType) chooseOutstandingType(ob.type);
    } catch (err) { toast(esc(err.message), 'danger'); }
  };
  window.editPartyGroup = id => openPartyGroupMembers(id);
  window.deletePartyGroup = async function (id) {
    if (!confirm('حذف هذه المجموعة؟ يجب إزالة أعضائها أو نقلهم أولاً.')) return;
    try { await API.delete(`/party-groups/${ob.groupType}/${id}`); ob.groupRows = ob.groupRows.filter(g => Number(g.id) !== Number(id)); ob.currentGroupId = null; renderPartyGroups(); $('pgMembers').innerHTML = '<div class="empty-state"><div class="empty-title">اختر مجموعة</div></div>'; toast('تم حذف المجموعة'); if (ob.type === ob.groupType) chooseOutstandingType(ob.type); }
    catch (err) { toast(esc(err.message), 'danger'); }
  };

  window.addEventListener('beforeprint', () => {});
  if (state.user?.role) window.syncPartyGroupPermissions(state.user.role);
})();
