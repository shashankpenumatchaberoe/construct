import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { transformPristineSource, ingestPage } from '../packages/engine/pageTransformer.mjs';
import { createFeature } from '../packages/core/generators.mjs';
import { validateArchitecture } from '../packages/core/architecture-enforcer.mjs';
import { ConstructError, EXIT_CODES } from '../packages/core/diagnostics.mjs';
import { parseToAst } from '../packages/core/parser.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const bin = path.join(REPO_ROOT, 'packages', 'cli', 'construct.mjs');
const FIXTURE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'subframe-export', 'CheckoutExport.tsx'), 'utf8');

function tmpProject() {
  const dir = makeTempDir('construct-page-transformer-');
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nproject:\n  framework: nextjs\nfeatures:\n  root: features\n');
  createFeature(dir, 'checkout');
  fs.mkdirSync(path.join(dir, 'features', 'checkout', 'components'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'features', 'checkout', 'components', 'Card.tsx'),
    `export function Card({ children }: { children: React.ReactNode }) {\n  return <div className="card">{children}</div>;\n}\n`,
  );
  return dir;
}

// ---- transformPristineSource: pure, in-memory ------------------------------

test('transformPristineSource catalogs every interactive prop across the JSX tree, deduped', () => {
  const { slots } = transformPristineSource(FIXTURE_SOURCE, { feature: 'checkout', name: 'Checkout' });
  assert.deepEqual(slots, [
    { name: 'onSubmit', kind: 'callback' },
    { name: 'value', kind: 'value' },
    { name: 'onChange', kind: 'callback' },
    { name: 'onClick', kind: 'callback' },
  ]);
});

test('transformPristineSource generates a Props interface declaring every slot with a real type', () => {
  const { propsSource } = transformPristineSource(FIXTURE_SOURCE, { feature: 'checkout', name: 'Checkout' });
  assert.match(propsSource, /export interface CheckoutPageProps \{/);
  assert.match(propsSource, /onSubmit: \(event: React\.FormEvent<HTMLFormElement>\) => void;/);
  assert.match(propsSource, /value: string;/);
  assert.match(propsSource, /onChange: \(value: string\) => void;/);
  assert.match(propsSource, /onClick: \(\) => void;/);
});

test('transformPristineSource produces a presentation-only page: state/local handlers stripped, attrs rewired to props', () => {
  const { pageSource } = transformPristineSource(FIXTURE_SOURCE, { feature: 'checkout', name: 'Checkout' });

  // Local state and the handler that closed over it are gone entirely.
  assert.doesNotMatch(pageSource, /useState/);
  assert.doesNotMatch(pageSource, /quantity/);
  assert.doesNotMatch(pageSource, /handleIncrement/);
  assert.doesNotMatch(pageSource, /setQuantity/);

  // Each catalogued attribute is rewired to reference the same-named prop.
  assert.match(pageSource, /onSubmit=\{onSubmit\}/);
  assert.match(pageSource, /value=\{value\}/);
  assert.match(pageSource, /onChange=\{onChange\}/);
  assert.match(pageSource, /onClick=\{onClick\}/);

  // A still-used sibling component import is retained; an unused hook import is dropped.
  assert.match(pageSource, /import \{ Card \} from '\.\.\/components\/Card';/);
  assert.doesNotMatch(pageSource, /from 'react'/);

  // Signature destructures exactly the discovered slots against the new Props type.
  assert.match(pageSource, /export function CheckoutPage\(\{ onSubmit, value, onChange, onClick \}: CheckoutPageProps\)/);

  // The result must actually be parseable TSX.
  assert.doesNotThrow(() => parseToAst(pageSource));
});

test('transformPristineSource throws a clear ConstructError when no exported component function is found', () => {
  assert.throws(() => transformPristineSource(`export const x = 1;\n`, { feature: 'checkout', name: 'Checkout' }), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.match(err.message, /No exported React component function/);
    return true;
  });
});

test('transformPristineSource handles a concise-body arrow component (no braces) with no interactive props', () => {
  const { pageSource, slots } = transformPristineSource(
    `export const Empty = () => (<div className="empty">Nothing here</div>);\n`,
    { feature: 'checkout', name: 'Empty' },
  );
  assert.deepEqual(slots, []);
  assert.match(pageSource, /export function EmptyPage\(_props: EmptyPageProps\)/);
  assert.doesNotThrow(() => parseToAst(pageSource));
});

// ---- ingestPage: filesystem-backed, end-to-end via validateArchitecture ---

