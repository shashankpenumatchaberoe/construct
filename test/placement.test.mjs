// #641 -- the placement filter: three fixed questions decide client leaf, server read, mutation or presentational for each verb
// of a requirement card, the result is mapped to the project's layers and compiled to an ordinary plan. Deterministic, no
// model, no network. An ambiguous case is a closed question, never a guess. The worked example in docs/PLACEMENT.md is
// executed here so it cannot go stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultLexicon, parseRequirement } from '../packages/core/requirement-card.mjs';
import { DEFAULT_LAYERS, REACT_SPA_LAYERS } from '../packages/core/config.mjs';
import { validatePlan } from '../packages/core/plan.mjs';
import { suggest } from '../packages/core/decision-provider.mjs';
import { CHOOSER_LIMITS } from '../packages/core/chooser.mjs';
import {
  ANSWER_RULES, LAYER_TABLE, PLACEMENTS, PLACEMENT_ERROR_CODES, PLACEMENT_LIMITS, PLACEMENT_QUESTIONS, VARIANT_OF_FRAMEWORK,
  blockLines, blockSummary, checkPlacementImports, placeCard, planFromBlocks, resolvePlacementOpen,
} from '../packages/core/placement.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const codes = (r) => r.errors.map((e) => e.code);

const BILLING = 'A logged-in user needs to see their current subscription plan and be able to click a button to manage their billing details safely via Stripe.';
const UPLOAD = 'A user wants to upload a profile picture and see it update instantly.';
const SEARCH = 'A customer wants to search products with instant keyboard filtering.';
const cardOf = (text, options) => {
  const r = parseRequirement(text, options);
  assert.ok(r.card, JSON.stringify(r.errors));
  return r.card;
};
const place = (text, options) => {
  const result = placeCard(cardOf(text), options);
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  return result;
};
const shape = (result) => result.blocks.map((b) => `${b.id} ${b.placement}: ${b.layers.map((l) => `${l.layer} ${l.name}`).join(' + ')}`);
const project = () => makeTempDir('og641-');
const compile = (result, extra = {}) => planFromBlocks(result.blocks, { feature: 'billing', root: project(), ...extra });

test('the closed sets and error codes: three questions in order, four placements, a frozen name-to-name code map', () => {
  assert.deepEqual(PLACEMENT_QUESTIONS.map((q) => q.id), ['browserApi', 'touchesSecretOrDb', 'changesBackend']);
  assert.deepEqual(Object.keys(ANSWER_RULES), PLACEMENT_QUESTIONS.map((q) => q.id), 'every question has its rule list, in order');
  assert.deepEqual([...PLACEMENTS], ['client-leaf', 'server-read', 'mutation', 'presentational']);
  assert.equal(Object.isFrozen(PLACEMENT_ERROR_CODES), true);
  for (const [k, v] of Object.entries(PLACEMENT_ERROR_CODES)) assert.equal(k, v);
  assert.equal(PLACEMENT_LIMITS.options, CHOOSER_LIMITS.maxOptions);
  assert.deepEqual(VARIANT_OF_FRAMEWORK, { nextjs: 'app-router', 'react-spa': 'default' });
});

test('question 1 alone, browser API: an interact verb or an interactive part of the screen says yes; a table does not', () => {
  const answers = (text) => place(text).blocks[0].answers;
  assert.deepEqual(answers('A user can click a button.'), { browserApi: true, touchesSecretOrDb: false, changesBackend: false });
  assert.equal(answers('A user can see a form.').browserApi, true, 'a read through an interactive part still needs the browser');
  assert.deepEqual(answers('A user can see a table.'), { browserApi: false, touchesSecretOrDb: false, changesBackend: false });
  assert.equal(place('A user can click a button.').blocks[0].placement, 'client-leaf');
});

