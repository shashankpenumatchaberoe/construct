// #617 -- a chooser asks one closed question; a chain of answers compiles to an ordinary plan. Definitions fail by named
// code, the summary has a fixed size, the compiled plan passes validatePlan, attribution rides beside the plan, and the
// worked example in docs/BLOCK-CONTRACT.md is executed here so it cannot go stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAN_FLOWS, validatePlan } from '../packages/core/plan.mjs';
import { GUARDRAILS } from '../packages/core/block-contract.mjs';
import { CHOOSER_ERROR_CODES, CHOOSER_LIMITS, DECISION_SOURCES, EXIT_ANSWER, chooserSummary, compileChain, defineChooser, validateChooser } from '../packages/core/chooser.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const codes = (r) => r.errors.map((e) => e.code);
const validateOpt = { id: 'check', label: 'Check the project', flow: 'validate', args: {} };
const featureOpt = (id, name) => ({ id, label: `Feature ${name}`, flow: 'create.feature', args: { name } });
const unitOpt = (id, layer, name, feature = 'cart') => ({ id, label: `${layer} ${name}`, flow: 'create.unit', args: { layer, name, feature } });
const spec = (over = {}) => ({ id: 'app.feature', question: 'Which feature?', options: [featureOpt('cart', 'cart'), featureOpt('wishlist', 'wishlist')], ...over });

const featureChooser = () => defineChooser(spec());
const unitChooser = () => defineChooser({ id: 'app.unit', question: 'First unit?', options: [unitOpt('rules', 'domain', 'cartRules'), unitOpt('page', 'page', 'CartPage')] });

function project() {
  const root = makeTempDir('og617-');
  fs.writeFileSync(path.join(root, 'architecture.yml'), 'features:\n  root: features\n');
  return root;
}

test('the error codes are a frozen name-to-name map, and the closed sets are what the issue names', () => {
  assert.equal(Object.isFrozen(CHOOSER_ERROR_CODES), true);
  for (const [k, v] of Object.entries(CHOOSER_ERROR_CODES)) assert.equal(k, v);
  assert.deepEqual([...DECISION_SOURCES], ['person', 'llm', 'decision-model']);
  assert.deepEqual([CHOOSER_LIMITS.minOptions, CHOOSER_LIMITS.maxOptions], [2, 5]);
});

test('a valid chooser is deep-frozen, copied from the spec, and defaults its exit to manual.task', () => {
  const input = spec();
  const chooser = defineChooser(input);
  assert.equal(Object.isFrozen(chooser), true);
  assert.equal(Object.isFrozen(chooser.options[0].args), true);
  input.options[0].args.name = 'changed';
  assert.equal(chooser.options[0].args.name, 'cart', 'the chooser does not alias the spec');
  assert.equal(chooser.exit.flow, 'manual.task');
  assert.equal(validateChooser(spec()).valid, true);
});

test('definition: every problem is named by code', () => {
  assert.deepEqual(codes(validateChooser(null)), ['CHOOSER_NOT_OBJECT']);
  assert.deepEqual(codes(validateChooser(spec({ id: 'has space' }))), ['CHOOSER_ID_INVALID']);
  assert.deepEqual(codes(validateChooser(spec({ id: '' }))), ['CHOOSER_ID_INVALID']);
  assert.deepEqual(codes(validateChooser(spec({ question: ' ' }))), ['CHOOSER_QUESTION_INVALID']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a')] }))), ['CHOOSER_OPTIONS_COUNT'], 'one option is not a question');
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => featureOpt(n, n));
  assert.deepEqual(codes(validateChooser(spec({ options: six }))), ['CHOOSER_OPTIONS_COUNT']);
  assert.equal(validateChooser(spec({ options: six.slice(0, 5) })).valid, true, 'five is allowed');
  assert.deepEqual(codes(validateChooser(spec({ options: 'x' }))), ['CHOOSER_OPTIONS_COUNT']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), null] }))), ['CHOOSER_OPTION_NOT_OBJECT']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), featureOpt('a', 'b')] }))), ['CHOOSER_OPTION_ID_DUPLICATE']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), featureOpt('has space', 'b')] }))), ['CHOOSER_OPTION_ID_INVALID']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), featureOpt(EXIT_ANSWER, 'b')] }))), ['CHOOSER_OPTION_ID_INVALID'], '"exit" is reserved');
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), { ...featureOpt('b', 'b'), label: '' }] }))), ['CHOOSER_OPTION_LABEL_INVALID']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), { ...featureOpt('b', 'b'), why: 3 }] }))), ['CHOOSER_OPTION_FIELD_INVALID']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), { ...featureOpt('b', 'b'), requires: [1] }] }))), ['CHOOSER_OPTION_FIELD_INVALID']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), { ...featureOpt('b', 'b'), flow: 'nope' }] }))), ['CHOOSER_OPTION_FLOW_UNKNOWN']);
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), { ...featureOpt('b', 'b'), flow: undefined }] }))), ['CHOOSER_OPTION_FLOW_UNKNOWN']);
});

