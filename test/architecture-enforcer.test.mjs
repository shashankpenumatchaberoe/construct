import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConstructError } from '../packages/core/diagnostics.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';
import { CANONICAL_LAYERS, loadLayerGraph } from '../packages/core/architecture-graph.mjs';
import {
  classifyFile,
  detectLayerViolations,
  matchGlob,
  exceptionApplies,
  validateExceptionsShape,
  expiredExceptionViolations,
  validateArchitecture,
} from '../packages/core/architecture-enforcer.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpProject() {
  return makeTempDir('construct-enforcer-');
}

// ---- classifier (in-memory, path-string only) --------------------------

test('classifyFile recognizes every layer by path pattern', () => {
  assert.equal(classifyFile('app/dashboard/page.tsx', CANONICAL_LAYERS), 'route');
  assert.equal(classifyFile('features/checkout/controllers/CheckoutController.tsx', CANONICAL_LAYERS), 'controller');
  assert.equal(classifyFile('features/checkout/workflows/CheckoutWorkflow.ts', CANONICAL_LAYERS), 'workflow');
  assert.equal(classifyFile('features/checkout/hooks/useCheckout.tsx', CANONICAL_LAYERS), 'hook');
  assert.equal(classifyFile('features/checkout/domain/total.ts', CANONICAL_LAYERS), 'domain');
  assert.equal(classifyFile('features/checkout/services/CheckoutService.ts', CANONICAL_LAYERS), 'service');
  assert.equal(classifyFile('features/checkout/pages/CheckoutPage.tsx', CANONICAL_LAYERS), 'page');
  assert.equal(classifyFile('features/checkout/components/Button.tsx', CANONICAL_LAYERS), 'component');
});

test('classifyFile returns null for a file that matches no layer pattern', () => {
  assert.equal(classifyFile('features/checkout/utils/helpers.ts', CANONICAL_LAYERS), null);
  assert.equal(classifyFile('README.md', CANONICAL_LAYERS), null);
});

// ---- detectLayerViolations (pure, in-memory source strings) ------------

test('detectLayerViolations flags a route with no controller import (ROUTE-001)', () => {
  const violations = detectLayerViolations('route', `export default function Page() { return <div/>; }`);
  assert.ok(violations.some((v) => v.rule === 'ROUTE-001'));
});

test('detectLayerViolations flags a route effect only, given a controller import (ROUTE-002)', () => {
  const source = `import { X } from '../../features/x/controllers/XController';\nexport default function Page(){ fetch('/'); return <X/>; }`;
  const violations = detectLayerViolations('route', source);
  assert.deepEqual(violations.map((v) => v.rule), ['ROUTE-002']);
});

test('detectLayerViolations flags each page rule independently', () => {
  assert.deepEqual(detectLayerViolations('page', `import { W } from '../workflows/W';`).map((v) => v.rule), ['PAGE-002']);
  assert.deepEqual(detectLayerViolations('page', `import { S } from '../services/S';`).map((v) => v.rule), ['PAGE-003']);
  assert.deepEqual(detectLayerViolations('page', `export function P(){ fetch('/'); }`).map((v) => v.rule), ['PAGE-004']);
  assert.deepEqual(detectLayerViolations('page', `import { D } from '../domain/D';`).map((v) => v.rule), ['PAGE-005']);
  assert.deepEqual(detectLayerViolations('page', `export function P(){ useMachine(); }`).map((v) => v.rule), ['PAGE-006']);
});

