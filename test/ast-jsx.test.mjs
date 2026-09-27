// packages/ast JSX family (#173): parse, tree, attribute/node edits, scope + prop analysis, on typescript-estree.
// (The byte-for-byte parity with the former Babel implementation is proven by
// ui/server/src/pagesEditor.golden.test.mjs; these are the package's own unit tests.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJsx, jsxParseError, checkJsxReplacement, parseJsxTree, jsxAttributes, jsxNameToString, findParentRecord,
  setAttributeText, setSpreadText, removeAttributeText, removeNodeText, swapNodesText, addChildText, renderAttrValue, spliceNode,
  collectComponentScopeNames, findImportOfName, declaredPropNames, findTypeMembers,
} from '../packages/ast/index.mjs';

const PAGE = `import { Card } from './Card';
export function Home({ title, ...rest }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="home" {...rest}>
      <Card title={title} n={1} on flag={false} id={x} expr={a + b} />
      {open && <p>hi</p>}
    </div>
  );
}
`;

test('parseJsxTree numbers nodes in document order and nests via source ranges', () => {
  const { roots, byId } = parseJsxTree(PAGE);
  assert.deepEqual([...byId.keys()], ['n0', 'n1', 'n2']);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].children.map((c) => c.tag), ['Card', 'p']);
  const card = byId.get('n1');
  assert.equal(PAGE.slice(card.start, card.end).startsWith('<Card'), true);
  assert.equal(card.isCustomComponent, true);
  assert.equal(byId.get('n0').line, 5);
  assert.equal(findParentRecord(byId, 'n2').id, 'n0');
  assert.equal(findParentRecord(byId, 'n0'), null);
});

test('parseJsxTree records endLine/endColumn and a text length per node (#701)', () => {
  const src = '<div>\n  <b>hi</b>\n</div>';
  const { byId } = parseJsxTree(src);
  const div = byId.get('n0');
  const b = byId.get('n1');
  assert.equal(div.line, 1);
  assert.equal(div.endLine, 3);
  assert.equal(div.endColumn, 7);
  assert.equal(div.length, div.end - div.start);
  assert.equal(div.length, src.length);
  assert.equal(b.line, 2);
  assert.equal(b.endLine, 2);
  assert.equal(b.length, '<b>hi</b>'.length);
  assert.equal(src.slice(b.start, b.end).length, b.length);
});

test('jsxAttributes classifies every attribute kind', () => {
  const { byId } = parseJsxTree(PAGE);
  const kinds = Object.fromEntries(byId.get('n1').props.map((p) => [p.name, [p.kind, p.value]]));
  assert.deepEqual(kinds, {
    title: ['identifier', 'title'], n: ['number', 1], on: ['boolean', true], flag: ['boolean', false], id: ['identifier', 'x'], expr: ['expression', 'a + b'],
  });
  assert.deepEqual(byId.get('n0').props.map((p) => [p.kind, p.name, p.index]), [['string', 'className', 0], ['spread', null, 1]]);
});

test('parseJsxTree lists plain text as a content record (#697)', () => {
  const src = '<p>hello</p>';
  const { roots } = parseJsxTree(src);
  assert.deepEqual(roots[0].content, [{ kind: 'text', value: 'hello', start: 3, end: 8 }]);
  assert.equal(src.slice(3, 8), 'hello');
  assert.deepEqual(roots[0].children, []); // additive: element children unaffected
});

test('parseJsxTree lists an {expression} child as a content record, excluding the braces (#697)', () => {
  const src = '<p>{user.name}</p>';
  const { roots } = parseJsxTree(src);
  assert.deepEqual(roots[0].content, [{ kind: 'expression', value: 'user.name', start: 4, end: 13 }]);
  assert.equal(src.slice(4, 13), 'user.name');
});

