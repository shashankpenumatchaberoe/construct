import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  extractPropsInterfaceMembers,
  extractHookSignature,
  matchSlotsToHandlers,
  generateController,
} from '../packages/engine/controllerBinder.mjs';
import { createFeature } from '../packages/core/generators.mjs';
import { parseToAst } from '../packages/core/parser.mjs';
import { createEnvelope } from '../packages/engine/envelope.mjs';
import { validateArchitecture, detectLayerViolations } from '../packages/core/architecture-enforcer.mjs';
import { ConstructError, EXIT_CODES } from '../packages/core/diagnostics.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const bin = path.join(REPO_ROOT, 'packages', 'cli', 'construct.mjs');

const PAGE_PROPS_SOURCE = `export interface CheckoutPageProps {
  onCategoryChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  value: string;
  onReset: () => void;
}
`;

const HOOK_SOURCE = `import { useState } from 'react';

export function useCheckout() {
  const [category, setCategory] = useState('');
  const [value, setValue] = useState('');

  function onSubmit() {
    setCategory('');
  }

  return { setCategory, value, onSubmit };
}
`;

const PAGE_SOURCE = `import type { CheckoutPageProps } from './CheckoutPageProps';

export function CheckoutPage({ onCategoryChange, onSubmit, value, onReset }: CheckoutPageProps) {
  return (
    <form onSubmit={onSubmit}>
      <input value={value} onChange={onCategoryChange} />
      <button type="button" onClick={onReset}>Reset</button>
    </form>
  );
}
`;

function tmpProject() {
  const dir = makeTempDir('construct-controller-test-');
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nproject:\n  framework: nextjs\nfeatures:\n  root: features\n');
  createFeature(dir, 'checkout');
  fs.writeFileSync(path.join(dir, 'features', 'checkout', 'pages', 'CheckoutPageProps.ts'), PAGE_PROPS_SOURCE);
  fs.writeFileSync(path.join(dir, 'features', 'checkout', 'pages', 'CheckoutPage.tsx'), PAGE_SOURCE);
  fs.writeFileSync(path.join(dir, 'features', 'checkout', 'hooks', 'useCheckout.tsx'), HOOK_SOURCE);
  return dir;
}

// ---- signature introspection (pure) ----------------------------------------

test('extractPropsInterfaceMembers reads every member name + whether it is a function type', () => {
  const members = extractPropsInterfaceMembers(PAGE_PROPS_SOURCE, 'CheckoutPageProps');
  assert.deepEqual(members, [
    { name: 'onCategoryChange', isFunctionType: true },
    { name: 'onSubmit', isFunctionType: true },
    { name: 'value', isFunctionType: false },
    { name: 'onReset', isFunctionType: true },
  ]);
});

test('extractPropsInterfaceMembers returns [] for a type name that is not found', () => {
  assert.deepEqual(extractPropsInterfaceMembers(PAGE_PROPS_SOURCE, 'NoSuchType'), []);
});

test('extractHookSignature falls back to the hook\'s own return-object-literal shape when there is no explicit return type', () => {
  const members = extractHookSignature(HOOK_SOURCE, 'useCheckout');
  assert.deepEqual(members.sort(), ['onSubmit', 'setCategory', 'value'].sort());
});

test('extractHookSignature prefers an explicit return-type annotation when present', () => {
  const source = `interface UseFooReturn { alpha: string; beta: () => void; }\nexport function useFoo(): UseFooReturn {\n  return { alpha: 'x', beta: () => {}, gamma: 'not declared' } as any;\n}\n`;
  const members = extractHookSignature(source, 'useFoo');
  assert.deepEqual(members.sort(), ['alpha', 'beta'].sort()); // "gamma" is NOT in the declared type
});

test('extractHookSignature supports an arrow-function hook', () => {
  const source = `export const useBar = () => {\n  const flag = true;\n  return { flag, toggleFlag: () => {} };\n};\n`;
  assert.deepEqual(extractHookSignature(source, 'useBar').sort(), ['flag', 'toggleFlag'].sort());
});