test('question 2 alone, secret or database: an outside service, a written entity, an entity behind a session or a server check says yes', () => {
  const answers = (text) => place(text).blocks[0].answers.touchesSecretOrDb;
  assert.equal(answers('A user can see Stripe.'), true, 'an outside service');
  assert.equal(answers('A user can delete an order.'), true, 'a written entity');
  assert.equal(answers('A logged-in user can see an order.'), true, 'an entity behind a session state');
  assert.equal(answers('A user can see an order privately.'), true, 'an entity guarded by a server check');
  assert.equal(answers('A user can see an order.'), false, 'a plain read of an entity: no session, secret or service');
  assert.equal(answers('A logged-in user can see a table.'), false, 'a session alone does not make a table server data');
  assert.equal(place('A user can see Stripe.').blocks[0].placement, 'server-read');
});

test('question 3 alone, changes the backend: only a write verb says yes, and it decides mutation against server read', () => {
  const delete1 = place('A user can delete an order.').blocks[0];
  assert.equal(delete1.answers.changesBackend, true);
  assert.equal(delete1.placement, 'mutation');
  const read = place('A logged-in user can see an order.').blocks[0];
  assert.equal(read.answers.changesBackend, false);
  assert.equal(read.placement, 'server-read');
  assert.equal(place('A user can open the page.').blocks[0].answers.changesBackend, false, 'a navigate verb changes nothing');
  assert.equal(place('A user can open the page.').blocks[0].placement, 'presentational', 'a navigation is a link on the screen');
});

test('the first yes decides, and a write that also needs the browser is a client leaf AND a mutation', () => {
  const both = place('A user can delete an order via a form.');
  const verbBlocks = both.blocks.filter((b) => b.verbs.includes('v1'));
  assert.deepEqual(verbBlocks.map((b) => b.placement), ['client-leaf', 'mutation']);
  assert.deepEqual(verbBlocks.map((b) => b.id), ['b1', 'b1-write']);
});

test('the billing example end to end: card, placement, plan', () => {
  const result = place(BILLING);
  assert.deepEqual(shape(result), [
    'b1 server-read: domain SubscriptionPlan + service SubscriptionPlan + controller SubscriptionPlan',
    'b1-view presentational: component SubscriptionPlan + page SubscriptionPlan',
    'b2 client-leaf: hook ClickButton + controller SubscriptionPlan',
    'b3 mutation: service ManageBillingDetails + workflow ManageBillingDetails',
  ]);
  const [read, view, click, manage] = result.blocks;
  assert.deepEqual(read.answers, { browserApi: false, touchesSecretOrDb: true, changesBackend: false });
  assert.deepEqual(read.verbs, ['v1']);
  assert.deepEqual(read.nouns, ['n1', 'n2'], 'the session state that decided it is named');
  assert.deepEqual(read.checkNames, ['auth-session-check', 'server-only-secret']);
  assert.deepEqual(view.checks, [], 'a presentational block carries no server check');
  assert.deepEqual(click.answers, { browserApi: true, touchesSecretOrDb: false, changesBackend: false });
  assert.deepEqual(manage.answers, { browserApi: false, touchesSecretOrDb: true, changesBackend: true });
  assert.deepEqual(manage.nouns, ['n4', 'n5']);
  assert.deepEqual(manage.checkNames, ['auth-session-check', 'server-only-secret', 'validated-redirect']);
  assert.equal(result.complete, true);
  assert.deepEqual(result.open, []);

  const compiled = compile(result);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  assert.deepEqual(compiled.plan.steps.map((s) => s.title), [
    'Create feature billing', 'Create domain SubscriptionPlan', 'Create service SubscriptionPlan', 'Create service ManageBillingDetails',
    'Create workflow ManageBillingDetails', 'Create hook ClickButton', 'Create component SubscriptionPlan', 'Create page SubscriptionPlan',
    'Create controller SubscriptionPlan',
  ]);
  assert.deepEqual(compiled.plan.steps.map((s) => s.dependsOn ?? []), [[], ['s1'], ['s1', 's2'], ['s1'], ['s1', 's4'], ['s1', 's5'], ['s1'], ['s1', 's7'], ['s1', 's2', 's3', 's6', 's8']]);
  // #677: each create.unit step also declares the feature's own types.ts/index.ts, since "billing" doesn't exist
  // on disk yet at plan time (deduped across the block's two steps).
  assert.deepEqual(compiled.files.b3, ['features/billing/types.ts', 'features/billing/index.ts', 'features/billing/services/ManageBillingDetails.tsx', 'features/billing/workflows/ManageBillingDetails.tsx']);
});