test('parseJsxTree lists mixed text, expression and element children in source order (#697)', () => {
  const src = '<p>Hi {user.name}! <b>bold</b> done.</p>';
  const { roots } = parseJsxTree(src);
  assert.deepEqual(roots[0].content.map((c) => [c.kind, c.value]), [
    ['text', 'Hi '], ['expression', 'user.name'], ['text', '! '], ['text', ' done.'],
  ]);
  // every content value round-trips through its own start/end
  for (const c of roots[0].content) assert.equal(src.slice(c.start, c.end), c.value);
  // the <b> element is still a real element child, unaffected by content
  assert.deepEqual(roots[0].children.map((c) => c.tag), ['b']);
  assert.deepEqual(roots[0].children[0].content, [{ kind: 'text', value: 'bold', start: 22, end: 26 }]);
});

test('parseJsxTree skips whitespace-only text (documented choice) but keeps real text (#697)', () => {
  const src = '<div>\n  <b>x</b>\n  <i>y</i>\n</div>';
  const { roots } = parseJsxTree(src);
  assert.deepEqual(roots[0].content, []); // only whitespace between <b> and <i>: skipped
  assert.deepEqual(roots[0].children.map((c) => c.tag), ['b', 'i']); // element children unaffected

  const single = parseJsxTree('<p> </p>');
  assert.deepEqual(single.roots[0].content, []); // a lone space is whitespace-only too
});

test('parseJsxTree skips an empty {/* comment */} expression container (#697)', () => {
  const { roots } = parseJsxTree('<p>{/* just a comment */}</p>');
  assert.deepEqual(roots[0].content, []);
});

test('jsxNameToString handles identifier, member and namespaced names', () => {
  const { byId } = parseJsxTree('<a><Foo.Bar /><svg:rect /></a>');
  assert.deepEqual([...byId.values()].map((n) => n.tag), ['a', 'Foo.Bar', 'svg:rect']);
  assert.equal(typeof jsxNameToString, 'function');
  assert.equal(typeof jsxAttributes, 'function');
});

test('string attributes decode entities and keep quotes/newlines', () => {
  const { byId } = parseJsxTree('<a t="x &amp; y &quot;z&quot;" u=\'it&apos;s\' />');
  assert.deepEqual(byId.get('n0').props.map((p) => p.value), ['x & y "z"', "it's"]);
});

test('parseJsx is strict about syntax but tolerant of bare > and } in JSX text (offsets preserved)', () => {
  assert.throws(() => parseJsx('<div><span></div>'));
  assert.throws(() => parseJsx('<div a={} />'), /non-empty expression/);
  const src = '<p a="1">1 > 0 } ok <b /></p>';
  const { byId } = parseJsxTree(src);
  assert.equal(src.slice(byId.get('n1').start, byId.get('n1').end), '<b />');
  assert.equal(jsxParseError('<div>'), jsxParseError('<div>'));
  assert.equal(jsxParseError('<div />'), null);
});

test('checkJsxReplacement: single element/fragment only', () => {
  assert.deepEqual(checkJsxReplacement('<a />'), { ok: true });
  assert.deepEqual(checkJsxReplacement('\n <><b /></>\n'), { ok: true });
  assert.equal(checkJsxReplacement('<a /><b />').kind, 'parse');
  assert.equal(checkJsxReplacement('1 + 1').kind, 'shape');
  assert.equal(checkJsxReplacement('').kind, 'parse');
});

test('setAttributeText replaces in place or appends before the closing bracket', () => {
  const src = '<a b="1"   c={2} />';
  const node = parseJsxTree(src).byId.get('n0');
  assert.equal(setAttributeText(src, node, 'b', 'string', 'x"y'), '<a b="x&quot;y"   c={2} />');
  assert.equal(setAttributeText(src, node, 'z', 'boolean', true), '<a b="1"   c={2} z />');
  const open = '<a>t</a>';
  assert.equal(setAttributeText(open, parseJsxTree(open).byId.get('n0'), 'k', 'number', '4'), '<a k={4}>t</a>');
  assert.equal(renderAttrValue('identifier', 'v'), '={v}');
});

