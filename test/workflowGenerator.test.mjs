import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  compileWorkflow,
  generateWorkflow,
  extractEventNames,
  eventsToEnvelope,
} from '../packages/engine/workflowGenerator.mjs';
import { createFeature } from '../packages/core/generators.mjs';
import { validateArchitecture, detectLayerViolations } from '../packages/core/architecture-enforcer.mjs';
import { parseToAst } from '../packages/core/parser.mjs';
import { ConstructError, EXIT_CODES } from '../packages/core/diagnostics.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const bin = path.join(REPO_ROOT, 'packages', 'cli', 'construct.mjs');
const CHECKOUT_DESCRIPTOR = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'workflow-graphs', 'checkout.json'), 'utf8'));

function tmpProject() {
  const dir = makeTempDir('construct-workflow-test-');
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nproject:\n  framework: nextjs\nfeatures:\n  root: features\n');
  createFeature(dir, 'checkout');
  return dir;
}

/** Real tsc --noEmit style check via the compiler API's Program, with a
 * minimal ambient `xstate` module stub (the repo doesn't install the real
 * `xstate` package -- generated files only ever run inside a *target*
 * project that does) so only this generator's own output is being checked,
 * not a third-party library's types. */
function tscCheck(tsxSource) {
  const dir = makeTempDir('construct-workflow-tsc-');
  const file = path.join(dir, 'Workflow.tsx');
  fs.writeFileSync(file, tsxSource);
  fs.writeFileSync(path.join(dir, 'xstate.d.ts'), `declare module 'xstate' {\n  export function setup(config: any): { createMachine(config: any): any };\n}\n`);

  const program = ts.createProgram([file, path.join(dir, 'xstate.d.ts')], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  fs.rmSync(dir, { recursive: true, force: true });
  return diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

// ---- descriptor validation --------------------------------------------

test('compileWorkflow rejects a descriptor missing "states"', () => {
  assert.throws(() => compileWorkflow({ initial: 'idle' }, { name: 'X' }), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.match(err.message, /"states"/);
    return true;
  });
});

test('compileWorkflow rejects a descriptor missing "initial"', () => {
  assert.throws(() => compileWorkflow({ states: { idle: {} } }, { name: 'X' }), /"initial"/);
});

test('compileWorkflow rejects an "initial" not present among "states"', () => {
  assert.throws(() => compileWorkflow({ initial: 'nope', states: { idle: {} } }, { name: 'X' }), /not one of its declared states/);
});

test('compileWorkflow rejects a malformed transition target', () => {
  const descriptor = { initial: 'idle', states: { idle: { on: { GO: { noTarget: true } } } } };
  assert.throws(() => compileWorkflow(descriptor, { name: 'X' }), /Invalid transition target/);
});

// ---- event extraction ---------------------------------------------------

test('extractEventNames collects every distinct event across states, deduped, in first-appearance order', () => {
  const events = extractEventNames(CHECKOUT_DESCRIPTOR.states);
  assert.deepEqual(events, ['SUBMIT', 'SUCCESS', 'FAILURE']);
});

test('eventsToEnvelope shapes event names into the Context Envelope events array', () => {
  assert.deepEqual(eventsToEnvelope(['SUBMIT', 'SUCCESS']), [
    { type: 'SUBMIT', payload: {} },
    { type: 'SUCCESS', payload: {} },
  ]);
});

// ---- compileWorkflow: AST synthesis output shape -------------------------

test('compileWorkflow emits a real setup(...).createMachine(...) XState v5 call with the right structure', () => {
  const { source, events, contextFields } = compileWorkflow(CHECKOUT_DESCRIPTOR, { name: 'Checkout' });

  assert.deepEqual(events, ['SUBMIT', 'SUCCESS', 'FAILURE']);
  assert.deepEqual(contextFields, ['quantity', 'error']);

  assert.match(source, /import \{ setup \} from 'xstate';/);
  assert.match(source, /export interface CheckoutContext \{/);
  assert.match(source, /quantity: number;/);
  assert.match(source, /error: string \| null;/);
  assert.match(source, /export type CheckoutEvent =/);
  assert.match(source, /type: "SUBMIT";/);
  assert.match(source, /export const CheckoutWorkflow = setup\(\{/);
  assert.match(source, /\}\)\.createMachine\(\{/);
  assert.match(source, /id: 'checkout',/);
  assert.match(source, /initial: 'idle',/);
  assert.match(source, /context: \{ quantity: 1, error: null \}/); // runtime defaults

  // Shorthand string target for a guardless transition ...
  assert.match(source, /SUBMIT: "submitting"/);
  assert.match(source, /SUCCESS: "done"/);
  // ... vs. the full object form once a guard is present.
  assert.match(source, /FAILURE: \{ target: "idle", guard: "hasError" \}/);
  assert.match(source, /type: "final"/);
});

test('compileWorkflow supports array-form (multi-guarded) transitions', () => {
  const descriptor = {
    initial: 'idle',
    states: {
      idle: { on: { GO: [{ target: 'a', guard: 'isA' }, { target: 'b' }] } },
      a: {},
      b: {},
    },
  };
  const { source } = compileWorkflow(descriptor, { name: 'Multi' });
  assert.match(source, /GO: \[\s*\{ target: "a", guard: "isA" \},\s*"b"\s*\]/);
});

test('compileWorkflow with no context declared falls back to a Record<string, never> alias (still valid TS)', () => {
  const { source, contextFields } = compileWorkflow({ initial: 'idle', states: { idle: {} } }, { name: 'Bare' });
  assert.deepEqual(contextFields, []);
  assert.match(source, /export type BareContext = Record<string, never>;/);
  // XState's MachineConfig requires the key when the context type is not `{}` (tsc: "Property 'context' is missing"), so an empty object is emitted (#576).
  assert.match(source, /^  context: \{\},$/m);
});

test('compileWorkflow eventPayloads (#576): an object payload flattens beside type, any other type is intersected, typeImports become import type lines', () => {
  const { source } = compileWorkflow({
    initial: 'idle',
    eventPayloads: { SUBMIT: '{ email: string; who: Person }', PICK: 'Choice' },
    typeImports: [{ from: '../types', names: ['Person', 'Choice'] }],
    states: { idle: { on: { SUBMIT: 'idle', PICK: 'idle', PLAIN: 'idle' } } },
  }, { name: 'Pay' });
  assert.match(source, /import type \{ Choice, Person \} from '\.\.\/types';/);
  assert.match(source, /type: "SUBMIT";\s+email: string;\s+who: Person;/);
  assert.match(source, /\{\s*type: "PICK";\s*\} & Choice/);
  assert.match(source, /\{\s*type: "PLAIN";\s*\}/);
});

test('compileWorkflow with no events at all still emits syntactically valid TS', () => {
  const { source, events } = compileWorkflow({ initial: 'idle', states: { idle: {} } }, { name: 'NoEvents' });
  assert.deepEqual(events, []);
  assert.doesNotThrow(() => parseToAst(source));
});

// ---- the generated output is real, valid, clean TypeScript ---------------

test('compileWorkflow output parses cleanly via typescript-estree', () => {
  const { source } = compileWorkflow(CHECKOUT_DESCRIPTOR, { name: 'Checkout' });
  assert.doesNotThrow(() => parseToAst(source));
});

test('compileWorkflow output compiles cleanly under tsc --noEmit (against a minimal xstate ambient stub)', () => {
  const { source } = compileWorkflow(CHECKOUT_DESCRIPTOR, { name: 'Checkout' });
  const diagnostics = tscCheck(source);
  assert.deepEqual(diagnostics, [], `expected zero tsc diagnostics, got:\n${diagnostics.join('\n')}`);
});

// ---- WORKFLOW-001: generator output trivially passes; the rule still catches corruption

test('the generated workflow source itself trips no WORKFLOW-001 violation (never imports React/UI)', () => {
  const { source } = compileWorkflow(CHECKOUT_DESCRIPTOR, { name: 'Checkout' });
  const violations = detectLayerViolations('workflow', source);
  assert.deepEqual(violations.filter((v) => v.rule === 'WORKFLOW-001'), []);
});

test('WORKFLOW-001 regression: corrupting this generator\'s own clean output with a React import is still caught', () => {
  const { source } = compileWorkflow(CHECKOUT_DESCRIPTOR, { name: 'Checkout' });
  const corrupted = `import { useState } from 'react';\n${source}`;
  const violations = detectLayerViolations('workflow', corrupted);
  assert.ok(violations.some((v) => v.rule === 'WORKFLOW-001'));
});

// ---- generateWorkflow: filesystem-backed, end-to-end via validateArchitecture

test('generateWorkflow writes a workflow file that passes construct validate cleanly', () => {
  const dir = tmpProject();
  const { file, events, contextFields } = generateWorkflow(dir, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR);

  assert.equal(file, path.join(dir, 'features', 'checkout', 'workflows', 'CheckoutWorkflow.tsx'));
  assert.deepEqual(events, ['SUBMIT', 'SUCCESS', 'FAILURE']);
  assert.deepEqual(contextFields, ['quantity', 'error']);
  assert.equal(fs.existsSync(file), true);

  const { violations } = validateArchitecture(dir);
  assert.deepEqual(violations.filter((v) => v.severity === 'error'), []);
});

// #677 -- `construct create workflow <name> --feature <missing> --from <path>` used to write only workflows/,
// leaving the rest of the feature's layer folders and its types.ts/index.ts missing.
test('#677: generateWorkflow into a missing feature scaffolds the feature first', () => {
  const dir = makeTempDir('construct-workflow-test-');
  const { file } = generateWorkflow(dir, 'Checkout', 'nope', CHECKOUT_DESCRIPTOR);
  assert.equal(fs.existsSync(file), true);
  const featureDir = path.join(dir, 'features', 'nope');
  assert.ok(fs.existsSync(path.join(featureDir, 'types.ts')));
  assert.ok(fs.existsSync(path.join(featureDir, 'index.ts')));
  const { violations } = validateArchitecture(dir);
  assert.deepEqual(violations.filter((v) => v.severity === 'error'), []);
});

// ---- end-to-end via the real CLI binary ------------------------------------

test('construct create workflow <name> --feature <f> --from <path> compiles end to end and construct validate passes', () => {
  const dir = tmpProject();
  const res = spawnSync('node', [
    bin, 'create', 'workflow', 'Checkout', '--feature', 'checkout', '--from', path.join(REPO_ROOT, 'fixtures', 'workflow-graphs', 'checkout.json'),
  ], { encoding: 'utf8', cwd: dir });

  assert.equal(res.status, EXIT_CODES.OK, res.stderr);
  assert.match(res.stdout, /CheckoutWorkflow\.tsx/);
  assert.match(res.stdout, /3 event\(s\): SUBMIT, SUCCESS, FAILURE/);

  const validateRes = spawnSync('node', [bin, 'validate'], { encoding: 'utf8', cwd: dir });
  assert.equal(validateRes.status, EXIT_CODES.OK, validateRes.stdout);
});

test('construct create workflow: malformed descriptor JSON is a usage error, not an internal crash', () => {
  const dir = tmpProject();
  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, '{ not valid json');
  const res = spawnSync('node', [bin, 'create', 'workflow', 'Checkout', '--feature', 'checkout', '--from', badPath], { encoding: 'utf8', cwd: dir });
  assert.equal(res.status, EXIT_CODES.USAGE_ERROR);
  assert.match(res.stderr, /Malformed workflow descriptor JSON/);
});

test('construct create workflow: a missing descriptor file is a usage error naming the path', () => {
  const dir = tmpProject();
  const res = spawnSync('node', [bin, 'create', 'workflow', 'Checkout', '--feature', 'checkout', '--from', path.join(dir, 'nope.json')], { encoding: 'utf8', cwd: dir });
  assert.equal(res.status, EXIT_CODES.USAGE_ERROR);
  assert.match(res.stderr, /Workflow descriptor not found/);
});

// ---- #216: identifier handling for the workflow name ---------------------

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String);
}

test('generateWorkflow: hyphenated, underscored and camel names give identical valid output (#216)', () => {
  const sources = {};
  for (const name of ['refund-request', 'refund_request', 'refundRequest', 'RefundRequest']) {
    const dir = tmpProject();
    const { file } = generateWorkflow(dir, name, 'checkout', CHECKOUT_DESCRIPTOR);
    assert.equal(path.basename(file), 'RefundRequestWorkflow.tsx', name);
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotThrow(() => parseToAst(source, file), name);
    assert.match(source, /export interface RefundRequestContext \{/);
    assert.match(source, /export type RefundRequestEvent = /);
    assert.match(source, /export const RefundRequestWorkflow = setup\(/);
    assert.doesNotMatch(source, /Refund-request|Refund_request/);
    sources[name] = source.replace(/id: '[^']*'/, "id: 'X'");
  }
  const [first, ...rest] = Object.values(sources);
  for (const s of rest) assert.equal(s, first);
});

test('generateWorkflow: a name that cannot form an identifier is rejected before anything is written (#216)', () => {
  const dir = tmpProject();
  const before = listFiles(path.join(dir, 'features'));
  for (const bad of ['3d-checkout', '9lives', 'has space']) {
    assert.throws(() => generateWorkflow(dir, bad, 'checkout', CHECKOUT_DESCRIPTOR), (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /Workflow name ".*" can't be turned into a valid TypeScript identifier/);
      return true;
    });
  }
  assert.deepEqual(listFiles(path.join(dir, 'features')), before);
});

// ---- #580: opt-in --state-union (typed state union + exhaustive matcher) -----------------

const STATE_UNION_FILE = ['features', 'checkout', 'workflows', 'CheckoutWorkflowState.ts'];

/** Type-check `files` (absolute paths) with the repo's TypeScript; returns the error messages. */
function tscErrors(dir, files) {
  const opts = { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, types: [] };
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, files: files.map((f) => path.relative(dir, f)) }));
  const program = ts.createProgram(files, opts);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

test('--state-union: without the flag nothing but the machine is written and its output is unchanged (#580)', () => {
  const dir = tmpProject();
  const res = generateWorkflow(dir, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR);
  assert.deepEqual(Object.keys(res), ['file', 'events', 'contextFields']);
  assert.deepEqual(listFiles(path.join(dir, 'features', 'checkout', 'workflows')), ['CheckoutWorkflow.tsx']);
  const withFlag = tmpProject();
  generateWorkflow(withFlag, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR, { stateUnion: true });
  assert.equal(
    fs.readFileSync(res.file, 'utf8'),
    fs.readFileSync(path.join(withFlag, 'features', 'checkout', 'workflows', 'CheckoutWorkflow.tsx'), 'utf8'),
  );
});

test('--state-union: the union has exactly the descriptor\'s states, status only, and validate passes (#580)', () => {
  const dir = tmpProject();
  const { stateFile } = generateWorkflow(dir, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR, { stateUnion: true });
  assert.equal(stateFile, path.join(dir, ...STATE_UNION_FILE));
  const source = fs.readFileSync(stateFile, 'utf8');
  const members = [...source.matchAll(/\| \{ status: '([^']+)' \}/g)].map((m) => m[1]);
  assert.deepEqual(members, Object.keys(CHECKOUT_DESCRIPTOR.states));
  assert.match(source, /export function matchCheckoutState</);
  assert.match(source, /export function assertNeverCheckoutState\(/);
  const { violations } = validateArchitecture(dir);
  assert.deepEqual(violations.filter((v) => v.severity === 'error'), []);
});

test('--state-union: the emitted file type-checks, and a non-exhaustive match or switch fails tsc (#580)', () => {
  const dir = tmpProject();
  const { stateFile } = generateWorkflow(dir, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR, { stateUnion: true });
  const good = path.join(dir, 'good.ts');
  fs.writeFileSync(good, [
    `import { matchCheckoutState, assertNeverCheckoutState, type CheckoutState } from './features/checkout/workflows/CheckoutWorkflowState';`,
    `export const label = (s: CheckoutState): string => matchCheckoutState(s, { idle: () => 'i', submitting: () => 's', done: () => 'd' });`,
    `export function sw(s: CheckoutState): number {`,
    `  switch (s.status) { case 'idle': return 1; case 'submitting': return 2; case 'done': return 3; default: return assertNeverCheckoutState(s); }`,
    `}`,
  ].join('\n'));
  assert.deepEqual(tscErrors(dir, [stateFile, good]), []);

  const missingKey = path.join(dir, 'bad-match.ts');
  fs.writeFileSync(missingKey, [
    `import { matchCheckoutState, type CheckoutState } from './features/checkout/workflows/CheckoutWorkflowState';`,
    `export const label = (s: CheckoutState): string => matchCheckoutState(s, { idle: () => 'i', submitting: () => 's' });`,
  ].join('\n'));
  assert.ok(tscErrors(dir, [stateFile, missingKey]).some((m) => /done/.test(m)), 'a missing handler must be a type error naming the state');

  const missingCase = path.join(dir, 'bad-switch.ts');
  fs.writeFileSync(missingCase, [
    `import { assertNeverCheckoutState, type CheckoutState } from './features/checkout/workflows/CheckoutWorkflowState';`,
    `export function sw(s: CheckoutState): number {`,
    `  switch (s.status) { case 'idle': return 1; case 'submitting': return 2; default: return assertNeverCheckoutState(s); }`,
    `}`,
  ].join('\n'));
  assert.ok(tscErrors(dir, [stateFile, missingCase]).length > 0, 'an unhandled switch case must be a type error');
});

test('--state-union: two runs give identical bytes, and a hand-written file is refused with nothing written (#580)', () => {
  const dir = tmpProject();
  const first = generateWorkflow(dir, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR, { stateUnion: true });
  const bytes = [first.file, first.stateFile].map((f) => fs.readFileSync(f, 'utf8'));
  const second = generateWorkflow(dir, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR, { stateUnion: true });
  assert.deepEqual([second.file, second.stateFile].map((f) => fs.readFileSync(f, 'utf8')), bytes);

  fs.writeFileSync(first.stateFile, 'export type CheckoutState = { status: "mine" };\n');
  fs.rmSync(first.file);
  assert.throws(() => generateWorkflow(dir, 'Checkout', 'checkout', CHECKOUT_DESCRIPTOR, { stateUnion: true }), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.match(err.message, /Refusing to write .*CheckoutWorkflowState\.ts/);
    return true;
  });
  assert.equal(fs.existsSync(first.file), false, 'the machine must not be written when the union file is refused');
  assert.equal(fs.readFileSync(first.stateFile, 'utf8'), 'export type CheckoutState = { status: "mine" };\n');
});

test('construct generate workflow --state-union: CLI writes both files and validate passes; usage text lists the flag (#580)', () => {
  const dir = tmpProject();
  const res = spawnSync('node', [
    bin, 'generate', 'workflow', 'Checkout', '--feature', 'checkout', '--from', path.join(REPO_ROOT, 'fixtures', 'workflow-graphs', 'checkout.json'), '--state-union',
  ], { encoding: 'utf8', cwd: dir });
  assert.equal(res.status, EXIT_CODES.OK, res.stderr);
  assert.match(res.stdout, /CheckoutWorkflowState\.ts/);
  assert.equal(fs.existsSync(path.join(dir, ...STATE_UNION_FILE)), true);
  assert.equal(spawnSync('node', [bin, 'validate'], { encoding: 'utf8', cwd: dir }).status, EXIT_CODES.OK);
  assert.match(spawnSync('node', [bin, '--help'], { encoding: 'utf8' }).stdout, /--state-union/);
});
