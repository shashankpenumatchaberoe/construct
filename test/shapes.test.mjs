// #619 -- screen shapes. The list shape writes real, typed units from templates: its names and fields are read by fixed rules,
// the output is a pure function of the request (byte-identical on a second run), a request that cannot be built writes
// nothing, and a plural list in a requirement card is OFFERED the shape as a closed question (never forced, never a model).
// The whole path on a real `construct init` project (validate, tsc, render) is test/list-shape-chain.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAN_FLOWS, PLAN_SHAPES, planToCommand, validatePlan } from '../packages/core/plan.mjs';
import { expectedFiles } from '../packages/core/plan-touches.mjs';
import { flowBlock } from '../packages/core/block-flows.mjs';
import { parseRequirement } from '../packages/core/requirement-card.mjs';
import { placeCard, planFromBlocks, blockSummary, SHAPE_OPTIONS, SHAPE_QUESTION_ID } from '../packages/core/placement.mjs';
import { suggest } from '../packages/core/decision-provider.mjs';
import { SHAPES, endpointOf, fieldsFromProperties, generateShapeLayer, generateShapeVertical, parseFields, shapeContext, shapeFiles, shapeTouches, singularOf } from '../packages/core/shapes.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'packages', 'cli', 'construct.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd });
const LAYERS = ['domain', 'service', 'hook', 'component', 'page', 'controller'];
const REQUEST = { shape: 'list', name: 'Products', feature: 'shop', entity: 'Product', fields: 'id:string,name:string,price:number' };

/** A fresh `construct init` project with one feature, ready for a shape. */
function project(framework = 'react-spa') {
  const dir = makeTempDir('construct-shape-');
  assert.equal(run(['init', '--framework', framework], dir).status, 0);
  assert.equal(run(['create', 'feature', 'shop'], dir).status, 0);
  return dir;
}
const tree = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter((f) => f.startsWith('features') && fs.statSync(path.join(dir, f)).isFile()).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('the plan registry, the shape table and the templates name the same shapes', () => {
  assert.deepEqual([...PLAN_SHAPES], Object.keys(SHAPES));
  for (const id of ['create.unit', 'create.layer']) {
    assert.deepEqual(PLAN_FLOWS[id].args.shape.enum, [...PLAN_SHAPES]);
    assert.deepEqual(['shape', 'entity', 'fields'].map((a) => PLAN_FLOWS[id].args[a].flag), ['--shape', '--entity', '--fields']);
    assert.ok(['shape', 'entity', 'fields'].every((a) => !PLAN_FLOWS[id].args[a].required), 'additive: a step without them is what it was');
  }
  for (const shape of Object.values(SHAPES)) {
    for (const [layer, needed] of Object.entries(shape.requires)) assert.ok(shape.layers.includes(layer) && needed.every((l) => shape.layers.includes(l)), `${layer} requires only layers of the shape`);
  }
});

test('the entity is the singular of the unit name by fixed rules, and a name the rules leave alone gets Item', () => {
  const cases = { Products: 'Product', Categories: 'Category', Boxes: 'Box', Statuses: 'Status', Addresses: 'Address', OrderItems: 'OrderItem', Inventory: 'InventoryItem', Sheep: 'SheepItem', Glass: 'GlassItem', Bus: 'BusItem' };
  for (const [plural, singular] of Object.entries(cases)) assert.equal(singularOf(plural), singular, plural);
  assert.equal(endpointOf('Products'), '/api/products');
  assert.equal(endpointOf('OrderItems'), '/api/order-items');
});

test('fields are name:type pairs with an id; every mistake is named and nothing is guessed', () => {
  assert.deepEqual(parseFields(undefined), [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }], 'the default');
  assert.deepEqual(parseFields('id:number, price:number ,isActive:boolean'), [{ name: 'id', type: 'number' }, { name: 'price', type: 'number' }, { name: 'isActive', type: 'boolean' }]);
  const bad = { 'name:string': /need an "id" field/, 'id:string,price': /must be name:type/, 'id:string,Price:number': /camelCase/, 'id:string,tags:string[]': /has type "string\[\]"/, 'id:string,id:number': /listed twice/, 'id:boolean': /string or a number/, [`id:string,${'abcdefghijklm'.split('').map((c) => `${c}:string`).join(',')}`]: /at most 12 fields/ };
  for (const [text, message] of Object.entries(bad)) assert.throws(() => parseFields(text), message, text);
});

