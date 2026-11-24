/* sql-doors.js — the door picker on the SQL catalog, shared by the door configurator page and the kitchen planner so
   the two always offer the same doors, options, standard selections, rules and attributes.

     // Optional: overlap the list with other startup work, then pass listReady to create().
     const listReady = SqlDoors.loadList({ staff, forPlanner, configurator: 'door' });
     const picker = SqlDoors.create({ panel, staff, forPlanner, wanted, lib, onChange, listReady });
       panel       element for the controls
       staff       true: the admin's view (drafts included, doors not yet Live), for staff only
       forPlanner  true: the planner's list (doors linked to the planner or the door configurator)
       wanted      a product id to open first, or a saved selection { product, sel, attrs, inputs } to load
       lib         the drawing library { FRAMES, EDGES, PANELS, SPECIES, FINISHES } (door-kit's tables)
       listReady   optional one-shot loadList() promise for these same staff/configurator settings
       onLoading({ phase, product, name } | null)  catalog/product/price feedback, separate from completed selection changes
       onChange(state)  after every change: { product, view, sel, attrs, inputs, dims, qty, price, job, approx }
     picker.state()   picker.load(saved)   picker.dims(w, h)

   job is a DoorEngine job spec: the look from the chosen options (profiles and swatches matched by name in
   sql-looks.js), the frame widths and the panel layout from the door's own cut list. */