// ---- matching: exact + the ticket's own fuzzy example ----------------------

test('matchSlotsToHandlers: exact match wins when both names are identical', () => {
  const result = matchSlotsToHandlers(['onSubmit', 'value'], ['onSubmit', 'value', 'setCategory']);
  assert.deepEqual(result, [
    { slot: 'onSubmit', handler: 'onSubmit', matchType: 'exact' },
    { slot: 'value', handler: 'value', matchType: 'exact' },
  ]);
});

test('matchSlotsToHandlers: the ticket\'s own fuzzy example, onCategoryChange -> setCategory', () => {
  const result = matchSlotsToHandlers(['onCategoryChange'], ['setCategory', 'value']);
  assert.deepEqual(result, [{ slot: 'onCategoryChange', handler: 'setCategory', matchType: 'fuzzy' }]);
});

test('matchSlotsToHandlers: fuzzy also tries toggle<Subject> and handle<Subject>', () => {
  assert.deepEqual(matchSlotsToHandlers(['onOpenToggle'], ['toggleOpen']), [{ slot: 'onOpenToggle', handler: 'toggleOpen', matchType: 'fuzzy' }]);
  assert.deepEqual(matchSlotsToHandlers(['onSaveClick'], ['handleSave']), [{ slot: 'onSaveClick', handler: 'handleSave', matchType: 'fuzzy' }]);
});

test('matchSlotsToHandlers: a slot with no exact or fuzzy candidate is reported as unmatched, not dropped', () => {
  const result = matchSlotsToHandlers(['onReset'], ['setCategory', 'value', 'onSubmit']);
  assert.deepEqual(result, [{ slot: 'onReset', handler: null, matchType: 'unmatched' }]);
});

// ---- generateController: filesystem-backed, end-to-end ---------------------

test('generateController binds exact + fuzzy matches and leaves a visible TODO for the unmatched slot', () => {
  const dir = tmpProject();
  const { file, bindings } = generateController(dir, 'Checkout', 'checkout');

  assert.equal(file, path.join(dir, 'features', 'checkout', 'controllers', 'CheckoutController.tsx'));
  const byslot = Object.fromEntries(bindings.map((b) => [b.slot, b]));
  assert.equal(byslot.onCategoryChange.handler, 'setCategory');
  assert.equal(byslot.onCategoryChange.matchType, 'fuzzy');
  assert.equal(byslot.onSubmit.handler, 'onSubmit');
  assert.equal(byslot.onSubmit.matchType, 'exact');
  assert.equal(byslot.value.handler, 'value');
  assert.equal(byslot.onReset.handler, null);
  assert.equal(byslot.onReset.matchType, 'unmatched');

  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /import \{ CheckoutPage \} from '\.\.\/pages\/CheckoutPage';/);
  assert.match(source, /import \{ useCheckout \} from '\.\.\/hooks\/useCheckout';/);
  assert.match(source, /const \{ setCategory, onSubmit, value \} = useCheckout\(\);/);
  assert.match(source, /onCategoryChange=\{setCategory\}/);
  assert.match(source, /onSubmit=\{onSubmit\}/);
  assert.match(source, /value=\{value\}/);
  assert.match(source, /onReset=\{\(\) => \{ \/\* TODO\(controller\): no hook handler matched "onReset" \*\/ \}\}/);
});

test('generateController output passes construct validate cleanly (including the new CONTROLLER-001 rule)', () => {
  const dir = tmpProject();
  generateController(dir, 'Checkout', 'checkout');
  const { violations } = validateArchitecture(dir);
  assert.deepEqual(violations.filter((v) => v.severity === 'error'), []);
});

