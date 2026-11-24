/* The catalog's categories, in the admin: folders and subfolders (as many levels as needed), and the products in each.
   The Categories page makes and arranges the folders; each product's page has the tree with a checkbox for each folder,
   to put the product in it (a product can be in several). Everything is saved as you go, as a draft like the rest of the
   catalog (one catalog setting, 'categories'), and customers see it once it's published. The door configurator's menu is
   built from it: a folder's subfolders, then the products in it. */
(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = () => 'c' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);
  // Keystone's website categories, to start from (only offered while there are none)
  const STARTER = [['Quick & Easy'], ['Door & Drawer Fronts', [['Standard', [['Standard 1 Panel'], ['Standard Multi-Panel']]], ['Glass Ready / Mullions'],
    ['Mitred', [['Mitre 1 Panel'], ['Mitred Multi-Panel']]], ['Haunched', [['Haunched Lazy Susan Door'], ['Haunched Multi-Panel']]], ['Narrow Frame'], ['One Piece MDF'],
    ['Custom Split Doors'], ['End Panel / Wainscot'], ['Solid'], ['Specialties', [['Mullion'], ['Quarter Circle'], ['Louver', [['True Open Louver']]]]]]],
    ['Drawer Boxes'], ['Face Frames', [['1 Opening'], ['2 Openings'], ['3 Openings'], ['4 Openings'], ['All Face Frames']]], ['Mouldings'], ['Space Saving Solutions'],
    ['Shelves'], ['Accessories'], ['Lumber'], ['Plywood', [['Cut-To-Size', [['Premium Face & Back']]]]]];
  const build = list => list.map(([name, kids]) => ({ id: newId(), name, children: build(kids || []) }));
  // the configurators a folder can show in (its show list; a subfolder without one follows the folder it's in)
  const SHOW = [['door', 'Door configurator', 'Doors'], ['drawer_front', 'Drawer front configurator', 'Drawer fronts'], ['drawer_box', 'Drawer box configurator', 'Drawer boxes'], ['planner', 'Kitchen planners', 'Planners']];
  const anyShow = ns => ns.some(n => Array.isArray(n.show) || anyShow(n.children));

  // ---------------- the folders as a tree: find one, the ids under one, every folder in order
  function locate(nodes, id, parent = null) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return { node: nodes[i], list: nodes, index: i, parent };
      const r = locate(nodes[i].children, id, nodes[i]); if (r) return r;
    }
    return null;
  }
  const under = n => [n.id, ...n.children.flatMap(under)];
  const pathOf = (nodes, id, trail = []) => { for (const n of nodes) { if (n.id === id) return [...trail, n.name]; const p = pathOf(n.children, id, [...trail, n.name]); if (p) return p; } return null; };

  // ---------------- one shared copy, loaded per page; saved a moment after each change (one save at a time), as a draft
  function store(api, changed) {
    let data = null, timer = 0, busy = false, again = false;
    const S = {
      async load() { const r = await api('GET', '/api/admin/categories'); if (!r.ok) throw new Error(r.error || 'Couldn’t load the categories.');
        data = { tree: r.categories.tree || [], products: r.categories.products || {}, draft: !!r.draft }; return data; },
      get data() { return data; },
      save(done = () => {}) {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (busy) { again = true; return; } busy = true;
          try { const r = await api('PUT', '/api/admin/catalog-controls/categories', { tree: data.tree, products: data.products }); if (r.ok) { data.draft = true; changed(); } done(r); }
          finally { busy = false; if (again) { again = false; S.save(done); } }
        }, 350);
      },
      async discard() { const r = await api('DELETE', '/api/admin/catalog-controls/categories'); if (r.ok) changed(); return r; },
    };
    return S;
  }
  const countIn = (data, id) => Object.values(data.products).filter(cs => cs.includes(id)).length;
  const STYLE = `<style>
    .kc-tree, .kc-tree ul { list-style: none; margin: 0; padding: 0; }
    .kc-tree ul { margin-left: 22px; border-left: 1px solid var(--line); padding-left: 8px; }
    .kc-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 6px; min-height: 30px; }
    .kc-row:hover { background: var(--field); }
    .kc-tog { width: 20px; height: 20px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); color: inherit; font: 600 12px/1 system-ui; cursor: pointer; padding: 0; flex: none; }
    .kc-tog.none { visibility: hidden; }
    .kc-name { cursor: text; padding: 2px 4px; border-radius: 4px; } .kc-name:hover { outline: 1px dashed var(--line); }
    .kc-row input[type=text] { font: inherit; padding: 2px 6px; border: 1px solid var(--line); border-radius: 6px; min-width: 220px; }
    .kc-tools { margin-left: auto; display: flex; gap: 4px; opacity: .35; } .kc-row:hover .kc-tools, .kc-row:focus-within .kc-tools { opacity: 1; }
    .kc-tools button { font: inherit; font-size: 12px; padding: 2px 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: inherit; cursor: pointer; }
    .kc-tools button.del { color: #9A3B1E; }
    .kc-count { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; background: var(--field); border: 1px solid var(--line); color: var(--muted, #667); }
    .kc-check { display: flex; align-items: center; gap: 6px; cursor: pointer; } .kc-check input { margin: 0; }
    .kc-show { font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid #94A596; background: #EDF1ED; color: #4E6153; cursor: pointer; }
    .kc-show.inh { background: transparent; border-style: dashed; } .kc-show i { opacity: .7; }
    .kc-showedit { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 4px 0 8px 30px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--field); }
  </style>`;
  const draftNote = (data, label) => data.draft
    ? `<div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;padding:8px 10px;border:1px solid #E0A33A;border-radius:8px;background:rgb(224 163 58/.08);margin:8px 0"><span class="pill warn">Draft</span><span class="small">${label} aren’t published yet: customers see the published categories until you publish (Publish, top right).</span><button class="btn small ghost" data-kc-discard>Discard draft</button></div>`
    : '<p class="small muted" style="margin:8px 0">Published: this is what customers see.</p>';

  // ---------------- the Categories page: make and arrange the folders
  async function mount(view, api, changed = () => {}) {
    const S = store(api, changed);
    view.innerHTML = '<p class="muted">Loading…</p>';
    try { await S.load(); } catch (e) { view.innerHTML = `<div class="card pad"><h2>Categories</h2><p class="err">${esc(e.message)}</p></div>`; return; }
    const closed = new Set(); let editing = null, showing = null;
    // a folder: its name, products, where it shows (its own, or as the folder it's in), and its tools
    const row = (n, inh = [], parent = null) => { const eff = Array.isArray(n.show) ? n.show : parent ? inh : [], label = eff.length ? SHOW.filter(([k]) => eff.includes(k)).map(x => x[2]).join(', ') : 'Not shown';
      return `<li><div class="kc-row" data-id="${esc(n.id)}">
        <button class="kc-tog${n.children.length ? '' : ' none'}" data-kc-tog title="${closed.has(n.id) ? 'Open' : 'Close'}">${closed.has(n.id) ? '+' : '−'}</button>
        ${editing === n.id ? `<input type="text" data-kc-name value="${esc(n.name)}" aria-label="Folder name">` : `<span class="kc-name" data-kc-rename title="Click to rename">${esc(n.name)}</span>`}
        <span class="kc-count" title="Products in this folder">${countIn(S.data, n.id)}</span>
        <button class="kc-show${Array.isArray(n.show) ? '' : ' inh'}" data-kc-show title="Where it shows${Array.isArray(n.show) || !parent ? '' : ` (as ${esc(parent.name)})`}">${esc(label)}${Array.isArray(n.show) || !parent ? '' : ' <i>as above</i>'}</button>
        <span class="kc-tools"><button data-kc-add title="Add a subfolder">+ Subfolder</button><button data-kc-up title="Move up">↑</button><button data-kc-down title="Move down">↓</button>
          <button data-kc-out title="Move out a level">←</button><button data-kc-in title="Move into the folder above">→</button><button class="del" data-kc-del title="Delete it">Delete</button></span></div>
        ${showing === n.id ? `<div class="kc-showedit" data-id="${esc(n.id)}"><b class="small">Shown in</b>
          ${parent ? `<label class="kc-check"><input type="checkbox" data-kc-inherit${Array.isArray(n.show) ? '' : ' checked'}>Same as “${esc(parent.name)}”</label>` : ''}
          ${SHOW.map(([k, l]) => `<label class="kc-check"><input type="checkbox" data-kc-showk="${k}"${eff.includes(k) ? ' checked' : ''}${parent && !Array.isArray(n.show) ? ' disabled' : ''}>${esc(l)}</label>`).join('')}
          <button class="btn small ghost" data-kc-showdone>Done</button></div>` : ''}
        ${n.children.length && !closed.has(n.id) ? `<ul>${n.children.map(c => row(c, eff, n)).join('')}</ul>` : ''}</li>`; };
    const draw = () => {
      const d = S.data, folders = (function c(ns) { return ns.reduce((k, n) => k + 1 + c(n.children), 0); })(d.tree);
      view.innerHTML = STYLE + `<div class="card pad"><h2>Categories</h2>
        <p class="small muted" style="max-width:820px">Folders and subfolders for the catalog: how products are grouped for customers. The door configurator starts from them (the <b>Door &amp; Drawer Fronts</b> folder’s subfolders are its families, then the doors in each). Put a product in a folder by ticking it in the <b>Categories</b> box on the product’s page; a product can be in several. Click a folder’s name to rename it. Changes save themselves as drafts.</p>
        ${draftNote(d, 'These categories')}
        <div class="row" style="gap:8px;flex-wrap:wrap;margin:6px 0 10px"><button class="btn" data-kc-addtop>Add a folder</button>
          ${d.tree.length ? `<button class="btn small ghost" data-kc-all="open">Open all</button><button class="btn small ghost" data-kc-all="close">Close all</button><span class="small muted" style="align-self:center">${folders} folder${folders === 1 ? '' : 's'} · ${Object.keys(d.products).length} product${Object.keys(d.products).length === 1 ? '' : 's'} placed</span>`
            : '<button class="btn small" data-kc-starter>Start with Keystone’s website categories</button>'}</div>
        ${d.tree.length && !anyShow(d.tree) ? '<p class="small" style="margin:0 0 8px;padding:8px 10px;border-radius:8px;background:var(--field);border:1px solid var(--line)">Choose where each folder shows with its <b>Not shown</b> button (the door configurator, the drawer front one, the drawer box one, the kitchen planners). Until a folder says, the door configurator uses the <b>Door &amp; Drawer Fronts</b> folder.</p>' : ''}
        ${d.tree.length ? `<ul class="kc-tree">${d.tree.map(n => row(n)).join('')}</ul>` : '<p class="small muted">No folders yet.</p>'}</div>`;
      const inp = view.querySelector('[data-kc-name]');
      if (inp) { inp.focus(); inp.select();
        const done = keep => { const r = locate(S.data.tree, editing); const v = inp.value.replace(/\s+/g, ' ').trim().slice(0, 80); editing = null;
          if (keep && r && v && v !== r.node.name) { r.node.name = v; S.save(saved); } draw(); };
        inp.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
        inp.onblur = () => editing && done(true); }
    };
    const saved = r => { if (!r.ok) { alert(r.error || 'Couldn’t save the categories.'); S.load().then(draw); } else draw(); };
    view.onchange = e => {
      const box = e.target.closest('.kc-showedit'); if (!box) return; const at = locate(S.data.tree, box.dataset.id); if (!at) return;
      if (e.target.matches('[data-kc-inherit]')) { if (e.target.checked) delete at.node.show; else at.node.show = [...box.querySelectorAll('[data-kc-showk]:checked')].map(c => c.dataset.kcShowk); }
      else if (e.target.matches('[data-kc-showk]')) at.node.show = [...box.querySelectorAll('[data-kc-showk]:checked')].map(c => c.dataset.kcShowk);
      S.save(saved); draw();
    };
    view.onclick = async e => {
      if (e.target.closest('[data-kc-showdone]')) { showing = null; draw(); return; }
      const t = e.target, rowEl = t.closest('.kc-row'), id = rowEl && rowEl.dataset.id, at = id && locate(S.data.tree, id), d = S.data;
      if (t.closest('[data-kc-discard]')) { if (!confirm('Discard the unpublished category changes? They go back to what’s published.')) return; await S.discard(); await S.load(); draw(); return; }
      if (t.closest('[data-kc-starter]')) { d.tree = build(STARTER); S.save(saved); draw(); return; }
      if (t.closest('[data-kc-addtop]')) { const n = { id: newId(), name: 'New folder', children: [] }; d.tree.push(n); editing = n.id; S.save(saved); draw(); return; }
      const all = t.closest('[data-kc-all]'); if (all) { closed.clear(); if (all.dataset.kcAll === 'close') (function c(ns) { for (const n of ns) if (n.children.length) { closed.add(n.id); c(n.children); } })(d.tree); draw(); return; }
      if (!at) return;
      if (t.closest('[data-kc-tog]')) { closed.has(id) ? closed.delete(id) : closed.add(id); draw(); return; }
      if (t.closest('[data-kc-show]')) { showing = showing === id ? null : id; draw(); return; }
      if (t.closest('[data-kc-rename]')) { editing = id; draw(); return; }
      if (t.closest('[data-kc-add]')) { const n = { id: newId(), name: 'New folder', children: [] }; at.node.children.push(n); closed.delete(id); editing = n.id; S.save(saved); draw(); return; }
      if (t.closest('[data-kc-up]') && at.index > 0) { at.list.splice(at.index - 1, 0, ...at.list.splice(at.index, 1)); S.save(saved); draw(); return; }
      if (t.closest('[data-kc-down]') && at.index < at.list.length - 1) { at.list.splice(at.index + 1, 0, ...at.list.splice(at.index, 1)); S.save(saved); draw(); return; }
      if (t.closest('[data-kc-out]') && at.parent) { const up = locate(d.tree, at.parent.id); at.list.splice(at.index, 1); up.list.splice(up.index + 1, 0, at.node); S.save(saved); draw(); return; }
      if (t.closest('[data-kc-in]') && at.index > 0) { const into = at.list[at.index - 1]; at.list.splice(at.index, 1); into.children.push(at.node); closed.delete(into.id); S.save(saved); draw(); return; }
      if (t.closest('[data-kc-del]')) {
        const ids = new Set(under(at.node)), n = Object.values(d.products).filter(cs => cs.some(c => ids.has(c))).length, subs = ids.size - 1;
        if (!confirm(`Delete “${at.node.name}”${subs ? ` and its ${subs} subfolder${subs === 1 ? '' : 's'}` : ''}?${n ? ` ${n} product${n === 1 ? ' is' : 's are'} in ${subs ? 'them' : 'it'}; ${n === 1 ? 'it stays in any other folders it’s in' : 'they stay in any other folders they’re in'}.` : ''} A draft until published.`)) return;
        at.list.splice(at.index, 1);
        for (const [pid, cs] of Object.entries(d.products)) { const left = cs.filter(c => !ids.has(c)); if (left.length) d.products[pid] = left; else delete d.products[pid]; }
        S.save(saved); draw(); return;
      }
    };
    draw();
  }

  // ---------------- a product's page: the tree with a checkbox for each folder, to put the product in it
  async function card(host, api, productId, changed = () => {}) {
    if (!host) return;
    const S = store(api, changed); let open = false;
    try { await S.load(); } catch (e) { host.innerHTML = `<p class="small err">${esc(e.message)}</p>`; return; }
    const closed = new Set();
    const branch = ns => `<ul>${ns.map(n => { const mine = (S.data.products[productId] || []).includes(n.id);
      return `<li><div class="kc-row" data-id="${esc(n.id)}"><button class="kc-tog${n.children.length ? '' : ' none'}" data-kc-tog>${closed.has(n.id) ? '+' : '−'}</button>
        <label class="kc-check"><input type="checkbox" data-kc-put="${esc(n.id)}"${mine ? ' checked' : ''}>${esc(n.name)}</label></div>${n.children.length && !closed.has(n.id) ? branch(n.children) : ''}</li>`; }).join('')}</ul>`;
    const draw = () => {
      const mine = S.data.products[productId] || [], paths = mine.map(c => pathOf(S.data.tree, c)).filter(Boolean).map(p => p.join(' › '));
      host.innerHTML = STYLE + `<div class="card pad" style="margin:10px 0"><div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
          <h3 style="margin:0">Categories</h3><span class="small ${paths.length ? '' : 'muted'}" style="flex:1 1 300px">${paths.length ? paths.map(esc).join(' · ') : 'Not in any folder yet.'}</span>
          <button class="btn small" data-kc-open aria-expanded="${open}">${open ? 'Done' : 'Change'}</button><a class="btn small ghost" href="#/categories">Edit categories</a></div>
        ${open ? (S.data.tree.length ? `<div style="margin-top:8px">${draftNote(S.data, 'Category changes')}</div><div class="kc-tree" style="max-height:440px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px">${branch(S.data.tree).replace(/^<ul>/, '<ul class="kc-tree" style="margin:0;border:0;padding:0">')}</div>`
          : '<p class="small muted">There are no folders yet. Make them on the <a href="#/categories">Categories</a> page.</p>') : ''}</div>`;
    };
    host.onclick = async e => {
      const t = e.target;
      if (t.closest('[data-kc-open]')) { open = !open; draw(); return; }
      if (t.closest('[data-kc-discard]')) { if (!confirm('Discard the unpublished category changes (for every product)? They go back to what’s published.')) return; await S.discard(); await S.load(); draw(); return; }
      const tog = t.closest('[data-kc-tog]'); if (tog) { const id = tog.closest('.kc-row').dataset.id; closed.has(id) ? closed.delete(id) : closed.add(id); draw(); }
    };
    host.onchange = e => {
      const c = e.target.closest('[data-kc-put]'); if (!c) return;
      const cur = new Set(S.data.products[productId] || []); if (c.checked) cur.add(c.dataset.kcPut); else cur.delete(c.dataset.kcPut);
      if (cur.size) S.data.products[productId] = [...cur]; else delete S.data.products[productId];
      S.save(r => { if (!r.ok) { alert(r.error || 'Couldn’t save.'); S.load().then(draw); } else draw(); }); draw();
    };
    draw();
  }

  window.KeystoneCategories = { mount, card, STARTER, SHOW, cleanTree: build };
})();
