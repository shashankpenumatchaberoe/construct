import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSeparationOfConcerns, isPublicPath, countPrimaryExports, parseIndexExports } from '../packages/core/soc-enforcer.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(__dirname, '..', 'fixtures');

function tmpProject() {
  return makeTempDir('construct-soc-');
}

function writeFile(root, relPath, contents) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function scaffoldFeature(root, name) {
  for (const dir of ['controllers', 'workflows', 'hooks', 'domain', 'services', 'pages', 'components']) {
    fs.mkdirSync(path.join(root, 'features', name, dir), { recursive: true });
  }
  writeFile(root, `features/${name}/index.ts`, `// Public API for feature: ${name}\n`);
  writeFile(root, `features/${name}/types.ts`, `export type ${name}Id = string;\n`);
}

// ---------------------------------------------------------------------------
// countPrimaryExports — tricky syntax unit tests (Epic 2.4)
// ---------------------------------------------------------------------------
test('countPrimaryExports: arrow function assigned to export const', () => {
  const r = countPrimaryExports(`export const handler = (req, res) => {\n  return res;\n};\n`);
  assert.deepEqual(r.map((e) => e.name), ['handler']);
});

test('countPrimaryExports: export default function (named and anonymous)', () => {
  assert.deepEqual(countPrimaryExports(`export default function Widget() { return 1; }`).map((e) => e.name), ['Widget']);
  assert.deepEqual(countPrimaryExports(`export default function () { return 1; }`).map((e) => e.name), ['default']);
});

test('countPrimaryExports: export default class and default expression', () => {
  assert.deepEqual(countPrimaryExports(`export default class Foo {}`).map((e) => e.name), ['Foo']);
  assert.deepEqual(countPrimaryExports(`const x = 1;\nexport default x;`).map((e) => e.name), ['default']);
});

test('countPrimaryExports: export * from does not count', () => {
  assert.deepEqual(countPrimaryExports(`export * from './x';\nexport * from './y';`), []);
});

test('countPrimaryExports: named re-export with from does not count', () => {
  assert.deepEqual(countPrimaryExports(`export { a, b } from './x';`), []);
});

test('countPrimaryExports: multiple exports on one line (comma-separated const)', () => {
  const r = countPrimaryExports(`export const a = 1, b = 2, c = 3;`);
  assert.deepEqual(r.map((e) => e.name).sort(), ['a', 'b', 'c']);
});

test('countPrimaryExports: multiple export statements on one physical line', () => {
  const r = countPrimaryExports(`export function a(){} export function b(){}`);
  assert.deepEqual(r.map((e) => e.name), ['a', 'b']);
});

test('countPrimaryExports: bare named export list (no from) counts locally declared exports', () => {
  const r = countPrimaryExports(`const a = 1;\nconst b = 2;\nexport { a, b as renamed };`);
  assert.deepEqual(r.map((e) => e.name).sort(), ['a', 'renamed']);
});

// ---------------------------------------------------------------------------
// isPublicPath
// ---------------------------------------------------------------------------
test('isPublicPath: a controller re-exported via export * is public', () => {
  assert.equal(isPublicPath(path.join(fixturesRoot, 'soc-clean'), 'features/alpha/controllers/AlphaController.tsx'), true);
});

test('isPublicPath: a service never exported is private', () => {
  assert.equal(isPublicPath(path.join(fixturesRoot, 'soc-clean'), 'features/alpha/services/alphaService.ts'), false);
});

test('isPublicPath: index.ts itself is always public', () => {
  assert.equal(isPublicPath(path.join(fixturesRoot, 'soc-clean'), 'features/alpha/index.ts'), true);
});

test('isPublicPath: a path outside the features root is not applicable (true)', () => {
  assert.equal(isPublicPath(path.join(fixturesRoot, 'soc-clean'), 'app/page.tsx'), true);
});

test('isPublicPath: a named (non-wildcard) export matches only its own file, not siblings', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/index.ts', `export { foo } from './domain/foo';\n`);
  writeFile(d, 'features/alpha/domain/foo.ts', `export function foo() {}\n`);
  writeFile(d, 'features/alpha/domain/bar.ts', `export function bar() {}\n`);
  assert.equal(isPublicPath(d, 'features/alpha/domain/foo.ts'), true);
  assert.equal(isPublicPath(d, 'features/alpha/domain/bar.ts'), false);
});