test('definition: args are checked by validatePlan itself (missing, unknown, wrong enum), not by a second rule set', () => {
  const bad = (option) => codes(validateChooser(spec({ options: [featureOpt('a', 'a'), option] })));
  assert.deepEqual(bad({ id: 'b', label: 'B', flow: 'create.feature', args: {} }), ['CHOOSER_OPTION_ARGS_INVALID'], 'a required arg is missing');
  assert.deepEqual(bad({ id: 'b', label: 'B', flow: 'create.feature', args: { name: 'x', colour: 'red' } }), ['CHOOSER_OPTION_ARGS_INVALID'], 'an unknown arg');
  assert.deepEqual(bad({ id: 'b', label: 'B', flow: 'project.init', args: { framework: 'rails' }, touches: { features: [], files: [] } }), ['CHOOSER_OPTION_ARGS_INVALID'], 'not in the enum');
  const r = validateChooser(spec({ options: [featureOpt('a', 'a'), { id: 'b', label: 'B', flow: 'create.feature', args: {} }] }));
  assert.match(r.errors[0].message, /name/);
  assert.equal(r.errors[0].path, 'options[1].args');
});

test('definition: a writer whose files cannot be derived must declare touches, and they must be a valid scope', () => {
  const mv = { id: 'b', label: 'Move it', flow: 'refactor.move', args: { name: 'Cart', feature: 'cart', from: 'domain', to: 'service' } };
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), mv] }))), ['CHOOSER_OPTION_TOUCHES_REQUIRED']);
  const touches = { features: ['cart'], files: [{ path: 'features/cart/domain/Cart.domain.ts', change: 'move' }] };
  assert.equal(validateChooser(spec({ options: [featureOpt('a', 'a'), { ...mv, touches }] })).valid, true);
  const abs = { features: [], files: [{ path: '/etc/passwd', change: 'modify' }] };
  assert.deepEqual(codes(validateChooser(spec({ options: [featureOpt('a', 'a'), { ...mv, touches: abs }] }))), ['CHOOSER_OPTION_TOUCHES_INVALID']);
  assert.equal(validateChooser(spec({ options: [featureOpt('a', 'a'), validateOpt] })).valid, true, 'a read-only flow needs none');
});

test('definition: the exit is manual.task or an ai action carrying every guardrail, nothing else', () => {
  const withExit = (exit) => codes(validateChooser(spec({ exit })));
  assert.deepEqual(withExit({ flow: 'manual.task', args: { instructions: 'Do it yourself.' } }), []);
  assert.deepEqual(withExit({ flow: 'manual.task' }), ['CHOOSER_EXIT_INVALID'], 'instructions are required');
  assert.deepEqual(withExit({ flow: 'validate', args: {} }), ['CHOOSER_EXIT_INVALID'], 'only manual.task');
  assert.deepEqual(withExit('manual.task'), ['CHOOSER_EXIT_INVALID']);
  const ai = { id: 'fill-with-ai', kind: 'ai', label: 'Fill with AI', enabled: true, gates: [...GUARDRAILS] };
  assert.deepEqual(withExit(ai), []);
  assert.deepEqual(withExit({ ...ai, gates: ['containment', 'approval'] }), ['CHOOSER_EXIT_INVALID'], 'a gate is missing');
  assert.deepEqual(withExit({ ...ai, gates: undefined }), ['CHOOSER_EXIT_INVALID']);
  assert.deepEqual(withExit({ ...ai, kind: 'free' }), ['CHOOSER_EXIT_INVALID'], 'a free action is not an exit here');
  assert.deepEqual(withExit({ ...ai, kind: 'mechanical' }), ['CHOOSER_EXIT_INVALID']);
  assert.deepEqual(withExit({ ...ai, label: '' }), ['CHOOSER_EXIT_INVALID']);
});

