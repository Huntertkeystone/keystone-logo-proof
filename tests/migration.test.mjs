// The source import (snapshot, idempotency) and the migration rules: pending products can't be ordered, approvals need
// passing checks, changes send approved products back to review, history is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './d1-shim.mjs';
import { handleApi } from '../server/api.mjs';
import { importStatements, countQuery, finishStatement, classify, WORKSTREAMS } from '../tools/oe/importlib.mjs';

const KEY = 'k';
const tables = {
  design_type: [{ id: '5', name: 'Framed Door', import_eligible: true }, { id: '8', name: 'Multi Panel', import_eligible: true }, { id: '3', name: 'Door Special Instr', import_eligible: true }],
  design: [
    { id: '88', design_type_id: '5', name: 'SRP-10-MP', product_type: 'Framed Door', import_eligible: 'True' },
    { id: '89', design_type_id: '5', name: 'SRP-10-MP', product_type: 'Framed Door', import_eligible: 'True' },   // same name, different product
    { id: '474', design_type_id: '8', name: 'Raised Panel', product_type: 'Multi Panel', import_eligible: 'True' },
    { id: '700', design_type_id: '3', name: 'Add hinge boring', product_type: 'Door Special Instr', import_eligible: 'True' },
    { id: '999', design_type_id: '5', name: 'DO NOT USE old door', product_type: 'Framed Door', import_eligible: 'False' },
    { id: '998', design_type_id: '5', name: '-------- Hinges ---------', product_type: 'Framed Door', import_eligible: 'True' },   // a menu divider
  ],
  formulas: [{ id: '88:v:0', design_id: '88', name: 'cost', label: 'Door cost', category: 'Design Cost', is_cost: 't', discountable: 't', expression: 'wood.cost * sqft', import_eligible: 'True' }],
  part_formulas: [{ id: '88:p:0', design_id: '88', alias: 'opening', source_json: JSON.stringify({ defaultDesign: { reference: 'oe://Design/474' }, _designType: { reference: 'oe://DesignType/8' } }), import_eligible: 'True' }],
  attribute_type: [{ id: '5', name: 'Wood', alias: 'wood', import_eligible: true }, { id: '10', name: 'Panel Style', alias: 'panel_style', import_eligible: true }, { id: '2', name: 'Finish', alias: 'finish', import_eligible: true }],
  attribute_name: [{ id: '164', attribute_type_id: '5', name: 'Maple, Hard', rank: '1', import_eligible: 'True' }, { id: '165', attribute_type_id: '10', name: '1/4" Panel', rank: '1', import_eligible: 'True' },
    { id: '166', attribute_type_id: '10', name: 'Regular Raise (5/8")', rank: '2', import_eligible: 'True' },
    { id: '167', attribute_type_id: '5', name: 'Cherry', rank: '2', import_eligible: 'True' }, { id: '168', attribute_type_id: '5', name: 'Walnut', rank: '3', import_eligible: 'True' },
    { id: '169', attribute_type_id: '5', name: 'Alder', rank: '4', import_eligible: 'True' },
    { id: '301', attribute_type_id: '2', name: 'Cafe (M)', rank: '1', import_eligible: 'True' }, { id: '302', attribute_type_id: '2', name: 'Antique Navy (D)', rank: '2', import_eligible: 'True' },
    { id: '303', attribute_type_id: '2', name: 'Harvest Glaze (L)', rank: '3', import_eligible: 'True' }],
  // what Framed Door offers (the SQL's map): Maple shown, Cherry office only, Walnut under "more"; Alder has values but isn't offered
  design_type_attribute_map: [{ id: '1', design_type_attribute_id: '7', attribute_name_id: '164', web_status: '1', import_eligible: true }, { id: '2', design_type_attribute_id: '7', attribute_name_id: '167', web_status: '0', import_eligible: true },
    { id: '3', design_type_attribute_id: '7', attribute_name_id: '168', web_status: '2', import_eligible: true }],
  design_type_attribute: [{ id: '7', design_type_id: '5', attribute_type_id: '5', import_eligible: true }],
  attribute_value_alias: [{ id: '44', design_type_attribute_id: '7', name: 'Cost', alias: 'cost', import_eligible: true }, { id: '45', design_type_attribute_id: '7', name: 'Thickness', alias: 'thickness', import_eligible: true }],
  attribute_value: [{ id: '900', attribute_name_id: '164', attribute_value_alias_id: '44', value: '12.50', import_eligible: 'True' }, { id: '901', attribute_name_id: '167', attribute_value_alias_id: '44', value: '15.00', import_eligible: 'True' },
    { id: '902', attribute_name_id: '168', attribute_value_alias_id: '44', value: '19.00', import_eligible: 'True' }, { id: '903', attribute_name_id: '169', attribute_value_alias_id: '44', value: '9.00', import_eligible: 'True' }],
  // each side of a conflict is one option or one design; a conflict has no direction
  conflict: [{ id: '1', attr1_id: '164', design1_id: null, attr2_id: '165', design2_id: null, import_eligible: 'True' },
    { id: '2', attr1_id: null, design1_id: '89', attr2_id: '164', design2_id: null, import_eligible: 'True' },
    { id: '3', attr1_id: null, design1_id: '999', attr2_id: '164', design2_id: null, import_eligible: 'False' }],
};
const snapshot = { id: 'oe-test', source_sha256: 'abc', package_version: 't', counts: Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length])) };
async function setup() {
  const DB = makeD1();
  for (const sql of importStatements(snapshot, tables, { workstreams: WORKSTREAMS })) DB.raw.exec(sql);
  const f = finishStatement(snapshot.id, snapshot.counts, DB.raw.prepare(countQuery(snapshot.id)).all()); DB.raw.exec(f.sql);
  const env = { DB, ALLOW_DEV_EMPLOYEE: 'true', EMPLOYEE_DEV_KEY: KEY };
  const call = async (method, path, body, emp = true) => { const r = await handleApi(new Request('https://t' + path, { method, headers: { 'content-type': 'application/json', origin: 'https://t', ...(emp ? { 'x-employee-dev-key': KEY } : {}) }, body: body ? JSON.stringify(body) : undefined }), env); return { status: r.status, data: await r.json() }; };
  return { DB, call, ok: f.ok };
}
const allPass = { source_integrity: { status: 'pass' }, classification: { status: 'pass' }, options_defaults: { status: 'pass' }, conflicts: { status: 'pass' }, pricing: { status: 'pass', evidence: 'matched 5 orders' }, sizing: { status: 'pass' }, visualization: { status: 'na', reason: 'no drawing for this design yet' } };

// Synthetic approval evidence belongs only to this test fixture, never to the source pilot.
async function reviewed(call) {
  await call('PUT', '/api/admin/migration/products/88', { checks: allPass, classification: 'sellable', classification_confirmed: true });
  const r = await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'approved', approved_release: 'test-fixture', approval_evidence: 'synthetic test fixture only' });
  assert.equal(r.status, 200);
}

test('import: every row kept, counts checked, a second run adds nothing, lifecycles survive', async () => {
  const { DB, call, ok } = await setup();
  assert.ok(ok);
  const total = Object.values(tables).reduce((n, t) => n + t.length, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM oe_records").get().n, total, 'excluded rows are kept in the snapshot too');
  await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'needs_review' });
  for (const sql of importStatements(snapshot, tables, { workstreams: WORKSTREAMS })) DB.raw.exec(sql);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM oe_records").get().n, total);
  assert.equal(DB.raw.prepare("SELECT lifecycle FROM oe_products WHERE design_id = '88'").get().lifecycle, 'needs_review', 're-import doesn’t reset a product’s review');
});

test('special instructions (“Special Instr” and “Spec Instr” types) aren’t tracked as products: they become configurator selections', () => {
  const t = { design_type: [{ id: '21', name: 'Shelf/Valance/Fluted Column Spec Instr', import_eligible: true }, { id: '3', name: 'Door Special Instr', import_eligible: true }],
    design: [{ id: '1', design_type_id: '21', name: 'Add a groove', import_eligible: 'True' }, { id: '2', design_type_id: '3', name: 'Shop Only Note', import_eligible: 'True' }] };
  assert.deepEqual(classify(t), []);
});
test('classification: sellable, component, special instruction; duplicate names stay separate products', () => {
  const c = Object.fromEntries(classify(tables).map(p => [p.design_id, p.classification]));
  assert.deepEqual(c, { 88: 'sellable', 89: 'sellable', 474: 'component' });
  assert.ok(!('999' in c), 'DO NOT USE designs aren’t tracked as products');
});

test('pending products are never in the customer catalog or orderable; employee review stays open', async () => {
  const { call } = await setup();
  assert.deepEqual((await call('GET', '/api/catalog/products', null, false)).data.products, []);
  assert.equal((await call('GET', '/api/catalog/products/88', null, false)).status, 404);
  assert.equal((await call('GET', '/api/admin/migration/products/88', null, false)).status, 401, 'review needs employee sign-in');
  const p = (await call('GET', '/api/admin/migration/products/88')).data.product;
  assert.equal(p.lifecycle, 'imported'); assert.equal(p.source_counts.formulas, 1);
});

test('approval needs every check passed (or not applicable with a reason), a confirmed classification and evidence; Live is a separate step', async () => {
  const { call } = await setup();
  assert.match((await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'approved', approved_release: 'r1', approval_evidence: 'x' })).data.error, /checks haven’t passed/);
  assert.match((await call('PUT', '/api/admin/migration/products/88', { checks: { visualization: { status: 'na' } } })).data.error, /needs a reason/);
  await call('PUT', '/api/admin/migration/products/88', { checks: allPass });
  assert.match((await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'approved', approved_release: 'r1', approval_evidence: 'x' })).data.error, /confirm the classification/);
  await call('PUT', '/api/admin/migration/products/88', { classification: 'sellable', classification_confirmed: true });
  const ap = await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'approved', approved_release: 'oe-test/r1', approval_evidence: 'priced 5 real orders identically' });
  assert.equal(ap.data.product.lifecycle, 'approved'); assert.equal(ap.data.product.approved_by, 'dev-employee@local');
  assert.deepEqual((await call('GET', '/api/catalog/products', null, false)).data.products, [], 'approved isn’t Live');
  await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'live' });
  assert.equal((await call('GET', '/api/catalog/products', null, false)).data.products.length, 1);
  assert.equal((await call('GET', '/api/catalog/products/88', null, false)).status, 200);
  // a check that stops passing sends it back to review and out of the catalog
  const back = await call('PUT', '/api/admin/migration/products/88', { checks: { pricing: { status: 'fail', evidence: 'order 1234 differs by $2' } } });
  assert.equal(back.data.product.lifecycle, 'needs_review');
  assert.deepEqual((await call('GET', '/api/catalog/products', null, false)).data.products, []);
  const hist = (await call('GET', '/api/admin/migration/products/88')).data.product.history;
  assert.ok(hist.length >= 5 && hist.some(h => /→ live/.test(h.action)) && hist.some(h => /needs_review/.test(h.action)), 'every change is in the history');
  // components can be approved but never published Live
  await call('PUT', '/api/admin/migration/products/474', { checks: allPass, classification: 'component', classification_confirmed: true });
  await call('PUT', '/api/admin/migration/products/474', { lifecycle: 'approved', approved_release: 'r', approval_evidence: 'e' });
  assert.match((await call('PUT', '/api/admin/migration/products/474', { lifecycle: 'live' })).data.error, /Only sellable/);
});

test('summary: totals by family, classification and lifecycle; workstreams seeded', async () => {
  const { call } = await setup();
  const s = (await call('GET', '/api/admin/migration/summary')).data;
  assert.equal(s.snapshots[0].status, 'complete');
  assert.equal(s.groups.reduce((n, g) => n + g.n, 0), 3);
  assert.ok(s.workstreams.some(w => w.id === 'doors') && s.workstreams.some(w => w.id === 'odoo_adapter'));
  assert.equal(s.checks.source_integrity.pass, 3);
});

test('conflict map: both directions, drafts for adds and removes, the source untouched', async () => {
  const { call, DB } = await setup();
  const of = async k => (await call('GET', `/api/admin/conflicts/of?item=${k}`)).data;
  const maple = await of('a164');
  assert.deepEqual(maple.conflicts.map(c => [c.key, c.state]).sort(), [['a165', 'source'], ['d89', 'source']], 'a design-option conflict shows from the option side too');
  assert.deepEqual((await of('a165')).conflicts.map(c => c.key), ['a164'], 'and from the other option');
  assert.equal((await call('GET', '/api/admin/conflicts/items?kind=a&type=10')).data.items.length, 2);
  // add one, remove one: both are drafts
  assert.equal((await call('POST', '/api/admin/conflicts/changes', { item: 'a164', add: ['a166'], remove: ['a165'] })).data.changes, 2);
  const after = Object.fromEntries((await of('a164')).conflicts.map(c => [c.key, c.state]));
  assert.deepEqual(after, { a165: 'removed', a166: 'added', d89: 'source' });
  assert.equal((await of('a166')).conflicts[0].key, 'a164', 'a draft conflict shows from both sides');
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM oe_records WHERE source_table = 'conflict'").get().n, 3, 'the imported source never changes');
  // undoing: re-adding a removed one cancels the removal; removing a draft add drops it
  await call('POST', '/api/admin/conflicts/changes', { item: 'a165', add: ['a164'] });
  await call('POST', '/api/admin/conflicts/changes', { item: 'a164', remove: ['a166'] });
  assert.deepEqual((await call('GET', '/api/admin/conflicts/changes')).data.changes, []);
  assert.equal((await call('POST', '/api/admin/conflicts/changes', { item: 'a164', add: ['a999'] })).status, 400, 'only items in the source catalog');
  assert.equal((await call('GET', '/api/admin/conflicts/of?item=a164', null, false)).status, 401, 'employees only');
});

test('options: every value an option holds per product type, drafts for edits, the source untouched', async () => {
  const { call, DB } = await setup();
  const o = (await call('GET', '/api/admin/options/164')).data;
  assert.equal(o.option.name, 'Maple, Hard'); assert.equal(o.option.type, 'Wood');
  assert.deepEqual(o.fields.map(f => [f.product_type, f.name, f.alias, f.value]), [['Framed Door', 'Cost', 'wood.cost', '12.50'], ['Framed Door', 'Thickness', 'wood.thickness', null]], 'a field with no value shows as not set');
  assert.equal((await call('PUT', '/api/admin/options/164/values', { field: '44', value: '13.25' })).data.ok, true);
  assert.equal((await call('PUT', '/api/admin/options/164/values', { field: '45', value: 'x * <oops>' })).status, 400, 'a value has to read as a formula');
  assert.equal((await call('PUT', '/api/admin/options/165/values', { field: '44', value: '1' })).status, 400, 'a field of another attribute is refused');
  const after = (await call('GET', '/api/admin/options/164')).data.fields[0];
  assert.deepEqual([after.value, after.draft.value], ['12.50', '13.25'], 'the source value stays until published; the draft sits beside it');
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.values, 1);
  assert.equal(JSON.parse(DB.raw.prepare("SELECT data_json FROM oe_records WHERE source_table = 'attribute_value'").get().data_json).value, '12.50');
  await call('PUT', '/api/admin/options/164/values', { field: '44', revert: true });
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.values, 0);
});

test('DO NOT USE, discontinued and divider items stay out of the admin lists and the catalog (still in the snapshot)', async () => {
  const { call, DB } = await setup();
  assert.ok(!classify(tables).some(p => p.design_id === '998'), 'a divider isn’t tracked as a product');
  // a divider tracked by an older import is still hidden
  DB.raw.exec("INSERT INTO oe_products (design_id, snapshot_id, name, product_type, family, classification, classification_basis, checks_json, updated_at) VALUES ('997', 'oe-test', '------', 'Framed Door', 'doors', 'sellable', 'x', '{}', 'now')");
  const list = (await call('GET', '/api/admin/migration/products?limit=50')).data.rows.map(r => r.name);
  assert.ok(!list.includes('------') && !list.includes('-------- Hinges ---------'));
  assert.ok(!(await call('GET', '/api/admin/conflicts/items?kind=d&type=5')).data.items.some(i => /DO NOT USE|^---/.test(i.name)));
  assert.deepEqual((await call('GET', '/api/admin/conflicts/of?item=a164')).data.conflicts.map(c => c.key).sort(), ['a165', 'd89'], 'the DO NOT USE door’s conflict isn’t listed');
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM oe_records WHERE source_table = 'design'").get().n, 6, 'the imported source keeps every row');
});

test('removing products: hidden everywhere with a reason in the history, Live and approved ones refused, Restore undoes it', async () => {
  const { call, DB } = await setup();
  const r = (await call('POST', '/api/admin/migration/products/remove', { ids: ['89', '474'], reason: 'test design' })).data;
  assert.deepEqual(r.removed.sort(), ['474', '89']);
  const names = async q => (await call('GET', `/api/admin/migration/products?limit=50${q || ''}`)).data.rows.map(x => x.design_id).sort();
  assert.deepEqual(await names(), ['88']);
  assert.deepEqual(await names('&lifecycle=removed'), ['474', '89']);
  assert.equal((await call('GET', '/api/admin/migration/summary')).data.groups.reduce((n, g) => n + g.n, 0), 1, 'not counted');
  assert.ok(!(await call('GET', '/api/admin/conflicts/items?kind=d&type=5')).data.items.some(i => i.id === '89'), 'not offered in the conflict lists');
  const p = (await call('GET', '/api/admin/migration/products/89')).data.product;
  assert.equal(p.removed_reason, 'test design'); assert.match(p.history[0].action, /removed from the catalog: test design/);
  assert.equal((await call('POST', '/api/admin/migration/products/remove', { ids: ['88'] })).status, 400, 'a reason is required');
  // a Live product can't be removed (it's retired instead)
  DB.raw.exec("UPDATE oe_products SET lifecycle = 'live' WHERE design_id = '88'");
  assert.deepEqual((await call('POST', '/api/admin/migration/products/remove', { ids: ['88'], reason: 'x' })).data.blocked.map(b => b.id), ['88']);
  assert.equal((await call('GET', '/api/catalog/products', null, false)).data.products.length, 1);
  assert.equal(JSON.parse(DB.raw.prepare("SELECT data_json FROM oe_records WHERE source_table = 'design' AND source_id = '89'").get().data_json).name, 'SRP-10-MP', 'the imported source is untouched');
  assert.equal((await call('POST', '/api/admin/migration/products/89/restore', {})).data.ok, true);
  assert.deepEqual(await names('&lifecycle=removed'), ['474']);
  assert.match((await call('GET', '/api/admin/migration/products/89')).data.product.history[0].action, /restored/);
});

test('remove all matching: every product a filter matches, never the whole catalog, and only if the count still agrees', async () => {
  const { call } = await setup();
  assert.equal((await call('POST', '/api/admin/migration/products/remove', { all_matching: {}, reason: 'x' })).status, 400, 'an unfiltered “remove everything” is refused');
  assert.equal((await call('POST', '/api/admin/migration/products/remove', { all_matching: { classification: 'component', group: 'layouts' }, expect: 5, reason: 'x' })).status, 409, 'a stale count is refused');
  const r = (await call('POST', '/api/admin/migration/products/remove', { all_matching: { classification: 'component', group: 'layouts' }, expect: 1, reason: 'Not sold on its own' })).data;
  assert.deepEqual(r.removed, ['474']);
  assert.deepEqual((await call('GET', '/api/admin/migration/products?limit=50')).data.rows.map(x => x.design_id).sort(), ['88', '89']);
  const types = (await call('GET', '/api/admin/conflicts/meta')).data.design_types.map(t => t.id);
  assert.ok(!types.includes('8') && !types.includes('3'), 'product types with nothing left (and special-instruction types) aren’t offered in Conflicts');
});

