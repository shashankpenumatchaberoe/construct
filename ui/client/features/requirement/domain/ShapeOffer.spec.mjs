import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirement } from '../../../../../packages/core/requirement-card.mjs';
import { placeCard, planFromBlocks } from '../../../../../packages/core/placement.mjs';
import { EXAMPLES, withAnswer } from './Examples.ts';
import { buildRequirementView } from './RequirementView.ts';
import { initialScreen } from '../workflows/RequirementMachine.ts';

// #651: the screen-shape offer. The placements are the REAL ones, from the core blocks, so the view is proven against what
// the server sends.
const PRODUCTS = 'A user wants to see a list of products';
const BILLING = EXAMPLES[0].text;
const shapeResult = (answers) => {
  const card = parseRequirement(PRODUCTS).card;
  const placement = placeCard(card, { framework: 'react-spa', answers });
  const planned = planFromBlocks(placement.blocks, { feature: 'products', root: '/x', decisions: placement.decisions });
  return { card, placement, plan: planned.plan, files: planned.files, open: placement.open, offers: placement.offers, warnings: [], summary: { readBack: [], blocks: [] } };
};
const shapeView = (result, extra = {}) => buildRequirementView({ ...initialScreen, text: PRODUCTS, read: { status: 'ready', result, error: null }, ...extra });

test('the offer view: unanswered, list is marked suggested, nothing is chosen and the plan stays the plain scaffold', () => {
  const v = shapeView(shapeResult());
  assert.equal(v.result.offers.length, 1);
  const [offer] = v.result.offers;
  assert.deepEqual([offer.id, offer.source], ['q-shape', 'placement']);
  assert.deepEqual(offer.options.map((o) => [o.id, o.label, o.suggested, o.chosen]), [['list', 'List screen, generated with typed code', true, false], ['scaffold', 'Empty scaffold', false, false]]);
  assert.match(offer.options[0].gives, /real files that validate/);
  assert.match(offer.options[1].gives, /empty stubs/);
  assert.equal(offer.decidedBy, null);
  assert.match(offer.status, /^Not chosen yet, so the plan below is the empty scaffold\. Suggested by rules: list screen/);
  assert.deepEqual([offer.suggestion.label, offer.suggestion.option], ['suggested by rules', 'list'], 'an older server: the offer carries the rules suggestion itself');
  assert.deepEqual(v.result.timeline.map((s) => s.kind), ['page-load', 'presentation'], 'the plain scaffold: no server read yet');
  // #677: create.unit's derived touches now also declare the feature's own types.ts/index.ts (products does not exist
  // on disk yet at plan time), so the plain scaffold (component + page, neither layer previously declared them) gains
  // both files, deduped across the two steps.
  assert.equal(v.result.files.length, 4);
});

test('the offer never blocks Approve: an unanswered offer approves the plain plan the screen shows', () => {
  const v = shapeView(shapeResult());
  assert.equal(v.result.open.length, 0, 'the offer is not an open question');
  assert.equal(v.result.approve.canApprove, true);
  assert.equal(v.result.approve.hint, null);
});

test('choosing list: the view names the chooser (person), the plan has 9 steps (the feature, six units, the proof and its run, #623) and the typed files; scaffold gives fewer', () => {
  const chosen = shapeResult({ 'q-shape': 'list' });
  const list = shapeView(chosen);
  const [offer] = list.result.offers;
  assert.deepEqual(offer.options.map((o) => o.chosen), [true, false]);
  assert.equal(offer.decidedBy, 'person');
  assert.equal(offer.status, 'Chosen: List screen, generated with typed code. Decided by: person.');
  assert.deepEqual(list.result.timeline.map((s) => s.kind), ['page-load', 'server-read', 'presentation'], 'the list shape reads on the server, then shows');
  // #677: create.unit's derived touches now also declare the feature's index.ts (types.ts was already declared by
  // the domain layer's own shape touches, #619); the shaped ten files, the local store (#621) and now index.ts too.
  assert.equal(list.result.files.length, 12, 'the ten files of the shape, the local store the rules default (#621) writes, and index.ts (#677)');
  assert.ok(list.result.files.includes('features/products/services/Products.service.ts'));
  assert.equal(chosen.plan.steps.length, 12, 'the feature, six units, the wiring, the type-check (#632), the proof and its run');
  assert.ok(chosen.plan.steps.slice(1, 7).every((s) => s.args.shape === 'list'));
  const scaffold = shapeView(shapeResult({ 'q-shape': 'scaffold' }));
  assert.equal(scaffold.result.offers[0].decidedBy, 'person');
  assert.deepEqual(scaffold.result.offers[0].options.map((o) => o.chosen), [false, true]);
  assert.ok(scaffold.result.files.length < list.result.files.length);
  assert.equal(list.result.approve.canApprove, true);
});