test('generateController resolves page/hook files from a Context Envelope\'s layers when one is given', () => {
  const dir = tmpProject();
  const envelope = createEnvelope('checkout', {
    layers: {
      page: ['features/checkout/pages/CheckoutPage.tsx', 'features/checkout/pages/CheckoutPageProps.ts'],
      hook: ['features/checkout/hooks/useCheckout.tsx'],
    },
  });
  const { file, bindings } = generateController(dir, 'Checkout', 'checkout', { envelope });
  assert.equal(fs.existsSync(file), true);
  assert.ok(bindings.some((b) => b.slot === 'onCategoryChange' && b.handler === 'setCategory'));
});

test('generateController: hyphenated / underscored names resolve to the PascalCase page + hook and emit a valid controller (#216)', () => {
  for (const name of ['checkout', 'checkout-flow', 'checkout_flow']) {
    const dir = tmpProject();
    const pascal = name === 'checkout' ? 'Checkout' : 'CheckoutFlow';
    const pages = path.join(dir, 'features', 'checkout', 'pages');
    const hooks = path.join(dir, 'features', 'checkout', 'hooks');
    if (pascal !== 'Checkout') {
      fs.renameSync(path.join(pages, 'CheckoutPageProps.ts'), path.join(pages, `${pascal}PageProps.ts`));
      fs.renameSync(path.join(pages, 'CheckoutPage.tsx'), path.join(pages, `${pascal}Page.tsx`));
      fs.renameSync(path.join(hooks, 'useCheckout.tsx'), path.join(hooks, `use${pascal}.tsx`));
      for (const f of [path.join(pages, `${pascal}PageProps.ts`), path.join(hooks, `use${pascal}.tsx`)]) {
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll('Checkout', pascal));
      }
    }
    const { file } = generateController(dir, name, 'checkout');
    assert.equal(path.basename(file), `${pascal}Controller.tsx`);
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, new RegExp(`export function ${pascal}Controller\\(`));
    assert.doesNotThrow(() => parseToAst(source, file));
  }
});

test('generateController: a name that cannot form an identifier is rejected before any file is read or written (#216)', () => {
  const dir = tmpProject();
  const controllers = path.join(dir, 'features', 'checkout', 'controllers');
  assert.throws(() => generateController(dir, '3d-checkout', 'checkout'), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.match(err.message, /Controller name "3d-checkout" can't be turned into a valid TypeScript identifier/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(controllers), []);
});

test('generateController throws a clear usage error when the PageProps file does not exist yet', () => {
  const dir = tmpProject();
  fs.rmSync(path.join(dir, 'features', 'checkout', 'pages', 'CheckoutPageProps.ts'));
  assert.throws(() => generateController(dir, 'Checkout', 'checkout'), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.match(err.message, /PageProps file not found/);
    return true;
  });
});

// #677: create.controller.bind into a feature that does not exist at all -- the missing feature
// itself is scaffolded first (ensureFeatureExists, generators.mjs, same as every other create.*
// flow), but --bind's own prerequisite (an already-generated page/hook) is a separate, already-
// clear requirement this doesn't create, so it still refuses just as before. The empty scaffold
// is real, though: the feature no longer silently stays a bare, unscaffolded folder.
test('generateController into a feature that does not exist at all scaffolds the (empty) feature but still refuses to bind, writing no controller (#677)', () => {
  const dir = makeTempDir('construct-controller-test-');
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nproject:\n  framework: nextjs\nfeatures:\n  root: features\n');
  assert.throws(() => generateController(dir, 'Checkout', 'nope'), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.match(err.message, /PageProps file not found/);
    return true;
  });
  assert.ok(fs.existsSync(path.join(dir, 'features', 'nope', 'index.ts')));
  assert.ok(fs.existsSync(path.join(dir, 'features', 'nope', 'types.ts')));
  assert.equal(fs.existsSync(path.join(dir, 'features', 'nope', 'controllers', 'CheckoutController.tsx')), false);
});

// ---- CONTROLLER-001 ---------------------------------------------------------