test('the profile-picture example: upload is a client leaf, seeing it is presentational, updating it is a mutation', () => {
  const result = place(UPLOAD);
  assert.deepEqual(shape(result), [
    'b1 client-leaf: hook UploadProfilePicture + controller ProfilePicture',
    'b2 presentational: component ProfilePicture + page ProfilePicture',
    'b3 mutation: service UpdateProfilePicture + workflow UpdateProfilePicture',
  ]);
  assert.ok(result.blocks.every((b) => b.checkNames.join() === 'latency-budget'), '"instantly" is a latency budget on every block');
  assert.equal(compile(result).ok, true);
});

test('the instant-search example: the keyboard makes filtering a client leaf, the product list is presentational', () => {
  const result = place(SEARCH);
  assert.deepEqual(shape(result), [
    'b1 presentational: component Products + page Products',
    'b2 client-leaf: hook FilteringProducts + controller Products',
  ]);
  assert.deepEqual(result.blocks[1].nouns, ['n1', 'n2']);
  assert.ok(result.blocks.every((b) => b.checkNames.join() === 'latency-budget'));
  const compiled = compile(result);
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.plan.steps.map((s) => s.title), ['Create feature billing', 'Create hook FilteringProducts', 'Create component Products', 'Create page Products', 'Create controller Products']);
});

test('an ambiguous write is an open question of 2-5 options, waits unanswered, and resolves with a valid answer', async () => {
  const card = cardOf('A user can save a form.');
  const first = placeCard(card);
  assert.equal(first.ok, true);
  assert.equal(first.complete, false);
  assert.deepEqual(first.blocks, [], 'nothing is guessed while the question is open');
  assert.equal(first.open.length, 1);
  const question = first.open[0];
  assert.equal(question.id, 'q-v1');
  assert.equal(question.question, 'What does "save" change?');
  assert.deepEqual(question.options.map((o) => o.id), ['mutation', 'client-leaf']);
  assert.ok(question.options.length >= CHOOSER_LIMITS.minOptions && question.options.length <= CHOOSER_LIMITS.maxOptions);
  assert.deepEqual(Object.keys(question).sort(), ['chosen', 'id', 'options', 'question'], 'the shape of a chooser summary');
  assert.equal(question.chosen, null);
  assert.equal((await suggest(question)).option, 'mutation', 'a decision provider reads it unchanged');

  const mutation = resolvePlacementOpen(card, { 'q-v1': 'mutation' });
  assert.deepEqual(codes(mutation), []);
  assert.equal(mutation.complete, true);
  assert.deepEqual(mutation.blocks.map((b) => b.placement), ['client-leaf', 'mutation'], 'a form is interactive, so the write also has its client leaf');
  assert.deepEqual(mutation.decisions, [{ question: 'q-v1', option: 'mutation', by: 'person' }]);
  const client = resolvePlacementOpen(card, { 'q-v1': 'client-leaf' });
  assert.deepEqual(client.blocks.map((b) => b.placement), ['client-leaf']);
  assert.equal(client.blocks[0].answers.changesBackend, false);
  assert.equal(compile(mutation).ok, true);
  assert.deepEqual(card.open, [], 'the card was not changed');
});

test('an invalid answer is refused by code, never a throw, and nothing is placed from it', () => {
  const card = cardOf('A user can save a form.');
  const bad = resolvePlacementOpen(card, { 'q-v1': 'delete-everything' });
  assert.equal(bad.ok, false);
  assert.deepEqual(codes(bad), ['PLACE_UNKNOWN_OPTION']);
  assert.deepEqual(bad.blocks, []);
  assert.deepEqual(codes(resolvePlacementOpen(card, { 'q-v9': 'mutation' })), ['PLACE_UNKNOWN_OPEN']);
  assert.deepEqual(codes(placeCard(card, { answers: 'mutation' })), ['PLACE_ANSWERS_INVALID']);
  assert.deepEqual(codes(resolvePlacementOpen(card, { 'q-v1': { option: 'mutation', by: 'robot' } })), ['PLACE_ATTRIBUTION_INVALID']);
  assert.deepEqual(codes(resolvePlacementOpen(card, { 'q-v1': 5 })), ['PLACE_UNKNOWN_OPTION']);
});