test('a sentence with no offer, or a server that sends none, has no card', () => {
  const billing = parseRequirement(BILLING).card;
  const placement = placeCard(billing);
  assert.deepEqual(placement.offers, []);
  const result = { card: billing, placement, plan: null, files: {}, open: [], offers: placement.offers, warnings: [], summary: { readBack: [], blocks: [] } };
  assert.deepEqual(shapeView(result).result.offers, []);
  const { offers, ...older } = result;
  assert.deepEqual(shapeView(older).result.offers, [], 'a response without `offers` is read as none');
});

// #621: the data source (q-source) rides in `offers` beside q-shape (the server puts it there once the plan is built) and is drawn as a card of its own.
const sourceResult = (answers, plan = {}) => {
  const card = parseRequirement(PRODUCTS).card;
  const placement = placeCard(card, { framework: 'react-spa', answers: { 'q-shape': 'list' } });
  const planned = planFromBlocks(placement.blocks, { feature: 'products', root: '/x', decisions: placement.decisions, answers, ...plan });
  const offers = [...placement.offers, ...planned.offers.filter((q) => q.id === 'q-source').map((q) => ({ ...q, source: 'plan' }))];
  return { card, placement: { ...placement, decisions: planned.decisions }, plan: planned.plan, files: planned.files, open: [], offers, warnings: [], summary: { readBack: [], blocks: [] } };
};

test('the data source offer: its own card kind, the server words, the rules default marked suggested, nothing chosen, Approve stays on', () => {
  const v = shapeView(sourceResult({}));
  assert.deepEqual(v.result.offers.map((o) => [o.id, o.kind, o.source]), [['q-shape', 'shape', 'placement'], ['q-source', 'source', 'placement']], 'two cards, the shape first; the client draws the server\'s `plan` questions like its placement ones');
  const source = v.result.offers[1];
  assert.deepEqual(source.options.map((o) => [o.id, o.label, o.suggested, o.chosen]), [['local', 'Local data, no backend', true, false], ['endpoint', 'Call GET /api/products', false, false]]);
  assert.match(source.options[1].gives, /must exist in your app/);
  assert.equal(source.status, "Not chosen yet, so the plan below uses the rules' default: local data, no backend.");
  assert.equal(source.decidedBy, null);
  assert.equal(v.result.approve.canApprove, true, 'a closed question beside the plan never blocks Approve');
});

test('answering the data source: the view names the chooser, the other option is not pressed, and the answer replaces an earlier one', () => {
  const v = shapeView(sourceResult({ 'q-source': 'endpoint' }));
  const source = v.result.offers[1];
  assert.deepEqual(source.options.map((o) => o.chosen), [false, true]);
  assert.equal(source.status, 'Chosen: Call GET /api/products. Decided by: person.');
  assert.equal(source.decidedBy, 'person');
  // #677: create.unit's derived touches now also declare the feature's index.ts (types.ts was already declared by
  // the domain layer's own shape touches, #619), same as the local-source count in the test above.
  assert.equal(v.result.files.length, 11, 'the endpoint source writes no store, plus index.ts (#677)');
  const target = { id: 'q-source', source: 'placement' };
  assert.deepEqual(withAnswer(withAnswer([{ id: 'q-shape', option: 'list' }], target, 'endpoint'), target, 'local'), [{ id: 'q-shape', option: 'list' }, { id: 'q-source', option: 'local' }]);
});