const SqlDoors = (() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (m, u, b) => { try { const r = await fetch(u, { method: m, credentials: 'same-origin', headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return await r.json(); } catch { return { ok: false, error: 'Couldn’t reach Keystone. Check your connection and try again.' }; } };
  const toIn = v => { const t = String(v ?? '').trim().replace(/["″]/g, ''); if (/^\d+(\.\d+)?$/.test(t)) return Number(t); const m = /^(\d+)?[\s-]*(?:(\d+)\/(\d+))?$/.exec(t); return m && (m[1] || m[2]) ? (+m[1] || 0) + (m[2] ? +m[2] / +m[3] : 0) : null; };
  // sizes as decimals to the nearest 1/32"
  const frac = v => { const n = Number(v); if (!Number.isFinite(n)) return String(v ?? ''); return `${(Math.round(n * 32) / 32).toFixed(5).replace(/\.?0+$/, '')}"`; };
  const fracOld = v => { const n = Number(v); if (!Number.isFinite(n)) return String(v ?? ''); const w = Math.floor(n + 1e-9), s = Math.round((n - w) * 16); if (!s) return `${w}"`; if (s === 16) return `${w + 1}"`; let a = s, b = 16; while (a % 2 === 0) { a /= 2; b /= 2; } return `${w ? w + ' ' : ''}${a}/${b}"`; };
  const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
  const items = view => (view ? view.sections.flatMap(s => s.items) : []);

  // the DoorEngine job for a configuration: the look from the options, the frame and panel layout from the cut list
  // a multi-panel layout's openings for the drawing: its panels (opening.top_panel, opening.bottom_left_panel …) grouped
  // into rows by their names, each row as tall as its panels are long, plus Frame Only / Multi-Lite rows from the name
  const VORD = ['top', 'upper', 'top_center', 'center', 'middle', 'bottom_center', 'lower', 'bottom'], HORD = ['left', 'left_center', 'center', 'middle', 'right_center', 'right'];
  function layoutRows(parts, name, sizes = {}, H = 0) {
    const P = (parts || []).filter(p => p.path && p.path.includes('.') && /panel$/.test(p.alias));
    if (!P.length && !/frame only|multi.?lite/i.test(name || '')) return null;
    const across = P.some(p => /(^|_)(left|right)(_|$)/.test(p.alias)), rows = new Map();
    for (const p of P) {
      const base = p.alias.replace(/_?panel$/, ''), mv = base.match(/^(top_center|bottom_center|top|bottom|upper|lower)(?:_|$)/);
      const vk = mv ? mv[1] : across ? '' : (base || 'center'), hk = across ? (mv ? base.slice(mv[0].length) : base) || 'center' : '';
      if (!rows.has(vk)) { rows.set(vk, []); rows.get(vk).vk = vk; } rows.get(vk).push({ hk, len: Number(p.length) || 0, wid: Number(p.width) || 0, qty: Number(p.qty) || 1 });
    }
    const out = [...rows].sort((a, b) => VORD.indexOf(a[0]) - VORD.indexOf(b[0])).map(([, cells]) => { const cs = cells.slice().sort((a, b) => HORD.indexOf(a.hk) - HORD.indexOf(b.hk)), n = cs.reduce((n, c) => n + (across ? 1 : c.qty), 0);
      return { fill: 'panel', n, key: cells.vk, vk: cells.vk, weight: Math.max(1, ...cs.map(c => c.len)), ...(across && cs.every(c => c.wid > 0) ? { cols: cs.map(c => c.wid) } : {}) }; });
    // the panels' lengths aren't known (the price couldn't be worked out yet, say a choice is missing): the opening heights
    // the customer typed (top_panel_length …) size their rows, and the rest of the door is shared by the others
    if (out.length > 1 && out.every(r => r.weight === 1)) {
      const want = r => { for (const nm of [`${r.vk}_panel_length`, `${r.vk}_opening_height`, `${r.vk}_length`]) { const v = Number(sizes[nm]); if (v > 0) return v; } return null; };
      const set = out.map(want), given = set.filter(v => v != null), sum = given.reduce((a, b) => a + b, 0);
      if (given.length) { const avail = Math.max(sum + 1, (Number(H) || 30.25) - 2.25 * (out.length + 1)), restN = set.length - given.length, rest = restN ? Math.max(1, (avail - sum) / restN) : 0;
        out.forEach((r, i) => { r.weight = set[i] ?? rest; }); }
    }
    out.forEach(r => delete r.vk);
    const n = name || '';
    if (/frame only( -)? top|multi.?lite top|multi.?lite with (a )?panel/i.test(n)) out.unshift({ fill: /multi.?lite/i.test(n) ? 'lite' : 'frame', weight: out.length ? out[0].weight : 1 });
    if (/frame only( -)? bottom/i.test(n)) out.push({ fill: 'frame', weight: out.length ? out[out.length - 1].weight : 1 });
    if (!out.length) out.push({ fill: /multi.?lite/i.test(n) ? 'lite' : 'frame' });
    return out;
  }
  // Explicit clear-opening sizes win over schematic proportions and cut-list allowances.
  function measuredRows(rows, sizes = {}, calculated = {}) {
    const names = rows.length === 1 ? ['center'] : rows.length === 2 ? ['top','bottom'] : rows.length === 3 ? ['top','center','bottom'] : rows.length === 4 ? ['top','upper','lower','bottom'] : ['top','top_center','center','bottom_center','bottom'];
    const value = (keys, values=sizes) => keys.map(k=>toIn(values[k])).find(v=>v>0);
    return rows.map((r,i)=>{
      const key=r.key || names[i], heights=[`${key}_panel_length`,`${key}_opening_height`,`${key}_length`], h=value(heights), derived=value(heights,calculated);
      const n=r.n||1, columns=n===1?['center']:n===2?['left','right']:n===3?['left','center','right']:n===4?['left','left_center','right_center','right']:['left','left_center','center','right_center','right'];
      const fixedCols=Array.from({length:n},(_,j)=>value([`${key}_${columns[j]}_panel_width`,`${columns[j]}_panel_width`,`${key}_${columns[j]}_opening_width`,`${columns[j]}_opening_width`]) || null);
      const cols=columns.map(c=>value([`${key}_${c}_panel_width`,`${c}_panel_width`,`${key}_${c}_opening_width`,`${c}_opening_width`],calculated));
      return {...r,...(derived?{weight:derived}:{}),...(h?{fixH:h}:{}),...(cols.length===n&&cols.every(v=>v>0)?{cols}:{}),...(fixedCols.some(Boolean)?{fixedCols}: {})};
    });
  }
  // which ML mullion style a door or layout is drawn with
  function mullionOf(name) {
    const n = String(name || '');
    if (/half\s*top/i.test(n) && /gothic/i.test(n)) { const k = n.match(/(\d+)\s*-?\s*lite/i); const lt = k ? Number(k[1]) - 2 : 0; return { style: 'halfTop', lites: lt >= 2 ? Math.min(20, lt - (lt % 2)) : null }; }
    if (/gothic\s*7|7\s*-?\s*lite gothic|ml-gothic 7/i.test(n)) return { style: 'gothic7' };
    if (/hourglass/i.test(n)) return { style: 'hourglass' };
    if (/gothic/i.test(n)) return { style: 'gothic' };
    return null;
  }
  // a wood's stock and finished thickness, from its name as the catalog writes it: "5/4 Maple, Hard" (5/4 stock, 1"),
  // "6/4 Cherry" (1 1/4"), a plain "Maple, Hard" (4/4, 3/4"); sheet goods carry their own ('1" Raw MDF')
  const STOCK_IN = { '3/4': 0.75, '4/4': 0.75, '5/4': 1, '6/4': 1.25, '8/4': 1.75, '10/4': 2.25, '12/4': 2.75 };
  // the product thickness guide (Keystone's shop chart): the stock a finished thickness is made from, none over 1.750" (8/4
  // is only for solid stock); the server prices by the same rule (server/configurators.mjs)
  const FINISH_THICK = /^finish_?thickness$/i, SAND = 0.06;
  // drawer box heights: 1/2" steps (the catalog's std_height_increment) from 1 1/2" (its Minimum Height) to 10" (Maximum)
  const BOX_H = { min: 1.5, max: 10, step: 0.5 };
  const stockForFinish = (t,bands=[{key:'4/4',max:.78},{key:'5/4',max:1},{key:'6/4',max:1.25},{key:'8/4',max:1.75}]) => {
    const v=Number(t);return v>0&&Number.isFinite(v)?bands.find(b=>v<=b.max+1e-9)?.key||null:null;
  };
  function stockOf(name) {
    const n = String(name || ''), q = n.match(/^\s*(\d+\/4)\s+(.*)$/), inch = n.match(/^\s*((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)"\s*(.*)$/);
    if (q) return { key: q[1] === '3/4' ? '4/4' : q[1], inches: STOCK_IN[q[1]] ?? null, species: q[2].trim() };
    if (inch) { const v = inch[1].split(/\s+/).reduce((t, p) => t + (p.includes('/') ? Number(p.split('/')[0]) / Number(p.split('/')[1]) : Number(p)), 0); return { key: `${inch[1]}"`, inches: v, species: inch[2].trim(), sheet: true }; }
    return { key: '4/4', inches: 0.75, species: n.trim() };
  }
  function woodFits(option, thickness, bands) {
    const need = stockForFinish(thickness, bands), st = option.material || stockOf(option.name);
    if (!need) return false;
    return st.sheet ? need !== '8/4' && thickness <= st.inches + 1e-9 : st.key === need;
  }
  function jobFor(view, sel, parts, lib, layoutName = '', sizes = {}, H = 0, widths = null, attrs = null, inputValues = {}, layouts = {}, quantity = 1) {
    const grainDefault = view.product.grain_default || (/drawer front/i.test(view.product.product_type||'')?'horizontal':'vertical');
    const grain = attrs?.panel_grain && attrs.panel_grain !== 'default' ? attrs.panel_grain : grainDefault;
    if (grain !== grainDefault) parts = (parts||[]).map(p=>/(?:panel|slab)$/i.test(p.alias)?{...p,width:p.length,length:p.width}:p);
    const J = {panelGrain:grain}, approx = [], unmatched = [], its = items(view);
    const countParts = (parts || []).map(p=>({...p,qty:p.qty==null?p.qty:Number(p.qty)/Math.max(1,Number(quantity)||1)}));
    const opt = key => { const it = its.find(i => i.kind === 'option' && i.key === key); if (!it) return null; const id = sel[key] ?? it.standard; return it.options.find(o => o.id === id) || null; };
    const pictures = [];
    const look = (key, o) => {
      let l = o && lib && typeof SqlLooks !== 'undefined' ? SqlLooks.lookOf(key, o, lib) : null; if (!l) return l;
      const acc = SqlLooks.accuracyOf(l); if (acc === 'approx') approx.push(o.name); else if (acc === 'none') unmatched.push(o.name);   // shown to customers as a note
      if (l.image) pictures.push({ kind: key, name: o.name, image: l.image });
      // an outline read from a DXF joins the drawing library under its own name, so the engine draws with it
      if (l.texture && lib.SPECIES) { const id = SqlLooks.addSpecies(lib.SPECIES, SqlLooks.textureSpecies(o.id, o.name, l.texture, lib.SPECIES)); l = { ...l, id }; }   // a wood's library texture
      if (l.finish && lib.FINISHES) { const id = SqlLooks.addFinish(lib.FINISHES, SqlLooks.finishEntry(SqlLooks.finishId(o.id, l.finish), o.name, l.finish)); l = { ...l, id }; }   // a finish colored in the admin
      if (l.profile) { const tab = key === 'lip' ? lib.EDGES : key === 'framing_bead' ? lib.FRAMES : lib.PANELS, id = `SQL-${o.id}`; if (tab) tab[id] = { label: o.name, ...l.profile, sqlName: o.name }; l = { ...l, key: id, type: key === 'panel_style' ? 'panel' : l.type }; }
      return l;
    };
    const fb = opt('framing_bead'), lp = opt('lip'), ps = opt('panel_style'), wd = opt('wood'), fn = opt('finish');
    let l;
    if (fb && (l = look('framing_bead', fb))) J.frame = l.key;
    if (lp && (l = look('lip', lp))) J.edge = l.key;
    if (ps && (l = look('panel_style', ps))) { if (l.type === 'glass') { J.type = 'glass'; J.glass = 'open'; } else { J.type = 'panel'; J.panel = l.key; } }
    if (wd && (l = look('wood', wd))) J.species = l.id;
    if (fn && (l = look('finish', fn))) J.finish = l.id;
    const P = a => (parts || []).find(p => p.alias === a), W = a => (P(a) && P(a).width != null ? Number(P(a).width) : null);
    // the outer stiles and rails as they finish: the parts are cut wider by the lip's tolerance (2 5/16" for a 2 1/4"
    // stile under a lip), so the finished widths from the formulas are drawn, and the part widths only where there are none
    const fin = a => { const it = (view.sections || []).flatMap(x => x.items).find(i => i.kind === 'input' && i.frame === a), entered = it ? toIn(inputValues[it.key]) : null, v = entered ?? (it && widths ? widths[it.key] : null); return v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null; };
    const OW = a => fin(a) ?? W(a);
    { const k = Object.keys(attrs || {}).find(x => FINISH_THICK.test(x) || (view.product?.finish_thickness_keys || []).includes(x)), ft = k ? Number(attrs[k]) : NaN; if (ft > 0) J.thickness = Math.round((ft + SAND) * 1000) / 1000; }
    if (OW('left_stile')) J.SL = OW('left_stile'); if (OW('right_stile')) J.SR = OW('right_stile'); if (OW('top_rail')) J.R = OW('top_rail'); if (OW('bottom_rail')) J.B = OW('bottom_rail');
    // the panels and the rails and stiles between them, wherever they are (a multi-panel layout's live in the opening:
    // opening.top_panel, opening.center_rail …)
    const sum = re => countParts.filter(p => re.test(p.alias)).reduce((n, p) => n + (Number(p.qty) || 1), 0);
    const inner = re => (parts || []).find(p => re.test(p.alias) && !/^(top|bottom)_rail$|^(left|right)_stile$/.test(p.alias));
    const mid = inner(/rail$/) || inner(/stile$/); if (mid && mid.width != null) J.CR = Number(mid.width);
    const railsIn = countParts.filter(p => /rail$/.test(p.alias) && !/^(top|bottom)_rail$/.test(p.alias)).reduce((n, p) => n + (Number(p.qty) || 1), 0);
    const rows = railsIn + 1, panels = Math.max(1, sum(/panel$/)), cols = Math.max(1, Math.round(panels / rows));
    J.layout = rows === 1 ? ({ 1: '1', 2: '2a', 3: '3a', 4: '4a', 5: '5a' }[cols] || '1') : cols === 1 ? ({ 2: '2', 3: '3', 4: '4', 5: '5' }[rows] || '1') : rows === 2 ? '2dn' : rows === 3 ? '3dn' : '1';
    if (/dn$/.test(J.layout)) J.across = cols;
    const rowsOut = layoutRows(countParts, layoutName, sizes, H); if (rowsOut) { J.rows = rowsOut; J.layoutLabel = layoutName; }
    const layoutItem = its.find(i=>i.kind==='layout');
    const layoutOption = layoutItem?.options.find(o=>o.id===String(layouts[layoutItem.key] ?? layoutItem.standard));
    if(layoutOption?.visual?.rows?.length) {
      const preset=layoutOption.visual;
      J.rows=preset.rows.map((row,i)=>({...row,...(preset.adaptive&&rowsOut?.length===preset.rows.length?{n:preset.variable_columns?(rowsOut[i].n||row.n):row.n,weight:rowsOut[i].weight||row.weight,...(rowsOut[i].cols?.length===(row.n||1)?{cols:rowsOut[i].cols}:{})}: {})}));
      J.layoutLabel=layoutOption.name;
      if(layoutOption.variant)J.layoutVariant=layoutOption.id;
      if(!preset.reviewed)approx.push('panel layout schematic (awaiting visual review)');
    }
    if(layoutOption?.count_template){
      const spec=layoutOption.count_spec,value=k=>toIn(sizes[k])??layoutOption.count_defaults?.[k],across=spec.x?Number(value(spec.x)):spec.across,down=spec.y?Number(value(spec.y)):spec.down;
      if(Number.isInteger(across)&&across>0&&Number.isInteger(down)&&down>0){
        J.layoutVariant=layoutOption.id+'x'+across+'y'+down;
        J.layoutPreviewLimit=across*down>256;
        J.rows=J.layoutPreviewLimit?[]:Array.from({length:down},(_,i)=>({fill:i===0&&spec.top?spec.top:spec.fill,n:across,weight:rowsOut?.length===down?rowsOut[i].weight:1}));
      }
    }
    if (J.rows?.length && layoutItem) {
      const measured = {};
      for (const sz of layoutOption?.sizes || []) {
        const v = widths?.[`${layoutItem.key}.${sz.name}`];
        // Returned formula values include derived reference dimensions, not only typed overrides.
        if (Number(v)>0) measured[sz.name]=String(v);
        if (sz.frame && /^center_(rail|stile)$/.test(sz.frame) && Number(v)>0) J.CR=Number(v);
      }
      J.rows=measuredRows(J.rows,sizes,measured);
    }
    // mullion doors (ML-Gothic, ML-Hourglass …): drawn with the mullion geometry from the ML Mullion Door builder;
    // ones it has no geometry for are noted as approximate
    const m = mullionOf(`${view.product.name} ${layoutName || ''}`);
    if (m) { J.type = 'glass'; J.glass = m.style; if (m.lites) J.mLites = m.lites; delete J.rows; J.layoutLabel = layoutName || J.layoutLabel; }
    else if (/\bML-|mullion/i.test(`${view.product.name} ${layoutName || ''}`)) approx.push(`${view.product.name}${layoutName ? ` (${layoutName})` : ''} mullions`);
    if (/solid/i.test(view.product.product_type || '') || ((parts || []).length && !P('left_stile') && !P('top_rail'))) J.type = 'slab';
    const revealItem = its.find(i => i.key === 'custom_raise_reveal'), revealOption = opt('panel_style');
    const rawReveal = attrs?.custom_raise_reveal;
    const customReveal = rawReveal == null || String(rawReveal).trim() === '' ? revealOption?.reveal?.standard : Number(rawReveal);
    if (revealItem && revealOption?.reveal && customReveal > 0 && Number.isFinite(customReveal)
      && Math.abs(customReveal - (revealOption.reveal.trace_standard ?? revealOption.reveal.source_standard ?? revealOption.reveal.standard)) > 1e-9) {
      J.raiseReveal = customReveal;
      J.raiseMinFlat = revealOption.reveal.min_flat;
      approx.push('modified raise section (visual preview; cutter geometry requires confirmation)');
    }
    const fhd = String(view.product.name || '').match(/FHD[- ]?(100|103|200|300)[- ]?(LEFT|RIGHT)/i);
    if (fhd) {
      J.fhd = { code:fhd[1], hand:fhd[2].toLowerCase() };
      J.braceWidth = 2.25;
      if (fhd[1] === '103' && (!J.rows || J.rows.length < 2)) J.rows = [{fill:'panel',weight:1},{fill:'panel',weight:1}];
    }
    const srp = String(view.product.name || '').match(/^SRP[- ](2020|3030|6060|350|20|30|40|60|90)(?:[- ]Half[- ](Left|Right))?(?=$|[ (])/i);
    if (srp) {
      J.srpStyle = 'SRP-' + srp[1] + (srp[2] ? '-Half ' + srp[2][0].toUpperCase() + srp[2].slice(1).toLowerCase() : '');
      approx.push('SRP contour from imported review data; resizing assumptions require review');
    }
    J.design = view.product.name;
    return { job: J, approx, unmatched, pictures };
  }

  // iconFor(product, job) → SVG: door styles show as tiles; job is the current configuration for the selected style (a
  // live drawing), null for the others (a generic outline)
  // configurator: 'door' (door styles, with the door drawing) or 'drawer_box' (Bee-Line, Arrow-Line …: the same picker and
  // pricing, no door drawing; iconFor draws the tiles)
  // only: which listed products to offer here (the planner leaves out the 45° corner drawer boxes)
  const NEED = '<small class="needmsg">Choose one to get a price</small>';
  // Keystone's door design categories (as keystonewood.com groups them), from a style's name and product type
  const CATS = ['Traditional', 'Shaker', 'Narrow Shaker', 'Applied Moulding', 'Mullion', 'Louver', 'Solid'];
  const catOf = p => { const n = `${(p && p.name) || ''} ${(p && p.product_type) || ''}`;
    if (/louv/i.test(n)) return 'Louver';
    if (/(^|[\s(])ML-|mullion|multi-?lite/i.test(n)) return 'Mullion';
    if (/narrow shaker/i.test(n)) return 'Narrow Shaker';
    if (/(^|[\s(])KAM-|applied moulding|moulding applied/i.test(n)) return 'Applied Moulding';
    if (/solid|slab|pro-?cor|\bdvg|batten|veneer|3-piece/i.test(n)) return 'Solid';   // (after the framed kinds: a Narrow Shaker or KAM with a PRO-COR panel isn't solid)
    if (/(^|[\s(])SK-|shaker/i.test(n)) return 'Shaker';
    return 'Traditional'; };
  function pickStyle() {
    if (typeof document === 'undefined' || document.getElementById('sqlPickStyle')) return;
    const st = document.createElement('style'); st.id = 'sqlPickStyle';
    st.textContent = `.stylecats { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
      .stylecats button { font: inherit; font-size: 12.5px; line-height: 1.2; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line, #d6d3cc); background: transparent; color: inherit; cursor: pointer; }
      .stylecats button:hover { border-color: currentColor; }
      .stylecats button[aria-pressed="true"] { background: var(--ink, #1e2a2e); color: var(--panel, #fff); border-color: var(--ink, #1e2a2e); }
      .stylecats button small { opacity: .65; margin-left: 4px; font-size: 11px; }
      .styletiles { grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)) !important; gap: 6px !important; }
      .styletile { padding: 6px 4px 5px !important; gap: 3px !important; }
      .styletile .styleicon { height: 60px; width: 100%; display: flex; align-items: center; justify-content: center; }
      .styletile .styleicon svg { height: 100%; max-height: 60px; width: auto; max-width: 100%; }
      .styletile .stylename { font-size: 11px !important; line-height: 1.2; }
      .styletiles.textstyles { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)) !important; }
      .textstyles .styletile { min-height: 42px; padding: 10px !important; justify-content: center; text-align: left; align-items: flex-start; }
      .textstyles .stylename { font-size: 13px !important; overflow-wrap: anywhere; }
      .sql-preview-surface { position: relative; }
      .sql-preview-overlay { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; border-radius: inherit; background: var(--panel, #fff); color: var(--ink, #1e2a2e); opacity: .96; text-align: center; font: 500 14px/1.4 system-ui, sans-serif; cursor: progress; }
      .sql-preview-spin { width: 30px; height: 30px; border: 3px solid var(--line, #d6d3cc); border-top-color: var(--ink, #1e2a2e); border-radius: 50%; animation: sqlPreviewSpin .8s linear infinite; }
      .sql-next-spin { display:inline-block; width:16px; height:16px; border-width:2px; vertical-align:middle; margin-right:8px; }
      @keyframes sqlPreviewSpin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .sql-preview-spin { animation: none; } }
      /* the category menu (families, then styles), the chosen style, sections still missing a choice, and an option the
         preview pointed to */
      .ccrumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 13px; margin: 0 0 12px; color: var(--muted, #5f6b66); }
      .ccrumbs button { font: inherit; border: 0; background: none; color: var(--blue, #2F5D7C); cursor: pointer; padding: 2px 4px; border-radius: 4px; text-decoration: underline; text-underline-offset: 2px; }
      .ccrumbs span { color: var(--ink, #1c2422); font-weight: 600; } .ccrumbs i { font-style: normal; opacity: .5; }
      .cfams { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; margin: 0 0 12px; }
      .cfam { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 8px 11px; border: 1px solid var(--line, #e1e5e2); border-radius: 12px; background: var(--field, #fff); color: inherit; font: inherit; cursor: pointer; transition: border-color .12s, box-shadow .12s, transform .12s; }
      .cfam:hover, .cfam:focus-visible { border-color: var(--sage-ink, #4E6153); box-shadow: 0 4px 14px rgb(0 0 0 / .08); transform: translateY(-1px); outline: none; }
      .cfam .cfam-ico { color: var(--sage-ink, #4E6153); } .cfam-name { font-weight: 600; font-size: 13.5px; text-align: center; line-height: 1.25; } .cfam small { font-size: 11.5px; color: var(--muted, #5f6b66); }
      .cfam.empty { opacity: .55; }
      .cchosen { display: flex; align-items: center; gap: 12px; justify-content: space-between; padding: 12px 14px; border: 1px solid var(--line, #e1e5e2); border-radius: 10px; background: var(--field, #fff); }
      .cchosen small { display: block; color: var(--muted, #5f6b66); font-size: 12px; } .cchosen strong { display: block; font-size: 16px; margin-top: 2px; }
      .cbtn { font: 600 13px system-ui, sans-serif; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--sage-ink, #4E6153); background: var(--sage-ink, #4E6153); color: #fff; cursor: pointer; white-space: nowrap; }
      .cbtn.ghost { background: transparent; color: var(--ink, #1c2422); border-color: var(--line, #e1e5e2); margin-top: 10px; }
      .sql-sec.needs > h2::after { content: ' · selection needed'; color: var(--warn, #9A3B1E); text-transform: none; letter-spacing: 0; font-weight: 600; }
      @keyframes sqlFlash { 0% { box-shadow: 0 0 0 3px var(--sage, #94A596); background: color-mix(in srgb, var(--sage, #94A596) 18%, transparent); } 100% { box-shadow: 0 0 0 3px transparent; } }
      .sql-flash { animation: sqlFlash 1.8s ease-out; border-radius: 8px; }
      .sql-option-row { width:100%; display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid var(--line,#ccc); border-radius:8px; background:var(--panel,#fff); color:inherit; text-align:left; padding:14px; cursor:pointer; font:inherit; }
      .sql-option-row small { display:block; color:var(--muted,#666); margin-top:5px; font-size:12px; line-height:1.5; }
      .sql-option-row.needs { border-color:var(--warn,#a33b20); box-shadow:inset 4px 0 var(--warn,#a33b20); }
      .sql-option-row.needs small { color:var(--warn,#a33b20); }
      .sql-option-next { display:block; width:100%; margin-top:16px; padding:12px; border:0; border-radius:8px; background:var(--ink,#24362e); color:var(--panel,#fff); font:600 14px system-ui; cursor:pointer; }
      .sql-option-next:focus-visible { outline:3px solid var(--accent,#22754d); outline-offset:2px; }
      .sql-option-row[aria-expanded=true] { border:2px solid var(--accent,#22754d); padding:13px; background:color-mix(in srgb,var(--accent,#22754d) 22%,var(--panel,#fff)); box-shadow:inset 6px 0 var(--accent,#22754d); }
      .sql-option-row[aria-expanded=true] strong { font-size:15px; }
      .sql-option-row[aria-expanded=true] small { color:inherit; opacity:.9; }
      .sql-option-row[aria-expanded=true] > span:last-child { font-size:0; }
      .sql-option-row[aria-expanded=true] > span:last-child::after { content:'Editing'; font-size:11px; font-weight:700; color:inherit; border:1px solid currentColor; border-radius:4px; padding:4px 6px; }
      .sql-option-row:hover { background:color-mix(in srgb,var(--accent,#22754d) 10%,var(--panel,#fff)); }
      .sql-option-row[aria-expanded=true]:hover { background:color-mix(in srgb,var(--accent,#22754d) 28%,var(--panel,#fff)); }
      .sql-option-body[hidden] { display:none!important; }
      .sql-option-body { padding:12px 0; }
      .sql-option-back { border:0; background:none; color:inherit; font:inherit; cursor:pointer; padding:8px 0; margin-bottom:8px; }
      .sql-option-row:focus-visible,.sql-option-back:focus-visible { outline:3px solid var(--accent,#22754d); outline-offset:2px; }
      .stylefind { margin-bottom: 8px; }`;
    document.head.appendChild(st);
  }
  // Cover only the drawing surfaces. Selection controls remain available during requests.
  function setPreviewLoading(root, loading) {
    if (!root) return;
    pickStyle();
    const surfaces = root.matches('[data-preview-surface]') ? [root] : [...root.querySelectorAll('[data-preview-surface], .dc-elev, .dc-sect')];
    root.setAttribute('aria-busy', String(!!loading));
    for (const [index, surface] of surfaces.entries()) {
      surface.classList.add('sql-preview-surface');
      let cover = surface.querySelector(':scope > .sql-preview-overlay');
      if (!loading) { cover?.remove(); continue; }
      if (!cover) {
        cover = document.createElement('div'); cover.className = 'sql-preview-overlay';
        if (!index) { cover.setAttribute('role', 'status'); cover.setAttribute('aria-live', 'polite'); }
        else cover.setAttribute('aria-hidden', 'true');
        cover.innerHTML = '<span class="sql-preview-spin" aria-hidden="true"></span><span data-loading-message></span>';
        surface.appendChild(cover);
      }
      cover.querySelector('[data-loading-message]').textContent = loading.phase === 'price' ? 'Updating preview and section…' : loading.phase === 'catalog' ? 'Loading styles…' : `Loading ${loading.name || 'preview'}…`;
    }
  }
  function organizeSidebar(panel, state) {
    const sections = [...panel.children].filter(e => e.tagName === 'SECTION');
    if (state.openSection === undefined) state.openSection = '0';
    const missing = section => section === sections[0] && !state.view ? [section.querySelector('[data-pick],[data-product]')].filter(Boolean) : [...section.querySelectorAll('.field.needs select,.field.needs input,[required],[data-dim],[data-qty]')].filter(e => !e.disabled && (!e.value.trim() || (e.matches('[data-dim],[data-qty]') && !(toIn(e.value) > 0))));
    const update = () => {
      const blocked = !state.view || state.loading?.phase === 'product' || state.loading?.phase === 'catalog';
      if (blocked) state.openSection = '0';
      for (const [index, section] of sections.entries()) {
        const summary = section.querySelector('[data-option-summary]');
        section.querySelector('[data-option-open]').disabled = blocked && index > 0;
        const next = section.querySelector('.sql-option-next');
        next.disabled = blocked;
        const loading = index === 0 && !!state.loading && blocked;
        next.setAttribute('aria-busy', String(loading));
        if (loading) next.innerHTML = '<span class="sql-preview-spin sql-next-spin" aria-hidden="true"></span><span>Loading…</span>';
        else next.textContent = index === 0 && !state.view ? 'Choose a style to continue' : next.normalLabel;
        section.querySelector('.sql-option-body').inert = blocked && index > 0;
        if (blocked) { section.querySelector('.sql-option-body').hidden = index !== 0; section.querySelector('[data-option-open]').setAttribute('aria-expanded', String(index === 0)); }
        const values = index === 0 ? [state.loading?.phase === 'product' ? `Loading ${state.loading.name}…` : state.view?.product.name || 'Choose a style to begin'] : [...section.querySelectorAll('select,input,textarea')].filter(e => !e.matches('[type="search"],[data-pl-filter]') && !e.disabled && e.value && (e.type !== 'checkbox' || e.checked)).map(e => e.tagName === 'SELECT' ? e.selectedOptions[0]?.textContent : e.type === 'checkbox' ? e.closest('label')?.textContent.trim() : `${e.closest('label')?.childNodes[0]?.textContent.trim() || ''}: ${e.value}`);
        const layout = section.querySelector('.pl-selected strong'); if (layout) values.unshift(layout.textContent);
        summary.textContent = (missing(section).length ? 'Selection needed · ' : '') + (values.filter(Boolean).slice(0,3).join(' · ') || 'Standard settings');
        section.querySelector('[data-option-open]').classList.toggle('needs', !!missing(section).length);
      }
    };
    sections.forEach((section,index) => {
      const key = String(index), title = section.querySelector('h2')?.textContent || 'Options';
      const body = document.createElement('div'); body.className = 'sql-option-body';
      while(section.firstChild) body.appendChild(section.firstChild);
      const button = document.createElement('button'); button.type = 'button'; button.dataset.optionOpen = key;
      button.className = 'sql-option-row'; button.innerHTML = `<span><strong>${index + 1}. ${esc(title)}</strong><small data-option-summary></small></span><span aria-hidden="true">›</span>`;
      const back = document.createElement('button'); back.type = 'button'; back.className = 'sql-option-back'; back.textContent = '← Back to options'; body.prepend(back);
      const setOpen = value => { if ((!state.view || state.loading?.phase === 'product' || state.loading?.phase === 'catalog') && value !== '0') return; state.openSection = value; for (const [i, other] of sections.entries()) { const open = String(i) === value; other.querySelector('.sql-option-body').hidden = !open; other.querySelector('[data-option-open]').setAttribute('aria-expanded', String(open)); } };
      button.onclick = () => { update(); setOpen(state.openSection === key ? null : key); };
      back.onclick = () => { update(); setOpen(null); button.focus(); };
      const next = document.createElement('button'); next.type = 'button'; next.className = 'sql-option-next';
      next.normalLabel = next.textContent = index < sections.length - 1 ? `Continue to ${sections[index + 1].querySelector('h2')?.textContent || 'next options'} →` : 'Review selections';
      next.onclick = () => {
        update(); if (!state.view || state.loading?.phase === 'product' || state.loading?.phase === 'catalog') return; const needed = missing(section);
        if (needed.length) { needed[0].focus(); needed[0].scrollIntoView?.({ block: 'nearest' }); return; }
        const target = sections[index + 1] || sections.find(s => missing(s).length);
        if (target) { setOpen(String(sections.indexOf(target))); target.querySelector('[data-option-open]').focus(); target.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }
        else { setOpen(null); button.focus(); }
      };
      body.append(next);
      body.hidden = state.openSection !== key; button.setAttribute('aria-expanded', String(!body.hidden));
      section.replaceChildren(button,body);
    });
    update(); return update;
  }
  // the options as plain sections, every one shown at once (no steps): a section still missing a choice is marked
  function markSections(panel) {
    const sections = [...panel.children].filter(e => e.tagName === 'SECTION');
    for (const s of sections) s.classList.add('sql-sec');
    const update = () => { for (const s of sections) s.classList.toggle('needs', [...s.querySelectorAll('.field.needs select,.field.needs input,select[required],input[required]')].some(e => !String(e.value || '').trim())); };
    update(); return update;
  }
  function needsStyle() {
    if (typeof document === 'undefined' || document.getElementById('sqlNeedsStyle')) return;
    const st = document.createElement('style'); st.id = 'sqlNeedsStyle';
    st.textContent = `.field.needs { color: #c62828; } .field.needs select, .field.needs input { border-color: #c62828 !important; box-shadow: 0 0 0 2px rgba(198, 40, 40, .16); }
      .field .needmsg { color: #c62828; font-size: .76rem; font-weight: 600; margin-top: 2px; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .field.needs { color: #ff8a80; } :root:not([data-theme="light"]) .field.needs select, :root:not([data-theme="light"]) .field.needs input { border-color: #ff8a80 !important; box-shadow: 0 0 0 2px rgba(255, 138, 128, .18); } :root:not([data-theme="light"]) .field .needmsg { color: #ff8a80; } }
      :root[data-theme="dark"] .field.needs { color: #ff8a80; } :root[data-theme="dark"] .field.needs select, :root[data-theme="dark"] .field.needs input { border-color: #ff8a80 !important; } :root[data-theme="dark"] .field .needmsg { color: #ff8a80; }`;
    document.head.appendChild(st);
  }
  function dimensionValues(view, physical) {
    return Object.fromEntries(items(view).filter(i => i.kind === 'dim').flatMap(i => {
      const v = toIn(physical[i.axis || i.key]); return v == null ? [] : [[i.key,String(v)]];
    }));
  }
  // A page may overlap this request with loading the drawing library. This is a one-shot
  // promise passed to create(), not a persistent catalog cache (admin/public stay separate).
  function loadList({ staff = false, forPlanner = false, configurator = 'door' } = {}) {
    const isDF = configurator === 'drawer_front', isDoor = configurator === 'door' || isDF;
    const qs = [isDF ? 'configurator=drawer_front' : '', forPlanner ? 'for=planner' : ''].filter(Boolean).join('&');
    return api('GET', `${staff ? '/api/admin' : '/api/catalog'}/${isDoor ? 'doors' : 'drawer-boxes'}${qs ? `?${qs}` : ''}`);
  }
  function pendingChoices(S, forPlanner = false, ruleOk = () => true) {
    const missing = [];
    for (const it of items(S.view)) {
      if (it.look?.show_when && !ruleOk(it.look.show_when, it.key)) continue;
      if (it.kind === 'option' && !(S.sel[it.key] ?? it.standard)) missing.push(it.label);
      if (it.kind === 'layout' && !(S.layouts?.[it.key] ?? it.standard)) missing.push(it.label);
      if (it.kind === 'input' && it.required && !(toIn(S.inputs[it.key]) > 0)) missing.push(it.label);
      if (it.kind === 'dim' && !forPlanner && !(toIn(S.dims[it.axis || it.key]) > 0)) missing.push(it.label);
    }
    if (!forPlanner && !(Number(S.qty) > 0)) missing.push('Quantity');
    return missing;
  }
  function previewPlaceholder(section = false) {
    const shape = section ? '<rect x="20" y="45" width="200" height="40" rx="2"/>' : '<rect x="35" y="10" width="130" height="220" rx="2"/>';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${section ? '240 130' : '200 240'}" role="img" aria-label="Preview waiting for required selections" style="max-height:420px;opacity:.45;fill:none;stroke:#b1babc;stroke-width:2">${shape}</svg>`;
  }

  function create({ panel, staff = false, forPlanner = false, wanted = null, lib = null, onChange = () => {}, heading = 'Door', iconFor = null, configurator = 'door', only = null, listReady = null, onLoading = () => {} }) {
    // the drawer front configurator works like the door one (the same drawings and choices), on the drawer fronts' own list
    const isDF = configurator === 'drawer_front', isDoor = configurator === 'door' || isDF;
    const cfgName = isDF ? 'drawer front configurator' : isDoor ? 'door configurator' : 'drawer box configurator';
    needsStyle(); pickStyle();
    const url = (id, what) => staff ? `/api/admin/products/${encodeURIComponent(id)}/configurators/${configurator}/${what === 'config' ? 'preview?office=1' : 'price'}`
      : what === 'config' ? `/api/catalog/products/${encodeURIComponent(id)}/config?configurator=${configurator}${forPlanner && !isDoor ? '&for=planner' : ''}` : `/api/catalog/products/${encodeURIComponent(id)}/price`;
    const S = { list: [], view: null, sel: {}, attrs: {}, inputs: {}, dims: isDF ? { width: '23.875', height: '7.5' } : isDoor ? (forPlanner ? { width: '15.75', height: '30.25' } : { width: '', height: '' }) : { width: '15', height: '6', depth: '21' }, qty: '1', price: null, job: null, approx: [], error: null };
    // what's chosen, by name, for the attributes' “Show only when” rules (the same as the server's chosenFor)
    const ruleOk = (rule, key) => {
      // a formula rule (wood.thickness > 1) is worked out by the engine with each price; until then it stays hidden
      if (rule && rule.formula) return !!(S.price && S.price.visible && S.price.visible[key]);
      if (!rule || !rule.key || !(rule.values || []).length) return true;
      const it = items(S.view).find(i => i.key === rule.key); let have = '';
      if (it && (it.kind === 'option' || it.kind === 'layout')) { const id = (it.kind === 'option' ? S.sel : S.layouts)[it.key] ?? it.standard; const o = (it.options || []).find(o => String(o.id) === String(id)); have = o ? o.name : ''; }
      else if (it && it.kind === 'attribute') { const v = S.attrs[it.key] ?? it.default; have = v == null ? '' : it.control === 'toggle' ? (String(v) === '1' ? 'yes' : 'no') : String(v); }
      have = have.toLowerCase(); const hit = have !== '' && rule.values.some(v => { v = String(v).toLowerCase().trim(); return v && (have === v || have.includes(v)); });
      return rule.op === 'not_in' ? !hit : hit;
    };
    // a frame member's standard width, from the last price's parts (for the empty Rails and stiles boxes)
    const partW = (alias, key) => { const w = S.price && S.price.widths && key && S.price.widths[key]; if (w != null) return `${frac(w)} standard`;
      const pt = ((S.price && S.price.parts) || []).find(x => x.alias === alias); return pt && pt.width != null ? `${frac(pt.width)} standard` : 'Standard'; };
    let seq = 0, loadSeq = 0, pendingSaved = null;

    const fail = (msg) => { panel.innerHTML = `<section><h2>${esc(heading)}</h2><p class="msg">${esc(msg)}</p></section>`; S.view = null; S.loading = null; try { emit(); } finally { onLoading(null); } };
    async function start() {
      S.loading = { phase: 'catalog', name: 'styles' }; onLoading(S.loading);
      try {
        const r = await (listReady || loadList({ staff, forPlanner, configurator }));
        S.list = r.ok ? (only ? r.products.filter(only) : r.products) : [];
        // the catalog's categories (the menu: families, then styles); a staff preview has the draft ones
        if (isDoor) S.cats = await api('GET', staff ? '/api/admin/categories' : '/api/catalog/categories').then(c => c && c.ok ? c.categories : null).catch(() => null);
        if (!r.ok) S.error = r.error;
        const saved = wanted && typeof wanted === 'object' ? wanted : null, first = saved ? saved.product : wanted;
        // staff asking for a product open that one, offered here or not (it's being set up)
        if (staff && first && !S.list.some(p => p.id === first)) S.list.unshift({ id: String(first), name: `Product ${first}`, product_type: '', notOffered: true });
        if (!S.list.length) return fail(S.error || (isDF ? 'No drawer fronts are offered yet. In the admin, set a drawer front Live, offer it in the drawer front configurator, and publish.' : isDoor ? 'No doors are offered yet. In the admin, set a door Live, offer it in the door configurator (or the kitchen planner), and publish.'
          : (forPlanner ? 'No drawer boxes are offered in the kitchen planner yet. In the admin, enable Kitchen planner on the desired boxes or cutlery trays, set them Live, and publish.' : 'No drawer boxes are offered yet. In the admin, offer the drawer boxes in the drawer box configurator, set them Live, and publish.')));
        if (first && !S.list.some(p => p.id === first)) S.error = 'That door isn’t available here, so choose another style.';
        const id = S.list.some(p => p.id === first) ? first : isDoor ? null : S.list[0].id;
        if (!id) { S.loading = null; draw(); try { emit(); } finally { onLoading(null); } return; }
        pendingSaved = saved && saved.product === id ? saved : null;
        await load(id);
      } catch (e) { fail(`The door configurator couldn’t start: ${e.message}`); }
    }
    async function load(id) {
      const my = ++loadSeq, saved = pendingSaved; pendingSaved = null; S.menuOpen = false;
      ++seq; // An old price must not arrive while a newly clicked product is loading.
      S.loading = { phase: 'product', product: id, name: S.list.find(p => p.id === id)?.name || 'product' };
      S.openSection = '0'; S.updateSummaries?.();
      panel.setAttribute('aria-busy', 'true');
      for (const tile of panel.querySelectorAll('[data-pick]')) {
        const pending = tile.dataset.pick === id;
        tile.setAttribute('aria-busy', String(pending));
        tile.classList.toggle('on', pending);
        tile.setAttribute('aria-pressed', String(pending));
        const label = tile.querySelector('.stylename'), product = S.list.find(p => p.id === tile.dataset.pick);
        if (label && product) label.textContent = product.name + (pending ? '…' : '');
      }
      onLoading(S.loading);
      let v;
      try { const base=url(id,'config'),ids=Object.values(saved?.layouts||{}).join(','); v = await api('GET',base+(ids?(base.includes('?')?'&':'?')+'layout_ids='+encodeURIComponent(ids):'')); } catch (e) { v = { ok: false, error: e.message }; }
      if (my !== loadSeq) return; // The most recent click owns the picker.
      panel.setAttribute('aria-busy', 'false');
      if (!v.ok) return fail(v.error || 'That door couldn’t be loaded.');
      try {
        const entry = S.list.find(p => p.id === id); if (entry) { entry.name = v.product.name; entry.product_type = v.product.product_type; }
        S.view = v; S.price = null; S.job = null; S.approx = []; S.unmatched = []; S.pictures = []; S.visSig = null; S.sel = {}; S.attrs = {}; S.inputs = {}; S.layouts = {}; S.lsizes = {}; S.layoutFilters={}; S.thick = null; S.thickWarn = '';
        for (const it of items(v)) if (it.kind === 'option' && it.standard) S.sel[it.key] = it.standard;   // every door starts on its standard selections
        for (const it of items(v)) if (it.kind === 'attribute' && it.default != null) S.attrs[it.key] = isFinishThickness(it.key) ? (v.product.standard_finish_thickness || 0.78) : it.default;
        if (saved) { const ok = id => items(v).some(i => i.kind === 'option' && i.options.some(o => o.id === id));
          if (saved.dims) S.dims = { ...saved.dims };
          if (saved.qty != null) S.qty = String(saved.qty);
          for (const [k, x] of Object.entries(saved.sel || {})) if (ok(x)) S.sel[k] = x;
          Object.assign(S.attrs, saved.attrs || {}); Object.assign(S.inputs, saved.inputs || {});S.lsizes=JSON.parse(JSON.stringify(saved.layout_sizes||{}));
          for (const [k, x] of Object.entries(saved.layouts || {})) if (items(v).some(i => i.kind === 'layout' && i.key === k && i.options.some(o => o.id === x))) S.layouts[k] = x;
        }
        if (/^SRP[- ]/i.test(v.product.name) && typeof window !== 'undefined' && !window.KeystoneSrpGeometry) {
          try { window.KeystoneSrpGeometry = await import('./srp-review/scalable/door-geometry.mjs'); }
          catch (e) { console.error('SRP geometry:', e); }
          if (my !== loadSeq) return;
        }
        S.loading = null; syncFinish(); draw(); price();
      } catch (e) { if (my === loadSeq) fail(e.message || 'That door couldn’t be loaded.'); }
    }
    // the SQL's rules: a choice that can't go with what's chosen elsewhere is marked and can't be picked
    function layoutBlocked(it) { const chosen = new Set(Object.values(S.sel).map(String)); return new Set((it.rules || []).filter(([, o]) => chosen.has(o)).map(([l]) => l)); }
    function blockedFor(key) {
      const others = new Set(items(S.view).filter(i => i.kind === 'option' && i.key !== key).map(i => S.sel[i.key]).filter(Boolean)), out = new Map();
      for (const [a, b] of S.view.rules || []) { if (others.has(a)) out.set(b, a); if (others.has(b)) out.set(a, b); }
      // the chosen panel layout's rules too
      for (const it of items(S.view).filter(i => i.kind === 'layout')) { const cur = S.layouts[it.key] ?? it.standard, name = (it.options.find(o => o.id === cur) || {}).name;
        for (const [l, o] of it.rules || []) if (l === cur && name) out.set(o, name); }
      return out;
    }
    const nameOf = id => { for (const it of items(S.view)) if (it.kind === 'option') { const o = it.options.find(x => x.id === id); if (o) return o.name; } return id; };
    function control(it) {
      // a drawer box's height comes in 1/2" steps (the catalog's std_height_increment), from its 1 1/2" minimum to its 10"
      // maximum: a dropdown, so only heights Keystone makes can be picked
      if (it.kind === 'dim' && !isDoor && /^height$/i.test(it.key) && !forPlanner) {
        const cur = Math.floor((toIn(S.dims[it.key]) || 6) * 2 + 1e-9) / 2, list = []; for (let v = BOX_H.min; v <= BOX_H.max + 1e-9; v += BOX_H.step) list.push(+v.toFixed(3));
        const pick = list.includes(cur) ? cur : list.reduce((a, v) => (v <= cur ? v : a), list[0]); S.dims[it.key] = String(pick);
        return `<label class="field">${esc(it.label)}<select data-dim="${esc(it.key)}">${list.map(v => `<option value="${v}"${v === pick ? ' selected' : ''}>${Math.floor(v) || ''}${v % 1 ? `${Math.floor(v) ? ' ' : ''}1/2` : ''}"</option>`).join('')}</select></label>`;
      }
      if (it.kind === 'dim') return forPlanner ? '' : `<label class="field">${esc(it.label)}<input data-dim="${esc(it.axis || it.key)}" value="${esc(S.dims[it.axis || it.key] ?? '')}" inputmode="decimal" placeholder="inches"></label>`;   // the planner sizes each front itself
      if (it.kind === 'input') return it.control === 'list' ? `<label class="field">${esc(it.label)}<select data-in="${esc(it.key)}"><option value="">Standard</option>${it.choices.map(c => `<option value="${esc(c)}"${S.inputs[it.key] === c ? ' selected' : ''}>${frac(c)}</option>`).join('')}</select></label>`
        : `<label class="field${it.required && !String(S.inputs[it.key] ?? '').trim() ? ' needs' : ''}">${esc(it.label)}<input data-in="${esc(it.key)}" value="${esc(S.inputs[it.key] ?? '')}" placeholder="${it.required ? 'Enter Value (required)' : 'Standard'}" ${it.required ? 'required aria-required="true"' : ''} inputmode="decimal"></label>`;
      // a door's panel layout (the Multi Panel design in its opening: 1 Panel, 2 Down N Across …)
      if (it.kind === 'layout') { const cur = S.layouts[it.key] ?? it.standard, lay = it.options.find(o => o.id === cur), sz = (S.lsizes[it.key] = S.lsizes[it.key] || {}), blocked = layoutBlocked(it);
        const picker=typeof window!=='undefined'&&window.PanelLayoutPicker;
        const choose=picker?`<div class="field wide pl-picker"><h3 style="font-size:14px;margin:0 0 10px">${esc(it.label)}</h3><input type="hidden" data-layout="${esc(it.key)}" value="${esc(cur||'')}"><div data-layout-picker="${esc(it.key)}"></div></div>`
          :`<label class="field wide">${esc(it.label)}<select data-layout="${esc(it.key)}">${it.options.filter(o=>(!o.count_template&&!(o.variant&&o.across===1&&o.down===1))||o.id===cur).map(o=>`<option value="${esc(o.id)}"${cur===o.id?' selected':''}${blocked.has(o.id)&&cur!==o.id?' disabled':''}>${esc(o.name)}</option>`).join('')}</select></label>`;
        const details=lay?.sizes?.filter(x=>!x.frame)||[];
        return choose+(details.length?`<details class="pl-details"${lay.count_template||details.some(x=>sz[x.name])?' open':''}><summary>3. Adjust layout details</summary><div class="pl-details-grid">${details.map(x=>`<label class="field">${esc(x.label)}<input data-lsize="${esc(it.key)}|${esc(x.name)}" value="${esc(sz[x.name]??'')}" inputmode="decimal" placeholder="Automatic"></label>`).join('')}</div></details>`:'');
      }
      if (it.kind === 'option' && it.key === 'wood') {
        const ft = finishThick(), need = stockForFinish(ft, S.view.product.wood_policy?.stock_bands), blocked = blockedFor(it.key);
        const list = it.options.filter(o => woodFits(o, ft, S.view.product.wood_policy?.stock_bands));
        const one = o => `<option value="${esc(o.id)}"${S.sel.wood === o.id ? ' selected' : ''}${blocked.has(o.id) ? ' disabled' : ''}>${esc(stockOf(o.name).sheet ? o.name : (o.material?.species || stockOf(o.name).species))}${o.standard ? ' (standard)' : ''}${o.office ? ' (office only)' : ''}${blocked.has(o.id) ? ` — not with ${esc(nameOf(blocked.get(o.id)))}` : ''}</option>`;
        return `<label class="field wide${S.sel.wood ? '' : ' needs'}">${esc(it.label)}<select data-opt="wood"><option value="">Choose…</option>${list.map(one).join('')}</select>${S.sel.wood ? '' : NEED}</label>
          <p class="note wide" style="margin:0">Finish at thickness: ${esc(ft)}" — ${need ? esc(need) + ' solid stock' : 'outside the supported range'}. Sheet materials retain their stated thickness limits.</p>
          ${!list.length ? '<p class="msg wide">No wood choices are available at this thickness for this design.</p>' : ''}
          ${S.thickWarn ? `<p class="msg wide" style="margin:0">${esc(S.thickWarn)}</p>` : ''}`;
      }
      if (it.kind === 'option') {
        const blocked = blockedFor(it.key), one = o => `<option value="${esc(o.id)}"${S.sel[it.key] === o.id ? ' selected' : ''}${blocked.has(o.id) && S.sel[it.key] !== o.id ? ' disabled' : ''}>${esc(o.name)}${o.standard ? ' (standard)' : ''}${o.office ? ' (office only)' : ''}${blocked.has(o.id) ? ` — not with ${esc(nameOf(blocked.get(o.id)))}` : ''}</option>`;
        const main = it.options.filter(o => !o.more), more = it.options.filter(o => o.more);
        const missing = !S.sel[it.key] && !it.standard;   // nothing chosen and no standard: the price needs a choice
        return `<label class="field wide${missing ? ' needs' : ''}">${esc(it.label)}<select data-opt="${esc(it.key)}">${it.standard ? '' : '<option value="">Choose…</option>'}${main.map(one).join('')}${more.length ? `<optgroup label="More choices">${more.map(one).join('')}</optgroup>` : ''}</select>${missing ? NEED : ''}</label>`;
      }
      if (it.kind === 'attribute' && it.key === 'custom_raise_reveal') {
        const panel = items(S.view).find(i => i.kind === 'option' && i.key === 'panel_style');
        const option = panel?.options.find(o => o.id === String(S.sel.panel_style ?? panel.standard)), guide = option?.reveal;
        if (!guide?.adjustable) return '';
        const value = S.attrs[it.key] ?? '';
        return `<label class="field wide">Modified raise reveal (in)<input data-attr="custom_raise_reveal" value="${esc(value)}" inputmode="decimal" placeholder="Standard: ${esc(guide.standard)}"></label>
          <p class="note wide">Visible width from the inside edge of the frame to the flat panel face. Suggested: ${esc(guide.suggested_min)}–${esc(guide.suggested_max)}". Leave blank for standard. Outside this guide requires review.</p>`;
      }
      // “Show only when…”: hidden while the choice it depends on doesn't match (the server ignores it then too)
      if (it.look && it.look.show_when && !ruleOk(it.look.show_when, it.key)) return '';
      const a = it, lk = a.look || {}, val = S.attrs[a.key] ?? a.default ?? '', unit = lk.unit_display ? ` (${lk.unit_display === 'mm' ? 'mm' : 'in'})` : a.unit ? ` (${esc(a.unit)})` : '';
      // how the attribute is set out: its share of the row, a new row, its alignment
      const box = (cls = 'field') => `<label class="${cls}${lk.width === 'full' ? ' wide' : ''}" style="${lk.width === 'full' ? 'grid-column:1/-1;' : ''}${lk.new_row ? 'grid-column-start:1;' : ''}">`;
      const al = lk.align ? ` style="text-align:${lk.align}"` : '';
      if (a.control === 'text') return `${box()}${esc(a.label)}<input data-attr="${esc(a.key)}" data-text value="${esc(S.attrs[a.key] ?? a.default ?? '')}" maxlength="${Number(lk.max_length) || 120}"${al}></label>`;
      if (a.control === 'paragraph') return `${box('field wide')}${esc(a.label)}<textarea data-attr="${esc(a.key)}" data-text rows="${Number(lk.box_lines) || 3}" maxlength="${Number(lk.max_length) || 2000}"${al}>${esc(S.attrs[a.key] ?? a.default ?? '')}</textarea></label>`;
      if (lk.read_only && a.control !== 'dropdown' && a.control !== 'toggle') return `${box()}${esc(a.label)}${unit}<input value="${esc(a.default ?? '')}" disabled${al}></label>`;
      if (a.control === 'toggle' && lk.checkbox_text) return `${box()}${esc(a.label)}<span class="check"><input type="checkbox" data-attr="${esc(a.key)}"${String(val) === '1' ? ' checked' : ''}> ${esc(lk.checkbox_text)}</span></label>`;
      // a dropdown with no default is optional: it starts on None (an extra like a handle cut-out), and can be set back to it
      if (a.control === 'dropdown') return `<label class="field">${esc(a.label)}${unit}<select data-attr="${esc(a.key)}">${a.default == null || a.default === '' ? (a.choices.some(c => c.value === '') ? '' : `<option value=""${val == null || val === '' ? ' selected' : ''}>None</option>`) : ''}${a.choices.map(c => `<option value="${esc(c.value)}"${String(val) === String(c.value) ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>`;
      if (a.control === 'toggle') return `<label class="field">${esc(a.label)}<span class="check"><input type="checkbox" data-attr="${esc(a.key)}"${String(val) === '1' ? ' checked' : ''}> Yes</span></label>`;
      if (a.control === 'slider') return `<label class="field wide">${esc(a.label)}${unit}<span class="check"><input type="range" data-attr="${esc(a.key)}" min="${esc(a.min)}" max="${esc(a.max)}" step="${esc(a.step || 1)}" value="${esc(val === '' ? a.min : val)}" style="flex:1"><output>${esc(val === '' ? a.min : val)}</output></span></label>`;
      return `<label class="field">${esc(a.label)}${unit}<input data-attr="${esc(a.key)}" value="${esc(val)}" inputmode="${a.control === 'integer' ? 'numeric' : 'decimal'}"></label>`;
    }
    // a finished thickness sets the stock: the Thickness choice follows it, and the wood moves to the same species in that
    // stock (or is cleared, with why, when that species isn't stocked that thick)
    const isFinishThickness = key => FINISH_THICK.test(key) || (S.view.product.finish_thickness_keys || []).includes(key);
    const finishThick = () => {
      const k = Object.keys(S.attrs || {}).find(x => isFinishThickness(x) && S.attrs[x] !== '' && S.attrs[x] != null);
      return k ? Number(S.attrs[k]) : Number(S.view.product.standard_finish_thickness || 0.78);
    };
    function syncFinish() {
      const ft = finishThick(), it = items(S.view).find(i => i.kind === 'option' && i.key === 'wood'); if (!it) return;
      const need = stockForFinish(ft, S.view.product.wood_policy?.stock_bands), blocked = blockedFor('wood');
      const available = it.options.filter(o => woodFits(o, ft, S.view.product.wood_policy?.stock_bands) && !blocked.has(o.id));
      S.thick = need; S.thickWarn = '';
      const was = S.sel.wood && it.options.find(o => o.id === S.sel.wood);
      if (was && !available.some(o => o.id === was.id)) {
        const sp = was.material?.species || stockOf(was.name).species;
        // Never substitute sheet goods for solid wood or pick between ambiguous duplicate species.
        const matches = available.filter(o => !stockOf(was.name).sheet && !stockOf(o.name).sheet
          && (o.material?.species || stockOf(o.name).species).toLowerCase() === sp.toLowerCase());
        if (matches.length === 1) S.sel.wood = matches[0].id;
        else { S.sel.wood = ''; S.thickWarn = `${sp} isn’t available for these choices at ${ft}". Choose another species.`; }
      }
      if (!need) S.thickWarn = 'Finish at thickness is outside the configured stock range.';
    }

    // the style menu from the catalog's categories: the Door & Drawer Fronts folder's subfolders are the families, then
    // theirs, then the styles filed in each; styles in no folder under “Other styles”. Without categories, the old list.
    const FAM_ICON = '<svg viewBox="0 0 40 56" width="40" height="56"><rect x="2" y="2" width="36" height="52" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="9" y="9" width="22" height="38" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".75"/></svg>';
    function catMenu(note, label) {
      const C = S.cats; if (!C || !(C.tree || []).length) return null;
      // the folders shown in this configurator (each folder's “Shown in”; a subfolder without its own follows its folder);
      // until no folder says, the Door & Drawer Fronts folder (as before). One such folder: the menu starts inside it;
      // several: at All categories, with them.
      const cfgKey = forPlanner ? 'planner' : configurator, says = n => Array.isArray(n.show);
      const anySaid = (function a(ns) { return ns.some(n => says(n) || a(n.children)); })(C.tree);
      const shown = (n, inh) => says(n) ? n.show.includes(cfgKey) : inh;
      let roots;
      if (anySaid) { roots = []; (function walk(ns) { for (const n of ns) { if (shown(n, false)) roots.push(n); else walk(n.children); } })(C.tree); }
      else { const r = C.tree.find(n => /door/i.test(n.name) && /front/i.test(n.name)) || C.tree.find(n => /door/i.test(n.name)); roots = r ? [r] : []; }
      if (!roots.length) return null;
      const root = roots.length === 1 ? roots[0] : { id: '__top', name: 'All categories', children: roots }, top = root.id === '__top';
      const kidsOf = n => n.id === '__top' ? n.children : n.children.filter(c => shown(c, true));   // (a subfolder turned off for this configurator: not here)
      const under = n => [n.id, ...kidsOf(n).flatMap(under)], inF = (p, ids) => (C.products[p.id] || []).some(c => ids.has(c));
      const find = (n, id) => n.id === id ? n : kidsOf(n).map(c => find(c, id)).find(Boolean) || null;
      const trail = id => { const go = (n, t) => n.id === id ? t : kidsOf(n).map(c => go(c, [...t, c])).find(Boolean) || null; return go(root, []); };
      const avail = S.list, others = avail.filter(p => !inF(p, new Set(under(root)))), cur = S.view && avail.find(p => p.id === S.view.product.id);
      const tile = p => `<button type="button" class="styletile cstyle${cur && p.id === cur.id ? ' on' : ''}" data-pick="${esc(p.id)}" aria-pressed="${!!(cur && p.id === cur.id)}"><span class="stylename">${esc(label(p))}</span></button>`;
      if (S.menuOpen == null) S.menuOpen = !S.view;
      if (!S.menuOpen && cur) {   // (a style chosen: where it's filed, its name, and Change style)
        const where = (S.menuPath || []).length && S.menuPath[0] !== '__other' ? S.menuPath.map(id => find(root, id)).filter(Boolean) : (C.products[cur.id] || []).map(trail).find(Boolean) || [];
        return `<section class="cmenu"><h2>${esc(heading)}</h2><div class="cchosen"><div><small>${(top ? where : [root, ...where]).map(n => esc(n.name)).join(' › ')}</small><strong>${esc(label(cur))}</strong></div><button type="button" class="cbtn" data-cchange>Change style</button></div>${note}</section>`;
      }
      const other = (S.menuPath || [])[0] === '__other', path = other ? [] : (S.menuPath || []).map(id => find(root, id)).filter(Boolean), here = other ? null : path[path.length - 1] || root;
      const crumbs = `<nav class="ccrumbs" aria-label="Categories">${path.length || other ? `<button type="button" data-cpath="-1">${esc(root.name)}</button>` : `<span>${esc(root.name)}</span>`}${other ? ' <i>›</i> <span>Other styles</span>' : path.map((n, i) => ` <i>›</i> ${i === path.length - 1 ? `<span>${esc(n.name)}</span>` : `<button type="button" data-cpath="${i}">${esc(n.name)}</button>`}`).join('')}</nav>`;
      const q = (S.styleQ || '').toLowerCase().trim(); let body;
      if (q) { const hit = avail.filter(p => p.name.toLowerCase().includes(q)); body = hit.length ? `<div class="styletiles textstyles">${hit.map(tile).join('')}</div>` : '<p class="note">No styles match.</p>'; }
      else if (!here) body = `<div class="styletiles textstyles">${others.map(tile).join('')}</div>`;
      else {
        const kids = kidsOf(here).map(n => [n, avail.filter(p => inF(p, new Set(under(n)))).length]).filter(([, k]) => k || staff), mine = avail.filter(p => (C.products[p.id] || []).includes(here.id));
        const fam = (id, name, k) => `<button type="button" class="cfam${k ? '' : ' empty'}" data-cfolder="${esc(id)}"><span class="cfam-ico" aria-hidden="true">${FAM_ICON}</span><span class="cfam-name">${esc(name)}</span><small>${k ? `${k} style${k === 1 ? '' : 's'}` : 'None yet'}</small></button>`;
        const fams = [...kids.map(([n, k]) => fam(n.id, n.name, k)), ...(here === root && others.length ? [fam('__other', 'Other styles', others.length)] : [])];
        body = (fams.length ? `<div class="cfams">${fams.join('')}</div>` : '') + (mine.length ? `${fams.length ? '<div class="stylegroup">Styles</div>' : ''}<div class="styletiles textstyles">${mine.map(tile).join('')}</div>` : '') || '<p class="note">No styles here yet.</p>';
      }
      return `<section class="cmenu"><h2>${esc(heading)}</h2>${crumbs}${S.list.length > 8 ? `<input type="search" data-styleq placeholder="Search all styles" value="${esc(S.styleQ || '')}" class="stylefind">` : ''}${body}${cur ? '<button type="button" class="cbtn ghost" data-cdone>Keep the current style</button>' : ''}${note}</section>`;
    }
    // while choices are missing: a drawing anyway, of what's chosen, with Keystone's display defaults for the rest (shown as
    // defaults, never counted as chosen): square edge and framing bead, a 1/4" panel, Paint Grade Superior Green, no finish
    const PREVIEW_DEFAULTS = { framing_bead: ['frame', 'SK'], lip: ['edge', 'SQUARE EDGE'], panel_style: ['panel', 'VENEERED MDF'], wood: ['species', 'paint-superior-green'], finish: ['finish', 'ks-no-finish'] };
    function previewJobOf() {
      S.previewDefaults = []; if (!S.view || !isDoor) return null;
      try {
        const j = jobFor(S.view, S.sel, [], lib, '').job; if (!j) return null;
        const has = key => { const it = items(S.view).find(i => i.key === key); return (S.sel[key] != null && S.sel[key] !== '') || !!(it && it.standard); };
        for (const [key, [field, v]] of Object.entries(PREVIEW_DEFAULTS)) { if (has(key) || (key === 'panel_style' && j.type && j.type !== 'panel')) continue; j[field] = v; S.previewDefaults.push(key); }
        return j;
      } catch { return null; }
    }
    // an option's control, scrolled to and highlighted (the preview's parts link to them)
    function focusOption(key) {
      const el = panel.querySelector(`[data-opt="${CSS.escape(key)}"],[data-attr="${CSS.escape(key)}"],[data-layout-picker="${CSS.escape(key)}"]`); if (!el) return false;
      const box = el.closest('.field') || el; box.scrollIntoView({ block: 'center', behavior: 'smooth' }); box.classList.remove('sql-flash'); void box.offsetWidth; box.classList.add('sql-flash');
      (el.matches('select,input') ? el : el.querySelector('select,input,button,summary'))?.focus({ preventScroll: true }); return true;
    }
    function draw() {
      const groupOf = p => isDoor ? catOf(p) : (p.product_type || '');
      const groups = new Map(isDoor ? CATS.map(c => [c, []]) : []); for (const p of S.list) { const g = groupOf(p); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
      for (const [g, ps] of [...groups]) if (!ps.length) groups.delete(g);
      // the category shown: the one picked, else the current style's (or every style when there are only a few)
      const curP = S.list.find(p => S.view && p.id === S.view.product.id);
      if (S.cat == null || (S.cat !== 'all' && !groups.has(S.cat))) S.cat = S.list.length <= 10 || groups.size < 2 ? 'all' : curP ? groupOf(curP) : [...groups.keys()][0];
      const pick = `<section><h2>${esc(heading)}</h2><label class="field wide">Style<select data-product>${[...groups].map(([g, ps]) => `${g && groups.size > 1 ? `<optgroup label="${esc(g)}">` : ''}${ps.map(p => `<option value="${esc(p.id)}"${S.view && p.id === S.view.product.id ? ' selected' : ''}>${esc(p.name)}${p.notOffered ? ' (not offered here yet)' : staff && p.lifecycle && p.lifecycle !== 'live' ? ' (not Live)' : ''}</option>`).join('')}${g && groups.size > 1 ? '</optgroup>' : ''}`).join('')}</select></label></section>`;
      const rails = () => {
        const fr = items(S.view).filter(i => i.kind === 'input' && i.frame).map(it => `<label class="field">${esc(it.label)}<input data-in="${esc(it.key)}" data-part="${esc(it.frame)}" value="${esc(S.inputs[it.key] ?? '')}" data-wkey="${esc(it.key)}" placeholder="${esc(partW(it.frame, it.key))}" inputmode="decimal"></label>`);
        for (const it of items(S.view).filter(i => i.kind === 'layout')) { const lay = it.options.find(o => o.id === (S.layouts[it.key] ?? it.standard)), sz = (S.lsizes[it.key] = S.lsizes[it.key] || {});
          for (const x of ((lay && lay.sizes) || []).filter(x => x.frame)) fr.push(`<label class="field">${esc(x.label)}<input data-lsize="${esc(it.key)}|${esc(x.name)}" data-part="${esc(x.frame)}" value="${esc(sz[x.name] ?? '')}" data-wkey="${esc(it.key)}.${esc(x.name)}" placeholder="${esc(partW(x.frame, `${it.key}.${x.name}`))}" inputmode="decimal"></label>`); }
        return fr.length ? `<div class="field wide railhead" style="grid-column:1/-1;margin-top:6px"><b>Rails and stiles</b> <span class="note" style="margin:0">Blank keeps the standard width.</span></div>${fr.join('')}` : '';
      };
      const secs = (S.view?.sections || []).map(s => { const body = s.items.filter(it => !(it.kind === 'input' && it.frame)).map(control).join('') + (s.key === 'size' ? rails() : ''); return body ? `<section><h2>${esc(s.name)}</h2><div class="grid">${body}${!forPlanner && s.key === 'size' ? `<label class="field">Quantity<input data-qty value="${esc(S.qty)}" inputmode="numeric"></label>` : ''}</div></section>` : ''; }).join('');
      const cur = S.list.find(p => S.view && p.id === S.view.product.id), note = cur && cur.notOffered ? `<p class="note">Not offered in the ${cfgName} yet: customers won’t see it here until it’s ticked Offered on its Setup tab, set Live and published.</p>` : S.error ? `<p class="note">${esc(S.error)}</p>` : '';
      // Doors and drawer fronts use text buttons; drawer boxes can retain their icons.
      const tiles = (isDoor || iconFor) ? (() => { const q = (S.styleQ || '').toLowerCase(), label = p => `${p.name}${p.notOffered ? ' (not offered here yet)' : staff && p.lifecycle && p.lifecycle !== 'live' ? ' (not Live)' : ''}`;
        const chips = groups.size > 1 ? `<div class="stylecats" role="group" aria-label="Categories">${[['all', 'All', S.list.length], ...[...groups].map(([g, ps]) => [g, g || 'Other', ps.length])].map(([k, l, n]) => `<button type="button" data-cat="${esc(k)}" aria-pressed="${!q && S.cat === k}">${esc(l)}<small>${n}</small></button>`).join('')}</div>` : '';
        const showAll = q || S.cat === 'all';
        return `<section><h2>${esc(heading)}</h2>${chips}${S.list.length > 12 ? `<input type="search" data-styleq placeholder="Find a style" value="${esc(S.styleQ || '')}" class="stylefind">` : ''}
          ${[...groups].filter(([g]) => showAll || g === S.cat).map(([g, ps]) => { const shown = ps.filter(p => !q || p.name.toLowerCase().includes(q)); return shown.length ? `${groups.size > 1 && g && showAll ? `<div class="stylegroup">${esc(g)}</div>` : ''}<div class="styletiles${isDoor ? ' textstyles' : ''}">${shown.map(p => `<button type="button" class="styletile${S.view && p.id === S.view.product.id ? ' on' : ''}" data-pick="${esc(p.id)}" title="${esc(label(p))}" aria-pressed="${S.view && p.id === S.view.product.id ? 'true' : 'false'}">${!isDoor && iconFor ? `<span class="styleicon">${iconFor(p, S.job, !!(S.view && p.id === S.view.product.id)) || ''}</span>` : ''}<span class="stylename">${esc(label(p))}</span></button>`).join('')}</div>` : ''; }).join('') || '<p class="note">No styles match.</p>'}</section>`; })() : null;
      const menu = isDoor ? catMenu(note, p => `${p.name}${p.notOffered ? ' (not offered here yet)' : staff && p.lifecycle && p.lifecycle !== 'live' ? ' (not Live)' : ''}`) : null;
      panel.innerHTML = (menu || (tiles ? tiles.replace(/<\/section>$/, `${note}</section>`) : pick.replace('</section>', `${note}</section>`))) + secs;
      // (the category menu: into a folder, back up the path, change or keep the style)
      panel.querySelectorAll('[data-cfolder]').forEach(b => b.onclick = () => { const id = b.dataset.cfolder; S.menuPath = id === '__other' ? ['__other'] : [...(S.menuPath || []).filter(x => x !== '__other'), id]; S.styleQ = ''; draw(); });
      panel.querySelectorAll('[data-cpath]').forEach(b => b.onclick = () => { const i = Number(b.dataset.cpath); S.menuPath = i < 0 ? [] : (S.menuPath || []).slice(0, i + 1); S.styleQ = ''; draw(); });
      const cChange = panel.querySelector('[data-cchange]'); if (cChange) cChange.onclick = () => { S.menuOpen = true; draw(); };
      const cDone = panel.querySelector('[data-cdone]'); if (cDone) cDone.onclick = () => { S.menuOpen = false; draw(); };
      if(typeof window!=='undefined'&&window.PanelLayoutPicker){
        S.layoutFilters ||= {};
        for(const root of panel.querySelectorAll('[data-layout-picker]')){
          const key=root.dataset.layoutPicker,it=items(S.view).find(i=>i.kind==='layout'&&i.key===key),selected=S.layouts[key]??it.standard,blocked=layoutBlocked(it),picker=window.PanelLayoutPicker;
          const state=S.layoutFilters[key] ||= picker.initialState(it.options,selected,blocked);
          if(!it.options.some(o=>picker.selectable(o)&&!blocked.has(o.id)&&picker.family(o)===state.family))Object.assign(state,picker.initialState(it.options,selected,blocked));
          picker.mount(root,{options:it.options,selected,blocked,state,onSelect:id=>{
            if(blocked.has(id)||!it.options.some(o=>o.id===id))return;
            read();if((S.layouts[key]??it.standard)!==id)S.lsizes[key]={};S.layouts[key]=id;
            draw();price();
            panel.querySelector(`[data-layout-picker="${CSS.escape(key)}"] .pl-chooser summary`)?.focus();
          }});
        }
      }
      if (tiles) { panel.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => load(b.dataset.pick));
        panel.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { S.cat = b.dataset.cat; S.styleQ = ''; draw(); });
        const sq = panel.querySelector('[data-styleq]'); if (sq) sq.oninput = debounce(() => { S.styleQ = sq.value; draw(); const n = panel.querySelector('[data-styleq]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 200); }
      else panel.querySelector('[data-product]').onchange = e => load(e.target.value);
      S.updateSummaries = markSections(panel);
      const go = debounce(() => { read(); price(); }, 250);
      panel.oninput = e => {
        if(e.target.matches('[data-pl-search],[data-pl-filter]'))return;
        // Retire an old price immediately, before the input debounce starts the next calculation.
        if (e.target.matches('[data-dim],[data-in],[data-opt],[data-layout],[data-lsize],[data-attr],[data-qty]')) { ++seq; S.price = null; }
        // a required size: red while it's blank, cleared as soon as something is typed
        if (e.target.matches('[data-in][required]')) e.target.closest('.field')?.classList.toggle('needs', !e.target.value.trim());
        if (!e.target.matches('[data-product]')) go(); };
      panel.onchange = e => { if (e.target.matches('[data-product],[data-pl-search],[data-pl-filter]')) return;
        if (e.target.matches('[data-attr]') && isFinishThickness(e.target.dataset.attr || '')) { read(); syncFinish(); draw(); price(); return; }
        if (e.target.matches('[data-opt="wood"]')) S.thickWarn = '';
        // a new choice can rule others out, or show or hide an attribute that depends on it
        read();
        if (e.target.dataset.opt === 'panel_style') {
          const p = items(S.view).find(i => i.key === 'panel_style')?.options.find(o => o.id === S.sel.panel_style);
          if (!p?.reveal?.adjustable) delete S.attrs.custom_raise_reveal;
        }
        syncFinish(); if (e.target.dataset.opt || e.target.dataset.layout || (e.target.dataset.attr && items(S.view).some(i => i.look && i.look.show_when && i.look.show_when.key === e.target.dataset.attr))) draw(); price(); };
    }
    function read() {
      panel.querySelectorAll('[data-dim]').forEach(e => { S.dims[e.dataset.dim] = e.value; });
      panel.querySelectorAll('[data-in]').forEach(e => { if (e.value.trim()) S.inputs[e.dataset.in] = e.value.trim(); else delete S.inputs[e.dataset.in]; });
      panel.querySelectorAll('[data-opt]').forEach(e => { if (e.value) S.sel[e.dataset.opt] = e.value; else if (e.dataset.opt === 'wood') S.sel.wood = ''; else delete S.sel[e.dataset.opt]; });
      panel.querySelectorAll('[data-layout]').forEach(e => { if (S.layouts[e.dataset.layout] !== e.value) S.lsizes[e.dataset.layout] = {}; S.layouts[e.dataset.layout] = e.value; });
      panel.querySelectorAll('[data-lsize]').forEach(e => { const [k, n] = e.dataset.lsize.split('|'); S.lsizes[k] = S.lsizes[k] || {}; const v = toIn(e.value); if (e.value.trim() && v != null) S.lsizes[k][n] = String(v); else delete S.lsizes[k][n]; });
      // numbers can be typed as fractions (1 1/8); they're sent as decimals
      panel.querySelectorAll('[data-attr]').forEach(e => { const raw = e.type === 'checkbox' ? (e.checked ? '1' : '0') : e.value, d = e.type !== 'checkbox' && e.tagName !== 'SELECT' && !('text' in e.dataset) && /\//.test(raw) ? toIn(raw) : null;
        S.attrs[e.dataset.attr] = d != null ? String(d) : raw; const o = e.parentElement.querySelector('output'); if (o) o.textContent = e.value; });
      const q = panel.querySelector('[data-qty]'); if (q) S.qty = q.value;
      S.updateSummaries?.();
    }
    async function price() {
      if ((S.loading && S.loading.phase !== 'price') || !S.view) return;
      const my = ++seq;
      const missing = isDoor ? pendingChoices(S, forPlanner, ruleOk) : [];
      if (missing.length) {
        S.pending = missing; S.price = null; S.job = null; S.approx = []; S.pictures = []; S.loading = null; S.previewJob = previewJobOf();
        emit(); onLoading(null); return;
      }
      S.pending = [];
      const id = S.view.product.id, dims = dimensionValues(S.view, S.dims), inputs = {};
      for (const [k, v] of Object.entries(S.inputs)) { const n = toIn(v); if (n != null) inputs[k] = String(n); }
      S.loading = { phase: 'price', product: id, name: S.view.product.name }; onLoading(S.loading);
      try {
        const r = await api('POST', url(id, 'price'), { dimensions: dims, quantity: S.qty, options: S.sel, attributes: S.attrs, inputs, layouts: S.layouts || {}, layout_sizes: S.lsizes || {}, ...(staff ? { office: true } : {}) });
        if (my !== seq) return;
        S.price = r;
        // the engine's answer for formula rules: redraw when an attribute appears or disappears
        { const sig = JSON.stringify(r.visible || {}); if (sig !== S.visSig) { const had = S.visSig != null; S.visSig = sig; if (had || Object.values(r.visible || {}).some(Boolean)) setTimeout(draw, 0); } }
        if (isDoor && r.status === 'needs_input') {
          S.pending = r.messages?.length ? r.messages : ['Required selections']; S.job = null; S.approx = []; S.pictures = []; S.previewJob = previewJobOf();
          S.loading = null; emit(); return;
        }
        panel.querySelectorAll('[data-part]').forEach(e => { e.placeholder = partW(e.dataset.part, e.dataset.wkey); });
        if (!isDoor) { S.job = null; if (iconFor) setTimeout(() => { const t = panel.querySelector('.styletile.on .styleicon'), p = S.list.find(x => S.view && x.id === S.view.product.id); if (t && p) t.innerHTML = iconFor(p, S.dims, true) || t.innerHTML; }, 0); }
        else try { const lay = items(S.view).find(i => i.kind === 'layout'), ln = lay ? (lay.options.find(o => o.id === (S.layouts[lay.key] ?? lay.standard)) || {}).name : ''; const j = jobFor(S.view, S.sel, r.parts || [], lib, ln, (lay && S.lsizes[lay.key]) || {}, toIn(S.dims.height) || 0, r.widths || null, S.attrs, S.inputs, S.layouts, S.qty);
          S.job = j.job; S.approx = j.approx; S.unmatched = j.unmatched; S.pictures = j.pictures; }
        catch (e) {
          // the drawing couldn't follow this change: draw what it can (the style without its parts) and say why, rather
          // than keep the last picture as if nothing had changed
          console.error('door drawing:', e);
          let fallback = null; try { fallback = jobFor(S.view, S.sel, [], lib, '').job; } catch (e2) { /* nothing to draw */ }
          S.job = fallback; S.approx = []; S.unmatched = []; S.pictures = []; S.price = { ...r, drawError: e.message }; }
        S.loading = null;
        try { emit(); } catch (e) { console.error(e); }
      } finally { if (my === seq) { S.loading = null; onLoading(null); } }
    }
    const state = () => ({ loading: S.loading || null, pending: S.pending || [], product: S.view ? S.view.product : null, list: S.list, view: S.view, category: S.cat, sel: { ...S.sel }, attrs: { ...S.attrs }, inputs: { ...S.inputs }, dims: { ...S.dims }, qty: S.qty, price: S.price, job: S.job, previewJob: S.job ? null : (S.previewJob || null), previewDefaults: S.job ? [] : (S.previewDefaults || []), approx: S.approx, unmatched: S.unmatched || [], pictures: S.pictures || [],
      saved: S.view ? { product: S.view.product.id, name: S.view.product.name, product_type: S.view.product.product_type, sel: { ...S.sel }, attrs: { ...S.attrs }, inputs: { ...S.inputs }, layouts: { ...(S.layouts || {}) }, layout_sizes: JSON.parse(JSON.stringify(S.lsizes||{})),
        // what was chosen, in words, for lists and orders
        names: Object.fromEntries([...(S.attrs.custom_raise_reveal ? [['custom_raise_reveal', { label: 'Modified raise reveal', value: S.attrs.custom_raise_reveal + ' in' }]] : []),...items(S.view).filter(i => i.kind === 'option' && S.sel[i.key]).map(i => [i.key, { label: i.label, value: (i.options.find(o => o.id === S.sel[i.key]) || {}).name || '' }]),
          ...items(S.view).filter(i => i.kind === 'layout').map(i => [i.key, { label: i.label, value: (i.options.find(o => o.id === (S.layouts[i.key] ?? i.standard)) || {}).name || '' }])]),
        price: S.price && S.price.status === 'priced' ? S.price.unit_price : null } : null });
    const emit = () => {
      let notice=panel.querySelector('[data-required-selections]');
      if (!notice && S.pending?.length) { notice=document.createElement('div'); notice.dataset.requiredSelections=''; notice.className='msg'; notice.setAttribute('role','status'); panel.prepend(notice); }
      if (notice) { notice.hidden=!S.pending?.length; notice.textContent=S.pending?.length?'Required selections: '+S.pending.join('; '):''; }
      onChange(state());
    };
    start();
    return { state, focus: focusOption, load: saved => { pendingSaved = saved; return load(saved.product); }, dims: (w, h) => { S.dims.width = String(w); S.dims.height = String(h); if (S.view) price(); } };
  }
  return { create, measuredRows, pendingChoices, previewPlaceholder, loadList, setPreviewLoading, dimensionValues, jobFor, toIn, frac, layoutRows, woodFits };
})();
if (typeof window !== 'undefined') window.SqlDoors = SqlDoors;
if (typeof module !== 'undefined' && module.exports) module.exports = SqlDoors;