test('defineChooser throws a TypeError listing the codes; PLAN_FLOWS is not touched', () => {
  const before = JSON.stringify(PLAN_FLOWS);
  assert.throws(() => defineChooser(spec({ options: [] })), (e) => e instanceof TypeError && /CHOOSER_OPTIONS_COUNT/.test(e.message));
  assert.equal(JSON.stringify(PLAN_FLOWS), before);
});

test('summary: fixed shape, options in order, nothing but id/label/enabled/why, chosen only when it names an option', () => {
  const chooser = defineChooser(spec({ options: [{ ...featureOpt('cart', 'cart'), why: 'The empty cart slice.' }, featureOpt('wishlist', 'wishlist')] }));
  const summary = chooserSummary(chooser, { chosen: 'wishlist' });
  assert.deepEqual(summary, {
    id: 'app.feature',
    question: 'Which feature?',
    options: [
      { id: 'cart', label: 'Feature cart', enabled: true, why: 'The empty cart slice.' },
      { id: 'wishlist', label: 'Feature wishlist', enabled: true, why: '' },
    ],
    chosen: 'wishlist',
  });
  assert.equal(chooserSummary(chooser, { chosen: 'nope' }).chosen, null);
  assert.equal(chooserSummary(chooser).chosen, null);
  assert.equal(chooserSummary(chooser, 'junk').chosen, null, 'a junk state is an empty state');
  assert.throws(() => chooserSummary(spec(), {}), /defineChooser/, 'only a defined chooser has a summary');
  assert.throws(() => chooserSummary({ ...chooser }, {}), /defineChooser/);
});

test('summary: options are disabled by a reason in state or by unmet requires, with the why a person reads', () => {
  const chooser = defineChooser(spec({ options: [featureOpt('cart', 'cart'), { ...featureOpt('wishlist', 'wishlist'), requires: ['openapi'] }, { ...featureOpt('orders', 'orders'), requires: ['openapi', 'auth'] }] }));
  const none = chooserSummary(chooser, {});
  assert.deepEqual(none.options.map((o) => [o.id, o.enabled, o.why]), [['cart', true, ''], ['wishlist', false, 'Needs: openapi.'], ['orders', false, 'Needs: openapi, auth.']]);
  const some = chooserSummary(chooser, { facts: ['openapi'], disabled: { cart: 'A cart already exists.' } });
  assert.deepEqual(some.options.map((o) => [o.id, o.enabled, o.why]), [['cart', false, 'A cart already exists.'], ['wishlist', true, ''], ['orders', false, 'Needs: auth.']]);
});

test('summary: fixed maximum size, whatever the definition says (capped text, absolute paths redacted, at most 5 options)', () => {
  const long = 'word '.repeat(200);
  const options = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ ...featureOpt(n, n), label: long, why: long }));
  const chooser = defineChooser(spec({ question: long, options }));
  const summary = chooserSummary(chooser, { disabled: { a: `Blocked by /home/dev/secret/app and C:\\Users\\me\\x and ../up and ~/rc but and/or is fine ${long}` } });
  assert.ok(summary.options.length <= CHOOSER_LIMITS.maxOptions);
  assert.ok(summary.question.length <= CHOOSER_LIMITS.question);
  for (const o of summary.options) {
    assert.ok(o.label.length <= CHOOSER_LIMITS.label);
    assert.ok(o.why.length <= CHOOSER_LIMITS.why);
  }
  assert.ok(summary.options[0].why.startsWith('Blocked by [path] and [path] and [path] and [path] but and/or is fine'));
  assert.doesNotMatch(JSON.stringify(summary), /home\/dev|Users|\.\.\/|~\//);
  assert.ok(JSON.stringify(summary).length < 2000, 'a summary is small');
});