// #632: every other closed question of the plan (the type-check, the environment variables, the route, the dependency) comes back in `offers` as a `plan`
// question and is drawn as a card of its own, titled from its id, with the same status words as the data source. The server owns the rules; this only words them.
const planResult = (sentence, answers = {}, shape = true) => {
  const card = parseRequirement(sentence).card;
  const placement = placeCard(card, { framework: 'react-spa', answers: shape ? { 'q-shape': 'list' } : {} });
  const planned = planFromBlocks(placement.blocks, { feature: 'products', root: '/x', decisions: placement.decisions, answers, card });
  const offers = [...placement.offers, ...planned.offers.map((q) => ({ ...q, source: 'plan' }))];
  return { card, placement: { ...placement, decisions: planned.decisions }, plan: planned.plan, files: planned.files, open: [], offers, warnings: [], summary: { readBack: [], blocks: [] } };
};

test('the plan questions: the type-check and the environment variables are cards of the kind `plan`, titled from their id, never blocking Approve', () => {
  const v = shapeView(planResult(PRODUCTS));
  assert.deepEqual(v.result.offers.map((o) => [o.id, o.kind, o.heading]), [['q-shape', 'shape', 'Screen shape'], ['q-source', 'source', 'Data source'], ['q-states', 'plan', 'Screen states'], ['q-access', 'plan', 'Access'], ['q-verify', 'plan', 'Verification']]);
  const verify = v.result.offers[4];
  assert.deepEqual(verify.options.map((o) => [o.id, o.suggested, o.chosen]), [['types', true, false], ['none', false, false]], 'the build option is disabled here (no package.json), so it is not offered');
  assert.equal(verify.status, "Not chosen yet, so the plan below uses the rules' default: type-check after the wiring.");
  assert.equal(v.result.approve.canApprove, true);
  const answered = shapeView(planResult(PRODUCTS, { 'q-verify': 'none' })).result.offers[4];
  assert.deepEqual([answered.status, answered.decidedBy, answered.options.map((o) => o.chosen)], ['Chosen: No verification step. Decided by: person.', 'person', [false, true]]);
  assert.deepEqual(withAnswer([], { id: 'q-verify', source: 'plan' }, 'none'), [{ id: 'q-verify', option: 'none' }]);

  const env = shapeView(planResult('A logged-in user wants to safely manage billing details Stripe', {}, false)).result.offers.filter((o) => o.kind === 'plan');
  assert.deepEqual(env.map((o) => [o.id, o.heading, o.options.map((x) => x.id)]), [['q-env-stripe-secret-key', 'Environment variable', ['add', 'skip']], ['q-env-allowed-redirect-origins', 'Environment variable', ['add', 'skip']]]);
  assert.match(env[0].question, /STRIPE_SECRET_KEY/);
  assert.equal(env[0].options[0].suggested, true, 'add is the rules default');
});

// #629: who may open the screen is one more closed question of the plan: the client only titles it (Access); the options, their words and the suggestion are the server's.
test('q-access is drawn as a plan card titled Access: the rules default is read off the card, a role the card cannot support is not offered, an answer marks the option', () => {
  const session = shapeView(planResult('A logged-in user wants to see a list of products')).result.offers.find((o) => o.id === 'q-access');
  assert.deepEqual([session.kind, session.heading, session.options.map((o) => [o.id, o.label, o.suggested, o.chosen])], ['plan', 'Access', [['signed-in', 'Only a signed-in person', true, false], ['public', 'Anyone can open it', false, false]]]);
  assert.equal(session.status, "Not chosen yet, so the plan below uses the rules' default: only a signed-in person.");
  const admin = shapeView(planResult('An admin wants to see a list of products')).result.offers.find((o) => o.id === 'q-access');
  assert.deepEqual(admin.options.map((o) => [o.id, o.suggested]), [['role', true], ['public', false], ['signed-in', false]]);
  assert.equal(admin.options[0].label, 'Only admin');
  const chosen = shapeView(planResult('A logged-in user wants to see a list of products', { 'q-access': { option: 'public', by: 'person' } })).result.offers.find((o) => o.id === 'q-access');
  assert.deepEqual([chosen.status, chosen.decidedBy, chosen.options.map((o) => o.chosen)], ['Chosen: Anyone can open it. Decided by: person.', 'person', [false, true]]);
  assert.deepEqual(withAnswer([], { id: 'q-access', source: 'plan' }, 'public'), [{ id: 'q-access', option: 'public' }]);
});