test('formulas: an edit is saved as a draft in the modern form, previews before saving, applies to calculations, and undoes', async () => {
  const { call, DB } = await setup();
  DB.raw.exec(`UPDATE oe_records SET data_json = json_set(data_json, '$.is_cost', 't', '$.category', 'Design Cost', '$.discountable', 't', '$.label', 'Door cost') WHERE source_table = 'formulas'`);
  const calc = async extra => (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' }, ...extra })).data;
  const base = await calc();
  assert.equal(base.price.status, 'unavailable', 'the source formula needs sqft, which this test product lacks');
  const pv = await calc({ preview: { target: 'v:cost', text: 'if wood.cost > 10 then wood.cost * 2 else 0' } });
  assert.equal(pv.price.unit_cost, '25.00', 'the preview applies the edit (12.50 × 2) without saving it');
  assert.equal((await calc({ preview: { target: 'v:cost', text: 'if wood.cost > 10 then 1' } })).formula_error, true);
  assert.equal((await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'if x then' })).status, 400, 'a formula that doesn’t read isn’t saved');
  assert.equal((await call('PUT', '/api/admin/products/88/formulas', { target: 'v:nope', text: '1' })).status, 404);
  const saved = (await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost * 2' })).data;
  assert.equal(saved.drafts[0].after, 'wood.cost * 2'); assert.equal(saved.drafts[0].before, 'wood.cost * sqft');
  assert.equal((await calc()).price.unit_cost, '25.00', 'saved edits apply to calculations');
  assert.equal((await calc({ drafts: false })).price.status, 'unavailable', 'and can be left out');
  assert.equal(JSON.parse(DB.raw.prepare("SELECT data_json FROM oe_records WHERE source_table = 'formulas'").get().data_json).expression, 'wood.cost * sqft', 'the source formula is untouched');
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.formulas, 1);
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', revert: true });
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.formulas, 0);
  assert.ok((await call('GET', '/api/admin/migration/products/88')).data.product.history.some(h => /formula edited/.test(h.action)));
});

test('shared variables: defined once, used by products that don’t define them; a product can give up its own copy', async () => {
  const { call } = await setup();
  const calc = async () => (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' } })).data;
  assert.equal((await call('PUT', '/api/admin/variables', { scope: 'type', design_type_id: '5', name: 'Bad Name', formula: '1' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/variables', { scope: 'type', design_type_id: '5', name: 'sqft', formula: 'if x then' })).status, 400, 'the formula has to read');
  const sv = (await call('PUT', '/api/admin/variables', { scope: 'type', design_type_id: '5', name: 'sqft', label: 'Square feet', formula: '2' })).data;
  assert.ok(sv.id);
  // the test door's cost is wood.cost * sqft and it never defined sqft: the shared one fills in
  {
    const r = await calc(); assert.equal(r.price.status, 'priced', JSON.stringify(r.price.errors)); assert.equal(r.price.unit_cost, '25.00', '12.50 × 2');
  }
  const p = (await call('GET', '/api/admin/products/88')).data;
  assert.deepEqual(p.shared.map(x => [x.name, x.overridden]), [['sqft', false]]);
  // a company-wide cost line applies to every product that doesn't define it
  await call('PUT', '/api/admin/variables', { scope: 'company', name: 'handling', label: 'Handling', category: 'Option Cost', is_cost: true, formula: '5' });
  assert.equal((await calc()).price.unit_cost, '30.00');
  // the product defines "cost" itself; giving it up means a shared "cost" must exist
  assert.equal((await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', use_shared: true })).status, 400);
  await call('PUT', '/api/admin/variables', { scope: 'type', design_type_id: '5', name: 'cost', label: 'Door cost', category: 'Design Cost', is_cost: true, formula: 'wood.cost * 3' });
  assert.equal((await calc()).price.unit_cost, '30.00', 'the product’s own cost still wins');
  assert.equal((await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', use_shared: true })).data.ok, true);
  assert.equal((await calc()).price.unit_cost, '42.50', 'now the shared cost (37.50) plus handling (5)');
  const usage = (await call('GET', '/api/admin/variables/usage?name=sqft')).data;
  assert.ok(usage.users.some(u => u.id === '88' && u.uses), 'who uses it');
  assert.equal((await call('GET', '/api/admin/variables/usage?name=sqft', null, false)).status, 401);
});

test('new products: copied from an existing one, tracked, calculating like any other', async () => {
  const { call } = await setup();
  assert.equal((await call('POST', '/api/admin/products/new', { design_type_id: '5', name: 'DO NOT USE test' })).status, 400);
  const r = (await call('POST', '/api/admin/products/new', { design_type_id: '5', name: 'SRP-10 Narrow', based_on: '88' })).data;
  assert.match(r.id, /^k\d+$/);
  const p = (await call('GET', `/api/admin/products/${r.id}`)).data;
  assert.equal(p.design.name, 'SRP-10 Narrow'); assert.equal(p.variables[0].name, 'cost'); assert.equal(p.custom.based_on, '88');
  const list = (await call('GET', '/api/admin/migration/products?q=Narrow')).data.rows;
  assert.equal(list[0].design_id, r.id); assert.equal(list[0].classification, 'sellable');
  await call('PUT', '/api/admin/variables', { scope: 'type', design_type_id: '5', name: 'sqft', formula: '2' });
  assert.equal((await call('POST', `/api/admin/products/${r.id}/calc`, { dims: {}, qty: '1', selections: { wood: '164' } })).data.price.unit_cost, '25.00');
  assert.equal((await call('PUT', `/api/admin/products/${r.id}/formulas`, { target: 'v:cost', text: 'wood.cost * sqft * 2' })).data.ok, true, 'its formulas can be edited like any product’s');
});

test('the catalog feed for configurators: Live products only, options by name, exposed inputs, and a price', async () => {
  const { call } = await setup();
  assert.equal((await call('GET', '/api/catalog/products/88/config', null, false)).status, 404, 'not Live yet');
  await call('PUT', '/api/admin/migration/products/88', { checks: allPass, classification: 'sellable', classification_confirmed: true });
  await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'approved', approved_release: 'r', approval_evidence: 'e' });
  await call('PUT', '/api/admin/migration/products/88', { lifecycle: 'live' });
  await call('PUT', '/api/admin/variables', { scope: 'type', design_type_id: '5', name: 'sqft', formula: '2' });
  await call('PUT', '/api/admin/products/88/inputs', { inputs: [{ key: 'stile', label: 'Stile width', control: 'number', min: '1.5', max: '8', step: '0.0625', variables: ['cost'], shown: true, show_door: true, show_planner: true }] });
  assert.deepEqual((await call('GET', '/api/catalog/products/88/config', null, false)).data.configurators, [], 'not in any configurator yet');
  assert.equal((await call('GET', '/api/catalog/products/88/config?configurator=door', null, false)).status, 404);
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  await call('POST', '/api/admin/publish', {});
  const cfg = (await call('GET', '/api/catalog/products/88/config?configurator=door', null, false)).data;
  assert.equal(cfg.product.name, 'SRP-10-MP');
  const items = cfg.sections.flatMap(sct => sct.items.map(i => [sct.key, i.kind, i.key]));
  assert.deepEqual(items, [['size', 'input', 'stile'], ['wood', 'option', 'wood'], ['details','attribute','panel_grain']], 'placed by default: customer sizes under Size, wood with Wood and finish');
  assert.deepEqual(cfg.sections.find(x => x.key === 'wood').items[0].options.map(o => o.name), ['Maple, Hard', 'Walnut'], 'what the door type offers on the web (Cherry is office only)');
  assert.ok(!JSON.stringify(cfg).includes('wood.cost') && !JSON.stringify(cfg).includes('variables'), 'no formulas or variable names go out');
  const price = (await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: { wood: '164' } }, false)).data;
  assert.deepEqual([price.status, price.unit_price], ['priced', '25.00']);
  assert.equal((await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: { wood: '164' }, inputs: { stile: '12' } }, false)).status, 400, 'a value outside the exposed limits is refused');
  const none = (await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: {} }, false)).data;
  assert.equal(none.status, 'needs_keystone'); assert.deepEqual(none.messages, ['Choose a wood']);
});

test('values over formulas: every name a product’s formulas mention comes back valued, or with why it can’t be worked out', async () => {
  const { call } = await setup();
  const r = (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' } })).data;
  assert.deepEqual(r.probes['wood.cost'], { value: '12.50', number: true });
  assert.match(r.probes.sqft.error, /sqft/, 'a name that isn’t defined says so');
  const { namesIn } = await import('../server/engine/oe/design.mjs');
  assert.deepEqual(namesIn('if a > 2 then round_up(b.c, 2) else "d e" # f g'), ['a', 'b.c'], 'keywords, function calls, text and notes are skipped');
});

test('configurator attributes: defined by name, used in formulas, checked against their control, sent to configurators', async () => {
  const { call } = await setup();
  const put = a => call('PUT', '/api/admin/attributes', a);
  assert.equal((await put({ scope: 'product', design_id: '88', name: 'Bad', label: 'x', control: 'integer' })).status, 400);
  assert.equal((await put({ scope: 'product', design_id: '88', name: 'width', label: 'x', control: 'integer' })).status, 400, 'reserved words refused');
  assert.equal((await put({ scope: 'product', design_id: '88', name: 'reach', label: 'Reach', control: 'slider' })).status, 400, 'a slider needs limits');
  assert.equal((await put({ scope: 'product', design_id: '88', name: 'style', label: 'Style', control: 'dropdown', choices: [] })).status, 400);
  assert.ok((await put({ scope: 'product', design_id: '88', name: 'hinge_count', label: 'Hinges', control: 'integer', min: '0', max: '6', default: '2' })).data.id);
  assert.ok((await put({ scope: 'type', design_type_id: '5', name: 'edge_style', label: 'Edge style', control: 'dropdown', choices: [{ label: 'Square', value: '0' }, { label: 'Eased', value: '1.5' }], default: '0' })).data.id);
  assert.ok((await put({ scope: 'company', name: 'rush', label: 'Rush order', control: 'toggle', default: '0' })).data.id);
  assert.equal((await put({ scope: 'company', name: 'rush', label: 'Again', control: 'toggle' })).status, 400, 'no second attribute of the same name in the same place');
  const ed = await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost + hinge_count * 3 + edge_style + (if rush then 10 else 0)' });
  assert.equal(ed.data.ok, true, ed.data.error);
  const calc = async attributes => (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' }, attributes })).data;
  let r = await calc({});
  assert.equal(r.price.unit_cost, '18.50', 'defaults: 12.50 + 2 × 3 + 0 + 0');
  assert.deepEqual(r.probes.hinge_count, { value: '2', number: true });
  r = await calc({ hinge_count: '4', edge_style: '1.5', rush: true });
  assert.equal(r.price.unit_cost, '36.00', '12.50 + 12 + 1.50 + 10');
  r = await calc({ hinge_count: '9' });
  assert.deepEqual(r.attribute_errors, ['Hinges: at most 6']);
  const p = (await call('GET', '/api/admin/products/88')).data;
  assert.deepEqual(p.config_attributes.map(a => [a.name, a.scope]).sort(), [['edge_style', 'type'], ['hinge_count', 'product'], ['rush', 'company']]);
  assert.deepEqual(p.config_attributes.find(a => a.name === 'edge_style').choices.map(c => c.label), ['Square', 'Eased']);
  assert.equal(p.attributes[0].alias, 'wood', 'the option lists are still there for the test panel');
  assert.ok(p.attributes[0].fields, 'with each option’s fields for the builder');
});

test('configurators: link a product, place its choices, preview what customers see, and see every product a configurator shows', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/attributes', { scope: 'product', design_id: '88', name: 'hinge_count', label: 'Hinges', control: 'integer', min: '0', max: '6', default: '2' });
  await call('PUT', '/api/admin/attributes', { scope: 'company', name: 'rush', label: 'Rush order', control: 'toggle', default: '0' });
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost + hinge_count * 3' });
  const setup0 = (await call('GET', '/api/admin/products/88/configurators')).data;
  assert.deepEqual(setup0.configurators.map(c => c.key), ['door', 'planner'], 'a door belongs in the door configurator and the planner, not the drawer box one');
  assert.equal(setup0.family, 'doors');
  assert.ok(setup0.links.every(l => !l.enabled), 'nothing linked yet');
  assert.deepEqual(setup0.items.map(i => [i.kind, i.key, i.used ?? null]), [['option', 'wood', null], ['attribute', 'hinge_count', true], ['attribute', 'rush', false], ['attribute','panel_grain',true]]);
  // the preview works before linking (it says so), and lists what can't show
  let pv = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data;
  assert.equal(pv.linked, false);
  assert.deepEqual(pv.not_shown.map(x => [x.key, x.why]), [['rush', 'Set for every product, but this product’s formulas don’t use it']], 'a company-wide choice this product doesn’t read stays out');
  // place hinge_count under Style, first; hide rush
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [{ kind: 'attribute', key: 'hinge_count', section: 'style', rank: 0 }, { kind: 'attribute', key: 'rush', section: 'details', hidden: true }, { kind: 'attribute', key: 'nope', section: 'style' }] });
  pv = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data;
  assert.equal(pv.linked, true);
  assert.deepEqual(pv.sections.map(x => [x.key, x.items.map(i => i.key)]), [['style', ['hinge_count']], ['wood', ['wood']], ['details',['panel_grain']]]);
  assert.deepEqual(pv.not_shown.map(x => x.why), ['Hidden: every order uses its default, 0']);
  const price = (await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: { wood: '164' }, attributes: { hinge_count: '3' } })).data;
  assert.deepEqual([price.status, price.unit_price], ['priced', '21.50']);
  const page = (await call('GET', '/api/admin/configurators/door')).data;
  assert.deepEqual(page.products.map(p => p.name), ['SRP-10-MP']);
  assert.deepEqual(page.attributes.map(a => [a.name, a.hidden_in]).sort(), [['hinge_count', 0], ['rush', 1]]);
  // unlinking takes it out of the configurator
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: false, layout: [] });
  assert.deepEqual((await call('GET', '/api/admin/configurators/door')).data.products, []);
});

test('standard selections and offered options follow the SQL: each door type’s map and each design’s standard choice', async () => {
  const { call, DB } = await setup();
  // SRP-10-MP's standard wood is Cherry (office only on the web)
  DB.raw.exec(`INSERT INTO oe_records (snapshot_id, source_table, source_id, design_id, ref1, ref2, data_json, eligible) VALUES ('oe-test', 'default_attribute', '50', '88', '88', '167', '${JSON.stringify({ id: '50', design_id: '88', attribute_name_id: '167' })}', 1)`);
  const p = (await call('GET', '/api/admin/products/88')).data, wood = p.attributes.find(a => a.alias === 'wood');
  assert.deepEqual(wood.options.map(o => [o.name, o.web, o.standard]), [['Maple, Hard', 1, false], ['Cherry', 0, true], ['Walnut', 2, false]], 'the map’s options only (no Alder), office-only marked, standard flagged');
  assert.equal(p.defaults.wood, '167', 'the product starts on its standard selection');
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  let pv = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data, opt = pv.sections.flatMap(x => x.items).find(i => i.key === 'wood');
  assert.deepEqual(opt.options.map(o => [o.name, o.standard, o.more]), [['Maple, Hard', false, false], ['Cherry', true, false], ['Walnut', false, false]], 'customers: the shown options (“more choices” reads as shown now), plus the standard one');
  assert.equal(opt.standard, '167'); assert.equal(pv.defaults.wood, '167');
  const price = o => call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: o });
  assert.equal((await price({})).data.unit_price, '15.00', 'nothing chosen: the standard selection prices it');
  assert.equal((await price({ wood: '168' })).data.unit_price, '19.00');
  assert.equal((await price({ wood: '169' })).data.error, 'Wood: that choice isn’t offered for this product.');
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [{ kind: 'option', key: 'wood', section: 'wood', hidden: true }] });
  pv = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data;
  assert.deepEqual(pv.not_shown.map(x => x.why), ['Hidden: every order uses the standard selection, Cherry']);
});

test('the simple flow: Draft → readiness → Live → Off, and Publish turns drafts into what customers get', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  let rd = (await call('POST', '/api/admin/products/88/readiness', { dimensions: {} })).data;
  assert.deepEqual(rd.items.map(i => [i.key, i.ok]), [['configurator', false], ['price', true], ['sizes', true], ['sellable', true], ['published', false]]);
  assert.equal(rd.ready, false);
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  rd = (await call('POST', '/api/admin/products/88/readiness', { dimensions: {} })).data;
  assert.equal(rd.ready, true, 'ready, though changes are waiting to publish (that’s information, not a blocker)');
  assert.equal((await call('PUT', '/api/admin/products/474/status', { status: 'live' })).status, 400, 'a part can’t go Live');
  assert.equal((await call('PUT', '/api/admin/products/88/status', { status: 'live' })).data.lifecycle, 'live', 'no approval step: a sellable product goes Live directly');
  // Live, but the formula edit and the layout aren't published: customers can't price it yet (sqft is undefined in the source)
  const feedPrice = async () => (await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: { wood: '164' } }, false)).data;
  assert.equal((await feedPrice()).status, 'needs_keystone');
  const pub = (await call('POST', '/api/admin/publish', { note: 'first' })).data;
  assert.ok(pub.release);
  assert.equal((await call('POST', '/api/admin/publish', {})).status, 409, 'nothing left to publish');
  assert.deepEqual([(await feedPrice()).status, (await feedPrice()).unit_price], ['priced', '12.50'], 'after Publish customers get the edit');
  const summary = (await call('GET', '/api/admin/changes/summary')).data;
  assert.equal(Object.entries(summary).filter(([k, v]) => k !== 'ok' && v).length, 0, 'nothing pending');
  // the edit stays in effect in the admin too, and can go back to the catalog's formula with a new draft
  assert.equal((await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' } })).data.price.unit_cost, '12.50');
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost * sqft' });
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.formulas, 1, 'restoring the original after a publish is a draft of its own');
  assert.equal((await feedPrice()).unit_price, '12.50', 'customers keep the published version until the next Publish');
  assert.equal((await call('GET', '/api/admin/releases')).data.releases[0].note, 'first');
  assert.equal((await call('PUT', '/api/admin/products/88/status', { status: 'off' })).data.lifecycle, 'retired');
  assert.equal((await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: {} }, false)).status, 404, 'Off: not orderable');
});

test('the SQL’s rules in the configurator: options that conflict with the door are dropped; chosen options that conflict stop the price', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  // Walnut can't be used on this door (a rule added in the admin): it drops out of the door's wood list
  await call('POST', '/api/admin/conflicts/changes', { item: 'd88', add: ['a168'] });
  const pv = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data;
  assert.deepEqual(pv.sections.flatMap(x => x.items).find(i => i.key === 'wood').options.map(o => o.name), ['Maple, Hard']);
  const r = (await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: { wood: '164' } })).data;
  assert.equal(r.status, 'priced'); assert.ok(Array.isArray(r.parts), 'the price comes with the cut list for drawing');
  assert.equal((await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: { wood: '168' } })).data.error, 'Wood: that choice isn’t offered for this product.');
});

test('the door configurator’s list: Live doors offered in it, and nothing else', async () => {
  const { call } = await setup();
  assert.deepEqual((await call('GET', '/api/catalog/doors', null, false)).data.products, []);
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  assert.deepEqual((await call('GET', '/api/catalog/doors', null, false)).data.products, [], 'offered but still Draft');
  await reviewed(call);
  await call('PUT', '/api/admin/products/88/status', { status: 'live' });
  await call('POST', '/api/admin/publish', {});
  assert.deepEqual((await call('GET', '/api/catalog/doors', null, false)).data.products.map(p => p.name), ['SRP-10-MP']);
  await call('PUT', '/api/admin/products/88/status', { status: 'off' });
  assert.deepEqual((await call('GET', '/api/catalog/doors', null, false)).data.products, []);
});

