import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { viewPage, openReference, openSourceLocation, resolveProjectFile } from './projectNav.mjs';
import { PagesEditorError } from './pagesEditor.mjs';
import { serverLog } from './logBuffer.mjs';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';

const PAGE = `import { PriceCard } from '../components';
import Badge from '../components/Badge';
import * as Kit from '../components/Kit';
import { Tooltip } from 'ui-lib';
import { Login } from '../../auth/components/Login';
import { Evil } from '../components/EvilLink';
import { Stolen } from '../components/stolen-link';
const Banner = cond ? A : B;
export default function HomePage() {
  const L = () => import(pathAtRuntime);
  return <div><PriceCard /><Badge /><Kit.Chip /><Tooltip /><Banner /><Login /><Evil /><Stolen /></div>;
}
`;

function makeProject() {
  const root = makeTempDir('construct-nav-');
  const outside = makeTempDir('construct-nav-outside-');
  fs.writeFileSync(path.join(root, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nproject:\n  framework: nextjs\nfeatures:\n  root: features\n');
  const w = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  w('features/catalog/pages/HomePage.tsx', PAGE);
  w('features/catalog/components/index.ts', "export { PriceCard } from './PriceCard';\n");
  w('features/catalog/components/PriceCard.tsx', "import Badge from './Badge';\nexport function PriceCard() { return <Badge />; }\n");
  w('features/catalog/components/Badge.tsx', 'export default function Badge() { return null; }\nexport function Named() { return null; }\n');
  w('features/catalog/components/Kit.tsx', 'export function Chip() { return null; }\n');
  w('features/auth/components/Login.tsx', 'export function Login() { return null; }\n');
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const SECRET = "top-secret";\n');
  // a symlink inside the project that points OUTSIDE it
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'features/catalog/components/EvilLink.ts'));
  fs.symlinkSync(outside, path.join(root, 'features/catalog/components/stolen-link'));
  fs.writeFileSync(path.join(outside, 'index.ts'), 'export const Stolen = 1;\n');
  // a "package" in node_modules that a relative path could reach
  w('node_modules/pkg/index.js', 'export const P = 1;\n');
  return { root, outside };
}

const refOf = (view, name, kind) => view.references.find((r) => r.name === name && (!kind || r.kind === kind));

test('a page resolves named, default, barrel and namespace references to root-relative paths', () => {
  const { root } = makeProject();
  const view = viewPage(root, 'catalog', 'HomePage.tsx');
  assert.equal(view.path, 'features/catalog/pages/HomePage.tsx');
  assert.equal(refOf(view, 'PriceCard', 'import').target, 'features/catalog/components/PriceCard.tsx'); // through the barrel
  assert.equal(refOf(view, 'PriceCard', 'jsx').target, 'features/catalog/components/PriceCard.tsx');
  assert.equal(refOf(view, 'Badge', 'import').target, 'features/catalog/components/Badge.tsx'); // default
  assert.equal(refOf(view, 'Kit', 'import').target, 'features/catalog/components/Kit.tsx'); // namespace
  assert.equal(refOf(view, 'Kit', 'jsx').target, 'features/catalog/components/Kit.tsx'); // <Kit.Chip />
  for (const r of view.references) if (r.target) assert.ok(!path.isAbsolute(r.target) && !r.target.split('/').includes('..'), r.target);
});

test('relations are labelled by layer, and by feature across features', () => {
  const { root } = makeProject();
  const view = viewPage(root, 'catalog', 'HomePage.tsx');
  assert.equal(refOf(view, 'PriceCard', 'import').relation.label, 'page -> component');
  assert.equal(refOf(view, 'PriceCard', 'import').relation.description, 'a component in the catalog feature');
  const login = refOf(view, 'Login', 'import');
  assert.equal(login.target, 'features/auth/components/Login.tsx');
  assert.equal(login.relation.label, 'catalog -> auth');
  assert.equal(login.relation.crossFeature, true);
});

test('unresolvable references have no target, a plain reason, and are logged at info level', () => {
  const { root } = makeProject();
  const before = serverLog.read().length;
  const view = viewPage(root, 'catalog', 'HomePage.tsx');
  for (const [name, kind, re] of [['Tooltip', 'import', /outside this project/], ['Tooltip', 'jsx', /outside this project/], ['Banner', 'jsx', /not imported/], ['pathAtRuntime', 'dynamic', /computed at run time/]]) {
    const r = refOf(view, name, kind);
    assert.equal(r.target, null, `${name} ${kind}`);
    assert.match(r.reason, re);
    assert.equal(r.relation, undefined);
  }
  const logged = serverLog.read().slice(before).filter((e) => e.source === 'navigation');
  assert.ok(logged.length >= 4);
  assert.ok(logged.every((e) => e.level === 'info'));
  assert.ok(logged.some((e) => /Banner is not a link/.test(e.text)));
});