// Ticket 7.2 (#112) regression: a page reaching for application state
// *indirectly*, via importing a custom hook, must be flagged under PAGE-006
// even when it never directly calls useMachine/useActor/createMachine
// itself -- this was a real gap (import-only usage previously slipped
// through) confirmed and closed as part of the epic's reconciliation notes.
test('detectLayerViolations flags PAGE-006 for a page that imports a custom hook, even with no useMachine/useActor/createMachine call', () => {
  const violations = detectLayerViolations('page', `import { useCart } from '../hooks/useCart';\nexport function P(){ const { items } = useCart(); return null; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['PAGE-006']);
  assert.match(violations[0].message, /custom hook/);
});

// #510 -- PAGE-006 narrowed: a page importing a Provider hook (named use<Name>Provider, the
// sanctioned way to reach shared context/store or service-backed data) is NOT flagged, while an
// arbitrary hook import (the exact fixture above) is still banned unchanged.
test('#510 (before/after): PAGE-006 no longer fires for a page importing a Provider hook by name', () => {
  const violations = detectLayerViolations(
    'page',
    `import { useCartProvider } from '../hooks/useCartProvider';\nexport function P(){ const { total } = useCartProvider(); return null; }`,
  );
  assert.deepEqual(violations, []);
});

test('#510: PAGE-006 still fires when a hook import mixes a Provider-named specifier with a non-Provider one', () => {
  const violations = detectLayerViolations(
    'page',
    `import { useCartProvider, useCart } from '../hooks/useCart';\nexport function P(){ useCartProvider(); useCart(); return null; }`,
  );
  assert.deepEqual(violations.map((v) => v.rule), ['PAGE-006']);
});

test('#510: PAGE-006 still fires for a bare side-effect hook import with no specifiers', () => {
  const violations = detectLayerViolations('page', `import '../hooks/useCart';\nexport function P(){ return null; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['PAGE-006']);
});

test('#510: PAGE-006 still fires for a namespace hook import (individual names cannot be verified)', () => {
  const violations = detectLayerViolations('page', `import * as hooks from '../hooks/useCart';\nexport function P(){ hooks.useCart(); return null; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['PAGE-006']);
});

// HOOK-002 (#510) -- the hooks/ layer's own rule: a hook named use<Name>Provider must really be
// built through defineProvider(...), which is what makes PAGE-006's naming-convention allowance
// above sound.
test('#510 (before/after): HOOK-002 fires for a hook named use*Provider that is not built via defineProvider', () => {
  const violations = detectLayerViolations('hook', `export function useCartProvider() { return { total: 0 }; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['HOOK-002']);
  assert.match(violations[0].message, /useCartProvider/);
});

test('#510: HOOK-002 does not fire for a hook named use*Provider that IS built via defineProvider', () => {
  const violations = detectLayerViolations(
    'hook',
    `import { defineProvider } from '@construct/typed-contracts';\nconst Cart = defineProvider('Cart', () => ({ total: 0 }));\nexport const useCartProvider = Cart.useProvider;`,
  );
  assert.deepEqual(violations.filter((v) => v.rule === 'HOOK-002'), []);
});

test('#510: HOOK-002 does not fire for an ordinary hook with no Provider-shaped name (regression)', () => {
  const violations = detectLayerViolations('hook', `export function useCart() { return { items: [] }; }`);
  assert.deepEqual(violations.filter((v) => v.rule === 'HOOK-002'), []);
});

// #521 -- HOOK-002's factory-presence check must also recognize defineProvider called with an
// explicit generic type argument (defineProvider<Props>(...)), not just the plain
// defineProvider(...) shape -- both must be treated as "really built through defineProvider".
test('#521: HOOK-002 does not fire for defineProvider called with an explicit generic type argument', () => {
  const violations = detectLayerViolations(
    'hook',
    `import { defineProvider } from '@construct/typed-contracts';\nconst Cart = defineProvider<CartState>('Cart', () => ({ total: 0 }));\nexport const useCartProvider = Cart.useProvider;`,
  );
  assert.deepEqual(violations.filter((v) => v.rule === 'HOOK-002'), []);
});

test('detectLayerViolations splits component rules (controller vs workflow/service/domain)', () => {
  assert.deepEqual(detectLayerViolations('component', `import { C } from '../controllers/C';`).map((v) => v.rule), ['COMPONENT-002']);
  assert.deepEqual(detectLayerViolations('component', `import { S } from '../services/S';`).map((v) => v.rule), ['COMPONENT-003']);
});

// #508 -- COMPONENT-005: no inline conditional/loop logic in a component's
// JSX (mirrors the still-unbuilt PAGE-008, #505). Three independent shapes:
// a ternary, a `&&` short-circuit, and a `.map()` list render.
test('detectLayerViolations flags COMPONENT-005 for inline conditional/loop JSX, in each of its shapes', () => {
  assert.deepEqual(
    detectLayerViolations('component', `export function C(p){ return p.ok ? <A/> : <B/>; }`).map((v) => v.rule),
    ['COMPONENT-005'],
  );
  assert.deepEqual(
    detectLayerViolations('component', `export function C(p){ return <div>{p.ok && <A/>}</div>; }`).map((v) => v.rule),
    ['COMPONENT-005'],
  );
  assert.deepEqual(
    detectLayerViolations('component', `export function C(p){ return <ul>{p.items.map(i => <li key={i}>{i}</li>)}</ul>; }`).map((v) => v.rule),
    ['COMPONENT-005'],
  );
});

test('detectLayerViolations does NOT flag COMPONENT-005 for a .map() whose callback never returns JSX', () => {
  const src = `export function C(p){ const ids = p.items.map(i => i.id); return <div>{ids.length}</div>; }`;
  assert.deepEqual(detectLayerViolations('component', src), []);
});

// #508 -- COMPONENT-006: a component-level JSX complexity budget (nesting
// depth / inline-branch count), separate from COMPONENT-005 (which fires on
// the *existence* of one inline branch regardless of budget) and from any
// one Expression's own cap.
test('detectLayerViolations flags COMPONENT-006 once the default JSX-nesting-depth budget is exceeded, with no inline logic present', () => {
  const deep = '<div>'.repeat(7) + 'hi' + '</div>'.repeat(7);
  const violations = detectLayerViolations('component', `export function C(){ return ${deep}; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['COMPONENT-006']);
  assert.match(violations[0].message, /nesting depth 7/);
});

test('detectLayerViolations flags COMPONENT-006 once the default branch-count budget is exceeded (COMPONENT-005 also fires, independently)', () => {
  const src = `export function C(p){ return <div>{p.a?<X/>:<Y/>}{p.b&&<Z/>}{p.c&&<W/>}{p.d&&<V/>}</div>; }`;
  const rules = detectLayerViolations('component', src).map((v) => v.rule);
  assert.deepEqual(rules.sort(), ['COMPONENT-005', 'COMPONENT-006']);
});

test('detectLayerViolations honors COMPONENT-006 opts overrides (maxJsxDepth/maxJsxBranches)', () => {
  const src = `export function C(){ return <div><span/></div>; }`; // depth 2, 0 branches
  assert.deepEqual(detectLayerViolations('component', src, { maxJsxDepth: 1 }).map((v) => v.rule), ['COMPONENT-006']);
  assert.deepEqual(detectLayerViolations('component', src), []); // default budget (6) is not exceeded
});

test('detectLayerViolations flags React imports in workflow/service layers', () => {
  assert.deepEqual(detectLayerViolations('workflow', `import { useState } from 'react';`).map((v) => v.rule), ['WORKFLOW-001']);
  assert.deepEqual(detectLayerViolations('service', `import { useEffect } from 'react';`).map((v) => v.rule), ['SERVICE-002']);
});

test('detectLayerViolations flags effects inside domain code', () => {
  for (const src of [`export function f(){ return fetch('/'); }`, `export function f(){ return window.innerWidth; }`, `export function f(){ return localStorage.getItem('x'); }`]) {
    assert.deepEqual(detectLayerViolations('domain', src).map((v) => v.rule), ['DOMAIN-001']);
  }
});

test('detectLayerViolations returns nothing for clean code', () => {
  assert.deepEqual(detectLayerViolations('domain', `export function pure(x){ return x + 1; }`), []);
  assert.deepEqual(detectLayerViolations('component', `export function C(){ return <div/>; }`), []);
});

// #74 regression: a comment (or string/property name) mentioning a banned substring
// must never trip a rule the way real code would — this was the actual false positive
// hit during the ui/ Next.js migration, and is the reason detectLayerViolations moved
// from whole-file text-pattern matching to real AST analysis (#89).
test('detectLayerViolations (#74 regression): a comment mentioning banned substrings does not trip any rule', () => {
  const domainSource = `
// This domain module intentionally has no workflow/service/domain effects — see fetch()
// usage in the services layer instead, and avoid window/document/localStorage here.
export function pure(x) {
  return x + 1;
}
`;
  assert.deepEqual(detectLayerViolations('domain', domainSource), []);

  const pageSource = `
// Do not import workflows/ or services/ or domain/ here, and never call fetch() or
// useMachine()/useActor()/createMachine() — this comment mentions all of them on purpose.
export function Page() {
  return null;
}
`;
  assert.deepEqual(detectLayerViolations('page', pageSource), []);

  const routeSource = `
// fetch/useMachine/useActor/localStorage/sessionStorage are all mentioned right here.
import { X } from '../../features/x/controllers/XController';
export default function Page(){ return <X/>; }
`;
  assert.deepEqual(detectLayerViolations('route', routeSource), []);

  const workflowSource = `
// this workflow talks to react (the library) in this comment only, never imports it
export function workflow() { return 1; }
`;
  assert.deepEqual(detectLayerViolations('workflow', workflowSource), []);

  // A same-named object property/import binding isn't a "usage" of the global either.
  const domainWithProperty = `
import { fetch as fetchThing } from './local-fetch-helper';
export function f() {
  const obj = { fetch: 1 };
  return obj.fetch + fetchThing();
}
`;
  assert.deepEqual(detectLayerViolations('domain', domainWithProperty), []);
});

// ---- exception matching -------------------------------------------------

test('matchGlob supports ** and * wildcards', () => {
  assert.equal(matchGlob('features/legacy/**', 'features/legacy/pages/X.tsx'), true);
  assert.equal(matchGlob('features/legacy/**', 'features/other/pages/X.tsx'), false);
  assert.equal(matchGlob('features/*/pages/*.tsx', 'features/x/pages/X.tsx'), true);
});

test('exceptionApplies matches by rule + path and honors expiry', () => {
  const config = { exceptions: [{ rule: 'PAGE-004', path: 'features/legacy/**', expires: '2999-01-01' }] };
  assert.equal(exceptionApplies(config, 'PAGE-004', 'features/legacy/pages/X.tsx'), true);
  assert.equal(exceptionApplies(config, 'PAGE-003', 'features/legacy/pages/X.tsx'), false);

  const expired = { exceptions: [{ rule: 'PAGE-004', path: 'features/legacy/**', expires: '2000-01-01' }] };
  assert.equal(exceptionApplies(expired, 'PAGE-004', 'features/legacy/pages/X.tsx'), false);
});

test('exceptionApplies supports a "rules" array', () => {
  const config = { exceptions: [{ rules: ['PAGE-004', 'PAGE-003'], path: 'features/legacy/**' }] };
  assert.equal(exceptionApplies(config, 'PAGE-003', 'features/legacy/pages/X.tsx'), true);
});

test('validateExceptionsShape throws a ConstructError naming the malformed entry', () => {
  assert.throws(() => validateExceptionsShape({ exceptions: [{ rule: 'PAGE-004' }] }), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.match(err.message, /exceptions\[0\]/);
    assert.match(err.message, /path/);
    return true;
  });
  assert.throws(() => validateExceptionsShape({ exceptions: [{ path: 'features/x/**' }] }), /rule/);
  assert.throws(() => validateExceptionsShape({ exceptions: [{ path: 'features/x/**', rule: 'PAGE-004', expires: 'not-a-date' }] }), /valid ISO date/);
});

test('validateExceptionsShape accepts a well-formed exception list', () => {
  assert.equal(validateExceptionsShape({ exceptions: [{ path: 'features/x/**', rule: 'PAGE-004', expires: '2999-01-01' }] }), true);
  assert.equal(validateExceptionsShape({}), true);
});

test('expiredExceptionViolations reports a warning for a stale exception', () => {
  const violations = expiredExceptionViolations({ exceptions: [{ rule: 'PAGE-004', path: 'features/legacy/**', expires: '2000-01-01' }] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'EXCEPTION-EXPIRED');
  assert.equal(violations[0].severity, 'warning');
});

test('expiredExceptionViolations is silent for a live exception', () => {
  const violations = expiredExceptionViolations({ exceptions: [{ rule: 'PAGE-004', path: 'features/legacy/**', expires: '2999-01-01' }] });
  assert.deepEqual(violations, []);
});

// architecture.yml is YAML: an UNQUOTED date-like scalar (`expires: 2020-01-01`)
// is parsed by js-yaml's default schema into a real JS Date, not a string —
// only a quoted value (`expires: "2020-01-01"`) yields a string. Both are
// legitimate on-disk spellings of the same author intent and must both work.
test('validateExceptionsShape, exceptionApplies, and expiredExceptionViolations all accept a Date object for "expires" (js-yaml auto-parses unquoted dates)', () => {
  const expired = { rule: 'PAGE-004', path: 'features/legacy/**', expires: new Date('2000-01-01') };
  const live = { rule: 'PAGE-004', path: 'features/legacy/**', expires: new Date('2999-01-01') };

  assert.equal(validateExceptionsShape({ exceptions: [expired] }), true);

  assert.equal(exceptionApplies({ exceptions: [live] }, 'PAGE-004', 'features/legacy/pages/X.tsx'), true);
  assert.equal(exceptionApplies({ exceptions: [expired] }, 'PAGE-004', 'features/legacy/pages/X.tsx'), false);

  const violations = expiredExceptionViolations({ exceptions: [expired] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'EXCEPTION-EXPIRED');
  assert.match(violations[0].message, /expired on 2000-01-01\./); // formatted as a plain date, not Date#toString()
});

test('validateExceptionsShape still rejects a genuinely invalid "expires" value', () => {
  assert.throws(
    () => validateExceptionsShape({ exceptions: [{ path: 'features/x/**', rule: 'PAGE-004', expires: new Date('not-a-date') }] }),
    /valid ISO date/,
  );
});

// ---- filesystem-backed integration tests --------------------------------

// #93 — ported from root test.mjs's one case (the only thing keeping the
// now-deleted src/validator.mjs alive), exercising validateArchitecture
// instead of validator.mjs's orphaned validateProject.
test('forbidden page fetch is detected (PAGE-004) against a real project directory', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  PAGE-004: error\n');
  fs.writeFileSync(path.join(dir, 'features', 'x', 'pages', 'X.tsx'), 'export function X(){fetch("/");return <div/>}');
  const res = validateArchitecture(dir);
  assert.ok(res.violations.some((v) => v.rule === 'PAGE-004'));
});

test('validateArchitecture honors an exception scoping a violation away', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'legacy', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'exceptions:\n  - rule: PAGE-004\n    path: features/legacy/**\n');
  fs.writeFileSync(path.join(dir, 'features', 'legacy', 'pages', 'X.tsx'), `export function X(){ fetch('/'); return <div/>; }`);
  const res = validateArchitecture(dir);
  assert.equal(res.violations.some((v) => v.rule === 'PAGE-004'), false);
});

// #508 -- COMPONENT-005 defaults to 'warning' (not 'error'): a real, valid
// project can pick it up and keep passing (res.ok stays true) until it
// opts into 'error' itself, per #500 phase 1's additive-only constraint.
test('validateArchitecture: COMPONENT-005 defaults to warning severity and does not fail validation', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'components'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'features', 'x', 'components', 'C.tsx'), `export function C(p){ return p.ok ? <A/> : <B/>; }`);
  const res = validateArchitecture(dir);
  const hit = res.violations.find((v) => v.rule === 'COMPONENT-005');
  assert.ok(hit, 'expected a COMPONENT-005 violation');
  assert.equal(hit.severity, 'warning');
  assert.equal(res.ok, true);
});

test('validateArchitecture: COMPONENT-005 can be raised to error via architecture.yml, same as any other rule', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'components'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  COMPONENT-005: error\n');
  fs.writeFileSync(path.join(dir, 'features', 'x', 'components', 'C.tsx'), `export function C(p){ return p.ok ? <A/> : <B/>; }`);
  const res = validateArchitecture(dir);
  assert.equal(res.ok, false);
});

// #508 -- COMPONENT-006's numeric budget overrides flow from architecture.yml
// through loadConfig into detectLayerViolations, the same 'READ-002-max-loc'
// numeric-override shape as every other threshold in this codebase.
test('validateArchitecture: COMPONENT-006-max-depth/COMPONENT-006-max-branches overrides from architecture.yml are honored', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'components'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  COMPONENT-006-max-depth: 1\n');
  fs.writeFileSync(path.join(dir, 'features', 'x', 'components', 'C.tsx'), `export function C(){ return <div><span/></div>; }`);
  const res = validateArchitecture(dir);
  assert.ok(res.violations.some((v) => v.rule === 'COMPONENT-006'));
});

test('validateArchitecture suggests a layer folder for an unclassifiable feature file', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'checkout', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'features', 'checkout', 'utils', 'helpers.ts'), `export const x = 1;`);
  const res = validateArchitecture(dir);
  const v = res.violations.find((x) => x.file === 'features/checkout/utils/helpers.ts');
  assert.ok(v, 'expected a violation for the unclassifiable file');
  assert.equal(v.rule, 'SOC-001');
  assert.match(v.message, /"utils"/);
  assert.ok(v.expected.some((e) => e.includes('pages') || e.includes('components')));
});

test('validateArchitecture throws a ConstructError for a malformed exception in architecture.yml', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'exceptions:\n  - path: features/x/**\n');
  assert.throws(() => validateArchitecture(dir), ConstructError);
});

test('validateArchitecture can be scoped to a subset of files via opts.files', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'features', 'x', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'features', 'x', 'pages', 'Bad.tsx'), `export function Bad(){ fetch('/'); return <div/>; }`);
  fs.writeFileSync(path.join(dir, 'features', 'x', 'domain', 'pure.ts'), `export function f(){ return fetch('/'); }`);
  const scoped = validateArchitecture(dir, { files: ['features/x/pages/Bad.tsx'] });
  assert.equal(scoped.violations.length, 1);
  assert.equal(scoped.violations[0].rule, 'PAGE-004');
});

// ---- IMPORT-001: dangling relative imports --------------------------------

test('validateArchitecture flags a relative import that resolves to nothing', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'controllers'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'features', 'x', 'controllers', 'XController.tsx'),
    `import { XPage } from '../pages/XPage';\nexport function XController(){ return <XPage/>; }`,
  );
  const res = validateArchitecture(dir);
  const v = res.violations.find((x) => x.rule === 'IMPORT-001');
  assert.ok(v, 'expected an IMPORT-001 violation');
  assert.equal(v.file, 'features/x/controllers/XController.tsx');
  assert.match(v.message, /"\.\.\/pages\/XPage"/);
});

test('IMPORT-001 checks the root app/page.tsx (nextjs route glob matches zero intervening segments, #491)', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'app', 'page.tsx'),
    `import { CoreController } from '../features/core/controllers/CoreController';\nexport default function Page(){ return <CoreController/>; }`,
  );
  const res = validateArchitecture(dir);
  const v = res.violations.find((x) => x.rule === 'IMPORT-001');
  assert.ok(v, 'expected an IMPORT-001 violation for the root page');
  assert.equal(v.file, 'app/page.tsx');
});

test('validateArchitecture does not flag a relative import once the target file exists', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'controllers'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'features', 'x', 'pages'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'features', 'x', 'controllers', 'XController.tsx'),
    `import { XPage } from '../pages/XPage';\nexport function XController(){ return <XPage/>; }`,
  );
  fs.writeFileSync(path.join(dir, 'features', 'x', 'pages', 'XPage.tsx'), `export function XPage(){ return <div/>; }`);
  const res = validateArchitecture(dir);
  assert.equal(res.violations.some((v) => v.rule === 'IMPORT-001'), false);
});

test('validateArchitecture never flags an external/bare import specifier', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'features', 'x', 'domain', 'D.ts'), `import { z } from 'zod';\nexport function f(){ return typeof z; }`);
  const res = validateArchitecture(dir);
  assert.equal(res.violations.some((v) => v.rule === 'IMPORT-001'), false);
});

test('validateArchitecture resolves a dangling import outside the project root the same way', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'controllers'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'features', 'x', 'controllers', 'XController.tsx'),
    `import { Outside } from '../../../../elsewhere/Outside';\nexport function XController(){ return <Outside/>; }`,
  );
  const res = validateArchitecture(dir);
  assert.equal(res.violations.some((v) => v.rule === 'IMPORT-001'), true);
});

// ---- fixtures -------------------------------------------------------------

test('architecture-valid fixture produces zero error-severity violations', () => {
  const res = validateArchitecture(path.join(REPO_ROOT, 'fixtures', 'architecture-valid'));
  const errors = res.violations.filter((v) => v.severity === 'error');
  assert.deepEqual(errors, []);
});

// #68 — a real, non-Next.js react-spa fixture (project.framework: react-spa,
// route layer = src/App.tsx per #65/#66/#67's real convention, not a stub)
// validated the same way the nextjs fixture above is: proof the whole
// pipeline (framework option -> route layer classification -> controller
// convention) actually works end to end, not just the individual unit
// tests #65-#67 already added in isolation.
test('architecture-valid-react-spa fixture produces zero error-severity violations', () => {
  const root = path.join(REPO_ROOT, 'fixtures', 'architecture-valid-react-spa');
  const res = validateArchitecture(root);
  const errors = res.violations.filter((v) => v.severity === 'error');
  assert.deepEqual(errors, []);
});

test('architecture-valid-react-spa fixture classifies src/App.tsx as the route layer and features/widget/controllers/WidgetController.tsx as the controller layer', () => {
  const root = path.join(REPO_ROOT, 'fixtures', 'architecture-valid-react-spa');
  const graph = loadLayerGraph(root);
  assert.equal(graph.route.pattern, 'src/App.tsx');
  assert.equal(classifyFile('src/App.tsx', graph), 'route');
  assert.equal(classifyFile('features/widget/controllers/WidgetController.tsx', graph), 'controller');
  // The nextjs-only route pattern must not accidentally also match this file.
  assert.notEqual(classifyFile('src/App.tsx', CANONICAL_LAYERS), 'route');
});

// #82 — a second react-spa fixture with more than one route (the fixture
// above only ever had /dashboard), proving the same zero-error bar holds
// with several routes/features sharing one project, not just a single one.
test('architecture-valid-react-spa-multi-route fixture produces zero error-severity violations', () => {
  const root = path.join(REPO_ROOT, 'fixtures', 'architecture-valid-react-spa-multi-route');
  const res = validateArchitecture(root);
  const errors = res.violations.filter((v) => v.severity === 'error');
  assert.deepEqual(errors, []);
});

test('architecture-valid-react-spa-multi-route fixture classifies each of its 3 routed controllers correctly', () => {
  const root = path.join(REPO_ROOT, 'fixtures', 'architecture-valid-react-spa-multi-route');
  const graph = loadLayerGraph(root);
  assert.equal(classifyFile('src/App.tsx', graph), 'route');
  for (const file of [
    'features/dashboard/controllers/DashboardController.tsx',
    'features/settings/controllers/SettingsController.tsx',
    'features/user/controllers/UserController.tsx',
  ]) {
    assert.equal(classifyFile(file, graph), 'controller');
  }
});

// #699 -- loadConfig/loadLayerGraph used to only ever hand out the framework's plural default
// folder names (controllers/, services/, ...): a project's own `layers:` override in
// architecture.yml had no effect, so a project with singular folders (service/ instead of
// services/) failed classification. This fixture overrides controller/workflow/hook/service/
// page/component to singular folder names and must validate exactly as cleanly as
// architecture-valid above.
test('architecture-valid-singular-layers fixture (a project with singular layer folder names, overridden via layers:) produces zero error-severity violations', () => {
  const root = path.join(REPO_ROOT, 'fixtures', 'architecture-valid-singular-layers');
  const res = validateArchitecture(root);
  const errors = res.violations.filter((v) => v.severity === 'error');
  assert.deepEqual(errors, []);
});

test('architecture-valid-singular-layers fixture classifies each singular-named folder as its layer', () => {
  const root = path.join(REPO_ROOT, 'fixtures', 'architecture-valid-singular-layers');
  const graph = loadLayerGraph(root);
  assert.equal(graph.service.pattern, 'features/*/service/**');
  assert.equal(classifyFile('features/widget/controller/WidgetController.tsx', graph), 'controller');
  assert.equal(classifyFile('features/widget/workflow/WidgetWorkflow.tsx', graph), 'workflow');
  assert.equal(classifyFile('features/widget/hook/useWidget.tsx', graph), 'hook');
  assert.equal(classifyFile('features/widget/service/WidgetService.ts', graph), 'service');
  assert.equal(classifyFile('features/widget/page/WidgetPage.tsx', graph), 'page');
  assert.equal(classifyFile('features/widget/component/WidgetComponent.tsx', graph), 'component');
  // The plural framework default must NOT also match — proves the override, not just an
  // accidental additional match.
  assert.equal(classifyFile('features/widget/services/WidgetService.ts', graph), null);
});

test('architecture-invalid fixture reports exactly the expected rule per manifest entry', () => {
  const dir = path.join(REPO_ROOT, 'fixtures', 'architecture-invalid');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const res = validateArchitecture(dir);
  for (const { file, expectedRule } of manifest) {
    const rulesForFile = res.violations.filter((v) => v.file === file).map((v) => v.rule);
    assert.deepEqual(rulesForFile, [expectedRule], `expected exactly [${expectedRule}] for ${file}, got [${rulesForFile}]`);
  }
  // Every violation is module:'architecture' and matches the frozen diagnostic shape.
  for (const v of res.violations) {
    assert.equal(v.module, 'architecture');
    assert.ok(['error', 'warning', 'off'].includes(v.severity));
  }
});

// ---- #503 -- the `expression` layer (EXPR-001..006) --------------------------------------

test('classifyFile recognizes the expression layer by path pattern', () => {
  assert.equal(classifyFile('features/cart/expressions/ShowDiscountBadge.tsx', CANONICAL_LAYERS), 'expression');
});

test('detectLayerViolations flags EXPR-001 for an Expression that uses an external effect', () => {
  const violations = detectLayerViolations('expression', `export function ShowBadge(){ return fetch('/'); }`);
  assert.ok(violations.some((v) => v.rule === 'EXPR-001'));
});

test('detectLayerViolations flags EXPR-004 for an Expression that hand-authors native JSX', () => {
  const src = `import { defineExpression } from '@construct/typed-contracts';\n`
    + `const ShowBadge = defineExpression('ShowBadge', ({ cond, children }) => cond ? <div>{children}</div> : null);`;
  const violations = detectLayerViolations('expression', src);
  assert.ok(violations.some((v) => v.rule === 'EXPR-004'));
  assert.match(violations.find((v) => v.rule === 'EXPR-004').message, /<div>/);
});

test('detectLayerViolations flags EXPR-003 for an Expression named after its control-flow kind', () => {
  const src = `import { defineExpression } from '@construct/typed-contracts';\n`
    + `export const If = defineExpression('If', ({ cond, children }) => <>{cond ? children : null}</>);`;
  assert.ok(detectLayerViolations('expression', src).some((v) => v.rule === 'EXPR-003'));
});

test('detectLayerViolations flags EXPR-005 for an Expression that never references children', () => {
  const src = `import { defineExpression } from '@construct/typed-contracts';\n`
    + `export const ShowDiscountBadge = defineExpression('ShowDiscountBadge', ({ cond }) => <>{cond ? 1 : null}</>);`;
  assert.ok(detectLayerViolations('expression', src).some((v) => v.rule === 'EXPR-005'));
});

test('detectLayerViolations flags EXPR-006 for an Expression not built through defineExpression(...)', () => {
  const src = `export const ShowDiscountBadge = ({ cond, children }) => cond ? children : null;`;
  assert.ok(detectLayerViolations('expression', src).some((v) => v.rule === 'EXPR-006'));
});

// #521 -- EXPR-006's factory-presence check must also recognize defineExpression called with an
// explicit generic type argument (defineExpression<Props>('Name', fn)) -- the canonical call
// shape this repo's own packages/core/typed-contracts/examples/expression.ts uses -- not just
// the plain defineExpression('Name', fn) shape.
test('#521: EXPR-006 does not fire for defineExpression called with an explicit generic type argument', () => {
  const src = `import { defineExpression } from '@construct/typed-contracts';\n`
    + `export const ShowDiscountBadge = defineExpression<ShowDiscountBadgeProps>('ShowDiscountBadge', ({ cond, children }) => <>{cond ? children : null}</>);`;
  assert.deepEqual(detectLayerViolations('expression', src).filter((v) => v.rule === 'EXPR-006'), []);
});

test('detectLayerViolations flags EXPR-002 once the default JSX complexity budget is exceeded', () => {
  const branches = Array.from({ length: 3 }, (_, i) => `{p.b${i}&&<X${i}/>}`).join('');
  const src = `import { defineExpression } from '@construct/typed-contracts';\n`
    + `export const ShowDiscountBadge = defineExpression('ShowDiscountBadge', ({ children, p }) => <>{children}${branches}</>);`;
  const violations = detectLayerViolations('expression', src);
  assert.deepEqual(violations.map((v) => v.rule), ['EXPR-002']);
});

test('detectLayerViolations honors EXPR-002 opts overrides (exprMaxJsxDepth/exprMaxJsxBranches)', () => {
  const src = `import { defineExpression } from '@construct/typed-contracts';\n`
    + `export const ShowDiscountBadge = defineExpression('ShowDiscountBadge', ({ children }) => <>{children}</>);`;
  assert.deepEqual(detectLayerViolations('expression', src, { exprMaxJsxDepth: 0 }).map((v) => v.rule), ['EXPR-002']);
  assert.deepEqual(detectLayerViolations('expression', src), []); // default budget (4) is not exceeded
});

test('detectLayerViolations reports zero EXPR violations for a real, well-formed Expression', () => {
  const src = `import { defineExpression } from '@construct/typed-contracts';\n`
    + `export const ShowDiscountBadge = defineExpression('ShowDiscountBadge', ({ cond, children }) => <>{cond ? children : null}</>);`;
  assert.deepEqual(detectLayerViolations('expression', src), []);
});

test('validateArchitecture: an expression-layer file with no legal issue gets zero error-severity violations by default', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'cart', 'expressions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'features', 'cart', 'expressions', 'ShowDiscountBadge.tsx'),
    `import { defineExpression } from '@construct/typed-contracts';\n`
      + `export const ShowDiscountBadge = defineExpression('ShowDiscountBadge', ({ cond, children }) => <>{cond ? children : null}</>);`,
  );
  const res = validateArchitecture(dir);
  assert.deepEqual(res.violations.filter((v) => v.file.includes('expressions')), []);
});

test('validateArchitecture: an expression importing a forbidden layer (service) is caught by the generic edge check (SOC-001)', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'cart', 'expressions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'features', 'cart', 'services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'features', 'cart', 'services', 'CartService.ts'), `export function fetchCart(){}`);
  fs.writeFileSync(
    path.join(dir, 'features', 'cart', 'expressions', 'ShowDiscountBadge.tsx'),
    `import { defineExpression } from '@construct/typed-contracts';\n`
      + `import { fetchCart } from '../services/CartService';\n`
      + `export const ShowDiscountBadge = defineExpression('ShowDiscountBadge', ({ children }) => { fetchCart(); return <>{children}</>; });`,
  );
  const res = validateArchitecture(dir);
  const hit = res.violations.find((v) => v.file.includes('ShowDiscountBadge'));
  assert.ok(hit, 'expected a violation for the forbidden expression -> service import');
  assert.equal(hit.rule, 'SOC-001');
});

// ---- #504 -- HOOK-001 (useTrackedState) + PAGE-006's further narrowing -------------------

test('#504 (before/after): HOOK-001 fires for a hook named use*State that is not built via useTrackedState', () => {
  const violations = detectLayerViolations('hook', `export function useCartState() { return { total: 0 }; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['HOOK-001']);
  assert.match(violations[0].message, /useCartState/);
});

test('#504: HOOK-001 does not fire for a hook named use*State that IS built via useTrackedState, with only directly-coupled setters/derivations', () => {
  const violations = detectLayerViolations(
    'hook',
    `import { useTrackedState } from '@construct/typed-contracts';\n`
      + `export function useCartState() { const [total, setTotal] = useTrackedState('total', 0); return { total, setTotal, isEmpty: total === 0 }; }`,
  );
  assert.deepEqual(violations.filter((v) => v.rule === 'HOOK-001'), []);
});

test('#504: HOOK-001 fires when a use*State hook built via useTrackedState also contains unrelated control flow', () => {
  const violations = detectLayerViolations(
    'hook',
    `import { useTrackedState } from '@construct/typed-contracts';\n`
      + `export function useCartState() { const [total, setTotal] = useTrackedState('total', 0); if (total > 10) { setTotal(0); } return { total, setTotal }; }`,
  );
  assert.deepEqual(violations.map((v) => v.rule), ['HOOK-001']);
});

test('#504: HOOK-001 fires when a use*State hook built via useTrackedState also contains an unrelated effect (useEffect/useRef/fetch)', () => {
  // #589 -- a bare fetch() is now ALSO a genuine, independent SERVICE-001 finding (only the
  // service layer may own an external effect) alongside HOOK-001's own "unrelated effect in a
  // tracked-state hook" finding -- two different rules correctly reporting two different
  // problems about the same fetch() call, not a duplicate. useEffect/useRef aren't in
  // SERVICE-001's effect vocabulary, so those two cases are unaffected.
  for (const [unrelated, expectedRules] of [
    ['useEffect(() => {}, [])', ['HOOK-001']],
    ['useRef(null)', ['HOOK-001']],
    ["fetch('/')", ['SERVICE-001', 'HOOK-001']],
  ]) {
    const violations = detectLayerViolations(
      'hook',
      `import { useTrackedState } from '@construct/typed-contracts';\n`
        + `export function useCartState() { const [total, setTotal] = useTrackedState('total', 0); ${unrelated}; return { total, setTotal }; }`,
    );
    assert.deepEqual(violations.map((v) => v.rule), expectedRules, `expected ${expectedRules} for: ${unrelated}`);
  }
});

test('#504: HOOK-001 does not fire for an ordinary hook with no State-shaped name (regression)', () => {
  const violations = detectLayerViolations('hook', `export function useCart() { return { items: [] }; }`);
  assert.deepEqual(violations.filter((v) => v.rule === 'HOOK-001'), []);
});

// #521 -- HOOK-001's factory-presence check must also recognize useTrackedState called with an
// explicit generic type argument (useTrackedState<T>(...)), not just the plain
// useTrackedState(...) shape.
test('#521: HOOK-001 does not fire for useTrackedState called with an explicit generic type argument', () => {
  const violations = detectLayerViolations(
    'hook',
    `import { useTrackedState } from '@construct/typed-contracts';\n`
      + `export function useCartState() { const [total, setTotal] = useTrackedState<number>('total', 0); return { total, setTotal }; }`,
  );
  assert.deepEqual(violations.filter((v) => v.rule === 'HOOK-001'), []);
});

// #504 -- PAGE-006 narrowed FURTHER: a page importing a tracked-state hook (named
// use<Name>State) is NOT flagged, alongside the Provider-hook allowance #510 already added;
// every other hook import (the exact #510/#112 fixtures) is still banned unchanged.
test('#504 (before/after): PAGE-006 no longer fires for a page importing a tracked-state hook by name', () => {
  const violations = detectLayerViolations(
    'page',
    `import { useCartState } from '../hooks/useCartState';\nexport function P(){ const { total } = useCartState(); return null; }`,
  );
  assert.deepEqual(violations, []);
});

test('#504: PAGE-006 still fires when a hook import mixes a State-named specifier with a non-Provider/non-State one', () => {
  const violations = detectLayerViolations(
    'page',
    `import { useCartState, useCart } from '../hooks/useCart';\nexport function P(){ useCartState(); useCart(); return null; }`,
  );
  assert.deepEqual(violations.map((v) => v.rule), ['PAGE-006']);
});

test('#504: PAGE-006 still fires for a plain hook import, and existing PAGE-006/HOOK-002 tests (#510) still pass unchanged (regression)', () => {
  assert.deepEqual(
    detectLayerViolations('page', `import { useCart } from '../hooks/useCart';\nexport function P(){ const { items } = useCart(); return null; }`).map((v) => v.rule),
    ['PAGE-006'],
  );
  assert.deepEqual(
    detectLayerViolations(
      'page',
      `import { useCartProvider } from '../hooks/useCartProvider';\nexport function P(){ const { total } = useCartProvider(); return null; }`,
    ),
    [],
  );
});

// ---- #505: PAGE-008 (no inline JSX logic) / PAGE-009 (page complexity budget) ---------

// PAGE-008 mirrors COMPONENT-005 exactly (same collectInlineJsxLogic helper), applied to the
// page layer instead of component. Same three independent shapes as the COMPONENT-005 test.
test('detectLayerViolations flags PAGE-008 for inline conditional/loop JSX, in each of its shapes', () => {
  assert.deepEqual(
    detectLayerViolations('page', `export function P(p){ return p.ok ? <A/> : <B/>; }`).map((v) => v.rule),
    ['PAGE-008'],
  );
  assert.deepEqual(
    detectLayerViolations('page', `export function P(p){ return <div>{p.ok && <A/>}</div>; }`).map((v) => v.rule),
    ['PAGE-008'],
  );
  assert.deepEqual(
    detectLayerViolations('page', `export function P(p){ return <ul>{p.items.map(i => <li key={i}>{i}</li>)}</ul>; }`).map((v) => v.rule),
    ['PAGE-008'],
  );
});

test('detectLayerViolations does NOT flag PAGE-008 for a .map() whose callback never returns JSX', () => {
  const src = `export function P(p){ const ids = p.items.map(i => i.id); return <div>{ids.length}</div>; }`;
  assert.deepEqual(detectLayerViolations('page', src), []);
});

// PAGE-009 mirrors COMPONENT-006 exactly (same computeJsxComplexity helper and default budget).
test('detectLayerViolations flags PAGE-009 once the default JSX-nesting-depth budget is exceeded, with no inline logic present', () => {
  const deep = '<div>'.repeat(7) + 'hi' + '</div>'.repeat(7);
  const violations = detectLayerViolations('page', `export function P(){ return ${deep}; }`);
  assert.deepEqual(violations.map((v) => v.rule), ['PAGE-009']);
  assert.match(violations[0].message, /nesting depth 7/);
});

test('detectLayerViolations flags PAGE-009 once the default branch-count budget is exceeded (PAGE-008 also fires, independently)', () => {
  const src = `export function P(p){ return <div>{p.a?<X/>:<Y/>}{p.b&&<Z/>}{p.c&&<W/>}{p.d&&<V/>}</div>; }`;
  const rules = detectLayerViolations('page', src).map((v) => v.rule);
  assert.deepEqual(rules.sort(), ['PAGE-008', 'PAGE-009']);
});

test('detectLayerViolations honors PAGE-009 opts overrides (maxJsxDepth/maxJsxBranches)', () => {
  const src = `export function P(){ return <div><span/></div>; }`; // depth 2, 0 branches
  assert.deepEqual(detectLayerViolations('page', src, { maxJsxDepth: 1 }).map((v) => v.rule), ['PAGE-009']);
  assert.deepEqual(detectLayerViolations('page', src), []); // default budget (6) is not exceeded
});

test('validateArchitecture honors PAGE-009-max-depth/PAGE-009-max-branches overrides from architecture.yml', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'features', 'x', 'pages', 'Deep.tsx'), `export function Deep(){ return <div><span/></div>; }\n`);
  fs.appendFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  PAGE-009-max-depth: 1\n');
  const res = validateArchitecture(dir);
  assert.ok(res.violations.some((v) => v.rule === 'PAGE-009' && v.file === 'features/x/pages/Deep.tsx'));
});