test('drawings: an option can be set to draw with a traced profile; customers get it after Publish', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  await reviewed(call);
  await call('PUT', '/api/admin/products/88/status', { status: 'live' });
  await call('POST', '/api/admin/publish', {});
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { key: 'REGULAR RAISE' } })).status, 400, 'a wood takes a swatch, not a profile');
  assert.equal((await call('PUT', '/api/admin/options/165/look', { look: { key: 'REGULAR RAISE' } })).data.ok, true, 'a panel style takes a profile');
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { id: 'maple' } })).data.ok, true);
  const opt = async (staff) => (staff ? (await call('GET', '/api/admin/products/88/configurators/door/preview')).data : (await call('GET', '/api/catalog/products/88/config?configurator=door', null, false)).data)
    .sections.flatMap(x => x.items).find(i => i.key === 'wood').options.find(o => o.id === '164');
  assert.deepEqual((await opt(true)).look, { id: 'maple' }, 'the admin’s preview shows it straight away');
  assert.equal((await opt(false)).look, undefined, 'customers keep the match by name until Publish');
  await call('POST', '/api/admin/publish', {});
  assert.deepEqual((await opt(false)).look, { id: 'maple' });
  await call('PUT', '/api/admin/options/164/look', { look: null });
  assert.deepEqual((await opt(false)).look, { id: 'maple' }, 'going back to automatic is a draft too');
  assert.equal((await opt(true)).look, undefined);
});

test('drawings from a DXF or a picture: kept with the option, checked, and sent to the configurators', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  const ProfileDXF = (await import('../shared/profile-dxf.js')).default;
  const square = { label: 'Square', path: [[0.9, 0], [0, 0], [0, 0.75], [0.9, 0.75]] };
  const r = ProfileDXF.toProfile('panel_style', ProfileDXF.template('panel_style', { ...square, path: [[2.2, 0], [0, 0], [0, 0.25], [2.2, 0.625]] }));
  assert.deepEqual([r.profile.t, r.profile.tongue, r.profile.group], [0.625, [0, 0.25], '5/8'], 'a panel DXF gives its thickness, tongue and group');
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { profile: square } })).status, 400, 'a wood takes no DXF');
  assert.equal((await call('PUT', '/api/admin/options/165/look', { look: { image: 'data:text/html;base64,PGI+' } })).status, 400, 'pictures are PNG, JPG or SVG');
  assert.equal((await call('PUT', '/api/admin/options/165/look', { look: { profile: { path: [[0, 0], [1e9, 0]] } } })).status, 400, 'an outline has to be inches');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await call('PUT', '/api/admin/options/165/look', { look: { profile: r.profile, file: 'raise.dxf', image: png, image_file: 'raise.png' } })).data.ok, true);
  const saved = (await call('GET', '/api/admin/options/165')).data.look.look;
  assert.deepEqual([saved.type, saved.file, saved.image_file, saved.profile.t], ['panel', 'raise.dxf', 'raise.png', 0.625]);
});

test('size checks: on/off as the import stores it (true/false) as well as older exports (True/False)', async () => {
  const { isOn } = await import('../server/engine/oe/design.mjs');
  assert.deepEqual([true, 'True', 'true', 't', 1, false, 'False', 'f', 0, null, undefined].map(isOn), [true, true, true, true, true, false, false, false, false, false, false]);
  const { call, DB } = await setup();
  DB.raw.exec(`INSERT INTO oe_records (snapshot_id, source_table, source_id, design_id, data_json, eligible) VALUES ('oe-test', 'size_constraints', '77', '88', '${JSON.stringify({ id: '77', design_id: '88', name: 'Most per order', expression: 'qty <= 2', message: 'Order 2 at most', enabled: true })}', 1)`);
  const r = (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '5', selections: { wood: '164' } })).data;
  const c = r.constraints.find(x => x.name === 'Most per order');
  assert.equal(c.enabled, true, 'a size check stored as true is on'); assert.equal(c.ok, false, 'and it stops an order of 5');
});

test('options: add one (copied), offer it on a product type, price with it; retire one; customers see none of it until Publish', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  await reviewed(call);
  await call('PUT', '/api/admin/products/88/status', { status: 'live' });
  await call('POST', '/api/admin/publish', { note: 'the door, as customers get it' });
  assert.equal((await call('POST', '/api/admin/options/new', { type_id: '5', name: 'Maple, Hard' })).status, 400, 'no two options of a kind with one name');
  const n = (await call('POST', '/api/admin/options/new', { type_id: '5', name: 'Rift White Oak', copy_from: '164' })).data;
  assert.match(n.id, /^n\d+$/);
  const o = (await call('GET', `/api/admin/options/${n.id}`)).data;
  assert.equal(o.fields.find(f => f.name === 'Cost').draft.value, '12.50', 'its values are copied (as drafts)');
  assert.ok(o.offered.find(x => x.dta === '7').offered, 'and where the copied option was offered');
  await call('PUT', '/api/admin/options/' + n.id + '/values', { field: '44', value: '16.25' });
  const wood = async staff => (staff ? (await call('GET', '/api/admin/products/88/configurators/door/preview')).data : (await call('GET', '/api/catalog/products/88/config?configurator=door', null, false)).data).sections.flatMap(x => x.items).find(i => i.key === 'wood').options.map(x => x.name);
  assert.ok((await wood(true)).includes('Rift White Oak'), 'the admin’s preview offers it straight away');
  assert.ok(!(await wood(false)).includes('Rift White Oak'), 'customers don’t, until Publish');
  assert.equal((await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: { wood: n.id } })).data.unit_price, '16.25', 'and it prices from its own (edited) values');
  // a value edit on an existing option now reaches the price, too
  await call('PUT', '/api/admin/options/164/values', { field: '44', value: '13.00' });
  assert.equal((await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: { wood: '164' } })).data.unit_price, '13.00');
  assert.equal((await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: { wood: '164' } }, false)).data.unit_price, '12.50', 'customers keep the published value');
  // stop offering Walnut on Framed Door, and retire Cherry
  await call('PUT', '/api/admin/options/168/offer', { dta: '7', offered: false });
  await call('PUT', '/api/admin/options/167/retire', { retired: true });
  assert.deepEqual((await wood(true)).sort(), ['Maple, Hard', 'Rift White Oak']);
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.options, 4, 'added, offered on Framed Door (copied), Walnut not offered, Cherry retired');
  await call('POST', '/api/admin/publish', {});
  assert.deepEqual((await wood(false)).sort(), ['Maple, Hard', 'Rift White Oak'], 'after Publish customers get all of it');
  assert.equal((await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: { wood: '164' } }, false)).data.unit_price, '13.00');
  await call('PUT', '/api/admin/options/167/retire', { retired: false });
  const adminWoods = async () => (await call('GET', '/api/admin/products/88')).data.attributes.find(a => a.alias === 'wood').options.map(o => o.name);
  assert.ok((await adminWoods()).includes('Cherry'), 'bringing it back is a draft of its own (Cherry is office only, so it shows in the admin’s list, not the customers’)');
  // finish colors
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { finish: { kind: 'paint', color: '#123456' } } })).status, 400, 'a wood takes no finish color');
});

test('variables only the old notes used are told apart from the ones prices, parts and size checks use', async () => {
  const { variableUse, indexSource } = await import('../server/engine/oe/design.mjs');
  const T = { design: [{ id: '1', design_type_id: '5', name: 'Door', notes: '${customer_note}\nNo guarantee' }, { id: '2', design_type_id: '9', name: 'Panel' }], design_type: [], attribute_type: [], attribute_name: [], attribute_value_alias: [], attribute_value: [], design_type_attribute: [], default_attribute: [], variable_type: [],
    formulas: [{ id: '1:v:0', design_id: '1', name: 'cost', is_cost: 't', expression: 'base * 2' }, { id: '1:v:1', design_id: '1', name: 'base', is_cost: 'f', expression: 'rail + 1' },
      { id: '1:v:2', design_id: '1', name: 'rail', is_cost: 'f', expression: '2.25' }, { id: '1:v:3', design_id: '1', name: 'customer_note', is_cost: 'f', expression: '"Grooves " + groove_note' },
      { id: '1:v:4', design_id: '1', name: 'groove_note', is_cost: 'f', expression: '"start O.C."' }, { id: '1:v:5', design_id: '1', name: 'panel_gap', is_cost: 'f', expression: '0.125' },
      { id: '2:v:0', design_id: '2', name: 'w', is_cost: 'f', expression: 'parent.panel_gap * 2' }],
    size_constraints: [], part_formulas: [] };
  const u = variableUse(indexSource(T), '1', t => t);
  assert.deepEqual(['cost', 'base', 'rail', 'panel_gap'].map(n => u.used.has(n)), [true, true, true, true], 'the cost line’s chain, and what a child design reads through parent.');
  assert.deepEqual(['customer_note', 'groove_note'].map(n => u.used.has(n)), [false, false], 'only the notes use these');
  assert.ok(u.notes.has('customer_note'));
});

test('a product’s allowed options: untick to rule one out for this product (the old Conflict Mapping), tick to allow it back', async () => {
  const { call } = await setup();
  let a = (await call('GET', '/api/admin/products/88/allowed')).data;
  const wood = () => a.attributes.find(x => x.alias === 'wood').options.map(o => [o.name, o.allowed, o.changed]);
  assert.deepEqual(wood(), [['Maple, Hard', true, false], ['Cherry', true, false], ['Walnut', true, false]], 'everything Framed Door offers is allowed to start with');
  assert.equal((await call('PUT', '/api/admin/products/88/allowed', { options: ['169'], allowed: false })).status, 400, 'Alder isn’t offered on Framed Door');
  await call('PUT', '/api/admin/products/88/allowed', { options: ['168'], allowed: false });
  a = (await call('GET', '/api/admin/products/88/allowed')).data;
  assert.deepEqual(wood()[2], ['Walnut', false, true], 'Walnut ruled out (a draft)');
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  const pv = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data;
  assert.ok(!pv.sections.flatMap(x => x.items).find(i => i.key === 'wood').options.some(o => o.name === 'Walnut'), 'and the configurator no longer offers it on this door');
  await call('POST', '/api/admin/publish', {});
  a = (await call('GET', '/api/admin/products/88/allowed')).data;
  assert.deepEqual(wood()[2], ['Walnut', false, false], 'still ruled out after Publish (no longer a draft)');
  assert.ok((await call('GET', '/api/admin/conflicts/of?item=d88')).data.conflicts.some(c => c.key === 'a168'), 'and the Rules page still shows it after Publish');
  await call('PUT', '/api/admin/products/88/allowed', { options: ['168'], allowed: true });
  a = (await call('GET', '/api/admin/products/88/allowed')).data;
  assert.deepEqual(wood()[2], ['Walnut', true, true], 'allowed back: a draft that removes the rule');
});

test('a product’s standard selection: set one (a draft), it’s what the configurator starts on; none means the customer chooses', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  assert.equal((await call('PUT', '/api/admin/products/88/standard', { attribute: 'wood', option: '169' })).status, 400, 'Alder isn’t offered on Framed Door');
  await call('PUT', '/api/admin/products/88/allowed', { options: ['168'], allowed: false });
  assert.equal((await call('PUT', '/api/admin/products/88/standard', { attribute: 'wood', option: '168' })).status, 400, 'a ruled-out option can’t be the standard');
  await call('PUT', '/api/admin/products/88/allowed', { options: ['168'], allowed: true });
  assert.equal((await call('PUT', '/api/admin/products/88/standard', { attribute: 'wood', option: '168' })).data.ok, true);
  const std = async () => (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.key === 'wood').standard;
  assert.equal(await std(), '168', 'the configurator starts on Walnut');
  assert.equal((await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: {} })).data.unit_price, '19.00', 'and prices with it when nothing is chosen');
  assert.equal((await call('GET', '/api/catalog/products/88/config?configurator=door', null, false)).status, 404, 'not Live: customers see nothing either way');
  await call('PUT', '/api/admin/products/88/standard', { attribute: 'wood', option: null });
  assert.equal(await std(), null, 'none: the customer chooses');
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.options, 0, 'back to how the SQL has it (no standard wood): nothing waiting');
});

test('product types: each type’s attributes and which options it offers, changed for the whole type as drafts', async () => {
  const { call } = await setup();
  const list = (await call('GET', '/api/admin/types')).data.types;
  assert.ok(list.some(t => t.name === 'Framed Door' && t.attributes === 1));
  let t = (await call('GET', '/api/admin/types/5')).data, wood = () => t.attributes.find(a => a.alias === 'wood').options.map(o => [o.name, o.offered, o.web]);
  assert.deepEqual(wood(), [['Maple, Hard', true, 1], ['Cherry', true, 0], ['Walnut', true, 1], ['Alder', false, null]], 'the SQL’s map: Alder isn’t offered on Framed Door; Walnut’s “more choices” reads as shown');
  await call('PUT', '/api/admin/types/5/offer', { dta: '7', options: ['169'], offered: true, web: 1 });
  await call('PUT', '/api/admin/types/5/offer', { dta: '7', options: ['167'], offered: false });
  t = (await call('GET', '/api/admin/types/5')).data;
  assert.deepEqual(wood(), [['Maple, Hard', true, 1], ['Cherry', false, null], ['Walnut', true, 1], ['Alder', true, 1]]);
  assert.equal((await call('GET', '/api/admin/products/88')).data.attributes.find(a => a.alias === 'wood').options.some(o => o.name === 'Alder'), true, 'every Framed Door now offers Alder (a draft)');
  await call('PUT', '/api/admin/types/5/offer', { dta: '7', options: ['167'], offered: true, web: 0 });
  t = (await call('GET', '/api/admin/types/5')).data;
  assert.equal(t.attributes[0].options.find(o => o.name === 'Cherry').changed, false, 'back to how the SQL has it: no draft');
  assert.equal((await call('PUT', '/api/admin/types/5/offer', { dta: '99', options: ['169'], offered: true })).status, 400);
});

test('a product type’s attributes: add one (empty), give it a value, fill it in, price with it; remove one', async () => {
  const { call } = await setup();
  let t = (await call('GET', '/api/admin/types/5')).data;
  assert.deepEqual(t.attributes.map(a => a.alias), ['wood']);
  assert.ok(t.addable.some(a => a.alias === 'panel_style'), 'any attribute Framed Door doesn’t have can be added');
  assert.equal((await call('POST', '/api/admin/types/5/attributes', { attribute_type_id: '10' })).data.ok, true);
  t = (await call('GET', '/api/admin/types/5')).data;
  let ps = t.attributes.find(a => a.alias === 'panel_style');
  assert.deepEqual([ps.added, ps.draft, ps.fields.length, ps.options.filter(o => o.offered).length], [true, true, 0, 0], 'it starts empty: no values, nothing offered');
  // give it a value formulas can read, offer an option, and fill the value in on the option
  assert.equal((await call('POST', '/api/admin/types/5/fields', { dta: ps.dta, alias: 'Cost!' })).status, 400);
  assert.equal((await call('POST', '/api/admin/types/5/fields', { dta: ps.dta, alias: 'cost', name: 'Cost' })).data.ok, true);
  await call('PUT', '/api/admin/types/5/offer', { dta: ps.dta, options: ['165'], offered: true, web: 1 });
  t = (await call('GET', '/api/admin/types/5')).data; ps = t.attributes.find(a => a.alias === 'panel_style');
  assert.deepEqual(ps.fields.map(f => [f.alias, f.added]), [['cost', true]]);
  const o = (await call('GET', '/api/admin/options/165')).data, f = o.fields.find(x => x.product_type === 'Framed Door' && x.alias === 'panel_style.cost');
  assert.ok(f, 'the option shows the new value under Framed Door');
  assert.equal((await call('PUT', '/api/admin/options/165/values', { field: f.field, value: '7.50' })).data.ok, true);
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost + panel_style.cost' });
  const r = (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164', panel_style: '165' } })).data;
  assert.equal(r.price.unit_cost, '20.00', 'Maple 12.50 + the raise’s new cost 7.50');
  // remove Wood: it tells how many products read it first
  assert.equal((await call('GET', '/api/admin/types/5/attributes/5/use')).data.products >= 0, true);
  await call('DELETE', '/api/admin/types/5/attributes/5');
  t = (await call('GET', '/api/admin/types/5')).data;
  assert.deepEqual(t.attributes.map(a => a.alias), ['panel_style']); assert.deepEqual(t.removed.map(r => [r.name, r.draft]), [['Wood', true]]);
  await call('POST', '/api/admin/types/5/attributes', { attribute_type_id: '5' });
  assert.deepEqual((await call('GET', '/api/admin/types/5')).data.attributes.map(a => a.alias).sort(), ['panel_style', 'wood'], 'bring it back');
  await call('DELETE', '/api/admin/types/5/attributes/10');
  assert.deepEqual((await call('GET', '/api/admin/types/5')).data.attributes.map(a => a.alias), ['wood'], 'dropping the added one before it’s published');
});

test('the order options are listed in: set per attribute (a draft), used by the configurators', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  const list = async () => (await call('GET', '/api/admin/options/list?type=5')).data.options.map(o => o.name);
  assert.deepEqual(await list(), ['Maple, Hard', 'Cherry', 'Walnut', 'Alder'], 'the SQL’s order to start with');
  assert.equal((await call('PUT', '/api/admin/options/order', { type_id: '5', order: ['168', '168'] })).status, 400);
  await call('PUT', '/api/admin/options/order', { type_id: '5', order: ['168', '164', '169', '167'] });
  assert.deepEqual(await list(), ['Walnut', 'Maple, Hard', 'Alder', 'Cherry']);
  const pv = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data;
  assert.deepEqual(pv.sections.flatMap(x => x.items).find(i => i.key === 'wood').options.map(o => o.name), ['Walnut', 'Maple, Hard'], 'the door configurator lists them in that order (Cherry is office only, Alder not offered)');
  assert.equal((await call('GET', '/api/admin/changes/summary')).data.options, 1);
});

test('an option value edited and published shows as the value, not the SQL’s old one', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/options/164/values', { field: '44', value: '13.00' });
  await call('POST', '/api/admin/publish', {});
  const f = (await call('GET', '/api/admin/options/164')).data.fields.find(x => x.field === '44');
  assert.deepEqual([f.value, f.edited, f.draft], ['13.00', true, null]);
  assert.equal((await call('PUT', '/api/admin/options/164/values', { field: '44', value: '13.00' })).data.unchanged, true, 'setting it to what customers already have is no change');
});

test('special instructions merge the way the old O.E. does: add, replace by pattern, ${super} and ${super.field}', async () => {
  const { withInstructions, indexSource } = await import('../server/engine/oe/design.mjs');
  const part = (design, alias, exprs) => ({ id: `${design}:${alias}`, design_id: design, alias, default_design: 'None', source_json: JSON.stringify({ exprs }) });
  const T = { design: [{ id: '1', design_type_id: '5', name: 'Door' }, { id: '9', design_type_id: '3', name: 'Horizontal Grain' }], design_type: [], attribute_type: [], attribute_name: [], attribute_value_alias: [], attribute_value: [], design_type_attribute: [], default_attribute: [], variable_type: [], size_constraints: [],
    formulas: [{ id: 'a', design_id: '1', name: 'cost', is_cost: 't', expression: '10' }, { id: 'b', design_id: '1', name: 'routing', is_cost: 'f', expression: '"Std"' },
      { id: 'c', design_id: '9', name: 'grain_cost', is_cost: 't', expression: '2.75' }, { id: 'd', design_id: '9', name: '^routing$', is_cost: 'f', expression: '${routing} + " HG"' }],
    part_formulas: [part('1', 'center_panel', { dim1: { alias: 'width', expression: 'w - 4' }, dim2: { alias: 'length', expression: 'h - 4' } }), part('1', 'left_stile', { dim1: { alias: 'width', expression: '2.25' } }),
      part('9', '^.*panel$', { dim1: { alias: 'width', expression: '${super.length}' }, dim2: { alias: 'length', expression: '${super.width}' } })] };
  const S = indexSource(T), r = withInstructions(S, '1', ['9']);
  assert.deepEqual(r.applied, ['9']); assert.deepEqual(r.errors, []);
  const vars = r.S.variables.get('1'), parts = r.S.parts.get('1');
  assert.deepEqual(vars.map(v => [v.name, v.expression]), [['cost', '10'], ['routing', '("Std") + " HG"'], ['grain_cost', '2.75']], 'a new cost line added, routing replaced over the old one');
  const ex = JSON.parse(parts.find(p => p.alias === 'center_panel').source_json).exprs;
  assert.deepEqual([ex.dim1.expression, ex.dim2.expression], ['h - 4', 'w - 4'], 'the panel’s width and length swap; the stile is untouched');
  assert.equal(JSON.parse(parts.find(p => p.alias === 'left_stile').source_json).exprs.dim1.expression, '2.25');
  assert.equal(S.variables.get('1').length, 2, 'the original index isn’t changed');
});