test('who answered is recorded (person, llm, decision-model) and rides beside the plan like compileChain', () => {
  const card = cardOf('A user can click a button safely.');
  const open = placeCard(card);
  assert.equal(open.open[0].id, 'q-server');
  assert.deepEqual(open.open[0].options.map((o) => o.id), ['mutation', 'server-read']);
  const answered = resolvePlacementOpen(card, { 'q-server': { option: 'mutation', by: 'decision-model', provider: 'jev' } });
  assert.deepEqual(codes(answered), []);
  assert.deepEqual(answered.decisions, [{ question: 'q-server', option: 'mutation', by: 'decision-model', provider: 'jev' }]);
  assert.deepEqual(answered.blocks.map((b) => `${b.placement}:${b.checkNames.length}`), ['client-leaf:0', 'mutation:3'], 'the server checks land on the new server block');
  const compiled = planFromBlocks(answered.blocks, { feature: 'checkout', root: project(), decisions: answered.decisions });
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  assert.deepEqual(compiled.decisions, answered.decisions);
  const byLlm = resolvePlacementOpen(card, { 'q-server': 'server-read' }, { by: 'llm', provider: 'local' });
  assert.deepEqual(byLlm.decisions, [{ question: 'q-server', option: 'server-read', by: 'llm', provider: 'local' }]);
  assert.deepEqual(codes(planFromBlocks(answered.blocks, { feature: 'checkout', root: project(), decisions: [{ question: 'q', option: 'x', by: 'nobody' }] })), ['PLAN_DECISIONS_INVALID']);
});

test('a check the table does not know becomes a question with three options', () => {
  const lexicon = structuredClone(defaultLexicon());
  lexicon.checks['gdpr-consent'] = { why: 'Ask for consent before storing personal data.' };
  lexicon.adjectives.compliantly = ['gdpr-consent'];
  const card = cardOf('A user can see a table compliantly.', { lexicon });
  assert.deepEqual(card.checks.map((c) => c.name), ['gdpr-consent']);
  const open = placeCard(card, { lexicon });
  assert.deepEqual(open.open.map((q) => q.id), ['q-c1']);
  assert.deepEqual(open.open[0].options.map((o) => o.id), ['server-blocks', 'screen-blocks', 'every-block']);
  assert.deepEqual(open.blocks[0].checks, [], 'not attached until answered');
  const answered = placeCard(card, { lexicon, answers: { 'q-c1': 'screen-blocks' } });
  assert.deepEqual(answered.blocks[0].checkNames, ['gdpr-consent']);
  assert.deepEqual(answered.open, []);
});

test('layer assignment respects the import rules: the three examples violate none, in both layer graphs and both variants', () => {
  for (const [name, layers] of [['nextjs', DEFAULT_LAYERS], ['react-spa', REACT_SPA_LAYERS]]) {
    for (const text of [BILLING, UPLOAD, SEARCH]) {
      const result = place(text, { framework: name, layers });
      assert.deepEqual(checkPlacementImports(result.blocks, layers), [], `${name}: ${text}`);
    }
  }
  const variants = [LAYER_TABLE.default, ...Object.values(LAYER_TABLE.variants)];
  for (const table of variants) {
    for (const rows of Object.values(table)) {
      for (const row of rows) {
        for (const used of row.uses) assert.ok(DEFAULT_LAYERS[row.layer].canImport.includes(used), `${row.layer} may import ${used}`);
      }
    }
  }
  const layerNames = new Set(Object.keys(DEFAULT_LAYERS));
  for (const rows of Object.values({ ...LAYER_TABLE.default })) for (const row of rows) assert.ok(layerNames.has(row.layer));
});