// PAGE-008/PAGE-009 default to 'warning' for the same reason COMPONENT-005/006 do (#508): a real,
// pre-existing fixture already has inline loop logic in a page's JSX --
// fixtures/frozen-presentation/project-bad's CpoHome.tsx (a `.map()` list render) -- so a silent
// 'error' default would have broken it (exactly the non-additive breakage #500 phase 1 rules out).
test('PAGE-008 defaults to warning severity: the real frozen-presentation CpoHome.tsx fixture already has an inline .map() render', () => {
  const dir = path.join(REPO_ROOT, 'fixtures', 'frozen-presentation', 'project-bad');
  const res = validateArchitecture(dir);
  const v = res.violations.find((x) => x.rule === 'PAGE-008' && x.file === 'features/cpo/pages/CpoHome.tsx');
  assert.ok(v, 'expected PAGE-008 to fire on CpoHome.tsx');
  assert.equal(v.severity, 'warning');
});


// ---- #506: DOMAIN-002 (allowlist purity, additive alongside DOMAIN-001, flag-gated) ----

// Off by default (DEFAULT_RULES) -- detectLayerViolations requires opts.domainPurityAllowlist
// so every pre-existing call site (including the DOMAIN-001 tests above, which call
// detectLayerViolations('domain', src) with no third argument) is completely unaffected.
test('detectLayerViolations does not run DOMAIN-002 unless opts.domainPurityAllowlist is set', () => {
  const src = `export function f(){ return document.title; }`;
  assert.deepEqual(detectLayerViolations('domain', src).map((v) => v.rule), ['DOMAIN-001']);
  assert.deepEqual(detectLayerViolations('domain', src, { domainPurityAllowlist: true }).map((v) => v.rule).sort(), ['DOMAIN-001', 'DOMAIN-002']);
});