test('symlinks that leave the project root are unresolved and never read', () => {
  const { root } = makeProject();
  const view = viewPage(root, 'catalog', 'HomePage.tsx');
  assert.equal(refOf(view, 'Evil', 'import').target, null);
  assert.equal(refOf(view, 'Stolen', 'import').target, null);
  assert.ok(!JSON.stringify(view).includes('top-secret'));
  assert.throws(() => openReference(root, 'features/catalog/pages/HomePage.tsx', 'Evil'), PagesEditorError);
});

test('openReference returns the target derived from the import, and its own references', () => {
  const { root } = makeProject();
  const v = openReference(root, 'features/catalog/pages/HomePage.tsx', 'PriceCard');
  assert.equal(v.path, 'features/catalog/components/PriceCard.tsx');
  assert.match(v.source, /export function PriceCard/);
  assert.equal(v.relation.label, 'page -> component');
  assert.equal(refOf(v, 'Badge', 'import').target, 'features/catalog/components/Badge.tsx');
  const next = openReference(root, v.path, 'Badge');
  assert.equal(next.path, 'features/catalog/components/Badge.tsx');
});

test('openReference refuses a reference that does not resolve', () => {
  const { root } = makeProject();
  for (const ref of ['Tooltip', 'Banner', 'NotAThing']) {
    assert.throws(() => openReference(root, 'features/catalog/pages/HomePage.tsx', ref), (e) => e instanceof PagesEditorError && e.status === 404);
  }
});

test('`from` must be a plain relative path inside the project: ../, absolute, symlink escape, node_modules, non-source', () => {
  const { root, outside } = makeProject();
  const secret = path.join(outside, 'secret.ts');
  for (const from of [
    '../secret.ts',
    `../${path.basename(outside)}/secret.ts`,
    'features/catalog/../../../secret.ts',
    secret,
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'features/catalog/components/EvilLink.ts', // symlink out of the root
    'features/catalog/components/stolen-link/index.ts', // through a symlinked directory
    'node_modules/pkg/index.js',
    'architecture.yml',
    '',
    'a\0b.ts',
    42,
    null,
  ]) {
    assert.equal(resolveProjectFile(root, from), null, `resolveProjectFile(${JSON.stringify(from)})`);
    assert.throws(() => openReference(root, from, 'Anything'), PagesEditorError, `openReference from ${JSON.stringify(from)}`);
  }
  assert.ok(resolveProjectFile(root, 'features/catalog/pages/HomePage.tsx'));
});

test('a resolved target is always inside the real project root', () => {
  const { root } = makeProject();
  const realRoot = fs.realpathSync(root);
  const view = viewPage(root, 'catalog', 'HomePage.tsx');
  for (const r of view.references.filter((x) => x.target)) {
    const real = fs.realpathSync(path.join(root, r.target));
    assert.ok(real.startsWith(realRoot + path.sep), r.target);
  }
});

test('a relative import that reaches node_modules is unresolved', () => {
  const { root } = makeProject();
  fs.writeFileSync(path.join(root, 'features/catalog/pages/Other.tsx'), "import { P } from '../../../node_modules/pkg';\nexport const Q = () => <P />;\n");
  const view = viewPage(root, 'catalog', 'Other.tsx');
  assert.equal(refOf(view, 'P', 'import').target, null);
});

test('pages scope: viewPage refuses anything outside pages/', () => {
  const { root } = makeProject();
  assert.throws(() => viewPage(root, 'catalog', '../components/Badge.tsx'), PagesEditorError);
  assert.throws(() => viewPage(root, 'catalog', path.join(os.tmpdir(), 'x.tsx')), PagesEditorError);
});

// #558: the live preview's "Show in source" button already knows the exact file/line/col (from the
// framed app's own error stack), so opening it needs no `from` file or reference name to derive a
// target from -- just the same containment every other nav read here goes through.
test('openSourceLocation opens a bare project file and carries the given position', () => {
  const { root } = makeProject();
  const v = openSourceLocation(root, 'features/catalog/components/Badge.tsx', 3, 7);
  assert.equal(v.path, 'features/catalog/components/Badge.tsx');
  assert.match(v.source, /export default function Badge/);
  assert.equal(v.line, 3);
  assert.equal(v.column, 7);
});

test('openSourceLocation drops a non-positive-integer line/column instead of passing it through', () => {
  const { root } = makeProject();
  for (const [line, column] of [[0, 1], [-1, 1], [1.5, 1], ['12', 1], [undefined, undefined]]) {
    const v = openSourceLocation(root, 'features/catalog/components/Badge.tsx', line, column);
    assert.equal(v.line, null, JSON.stringify([line, column]));
  }
});

test('openSourceLocation refuses the same paths openReference refuses: outside the root, node_modules, symlink escape, non-source', () => {
  const { root, outside } = makeProject();
  for (const file of ['../secret.ts', path.join(outside, 'secret.ts'), 'node_modules/pkg/index.js', 'features/catalog/components/EvilLink.ts', 'architecture.yml', '']) {
    assert.throws(() => openSourceLocation(root, file, 1, 1), PagesEditorError, `openSourceLocation(${JSON.stringify(file)})`);
  }
});