test('a violation is caught: a page importing a service, a layer the project lacks, and a graph that forbids an import', () => {
  const hand = [{ id: 'b1', placement: 'presentational', layers: [{ layer: 'page', name: 'X', uses: ['service'] }, { layer: 'service', name: 'X' }] }];
  const found = checkPlacementImports(hand, DEFAULT_LAYERS);
  assert.deepEqual(found.map((e) => e.code), ['PLACE_IMPORT_FORBIDDEN']);
  assert.match(found[0].message, /a page may only import: component, types/);
  const { workflow: _drop, ...noWorkflow } = DEFAULT_LAYERS;
  assert.deepEqual(codes(placeCard(cardOf(BILLING), { layers: noWorkflow })), ['PLACE_LAYER_MISSING']);
  const strict = { ...DEFAULT_LAYERS, hook: { pattern: DEFAULT_LAYERS.hook.pattern, canImport: ['domain', 'types'] } };
  const bad = placeCard(cardOf(BILLING), { layers: strict });
  assert.equal(bad.ok, false);
  assert.ok(codes(bad).every((c) => c === 'PLACE_IMPORT_FORBIDDEN'));
  assert.deepEqual(bad.blocks, []);
});

test('the App Router variant and a project without server components: different layers, and the notes say so', () => {
  const app = place(BILLING, { framework: 'nextjs' });
  assert.equal(app.variant, 'app-router');
  assert.match(app.notes.join(' '), /Server Component/);
  assert.match(app.notes.join(' '), /Server Action/);
  assert.match(app.blocks[0].layers.at(-1).why, /Server Component/);
  assert.deepEqual(app.blocks[0].layers.map((l) => l.layer), ['domain', 'service', 'controller']);
  assert.match(app.blocks[3].layers[0].why, /Server Action/);

  const spa = place(BILLING, { framework: 'react-spa', layers: REACT_SPA_LAYERS });
  assert.equal(spa.variant, 'default');
  assert.match(spa.notes.join(' '), /no Server Components or Server Actions/);
  assert.match(spa.notes.join(' '), /src\/App\.tsx/);
  assert.deepEqual(spa.blocks[0].layers.map((l) => l.layer), ['domain', 'service', 'hook', 'controller'], 'the fetch runs from a hook in the browser');
  assert.equal(compile(spa).ok, true);

  assert.deepEqual(codes(placeCard(cardOf(BILLING), { framework: 'remix' })), ['PLACE_FRAMEWORK_UNKNOWN']);
  assert.deepEqual(codes(placeCard(cardOf(BILLING), { screen: 'billing page' })), ['PLACE_SCREEN_INVALID']);
  assert.equal(place(BILLING, { screen: 'Billing' }).blocks.at(-1).layers.length, 2);
  assert.equal(place(BILLING, { screen: 'Billing' }).blocks[0].layers.at(-1).name, 'Billing');
});

test('a controller always has its page: a client leaf alone still names the page it imports', () => {
  const result = place('A user can click a button.');
  assert.deepEqual(result.blocks[0].layers.map((l) => `${l.layer}:${l.name}`), ['hook:ClickButton', 'controller:Screen', 'page:Screen']);
  assert.equal(compile(result).ok, true);
});

test('planFromBlocks passes validatePlan with zero errors, declares every file a step writes, and lists them per block', () => {
  for (const text of [BILLING, UPLOAD, SEARCH]) {
    for (const framework of ['nextjs', 'react-spa']) {
      const compiled = compile(place(text, { framework }));
      assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
      assert.deepEqual(validatePlan(compiled.plan), { valid: true, errors: [] });
      assert.deepEqual(compiled.plan.steps[0].args, { name: 'billing' });
      for (const step of compiled.plan.steps) {
        assert.equal(step.executor, 'deterministic');
        assert.ok(step.touches.files.length >= 1 && step.touches.files.every((f) => f.change === 'create'), step.title);
      }
      assert.ok(Object.values(compiled.files).every((list) => list.length >= 2));
    }
  }
});