// #630: shared client state is one more closed question of the plan: the client only titles it (Client state); its option ids are prefixed `store-` so none is also a screen shape's id (`list`).
test('q-state is drawn as a plan card titled Client state: the store options keep the server words, and the screen shape words are not borrowed', () => {
  const state = shapeView(planResult('A user wants to see a list of products with the selected items')).result.offers.find((o) => o.id === 'q-state');
  assert.deepEqual([state.kind, state.heading, state.options.map((o) => [o.id, o.label, o.suggested, o.chosen])], ['plan', 'Client state', [['store-list', 'A list with a selection', true, false], ['store-value', 'One value', false, false], ['store-keyed', 'Items by their id', false, false], ['skip', 'No store', false, false]]]);
  assert.equal(state.status, "Not chosen yet, so the plan below uses the rules' default: a list with a selection.");
  const chosen = shapeView(planResult('A user wants to see a list of products with the selected items', { 'q-state': { option: 'store-keyed', by: 'person' } })).result.offers.find((o) => o.id === 'q-state');
  assert.deepEqual([chosen.status, chosen.decidedBy], ['Chosen: Items by their id. Decided by: person.', 'person']);
  assert.deepEqual(withAnswer([], { id: 'q-state', source: 'plan' }, 'skip'), [{ id: 'q-state', option: 'skip' }]);
});

// #625: the route handler of a screen's endpoint is one more closed question of the plan: the client only titles it (Route handler); it is asked on a Next.js project once the source is `endpoint`.
test('q-handler is drawn as a plan card titled Route handler, with the server words for its two options', () => {
  const built = (answers) => {
    const card = parseRequirement(PRODUCTS).card;
    const placement = placeCard(card, { framework: 'nextjs', answers: { 'q-shape': 'list' } });
    const planned = planFromBlocks(placement.blocks, { feature: 'products', root: process.cwd(), decisions: placement.decisions, answers, card });
    return { card, placement: { ...placement, decisions: planned.decisions }, plan: planned.plan, files: planned.files, open: [], offers: [...placement.offers, ...planned.offers.map((q) => ({ ...q, source: 'plan' }))], warnings: [], summary: { readBack: [], blocks: [] } };
  };
  const handler = shapeView(built({ 'q-source': 'endpoint' })).result.offers.find((o) => o.id === 'q-handler');
  assert.deepEqual([handler.kind, handler.heading, handler.options.map((o) => [o.id, o.label, o.suggested])], ['plan', 'Route handler', [['add-handler', 'Add GET /api/products', true], ['skip', 'No handler', false]]]);
  assert.equal(handler.status, "Not chosen yet, so the plan below uses the rules' default: add GET /api/products.");
  const chosen = shapeView(built({ 'q-source': 'endpoint', 'q-handler': { option: 'skip', by: 'person' } })).result.offers.find((o) => o.id === 'q-handler');
  assert.deepEqual([chosen.status, chosen.decidedBy], ['Chosen: No handler. Decided by: person.', 'person']);
  assert.deepEqual(withAnswer([], { id: 'q-handler', source: 'plan' }, 'skip'), [{ id: 'q-handler', option: 'skip' }]);
});

test('a decision made by the rules names its provider; an option the table does not know keeps the server words', () => {
  const r = shapeResult({ 'q-shape': { option: 'list', by: 'decision-model', provider: 'rules' } });
  assert.equal(shapeView(r).result.offers[0].decidedBy, 'decision-model (rules)');
  const odd = shapeResult();
  odd.offers = [{ ...odd.offers[0], options: [...odd.offers[0].options, { id: 'grid', label: 'Grid shape', enabled: true, why: 'Cards in a grid.' }, { id: 'off', label: 'Off', enabled: false, why: 'w' }] }];
  const options = shapeView(odd).result.offers[0].options;
  assert.deepEqual(options.map((o) => o.id), ['list', 'scaffold', 'grid'], 'a disabled option is not offered');
  assert.deepEqual([options[2].label, options[2].gives], ['Grid shape', 'Cards in a grid.']);
});