test('isPublicPath: a directory-level export * covers every file underneath it', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/index.ts', `export * from './controllers';\n`);
  writeFile(d, 'features/alpha/controllers/Foo.ts', `export function Foo() {}\n`);
  assert.equal(isPublicPath(d, 'features/alpha/controllers/Foo.ts'), true);
});

// ---------------------------------------------------------------------------
// parseIndexExports
// ---------------------------------------------------------------------------
test('parseIndexExports finds wildcard and named-from exports with line numbers', () => {
  const src = `// header\nexport type * from './types';\nexport * from './controllers/Foo';\nexport { bar } from './domain/bar';\n`;
  const entries = parseIndexExports(src);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].specifier, './types');
  assert.equal(entries[0].isType, true);
  assert.equal(entries[1].isWildcard, true);
  assert.equal(entries[2].line, 4);
});

// ---------------------------------------------------------------------------
// Full-fixture tests (Epic 2.4)
// ---------------------------------------------------------------------------
test('fixture soc-clean: no violations', () => {
  const r = validateSeparationOfConcerns(path.join(fixturesRoot, 'soc-clean'));
  assert.deepEqual(r.violations, []);
});

// #699 -- checkSkeleton (SLICE-001) and checkOwnership (SOC-001) used to check every feature
// against a hardcoded plural folder list (controllers/, services/, ...), completely ignoring
// architecture.yml's `layers:` override -- this (not config.mjs's loadConfig alone) is the actual
// mechanism behind Trace's reported 193 SOC-001 errors on a project with singular layer folders:
// every file under e.g. features/*/service/ was "under unrecognized folder" and every feature was
// "missing" controllers/workflows/hooks/services/pages/components even when it had their singular
// equivalents. architecture-valid-singular-layers overrides those six layers to singular folder
// names; both rules must now recognize them.
test('fixture architecture-valid-singular-layers: layers: override is honored, zero SOC-001/SLICE-001 violations', () => {
  const r = validateSeparationOfConcerns(path.join(fixturesRoot, 'architecture-valid-singular-layers'));
  assert.deepEqual(r.violations.filter((v) => v.rule === 'SOC-001' || v.rule === 'SLICE-001'), []);
});

// #724 -- internalUnitKind (SLICE-004's "which internal-unit folder is this?" helper) used to
// hardcode the plural `(components|hooks)` regex, so a project with singular `component/`/`hook/`
// folders (via the SAME `layers:` override honored by SOC-001/SLICE-001 above, #699) never matched
// and SLICE-004 was silently skipped for its component/provider re-exports. The fixture's
// features/widget/index.ts re-exports WidgetComponent directly from its singular `component/`
// folder -- this must still be flagged.
test('fixture architecture-valid-singular-layers: a direct re-export from the singular component/ folder still fires SLICE-004', () => {
  const r = validateSeparationOfConcerns(path.join(fixturesRoot, 'architecture-valid-singular-layers'));
  const v = r.violations.filter((x) => x.rule === 'SLICE-004');
  assert.equal(v.length, 1);
  assert.equal(v[0].file, 'features/widget/index.ts');
  assert.match(v[0].message, /WidgetComponent/);
});

test('fixture soc-cross-feature: exactly one SLICE-002 violation fires', () => {
  const r = validateSeparationOfConcerns(path.join(fixturesRoot, 'soc-cross-feature'));
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].rule, 'SLICE-002');
  assert.equal(r.violations[0].file, 'features/beta/controllers/BetaController.tsx');
  assert.equal(r.violations[0].module, 'separation-of-concerns');
});

test('fixture soc-god-file: exactly one MODULE-001 violation fires', () => {
  const r = validateSeparationOfConcerns(path.join(fixturesRoot, 'soc-god-file'));
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].rule, 'MODULE-001');
  assert.equal(r.violations[0].file, 'features/alpha/domain/godFile.ts');
  assert.match(r.violations[0].message, /5 primary exports/);
});