// #492's false positive: DOMAIN-001's denylist still (unchanged, per #500 phase 1) flags a
// parameter merely *named* document -- DOMAIN-002 does not, because it allows any of the
// function's own parameters/local bindings regardless of name.
test('DOMAIN-002 (#492 proof, false positive avoided): a parameter merely named "document" does not trip DOMAIN-002, though DOMAIN-001 still (unchanged) does', () => {
  const src = `export function AddWidget(document, widget) { return { ...document, widgets: [...document.widgets, widget] }; }`;
  const withAllowlist = detectLayerViolations('domain', src, { domainPurityAllowlist: true }).map((v) => v.rule);
  assert.deepEqual(withAllowlist, ['DOMAIN-001'], 'DOMAIN-001 keeps its existing (buggy, unfixed-by-this-ticket) behavior');
  assert.equal(withAllowlist.includes('DOMAIN-002'), false, 'DOMAIN-002 must not false-positive on a same-named parameter');
});

// A genuine effect still correctly flags under the new allowlist too, regardless of name.
test('DOMAIN-002 (still-caught proof): a genuine document.querySelector(...) call is flagged', () => {
  const src = `export function f(){ return document.querySelector('.x'); }`;
  const rules = detectLayerViolations('domain', src, { domainPurityAllowlist: true }).map((v) => v.rule).sort();
  assert.deepEqual(rules, ['DOMAIN-001', 'DOMAIN-002']);
});