test('answers: the shape answer is a placement answer, so a changed mind replaces it and card answers stay in order', () => {
  const shape = { id: 'q-shape', source: 'placement' };
  const a = withAnswer(withAnswer([{ id: 'o1', option: 'interact' }], shape, 'scaffold'), shape, 'list');
  assert.deepEqual(a, [{ id: 'o1', option: 'interact' }, { id: 'q-shape', option: 'list' }]);
  assert.deepEqual(withAnswer([], shape, 'list'), [{ id: 'q-shape', option: 'list' }]);
});

test('Approve waits while a new read is in flight, so the plan sent is the plan on screen for the choice made', () => {
  const ready = shapeResult({ 'q-shape': 'list' });
  assert.equal(shapeView(ready, { read: { status: 'loading', result: ready, error: null } }).result.approve.canApprove, false);
  assert.equal(shapeView(ready).result.approve.canApprove, true);
});

// #633: what the project's decision provider suggests is the server's `suggestions` (per question id), drawn as "suggested by <provider>".
const suggestion = (option, provider = 'rules', extra = {}) => ({ option, reason: 'because', runnerUp: null, provider: { name: provider, version: '1' }, ...extra });

test('a suggestion from the server: the offer and the open questions say "suggested by <provider>" with the reason; nothing is chosen', () => {
  const r = { ...shapeResult(), suggestions: { 'q-shape': suggestion('scaffold', 'jev') } };
  const [offer] = shapeView(r).result.offers;
  assert.deepEqual(offer.options.map((o) => [o.id, o.suggested, o.chosen]), [['list', false, false], ['scaffold', true, false]], 'the provider, not the offer\'s own default, decides which is marked');
  assert.deepEqual(offer.suggestion, { option: 'scaffold', label: 'suggested by jev', reason: 'because' });
  assert.match(offer.status, /^Not chosen yet, so the plan below is the empty scaffold\. Suggested by jev: empty scaffold\.$/);
  assert.equal(offer.decidedBy, null);

  const card = parseRequirement('A customer wants to frobnicate the invoice list.').card;
  const open = { card, placement: null, plan: null, files: {}, open: card.open.map((i) => ({ id: i.id, question: 'What does it do?', source: 'card', chosen: null, options: [{ id: 'read', label: 'Shows something', enabled: true, why: 'w' }, { id: 'write', label: 'Changes data', enabled: true, why: 'w' }] })), offers: [], warnings: [], summary: { readBack: [], blocks: [] }, suggestions: { o1: suggestion('write', 'rules', { fellBackFrom: 'jev' }) } };
  const [q] = buildRequirementView({ ...initialScreen, text: 'x', read: { status: 'ready', result: open, error: null } }).result.open;
  assert.deepEqual(q.options.map((o) => [o.id, o.suggested]), [['read', false], ['write', true]]);
  assert.deepEqual(q.suggestion, { option: 'write', label: 'suggested by rules (jev did not answer)', reason: 'because' });
});

test('a provider that is off (or abstained) suggests nothing, even where the offer has its own default; an older server keeps the rules default', () => {
  const off = { ...shapeResult(), suggestions: {} };
  const [offer] = shapeView(off).result.offers;
  assert.equal(offer.suggestion, null);
  assert.deepEqual(offer.options.map((o) => o.suggested), [false, false]);
  assert.equal(offer.status, 'Not chosen yet, so the plan below is the empty scaffold.');
  assert.equal(shapeView(shapeResult()).result.offers[0].options[0].suggested, true, 'no `suggestions` field at all: an older server');
});