// ---------------------------------------------------------------------------
// SLICE-004 (#509) — cross-feature component/provider re-export must be a distinct wrapper
// ---------------------------------------------------------------------------
test('SLICE-004 (regression): the existing SLICE-002 fixtures (soc-clean, soc-cross-feature) fire zero SLICE-004 violations', () => {
  // soc-clean re-exports a plain (non-Provider) hook (`export * from './hooks/useAlpha'`) --
  // a pre-existing, legitimate pattern that must stay untouched.
  assert.deepEqual(
    validateSeparationOfConcerns(path.join(fixturesRoot, 'soc-clean')).violations.filter((v) => v.rule === 'SLICE-004'),
    [],
  );
  assert.deepEqual(
    validateSeparationOfConcerns(path.join(fixturesRoot, 'soc-cross-feature')).violations.filter((v) => v.rule === 'SLICE-004'),
    [],
  );
  // and soc-cross-feature's own SLICE-002 case still fires exactly as before (unchanged).
  const r = validateSeparationOfConcerns(path.join(fixturesRoot, 'soc-cross-feature'));
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].rule, 'SLICE-002');
});

test('SLICE-004: a direct re-export of an internal component from index.ts is flagged', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/index.ts', `export { InternalThing } from './components/InternalThing';\n`);
  writeFile(d, 'features/alpha/components/InternalThing.tsx', `export function InternalThing() { return null; }\n`);
  const r = validateSeparationOfConcerns(d);
  const v = r.violations.filter((x) => x.rule === 'SLICE-004');
  assert.equal(v.length, 1);
  assert.equal(v[0].file, 'features/alpha/index.ts');
  assert.match(v[0].message, /InternalThing/);
});

test('SLICE-004: aliasing the raw internal component under a different exported name is STILL flagged', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/index.ts', `export { InternalThing as SharedThing } from './components/InternalThing';\n`);
  writeFile(d, 'features/alpha/components/InternalThing.tsx', `export function InternalThing() { return null; }\n`);
  const r = validateSeparationOfConcerns(d);
  const v = r.violations.filter((x) => x.rule === 'SLICE-004');
  assert.equal(v.length, 1);
  assert.match(v[0].message, /SharedThing/);
});

test('SLICE-004: a bare local alias (import then re-export the same reference, no wrapping) is STILL flagged', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(
    d,
    'features/alpha/index.ts',
    `import { InternalThing } from './components/InternalThing';\nexport const SharedThing = InternalThing;\n`,
  );
  writeFile(d, 'features/alpha/components/InternalThing.tsx', `export function InternalThing() { return null; }\n`);
  const r = validateSeparationOfConcerns(d);
  const v = r.violations.filter((x) => x.rule === 'SLICE-004');
  assert.equal(v.length, 1);
  assert.match(v[0].message, /SharedThing/);
});

test('SLICE-004: a distinct wrapper function (a genuinely new function that wraps the internal unit) PASSES', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(
    d,
    'features/alpha/index.ts',
    `import { InternalThing } from './components/InternalThing';\nexport const SharedThing = (props) => InternalThing(props);\n`,
  );
  writeFile(d, 'features/alpha/components/InternalThing.tsx', `export function InternalThing(props) { return props; }\n`);
  const r = validateSeparationOfConcerns(d);
  assert.deepEqual(r.violations.filter((x) => x.rule === 'SLICE-004'), []);
});

test('SLICE-004: an ordinary (non-Provider) hook re-exported directly from hooks/ is NOT flagged (matches the existing soc-clean pattern)', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/index.ts', `export * from './hooks/useAlpha';\n`);
  writeFile(d, 'features/alpha/hooks/useAlpha.ts', `export function useAlpha() { return {}; }\n`);
  const r = validateSeparationOfConcerns(d);
  assert.deepEqual(r.violations.filter((x) => x.rule === 'SLICE-004'), []);
});

test('SLICE-004: a Provider hook (use<Name>Provider) re-exported directly IS flagged', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/index.ts', `export { useCartProvider } from './hooks/useCartProvider';\n`);
  writeFile(d, 'features/alpha/hooks/useCartProvider.ts', `export function useCartProvider() { return {}; }\n`);
  const r = validateSeparationOfConcerns(d);
  const v = r.violations.filter((x) => x.rule === 'SLICE-004');
  assert.equal(v.length, 1);
  assert.match(v[0].message, /useCartProvider/);
});