test('the fields of a card entity are typed by the name of each property, and screen-only properties are left out', () => {
  assert.equal(fieldsFromProperties(['name', 'price']), 'id:string,name:string,price:number');
  assert.equal(fieldsFromProperties(['planName', 'status', 'quantity', 'isActive', 'interactive', 'session']), 'id:string,planName:string,status:string,quantity:number,isActive:boolean');
  assert.equal(fieldsFromProperties([]), 'id:string,name:string');
  assert.equal(fieldsFromProperties(undefined), 'id:string,name:string');
});

test('the same request gives the same files, byte for byte, and each file is named Name.layer.ext', () => {
  const dir = project();
  const first = LAYERS.flatMap((layer) => shapeFiles(dir, { ...REQUEST, layer }));
  const second = LAYERS.flatMap((layer) => shapeFiles(dir, { ...REQUEST, layer }));
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((f) => path.relative(dir, f.path)), [
    'features/shop/domain/Products.domain.ts', 'features/shop/types.ts', 'features/shop/services/Products.service.ts', 'features/shop/hooks/useProducts.state.ts',
    'features/shop/components/ProductRow.component.tsx', 'features/shop/components/ProductList.component.tsx', 'features/shop/components/ProductsNotice.component.tsx',
    'features/shop/pages/ProductsPage.page.tsx', 'features/shop/expressions/ProductsByStatus.expression.tsx', 'features/shop/controllers/ProductsController.controller.tsx',
  ]);
  assert.deepEqual(first.filter((f) => f.change === 'modify').map((f) => path.basename(f.path)), ['types.ts'], 'only the feature types are modified, by the domain layer');
  // Each unit is built through the typed factory of its layer.
  const text = (name) => first.find((f) => f.path.endsWith(name)).content;
  assert.match(text('Products.domain.ts'), /defineDomain</);
  assert.match(text('Products.service.ts'), /defineService\('fetchProducts', async \(\{ signal \}: \{ signal: AbortSignal \}\)/);
  assert.match(text('useProducts.state.ts'), /useTrackedState<ProductsState>/);
  assert.match(text('ProductRow.component.tsx'), /defineComponent</);
  assert.match(text('ProductsByStatus.expression.tsx'), /defineExpression</);
  assert.match(text('ProductsPage.page.tsx'), /definePage</);
  assert.match(text('ProductsController.controller.tsx'), /defineController</);
  assert.ok(first.every((f) => !/\bTODO\b/.test(f.content)), 'no stub is left for a person to fill');
  assert.ok(first.every((f) => !/\{\{|\bundefined\b/.test(f.content)), 'no placeholder leaks into the output');
});

test('the framework decides the directive: a Next.js hook and controller are client files, a Vite SPA needs none', () => {
  for (const [framework, expected] of [['nextjs', true], ['react-spa', false]]) {
    const dir = project(framework);
    for (const layer of ['hook', 'controller']) {
      const [file] = shapeFiles(dir, { ...REQUEST, layer });
      assert.equal(file.content.startsWith("'use client';\n"), expected, `${framework} ${layer}`);
    }
    assert.equal(shapeFiles(dir, { ...REQUEST, layer: 'page' })[0].content.includes('use client'), false, 'a page stays presentational');
  }
});

test('the fields shape the row, the sort and the boundary check of the service', () => {
  const dir = project();
  const files = (fields) => Object.fromEntries(['domain', 'service', 'component'].flatMap((layer) => shapeFiles(dir, { ...REQUEST, fields, layer })).map((f) => [path.basename(f.path), f.content]));
  const a = files('id:string,title:string,price:number,isActive:boolean');
  assert.match(a['Products.domain.ts'], /a\.title\.localeCompare\(b\.title\)/, 'sorted by the title field');
  assert.match(a['ProductRow.component.tsx'], /<strong>\{item\.title\}<\/strong>/);
  assert.match(a['ProductRow.component.tsx'], /<span>\{`price: \$\{String\(item\.price\)\}`\}<\/span>[\s\S]*<span>\{`isActive: \$\{String\(item\.isActive\)\}`\}<\/span>/);
  assert.match(a['Products.service.ts'], /typeof row\.id === 'string' && typeof row\.title === 'string' && typeof row\.price === 'number' && typeof row\.isActive === 'boolean'/);
  const b = files('id:number,price:number');
  assert.match(b['Products.domain.ts'], /a\.id - b\.id/, 'no string field: sorted by the id');
  assert.match(b['ProductRow.component.tsx'], /<strong>\{String\(item\.id\)\}<\/strong>/);
});

test('a bad request is a usage error that names the problem, before anything is written', () => {
  const dir = project();
  const before = tree(dir);
  const refused = (request, message) => assert.throws(() => generateShapeVertical(dir, { ...REQUEST, ...request }, LAYERS), message, JSON.stringify(request));
  refused({ shape: 'grid' }, /Unknown shape "grid"/);
  refused({ name: '3d-list' }, /can't be turned into a valid TypeScript identifier/);
  refused({ entity: 'product' }, /must be PascalCase/);
  refused({ name: 'Product', entity: 'Product' }, /clashing names/);
  refused({ fields: 'name:string' }, /need an "id" field/);
  assert.throws(() => generateShapeLayer(dir, { ...REQUEST, layer: 'workflow' }), /has no "workflow" layer/);
  assert.throws(() => generateShapeVertical(dir, REQUEST, ['service', 'hook']), /import[s]? domain[\s\S]*--layers domain,service,hook[\s\S]*Nothing was written/);
  assert.throws(() => generateShapeVertical(dir, REQUEST, ['controller']), /hook, page/);
  assert.deepEqual(tree(dir), before, 'nothing was written by any of them');
  assert.equal(shapeTouches(dir, { ...REQUEST, fields: 'oops' }), null, 'touches never throws: an invalid request has no derivable files');
  assert.equal(shapeContext(dir, { shape: 'list', name: 'Products', feature: 'shop' }).request.entity, 'Product', 'the entity defaults to the singular');
});

test('a required layer that already exists satisfies a smaller request', () => {
  const dir = project();
  generateShapeVertical(dir, REQUEST, ['domain', 'service', 'hook', 'component']);
  assert.deepEqual(generateShapeLayer(dir, { ...REQUEST, layer: 'page' }).map((f) => path.basename(f)), ['ProductsPage.page.tsx', 'ProductsByStatus.expression.tsx']);
  assert.deepEqual(generateShapeLayer(dir, { ...REQUEST, layer: 'controller' }).map((f) => path.basename(f)), ['ProductsController.controller.tsx']);
});

test('types.ts keeps what a person wrote: an existing declaration is not replaced, a missing one is appended, a second run changes nothing', () => {
  const dir = project();
  const types = path.join(dir, 'features', 'shop', 'types.ts');
  fs.appendFileSync(types, 'export interface Product { id: string; name: string; price: number; sku: string }\n');
  generateShapeLayer(dir, { ...REQUEST, layer: 'domain' });
  const once = fs.readFileSync(types, 'utf8');
  assert.match(once, /sku: string/, 'the hand-written Product is kept');
  assert.equal((once.match(/export interface Product\b/g) ?? []).length, 1);
  assert.match(once, /export type ProductsState =/);
  assert.match(once, /export type ProductsResult =/);
  generateShapeLayer(dir, { ...REQUEST, layer: 'domain' });
  assert.equal(fs.readFileSync(types, 'utf8'), once, 'idempotent');
});

test('a whole run twice on two fresh projects, and again on the same project, writes identical bytes', () => {
  const [a, b] = [project(), project()];
  for (const dir of [a, b]) generateShapeVertical(dir, REQUEST, LAYERS);
  const firstRun = tree(a);
  assert.deepEqual(tree(b), firstRun, 'two projects');
  generateShapeVertical(a, REQUEST, LAYERS);
  assert.deepEqual(tree(a), firstRun, 'the same project again');
});

test('a shaped plan step declares every file it writes (the approval gate refuses any other), for the unit and the layer flow', () => {
  const dir = project();
  const unit = expectedFiles(dir, 'create.unit', { layer: 'domain', name: 'Products', feature: 'shop', shape: 'list', entity: 'Product', fields: 'id:string' });
  assert.deepEqual(unit.map((f) => `${f.change} ${f.path}`), ['create features/shop/domain/Products.domain.ts', 'modify features/shop/types.ts']);
  const layer = expectedFiles(dir, 'create.layer', { name: 'Products', feature: 'shop', layers: ['controller', 'page', 'domain'], shape: 'list' });
  assert.deepEqual(layer.map((f) => f.layer), ['domain', 'domain', 'page', 'page', 'controller'], 'in generation order, whatever order the step lists them');
  assert.equal(expectedFiles(dir, 'create.unit', { layer: 'domain', name: 'Products', feature: 'shop', shape: 'grid' }), null, 'an unknown shape derives nothing');
  const unshaped = expectedFiles(dir, 'create.unit', { layer: 'page', name: 'Products', feature: 'shop' });
  assert.deepEqual(unshaped.map((f) => f.path), ['features/shop/pages/ProductsPage.tsx'], 'a step without a shape is unchanged');
  assert.deepEqual(flowBlock('create.unit').declaredScope({ layer: 'page', name: 'Products', feature: 'shop', shape: 'list' }, { root: dir }).files.map((f) => path.basename(f.path)), ['ProductsPage.page.tsx', 'ProductsByStatus.expression.tsx']);
});

test('planToCommand turns a shaped step into the real CLI command, and validatePlan checks the shape argument', () => {
  const step = { flow: 'create.unit', args: { layer: 'hook', name: 'Products', feature: 'shop', shape: 'list', entity: 'Product', fields: 'id:string,name:string' } };
  assert.deepEqual(planToCommand(step).argv, ['create', 'hook', 'Products', '--feature', 'shop', '--shape', 'list', '--entity', 'Product', '--fields', 'id:string,name:string']);
  const plan = (args) => ({ version: 1, ticket: { source: 'text', title: 't' }, steps: [{ id: 's1', title: 'x', flow: 'create.unit', args, executor: 'deterministic', touches: { features: ['shop'], files: [] } }] });
  assert.equal(validatePlan(plan(step.args)).valid, true);
  const bad = validatePlan(plan({ ...step.args, shape: 'grid' }));
  assert.deepEqual(bad.errors.map((e) => e.code), ['STEP_ARG_ENUM']);
});

// ---------------------------------------------------------------------------------------------------------------- the CLI

test('construct create: --shape writes the units, --format json lists them, and a mistake exits with a usage error', () => {
  const dir = project();
  const args = ['create', 'layer', 'Products', '--feature', 'shop', '--layers', LAYERS.join(','), '--shape', 'list', '--entity', 'Product', '--fields', 'id:string,name:string,price:number'];
  const json = JSON.parse(run([...args, '--format', 'json'], dir).stdout);
  assert.equal(json.ok, true);
  assert.equal(json.shape, 'list');
  assert.equal(json.files.length, 10);
  assert.ok(json.files.includes('features/shop/pages/ProductsPage.page.tsx'));

  const single = run(['create', 'component', 'Orders', '--feature', 'shop', '--shape', 'list'], dir);
  assert.notEqual(single.status, 0, 'a component alone needs the domain layer the types come from');
  assert.match(single.stderr, /domain/);

  const stray = run(['create', 'page', 'Products', '--feature', 'shop', '--fields', 'id:string'], dir);
  assert.notEqual(stray.status, 0);
  assert.match(stray.stderr, /--fields only applies with --shape/);
  const llm = run(['create', 'page', 'Products', '--feature', 'shop', '--shape', 'list', '--llm', 'ollama'], dir);
  assert.notEqual(llm.status, 0);
  assert.match(llm.stderr, /no model/);
  const unknown = JSON.parse(run(['create', 'layer', 'Things', '--feature', 'shop', '--layers', 'domain', '--shape', 'grid', '--format', 'json'], dir).stdout);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'USAGE_ERROR');
});

test('construct create: --shape declares the typed-contracts dependency itself, through add.dependency, instead of just telling a person to (#678)', () => {
  const dir = project();
  const pkgPath = path.join(dir, 'package.json');
  const before = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(!before.dependencies?.['@line/construct-core'], 'a fresh init project does not declare it yet');
  const otherDeps = { ...before.dependencies };

  const out = run(['create', 'layer', 'Products', '--feature', 'shop', '--layers', 'domain,service', '--shape', 'list'], dir).stdout;
  assert.match(out, /Created features\/shop\/domain\/Products\.domain\.ts/);
  assert.match(out, /Updated features\/shop\/types\.ts/);
  assert.match(out, /Added "@line\/construct-core": "\^0\.9\.0" to package\.json \(dependencies\)/);
  assert.match(out, /restricted GitHub Packages registry, not the public npm registry/, 'says so rather than silently adding an unresolvable dependency (#678)');

  const after = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(after.dependencies['@line/construct-core'], '^0.9.0', 'the plan/approval line, added via the same addDependency the add.dependency flow uses, not a hand-written note');
  for (const [name, range] of Object.entries(otherDeps)) assert.equal(after.dependencies[name], range, `an already-present dependency (${name}) is left alone`);

  // Idempotent: a second shaped generation into the same project neither re-adds nor re-announces it.
  const again = run(['create', 'layer', 'Products', '--feature', 'shop', '--layers', 'domain', '--shape', 'list'], dir).stdout;
  assert.doesNotMatch(again, /Added |Note:/);
  assert.deepEqual(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies, after.dependencies, 'unchanged once the dependency is already declared');
});

// ------------------------------------------------------------------------------------------------- the Requirement chain

const cardOf = (text) => parseRequirement(text).card;
const offers = (text, options) => placeCard(cardOf(text), options).offers;

test('a plural list is offered the list shape as a closed question of two options, with the rules default', () => {
  const result = placeCard(cardOf('A user wants to see a list of products'), { framework: 'react-spa' });
  assert.equal(result.complete, true, 'the offer does not hold the plan back');
  assert.deepEqual(result.open, []);
  const [offer] = result.offers;
  assert.equal(offer.id, SHAPE_QUESTION_ID);
  assert.deepEqual(Object.keys(offer).slice(0, 4), ['id', 'question', 'options', 'chosen'], 'the shape of a chooser summary');
  assert.deepEqual(offer.options.map((o) => [o.id, o.enabled]), [['list', true], ['scaffold', true]]);
  assert.deepEqual(SHAPE_OPTIONS.map((o) => o.id), ['list', 'scaffold']);
  assert.deepEqual([offer.default, offer.chosen, offer.entity, offer.fields, offer.unit, offer.block], ['list', null, 'Product', 'id:string,name:string,price:number', 'Products', 'b1']);
  assert.deepEqual(blockSummary(result).offers.map((o) => [o.id, o.chosen, o.default]), [['q-shape', null, 'list']], 'the summary carries it, at a fixed size');
  assert.ok(JSON.stringify(blockSummary(result).offers).length < 900);
  // The rules-only decision provider suggests the default; nothing else is needed to choose it.
  const summary = { id: offer.id, question: offer.question, options: offer.options };
  return suggest(summary).then((s) => assert.deepEqual([s.option, s.provider], ['list', 'rules']));
});

test('the offer is made by fixed rules: a plural data object read alone, and nothing richer', () => {
  const yes = ['A user wants to see a list of products', 'A customer wants to browse the products', 'A user wants to view the orders', 'A visitor wants to see the invoices'];
  for (const text of yes) assert.equal(offers(text).length, 1, text);
  const no = [
    'A customer wants to see their current subscription plan', // one plan, not a list
    'A customer wants to see their billing details', // "billing details" is one data object, plural in form only
    'A customer wants to search products with instant keyboard filtering.', // a search with a client leaf
    'A logged-in user wants to see their current subscription plan and click a button to manage their billing details via Stripe.',
    'A user wants to see products and orders', // two data objects: a later slice
    'A user wants to see the products and delete an order',
  ];
  for (const text of no) assert.deepEqual(offers(text), [], text);
  assert.deepEqual(offers('A user wants to see a list of products', { screen: 'Catalog' }), [], 'a screen named otherwise is not the shape\'s unit name');
});

test('answering the offer applies the shape: blocks carry it, the attribution is recorded, and an unanswered offer changes nothing', () => {
  const card = cardOf('A user wants to see a list of products');
  const plain = placeCard(card, { framework: 'react-spa' });
  assert.deepEqual(plain.blocks.map((b) => b.placement), ['presentational']);
  assert.ok(plain.blocks.every((b) => b.shape === undefined));
  assert.deepEqual(plain.decisions, []);

  const scaffold = placeCard(card, { framework: 'react-spa', answers: { 'q-shape': 'scaffold' } });
  assert.deepEqual(scaffold.blocks, plain.blocks, 'choosing the scaffold is the plain plan');
  assert.deepEqual(scaffold.decisions, [{ question: 'q-shape', option: 'scaffold', by: 'person' }]);
  assert.equal(scaffold.offers[0].chosen, 'scaffold');

  const listed = placeCard(card, { framework: 'react-spa', answers: { 'q-shape': { option: 'list', by: 'decision-model', provider: 'rules' } } });
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(listed.blocks.map((b) => [b.id, b.placement, b.layers.map((l) => `${l.layer}:${l.name}`)]), [
    ['b1', 'server-read', ['domain:Products', 'service:Products', 'hook:Products', 'controller:Products']],
    ['b1-view', 'presentational', ['component:Products', 'page:Products']],
  ]);
  assert.ok(listed.blocks.every((b) => b.shape.name === 'list' && b.shape.entity === 'Product' && b.shape.fields === 'id:string,name:string,price:number'));
  assert.deepEqual(listed.decisions, [{ question: 'q-shape', option: 'list', by: 'decision-model', provider: 'rules' }]);
  assert.equal(listed.notes.length, 2);
  assert.match(listed.notes[1], /reads its rows through a service: choose where they come from \(q-source: .*\)\. The plan wires the route entry, runs sync/, '#654: the route entry is no longer a by-hand note');
  assert.deepEqual(blockSummary(listed).lines, ['"see list products" is a list fetched by a service (domain, service, hook, controller).', '"see list products" shows that list from props (component, page).']);
  assert.deepEqual(placeCard(card, { framework: 'nextjs', answers: { 'q-shape': 'list' } }).blocks.map((b) => b.layers.length), [4, 2], 'the app-router layer table is not used: the shape fetches in the browser');

  for (const [answers, code] of [[{ 'q-shape': 'grid' }, 'PLACE_UNKNOWN_OPTION'], [{ 'q-shape': { option: 'list', by: 'robot' } }, 'PLACE_ATTRIBUTION_INVALID']]) {
    assert.deepEqual(placeCard(card, { answers }).errors.map((e) => e.code), [code]);
  }
  assert.deepEqual(placeCard(cardOf('A user wants to see products and orders'), { answers: { 'q-shape': 'list' } }).errors.map((e) => e.code), ['PLACE_UNKNOWN_OPEN'], 'no offer, no such question');
  assert.deepEqual(placeCard(cardOf('A user wants to see a product'), { answers: { 'q-shape': 'list' } }).errors.map((e) => e.code), ['PLACE_UNKNOWN_OPTION'], 'a single read is offered detail, not list: the options belong to the card');
});

test('the plan of a list-shaped card is valid, every step carries the shape, and a card without the shape plans as before', () => {
  const dir = project();
  const card = cardOf('A user wants to see a list of products');
  const before = planFromBlocks(placeCard(card, { framework: 'react-spa' }).blocks, { feature: 'shop', root: dir });
  assert.deepEqual(before.plan.steps.map((s) => s.title), ['Create feature shop', 'Create component Products', 'Create page Products']);
  assert.ok(before.plan.steps.every((s) => !('shape' in s.args)));

  const placed = placeCard(card, { framework: 'react-spa', answers: { 'q-shape': 'list' } });
  const planned = planFromBlocks(placed.blocks, { feature: 'shop', root: dir, decisions: placed.decisions });
  assert.equal(planned.ok, true, JSON.stringify(planned.errors));
  assert.deepEqual(validatePlan(planned.plan), { valid: true, errors: [] });
  assert.deepEqual(planned.plan.steps.map((s) => s.title), ['Create feature shop', ...LAYERS.map((l) => `Create ${l} Products`), 'Add @line/construct-core to package.json', "Export the shop feature's public API (sync)", 'Wire the Products screen into the route entry (/products)', 'Type-check the project', 'Prove the Products screen', 'Run the proof of Products'], '#623, #654 and #632: a shaped screen is wired (dependency, sync, route), type-checked and ends with its proof and the read-only run of it');
  assert.deepEqual(planned.plan.steps.slice(1, 1 + LAYERS.length).map((s) => s.args.layer), LAYERS);
  for (const s of planned.plan.steps.slice(1, 1 + LAYERS.length)) assert.deepEqual([s.args.shape, s.args.entity, s.args.fields], ['list', 'Product', 'id:string,name:string,price:number']);
  assert.equal(planFromBlocks(placed.blocks, { feature: 'shop', root: dir, proof: false, wire: false }).plan.steps.length, 1 + LAYERS.length, 'proof: false and wire: false leave the plan as it was before #623 and #654');
  const stepOf = (layer) => planned.plan.steps.find((s) => s.args.layer === layer);
  assert.deepEqual(stepOf('page').dependsOn, ['s1', 's2', 's5'], 'the page waits for the domain (its types) and the component');
  assert.deepEqual(stepOf('controller').dependsOn, ['s1', 's4', 's6']);
  assert.deepEqual(planned.decisions, placed.decisions);
  assert.equal(planned.files.b1.length + planned.files['b1-view'].length, 11, 'the files of the two blocks are the ten of the shape and the local store (#621: an unanswered q-source is the rules default, local, in a project with no OpenAPI file)');
  assert.ok(planned.plan.steps.slice(1, 1 + LAYERS.length).every((s) => s.args.source === 'local'), 'every unit of the screen carries the source it was planned with');
  assert.ok(planned.files.b1.includes('features/shop/types.ts'));
  assert.deepEqual(planned.plan.steps[1].touches.files.map((f) => f.change), ['create', 'create', 'modify'], 'the domain unit, the local store, and types.ts');

  // A block with a malformed shape is refused by name, not planned.
  const broken = planFromBlocks(placed.blocks.map((b) => ({ ...b, shape: { name: 'grid', entity: 'X', fields: 'id:string' } })), { feature: 'shop', root: dir });
  assert.deepEqual(broken.errors.map((e) => e.code), ['PLAN_BLOCK_INVALID', 'PLAN_BLOCK_INVALID']);
});

test('the worked example in docs/PLACEMENT.md runs and produces exactly the JSON the doc shows', async () => {
  const doc = fs.readFileSync(path.join(here, '..', 'docs', 'PLACEMENT.md'), 'utf8');
  const block = (tag, lang) => new RegExp(`<!-- list-shape-example:${tag} -->\\n\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``).exec(doc)?.[1];
  const code = block('code', 'js');
  assert.ok(code, 'the doc carries the code block');
  const dir = project();
  const core = pathToFileURL(path.join(here, '..', 'packages', 'core')).href;
  const file = path.join(dir, 'doc-example.mjs');
  fs.writeFileSync(file, code
    .replace("'@line/construct-core/requirement-card'", `'${core}/requirement-card.mjs'`)
    .replace("'@line/construct-core/placement'", `'${core}/placement.mjs'`)
    .replace("'@line/construct-core/plan'", `'${core}/plan.mjs'`)
    .replace("'/path/to/project'", JSON.stringify(dir)));
  const shown = await import(pathToFileURL(file).href);
  for (const tag of ['question', 'decisions', 'commands', 'files']) {
    assert.deepEqual(JSON.parse(block(tag, 'json')), JSON.parse(JSON.stringify(shown[tag])), tag);
  }
  assert.equal(shown.commands.length, 13);
});