// #659: the wizard's step count (q-steps) is a card of the kind `plan`, titled and explained in plain words, with the default first, and never blocks Approve.
test('the wizard step count (q-steps) is a plan card with a plain line about what a step is; the other plan cards have none', () => {
  const card = parseRequirement('A user wants a step by step signup').card;
  const placement = placeCard(card, { framework: 'react-spa', answers: { 'q-shape': 'wizard' } });
  const build = (answers = {}) => {
    const planned = planFromBlocks(placement.blocks, { feature: 'signup', root: '/x', decisions: placement.decisions, answers, card });
    return shapeView({ card, placement: { ...placement, decisions: planned.decisions }, plan: planned.plan, files: planned.files, open: [], offers: [...placement.offers, ...planned.offers.map((q) => ({ ...q, source: 'plan' }))], warnings: [], summary: { readBack: [], blocks: [] } });
  };
  const v = build();
  assert.deepEqual(v.result.offers.map((o) => [o.id, o.kind, o.heading]), [['q-shape', 'shape', 'Screen shape'], ['q-source', 'source', 'Data source'], ['q-steps', 'plan', 'Wizard steps'], ['q-access', 'plan', 'Access'], ['q-verify', 'plan', 'Verification']]);
  const steps = v.result.offers[2];
  assert.match(steps.hint, /^A step is one screen of the wizard: Next and Back move between steps/);
  assert.deepEqual(v.result.offers.filter((o) => o.hint !== null).map((o) => o.id), ['q-steps'], 'only the question with a word to explain has a line');
  assert.deepEqual(steps.options.map((o) => [o.id, o.label, o.suggested, o.chosen]), [['three', '3 steps: details, review, done', true, false], ['two', '2 steps: details, done', false, false], ['four', '4 steps: details, options, review, done', false, false]]);
  assert.equal(steps.status, "Not chosen yet, so the plan below uses the rules' default: 3 steps: details, review, done.");
  assert.equal(v.result.approve.canApprove, true);
  const four = build({ 'q-steps': 'four' }).result.offers[2];
  assert.deepEqual([four.status, four.decidedBy, four.options.map((o) => o.chosen)], ['Chosen: 4 steps: details, options, review, done. Decided by: person.', 'person', [false, false, true]]);
  assert.deepEqual(withAnswer([{ id: 'q-shape', option: 'wizard' }], { id: 'q-steps', source: 'plan' }, 'four'), [{ id: 'q-shape', option: 'wizard' }, { id: 'q-steps', option: 'four' }]);
});

// #622: how a list, detail or dashboard screen shows its states (q-states) is a plan card, titled and explained in plain words, default views first, and never blocks Approve; a skip's warning reaches the Approve bar.
test('the screen states question (q-states) is a plan card with a plain line about states; choosing a skip changes the status words and never blocks Approve', () => {
  const card = parseRequirement('A user wants to see a list of products').card;
  const placement = placeCard(card, { framework: 'react-spa', answers: { 'q-shape': 'list' } });
  const build = (answers = {}) => {
    const planned = planFromBlocks(placement.blocks, { feature: 'products', root: '/x', decisions: placement.decisions, answers, card });
    return shapeView({ card, placement: { ...placement, decisions: planned.decisions }, plan: planned.plan, files: planned.files, open: [], offers: [...placement.offers, ...planned.offers.map((q) => ({ ...q, source: 'plan' }))], warnings: planned.warnings, summary: { readBack: [], blocks: [] } });
  };
  const v = build();
  assert.deepEqual(v.result.offers.map((o) => [o.id, o.kind, o.heading]), [['q-shape', 'shape', 'Screen shape'], ['q-source', 'source', 'Data source'], ['q-states', 'plan', 'Screen states'], ['q-access', 'plan', 'Access'], ['q-verify', 'plan', 'Verification']]);
  const states = v.result.offers[2];
  assert.match(states.hint, /^A state is what the screen shows in one situation: while the data loads/);
  assert.deepEqual(v.result.offers.filter((o) => o.hint !== null).map((o) => o.id), ['q-states'], 'only the question with a word to explain has a line');
  assert.deepEqual(states.options.map((o) => [o.id, o.suggested, o.chosen]), [['default', true, false], ['custom', false, false], ['skip-empty', false, false], ['skip-all', false, false]]);
  assert.equal(states.status, "Not chosen yet, so the plan below uses the rules' default: default views, a short message for each state.");
  assert.deepEqual([v.result.approve.canApprove, v.result.warnings], [true, []]);
  const skipped = build({ 'q-states': 'skip-all' });
  assert.deepEqual([skipped.result.offers[2].status, skipped.result.offers[2].decidedBy], ['Chosen: Skip every state view (a warning). Decided by: person.', 'person']);
  assert.equal(skipped.result.approve.canApprove, true, 'a skip is a warning, never a block');
  assert.match(skipped.result.warnings.join(' '), /Products screen has no view for any state/);
  assert.deepEqual(withAnswer([{ id: 'q-shape', option: 'list' }], { id: 'q-states', source: 'plan' }, 'skip-all'), [{ id: 'q-shape', option: 'list' }, { id: 'q-states', option: 'skip-all' }]);
});