// #696: a multi-line tag's new attribute must land on its own line at the sibling indentation, and a
// single-line self-closing tag's existing space before `/>` must survive the insertion.
test('setAttributeText (#696): indents a new attribute like its siblings on a multi-line tag', () => {
  const src = '<a\n  b="1"\n  c={2}\n/>';
  const node = parseJsxTree(src).byId.get('n0');
  assert.equal(setAttributeText(src, node, 'd', 'string', '3'), '<a\n  b="1"\n  c={2}\n  d="3"\n/>');
});

test('setAttributeText (#696): indents with the sibling attributes\' own indentation (tabs)', () => {
  const src = '<a\n\tb="1"\n/>';
  const node = parseJsxTree(src).byId.get('n0');
  assert.equal(setAttributeText(src, node, 'c', 'number', 2), '<a\n\tb="1"\n\tc={2}\n/>');
});

test('setAttributeText (#696): keeps the space before /> on a single-line self-closing tag', () => {
  const src = '<a b="1" />';
  const node = parseJsxTree(src).byId.get('n0');
  assert.equal(setAttributeText(src, node, 'c', 'number', 2), '<a b="1" c={2} />');
  const noAttrs = '<a />';
  assert.equal(setAttributeText(noAttrs, parseJsxTree(noAttrs).byId.get('n0'), 'c', 'number', 2), '<a c={2} />');
});

test('setSpreadText / removeAttributeText', () => {
  const src = '<a {...s} b="1" />';
  const node = parseJsxTree(src).byId.get('n0');
  assert.equal(setSpreadText(src, node, 0, 'other'), '<a {...other} b="1" />');
  assert.equal(setSpreadText(src, node, 1, 'other'), null);
  assert.equal(removeAttributeText(src, node, 'b'), '<a {...s} />');
  assert.equal(removeAttributeText(src, node, 'nope'), null);
});

test('removeNodeText / swapNodesText / addChildText / spliceNode', () => {
  const src = '<ul>\n  <li a="1" />\n  <li b="2" />\n</ul>';
  const { byId } = parseJsxTree(src);
  assert.equal(removeNodeText(src, byId.get('n1')), '<ul>\n  <li b="2" />\n</ul>');
  assert.equal(swapNodesText(src, byId.get('n1'), byId.get('n2')), '<ul>\n  <li b="2" />\n  <li a="1" />\n</ul>');
  assert.deepEqual(addChildText(src, byId.get('n0')), { ok: true, source: '<ul>\n  <li a="1" />\n  <li b="2" />\n<div /></ul>' });
  assert.equal(addChildText(src, byId.get('n1')).reason, 'self-closing');
  assert.equal(spliceNode(src, byId.get('n2'), '<x />'), '<ul>\n  <li a="1" />\n  <x />\n</ul>');
  const frag = '<>a</>';
  assert.equal(addChildText(frag, parseJsxTree(frag).byId.get('n0')).source, '<>a<div /></>');
});

test('collectComponentScopeNames: params + useState bindings, not method params', () => {
  const src = `function A({ a, b: c, ...r }, p) { const [x, setX] = React.useState(0); class K { m(no) {} } const o = { meth(no2) {}, f: (yes) => 1 }; }`;
  assert.deepEqual(collectComponentScopeNames(parseJsx(src)), ['a', 'c', 'r', 'p', 'x', 'setX', 'yes']);
});