test('SLICE-004: a wildcard re-export of a Provider hook file IS flagged, keyed off the file name', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/index.ts', `export * from './hooks/useCartProvider';\n`);
  writeFile(d, 'features/alpha/hooks/useCartProvider.ts', `export function useCartProvider() { return {}; }\n`);
  const r = validateSeparationOfConcerns(d);
  assert.equal(r.violations.filter((x) => x.rule === 'SLICE-004').length, 1);
});

// ---------------------------------------------------------------------------
// SLICE-001 — feature-root/skeleton existence
// ---------------------------------------------------------------------------
test('SLICE-001: missing features root is reported with a create-feature suggestion', () => {
  const d = tmpProject();
  const r = validateSeparationOfConcerns(d);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].rule, 'SLICE-001');
  assert.match(r.violations[0].suggestedFix, /construct feature create/);
});

test('SLICE-001: a feature missing subfolders names them and suggests the exact fix command', () => {
  const d = tmpProject();
  fs.mkdirSync(path.join(d, 'features', 'gamma', 'controllers'), { recursive: true });
  writeFile(d, 'features/gamma/index.ts', '// Public API for feature: gamma\n');
  const r = validateSeparationOfConcerns(d);
  const v = r.violations.find((v) => v.rule === 'SLICE-001');
  assert.ok(v, 'expected a SLICE-001 violation');
  assert.match(v.message, /workflows/);
  assert.equal(v.suggestedFix, 'Run: construct feature create gamma');
});

// ---------------------------------------------------------------------------
// SOC-001 — ownership check
// ---------------------------------------------------------------------------
test('SOC-001: a stray file directly in the feature root is flagged', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/utils.ts', 'export function helper() {}\n');
  const r = validateSeparationOfConcerns(d);
  const v = r.violations.find((v) => v.rule === 'SOC-001');
  assert.ok(v);
  assert.equal(v.file, 'features/alpha/utils.ts');
});

test('SOC-001: a file under an unrecognized folder is flagged, shared/ is allowed', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/utilities/helper.ts', 'export function helper() {}\n');
  writeFile(d, 'features/alpha/shared/constants.ts', 'export const X = 1;\n');
  const r = validateSeparationOfConcerns(d);
  const socViolations = r.violations.filter((v) => v.rule === 'SOC-001');
  assert.equal(socViolations.length, 1);
  assert.equal(socViolations[0].file, 'features/alpha/utilities/helper.ts');
});

// ---------------------------------------------------------------------------
// DRY-001 — duplication heuristic (warning-level)
// ---------------------------------------------------------------------------
test('DRY-001: near-identical function bodies across two features are flagged as a warning', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  scaffoldFeature(d, 'beta');
  const body = `export function computeShippingCost(order) {\n  const base = order.weight * 1.5 + order.distance * 0.2;\n  const surcharge = order.express ? base * 0.35 : 0;\n  return base + surcharge + order.handlingFee;\n}\n`;
  writeFile(d, 'features/alpha/domain/shipping.ts', body);
  writeFile(d, 'features/beta/domain/shipping.ts', body.replace(/order/g, 'shipment'));
  const r = validateSeparationOfConcerns(d);
  const dry = r.violations.filter((v) => v.rule === 'DRY-001');
  assert.equal(dry.length, 1);
  assert.equal(dry[0].severity, 'warning');
  assert.match(dry[0].suggestedFix, /shared/);
});

test('DRY-001: similar functions within the SAME feature are not flagged', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  const body = `export function computeShippingCost(order) {\n  const base = order.weight * 1.5 + order.distance * 0.2;\n  const surcharge = order.express ? base * 0.35 : 0;\n  return base + surcharge + order.handlingFee;\n}\n`;
  writeFile(d, 'features/alpha/domain/shippingA.ts', body);
  writeFile(d, 'features/alpha/domain/shippingB.ts', body);
  const r = validateSeparationOfConcerns(d);
  assert.equal(r.violations.filter((v) => v.rule === 'DRY-001').length, 0);
});

// #338: thin wiring controllers share a shape (hook call + page render) and used to collide once
// every identifier was erased. They carry no business rule, so they are not logic.
const thinController = (name, hook, page) =>
  `export function ${name}() {\n  const { items, status, error, reload, select } = ${hook}();\n  return <${page} items={items} status={status} error={error} onReload={reload} onSelect={select} view={buildView(items)} />;\n}\n`;