// A value import used as a value is exactly the kind of effect DOMAIN-001's fixed name list
// cannot see at all, but DOMAIN-002's allowlist catches regardless of what it's named.
test('DOMAIN-002 catches a value import used as a value, which DOMAIN-001 cannot see by name', () => {
  const src = `import { helper } from './helper';\nexport function f(x){ return helper(x); }`;
  assert.deepEqual(detectLayerViolations('domain', src).map((v) => v.rule), []); // DOMAIN-001: nothing to see here
  assert.deepEqual(detectLayerViolations('domain', src, { domainPurityAllowlist: true }).map((v) => v.rule), ['DOMAIN-002']);
});

// #619: defineDomain is the typed-contracts factory a domain unit is built through; the allowlist must not
// count importing it as an effect, or DOMAIN-002 and defineDomain(...) could never both be on. Only that one
// factory, only from a typed-contracts module: any other value import is still flagged.
test('DOMAIN-002 lets a domain unit import defineDomain from typed-contracts, and nothing else by value', () => {
  const unit = (from, name = 'defineDomain') => `import { ${name} } from '${from}';\nexport const sortAll = ${name}('sortAll', ({ items }) => [...items].sort());`;
  for (const from of ['@line/construct-core/typed-contracts', '../../../packages/core/typed-contracts/index.ts']) {
    assert.deepEqual(detectLayerViolations('domain', unit(from), { domainPurityAllowlist: true }), [], from);
  }
  assert.deepEqual(detectLayerViolations('domain', unit('./helpers'), { domainPurityAllowlist: true }).map((v) => v.rule), ['DOMAIN-002'], 'the same name from another module is an effect');
  assert.deepEqual(detectLayerViolations('domain', unit('@line/construct-core/typed-contracts', 'defineService'), { domainPurityAllowlist: true }).map((v) => v.rule), ['DOMAIN-002'], 'another factory is not the domain factory');
});