test('the summary is deterministic: the same chooser and state give byte-identical JSON', () => {
  const chooser = featureChooser();
  const state = { facts: ['x'], disabled: { wishlist: 'Not yet.' } };
  assert.equal(JSON.stringify(chooserSummary(chooser, state)), JSON.stringify(chooserSummary(chooser, state)));
});

test('compile: the two-question chain (create.feature then create.unit) is a plan that passes validatePlan, with derived touches', () => {
  const root = project();
  const r = compileChain([featureChooser(), unitChooser()], { 'app.feature': 'cart', 'app.unit': 'rules' }, { root, title: 'Start the cart' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(validatePlan(r.plan), { valid: true, errors: [] });
  assert.deepEqual(r.plan.ticket, { source: 'text', title: 'Start the cart' });
  assert.deepEqual(r.plan.steps.map((s) => [s.id, s.flow, s.executor, s.dependsOn ?? null]), [
    ['s1', 'create.feature', 'deterministic', null],
    ['s2', 'create.unit', 'deterministic', ['s1']],
  ]);
  assert.deepEqual(r.plan.steps[0].args, { name: 'cart' });
  assert.deepEqual(r.plan.steps[0].touches.files.map((f) => f.path), ['features/cart/types.ts', 'features/cart/index.ts']);
  assert.deepEqual(r.plan.steps[1].touches.features, ['cart']);
  // #677: step 2 also declares the feature's own types.ts/index.ts, since "cart" doesn't exist on disk yet at
  // plan time (step 1 hasn't run) -- create.unit's own derived scope is accurate taken alone, even though step 1
  // will already have created them by the time step 2 actually runs.
  assert.deepEqual(r.plan.steps[1].touches.files.map((f) => f.path), ['features/cart/types.ts', 'features/cart/index.ts', 'features/cart/domain/CartRules.tsx']);
  assert.equal(r.plan.steps[1].touches.files.at(-1).layer, 'domain');
  assert.deepEqual(Object.keys(r.plan).sort(), ['steps', 'ticket', 'version'], 'no top-level field validatePlan would reject');
  assert.deepEqual(r.errors, []);
});

test('compile is deterministic and does not alias the chooser: a second run is byte-identical and mutating the plan changes nothing', () => {
  const root = project();
  const chain = [featureChooser(), unitChooser()];
  const answers = { 'app.feature': 'wishlist', 'app.unit': 'page' };
  const one = JSON.stringify(compileChain(chain, answers, { root }));
  const two = JSON.stringify(compileChain(chain, answers, { root }));
  assert.equal(one, two);
  const r = compileChain(chain, answers, { root });
  r.plan.steps[0].args.name = 'mutated';
  assert.equal(chain[0].options[1].args.name, 'wishlist');
});

test('compile: the default title names the chain, and a read-only flow yields an empty scope', () => {
  const root = project();
  const chooser = defineChooser({ id: 'app.check', question: 'Check now?', options: [validateOpt, featureOpt('cart', 'cart')] });
  const r = compileChain([chooser], { 'app.check': 'check' }, { root });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.plan.ticket.title, 'Chain: app.check');
  assert.deepEqual(r.plan.steps[0].touches, { features: [], files: [] });
});

test('compile: an option with declared touches uses them (a declared-scope flow), and its own executor rule', () => {
  const touches = { features: ['cart'], files: [{ path: 'features/cart/domain/Cart.domain.ts', change: 'move' }] };
  const chooser = defineChooser({
    id: 'app.move',
    question: 'Move it?',
    options: [{ id: 'move', label: 'Move Cart to service', flow: 'refactor.move', args: { name: 'Cart', feature: 'cart', from: 'domain', to: 'service' }, touches }, validateOpt],
  });
  const r = compileChain([chooser], { 'app.move': 'move' }, { root: project() });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.plan.steps[0].touches, touches);
});

