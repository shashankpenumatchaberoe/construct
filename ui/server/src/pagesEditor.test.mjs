import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  listFeatures,
  listPages,
  resolvePageFile,
  serializeTree,
  getNodeSnippet,
  patchNode,
  assertContentHash,
  getNodeProps,
  buildAttributeSnippet,
  findUnmappedProps,
  getScopeLinks,
  resolveDeclaredPropNames,
  parsePageTree,
  applyAutoMap,
  checkEnforcement,
  hashOf,
  PagesEditorError,
  parseSnippetToTree,
  removeAttributeSnippet,
  rewireWireInSnippet,
  removeNodeInSnippet,
  moveNodeInSnippet,
  addChildInSnippet,
} from './pagesEditor.mjs';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';

const SOURCE = `import React from 'react';
import { Card } from '../components/Card.jsx';

export function Home({ title, count }) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="home">
      <h1>{title}</h1>
      <Card>
        <p>Count: {count}</p>
        <button onClick={() => setOpen(!open)}>Toggle</button>
      </Card>
    </div>
  );
}
`;

function makeFixture() {
  const root = makeTempDir('construct-pages-editor-');
  fs.writeFileSync(path.join(root, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nfeatures:\n  root: features\n');
  fs.mkdirSync(path.join(root, 'features/demo/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'features/demo/components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'features/demo/pages/Home.jsx'), SOURCE);
  fs.writeFileSync(
    path.join(root, 'features/demo/components/Card.jsx'),
    'export function Card({ children }) {\n  return <div className="card">{children}</div>;\n}\n',
  );
  return root;
}

// #529 -- a real page importing a real Provider hook file (same shape #528's own
// test/scopeLinks.test.mjs fixtures use: provider.ts's documented
// `defineProvider<Props, Value>(...)` + `export const use<Name>Provider = XProvider.useProvider`).
const CART_PROVIDER_HOOK = `interface CartProviderProps { total: number }
interface CartValue { total: number; label: string }
const CartProvider = defineProvider<CartProviderProps, CartValue>('Cart', ({ total }) => ({ total, label: 'x' }));
export const useCartProvider = CartProvider.useProvider;
`;

const CARD_WITH_AMOUNT = `export function Card({ title, amount, label }: { title: string; amount: number; label: string }) { return null; }
`;

const PAGE_WITH_PROVIDER = `import { Card } from '../components/Card';
import { useCartProvider } from '../hooks/useCartProvider';

export default function CartPage({ title }: { title: string }) {
  return (
    <div>
      <Card title={title} amount={total} label={label} />
    </div>
  );
}
`;

function makeProviderFixture() {
  const root = makeTempDir('construct-pages-editor-provider-');
  fs.writeFileSync(path.join(root, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nfeatures:\n  root: features\n');
  fs.mkdirSync(path.join(root, 'features/cart/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'features/cart/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'features/cart/hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'features/cart/pages/CartPage.tsx'), PAGE_WITH_PROVIDER);
  fs.writeFileSync(path.join(root, 'features/cart/components/Card.tsx'), CARD_WITH_AMOUNT);
  fs.writeFileSync(path.join(root, 'features/cart/hooks/useCartProvider.ts'), CART_PROVIDER_HOOK);
  return root;
}

test('listFeatures / listPages find the fixture feature and page', () => {
  const root = makeFixture();
  assert.deepEqual(listFeatures(root), ['demo']);
  assert.deepEqual(listPages(root, 'demo'), ['Home.jsx']);
});

test('#365: resolvePageFile refuses a symlinked page whose real path is outside the project (e.g. from a cloned repo)', () => {
  const root = makeFixture();
  const outside = makeTempDir('construct-pages-outside-');
  fs.writeFileSync(path.join(outside, 'secret.jsx'), 'export const secret = <p>SECRET</p>;\n');
  fs.symlinkSync(path.join(outside, 'secret.jsx'), path.join(root, 'features', 'demo', 'pages', 'Evil.jsx'));
  assert.throws(() => resolvePageFile(root, 'demo', 'Evil.jsx'), (e) => e instanceof PagesEditorError && /outside the project/.test(e.message));
  // A symlink that stays inside the project is still fine.
  fs.symlinkSync(path.join(root, 'features', 'demo', 'pages', 'Home.jsx'), path.join(root, 'features', 'demo', 'pages', 'Alias.jsx'));
  assert.equal(resolvePageFile(root, 'demo', 'Alias.jsx').relPath.endsWith('Alias.jsx'), true);
});

test('resolvePageFile rejects path traversal out of pages/', () => {
  const root = makeFixture();
  const { relPath } = resolvePageFile(root, 'demo', 'Home.jsx');
  assert.equal(relPath, 'features/demo/pages/Home.jsx');
  assert.throws(() => resolvePageFile(root, 'demo', '../../../etc/passwd'), PagesEditorError);
  assert.throws(() => resolvePageFile(root, 'demo', '../components/Card.jsx'), PagesEditorError);
  assert.throws(() => resolvePageFile(root, '../escape', 'Home.jsx'), PagesEditorError);
});

test('serializeTree produces the expected element hierarchy (#50)', () => {
  const { roots, contentHash } = serializeTree(SOURCE);
  assert.equal(contentHash, hashOf(SOURCE));
  assert.equal(roots.length, 1);
  const div = roots[0];
  assert.equal(div.tag, 'div');
  assert.equal(div.isCustomComponent, false);
  // div > h1, Card (p/button are inside Card, nested one level deeper)
  assert.equal(div.children.length, 2);
  const [h1, card] = div.children;
  assert.equal(h1.tag, 'h1');
  assert.equal(card.tag, 'Card');
  assert.equal(card.isCustomComponent, true);
  assert.equal(card.children.map((c) => c.tag).join(','), 'p,button');
});

test('getNodeSnippet returns exactly one node\'s JSX, not the whole file (#52)', () => {
  const { roots } = serializeTree(SOURCE);
  const cardId = roots[0].children[1].id;
  const { snippet } = getNodeSnippet(SOURCE, cardId);
  assert.ok(snippet.startsWith('<Card>'));
  assert.ok(snippet.trim().endsWith('</Card>'));
  assert.ok(!snippet.includes('import React'));
});

test('patchNode splices only the target node, leaving the rest of the file untouched (#52)', () => {
  const { roots, contentHash } = serializeTree(SOURCE);
  const h1Id = roots[0].children[0].id;
  const patched = patchNode(SOURCE, h1Id, '<h1>{title}!!!</h1>', contentHash);
  assert.ok(patched.includes('<h1>{title} !!!'.replace(' !!!', '!!!'))); // sanity: new text present
  assert.ok(patched.includes("import { Card } from '../components/Card.jsx';")); // untouched
  assert.equal(patched.split('\n').length, SOURCE.split('\n').length); // same line count, single-line edit
});

test('patchNode rejects a stale contentHash (optimistic concurrency)', () => {
  const { roots } = serializeTree(SOURCE);
  const h1Id = roots[0].children[0].id;
  assert.throws(
    () => patchNode(SOURCE, h1Id, '<h1>x</h1>', 'not-the-real-hash'),
    (e) => e instanceof PagesEditorError && e.status === 409 && e.code === 'CHANGED_ON_DISK',
  );
});

// #590 -- patchNode's own hash guard is mandatory, not "checked if present": a client that omits
// contentHash entirely must never silently win the write. Missing/blank/non-string is a distinct 400
// HASH_REQUIRED (a client bug) from a present-but-wrong hash's 409 CHANGED_ON_DISK (someone else's
// edit landed first) -- never a write in either case.
test('patchNode requires contentHash -- omitted, empty or non-string is 400 HASH_REQUIRED, never a write', () => {
  const { roots } = serializeTree(SOURCE);
  const h1Id = roots[0].children[0].id;
  const isRequired = (e) => e instanceof PagesEditorError && e.status === 400 && e.code === 'HASH_REQUIRED';
  assert.throws(() => patchNode(SOURCE, h1Id, '<h1>x</h1>'), isRequired, 'omitted');
  assert.throws(() => patchNode(SOURCE, h1Id, '<h1>x</h1>', undefined), isRequired, 'undefined');
  assert.throws(() => patchNode(SOURCE, h1Id, '<h1>x</h1>', null), isRequired, 'null');
  assert.throws(() => patchNode(SOURCE, h1Id, '<h1>x</h1>', ''), isRequired, 'empty string');
  assert.throws(() => patchNode(SOURCE, h1Id, '<h1>x</h1>', 42), isRequired, 'non-string');
});

test('patchNode saves on a matching contentHash, same as before (#590 unchanged on match)', () => {
  const { roots, contentHash } = serializeTree(SOURCE);
  const h1Id = roots[0].children[0].id;
  const patched = patchNode(SOURCE, h1Id, '<h1>x</h1>', contentHash);
  assert.ok(patched.includes('<h1>x</h1>'));
});

// #590's one shared guard, exercised directly: missing -> 400 HASH_REQUIRED, mismatch -> 409
// CHANGED_ON_DISK, match -> no throw. Every disk-writing Pages editor route calls this.
test('assertContentHash: missing is 400 HASH_REQUIRED, mismatch is 409 CHANGED_ON_DISK, match passes', () => {
  assert.throws(() => assertContentHash(SOURCE, undefined), (e) => e.status === 400 && e.code === 'HASH_REQUIRED');
  assert.throws(() => assertContentHash(SOURCE, ''), (e) => e.status === 400 && e.code === 'HASH_REQUIRED');
  assert.throws(() => assertContentHash(SOURCE, 'deadbeef'), (e) => e.status === 409 && e.code === 'CHANGED_ON_DISK');
  assert.doesNotThrow(() => assertContentHash(SOURCE, hashOf(SOURCE)));
});

test('patchNode rejects a replacement that is not valid JSX', () => {
  const { roots, contentHash } = serializeTree(SOURCE);
  const h1Id = roots[0].children[0].id;
  assert.throws(() => patchNode(SOURCE, h1Id, 'this is not jsx {{{', contentHash), PagesEditorError);
});

test('getNodeProps + buildAttributeSnippet + patchNode round-trip a prop edit (#53)', () => {
  const { roots, contentHash } = serializeTree(SOURCE);
  const buttonId = roots[0].children[1].children[1].id; // Card > button
  const props = getNodeProps(SOURCE, buttonId);
  assert.equal(props.props[0].name, 'onClick');
  assert.ok(props.scopeNames.includes('title'));
  assert.ok(props.scopeNames.includes('count'));
  assert.ok(props.scopeNames.includes('open'));

  const snippet = buildAttributeSnippet(SOURCE, buttonId, 'disabled', 'boolean', true);
  const patched = patchNode(SOURCE, buttonId, snippet, contentHash);
  // New attributes are appended at the end of the tag's attribute list.
  assert.match(patched, /<button onClick=\{[^}]*\} disabled>/);
});

test('getNodeProps includes an index on every prop, and a spread prop has name:null (#77 follow-up to #53)', () => {
  const source = `function Row({ rest }) {\n  return <li className="row" {...rest} data-x="1" />;\n}\n`;
  const { roots } = serializeTree(source);
  const liId = roots[0].id;
  const { props } = getNodeProps(source, liId);
  assert.deepEqual(
    props.map((p) => [p.kind, p.name, p.index]),
    [
      ['string', 'className', 0],
      ['spread', null, 1],
      ['string', 'data-x', 2],
    ],
  );
});

test('buildAttributeSnippet edits an existing spread prop by index, leaving its name-having siblings untouched (#77 follow-up to #53)', () => {
  const source = `function Row({ rest, other }) {\n  return <li className="row" {...rest} data-x="1" />;\n}\n`;
  const { roots, contentHash } = serializeTree(source);
  const liId = roots[0].id;
  const { props } = getNodeProps(source, liId);
  const spread = props.find((p) => p.kind === 'spread');
  assert.equal(spread.value, 'rest');

  const snippet = buildAttributeSnippet(source, liId, null, 'spread', 'other', spread.index);
  const patched = patchNode(source, liId, snippet, contentHash);
  assert.match(patched, /<li className="row" \{\.\.\.other\} data-x="1" \/>/);
});

test('buildAttributeSnippet rejects a spread edit whose index no longer points at a spread attribute (#77 follow-up to #53)', () => {
  const source = `function Row({ rest }) {\n  return <li className="row" {...rest} />;\n}\n`;
  assert.throws(() => buildAttributeSnippet(source, 'n0', null, 'spread', 'other', 0), PagesEditorError); // index 0 is className, not the spread
});

test('findUnmappedProps flags parent scope names not passed to a child component (#54)', () => {
  const { roots } = serializeTree(SOURCE);
  const cardId = roots[0].children[1].id;
  const { candidates } = findUnmappedProps(SOURCE, cardId);
  // Includes both the useState value and its setter — a setter is a
  // perfectly normal thing to drill down as a callback prop too (e.g.
  // `onToggle={setOpen}`); see #54's decision-point comment on the issue.
  assert.deepEqual([...candidates].sort(), ['count', 'open', 'setOpen', 'title']);
});

test('getScopeLinks resolves the child file across the import and reports links/unbound props (#223)', () => {
  const root = makeFixture();
  const { absPath } = resolvePageFile(root, 'demo', 'Home.jsx');
  const { roots } = serializeTree(SOURCE);
  const cardId = roots[0].children[1].id;
  const g = getScopeLinks(SOURCE, cardId, root, absPath);
  // Card declares only `children`, so it is a closed set with nothing bound.
  assert.equal(g.childPropsResolved, true);
  assert.deepEqual(g.childProps, [{ name: 'children', status: 'unbound' }]);
  assert.deepEqual(g.scope.map((d) => d.name), ['title', 'count', 'open', 'setOpen']);
  assert.throws(() => getScopeLinks(SOURCE, 'n999', root, absPath), PagesEditorError);
});

test('getScopeLinks resolves a real, reachable Provider hook import and passes its fields as \'provider\' scope (#529)', () => {
  const root = makeProviderFixture();
  const { absPath } = resolvePageFile(root, 'cart', 'CartPage.tsx');
  const { roots } = serializeTree(PAGE_WITH_PROVIDER);
  const cardId = roots[0].children[0].id; // <div><Card .../></div>
  const g = getScopeLinks(PAGE_WITH_PROVIDER, cardId, root, absPath);
  assert.deepEqual(g.scope, [
    { name: 'title', kind: 'prop' },
    { name: 'total', kind: 'provider' },
    { name: 'label', kind: 'provider' },
  ]);
  assert.deepEqual(g.links, [
    { prop: 'title', valueKind: 'identifier', text: 'title', from: [{ name: 'title', kind: 'prop' }] },
    { prop: 'amount', valueKind: 'identifier', text: 'total', from: [{ name: 'total', kind: 'provider' }] },
    { prop: 'label', valueKind: 'identifier', text: 'label', from: [{ name: 'label', kind: 'provider' }] },
  ]);
});

test('findUnmappedProps without root/pageAbsPath keeps the old permissive (unfiltered) behavior', () => {
  // No cross-file context passed — same call shape existing callers used
  // before #77's cross-file resolution existed.
  const { roots } = serializeTree(SOURCE);
  const cardId = roots[0].children[1].id;
  const { candidates, childPropsResolved } = findUnmappedProps(SOURCE, cardId);
  assert.deepEqual([...candidates].sort(), ['count', 'open', 'setOpen', 'title']);
  assert.equal(childPropsResolved, false);
});

test('findUnmappedProps filters candidates to the child\'s actually-declared props when resolvable across files (#77 follow-up to #54)', () => {
  const root = makeFixture();
  const pageAbsPath = path.join(root, 'features/demo/pages/Home.jsx');
  // Card only destructures `{ children }` — none of the page's in-scope
  // names (title/count/open/setOpen) are props Card can actually accept,
  // so cross-file resolution should filter them all out (this is exactly
  // the false-positive #77/#54 describes: setOpen offered for a child that
  // can't use it).
  const { roots } = serializeTree(SOURCE);
  const cardId = roots[0].children[1].id;
  const { candidates, childPropsResolved } = findUnmappedProps(SOURCE, cardId, root, pageAbsPath);
  assert.deepEqual(candidates, []);
  assert.equal(childPropsResolved, true);
});

test('findUnmappedProps partial-overlap: only candidates the child declares survive (#77)', () => {
  const root = makeFixture();
  const source = SOURCE.replace(
    "import { Card } from '../components/Card.jsx';",
    "import { Card } from '../components/Card.jsx';\nimport { Profile } from '../components/Profile.jsx';",
  ).replace('<Card>', '<Profile></Profile>\n      <Card>');
  fs.writeFileSync(path.join(root, 'features/demo/pages/Home.jsx'), source);
  fs.writeFileSync(
    path.join(root, 'features/demo/components/Profile.jsx'),
    'export function Profile({ title, count }) {\n  return <div>{title}: {count}</div>;\n}\n',
  );
  const { roots } = serializeTree(source);
  const profileId = roots[0].children[1].id; // h1, Profile, Card
  const pageAbsPath = path.join(root, 'features/demo/pages/Home.jsx');
  const { candidates, childPropsResolved } = findUnmappedProps(source, profileId, root, pageAbsPath);
  // Profile declares title+count (both in scope) but not open/setOpen —
  // those must be filtered out even though they're valid page-scope names.
  assert.deepEqual([...candidates].sort(), ['count', 'title']);
  assert.equal(childPropsResolved, true);
});

test('findUnmappedProps falls back to permissive when the child import can\'t be resolved (#77)', () => {
  const root = makeFixture();
  const source = SOURCE.replace(
    "import { Card } from '../components/Card.jsx';",
    "import { Card } from '../components/Card.jsx';\nimport { External } from 'some-npm-package';",
  ).replace('<Card>', '<External></External>\n      <Card>');
  fs.writeFileSync(path.join(root, 'features/demo/pages/Home.jsx'), source);
  const { roots } = serializeTree(source);
  const externalId = roots[0].children[1].id;
  const pageAbsPath = path.join(root, 'features/demo/pages/Home.jsx');
  const { candidates, childPropsResolved } = findUnmappedProps(source, externalId, root, pageAbsPath);
  // Bare/package specifier — not cross-file resolved, so every in-scope
  // name not already passed is still offered (today's behavior).
  assert.deepEqual([...candidates].sort(), ['count', 'open', 'setOpen', 'title']);
  assert.equal(childPropsResolved, false);
});

test('resolveDeclaredPropNames resolves a typed, non-destructured props param via its interface (#77 bonus case)', () => {
  const root = makeFixture();
  fs.mkdirSync(path.join(root, 'features/demo/components2'), { recursive: true });
  const pageSource = `import { Labeled } from '../components2/Labeled.tsx';\nexport function Page() { return <Labeled />; }\n`;
  const pageAbsPath = path.join(root, 'features/demo/pages/Page2.tsx');
  fs.writeFileSync(pageAbsPath, pageSource);
  fs.writeFileSync(
    path.join(root, 'features/demo/components2/Labeled.tsx'),
    'interface LabeledProps {\n  title: string;\n  count: number;\n}\nexport function Labeled(props: LabeledProps) {\n  return <div>{props.title}</div>;\n}\n',
  );
  const { ast } = parsePageTree(pageSource);
  const declared = resolveDeclaredPropNames(root, pageAbsPath, ast, 'Labeled');
  assert.ok(declared);
  assert.equal(declared.closed, true);
  assert.deepEqual([...declared.names].sort(), ['count', 'title']);
});

test('applyAutoMap wires the chosen props onto the child as shorthand attributes (#54)', () => {
  const { roots } = serializeTree(SOURCE);
  const cardId = roots[0].children[1].id;
  const patched = applyAutoMap(SOURCE, cardId, ['title', 'count']);
  // Each new attribute is inserted at the end of the tag's attribute list
  // (not re-derived positionally each time), so requesting title then
  // count lands them in that same requested order.
  assert.match(patched, /<Card title=\{title\} count=\{count\}>/);
  assert.ok(patched.includes("import { Card } from '../components/Card.jsx';"));
});

test('checkEnforcement flags a PAGE-004 violation (fetch()) and leaves the file untouched on rejection (#56)', () => {
  const root = makeFixture();
  const relPath = 'features/demo/pages/Home.jsx';
  const badSource = SOURCE.replace('const [open, setOpen] = React.useState(false);', 'fetch("/api/x");');
  const result = checkEnforcement(root, relPath, badSource);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((v) => v.rule === 'PAGE-004'));
  // the temp write/revert inside checkEnforcement must leave the real file exactly as it was
  assert.equal(fs.readFileSync(path.join(root, relPath), 'utf8'), SOURCE);
});

test('checkEnforcement allows a clean structural/prop edit through (#56)', () => {
  const root = makeFixture();
  const relPath = 'features/demo/pages/Home.jsx';
  const okSource = SOURCE.replace('<h1>{title}</h1>', '<h1>{title} (v2)</h1>');
  const result = checkEnforcement(root, relPath, okSource);
  assert.equal(result.ok, true);
});

// Ticket F.1 (#120, epic #119) — parseSnippetToTree feeds the visual
// composer's live graph. It must handle a bare snippet (no surrounding
// file), not just a whole page.
test('parseSnippetToTree parses a bare snippet (no surrounding file) into the same node tree shape (#120)', () => {
  const { roots, error } = parseSnippetToTree('<Card>\n  <p>Count: {count}</p>\n</Card>');
  assert.equal(error, null);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].tag, 'Card');
  assert.equal(roots[0].children[0].tag, 'p');
});

test('parseSnippetToTree reports a parse error without throwing, for a snippet mid-edit (#120)', () => {
  const { roots, error } = parseSnippetToTree('<Card>\n  <p>unclosed');
  assert.deepEqual(roots, []);
  assert.ok(typeof error === 'string' && error.length > 0);
});

test('parseSnippetToTree returns an empty, error-free tree for empty/whitespace input (#120)', () => {
  assert.deepEqual(parseSnippetToTree(''), { roots: [], error: null });
  assert.deepEqual(parseSnippetToTree('   \n  '), { roots: [], error: null });
});

// Ticket F.2 (#121, epic #119) — removeAttributeSnippet + rewireWireInSnippet
// back the visual composer's wire-rewrite (drag a connection's child-side
// endpoint onto a different sibling).
const WIRE_SNIPPET = '<main>\n  <Card title={title} />\n  <Aside />\n</main>';

test('removeAttributeSnippet deletes a named attribute and the whitespace before it (#121)', () => {
  const { byId } = parsePageTree(WIRE_SNIPPET);
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const replacement = removeAttributeSnippet(WIRE_SNIPPET, cardId, 'title');
  assert.equal(replacement, '<Card />');
});

test('removeAttributeSnippet throws for an attribute that does not exist (#121)', () => {
  const { byId } = parsePageTree(WIRE_SNIPPET);
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  assert.throws(() => removeAttributeSnippet(WIRE_SNIPPET, cardId, 'nope'), PagesEditorError);
});

test('rewireWireInSnippet moves a prop from one child to its sibling (#121)', () => {
  const { byId } = parsePageTree(WIRE_SNIPPET);
  const mainId = [...byId.values()].find((n) => n.tag === 'main').id;
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const asideId = [...byId.values()].find((n) => n.tag === 'Aside').id;

  const result = rewireWireInSnippet(WIRE_SNIPPET, { parentId: mainId, propName: 'title', fromChildId: cardId, toChildId: asideId });
  assert.equal(result.ok, true);
  assert.match(result.snippet, /<Card\s*\/>/);
  // buildAttributeSnippet's setAttributeText preserves the tag's existing space before `/>` when
  // inserting a new attribute into a single-line self-closing tag (#696).
  assert.match(result.snippet, /<Aside title=\{title\} \/>/);

  // The rewired snippet must still parse as a real, valid tree.
  const reparsed = parsePageTree(result.snippet);
  assert.equal(reparsed.roots.length, 1);
});

test('rewireWireInSnippet rejects a target that already has the same prop, and leaves the snippet unchanged (#121)', () => {
  const source = '<main>\n  <Card title={title} />\n  <Aside title={other} />\n</main>';
  const { byId } = parsePageTree(source);
  const mainId = [...byId.values()].find((n) => n.tag === 'main').id;
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const asideId = [...byId.values()].find((n) => n.tag === 'Aside').id;

  const result = rewireWireInSnippet(source, { parentId: mainId, propName: 'title', fromChildId: cardId, toChildId: asideId });
  assert.equal(result.ok, false);
  assert.match(result.error, /already has its own "title" prop/);
});

test('rewireWireInSnippet rejects a target that is not a sibling under the same parent (#121)', () => {
  const source = '<main>\n  <Card title={title} />\n  <section><Aside /></section>\n</main>';
  const { byId } = parsePageTree(source);
  const mainId = [...byId.values()].find((n) => n.tag === 'main').id;
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const asideId = [...byId.values()].find((n) => n.tag === 'Aside').id;

  const result = rewireWireInSnippet(source, { parentId: mainId, propName: 'title', fromChildId: cardId, toChildId: asideId });
  assert.equal(result.ok, false);
  assert.match(result.error, /sibling under the same parent/);
});

test('rewireWireInSnippet rejects stale node ids without throwing (#121)', () => {
  const result = rewireWireInSnippet(WIRE_SNIPPET, { parentId: 'nX', propName: 'title', fromChildId: 'nY', toChildId: 'nZ' });
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

// Ticket F.3 (#122, epic #119) — removeNodeInSnippet/moveNodeInSnippet/
// addChildInSnippet back the visual composer's structural node edits.
const STRUCT_SNIPPET = '<main>\n  <Card />\n  <Aside />\n</main>';

test('removeNodeInSnippet deletes a node and its surrounding blank line (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const result = removeNodeInSnippet(STRUCT_SNIPPET, cardId);
  assert.equal(result.ok, true);
  assert.equal(result.snippet, '<main>\n  <Aside />\n</main>');
});

test('removeNodeInSnippet rejects removing the snippet\'s own root (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const mainId = [...byId.values()].find((n) => n.tag === 'main').id;
  const result = removeNodeInSnippet(STRUCT_SNIPPET, mainId);
  assert.equal(result.ok, false);
  assert.match(result.error, /own root element/);
});

test('moveNodeInSnippet swaps a node with its next sibling ("down") (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const result = moveNodeInSnippet(STRUCT_SNIPPET, cardId, 'down');
  assert.equal(result.ok, true);
  assert.equal(result.snippet, '<main>\n  <Aside />\n  <Card />\n</main>');
});

test('moveNodeInSnippet swaps a node with its previous sibling ("up") (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const asideId = [...byId.values()].find((n) => n.tag === 'Aside').id;
  const result = moveNodeInSnippet(STRUCT_SNIPPET, asideId, 'up');
  assert.equal(result.ok, true);
  assert.equal(result.snippet, '<main>\n  <Aside />\n  <Card />\n</main>');
});