// A type-only import used only in a type position is never a violation.
test('DOMAIN-002 does not flag a type-only import used only as a type', () => {
  const src = `import type { Foo } from './types';\nexport function f(x: Foo): Foo { return x; }`;
  assert.deepEqual(detectLayerViolations('domain', src, { domainPurityAllowlist: true }), []);
});

// End-to-end through validateArchitecture: off by default (no architecture.yml override), and a
// project can opt in via `rules: { DOMAIN-002: error }`. Also proves the false-positive-avoided
// and still-caught cases survive the full config/severity pipeline, not just the pure detector.
test('validateArchitecture: DOMAIN-002 is off by default and opt-in via architecture.yml (rules: DOMAIN-002: error)', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'x', 'domain'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'features', 'x', 'domain', 'AddWidget.ts'),
    `export function AddWidget(document, widget) { return { ...document, widgets: [...document.widgets, widget] }; }\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'features', 'x', 'domain', 'RealEffect.ts'),
    `export function f(){ return document.querySelector('.x'); }\n`,
  );

  const off = validateArchitecture(dir);
  assert.equal(off.violations.some((v) => v.rule === 'DOMAIN-002'), false, 'DOMAIN-002 must be silent by default');
  assert.ok(off.violations.some((v) => v.rule === 'DOMAIN-001' && v.file === 'features/x/domain/AddWidget.ts'), 'DOMAIN-001 keeps firing unchanged');

  fs.appendFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  DOMAIN-002: error\n');
  const on = validateArchitecture(dir);
  assert.equal(
    on.violations.some((v) => v.rule === 'DOMAIN-002' && v.file === 'features/x/domain/AddWidget.ts'),
    false,
    'opting in must still not false-positive on the document-named parameter',
  );
  assert.ok(
    on.violations.some((v) => v.rule === 'DOMAIN-002' && v.file === 'features/x/domain/RealEffect.ts' && v.severity === 'error'),
    'opting in must still catch the genuine document.querySelector(...) effect',
  );
});