test('compile: a derived flow whose files cannot be derived without a root is a typed error, not a guess', () => {
  const r = compileChain([featureChooser()], { 'app.feature': 'cart' }, {});
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['CHAIN_TOUCHES_UNKNOWN']);
  assert.equal(r.plan, null);
});

test('compile: unknown, missing, extra and disabled answers are typed errors and never throw', () => {
  const root = project();
  const chain = [featureChooser(), unitChooser()];
  const ok = { 'app.feature': 'cart', 'app.unit': 'rules' };
  assert.deepEqual(codes(compileChain(chain, { ...ok, 'app.unit': 'nope' }, { root })), ['CHAIN_ANSWER_UNKNOWN_OPTION']);
  assert.deepEqual(codes(compileChain(chain, { ...ok, 'app.unit': 7 }, { root })), ['CHAIN_ANSWER_UNKNOWN_OPTION']);
  assert.deepEqual(codes(compileChain(chain, { 'app.feature': 'cart' }, { root })), ['CHAIN_ANSWER_MISSING']);
  assert.deepEqual(codes(compileChain(chain, { ...ok, 'app.other': 'x' }, { root })), ['CHAIN_ANSWER_UNKNOWN_CHOOSER']);
  assert.deepEqual(codes(compileChain(chain, {}, { root })), ['CHAIN_ANSWER_MISSING', 'CHAIN_ANSWER_MISSING'], 'every problem is reported');
  const states = { 'app.unit': { disabled: { rules: 'A cart rules unit already exists.' } } };
  const disabled = compileChain(chain, ok, { root, states });
  assert.deepEqual(codes(disabled), ['CHAIN_ANSWER_DISABLED']);
  assert.match(disabled.errors[0].message, /already exists/);
  const gated = defineChooser(spec({ id: 'app.gated', options: [{ ...featureOpt('a', 'a'), requires: ['openapi'] }, featureOpt('b', 'b')] }));
  assert.deepEqual(codes(compileChain([gated], { 'app.gated': 'a' }, { root })), ['CHAIN_ANSWER_DISABLED']);
  assert.equal(compileChain([gated], { 'app.gated': 'a' }, { root, states: { 'app.gated': { facts: ['openapi'] } } }).ok, true);
  for (const junk of [null, undefined, 'x', [], 5]) {
    assert.doesNotThrow(() => compileChain(chain, junk, { root }));
    assert.doesNotThrow(() => compileChain(junk, ok, { root }));
    assert.doesNotThrow(() => compileChain(chain, ok, junk));
  }
  assert.deepEqual(codes(compileChain([], ok, { root })), ['CHAIN_EMPTY']);
  assert.deepEqual(codes(compileChain(chain, 'x', { root })), ['CHAIN_ANSWERS_INVALID']);
  assert.deepEqual(codes(compileChain([spec()], ok, { root })), ['CHAIN_CHOOSER_INVALID'], 'a plain object is not a chooser');
  assert.deepEqual(codes(compileChain([chain[0], chain[0]], ok, { root })), ['CHAIN_CHOOSER_DUPLICATE']);
});