test('DRY-001 (#338): two thin controllers with different hooks/pages are NOT flagged', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  scaffoldFeature(d, 'beta');
  writeFile(d, 'features/alpha/controllers/CommitIndicatorController.tsx', thinController('CommitIndicatorController', 'useCommitStatus', 'CommitIndicatorPage'));
  writeFile(d, 'features/beta/controllers/LogsController.tsx', thinController('LogsController', 'useLogs', 'LogsPage'));
  const r = validateSeparationOfConcerns(d);
  assert.equal(r.violations.filter((v) => v.rule === 'DRY-001').length, 0);
});

test('DRY-001 (#338): a copy-pasted function with renamed identifiers is STILL flagged, in a controller too', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  scaffoldFeature(d, 'beta');
  const body = `export function pickVisible(rows, mode) {\n  const out = [];\n  for (const row of rows) {\n    if (mode === 'all' || row.pinned) out.push(row);\n  }\n  return out.length > 0 ? out : rows;\n}\n`;
  writeFile(d, 'features/alpha/controllers/ListController.tsx', body);
  writeFile(d, 'features/beta/controllers/GridController.tsx', body.replace(/rows/g, 'cells').replace(/row/g, 'cell').replace(/out/g, 'kept'));
  const r = validateSeparationOfConcerns(d);
  assert.equal(r.violations.filter((v) => v.rule === 'DRY-001').length, 1);
});

// ---------------------------------------------------------------------------
// MODULE-001 threshold is configurable via architecture.yml
// ---------------------------------------------------------------------------
test('MODULE-001: threshold is configurable via architecture.yml (nested rules.MODULE-001.threshold)', () => {
  const d = tmpProject();
  scaffoldFeature(d, 'alpha');
  writeFile(d, 'features/alpha/domain/ops.ts', `export function a(){}\nexport function b(){}\nexport function c(){}\nexport function d(){}\n`);
  writeFile(d, 'architecture.yml', 'rules:\n  MODULE-001:\n    threshold: 5\n');
  const r = validateSeparationOfConcerns(d);
  assert.equal(r.violations.filter((v) => v.rule === 'MODULE-001').length, 0);
});

// ---------------------------------------------------------------------------
// #326 — countPrimaryExports reads the AST: generics' commas and comments do not count
// ---------------------------------------------------------------------------
test('countPrimaryExports (#326): a comma inside a generic annotation is not a second declarator', () => {
  const src = [
    `export const MODE_LABELS: Record<CommitMode, string> = { a: 'x' };`,
    `export const M: Map<string, Map<number, boolean>> = new Map();`,
    `export const P: Partial<Record<A, B>> = {};`,
  ].join('\n');
  assert.deepEqual(countPrimaryExports(src).map((e) => e.name), ['MODE_LABELS', 'M', 'P']);
});

test('countPrimaryExports (#326): a real comma-separated declarator list still counts each binding', () => {
  assert.deepEqual(countPrimaryExports(`export const a: Record<K, V> = {}, b = 2;`).map((e) => e.name), ['a', 'b']);
});

test('countPrimaryExports (#326): the word export inside a line or block comment is not an export', () => {
  const src = [
    `// export const fake = 1;`,
    `/* export function alsoFake() {}`,
    `   export { nope } */`,
    `/** Example: export default class Ghost {} */`,
    `const s = "export const inString = 1";`,
    `export const real = 1;`,
  ].join('\n');
  assert.deepEqual(countPrimaryExports(src).map((e) => e.name), ['real']);
});

test('countPrimaryExports (#326): a genuine second export is still caught, with its line', () => {
  const r = countPrimaryExports(`// export const ghost = 0;\nexport const one: Record<A, B> = {};\nexport function two() {}\n`);
  assert.deepEqual(r, [{ name: 'one', line: 2 }, { name: 'two', line: 3 }]);
});

test('countPrimaryExports (#326): three real exports with generics and commented examples stay at three', () => {
  const src = `// e.g. export const x = 1; Record<A, B>\nexport const A1: Record<K, V> = {};\nexport const A2: Map<K, V> = new Map();\nexport function A3() {}\n`;
  assert.equal(countPrimaryExports(src).length, 3);
});