test('auto-conflicts: a new option starts ruled out on products flagged for its attribute; the flag can be changed per product', async () => {
  const { call, DB } = await setup();
  DB.raw.exec(`INSERT INTO oe_records (snapshot_id, source_table, source_id, design_id, ref1, data_json, eligible) VALUES ('oe-test', 'attribute_auto_conflict', '1', '88', '5', '${JSON.stringify({ id: '1', design_id: '88', attribute_type_id: '5' })}', 1)`);
  assert.equal((await call('GET', '/api/admin/products/88/allowed')).data.attributes.find(a => a.alias === 'wood').auto, true, 'SRP-10-MP is flagged for Wood');
  const n = (await call('POST', '/api/admin/options/new', { type_id: '5', name: 'Rift White Oak', copy_from: '164' })).data;
  assert.equal(n.ruled_out_on, 1);
  const w = (await call('GET', '/api/admin/products/88/allowed')).data.attributes.find(a => a.alias === 'wood').options.find(o => o.id === n.id);
  assert.deepEqual([w.allowed, w.changed], [false, true], 'the new wood starts ruled out on SRP-10-MP');
  await call('PUT', '/api/admin/products/88/autoconflict', { attribute: 'wood', on: false });
  const n2 = (await call('POST', '/api/admin/options/new', { type_id: '5', name: 'Sapele' })).data;
  assert.equal(n2.ruled_out_on, 0, 'with the flag off, the next new wood isn’t');
});

test('the Design Builder’s work: add a cost line, a value, a size check and a part to a product; remove one; customers after Publish', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  await call('PUT', '/api/admin/products/88/status', { status: 'live' });
  await call('POST', '/api/admin/publish', {});
  const price = async (who = 'admin') => who === 'admin' ? (await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: 1, options: { wood: '164' } })).data : (await call('POST', '/api/catalog/products/88/price', { dimensions: {}, quantity: 1, options: { wood: '164' } }, false)).data;
  const before = (await price()).unit_price;
  assert.equal((await call('POST', '/api/admin/products/88/items', { kind: 'variable', name: 'Bad Name', expression: '1' })).status, 400);
  assert.equal((await call('POST', '/api/admin/products/88/items', { kind: 'variable', name: 'prep', expression: '2 +' })).status, 400, 'a formula has to read');
  assert.equal((await call('POST', '/api/admin/products/88/items', { kind: 'variable', name: 'prep_rate', label: 'Prep rate', expression: '1.25' })).data.ok, true);
  assert.equal((await call('POST', '/api/admin/products/88/items', { kind: 'variable', name: 'prep_cost', label: 'Prep', is_cost: true, category: 'Option Cost', expression: 'prep_rate * 2' })).data.ok, true);
  const p = (await call('GET', '/api/admin/products/88')).data;
  assert.deepEqual(p.variables.filter(v => v.added).map(v => [v.name, v.is_cost]), [['prep_rate', false], ['prep_cost', true]]);
  assert.equal(Number((await price()).unit_price) - Number(before), 2.5, 'the new cost line adds 2.50 in the admin straight away');
  assert.equal((await price('customer')).status, 'priced'); const custBefore = (await price('customer')).unit_price;
  // a size check and a part
  assert.equal((await call('POST', '/api/admin/products/88/items', { kind: 'constraint', name: 'At most 3', expression: 'qty <= 3', message: 'Order 3 at most' })).data.ok, true);
  assert.equal((await call('POST', '/api/admin/products/88/items', { kind: 'part', alias: 'center_mullion', formulas: { qty: 'qty', width: '2', length: '10' } })).data.ok, true);
  const c = (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '5', selections: { wood: '164' } })).data;
  assert.equal(c.constraints.find(x => x.name === 'At most 3').ok, false);
  assert.ok(c.parts.some(x => x.alias === 'center_mullion'), 'the new part is in the cut list');
  // remove the added value before publishing: it just goes
  await call('DELETE', '/api/admin/products/88/items', { key: 'c:At most 3' });
  assert.ok(!(await call('GET', '/api/admin/products/88')).data.constraints.some(x => x.name === 'At most 3'));
  await call('POST', '/api/admin/publish', {});
  assert.equal(Number((await price('customer')).unit_price) - Number(custBefore), 2.5, 'customers get the cost line after Publish');
  // remove the published cost line: a removal draft
  await call('DELETE', '/api/admin/products/88/items', { key: 'v:prep_cost' });
  assert.equal((await price()).unit_price, before, 'gone in the admin');
  assert.equal(Number((await price('customer')).unit_price) - Number(custBefore), 2.5, 'customers keep it until Publish');
  await call('PUT', '/api/admin/products/88/items', { key: 'v:prep_cost', restore: true });
  assert.equal(Number((await price()).unit_price) - Number(before), 2.5, 'kept after all');
});

test('special instructions page: what an instruction does, which choices apply it, and offering it on a product type', async () => {
  const { call, DB } = await setup();
  // an instruction type and one instruction in the test catalog
  const add = (t, id, d, extra = '') => DB.raw.exec(`INSERT INTO oe_records (snapshot_id, source_table, source_id, design_id, data_json, eligible) VALUES ('oe-test', '${t}', '${id}', ${d ? `'${d}'` : 'NULL'}, '${JSON.stringify(extra).replace(/'/g, "''")}', 1)`);
  add('design_type_meta', '1', null, { id: '1', name: 'Simple Instruction', is_instruction: 't', is_embedded: 'f' });
  add('design_type', '33', null, { id: '33', name: 'Door Special Instr (test)', design_type_meta_id: '1' });
  add('design', '900', '900', { id: '900', design_type_id: '33', name: 'Glass Prep', notes: '' });
  add('formulas', '900:v:0', '900', { id: '900:v:0', design_id: '900', name: 'glass_prep_cost', label: 'Glass prep', category: 'Option Cost', is_cost: 't', discountable: 't', expression: '12.50' });
  const list = (await call('GET', '/api/admin/instructions')).data.instructions;
  assert.ok(list.some(x => x.id === '900' && x.linked === 0));
  let r = (await call('GET', '/api/admin/instructions/900')).data;
  assert.deepEqual(r.formulas.map(f => [f.name, f.is_cost, f.text]), [['glass_prep_cost', true, '12.50']]);
  assert.equal((await call('POST', '/api/admin/instructions/900/offer', { design_type_id: '5', label: 'Glass prep' })).data.ok, true);
  r = (await call('GET', '/api/admin/instructions/900')).data;
  assert.deepEqual(r.links.map(l => [l.attribute, l.control, l.where]), [['Glass prep', 'toggle', 'Framed Door']], 'offered on every Framed Door as a yes/no');
  // and it prices: SRP-10-MP with the yes/no on
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  const on = (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' }, attributes: { glass_prep: '1' } })).data;
  assert.equal(on.price.unit_cost, '25.00', 'Maple 12.50 + glass prep 12.50');
  assert.deepEqual(on.instructions.map(i => i.name), ['Glass Prep']);
  // removing: skipped while a choice applies it; unlink, then remove; restore
  assert.deepEqual((await call('POST', '/api/admin/instructions/remove', { ids: ['900'], reason: 'not used' })).data.skipped_linked, ['900']);
  const link = (await call('GET', '/api/admin/instructions/900')).data.links[0];
  assert.equal((await call('DELETE', '/api/admin/instructions/900/links', { attribute_id: link.attribute_id })).data.deleted_choice, true, 'the yes/no made for it goes');
  assert.deepEqual((await call('POST', '/api/admin/instructions/remove', { ids: ['900'], reason: 'not used' })).data.removed, ['900']);
  assert.equal((await call('GET', '/api/admin/instructions')).data.instructions.find(x => x.id === '900').removed.reason, 'Special instruction: not used');
  assert.equal((await call('POST', '/api/admin/instructions/900/offer', { design_type_id: '5' })).status, 400, 'a removed one can’t be offered');
  await call('POST', '/api/admin/instructions/900/restore');
  assert.equal((await call('GET', '/api/admin/instructions')).data.instructions.find(x => x.id === '900').removed, null);
});

test('left-out formulas: a name pattern leaves matching formulas out of every product; refused while something kept reads one', async () => {
  const { call, DB } = await setup();
  const add = (id, name, expr, cost = 'f') => DB.raw.exec(`INSERT INTO oe_records (snapshot_id, source_table, source_id, design_id, data_json, eligible) VALUES ('oe-test', 'formulas', '${id}', '88', '${JSON.stringify({ id, design_id: '88', name, label: name, category: cost === 't' ? 'Option Cost' : 'Expression', is_cost: cost, discountable: cost, expression: expr })}', 1)`);
  add('88:v:70', 'ups_girth', 'width * 2'); add('88:v:71', 'ups_ground_fees', 'ups_girth + 1'); add('88:v:72', 'mfg_qty', 'qty'); add('88:v:73', 'boxed_cost', 'mfg_qty * 0', 't');
  let c = (await call('POST', '/api/admin/settings/left-out/check', { pattern: 'ups_*' })).data;
  assert.deepEqual([c.formulas, c.readers_total], [2, 0], 'the two ups_ formulas only read each other');
  c = (await call('POST', '/api/admin/settings/left-out/check', { pattern: 'mfg_*' })).data;
  assert.equal(c.readers_total, 1, 'boxed_cost (kept) reads mfg_qty');
  assert.equal((await call('PUT', '/api/admin/settings/left-out', { patterns: ['ups_*', 'mfg_*'] })).data.ok, true);
  let names = (await call('GET', '/api/admin/products/88')).data.variables.map(v => v.name);
  assert.ok(!names.some(n => n.startsWith('ups_')), 'ups_ formulas are gone from the product');
  assert.ok(names.includes('mfg_qty'), 'mfg_qty stays: a kept cost line reads it');
  await call('PUT', '/api/admin/settings/left-out', { patterns: [] });
  names = (await call('GET', '/api/admin/products/88')).data.variables.map(v => v.name);
  assert.ok(names.includes('ups_girth'), 'and back when the pattern is taken off');
});

test('how close an option’s drawing is: set on its own or with a drawing, sent to the configurators', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { accuracy: 'approx' } })).data.ok, true);
  const opt = async () => (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.key === 'wood').options.find(o => o.id === '164');
  assert.deepEqual((await opt()).look, { accuracy: 'approx' }, 'the match by name stays; only the note changes');
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { id: 'maple', accuracy: 'none' } })).data.ok, true);
  assert.deepEqual((await opt()).look, { id: 'maple', accuracy: 'none' });
  const L = (await import('../shared/sql-looks.js')).default;
  assert.deepEqual([L.accuracyOf({ exact: true }), L.accuracyOf({ close: true }), L.accuracyOf({}), L.accuracyOf({ exact: true, accuracy: 'approx' })], ['exact', 'approx', 'none', 'approx']);
});

test('panel layouts on a product’s Options tab: listed, ruled out per product like an option', async () => {
  const { call } = await setup();
  const a = (await call('GET', '/api/admin/products/88/allowed')).data;
  assert.ok(Array.isArray(a.layouts), 'the Options tab gets a layouts list (empty for a door with no layout slot)');
  assert.equal((await call('PUT', '/api/admin/products/88/allowed', { layouts: ['99999'], allowed: false })).status, 400, 'only this door’s own layouts');
});

test('an instruction offered as a number: entering a thickness applies it and the value goes into its “enter value” formula', async () => {
  const { call, DB } = await setup();
  const add = (t, id, d, extra) => DB.raw.exec(`INSERT INTO oe_records (snapshot_id, source_table, source_id, design_id, data_json, eligible) VALUES ('oe-test', '${t}', '${id}', ${d ? `'${d}'` : 'NULL'}, '${JSON.stringify(extra).replace(/'/g, "''")}', 1)`);
  add('design_type_meta', '1', null, { id: '1', name: 'Simple Instruction', is_instruction: 't', is_embedded: 'f' });
  add('design_type', '33', null, { id: '33', name: 'Door Special Instr (test)', design_type_meta_id: '1' });
  add('design', '901', '901', { id: '901', design_type_id: '33', name: 'Doors to finish at X thick', notes: '' });
  add('formulas', '901:v:0', '901', { id: '901:v:0', design_id: '901', name: 'non_standard_thickness', label: 'Thickness', category: 'Expression', is_cost: 'f', expression: 'enter value' });
  add('formulas', '901:v:1', '901', { id: '901:v:1', design_id: '901', name: 'non_standard_thickness_cost', label: 'Non-standard thickness', category: 'Option Cost', is_cost: 't', discountable: 't', expression: 'iif (non_standard_thickness == 0.78, 0, 16.85)' });
  const r = (await call('GET', '/api/admin/instructions/901')).data;
  assert.deepEqual(r.formulas.filter(f => f.enter).map(f => f.name), ['non_standard_thickness'], 'the page knows which formula wants a value');
  assert.equal((await call('POST', '/api/admin/instructions/901/offer', { design_type_id: '5', as: 'number', sets: 'non_standard_thickness', label: 'Finish thickness' })).data.ok, true);
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  const calc = async v => (await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' }, attributes: v == null ? {} : { finish_thickness: v } })).data;
  assert.equal((await calc(null)).price.unit_cost, '12.50', 'blank: the standard door, no charge');
  const thick = await calc('1.125');
  assert.deepEqual(thick.instructions.map(i => i.name), ['Doors to finish at X thick']);
  assert.equal(thick.price.unit_cost, '29.35', 'Maple 12.50 + the source’s 16.85 for a non-standard thickness');
  assert.equal((await calc('0.78')).price.unit_cost, '12.50', 'the source’s own condition: 0.78" is standard, so no charge');
  const copy = await call('POST', '/api/admin/instructions/migrate-built', {});
  assert.equal(copy.status, 200); assert.deepEqual(copy.data.migrated, ['901']);
  assert.deepEqual((await call('POST', '/api/admin/instructions/migrate-built', {})).data.migrated, []);
  assert.equal((await call('GET', '/api/admin/instructions')).data.instructions.find(i => i.id === '901').migrated, true);
  const attribute = (await call('GET', '/api/admin/attributes')).data.attributes.find(a => a.name === 'finish_thickness');
  assert.equal((await call('DELETE', `/api/admin/attributes/${attribute.id}`)).status, 400);
  assert.equal((await call('DELETE', '/api/admin/instructions/901/links', { attribute_id: attribute.id })).status, 400);
  assert.equal((await call('PUT', '/api/admin/attributes', { ...attribute, number_instruction: '', choices: [] })).status, 400);
  assert.equal((await call('PUT', '/api/admin/attributes', { ...attribute, number_instruction: '901', number_sets: 'non_standard_thickness', min: '0.75', max: '1.25', default: '0.78' })).status, 200, 'defaults and limits remain editable');
  assert.deepEqual((await call('POST', '/api/admin/instructions/remove', { ids: ['901'], reason: 'migrated' })).data.removed, []);
  DB.raw.exec("DELETE FROM oe_records WHERE design_id='901'");
  assert.equal((await calc('1.125')).price.unit_cost, '29.35', 'copied pricing survives removal of all legacy definition rows');
  assert.equal((await calc('0.78')).price.unit_cost, '12.50');

});

test('no approval step: a sellable product goes from Draft straight to Live', async () => {
  const { call } = await setup();
  const r = await call('PUT', '/api/admin/products/88/status', { status: 'live' });
  assert.equal(r.status, 200, r.data.error); assert.equal(r.data.lifecycle, 'live');
});

test('planner estimate: cabinets with no old O.E. match say so; the route answers for customers and staff', async () => {
  const { call } = await setup();
  for (const [base, emp] of [['/api/catalog/planner', false], ['/api/admin/planner', true]]) {
    const r = (await call('POST', `${base}/quote`, { cabinets: [{ ref: 'a', moz: 'Made_Up_Cabinet', label: 'X', width: 18, height: 34.5, depth: 24 }], fronts: [] }, emp)).data;
    assert.equal(r.ok, true); assert.equal(r.cabinets[0].status, 'no_product'); assert.equal(r.totals.complete, false);
  }
});

test('texture library: a photo is added, served as an image, and a wood can use it with its color adjusted', async () => {
  const { call } = await setup();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', '/api/admin/textures', { name: 'Oak', color_map: 'data:text/plain;base64,AA==', width_in: 12, height_in: 24 })).status, 400);
  const id = (await call('POST', '/api/admin/textures', { name: 'Flat-sawn oak', color_map: png, thumb: png, width_in: 12, height_in: 24, swatch: '#B08A60' })).data.id;
  assert.ok(id);
  const lib = (await call('GET', '/api/admin/textures')).data.textures; assert.deepEqual(lib.map(t => [t.name, t.width_in, t.swatch]), [['Flat-sawn oak', 12, '#B08A60']]);
  assert.equal((await call('PUT', '/api/admin/options/165/look', { look: { texture: { source: 'photo', id } } })).status, 400, 'only woods take a texture');
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { texture: { source: 'photo', id, adjust: { warmth: 40, tint: '#7a4a2a', tint_amount: 30 } } } })).data.ok, true);
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  const opt = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.key === 'wood').options.find(o => o.id === '164');
  assert.deepEqual([opt.look.texture.source, opt.look.texture.adjust.warmth, opt.look.texture.adjust.tint, opt.look.texture.meta.width_in], ['photo', 40, '#7A4A2A', 12], 'the wood carries its texture, color and the photo’s size');
});

test('a configurator only previews and prices products of its own families', async () => {
  const { call } = await setup();
  const ok = await call('GET', '/api/admin/products/88/configurators/door/preview');
  assert.equal(ok.status, 200, 'a framed door is in the door configurator');
  const box = await call('GET', '/api/admin/products/88/configurators/drawer_box/preview');
  assert.equal(box.status, 400); assert.match(box.data.error, /isn’t in the drawer box configurator; it belongs in the door configurator or the kitchen planner/);
});

// ---------------- the typed attribute editor (Allmoxy-style)
import { attributeValue } from '../server/engine/oe/design.mjs';
import { storage as makeStorage } from '../server/storage/d1.mjs';