test('compile: attribution is recorded per step beside the plan (validatePlan rejects an unknown top-level field, so it is not inside it)', () => {
  const root = project();
  const chain = [featureChooser(), unitChooser()];
  const answers = { 'app.feature': 'cart', 'app.unit': { option: 'rules', by: 'llm' } };
  const r = compileChain(chain, answers, { root, by: 'decision-model', provider: 'rules' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.decisions, [
    { step: 's1', chooser: 'app.feature', option: 'cart', by: 'decision-model', provider: 'rules' },
    { step: 's2', chooser: 'app.unit', option: 'rules', by: 'llm', provider: 'rules' },
  ]);
  assert.equal(compileChain(chain, { 'app.feature': 'cart', 'app.unit': 'rules' }, { root }).decisions[0].by, 'person', 'the default is a person');
  assert.equal('provider' in compileChain(chain, { 'app.feature': 'cart', 'app.unit': 'rules' }, { root }).decisions[0], false);
  const inside = validatePlan({ ...r.plan, decisions: r.decisions });
  assert.equal(inside.valid, false, 'the reason it is returned beside the plan');
  assert.equal(inside.errors[0].code, 'PLAN_UNKNOWN_FIELD');
  assert.deepEqual(codes(compileChain(chain, { 'app.feature': 'cart', 'app.unit': 'rules' }, { root, by: 'robot' })), ['CHAIN_ATTRIBUTION_INVALID']);
  assert.deepEqual(codes(compileChain(chain, { 'app.feature': 'cart', 'app.unit': 'rules' }, { root, provider: '' })), ['CHAIN_ATTRIBUTION_INVALID']);
  assert.deepEqual(codes(compileChain(chain, { 'app.feature': 'cart', 'app.unit': { option: 'rules', by: 'robot' } }, { root })), ['CHAIN_ATTRIBUTION_INVALID']);
});

test('the exit: answering "exit" compiles a manual.task step for the person; an ai exit is a typed error, not a step', () => {
  const root = project();
  const manual = defineChooser(spec({ id: 'app.second', exit: { flow: 'manual.task', label: 'Something else', args: { instructions: 'Add the feature by hand.' }, touches: { features: [], files: [{ path: 'features/other/x.ts', change: 'create' }] } } }));
  const r = compileChain([featureChooser(), manual], { 'app.feature': 'cart', 'app.second': EXIT_ANSWER }, { root });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.plan.steps[1], {
    id: 's2', title: 'Something else', flow: 'manual.task', args: { instructions: 'Add the feature by hand.' }, executor: 'user',
    touches: { features: [], files: [{ path: 'features/other/x.ts', change: 'create' }] }, dependsOn: ['s1'],
  });
  assert.deepEqual(r.decisions[1], { step: 's2', chooser: 'app.second', option: 'exit', by: 'person' });
  const byDefault = compileChain([featureChooser()], { 'app.feature': EXIT_ANSWER }, { root });
  assert.equal(byDefault.ok, true, JSON.stringify(byDefault.errors));
  assert.deepEqual(byDefault.plan.steps[0].touches, { features: [], files: [] }, 'nothing declared, nothing approved');
  const ai = defineChooser(spec({ exit: { id: 'fill-with-ai', kind: 'ai', label: 'Fill with AI', enabled: true, gates: [...GUARDRAILS] } }));
  assert.deepEqual(codes(compileChain([ai], { 'app.feature': EXIT_ANSWER }, { root })), ['CHAIN_ANSWER_EXIT_UNSUPPORTED']);
});

test('the worked example in docs/BLOCK-CONTRACT.md runs and produces exactly the plan the doc shows', async () => {
  const doc = fs.readFileSync(path.join(here, '..', 'docs', 'BLOCK-CONTRACT.md'), 'utf8');
  const code = /<!-- chooser-example:code -->\n```js\n([\s\S]*?)```/.exec(doc)?.[1];
  const shown = /<!-- chooser-example:result -->\n```json\n([\s\S]*?)```/.exec(doc)?.[1];
  assert.ok(code && shown, 'the doc carries both example blocks');
  const dir = makeTempDir('og617-doc-');
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'features:\n  root: features\n');
  const chooserUrl = pathToFileURL(path.join(here, '..', 'packages', 'core', 'chooser.mjs')).href;
  assert.match(code, /'@line\/construct-core\/chooser'/);
  const file = path.join(dir, 'example.mjs');
  fs.writeFileSync(file, code.replace("'@line/construct-core/chooser'", `'${chooserUrl}'`));
  const cwd = process.cwd();
  let result;
  try {
    process.chdir(dir);
    ({ result } = await import(pathToFileURL(file).href));
  } finally {
    process.chdir(cwd);
  }
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(validatePlan(result.plan), { valid: true, errors: [] });
  assert.deepEqual(JSON.parse(shown), JSON.parse(JSON.stringify(result)));
});