test('planFromBlocks never throws for user input: unknown or unsupported placements and layers, bad names, features and roots are typed errors', () => {
  const good = place(SEARCH).blocks;
  const root = project();
  const attempt = (blocks, options) => planFromBlocks(blocks, options);
  assert.deepEqual(codes(attempt(good, { feature: 'search', root })), []);
  assert.deepEqual(codes(attempt([{ ...good[0], placement: 'edge-function' }], { feature: 'search', root })), ['PLAN_PLACEMENT_UNKNOWN']);
  assert.deepEqual(codes(attempt([{ ...good[0], layers: [{ layer: 'route', name: 'Home', why: 'x' }] }], { feature: 'search', root })), ['PLAN_LAYER_UNSUPPORTED']);
  assert.deepEqual(codes(attempt([{ ...good[0], layers: [{ layer: 'page', name: 'not valid' }] }], { feature: 'search', root })), ['PLAN_NAME_INVALID']);
  assert.deepEqual(codes(attempt([{ ...good[0], layers: [{ layer: 'page' }] }], { feature: 'search', root })), ['PLAN_LAYER_INVALID']);
  assert.deepEqual(codes(attempt(good, { feature: '3d viewer', root })), ['PLAN_FEATURE_INVALID']);
  assert.deepEqual(codes(attempt(good, { feature: 'search' })), ['PLAN_ROOT_REQUIRED']);
  for (const junk of [undefined, null, 5, 'blocks', {}, [], [null], [5], [{}]]) {
    const r = attempt(junk, { feature: 'search', root });
    assert.equal(r.ok, false);
    assert.equal(r.plan, null);
    assert.ok(r.errors.length > 0);
  }
  for (const junk of [undefined, null, 'x', 7]) assert.equal(planFromBlocks(good, junk).ok, false);
  for (const junk of [undefined, null, 7, 'x', {}, { version: 'requirement-card.v1' }]) {
    const r = placeCard(junk);
    assert.equal(r.ok, false);
    assert.equal(codes(r).includes('PLACE_CARD_INVALID'), true);
  }
});

test('a card that still has its own open words is refused until resolveOpen answers them', () => {
  const card = cardOf('A user can frobnicate a form.');
  assert.ok(card.open.length > 0);
  assert.deepEqual(codes(placeCard(card)), ['PLACE_CARD_OPEN']);
});

test('deterministic: a second run is byte-identical and the input card is not changed', () => {
  for (const text of [BILLING, UPLOAD, SEARCH, 'A user can save a form.', 'A user can click a button safely.']) {
    const card = cardOf(text);
    const before = JSON.stringify(card);
    const one = placeCard(structuredClone(card));
    const two = placeCard(structuredClone(card));
    assert.equal(JSON.stringify(one), JSON.stringify(two));
    assert.equal(JSON.stringify(card), before, 'the card is untouched');
    assert.equal(JSON.stringify(blockSummary(one)), JSON.stringify(blockSummary(two)));
    if (one.blocks.length) {
      const root = project();
      assert.equal(JSON.stringify(planFromBlocks(one.blocks, { feature: 'f', root })), JSON.stringify(planFromBlocks(two.blocks, { feature: 'f', root })));
    }
  }
});