test('ingestPage writes a page + Props file that passes construct validate cleanly', () => {
  const dir = tmpProject();
  const { pageFile, propsFile, slots } = ingestPage(dir, 'Checkout', 'checkout', path.join(REPO_ROOT, 'fixtures', 'subframe-export', 'CheckoutExport.tsx'));

  assert.equal(pageFile, path.join(dir, 'features', 'checkout', 'pages', 'CheckoutPage.tsx'));
  assert.equal(propsFile, path.join(dir, 'features', 'checkout', 'pages', 'CheckoutPageProps.ts'));
  assert.equal(slots.length, 4);
  assert.equal(fs.existsSync(pageFile), true);
  assert.equal(fs.existsSync(propsFile), true);

  const { violations } = validateArchitecture(dir);
  assert.deepEqual(violations.filter((v) => v.severity === 'error'), []);
});

// #677 -- `construct create page <name> --feature <missing> --from <file>` used to write only pages/, leaving
// the rest of the feature's layer folders and its types.ts/index.ts missing. Uses a source with no relative
// imports of its own (plain HTML elements only), so the only thing under test is the feature scaffold -- the
// fixtures under fixtures/subframe-export/ each need their own companion components pre-written, which is a
// separate, unrelated prerequisite already covered by the other tests in this file.
test('#677: ingestPage into a missing feature scaffolds the feature first', () => {
  const dir = makeTempDir('construct-page-transformer-');
  const source = path.join(dir, 'PlainExport.tsx');
  fs.writeFileSync(source, `export function PlainExport() {\n  return (<button onClick={() => {}}>Go</button>);\n}\n`);
  const { pageFile, propsFile } = ingestPage(dir, 'Checkout', 'nope', source);
  assert.equal(fs.existsSync(pageFile), true);
  assert.equal(fs.existsSync(propsFile), true);
  const featureDir = path.join(dir, 'features', 'nope');
  assert.ok(fs.existsSync(path.join(featureDir, 'types.ts')));
  assert.ok(fs.existsSync(path.join(featureDir, 'index.ts')));
  const { violations } = validateArchitecture(dir);
  assert.deepEqual(violations.filter((v) => v.severity === 'error'), []);
});

test('ingestPage: hyphenated / underscored / camel names give identical valid identifiers and file names (#216)', () => {
  const fixture = path.join(REPO_ROOT, 'fixtures', 'subframe-export', 'CheckoutExport.tsx');
  const outputs = [];
  for (const name of ['refund-request', 'refund_request', 'refundRequest']) {
    const dir = tmpProject();
    const { pageFile, propsFile } = ingestPage(dir, name, 'checkout', fixture);
    assert.equal(path.basename(pageFile), 'RefundRequestPage.tsx');
    assert.equal(path.basename(propsFile), 'RefundRequestPageProps.ts');
    const page = fs.readFileSync(pageFile, 'utf8');
    const props = fs.readFileSync(propsFile, 'utf8');
    assert.doesNotThrow(() => parseToAst(page, pageFile));
    assert.doesNotThrow(() => parseToAst(props, propsFile));
    assert.match(page, /export function RefundRequestPage\(/);
    assert.match(props, /export interface RefundRequestPageProps \{/);
    outputs.push(page + props);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.equal(outputs[0], outputs[2]);
});

test('ingestPage: a name that cannot form an identifier is rejected with nothing written (#216)', () => {
  const dir = tmpProject();
  const pagesDir = path.join(dir, 'features', 'checkout', 'pages');
  const before = fs.readdirSync(pagesDir);
  assert.throws(() => ingestPage(dir, '3d-refund', 'checkout', path.join(REPO_ROOT, 'fixtures', 'subframe-export', 'CheckoutExport.tsx')), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.match(err.message, /Page name "3d-refund" can't be turned into a valid TypeScript identifier/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(pagesDir), before);
});

test('ingestPage throws a usage error for a missing source file', () => {
  const dir = tmpProject();
  assert.throws(() => ingestPage(dir, 'Checkout', 'checkout', path.join(dir, 'nope.tsx')), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    return true;
  });
});

// ---- second acceptance criterion: a hand-authored pages/ file that imports
// xstate / a custom hook / a service is still flagged post-ingestion -------

test('a pages/ file that imports xstate is flagged (existing PAGE-006 coverage)', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'features', 'checkout', 'pages', 'Rogue.tsx'),
    `import { createMachine } from 'xstate';\nexport function Rogue(){ createMachine({}); return null; }\n`,
  );
  const { violations } = validateArchitecture(dir);
  assert.ok(violations.some((v) => v.rule === 'PAGE-006' && v.file === 'features/checkout/pages/Rogue.tsx'));
});

test('a pages/ file that imports a custom hook is flagged (PAGE-006, the gap this ticket closed)', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'features', 'checkout', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'features', 'checkout', 'hooks', 'useCart.tsx'), `export function useCart(){ return { items: [] }; }\n`);
  fs.writeFileSync(
    path.join(dir, 'features', 'checkout', 'pages', 'Rogue.tsx'),
    `import { useCart } from '../hooks/useCart';\nexport function Rogue(){ const { items } = useCart(); return null; }\n`,
  );
  const { violations } = validateArchitecture(dir);
  assert.ok(violations.some((v) => v.rule === 'PAGE-006' && v.file === 'features/checkout/pages/Rogue.tsx'));
});