test('findImportOfName + declaredPropNames resolve a child component\'s declared props', () => {
  const ast = parseJsx(`import Def, { Named } from './c';\nimport * as Ui from './ui';`);
  assert.deepEqual(findImportOfName(ast, 'Named'), { source: './c', isDefault: false });
  assert.deepEqual(findImportOfName(ast, 'Def'), { source: './c', isDefault: true });
  assert.equal(findImportOfName(ast, 'Missing'), null);

  const names = (src, tag, isDefault = false) => { const r = declaredPropNames(src, tag, isDefault); return r && { closed: r.closed, names: [...r.names] }; };
  assert.deepEqual(names('export function Named({ a, b }) {}', 'Named'), { closed: true, names: ['a', 'b'] });
  assert.deepEqual(names('export default ({ z }) => null', 'X', true), { closed: true, names: ['z'] });
  assert.deepEqual(names('interface P { a: 1; b?: 2 }\nexport const N = (props: P) => null;', 'N'), { closed: true, names: ['a', 'b'] });
  assert.equal(names('export function N(props) {}', 'N'), null);
  assert.equal(names('export function N({ a } {', 'N'), null);
  assert.equal(names('export const other = 1', 'N'), null);
});

test('findTypeMembers: closed interface, type literal, open index signature, missing', () => {
  assert.deepEqual([...findTypeMembers('type T = { a: 1; b: 2 }', 'T').names], ['a', 'b']);
  assert.equal(findTypeMembers('interface I { [k: string]: 1 }', 'I').closed, false);
  assert.equal(findTypeMembers('interface I { a: 1 }', 'Nope'), null);
});

// #534 -- findTypeMembers/declaredPropNames additionally carry each member's own type-annotation
// text (a `types` Map), purely by reading the annotation's source text -- additive: every assertion
// above this point is unchanged and still passes.
test('findTypeMembers: types map carries each member\'s own annotation text', () => {
  const members = findTypeMembers('interface Props { title: string; total: number; onClose: () => void }', 'Props');
  assert.deepEqual([...members.types], [['title', 'string'], ['total', 'number'], ['onClose', '() => void']]);
  assert.deepEqual([...findTypeMembers('interface I { [k: string]: 1 }', 'I').types], []);
});

test('declaredPropNames: types resolve from an inline object-pattern type literal (this codebase\'s own component convention)', () => {
  const r = declaredPropNames('export function Card({ title, total }: { title: string; total: number }) { return null; }', 'Card', false);
  assert.deepEqual([...r.types], [['title', 'string'], ['total', 'number']]);
});

test('declaredPropNames: types resolve from an object pattern annotated with a same-file type reference', () => {
  const src = 'interface CardProps { title: string; total: number }\nexport function Card({ title, total }: CardProps) { return null; }';
  const r = declaredPropNames(src, 'Card', false);
  assert.deepEqual([...r.types], [['title', 'string'], ['total', 'number']]);
});

test('declaredPropNames: a plain, unannotated destructured parameter has names but no types', () => {
  const r = declaredPropNames('export function Card({ title, total }) { return null; }', 'Card', false);
  assert.deepEqual([...r.names], ['title', 'total']);
  assert.deepEqual([...r.types], []);
});

// #675 sweep: a component behind memo/forwardRef (how Subframe writes its components) still has its props read.
test('#675 declaredPropNames reads props through forwardRef / memo / as, named and default', () => {
  const forwardRefSrc = `import React from 'react';
interface ButtonProps { variant?: string; onClick?: () => void }
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function ButtonRoot({ variant, onClick }: ButtonProps, ref) {
  return <button ref={ref} onClick={onClick}>{variant}</button>;
});
export { Button };
`;
  assert.deepEqual([...declaredPropNames(forwardRefSrc, 'Button', false).names].sort(), ['onClick', 'variant']);
  const memoDefault = `import { memo } from 'react';
type P = { title: string };
function Card({ title }: P) { return <h2>{title}</h2>; }
export default memo(Card);
`;
  assert.deepEqual([...declaredPropNames(memoDefault, 'Card', true).names], ['title']);
  const asDefault = `type P = { label: string };
const Tag = ({ label }: P) => <span>{label}</span>;
export default Tag as unknown as (p: P) => JSX.Element;
`;
  assert.deepEqual([...declaredPropNames(asDefault, 'Tag', true).names], ['label']);
});