test('attributes: the five types save with their settings, reload, and keep their values exactly', async () => {
  const { call } = await setup();
  const put = b => call('PUT', '/api/admin/attributes', { scope: 'company', show_door: true, show_planner: true, ...b });
  let r = await put({ name: 'groove_depth', label: 'Groove depth', control: 'number', min: '1', max: '50', default: '6.35', settings: { unit_display: 'mm', unit_formula: 'in', precision: '.01', comments: 'staff only', width: 'half' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await put({ name: 'pull_side', label: 'Pull side', control: 'dropdown', choices: [{ label: 'Left', value: '1' }, { label: 'Right', value: '2' }], default: '2' }); assert.equal(r.status, 200);
  r = await put({ name: 'soft_close', label: 'Soft close', control: 'toggle', default: '0', settings: { checkbox_text: 'Add soft-close hinges' } }); assert.equal(r.status, 200);
  r = await put({ name: 'room_tag', label: 'Room', control: 'text', default: '0012', settings: { max_length: 10, always_show: true } }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await put({ name: 'job_notes', label: 'Notes', control: 'paragraph', settings: { max_length: 200, box_lines: 4 } }); assert.equal(r.status, 200);
  const list = (await call('GET', '/api/admin/attributes')).data.attributes, by = n => list.find(a => a.name === n);
  assert.deepEqual([by('groove_depth').control, by('pull_side').control, by('soft_close').control, by('room_tag').control, by('job_notes').control], ['number', 'dropdown', 'toggle', 'text', 'paragraph']);
  assert.equal(by('groove_depth').settings.unit_display, 'mm'); assert.equal(by('groove_depth').settings.comments, 'staff only');
  assert.equal(by('room_tag').default, '0012', 'numeric-looking text stays text'); assert.equal(by('job_notes').settings.box_lines, 4); assert.equal(by('soft_close').settings.checkbox_text, 'Add soft-close hinges');
  // a label change keeps the formula name and the stored values
  r = await put({ ...by('pull_side'), label: 'Which side the pull is on', settings: {} }); assert.equal(r.status, 200);
  const again = (await call('GET', '/api/admin/attributes')).data.attributes.find(a => a.name === 'pull_side');
  assert.equal(again.label, 'Which side the pull is on'); assert.deepEqual(again.choices.map(c => c.value), ['1', '2']); assert.equal(again.default, '2');
});

test('attributes: the server refuses bad names, mismatched units, long text and bad defaults', async () => {
  const { call } = await setup();
  const put = b => call('PUT', '/api/admin/attributes', { scope: 'company', ...b });
  assert.equal((await put({ name: 'Bad Name', label: 'x', control: 'number' })).status, 400);
  assert.equal((await put({ name: 'width', label: 'x', control: 'number' })).status, 400, 'a word formulas already use');
  assert.match((await put({ name: 'a_three', label: 'C', control: 'number', settings: { unit_display: 'mm' } })).data.error, /unitless value can’t be converted/);
  assert.match((await put({ name: 'a_four', label: 'D', control: 'number', settings: { unit_display: 'ft', unit_formula: 'in' } })).data.error, /unitless, inches or millimeters/);
  assert.match((await put({ name: 'a_five', label: 'E', control: 'text', default: 'far too long', settings: { max_length: 5 } })).data.error, /5 characters at most/);
  assert.match((await put({ name: 'a_six', label: 'F', control: 'dropdown', choices: [{ label: 'X', value: '1' }], default: '9' })).data.error, /Default/);
});

test('attributes: values — text stays text, empty stays empty, false and zero survive, read-only and units hold on the server', () => {
  const text = { label: 'Room', control: 'text', default: '0012', settings: { max_length: 10 } };
  assert.deepEqual(attributeValue(text, undefined), { value: '0012', text: true }, 'left out: the default, as text');
  assert.deepEqual(attributeValue(text, ''), { value: '', text: true }, 'cleared: empty, not the default');
  assert.deepEqual(attributeValue(text, '0012'), { value: '0012', text: true });
  assert.ok(attributeValue(text, 'x'.repeat(11)).error);
  const para = { label: 'Notes', control: 'paragraph', settings: {} };
  assert.equal(attributeValue(para, 'line one\nline two').value, 'line one\nline two', 'multi-line text kept');
  const flag = { label: 'Soft close', control: 'toggle', default: '1' };
  assert.equal(attributeValue(flag, false).value, '0'); assert.equal(attributeValue(flag, 0).value, '0');
  const n = { label: 'Count', control: 'number', default: '3', min: '0' };
  assert.equal(attributeValue(n, '0').value, '0', 'zero is a value, not “use the default”');
  const ro = { label: 'Fixed', control: 'number', default: '2.5', settings: { read_only: true } };
  assert.equal(attributeValue(ro, '9').value, '2.5', 'read-only: the server uses the default whatever is sent');
  const mm = { label: 'Depth', control: 'number', settings: { unit_display: 'mm', unit_formula: 'in' } };
  assert.equal(attributeValue(mm, '25.4').value, '1', '25.4 mm is exactly 1 inch for the formulas');
  assert.equal(attributeValue(mm, '6.35').value, '0.25');
  const inch = { label: 'Depth', control: 'number', settings: { unit_display: 'in', unit_formula: 'mm' } };
  assert.equal(attributeValue(inch, '0.5').value, '12.70');
  const plain = { label: 'Depth', control: 'number', settings: {} };
  assert.equal(attributeValue(plain, '0.5').value, '0.5', 'no units: unchanged');
});

test('attributes: an older database upgrades in place, keeping every attribute and its id', async () => {
  const DB = makeD1();
  DB.raw.exec('DROP TABLE IF EXISTS oe_attributes');   // an attribute table as it was before this change
  DB.raw.exec(`CREATE TABLE oe_attributes (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL CHECK (scope IN ('company', 'type', 'product')), design_type_id TEXT, design_id TEXT, name TEXT NOT NULL, label TEXT NOT NULL, control TEXT NOT NULL CHECK (control IN ('dropdown', 'integer', 'number', 'slider', 'toggle')), min_value TEXT, max_value TEXT, step_value TEXT, choices_json TEXT NOT NULL DEFAULT '[]', default_value TEXT, unit TEXT, help TEXT, rank INTEGER NOT NULL DEFAULT 0, show_door INTEGER NOT NULL DEFAULT 1, show_planner INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')), updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (scope, design_type_id, design_id, name))`);
  DB.raw.exec(`INSERT INTO oe_attributes (id, scope, name, label, control, default_value, choices_json, updated_by, updated_at) VALUES (7, 'company', 'rush', 'Rush', 'toggle', '0', '[{"label":"Yes","value":"1","instruction":"42"}]', 't', 'now')`);
  const S = makeStorage(DB);
  const list = await S.oeAttributes();
  assert.equal(list.length, 1); assert.equal(list[0].id, 7); assert.equal(list[0].choices[0].instruction, '42', 'instruction links kept'); assert.deepEqual(list[0].settings, {});
  await S.oeSaveAttribute({ scope: 'company', name: 'notes', label: 'Notes', control: 'paragraph', settings: { box_lines: 3 } }, 't');
  assert.equal((await S.oeAttributes()).find(a => a.name === 'notes').settings.box_lines, 3, 'the upgraded table takes the new types and settings');
  await makeStorage(DB).oeAttributes();   // running the upgrade again is harmless
  assert.equal((await makeStorage(DB).oeAttributes()).length, 2);
});

test('attributes: added to a product by dragging (only products it’s added to), and shown only when another choice matches', async () => {
  const { call } = await setup();
  let r = await call('PUT', '/api/admin/attributes', { scope: 'company', name: 'glass_texture', label: 'Glass texture', control: 'dropdown', choices: [{ label: 'Clear', value: '1' }, { label: 'Seeded', value: '2' }],
    settings: { only_assigned: true, show_when: { key: 'soft_close', op: 'in', values: 'yes' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); const gid = r.data.id;
  await call('PUT', '/api/admin/attributes', { scope: 'company', name: 'soft_close', label: 'Soft close', control: 'toggle', default: '0', settings: { always_show: true } });
  const keys = async () => (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).map(i => i.key);
  assert.ok(!(await keys()).includes('glass_texture'), 'not on the product until it’s added');
  assert.ok((await call('GET', '/api/admin/attributes/addable/88')).data.attributes.some(a => a.name === 'glass_texture'), 'offered to drag in');
  assert.equal((await call('PUT', `/api/admin/attributes/${gid}/products/88`)).status, 200);
  assert.ok((await keys()).includes('glass_texture'), 'on the product once added');
  assert.ok(!(await call('GET', '/api/admin/attributes/addable/88')).data.attributes.some(a => a.name === 'glass_texture'));
  const look = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.key === 'glass_texture').look;
  assert.deepEqual(look.show_when, { key: 'soft_close', op: 'in', values: ['yes'] }, 'the rule goes to the configurators');
  // the server applies the rule too: hidden (soft close not chosen), a bad value for it is ignored; shown, it's checked
  const { showWhen } = await import('../server/configurators.mjs');
  assert.equal(showWhen({ key: 'soft_close', op: 'in', values: ['yes'] }, { soft_close: 'no' }), false);
  assert.equal(showWhen({ key: 'soft_close', op: 'in', values: ['yes'] }, { soft_close: 'yes' }), true);
  assert.equal(showWhen({ key: 'panel_style', op: 'not_in', values: ['glass'] }, { panel_style: 'Glass Panel' }), false, 'names match without case, and by part');
  assert.equal(showWhen({ key: 'panel_style', op: 'in', values: ['glass'] }, {}), false, 'nothing chosen: not shown');
  assert.equal((await call('DELETE', `/api/admin/attributes/${gid}/products/88`)).status, 200);
  assert.ok(!(await keys()).includes('glass_texture'), 'taken off again');
  assert.match((await call('PUT', '/api/admin/attributes', { scope: 'company', name: 'loop_test', label: 'L', control: 'number', settings: { show_when: { key: 'loop_test', values: 'x' } } })).data.error, /itself/);
});

test('attributes: a new formula name that would override a catalog formula or another level’s attribute needs confirming', async () => {
  const { call } = await setup();
  const vars = (await call('GET', '/api/admin/products/88')).data.variables || [], own = vars.find(v => /^[a-z_][a-z0-9_]*$/.test(v.name || '') && !['width', 'height', 'qty', 'depth'].includes(v.name) && v.design_id === '88') || vars.find(v => /^[a-z_][a-z0-9_]*$/.test(v.name || '') && !['width', 'height', 'qty', 'depth'].includes(v.name));
  assert.ok(own, `a formula on product 88 (of ${vars.length})`);
  let r = await call('PUT', '/api/admin/attributes', { scope: 'company', name: own.name, label: 'X', control: 'number' });
  assert.equal(r.status, 409); assert.equal(r.data.confirm, true); assert.match(r.data.error, /own formula/);
  r = await call('PUT', '/api/admin/attributes', { scope: 'company', name: own.name, label: 'X', control: 'number', confirm_override: true });
  assert.equal(r.status, 200, 'confirmed: an intentional override is allowed');
  assert.equal((await call('PUT', '/api/admin/attributes', { scope: 'company', name: 'tier_z', label: 'Tier', control: 'number' })).status, 200);
  r = await call('PUT', '/api/admin/attributes', { scope: 'product', design_id: '88', name: 'tier_z', label: 'Tier here', control: 'number' });
  assert.equal(r.status, 409); assert.match(r.data.error, /already an attribute called tier_z \(company-wide\)/);
  assert.equal((await call('PUT', '/api/admin/attributes', { scope: 'product', design_id: '88', name: 'tier_z', label: 'Tier here', control: 'number', confirm_override: true })).status, 200);
  assert.equal((await call('PUT', '/api/admin/attributes', { scope: 'company', name: 'tier_z', label: 'Again', control: 'number', confirm_override: true })).status, 400, 'the same level twice is never allowed');
});

test('attributes: “show only when” a formula is true — checked when saved, worked out with each price, ignored while false', async () => {
  const { call } = await setup();
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  assert.match((await call('PUT', '/api/admin/attributes', { scope: 'product', design_id: '88', name: 'big_note', label: 'Note', control: 'text', settings: { show_when: { formula: 'qty >' } } })).data.error, /mistake/);
  assert.match((await call('PUT', '/api/admin/attributes', { scope: 'product', design_id: '88', name: 'self_ref', label: 'S', control: 'number', settings: { show_when: { formula: 'self_ref > 1' } } })).data.error, /itself/);
  const r = await call('PUT', '/api/admin/attributes', { scope: 'product', design_id: '88', name: 'extra_hinges', label: 'Extra hinges', control: 'integer', min: '0', max: '6', settings: { show_when: { formula: 'qty > 2 and not (qty > 50)' } }, confirm_override: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const price = async (q, n) => (await call('POST', '/api/admin/products/88/configurators/door/price', { dimensions: {}, quantity: String(q), options: {}, attributes: { extra_hinges: String(n) }, office: true })).data;
  const one = await price(1, 4);
  assert.equal(one.visible.extra_hinges, false, 'one door: hidden');
  assert.equal((await price(1, 1)).unit_price, one.unit_price, 'while hidden, its value can’t change the price');
  assert.equal((await price(3, 4)).visible.extra_hinges, true, 'three doors: shown');
  assert.equal((await price(60, 4)).visible.extra_hinges, false, 'and, or, not all work');
  const look = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.key === 'extra_hinges').look;
  assert.deepEqual(look.show_when, { formula: 'qty > 2 and not (qty > 50)' });
});

test('customers: a new customer with no number gets the next one — zero-padded, never a duplicate', async () => {
  const { nextCustomerNumber } = await import('../server/api.mjs');
  assert.equal(nextCustomerNumber([]), '1001');
  assert.equal(nextCustomerNumber(['00123', '00099', 'ABC-7']), '00124', 'the highest all-digit number, same width; letters ignored');
  assert.equal(nextCustomerNumber(['0999']), '1000', 'a wider number when it rolls over');
  const { call } = await setup();
  let r = await call('POST', '/api/admin/customers', { rows: [{ number: '00123', name: 'First' }] }); assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/admin/customers/next-number')).data.number, '00124');
  r = await call('POST', '/api/admin/customers', { rows: [{ number: '', name: 'Second' }, { name: 'Third' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.rows.map(x => [x.number, x.auto]), [['00124', true], ['00125', true]], 'two new ones in one save: consecutive');
  assert.equal((await call('POST', '/api/admin/customers', { rows: [{ number: '00124', name: 'Dup' }] })).status, 400, 'a typed number already used is refused');
  const list = (await call('GET', '/api/admin/customers?q=')).data.rows.map(c => c.number).sort();
  assert.deepEqual(list.filter(n => n.startsWith('001')), ['00123', '00124', '00125']);
});

test('drawings: an option drawn from each door design shows that design’s own profile, or an approximate name match until it has one', async () => {
  const { designLook } = await import('../server/configurators.mjs');
  const own = { profile: { path: [[0, 0], [1, 1]] }, file: 'design-88.dxf' };
  const looks = new Map([['5', { by_design: true }], ['p:88:framing_bead', own], ['6', { key: 'OG' }]]);
  assert.deepEqual(designLook(looks, '5', '88', 'framing_bead'), { ...own, accuracy: 'exact' }, 'the design’s own profile');
  assert.deepEqual(designLook(looks, '5', '99', 'framing_bead'), { accuracy: 'approx', by_design: true }, 'no profile for that design: name match, approximate');
  assert.deepEqual(designLook(looks, '6', '88', 'framing_bead'), { key: 'OG' }, 'any other option: unchanged');
  const { call } = await setup();
  const wood = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.kind === 'option' && i.key === 'wood');
  assert.match((await call('PUT', `/api/admin/options/${wood.options[0].id}/by-design`, { on: true })).data.error, /Only framing beads/);
  let r = await call('PUT', '/api/admin/products/88/profiles/framing_bead', { look: { profile: { path: [[0.8, 0], [0, 0], [0, 0.75], [0.8, 0.75]] }, file: 'design-88.dxf' } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.look.profile.g.length, 2, 'a framing bead keeps its groove'); assert.equal(r.data.previous, null);
  assert.equal((await call('PUT', '/api/admin/products/88/profiles/framing_bead', { look: { profile: { path: [[1, 2]] } } })).status, 400, 'a broken outline is refused');
  r = await call('PUT', '/api/admin/products/88/profiles/framing_bead', { look: null }); assert.equal(r.status, 200); assert.equal(r.data.previous.file, 'design-88.dxf', 'Undo gets the old one back');
  assert.deepEqual((await call('GET', '/api/admin/products/88/profiles')).data.kinds, [], 'no option of this door is drawn by design');
});

test('drawings: a design that offers an option drawn from each design, with no profile of its own, is flagged', async () => {
  const { designProfileGaps } = await import('../server/configurators.mjs');
  const pi = { items: [{ kind: 'option', key: 'framing_bead', options: [{ id: '5', name: 'Stock Frame' }, { id: '6', name: 'Ogee Frame' }] }, { kind: 'option', key: 'panel_style', options: [{ id: '7', name: 'Stock Panel' }] }, { kind: 'option', key: 'wood', options: [{ id: '8', name: 'Maple' }] }] };
  const looks = new Map([['5', { by_design: true }], ['7', { by_design: true }], ['p:88:panel_style', { profile: { path: [[0, 0], [1, 1]] } }]]);
  assert.deepEqual(await designProfileGaps(null, pi, '88', looks), [{ kind: 'framing_bead', name: 'Framing bead', options: ['Stock Frame'] }], 'the panel has its profile; the framing bead doesn’t');
  assert.deepEqual(await designProfileGaps(null, pi, '88', new Map([['6', { key: 'OG' }]])), [], 'nothing drawn by design: nothing flagged');
  const { call } = await setup();
  assert.deepEqual((await call('GET', '/api/admin/drawings/gaps')).data.products, [], 'none in the test catalog');
  assert.deepEqual((await call('GET', '/api/admin/products/88')).data.profile_gaps, []);
});

test('planner quote: drawer boxes, the kitchen’s or a cabinet’s own, grouped by box and size', async () => {
  const { call } = await setup();
  const r = await call('POST', '/api/admin/planner/quote', { cabinets: [], fronts: [], box: { product: '88', options: {} },
    boxes: [{ ref: 'a', width: 16.106, height: 4.5, depth: 21 }, { ref: 'b', width: 16.106, height: 4.5, depth: 21 }, { ref: 'c', width: 22.106, height: 4.5, depth: 21, box: { product: '88', options: { x: '1' } } }, { ref: 'd', width: 0, height: 4, depth: 21 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.boxes.map(b => [b.width, b.qty, b.refs.join('')]), [[16.106, 2, 'ab'], [22.106, 1, 'c']], 'the same box at the same size priced once; a box with no size skipped');
  assert.ok('boxes' in r.data.totals);
});

test('products: Discontinued — Off underneath, out of the main list, on its own tab, back again', async () => {
  const { call } = await setup();
  const inMain = async id => (await call('GET', `/api/admin/migration/products?q=${id}`)).data.rows.some(r => r.design_id === id);
  const inDisc = async id => (await call('GET', `/api/admin/migration/products?lifecycle=discontinued&q=${id}`)).data.rows.some(r => r.design_id === id && r.lifecycle === 'discontinued');
  assert.ok(await inMain('88'));
  let r = await call('PUT', '/api/admin/products/88/status', { status: 'discontinued', reason: 'replaced by SRP-12' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.lifecycle, 'retired', 'Off underneath: not orderable');
  assert.ok(!(await inMain('88')), 'out of the main list'); assert.ok(await inDisc('88'), 'on the Discontinued tab');
  const p = (await call('GET', '/api/admin/migration/products/88')).data.product;
  assert.equal(p.lifecycle, 'discontinued'); assert.equal(p.discontinued_reason, 'replaced by SRP-12');
  assert.match(p.history[0].action, /Discontinued \(replaced by SRP-12\)/);
  assert.ok(!(await call('GET', '/api/admin/migration/products?lifecycle=off&q=88')).data.rows.some(r => r.design_id === '88'), 'not under Off either');
  r = await call('POST', '/api/admin/products/status', { ids: ['88'], status: 'off' }); assert.deepEqual(r.data.done, ['88']);
  assert.ok(await inMain('88'), 'brought back: in the main list'); assert.ok(!(await inDisc('88')));
  assert.equal((await call('GET', '/api/admin/migration/products/88')).data.product.lifecycle, 'retired');
  const lv = await call('POST', '/api/admin/products/status', { ids: ['88'], status: 'live' }); assert.equal(lv.status, 200, 'several at once: any status');
  assert.ok(lv.data.done.includes('88') || lv.data.skipped.some(x => x.id === '88'), 'set Live, or skipped with a reason when it isn’t sold on its own');
  await call('POST', '/api/admin/products/status', { ids: ['88'], status: 'off' });
});

test('conflicts: Off and Discontinued products are left out of the lists unless everything is asked for', async () => {
  const { call } = await setup();
  const meta = (await call('GET', '/api/admin/conflicts/meta')).data, dt = meta.design_types.find(t => t.id) ;
  const items = async (all = false) => (await call('GET', `/api/admin/conflicts/items?kind=d&type=${encodeURIComponent(dt.id)}${all ? '&all=1' : ''}`)).data.items.map(i => i.id);
  const before = await items(); assert.ok(before.length, 'a product type with products');
  const id = before[0];
  await call('PUT', `/api/admin/products/${id}/status`, { status: 'discontinued' });
  assert.ok(!(await items()).includes(id), 'Discontinued: left out');
  assert.ok((await items(true)).includes(id), 'shown with everything');
  await call('PUT', `/api/admin/products/${id}/status`, { status: 'off' });
  assert.ok(!(await items()).includes(id), 'Off: left out');
  await call('PUT', `/api/admin/products/${id}/status`, { status: 'draft' });
  assert.ok((await items()).includes(id), 'back to Draft: listed again');
});

test('bulk status: products set Draft, Live, Off or Discontinued together; options discontinued and brought back together', async () => {
  const { call } = await setup();
  let r = await call('POST', '/api/admin/products/status', { ids: ['88'], status: 'discontinued', reason: 'bulk' }); assert.deepEqual(r.data.done, ['88']);
  r = await call('POST', '/api/admin/products/status', { ids: ['88'], status: 'draft' }); assert.deepEqual(r.data.done, ['88']);
  assert.equal((await call('GET', '/api/admin/migration/products/88')).data.product.lifecycle, 'imported', 'Draft');
  assert.equal((await call('POST', '/api/admin/products/status', { ids: ['88'], status: 'nope' })).status, 400);
  const wood = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.key === 'wood');
  const type = (await call('GET', `/api/admin/options/${wood.options[0].id}`)).data.option.type_id, ids = wood.options.slice(0, 2).map(o => String(o.id));
  r = await call('POST', '/api/admin/options/retire', { ids, retired: true }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.done, ids);
  const listed = async () => (await call('GET', `/api/admin/options/list?type=${type}`)).data.options.filter(o => ids.includes(String(o.id))).map(o => o.retired);
  assert.deepEqual(await listed(), [true, true], 'both discontinued');
  await call('POST', '/api/admin/options/retire', { ids, retired: false });
  assert.deepEqual(await listed(), [false, false], 'both brought back');
});

test('products list: the panel layouts (Multi Panel) are on their own tab, not in the main list', async () => {
  const { call } = await setup();
  const main = (await call('GET', '/api/admin/migration/products?limit=500')).data.rows, lays = (await call('GET', '/api/admin/migration/products?group=layouts&limit=500')).data.rows;
  assert.ok(main.every(r => r.product_type !== 'Multi Panel'), 'none in the main list');
  assert.ok(lays.every(r => r.product_type === 'Multi Panel'), 'only layouts on their tab');
});

test('planner quote: drawer fronts too short to be framed are priced on their own, as the solid or slab drawer front chosen', async () => {
  const { call } = await setup();
  const fronts = [{ ref: 'a', kind: 'drawer', width: 23.875, height: 6, small: true }, { ref: 'a', kind: 'drawer', width: 23.875, height: 7.958 }, { ref: 'b', kind: 'drawer', width: 23.875, height: 6, small: true }];
  let r = (await call('POST', '/api/admin/planner/quote', { cabinets: [], fronts, door: { product: '88', options: {} } })).data;
  const small = r.fronts.filter(f => f.small);
  assert.equal(small.length, 1, 'the two short fronts priced together'); assert.equal(small[0].qty, 2);
  assert.equal(small[0].status, 'needs_choice', 'none chosen yet: it says so');
  r = (await call('POST', '/api/admin/planner/quote', { cabinets: [], fronts, door: { product: '88', options: {} }, small_front: { product: '88' } })).data;
  assert.notEqual(r.fronts.find(f => f.small).status, 'needs_choice', 'chosen: priced as that drawer front');
  assert.ok(r.fronts.some(f => !f.small && f.height === 7.958), 'the framed ones as the door style');
});

test('planner quote: a drawer front style or drawer box sent as the picker saves it (sel, attrs) has its choices read', async () => {
  const { call } = await setup();
  const wood = (await call('GET', '/api/admin/products/88/configurators/door/preview')).data.sections.flatMap(x => x.items).find(i => i.key === 'wood');
  const pick = String(wood.options[0].id), fronts = [{ ref: 'a', kind: 'drawer', width: 20.875, height: 6 }];
  const asSaved = (await call('POST', '/api/admin/planner/quote', { cabinets: [], fronts, door: { product: '88', options: {} }, drawer_front: { product: '88', sel: { wood: pick }, attrs: {} } })).data;
  const asSent = (await call('POST', '/api/admin/planner/quote', { cabinets: [], fronts, door: { product: '88', options: {} }, drawer_front: { product: '88', options: { wood: pick }, attributes: {} } })).data;
  const msgs = r => (r.fronts[0].messages || []).join('; ');
  assert.ok(!/choose a wood/i.test(msgs(asSaved)), `the wood saved as sel is read (got: ${msgs(asSaved)})`);
  assert.equal(msgs(asSaved), msgs(asSent), 'the same answer either way');
});

import { stockForFinish, stockOfName, dropStandardThickness, instructionsForProduct } from '../server/configurators.mjs';
test('product thickness guide: a finished thickness is made from its stock (4/4 to 0.780", 5/4 to 1.000", 6/4 to 1.250", 8/4 to 1.750")', () => {
  assert.equal(stockForFinish(0.75), '4/4'); assert.equal(stockForFinish(0.78), '4/4');
  assert.equal(stockForFinish(0.781), '5/4'); assert.equal(stockForFinish(1), '5/4');
  assert.equal(stockForFinish(1.001), '6/4'); assert.equal(stockForFinish(1.25), '6/4');
  assert.equal(stockForFinish(1.251), '8/4'); assert.equal(stockForFinish(1.75), '8/4');
  assert.equal(stockForFinish(1.76), null, 'nothing thicker than 1.750"'); assert.equal(stockForFinish(''), null);
  assert.equal(stockOfName('5/4 Maple, Hard').key, '5/4'); assert.equal(stockOfName('Maple, Hard').key, '4/4'); assert.equal(stockOfName('6/4 Cherry').key, '6/4');
  assert.ok(stockOfName('3/4" Raw MDF').sheet); assert.equal(stockOfName('3/4" Raw MDF').inches, 0.75);
});
test('the standard finished thickness (0.780") applies no "finish at X thick" instruction; others do', () => {
  assert.deepEqual(dropStandardThickness({ finish_thickness: '0.78' }), {});
  assert.deepEqual(dropStandardThickness({ finish_thickness: '0.9' }), { finish_thickness: '0.9' });
});
test('a drawer front takes the "Drawer fronts …" version of a linked "Doors …" instruction; a door keeps it', () => {
  const Sx = { designs: new Map([['1183', { name: 'Doors to finish at X thick' }], ['2066', { name: 'Drawer fronts to finish at X thick' }]]) };
  const attrs = [{ name: 'finish_thickness', control: 'number', choices: [{ value: '*', instruction: '1183', sets: 'non_standard_thickness' }] }];
  assert.deepEqual(instructionsForProduct(Sx, { product_type: 'Framed Door' }, attrs, { finish_thickness: '0.9' }), ['1183']);
  assert.deepEqual(instructionsForProduct(Sx, { product_type: 'Framed Drawer Front' }, attrs, { finish_thickness: '0.9' }), ['2066']);
  assert.deepEqual(instructionsForProduct(Sx, { product_type: 'Solid Drawer Front' }, attrs, {}), []);
});

import { configuratorFits } from '../server/configurators.mjs';
test('the drawer front configurator: drawer fronts only; the door configurator takes the other door types', () => {
  assert.equal(configuratorFits('drawer_front', 'doors', 'Framed Drawer Front'), true);
  assert.equal(configuratorFits('drawer_front', 'doors', 'Solid Drawer Front (5/4)'), true);
  assert.equal(configuratorFits('drawer_front', 'doors', 'Framed Door'), false);
  assert.equal(configuratorFits('door', 'doors', 'Framed Door'), true);
  assert.equal(configuratorFits('door', 'doors', 'Framed Drawer Front'), false, 'a drawer front is in its own configurator now');
  assert.equal(configuratorFits('drawer_box', 'doors', 'Framed Door'), false);
  assert.equal(configuratorFits('planner', 'doors', 'Framed Drawer Front'), true, 'the planner still takes every door type');
});
test('product configurators: an older database (door, drawer box, planner only) upgrades in place and takes drawer fronts', async () => {
  const DB = makeD1();
  DB.raw.exec('DROP TABLE IF EXISTS oe_product_configurators');
  DB.raw.exec(`CREATE TABLE oe_product_configurators (design_id TEXT NOT NULL, configurator TEXT NOT NULL CHECK (configurator IN ('door', 'drawer_box', 'planner')), enabled INTEGER NOT NULL DEFAULT 1,
    layout_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')), updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (design_id, configurator))`);
  DB.raw.exec(`INSERT INTO oe_product_configurators (design_id, configurator, enabled, layout_json, status, updated_by, updated_at) VALUES ('88', 'door', 1, '[{"kind":"option","key":"wood"}]', 'published', 't', 'x')`);
  const S = makeStorage(DB);
  const links = await S.oeProductConfigurators('88');
  assert.equal(links.length, 1); assert.equal(links[0].configurator, 'door'); assert.equal(links[0].layout.length, 1, 'the link and its layout kept');
  await S.oeSaveProductConfigurator('554', 'drawer_front', { enabled: true, layout: [] }, 't');
  assert.ok((await S.oeProductConfigurators('554')).some(l => l.configurator === 'drawer_front'), 'the upgraded table takes drawer front links');
  await makeStorage(DB).oeProductConfigurators('88');   // running the upgrade again is harmless
  assert.equal((await makeStorage(DB).oeProductConfigurators('88')).length, 1);
});

test('a dropdown choice can apply its instruction twice: “Front & Back” charges a handle cut-out twice; the count is kept', async () => {
  const { call, DB } = await setup();
  const add = (t, id, d, extra) => DB.raw.exec(`INSERT INTO oe_records (snapshot_id, source_table, source_id, design_id, data_json, eligible) VALUES ('oe-test', '${t}', '${id}', ${d ? `'${d}'` : 'NULL'}, '${JSON.stringify(extra).replace(/'/g, "''")}', 1)`);
  add('design_type_meta', '1', null, { id: '1', name: 'Simple Instruction', is_instruction: 't', is_embedded: 'f' });
  add('design_type', '34', null, { id: '34', name: 'Box Special Instr (test)', design_type_meta_id: '1' });
  add('design', '902', '902', { id: '902', design_type_id: '34', name: 'Handle Cut-Out "F"', notes: '' });
  add('formulas', '902:v:0', '902', { id: '902:v:0', design_id: '902', name: 'handle_cut_out_cost', label: 'Handle Cut Out Cost', category: 'Option Cost', is_cost: 't', discountable: 't', expression: '5.9' });
  const put = await call('PUT', '/api/admin/attributes', { scope: 'type', design_type_id: '5', name: 'handle_cutout_f', label: 'Handle cut-out "F"', control: 'dropdown', show_door: true, show_planner: true,
    choices: [{ label: 'Front', value: 'front', instruction: '902' }, { label: 'Back', value: 'back', instruction: '902' }, { label: 'Front & Back', value: 'both', instruction: '902', times: 2 }] });
  assert.equal(put.data.ok, true);
  const saved = (await call('GET', '/api/admin/attributes')).data.attributes.find(a => a.name === 'handle_cutout_f');
  assert.equal(saved.choices.find(c => c.value === 'both').times, 2, 'the count is kept'); assert.equal(saved.choices.find(c => c.value === 'front').times, undefined);
  await call('PUT', '/api/admin/products/88/formulas', { target: 'v:cost', text: 'wood.cost' });
  const cost = async v => Number((await call('POST', '/api/admin/products/88/calc', { dims: {}, qty: '1', selections: { wood: '164' }, attributes: v ? { handle_cutout_f: v } : {} })).data.price.unit_cost);
  const none = await cost(null), front = await cost('front'), both = await cost('both');
  assert.equal(+(front - none).toFixed(2), 5.9, 'one cut-out'); assert.equal(+(both - none).toFixed(2), 11.8, 'front and back: charged twice');
});

test('wood catalog: box-only wood is excluded even when it was the source default', async () => {
  const { DB, call } = await setup();
  DB.raw.prepare("UPDATE oe_records SET data_json=json_set(data_json,'$.name','Bee-Line Prefinished Maple') WHERE source_table='attribute_name' AND source_id='164'").run();
  DB.raw.prepare("UPDATE oe_records SET data_json=json_set(data_json,'$.default_attribute_id','164') WHERE source_table='design_type_attribute' AND source_id='7'").run();
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled:true, layout:[] });
  const view=(await call('GET','/api/admin/products/88/configurators/door/preview')).data;
  const wood=view.sections.flatMap(s=>s.items).find(i=>i.key==='wood');
  assert.ok(!wood.options.some(o=>o.id==='164'));
  assert.equal(wood.standard,null);
  const explicit=await call('POST','/api/admin/products/88/configurators/door/price',{options:{wood:'164'}});
  assert.match(explicit.data.error,/isn’t offered/);
  const omitted=(await call('POST','/api/admin/products/88/configurators/door/price',{options:{}})).data;
  assert.equal(omitted.status,'needs_input');
});

test('wood catalog: configured design standard and explicit thickness both gate source pricing', async () => {
  const {DB,call}=await setup();
  await call('PUT','/api/admin/products/88/configurators/door',{enabled:true,layout:[]});
  await call('PUT','/api/admin/variables',{scope:'type',design_type_id:'5',name:'sqft',formula:'2'});
  await call('PUT','/api/admin/attributes',{scope:'product',design_id:'88',name:'standard_finish_thickness',label:'Standard finished thickness',control:'number',default:'1'});
  await call('PUT','/api/admin/attributes',{scope:'product',design_id:'88',name:'finish_thickness',label:'Finish at thickness',control:'number',min:'0.1',max:'1.75',default:'0.78'});
  const view=(await call('GET','/api/admin/products/88/configurators/door/preview')).data;
  assert.equal(view.product.standard_finish_thickness,1);
  assert.ok(!view.sections.flatMap(s=>s.items).some(i=>i.key==='standard_finish_thickness'));
  const price=async attributes=>(await call('POST','/api/admin/products/88/configurators/door/price',{options:{wood:'164'},attributes})).data;
  const wrong=await price({});
  assert.notEqual(wrong.status,'priced');
  assert.ok(wrong.messages.some(m=>m.includes('5/4')));
  const right=await price({finish_thickness:'0.78'});
  assert.equal(right.unit_price,'25.00','source wood cost is preserved');
  const cleared=(await call('POST','/api/admin/products/88/configurators/door/price',{options:{wood:''}})).data;
  assert.equal(cleared.status,'needs_input','clearing incompatible wood cannot silently use a default');
  assert.notEqual((await price({finish_thickness:'',standard_finish_thickness:'0.78'})).status,'priced','blank uses design standard; posted standard override is ignored');
  DB.raw.prepare("UPDATE oe_records SET data_json=json_set(data_json,'$.name','5/4 Maple, Hard') WHERE source_table='attribute_name' AND source_id='164'").run();
  assert.equal((await price({})).unit_price,'25.00','design standard uses correct stock without changing its source cost');

});

test('Modified Raise reuses source instructions, preserves standard prices and checks guide/flat area', async () => {
  const {call,DB}=await setup();
  const add=(t,id,d,data)=>DB.raw.prepare('INSERT INTO oe_records (snapshot_id,source_table,source_id,design_id,data_json,eligible) VALUES (?,?,?,?,?,1)').run('oe-test',t,id,d,JSON.stringify({id,...data}));
  add('design_type_meta','1',null,{name:'Instruction',is_instruction:'t',is_embedded:'f'});
  add('design_type','33',null,{name:'Door Special Instr',design_type_meta_id:'1'});
  for(const [n,name] of ['Alpine','Aspen','Cove','Elite','Euro','Keystone','Regular','Slope','Step'].entries())
    add('design',String(900+n),String(900+n),{design_type_id:'33',name:'Modified '+name+' Raise'});
  add('design','475','475',{design_type_id:'8',name:'Two-panel layout'});
  const iid='906';
  for(const [n,name,expression,cost] of [
    ['0','panel_reveal','enter value','f'],['1','modified_cost','4.25','t']
  ]) add('formulas',iid+':v:'+n,iid,{design_id:iid,name,expression,is_cost:cost,discountable:'t'});
  add('size_constraints',iid+':c:0',iid,{design_id:iid,name:'Min Reveal',expression:'panel_reveal >= 0.125',message:'Reveal below source minimum',enabled:true});
  add('size_constraints',iid+':c:1',iid,{design_id:iid,name:'Max Reveal',expression:'panel_reveal <= 10',message:'Reveal above source maximum',enabled:true});
  DB.raw.prepare("UPDATE oe_records SET data_json=json_set(data_json,'$.name','Regular Raise (5/8)') WHERE source_table='attribute_name' AND source_id='165'").run();
  add('design_type_attribute','8',null,{design_type_id:'5',attribute_type_id:'10'});
  add('attribute_name','884',null,{attribute_type_id:'10',name:'Custom or Modified Raise (5/8")',rank:'9'});
  DB.raw.prepare('INSERT INTO oe_records (snapshot_id,source_table,source_id,ref1,ref2,data_json,eligible) VALUES (?,?,?,?,?,?,1)')
    .run('oe-test','design_type_attribute_map','98','8','884',JSON.stringify({id:'98',design_type_attribute_id:'8',attribute_name_id:'884',web_status:'0'}));

  DB.raw.prepare('INSERT INTO oe_records (snapshot_id,source_table,source_id,ref1,ref2,data_json,eligible) VALUES (?,?,?,?,?,?,1)')
    .run('oe-test','design_type_attribute_map','99','8','165',JSON.stringify({id:'99',design_type_attribute_id:'8',attribute_name_id:'165',web_status:'1'}));
  add('formulas','88:shape','88',{design_id:'88',name:'panel_shape_tolerance',expression:'0'});
  add('formulas','474:tol','474',{design_id:'474',name:'panel_style_tolerance',expression:'0.625'});
  add('part_formulas','474:panel','474',{design_id:'474',alias:'panel',source_json:JSON.stringify({exprs:{
    dim1:{alias:'width',expression:'10',enabled:true,evalInParentNS:true},
    dim2:{alias:'length',expression:'20',enabled:true,evalInParentNS:true},
    qty:{alias:'qty',expression:'1',enabled:true,evalInParentNS:true}
  }})});
  await call('PUT','/api/admin/variables',{scope:'type',design_type_id:'5',name:'sqft',formula:'2'});
  await call('PUT','/api/admin/products/88/configurators/door',{enabled:true,layout:[]});
  const view=(await call('GET','/api/admin/products/88/configurators/door/preview')).data;
  const items=view.sections.flatMap(s=>s.items);
  assert.ok(items.some(i=>i.key==='custom_raise_reveal'));
  const mods=(await call('GET','/api/admin/products/88/configurators')).data.modifications;
  assert.equal(mods.raise_panels.find(o=>o.id==='165').reveal.instruction_id,iid, 'admin modifications use the actual product calculation context');
  assert.ok(!items.find(i=>i.key==='panel_style').options.some(o=>o.id==='884'),'office-only custom panel stays an internal pricing mapping');
  assert.equal(items.find(i=>i.key==='panel_style').options.find(o=>o.id==='165').reveal.instruction_id,iid,'all nine source instructions load, including Regular after the sixth');
  const price=async value=>(await call('POST','/api/admin/products/88/configurators/door/price',{options:{wood:'168',panel_style:'165'},attributes:{custom_raise_reveal:value}})).data;
  assert.equal((await price('')).unit_price,'38.00');
  assert.equal((await price('1.125')).unit_price,'38.00','standard reveal applies no modification');
  const modified=await price('1.25');
  assert.equal(modified.unit_price,'42.25','the source instruction charge is applied once, not the CSV charge');
  assert.match(modified.texts.custom_raise_reveal,/1.25/);
  assert.equal((await price('1.5')).status,'needs_keystone','outside-guide requests require review');
  assert.equal((await price('0.1')).status,'not_allowed','source constraints still apply');
  assert.equal((await price('5')).status,'not_allowed','flat panel face cannot disappear');
  const guideDraft=structuredClone((await call('GET','/api/admin/catalog-controls')).data.reveals);
  guideDraft['REGULAR RAISE'].standard=1.25;guideDraft['REGULAR RAISE'].use_source_standard=false;
  await call('PUT','/api/admin/catalog-controls/reveal-guides',guideDraft);
  assert.equal((await price('')).unit_price,'42.25','an admin standard changed from the source standard applies the source modification');

  add('formulas','88:stile','88',{design_id:'88',name:'left_stile_width',expression:'2.25'});
  await call('PUT','/api/admin/products/88/inputs',{inputs:[{key:'left_stile_width',label:'Left stile',control:'number',min:'1',max:'12',variables:['left_stile_width'],shown:true,show_door:true,show_planner:true}]});
  const withoutWood=(await call('POST','/api/admin/products/88/configurators/door/price',{options:{wood:'',panel_style:'165'},inputs:{left_stile_width:'3.5'},layouts:{opening:'474'}})).data;
  assert.equal(withoutWood.status,'needs_input');
  assert.equal(withoutWood.unit_price,null);
  assert.equal(withoutWood.widths.left_stile_width,'3.5','geometry probes run while wood is unselected');
  assert.ok(withoutWood.parts.some(p=>p.alias==='panel'),'selected layout parts remain available without a material');

});

test('catalog controls: draft/publish isolation, validation, layout metadata and discard preserve source data', async () => {
  const {call,DB}=await setup();
  const {storage}=await import('../server/storage/d1.mjs');
  const S=storage(DB);
  const source=()=>JSON.stringify(DB.raw.prepare('SELECT source_table,source_id,data_json FROM oe_records ORDER BY source_table,source_id').all());
  const before=source();
  // A second source layout exposes the layout selector on this fixture product.
  DB.raw.prepare('INSERT INTO oe_records (snapshot_id,source_table,source_id,design_id,data_json,eligible) VALUES (?,?,?,?,?,1)')
    .run('oe-test','design','475','475',JSON.stringify({id:'475',design_type_id:'8',name:'Two openings'}));
  const sourceWithLayout=source();
  assert.ok([401,403].includes((await call('PUT','/api/admin/catalog-controls/wood-policy',{},false)).status),'catalog settings require admin authentication');
  const data=(await call('GET','/api/admin/catalog-controls')).data;
  assert.ok(data.layouts.some(l=>l.id==='474'&&l.visual.rows.length));
  const wood={...data.wood,default_thickness:1,stock_bands:data.wood.stock_bands.map(b=>({...b}))};
  assert.equal((await call('PUT','/api/admin/catalog-controls/wood-policy',{...wood,stock_bands:[{key:'4/4',max:2}]})).status,400);
  assert.equal((await call('PUT','/api/admin/catalog-controls/wood-policy',wood)).data.ok,true);
  assert.equal((await S.oeCatalogControls('published')).has('wood-policy'),false,'customers keep defaults before Publish');
  const ctx=await (await import('../server/configurators.mjs')).productItems(S,'oe-test','88',{drafts:true});
  assert.equal(ctx.policy.default_thickness,1);
  const guides=structuredClone(data.reveals);
  guides['REGULAR RAISE'].min_flat=.625;
  assert.equal((await call('PUT','/api/admin/catalog-controls/reveal-guides',guides)).data.ok,true);
  const visual={label:'Single opening',group:'Panels',rows:[{fill:'lite',n:1,weight:1}],adaptive:false,reviewed:true,notes:'Reviewed'};
  assert.equal((await call('PUT','/api/admin/catalog-controls/layout:474',visual)).data.ok,true);
  assert.equal((await call('PUT','/api/admin/catalog-controls/layout:88',visual)).status,400,'a sellable door cannot become a layout visual');
  assert.equal((await call('PUT','/api/admin/catalog-controls/layout:474',{...visual,rows:[{fill:'javascript',n:1,weight:1}]})).status,400);
  assert.equal((await call('GET','/api/admin/changes/summary')).data.catalog,3);
  const ready=(await call('GET','/api/admin/catalog-controls')).data;
  assert.equal(ready.pending.length,3);
  const pub=await S.oePublish('test','Catalog controls');
  assert.ok(pub);
  assert.equal((await S.oeCatalogControls('published')).get('wood-policy').default_thickness,1);
  const publishedCtx=await (await import('../server/configurators.mjs')).productItems(S,'oe-test','88');
  const layout=publishedCtx.items.find(i=>i.kind==='layout');
  assert.equal(layout.options.find(o=>o.id==='474').name,'Single opening');
  assert.equal(layout.options.find(o=>o.id==='474').visual.rows[0].fill,'lite');
  await call('PUT','/api/admin/catalog-controls/wood-policy',{...wood,default_thickness:.78});
  assert.equal((await S.oeCatalogControls('published')).get('wood-policy').default_thickness,1,'later drafts do not leak');
  await call('DELETE','/api/admin/catalog-controls/wood-policy');
  assert.equal((await S.oeCatalogControls()).get('wood-policy').default_thickness,1,'discard restores the published setting');
  assert.equal(source(),sourceWithLayout,'controls do not rewrite source rows');
  assert.notEqual(before,sourceWithLayout,'only the deliberately inserted test layout changed the source fixture');
  const copied=(await call('POST','/api/admin/products/new',{name:'Copied panel layout',design_type_id:'8',based_on:'474'})).data;
  assert.ok(copied.id);
  assert.equal((await S.oeProduct(copied.id)).classification,'component','new layouts are components rather than sellable products');
  assert.equal((await call('PUT','/api/admin/catalog-controls/layout:'+copied.id,{...visual,label:'Copied panel layout'})).data.ok,true);
  assert.ok((await call('GET','/api/admin/catalog-controls')).data.layouts.some(l=>l.id===copied.id&&l.visual.label==='Copied panel layout'));
  const {productItems}=await import('../server/configurators.mjs');
  assert.ok((await productItems(S,'oe-test','88',{drafts:true})).items.find(i=>i.kind==='layout').options.some(o=>o.id===copied.id));
  assert.ok(!(await productItems(S,'oe-test','88')).items.find(i=>i.kind==='layout').options.some(o=>o.id===copied.id),'copied layout is hidden from customers until its visual draft is published');
  await S.oePublish('test','New component layout');
  assert.ok((await productItems(S,'oe-test','88')).items.find(i=>i.kind==='layout').options.some(o=>o.id===copied.id));


});

test('wood grain settings save as option-look drafts and reach customers only after publishing', async () => {
  const {call} = await setup();
  await call('PUT','/api/admin/products/88/configurators/door',{enabled:true,layout:[]});
  await reviewed(call); await call('PUT','/api/admin/products/88/status',{status:'live'});
  await call('POST','/api/admin/publish',{});
  const texture = {source:'recipe',species:'maple',raw:'#bca080',grain:{family:'rift-oak',contrast:.45,flat:0,ring:.12,pores:'ring',poreAmount:.4,knots:0}};
  const r = await call('PUT','/api/admin/options/164/look',{look:{texture}});
  assert.equal(r.status,200); assert.equal(r.data.look.look.texture.raw,'#BCA080');
  const wood = data => data.sections.flatMap(s=>s.items).find(i=>i.key==='wood').options.find(o=>o.id==='164');
  assert.deepEqual(wood((await call('GET','/api/admin/products/88/configurators/door/preview')).data).look.texture.grain,texture.grain);
  assert.equal(wood((await call('GET','/api/catalog/products/88/config?configurator=door',null,false)).data).look?.texture,undefined);
  await call('POST','/api/admin/publish',{});
  assert.deepEqual(wood((await call('GET','/api/catalog/products/88/config?configurator=door',null,false)).data).look.texture.grain,texture.grain);
  for(const bad of [{contrast:2},{ring:0},{family:'invented'},{pores:'bad'},{knots:'1'}])
    assert.equal((await call('PUT','/api/admin/options/164/look',{look:{texture:{...texture,grain:bad}}})).status,400);
});

test('numbered panel layouts reuse source formulas, lock counts, inherit conflicts and publish their settings',async()=>{
 const {call,DB}=await setup();
 const add=(table,id,design,data)=>DB.raw.prepare('INSERT INTO oe_records (snapshot_id,source_table,source_id,design_id,data_json,eligible) VALUES (?,?,?,?,?,1)').run('oe-test',table,id,design,JSON.stringify({id,import_eligible:true,...data}));
 add('design','781','781',{design_type_id:'8',name:'2 Down N Across',product_type:'Multi Panel'});
 DB.raw.prepare("UPDATE oe_records SET data_json=json_set(data_json,'$.source_json',?) WHERE source_table='part_formulas' AND source_id='88:p:0'").run(JSON.stringify({defaultDesign:{reference:'oe://Design/474'},_designType:{reference:'oe://DesignType/8'},exprs:{qty:{alias:'qty',expression:'qty',enabled:true,evalInParentNS:true}}}));
 add('formulas','781:v:0','781',{design_id:'781',name:'panels_across',label:'Panels Across',expression:'2',is_cost:'f'});
 add('formulas','781:v:top','781',{design_id:'781',name:'top_panel_length',label:'Top opening height',expression:'7',is_cost:'f'});
 add('formulas','781:v:rail','781',{design_id:'781',name:'center_rail_width',label:'Center rail width',expression:'2.25',is_cost:'f'});
 add('formulas','781:v:1','781',{design_id:'781',name:'panel_charge',label:'Panel charge',expression:'panels_across * 5',is_cost:'t',discountable:'t'});
 add('part_formulas','781:p:0','781',{design_id:'781',alias:'top_panel',source_json:JSON.stringify({exprs:{dim1:{alias:'width',expression:'12',enabled:true,evalInParentNS:true},dim2:{alias:'length',expression:'20',enabled:true,evalInParentNS:true},qty:{alias:'qty',expression:'qty * panels_across',enabled:true,evalInParentNS:true}}})});
 add('part_formulas','781:p:1','781',{design_id:'781',alias:'bottom_panel',source_json:JSON.stringify({exprs:{dim1:{alias:'width',expression:'12',enabled:true,evalInParentNS:true},dim2:{alias:'length',expression:'20',enabled:true,evalInParentNS:true},qty:{alias:'qty',expression:'qty * panels_across',enabled:true,evalInParentNS:true}}})});
 const {storage}=await import('../server/storage/d1.mjs');const S=storage(DB);
 await S.oeTrackProduct({design_id:'781',snapshot_id:'oe-test',name:'2 Down N Across',product_type:'Multi Panel',family:'doors',classification:'component',classification_basis:'fixture',confirmed:true},'fixture');
 await call('PUT','/api/admin/variables',{scope:'type',design_type_id:'5',name:'sqft',formula:'2'});
 await call('PUT','/api/admin/products/88/configurators/door',{enabled:true,layout:[]});
 const before=JSON.stringify(DB.raw.prepare('SELECT source_table,source_id,data_json FROM oe_records ORDER BY source_table,source_id').all());
 const get=async staff=>(await call('GET',staff?'/api/admin/products/88/configurators/door/preview':'/api/catalog/products/88/config?configurator=door',null,staff)).data.sections.flatMap(s=>s.items).find(i=>i.kind==='layout');
 const lay=await get(true),v=lay.options.find(o=>o.id==='781x3y2');assert.ok(v);assert.equal(v.source_id,'781');assert.equal(v.visual.rows.length,2);assert.ok(v.visual.rows.every(r=>r.n===3));
 const price=async (id,layout_sizes={})=>(await call('POST','/api/admin/products/88/configurators/door/price',{quantity:'2',options:{wood:'168'},layouts:{opening:id},layout_sizes:{opening:layout_sizes}})).data;
 const numbered=await price(v.id),custom=await price('781',{panels_across:'3'});
 const adjusted=await price(v.id,{top_panel_length:'10',center_rail_width:'3'});assert.equal(adjusted.widths['opening.top_panel_length'],'10');assert.equal(adjusted.widths['opening.center_rail_width'],'3');
 assert.equal(numbered.status,'priced');assert.equal(numbered.unit_price,custom.unit_price);assert.deepEqual(numbered.parts,custom.parts);assert.equal(numbered.parts.find(p=>p.alias==='top_panel').qty,'6');
 assert.notEqual((await price('781x4y2')).unit_price,numbered.unit_price,'the chosen count reaches source cost formulas');
 assert.match((await price(v.id,{panels_across:'4'})).error,/counts are fixed/);
 await reviewed(call);await call('PUT','/api/admin/products/88/status',{status:'live'});await call('POST','/api/admin/publish',{});
 assert.ok(!(await get(false)).options.some(o=>o.id==='781x7y2'));
 assert.equal((await call('PUT','/api/admin/catalog-controls/layout-counts:781',{across:[2,7]})).status,200);
 assert.ok((await get(true)).options.some(o=>o.id==='781x7y2'));assert.ok(!(await get(false)).options.some(o=>o.id==='781x7y2'));
 const restored=(await call('GET','/api/admin/products/88/configurators/door/preview?layout_ids=781x3y2')).data.sections.flatMap(s=>s.items).find(i=>i.kind==='layout');assert.equal(restored.options.find(o=>o.id==='781x3y2').retained,true);
 const visual=(await get(true)).options.find(o=>o.id==='781x7y2').visual;
 await call('PUT','/api/admin/catalog-controls/layout:781x7y2',{...visual,reviewed:true});
 assert.equal((await call('GET','/api/admin/catalog-controls')).data.layouts.find(o=>o.id==='781x7y2').visual.reviewed,true);
 await call('POST','/api/admin/publish',{});assert.ok((await get(false)).options.some(o=>o.id==='781x7y2'));
 assert.equal((await get(false)).options.find(o=>o.id==='781x7y2').visual.reviewed,true);
 assert.equal(JSON.stringify(DB.raw.prepare('SELECT source_table,source_id,data_json FROM oe_records ORDER BY source_table,source_id').all()),before);
 // Conflict mapping is tied to the source, inherited by every numbered identity.
 await S.oeConflictChange('oe-test','d781',{add:['a168']},'fixture');
 assert.equal((await price(v.id)).status,'not_allowed');
});

test('admin area is editable metadata and does not change the customer input connection',async()=>{
 const {call}=await setup();
 const setting={scope:'product',design_id:'88',name:'engraving_text',label:'Engraving',control:'text',settings:{admin_area:'instructions'},default:'',show_door:true,show_planner:true};
 const made=await call('PUT','/api/admin/attributes',setting);assert.equal(made.status,200);
 const id=made.data.id;
 let list=(await call('GET','/api/admin/attributes')).data.attributes;
 assert.equal(list.find(a=>a.id===id).settings.admin_area,'instructions');
 assert.equal((await call('PUT','/api/admin/attributes',{...setting,id,settings:{admin_area:'options'}})).status,200);
 list=(await call('GET','/api/admin/attributes')).data.attributes;
 assert.equal(list.find(a=>a.id===id).name,'engraving_text');
 assert.equal(list.find(a=>a.id===id).settings.admin_area,'options');
 assert.equal((await call('PUT','/api/admin/attributes',{...setting,id,settings:{admin_area:'invalid'}})).status,400);
 const cfg=(await call('GET','/api/admin/products/88/configurators')).data;
 assert.deepEqual(cfg.modifications.raise_panels,[],'no raise modification is advertised without eligible raised panel options');
});


test('beaded profile drafts preserve repeat settings and reject invalid patterns',async()=>{
 const {call}=await setup();
 const profile={label:'Test bead',path:[[0,0],[2,0],[2,.375],[0,.375]],t:.375,tongue:[.131,.375],group:'3/8',feat:{kind:'bead',w:.34,mode:'count',count:2}};
 const r=await call('PUT','/api/admin/options/165/look',{look:{profile,accuracy:'approx'}});assert.equal(r.status,200);
 const d=(await call('GET','/api/admin/drawings')).data.kinds.find(k=>k.kind==='panel_style').options.find(o=>o.id==='165');
 assert.deepEqual(d.look.profile.feat,profile.feat);assert.equal(d.draft,true);
 assert.equal((await call('PUT','/api/admin/options/165/look',{look:{profile:{...profile,feat:{...profile.feat,count:0}}}})).status,400);
});

test('grain options default to source and accept explicit overrides in configurator pricing',async()=>{
 const {call}=await setup();
 const v=(await call('GET','/api/admin/products/88/configurators/door/preview')).data;
 const grain=v.sections.flatMap(s=>s.items).find(i=>i.key==='panel_grain');assert.equal(grain.default,'default');assert.deepEqual(grain.choices.map(c=>c.value),['default','vertical','horizontal']);
 assert.equal(v.product.grain_default,'vertical');
 const invalid=await call('POST','/api/admin/products/88/configurators/door/price',{attributes:{panel_grain:'diagonal'}});assert.equal(invalid.data.ok,false);
});


test('horizontal grain swaps source panel cut dimensions while retaining price and frame dimensions',async()=>{
 const {call,DB}=await setup();
 const row={id:'grain-test',design_id:'88',alias:'panel',source_json:JSON.stringify({exprs:{w:{alias:'width',expression:'10',evalInParentNS:true},l:{alias:'length',expression:'20',evalInParentNS:true},q:{alias:'qty',expression:'1',evalInParentNS:true}}})};
 DB.raw.prepare('INSERT INTO oe_records(snapshot_id,source_table,source_id,design_id,data_json,eligible) VALUES (?,?,?,?,?,1)').run('oe-test','part_formulas',row.id,'88',JSON.stringify(row));
 await call('PUT','/api/admin/variables',{scope:'type',design_type_id:'5',name:'sqft',formula:'2'});
 const calc=async grain=>(await call('POST','/api/admin/products/88/configurators/door/price',{options:{wood:'164'},attributes:{panel_grain:grain}})).data;
 const original=await calc('default'),horizontal=await calc('horizontal'),vertical=await calc('vertical');
 const p=original.parts.find(p=>p.alias==='panel'),h=horizontal.parts.find(p=>p.alias==='panel');assert.ok(p);assert.equal(h.width,p.length);assert.equal(h.length,p.width);assert.equal(h.qty,p.qty);assert.equal(horizontal.unit_price,original.unit_price);assert.deepEqual(vertical.parts,original.parts);
});


test('product list quick flags reflect drafts and toggling availability preserves the saved layout',async()=>{
 const {call}=await setup();
 const layout=[{kind:'option',key:'wood',section:'wood',rank:7,hidden:false}];
 await call('PUT','/api/admin/products/88/configurators/door',{enabled:true,layout});
 const list=(await call('GET','/api/admin/migration/products?include_configurators=1')).data;
 const product=list.rows.find(p=>p.design_id==='88');assert.ok(product);
 const door=product.configurators.find(c=>c.key==='door');assert.equal(door.enabled,true);assert.equal(door.status,'draft');
 assert.ok(product.configurators.some(c=>c.key==='planner'));assert.ok(!product.configurators.some(c=>c.key==='drawer_box'));
 assert.equal((await call('PUT','/api/admin/products/88/configurators/door',{enabled:false})).status,200);
 const links=(await call('GET','/api/admin/products/88/configurators')).data.links;
 assert.equal(links.find(l=>l.configurator==='door').enabled,false);assert.deepEqual(links.find(l=>l.configurator==='door').layout,layout);
 assert.equal((await call('PUT','/api/admin/products/88/configurators/door',{enabled:true})).status,200);
 const latest=(await call('GET','/api/admin/migration/products?include_configurators=1')).data.rows.find(p=>p.design_id==='88');assert.equal(latest.configurators.find(c=>c.key==='door').enabled,true);
});

test('premium boxes and cutlery trays offer independent kitchen visibility and planner-only products load',async()=>{
 const {DB,call}=await setup();
 DB.raw.exec("UPDATE oe_products SET name='Cutlery Tray-1',product_type='Box (Premium)' WHERE design_id='88'");
 DB.raw.exec("UPDATE oe_records SET data_json=json_set(data_json,'$.name','Box (Premium)') WHERE source_table='design_type' AND source_id='5'");
 const setupView=(await call('GET','/api/admin/products/88/configurators')).data;
 assert.ok(setupView.configurators.some(c=>c.key==='planner'));
 const flag=(await call('GET','/api/admin/migration/products?include_configurators=1')).data.rows.find(p=>p.design_id==='88');
 assert.ok(flag.configurators.some(c=>c.key==='planner'));
 assert.equal((await call('PUT','/api/admin/products/88/configurators/planner',{enabled:true})).status,200);
 assert.equal((await call('GET','/api/admin/drawer-boxes?for=planner')).data.products.length,1);
 DB.raw.exec("UPDATE oe_products SET lifecycle='live',classification='sellable' WHERE design_id='88'");
 await call('POST','/api/admin/publish',{});
 assert.equal((await call('GET','/api/catalog/drawer-boxes?for=planner',null,false)).data.products.length,1);
 assert.equal((await call('GET','/api/catalog/products/88/config?configurator=drawer_box&for=planner',null,false)).status,200);
 await call('PUT','/api/admin/products/88/configurators/drawer_box',{enabled:true});
 await call('PUT','/api/admin/products/88/configurators/planner',{enabled:false});
 await call('POST','/api/admin/publish',{});
 assert.equal((await call('GET','/api/catalog/drawer-boxes?for=planner',null,false)).data.products.length,0);
 assert.equal((await call('GET','/api/catalog/drawer-boxes',null,false)).data.products.length,1);
 assert.equal((await call('GET','/api/catalog/products/88/config?configurator=drawer_box&for=planner',null,false)).status,404);
});

test('the planners’ material looks: a wood’s look set in the Option library, by its name; customers get it after Publish, the admin’s preview right away', async () => {
  const { call } = await setup();
  const pub = async () => (await call('GET', '/api/catalog/material-looks', null, false)).data, staff = async () => (await call('GET', '/api/admin/material-looks')).data;
  assert.deepEqual((await pub()).woods, [], 'nothing set yet');
  assert.equal((await call('PUT', '/api/admin/options/164/look', { look: { texture: { source: 'recipe', species: 'maple', raw: '#d02020', adjust: { warmth: 10 } } } })).data.ok, true);
  assert.deepEqual((await pub()).woods, [], 'customers: not until Publish');
  const s1 = (await staff()).woods; assert.equal(s1.length, 1);
  assert.deepEqual([s1[0].name, s1[0].texture.source, s1[0].texture.species, s1[0].texture.raw], ['Maple, Hard', 'recipe', 'maple', '#D02020'], 'the admin’s preview: the draft, by its name');
  await call('POST', '/api/admin/publish', {});
  const w = (await pub()).woods; assert.equal(w.length, 1); assert.equal(w[0].name, 'Maple, Hard'); assert.equal(w[0].texture.raw, '#D02020');
  assert.ok(Array.isArray((await pub()).finishes));
  // changed again: customers keep the published look until the next Publish
  await call('PUT', '/api/admin/options/164/look', { look: { texture: { source: 'recipe', species: 'maple', raw: '#20D020' } } });
  assert.equal((await pub()).woods[0].texture.raw, '#D02020'); assert.equal((await staff()).woods[0].texture.raw, '#20D020');
  assert.equal((await call('GET', '/api/admin/material-looks', null, false)).status, 401, 'drafts: the admin only');
});

test('planner product links (Settings → Planner product links): set by hand, checked, used by the quote, cleared for good', async () => {
  const { DB, call } = await setup();
  // the corner shelf is linked to Keystone's Corner Shelf product (3836) the first time: not in this test catalog, so it shows as missing
  let r = await call('GET', '/api/admin/planner-links'); assert.equal(r.status, 200);
  assert.deepEqual(r.data.links.map(l => [l.type, l.design_id, l.missing]), [['cshelf', '3836', true]]);
  // a link needs a product that's there
  assert.equal((await call('PUT', '/api/admin/planner-links/b1d', { design_id: 'abc' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/planner-links/b1d', { design_id: '12345' })).status, 404);
  r = await call('PUT', '/api/admin/planner-links/b1d', { design_id: '88' }); assert.equal(r.status, 200);
  assert.deepEqual([r.data.link.type, r.data.link.design_id, r.data.link.name], ['b1d', '88', 'SRP-10-MP']);
  // the quote prices a linked planner product as that product, whatever its Mozaik name
  r = await call('POST', '/api/admin/planner/quote', { cabinets: [{ ref: 1, type: 'b1d', moz: 'No_Such_Mozaik_Cabinet', label: 'B1D 18', width: 18, height: 34.5, depth: 24 }] });
  assert.equal(r.status, 200); assert.equal(r.data.cabinets[0].product, '88');
  // a linked product that's removed: the quote says to relink it, and the list shows it as removed
  DB.raw.exec("INSERT INTO oe_removed_products (design_id, at, actor, reason) VALUES ('88', 'now', 'test', 'test')");
  r = await call('POST', '/api/admin/planner/quote', { cabinets: [{ ref: 1, type: 'b1d', moz: 'x', label: 'B1D 18', width: 18, height: 34.5, depth: 24 }] });
  assert.equal(r.data.cabinets[0].status, 'no_product'); assert.match(r.data.cabinets[0].message, /relink it/);
  assert.equal((await call('GET', '/api/admin/planner-links')).data.links.find(l => l.type === 'b1d').removed, true);
  assert.equal((await call('PUT', '/api/admin/planner-links/w2', { design_id: '88' })).status, 409);   // (a removed product can't be linked)
  // cleared: gone, and the corner shelf's first link doesn't come back
  assert.equal((await call('DELETE', '/api/admin/planner-links/cshelf')).status, 200);
  assert.deepEqual((await call('GET', '/api/admin/planner-links')).data.links.map(l => l.type), ['b1d']);
  assert.deepEqual((await call('GET', '/api/admin/planner-links')).data.links.map(l => l.type), ['b1d']);
  // only staff: customers can't see or change links
  assert.notEqual((await call('GET', '/api/admin/planner-links', null, false)).status, 200);
});

test('a wood look set in the Option library reaches the planners even when the import marked that option ineligible (the box\'s prefinished maple)', async () => {
  const { DB, call } = await setup();
  // Alder (169), marked not eligible, as an option the catalog doesn't sell can be
  DB.raw.exec("UPDATE oe_records SET eligible = 0 WHERE source_table = 'attribute_name' AND source_id = '169'");
  const texture = { source: 'recipe', species: 'maple', raw: '#EADCC2' };
  const r = await call('PUT', '/api/admin/options/169/look', { look: { texture } }); assert.equal(r.status, 200);
  // the admin's preview (drafts) has it straight away; customers once it's published
  const wood = d => (d.woods || []).find(w => String(w.id) === '169');
  assert.equal(wood((await call('GET', '/api/admin/material-looks')).data)?.texture.raw, '#EADCC2');
  assert.equal(wood((await call('GET', '/api/catalog/material-looks', null, false)).data), undefined);
  await call('POST', '/api/admin/publish', {});
  assert.equal(wood((await call('GET', '/api/catalog/material-looks', null, false)).data)?.texture.raw, '#EADCC2');
});

test('a photo used as grain: its base color is kept, and its details (average color, size, maps) go to whoever draws it', async () => {
  const { call } = await setup();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const id = (await call('POST', '/api/admin/textures', { name: 'Flat-sawn oak', color_map: png, thumb: png, width_in: 18, height_in: 36, swatch: '#B08A60' })).data.id;
  const r = await call('PUT', '/api/admin/options/164/look', { look: { texture: { source: 'photo', id, raw: '#c68b5e', adjust: { warmth: 10 } } } });
  assert.equal(r.status, 200); assert.equal(r.data.look.look.texture.raw, '#C68B5E');
  const wood = (await call('GET', '/api/admin/material-looks')).data.woods.find(w => String(w.id) === '164');
  assert.equal(wood.texture.raw, '#C68B5E');
  assert.deepEqual(wood.texture.meta, { swatch: '#B08A60', width_in: 18, height_in: 36, has_normal: false, has_roughness: false });
});

test('the planners\' non-cabinet products are named by their linked products: drafts for staff, customers once orderable', async () => {
  const { call } = await setup();
  assert.equal((await call('PUT', '/api/admin/planner-links/gapB', { design_id: '88' })).status, 200);
  assert.deepEqual((await call('GET', '/api/admin/planner-names')).data.names.gapB, { id: '88', name: 'SRP-10-MP' });
  assert.equal((await call('GET', '/api/catalog/planner-names', null, false)).data.names.gapB, undefined);   // (a draft: not for customers)
  await call('PUT', '/api/admin/products/88/configurators/door', { enabled: true, layout: [] });
  await reviewed(call); await call('PUT', '/api/admin/products/88/status', { status: 'live' }); await call('POST', '/api/admin/publish', {});
  assert.deepEqual((await call('GET', '/api/catalog/planner-names', null, false)).data.names.gapB, { id: '88', name: 'SRP-10-MP' });
});

test('the planners’ woods: the Wood options with the admin’s changes (added, switched off), customers after Publish, the admin’s preview right away', async () => {
  const { call } = await setup();
  const { createRequire } = await import('node:module'), { sortWoods } = createRequire(import.meta.url)('../shared/materials.js');
  const species = JSON.parse((await import('node:fs')).readFileSync(new URL('../shared/materials.json', import.meta.url), 'utf8')).species;
  const pub = async () => (await call('GET', '/api/catalog/material-looks', null, false)).data.woodOptions, staff = async () => (await call('GET', '/api/admin/material-looks')).data.woodOptions;
  const names = list => list.filter(o => !o.off).map(o => o.name).sort();
  assert.deepEqual(names(await pub()), ['Alder', 'Cherry', 'Maple, Hard', 'Walnut'], 'the Wood options, as imported');
  // the admin switches Walnut off and adds Poplar
  assert.equal((await call('POST', '/api/admin/options/retire', { ids: ['168'], retired: true })).data.ok, true);
  assert.equal((await call('POST', '/api/admin/options/new', { type_id: '5', name: 'Poplar' })).data.ok, true);
  assert.deepEqual(names(await staff()), ['Alder', 'Cherry', 'Maple, Hard', 'Poplar'], 'the admin’s preview: right away');
  assert.deepEqual(names(await pub()), ['Alder', 'Cherry', 'Maple, Hard', 'Walnut'], 'customers: not until Publish');
  await call('POST', '/api/admin/publish', {});
  const p = await pub();
  assert.deepEqual(names(p), ['Alder', 'Cherry', 'Maple, Hard', 'Poplar'], 'published: in the planners');
  const r = sortWoods(p, species);
  assert.equal(r.leftOut.find(x => x.name === 'Walnut').why, 'Switched off in the options library');
  assert.ok(r.woods.some(w => w.name === 'Poplar') && !r.woods.some(w => w.name === 'Walnut'));
});

test('the planners’ finishes: the Finish options, each with the type set in the admin (a draft until Publish); a color keeps it, Not set clears it', async () => {
  const { call } = await setup();
  const pub = async () => (await call('GET', '/api/catalog/material-looks', null, false)).data.finishOptions, staff = async () => (await call('GET', '/api/admin/material-looks')).data.finishOptions;
  const by = (list, n) => list.find(o => o.name === n), look = (id, l) => call('PUT', `/api/admin/options/${id}/look`, { look: l }), typeOf = async id => ((await call('GET', `/api/admin/options/${id}`)).data.look?.look?.finish || {}).type;
  assert.deepEqual((await pub()).map(o => o.name).sort(), ['Antique Navy (D)', 'Cafe (M)', 'Harvest Glaze (L)'], 'the Finish options');
  // a type on its own: in the admin’s preview at once, the planners after Publish
  assert.equal((await look('301', { finish: { type: 'paint' } })).data.ok, true);
  assert.equal(by(await staff(), 'Cafe (M)').type, 'paint'); assert.equal(by(await pub(), 'Cafe (M)').type, undefined, 'not until Publish');
  await call('POST', '/api/admin/publish', {});
  assert.equal(by(await pub(), 'Cafe (M)').type, 'paint');
  // a color from the look editor: the type stays while it’s the same paint or stain, goes when it isn’t; Not set clears it
  await look('303', { finish: { type: 'glazed-stain' } });
  await look('303', { finish: { kind: 'stain', color: '#884422' } }); assert.equal(await typeOf('303'), 'glazed-stain', 'still a stain: the type stays');
  await look('303', { finish: { kind: 'paint', color: '#112233' } }); assert.equal(await typeOf('303'), undefined, 'now a paint: not a glazed stain any more');
  await look('303', { finish: { type: 'painted-glaze', color: '#112233' } }); assert.equal(await typeOf('303'), 'painted-glaze');
  await look('303', { finish: { kind: 'paint', color: '#112233', type: null } }); assert.equal(await typeOf('303'), undefined, 'Not set: cleared');
  assert.equal((await look('303', { finish: { type: 'lacquer' } })).status, 400, 'not one of the types');
  // switched off in the admin: marked off (the planners set it aside)
  await call('POST', '/api/admin/options/retire', { ids: ['302'], retired: true });
  assert.equal(by(await staff(), 'Antique Navy (D)').off, true);
});

test('a product type’s values: the SQL’s own discontinued (a draft, with its option values gone from the type) and restored; which products read one', async () => {
  const { call, DB } = await setup();
  const { storage } = await import('../server/storage/d1.mjs'), S = storage(DB);
  const wood = async () => (await call('GET', '/api/admin/types/5')).data.attributes.find(a => a.alias === 'wood');
  const field = async al => (await wood()).fields.find(f => f.alias === al), dta = (await wood()).dta;
  const built = async () => { const T = await S.oeDesignSource('oe-test', '88', 'all'); return { fields: T.attribute_value_alias.map(f => f.alias), costValues: T.attribute_value.filter(v => String(v.attribute_value_alias_id) === '44').length }; };
  assert.deepEqual((await wood()).fields.map(f => [f.alias, f.added, f.off]), [['cost', false, false], ['thickness', false, false]]);
  // which products read it
  const use = async al => (await call('GET', `/api/admin/types/5/fields/use?dta=${dta}&alias=${al}`)).data;
  const cu = await use('cost'); assert.equal(cu.n, 1, 'the door’s formula reads wood.cost'); assert.equal(cu.names.length, 1); assert.equal((await use('thickness')).n, 0);
  const before = await built(); assert.ok(before.fields.includes('cost')); assert.ok(before.costValues > 0, 'the options have cost values to lose');
  // discontinued: marked off (a draft), and gone from the type’s values, with every option’s value for it
  const r = await call('DELETE', '/api/admin/types/5/fields', { dta, alias: 'cost' }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.discontinued, true);
  assert.deepEqual([(await field('cost')).off, (await field('cost')).draft], [true, true]);
  const after = await built(); assert.ok(!after.fields.includes('cost'), 'gone from the type’s values'); assert.equal(after.costValues, 0, 'and its options’ values');
  assert.ok(after.fields.includes('thickness'), 'the other value untouched');
  assert.equal((await call('DELETE', '/api/admin/types/5/fields', { dta, alias: 'cost' })).status, 400, 'already discontinued');
  // restored before publishing: the draft is dropped, as it was
  assert.equal((await call('PUT', '/api/admin/types/5/fields', { dta, alias: 'cost', restore: true })).status, 200);
  assert.deepEqual([(await field('cost')).off, (await field('cost')).draft], [false, false]); assert.equal((await built()).costValues, before.costValues);
  // discontinued and published, then restored: a restore draft until the next Publish
  await call('DELETE', '/api/admin/types/5/fields', { dta, alias: 'cost' }); await call('POST', '/api/admin/publish', {});
  assert.deepEqual([(await field('cost')).off, (await field('cost')).draft], [true, false], 'published');
  await call('PUT', '/api/admin/types/5/fields', { dta, alias: 'cost', restore: true });
  assert.deepEqual([(await field('cost')).off, (await field('cost')).draft], [false, true], 'restored: a draft');
  assert.equal((await call('PUT', '/api/admin/types/5/fields', { dta, alias: 'cost', restore: true })).status, 400, 'not discontinued now');
});

test('the catalog’s categories: folders and subfolders with the products in each, a draft until Publish (customers see the published), discarded; a bad tree refused', async () => {
  const { call } = await setup();
  const pub = async () => (await call('GET', '/api/catalog/categories', null, false)).data.categories, admin = async () => (await call('GET', '/api/admin/categories')).data;
  const tree = [{ id: 'cdoors', name: 'Door & Drawer Fronts', children: [{ id: 'cstd', name: 'Standard', children: [{ id: 'cstd1', name: 'Standard 1 Panel', children: [] }] }, { id: 'cmit', name: 'Mitred', children: [] }] }];
  assert.deepEqual(await pub(), { tree: [], products: {} }, 'none yet');
  const r = await call('PUT', '/api/admin/catalog-controls/categories', { tree, products: { 88: ['cstd1', 'cmit', 'cstd1', 'cgone'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = await admin(); assert.equal(a.draft, true); assert.equal(a.categories.tree[0].children[0].children[0].name, 'Standard 1 Panel');
  assert.deepEqual(a.categories.products, { 88: ['cstd1', 'cmit'] }, 'each folder once; a folder that isn’t there dropped');
  assert.deepEqual(await pub(), { tree: [], products: {} }, 'customers: not until Publish');
  await call('POST', '/api/admin/publish', {});
  assert.deepEqual((await pub()).products, { 88: ['cstd1', 'cmit'] }); assert.equal((await admin()).draft, false);
  // a folder deleted: its products' places in it go with it; discarded, back to the published
  const less = [{ ...tree[0], children: [tree[0].children[1]] }];
  await call('PUT', '/api/admin/catalog-controls/categories', { tree: less, products: (await admin()).categories.products });
  assert.deepEqual((await admin()).categories.products, { 88: ['cmit'] });
  await call('DELETE', '/api/admin/catalog-controls/categories');
  assert.deepEqual((await admin()).categories.products, { 88: ['cstd1', 'cmit'] }, 'discarded: the published again');
  // refused
  const bad = async t => (await call('PUT', '/api/admin/catalog-controls/categories', { tree: t, products: {} })).status;
  assert.equal(await bad([{ id: 'ca', name: 'A', children: [] }, { id: 'ca', name: 'B', children: [] }]), 400, 'two folders, one id');
  assert.equal(await bad([{ id: 'ca', name: '  ', children: [] }]), 400, 'no name');
  let deep = []; for (let k = 9; k >= 0; k--) deep = [{ id: 'cd' + k, name: 'L' + k, children: deep }];
  assert.equal(await bad(deep), 400, 'more than 8 levels');
});

test('the catalog’s categories: where each folder shows (the configurators listed; none listed, it follows the folder it’s in)', async () => {
  const { call } = await setup();
  const tree = [{ id: 'cdoors', name: 'Door & Drawer Fronts', show: ['door', 'planner', 'door', 'nonsense'], children: [{ id: 'cstd', name: 'Standard', children: [] }, { id: 'cfr', name: 'Fronts', show: ['drawer_front'], children: [] }] }];
  assert.equal((await call('PUT', '/api/admin/catalog-controls/categories', { tree, products: {} })).status, 200);
  const t = (await call('GET', '/api/admin/categories')).data.categories.tree;
  assert.deepEqual(t[0].show, ['door', 'planner'], 'each once, only the configurators there are');
  assert.equal(t[0].children[0].show, undefined, 'none listed: follows its folder');
  assert.deepEqual(t[0].children[1].show, ['drawer_front']);
});