test('CONTROLLER-001: a controller calling fetch() directly is flagged', () => {
  const violations = detectLayerViolations('controller', `export function C(){ fetch('/api'); return null; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['CONTROLLER-001']);
  assert.match(violations[0].message, /fetch/);
});

test('CONTROLLER-001: a controller with control-flow (if/for/while/switch/try) business logic is flagged', () => {
  for (const src of [
    `export function C(){ if (true) { return null; } return null; }`,
    `export function C(){ for (let i=0;i<1;i++){} return null; }`,
    `export function C(){ while (false) {} return null; }`,
    `export function C(){ switch (1) { default: break; } return null; }`,
    `export function C(){ try { return null; } catch (e) { return null; } }`,
  ]) {
    const violations = detectLayerViolations('controller', src);
    assert.deepEqual(violations.map((v) => v.rule), ['CONTROLLER-001'], `expected CONTROLLER-001 for: ${src}`);
  }
});

test('CONTROLLER-001: a pure compose-and-wire controller (the generator\'s own shape) trips nothing', () => {
  const violations = detectLayerViolations('controller', `import { XPage } from '../pages/XPage';\nimport { useX } from '../hooks/useX';\n\nexport function XController() {\n  const { onSubmit } = useX();\n  return <XPage onSubmit={onSubmit} />;\n}\n`);
  assert.deepEqual(violations, []);
});

test('validateArchitecture flags CONTROLLER-001 for a hand-written controller with real business logic', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'features', 'checkout', 'controllers', 'Rogue.tsx'),
    `export function Rogue(){ if (Math.random() > 0.5) { fetch('/api'); } return null; }`,
  );
  const { violations } = validateArchitecture(dir);
  const rogueViolations = violations.filter((v) => v.file === 'features/checkout/controllers/Rogue.tsx');
  assert.ok(rogueViolations.some((v) => v.rule === 'CONTROLLER-001'));
});

// ---- end-to-end via the real CLI binary ------------------------------------

test('construct create controller <name> --feature <f> --bind binds end to end and construct validate passes', () => {
  const dir = tmpProject();
  const res = spawnSync('node', [bin, 'create', 'controller', 'Checkout', '--feature', 'checkout', '--bind'], { encoding: 'utf8', cwd: dir });

  assert.equal(res.status, EXIT_CODES.OK, res.stderr);
  assert.match(res.stdout, /CheckoutController\.tsx/);
  assert.match(res.stdout, /onCategoryChange -> setCategory \(fuzzy\)/);
  assert.match(res.stdout, /onSubmit -> onSubmit \(exact\)/);
  assert.match(res.stdout, /onReset -> UNMATCHED/);

  const validateRes = spawnSync('node', [bin, 'validate'], { encoding: 'utf8', cwd: dir });
  assert.equal(validateRes.status, EXIT_CODES.OK, validateRes.stdout);
});

test('construct create controller without --bind is unchanged (still the plain same-named-page stub)', () => {
  const dir = tmpProject();
  // The plain stub controller template unconditionally imports a same-named page (this
  // is pre-existing, unrelated to Ticket 7.4 -- see generators.mjs's LAYER_ORDER comment),
  // so that page must exist first, or IMPORT-001 fails the self-check either way.
  const pageRes = spawnSync('node', [bin, 'create', 'page', 'Other', '--feature', 'checkout'], { encoding: 'utf8', cwd: dir });
  assert.equal(pageRes.status, EXIT_CODES.OK, pageRes.stderr);

  const res = spawnSync('node', [bin, 'create', 'controller', 'Other', '--feature', 'checkout'], { encoding: 'utf8', cwd: dir });
  assert.equal(res.status, EXIT_CODES.OK, res.stderr);
  const file = path.join(dir, 'features', 'checkout', 'controllers', 'OtherController.tsx');
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /import \{ OtherPage \} from '\.\.\/pages\/OtherPage';/);
  assert.doesNotMatch(source, /useOther/);
});