test('moveNodeInSnippet rejects moving past the first/last sibling position (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const asideId = [...byId.values()].find((n) => n.tag === 'Aside').id;
  assert.equal(moveNodeInSnippet(STRUCT_SNIPPET, cardId, 'up').ok, false);
  assert.equal(moveNodeInSnippet(STRUCT_SNIPPET, asideId, 'down').ok, false);
});

test('moveNodeInSnippet rejects moving the snippet\'s own root (no siblings) (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const mainId = [...byId.values()].find((n) => n.tag === 'main').id;
  const result = moveNodeInSnippet(STRUCT_SNIPPET, mainId, 'up');
  assert.equal(result.ok, false);
  assert.match(result.error, /no siblings/);
});

test('addChildInSnippet appends a fixed <div /> before the closing tag (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const mainId = [...byId.values()].find((n) => n.tag === 'main').id;
  const result = addChildInSnippet(STRUCT_SNIPPET, mainId);
  assert.equal(result.ok, true);
  assert.equal(result.snippet, '<main>\n  <Card />\n  <Aside />\n<div /></main>');
  const reparsed = parsePageTree(result.snippet);
  assert.equal(reparsed.roots[0].children.length, 3);
});

test('addChildInSnippet works on a fragment root (#122)', () => {
  const source = '<>\n  <Card />\n</>';
  const { byId } = parsePageTree(source);
  const fragId = [...byId.values()].find((n) => n.isFragment).id;
  const result = addChildInSnippet(source, fragId);
  assert.equal(result.ok, true);
  assert.equal(result.snippet, '<>\n  <Card />\n<div /></>');
});

test('addChildInSnippet rejects a self-closing element (#122)', () => {
  const { byId } = parsePageTree(STRUCT_SNIPPET);
  const cardId = [...byId.values()].find((n) => n.tag === 'Card').id;
  const result = addChildInSnippet(STRUCT_SNIPPET, cardId);
  assert.equal(result.ok, false);
  assert.match(result.error, /self-closing/);
});