test('a pages/ file that imports a service is flagged (existing PAGE-003 coverage)', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'features', 'checkout', 'pages', 'Rogue.tsx'),
    `import { fetchTotal } from '../services/TotalService';\nexport function Rogue(){ return null; }\n`,
  );
  const { violations } = validateArchitecture(dir);
  assert.ok(violations.some((v) => v.rule === 'PAGE-003' && v.file === 'features/checkout/pages/Rogue.tsx'));
});

// ---- end-to-end via the real CLI binary ------------------------------------

test('construct create page <name> --feature <f> --from <path> ingests end to end and construct validate passes', () => {
  const dir = tmpProject();
  const res = spawnSync('node', [
    bin, 'create', 'page', 'Checkout', '--feature', 'checkout', '--from', path.join(REPO_ROOT, 'fixtures', 'subframe-export', 'CheckoutExport.tsx'),
  ], { encoding: 'utf8', cwd: dir });

  assert.equal(res.status, EXIT_CODES.OK, res.stderr);
  assert.match(res.stdout, /CheckoutPage\.tsx/);
  assert.match(res.stdout, /CheckoutPageProps\.ts/);
  assert.match(res.stdout, /4 slot\(s\)/);

  const validateRes = spawnSync('node', [bin, 'validate'], { encoding: 'utf8', cwd: dir });
  assert.equal(validateRes.status, EXIT_CODES.OK, validateRes.stdout);
});

// ---- #675: every way a design tool exports the component -------------------

const BODY = `{ return <button onClick={() => {}}>Go</button>; }`;
for (const [label, src] of [
  ['function X then `export default X;` (Subframe)', `function Screen() ${BODY}\nexport default Screen;\n`],
  ['const arrow then `export default X;`', `const Screen = () => <button onClick={() => {}}>Go</button>;\nexport default Screen;\n`],
  ['`export { X as default }`', `function Screen() ${BODY}\nexport { Screen as default };\n`],
  ['`export { X }`', `function Screen() ${BODY}\nexport { Screen };\n`],
  ['`export default memo(X)`', `import { memo } from 'react';\nfunction Screen() ${BODY}\nexport default memo(Screen);\n`],
  ['`export default React.memo(function ...)`', `import React from 'react';\nexport default React.memo(function Screen() ${BODY});\n`],
  ['`export const X = forwardRef(...)`', `import { forwardRef } from 'react';\nexport const Screen = forwardRef(function Screen(props, ref) ${BODY});\n`],
  ['typed `export const X: FC = function ...`', `import type { FC } from 'react';\nexport const Screen: FC = function () ${BODY};\n`],
  ['`export default X as ...`', `function Screen() ${BODY}\nexport default (Screen as unknown as () => null);\n`],
]) {
  test(`#675 transformPristineSource ingests ${label}`, () => {
    const { pageSource, slots } = transformPristineSource(src, { feature: 'f', name: 'Screen' });
    assert.deepEqual(slots, [{ name: 'onClick', kind: 'callback' }]);
    assert.match(pageSource, /<button data-testid="click" onClick=\{onClick\}>Go<\/button>/);
  });
}

test('#675 the refusal names the export it found and why it was not accepted', () => {
  assert.throws(
    () => transformPristineSource(`export default 42;\n`, { feature: 'f', name: 'Screen' }),
    (err) => err.exitCode === EXIT_CODES.USAGE_ERROR && /Found `export default 42;`/.test(err.message),
  );
  assert.throws(
    () => transformPristineSource(`export default Missing;\n`, { feature: 'f', name: 'Screen' }),
    (err) => /Found `export default Missing;`, which does not resolve/.test(err.message),
  );
  assert.throws(() => transformPristineSource(`const x = 1;\n`, { feature: 'f', name: 'Screen' }), /The file has no export\./);
});