test('the summary has a fixed maximum size, one plain-English line per block, and the same shape for every card', () => {
  const small = blockSummary(place(BILLING));
  assert.equal(small.truncated, false);
  assert.deepEqual(small.counts, { blocks: 4, open: 0, errors: 0 });
  assert.equal(small.lines.length, 4);
  assert.equal(small.lines[0], '"see current subscription plan" is fetched on the server (domain, service, controller). Checks: auth-session-check, server-only-secret.');
  assert.equal(small.lines[1], '"see current subscription plan" is shown from props (component, page).');
  assert.ok(small.lines.every((l) => l.length <= PLACEMENT_LIMITS.line));
  assert.deepEqual(blockLines(place(BILLING)).map((l) => l.id), ['b1', 'b1-view', 'b2', 'b3']);

  const huge = cardOf('A user can click a button and see a table via Stripe safely, then delete an order. '.repeat(40));
  const result = placeCard(huge);
  assert.ok(result.blocks.length > PLACEMENT_LIMITS.blocks);
  const summary = blockSummary(result);
  assert.equal(summary.truncated, true);
  assert.ok(summary.blocks.length <= PLACEMENT_LIMITS.blocks);
  assert.ok(summary.lines.length <= PLACEMENT_LIMITS.lines);
  assert.ok(summary.blocks.every((b) => b.layers.length <= PLACEMENT_LIMITS.layers && b.checks.length <= PLACEMENT_LIMITS.checks && b.why.length <= PLACEMENT_LIMITS.why));
  assert.ok(summary.notes.length <= PLACEMENT_LIMITS.notes && summary.notes.every((n) => n.length <= PLACEMENT_LIMITS.note));
  assert.ok(JSON.stringify(summary).length < 7000, `summary is ${JSON.stringify(summary).length} bytes`);
  assert.ok(JSON.stringify(result).length > 5 * JSON.stringify(summary).length, 'the result is much larger than its summary');

  const openSummary = blockSummary(placeCard(cardOf('A user can save a form.')));
  assert.equal(openSummary.open.length, 1);
  assert.ok(openSummary.open[0].options.length <= PLACEMENT_LIMITS.options);
  assert.equal(openSummary.complete, false);
  assert.deepEqual(blockSummary(null).counts, { blocks: 0, open: 0, errors: 0 });
});

test('nothing here can reach a model or the network: only sibling modules are imported and no client is used', () => {
  const src = fs.readFileSync(path.join(here, '..', 'packages', 'core', 'placement.mjs'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./block-flows.mjs', './chooser.mjs', './config.mjs', './env.mjs', './generators.mjs', './guard.mjs', './handler.mjs', './plan.mjs', './proof.mjs', './requirement-card.mjs', './shape-dashboard.mjs', './shape-source.mjs', './shape-states.mjs', './shape-wizard.mjs', './shapes.mjs', './store.mjs', './verify.mjs', './wiring.mjs']);
  assert.doesNotMatch(src, /\b(fetch\s*\(|XMLHttpRequest|WebSocket|child_process|https?:\/\/|require\()/);
  assert.doesNotMatch(src, /(?<!\{)\bimport\s*\(/, 'no dynamic import (a JSDoc type import is fine)');
  assert.doesNotMatch(src, /\b(Date\.now|Math\.random|new Date)\b/, 'no clock or randomness: same input, same output');
  const exported = JSON.parse(fs.readFileSync(path.join(here, '..', 'packages', 'core', 'package.json'), 'utf8')).exports;
  assert.equal(exported['./placement'], './placement.mjs');
});

test('the worked examples in docs/PLACEMENT.md run and produce exactly the JSON the doc shows', async () => {
  const doc = fs.readFileSync(path.join(here, '..', 'docs', 'PLACEMENT.md'), 'utf8');
  const block = (tag, lang) => new RegExp(`<!-- placement-example:${tag} -->\\n\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``).exec(doc)?.[1];
  const code = block('code', 'js');
  const overviewCode = block('overview-code', 'js');
  assert.ok(code && overviewCode, 'the doc carries both code blocks');
  const dir = makeTempDir('og641-doc-');
  const rootUrl = pathToFileURL(path.join(here, '..', 'packages', 'core')).href;
  const run = async (name, source) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source
      .replace("'@line/construct-core/requirement-card'", `'${rootUrl}/requirement-card.mjs'`)
      .replace("'@line/construct-core/placement'", `'${rootUrl}/placement.mjs'`)
      .replace("'/path/to/project'", JSON.stringify(dir)));
    return import(pathToFileURL(file).href);
  };
  const first = await run('billing.mjs', code);
  const second = await run('overview.mjs', overviewCode);
  const same = (tag, value) => assert.deepEqual(JSON.parse(block(tag, 'json')), JSON.parse(JSON.stringify(value)), tag);
  same('placement', first.placement);
  same('plan', first.plan);
  same('files', first.files);
  same('overview', second.overview);
  assert.equal(first.placement.blocks.length, 4);
  assert.deepEqual(validatePlan(first.plan), { valid: true, errors: [] });
});
