import { countSettings, layoutIdentity, COUNT_LAYOUTS } from './layout-variants.mjs';
import { REVEAL_GUIDE } from './raise-reveal.mjs';
export const DEFAULT_WOOD_POLICY = {
  default_thickness: .78,
  box_only_woods: ['Bee-Line Prefinished Maple','Arrow-Line Prefinished Maple'],
  stock_bands: [{key:'4/4',max:.78},{key:'5/4',max:1},{key:'6/4',max:1.25},{key:'8/4',max:1.75}]
};
export function woodPolicy(settings) { return settings?.get('wood-policy') || DEFAULT_WOOD_POLICY; }
/* the catalog's categories: folders and subfolders (as many levels as needed, up to 8), and the products in each. A
   product can be in several; a folder deleted takes its products' places in it with it. Each folder can say which
   configurators it shows in (show); a subfolder without its own follows the folder it's in. Folder ids are the admin's own
   ('c' and letters or digits), names up to 80 characters. */
// the configurators a folder can show in
export const SHOW_IN = ['door', 'drawer_front', 'drawer_box', 'planner'];
export function cleanCategories(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Supply the categories.');
  const ids = new Set(); let count = 0;
  const tree = (nodes, depth) => {
    if (!Array.isArray(nodes)) throw Error('A folder’s subfolders must be a list.');
    if (depth > 8) throw Error('Folders can go 8 levels deep at most.');
    return nodes.map(n => {
      if (!n || typeof n !== 'object') throw Error('Each folder needs a name.');
      const id = String(n.id || ''), name = String(n.name || '').replace(/\s+/g, ' ').trim();
      if (!/^c[a-z0-9]{1,24}$/.test(id)) throw Error('A folder’s id isn’t valid.');
      if (ids.has(id)) throw Error('Two folders have the same id.');
      if (!name) throw Error('Each folder needs a name.'); if (name.length > 80) throw Error(`“${name.slice(0, 30)}…” is longer than 80 characters.`);
      if (++count > 600) throw Error('There can be up to 600 folders.');
      // where it shows: the configurators it's in (none listed: the folder it's in decides)
      const show = Array.isArray(n.show) ? [...new Set(n.show.map(String))].filter(k => SHOW_IN.includes(k)) : null;
      ids.add(id); return { id, name, ...(show ? { show } : {}), children: tree(n.children || [], depth + 1) };
    });
  };
  const out = { tree: tree(value.tree || [], 1), products: {} };
  const products = value.products && typeof value.products === 'object' && !Array.isArray(value.products) ? value.products : {};
  if (Object.keys(products).length > 20000) throw Error('Too many products.');
  for (const [pid, cats] of Object.entries(products)) {
    if (!/^k?\d{1,12}$/.test(pid)) throw Error(`“${pid}” isn’t a product.`);
    const kept = [...new Set((Array.isArray(cats) ? cats : []).map(String))].filter(c => ids.has(c)).slice(0, 50);   // (folders since deleted: dropped)
    if (kept.length) out.products[pid] = kept;
  }
  return out;
}
export function validateControl(key, value) {
  if (key === 'categories') return cleanCategories(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Supply the settings object.');
  const num=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
  if(key==='wood-policy') {
    if(!num(value.default_thickness,.001,1.75)||!Array.isArray(value.box_only_woods)||value.box_only_woods.length>100||value.box_only_woods.some(x=>typeof x!=='string'||!x.trim()||x.length>100)) throw Error('Check the standard thickness and wood names.');
    if(!Array.isArray(value.stock_bands)||value.stock_bands.length!==4) throw Error('Enter all four stock bands.');
    let previous=0;
    for(const [i,b] of value.stock_bands.entries()) { if(b.key!==['4/4','5/4','6/4','8/4'][i]||!num(b.max,.001,1.75)||b.max<=previous)throw Error('Stock boundaries must increase and stay at or below 1.750 inches.');previous=b.max; }
    if(value.default_thickness>previous)throw Error('The standard thickness exceeds the stock range.');
    return {default_thickness:value.default_thickness,box_only_woods:value.box_only_woods.map(x=>x.trim()),stock_bands:value.stock_bands.map(b=>({key:b.key,max:b.max}))};
  }
  if(key==='reveal-guides') {
    const out={};
    for(const name of Object.keys(REVEAL_GUIDE)) {
      const g=value[name];if(!g||!num(g.standard,.125,10)||!num(g.suggested_min,.125,10)||!num(g.suggested_max,.125,10)||g.suggested_min>g.standard||g.standard>g.suggested_max||!num(g.min_flat,.125,5))throw Error('Check reveal limits for '+name+'.');
      out[name]={standard:g.standard,suggested_min:g.suggested_min,suggested_max:g.suggested_max,min_flat:g.min_flat,enabled:g.enabled!==false,use_source_standard:g.use_source_standard!==false};
    } return out;
  }
  if(key.startsWith('layout-counts:'))return countSettings(key.slice(14),value);
  if(/^layout:k?\d{1,12}(?:x[1-9]\d?y[1-9]\d?)?$/.test(key)) {
    if(typeof value.label!=='string'||!value.label.trim()||value.label.length>120||typeof value.group!=='string'||value.group.length>60)throw Error('Enter a layout name and group.');
    if(!Array.isArray(value.rows)||value.rows.length<1||value.rows.length>32)throw Error('A visual needs 1–32 rows.');
    const rows=value.rows.map(r=>{
      if(!['panel','frame','lite','mdf','louver'].includes(r.fill)||!Number.isInteger(r.n)||r.n<1||r.n>32||!num(r.weight,.1,100))throw Error('Check row fill, column count (1–32), and height weight.');
      return {fill:r.fill,n:r.n,weight:r.weight};
    });
    const identity=layoutIdentity(key.slice(7));
    if(identity?.across && (!COUNT_LAYOUTS[identity.source_id] || (!COUNT_LAYOUTS[identity.source_id].x && identity.across!==COUNT_LAYOUTS[identity.source_id].across) || (!COUNT_LAYOUTS[identity.source_id].y && identity.down!==COUNT_LAYOUTS[identity.source_id].down) || rows.length!==identity.down || rows.some(r=>r.n!==identity.across)))throw Error('A numbered layout must keep its bound row and column counts.');
    return {label:value.label.trim(),group:value.group.trim(),rows,adaptive:!!value.adaptive,variable_columns:!!value.variable_columns,reviewed:!!value.reviewed,notes:String(value.notes||'').slice(0,500)};
  }
  throw Error('Unknown catalog setting.');
}