// ---- #676: one slot per interaction, not per attribute name -----------------

const MY_CATEGORIES = fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'subframe-export', 'MyCategoriesExport.tsx'), 'utf8');

test('#676 repeated onClick is split into named slots: text, then icon (with its action word)', () => {
  const { slots } = transformPristineSource(MY_CATEGORIES, { feature: 'categories', name: 'MyCategories' });
  assert.deepEqual(slots.map((s) => s.name), ['onHome', 'onSearch', 'onClose', 'onAddCategory', 'onMenu']);
  assert.ok(slots.every((s) => s.event === 'onClick'));
});

test('#676 identical rows become ONE slot taking the row index, each call site passing its own', () => {
  const { slots, pageSource, propsSource } = transformPristineSource(MY_CATEGORIES, { feature: 'categories', name: 'MyCategories' });
  assert.deepEqual(slots.find((s) => s.name === 'onMenu'), { name: 'onMenu', kind: 'callback', event: 'onClick', repeated: true });
  assert.match(propsSource, /onMenu: \(index: number\) => void;/);
  assert.match(propsSource, /onAddCategory: \(\) => void;/);
  for (const i of [0, 1, 2]) assert.match(pageSource, new RegExp(`onClick=\\{\\(\\) => onMenu\\(${i}\\)\\}`));
  assert.match(pageSource, /onClick=\{onAddCategory\}/);
  assert.doesNotMatch(pageSource, /onClick=\{onClick\}/);
});

test('#676 every interactive element gets its own data-testid', () => {
  const { testIds } = transformPristineSource(MY_CATEGORIES, { feature: 'categories', name: 'MyCategories' });
  assert.deepEqual(testIds, ['home', 'search', 'close', 'add-category', 'menu-0', 'menu-1', 'menu-2']);
});

test('#676 naming attributes win over text; value attributes are split too; unnamed ones are numbered', () => {
  const src = `export function F() {
    return (<form>
      <input name="email" value="" onChange={() => {}} />
      <input aria-label="Full name" value="" onChange={() => {}} />
      <button onClick={() => {}}><span /><span /></button>
      <button onClick={() => {}}><span /><span /></button>
    </form>);
  }`;
  const { slots, propsSource } = transformPristineSource(src, { feature: 'f', name: 'F' });
  assert.deepEqual(slots.map((s) => s.name), ['emailValue', 'onEmailChange', 'fullNameValue', 'onFullNameChange', 'onClick1', 'onClick2']);
  assert.match(propsSource, /onEmailChange: \(value: string\) => void;/);
  assert.match(propsSource, /emailValue: string;/);
});

test('#676 a derived name never takes the name of an attribute that kept its own', () => {
  const src = `export function F() {
    return (<form onSubmit={() => {}}>
      <button onClick={() => {}}>Submit</button>
      <button onClick={() => {}}>Cancel</button>
    </form>);
  }`;
  const { slots } = transformPristineSource(src, { feature: 'f', name: 'F' });
  assert.deepEqual(slots.map((s) => s.name), ['onSubmit', 'onSubmit2', 'onCancel']);
});

test('#675/#676 construct create page --from ingests a Subframe-shaped export end to end and validates', () => {
  const dir = tmpProject();
  const components = path.join(dir, 'features', 'checkout', 'components');
  for (const n of ['Button', 'IconButton']) fs.writeFileSync(path.join(components, `${n}.tsx`), `export function ${n}(props: Record<string, unknown>) {\n  return <button>{String(props.children ?? '')}</button>;\n}\n`);
  fs.writeFileSync(path.join(components, 'Icons.tsx'), ['Home', 'MoreVertical', 'Plus', 'Search', 'X'].map((n) => `export function Feather${n}() {\n  return <svg />;\n}\n`).join(''));
  const res = spawnSync('node', [bin, 'create', 'page', 'MyCategories', '--feature', 'checkout', '--from', path.join(REPO_ROOT, 'fixtures', 'subframe-export', 'MyCategoriesExport.tsx')], { encoding: 'utf8', cwd: dir });
  assert.equal(res.status, EXIT_CODES.OK, res.stderr);
  assert.match(res.stdout, /5 slot\(s\): onHome, onSearch, onClose, onAddCategory, onMenu/);
});
