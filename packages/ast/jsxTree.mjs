// AST package: the JSX element tree with stable node ids (#173).
//
// `parseJsxTree(source)` assigns ids `n0`, `n1`, ... in source (document) order; an id is only valid for
// the exact source text it was computed from. Every record carries the element's `[start, end)` offsets
// in `source`, its 1-based `line` and `column`, its props (see `jsxAttributes`), its element children and
// its text/expression content (#697 -- additive; see `parseJsxTree`'s doc for the `content` shape).
import { walkAst } from './walk.mjs';
import { parseJsx } from './jsxParse.mjs';

/**
 * `Foo`, `ui.Item` or `ns:tag` for a JSX name node (`'?'` for anything else).
 *
 * @param {object} nameNode A JSX name node.
 * @returns {string} The name as written; `'?'` for an unknown node type.
 */
export function jsxNameToString(nameNode) {
  if (nameNode.type === 'JSXIdentifier') return nameNode.name;
  if (nameNode.type === 'JSXMemberExpression') return `${jsxNameToString(nameNode.object)}.${jsxNameToString(nameNode.property)}`;
  if (nameNode.type === 'JSXNamespacedName') return `${nameNode.namespace.name}:${nameNode.name.name}`;
  return '?';
}

/**
 * An opening tag's attributes as `{kind, name, value, index}` records (`index` = 0-based position in the
 * attribute list; a spread has `name: null`). kinds: 'string' | 'number' | 'boolean' | 'identifier' |
 * 'expression' (value = raw source text) | 'spread' (value = the spread argument's source text).
 *
 * @param {object} openingElement A JSX opening element node.
 * @param {string} source The full source text (for expression values).
 * @returns {{kind:string, name:string|null, value:any, index:number}[]} One record per attribute, in order.
 */
export function jsxAttributes(openingElement, source) {
  return openingElement.attributes.map((attr, index) => {
    if (attr.type === 'JSXSpreadAttribute') {
      return { kind: 'spread', name: null, value: source.slice(attr.argument.range[0], attr.argument.range[1]), index };
    }
    const name = jsxNameToString(attr.name);
    if (attr.value == null) return { kind: 'boolean', name, value: true, index };
    if (attr.value.type === 'Literal') return { kind: 'string', name, value: attr.value.value, index };
    if (attr.value.type === 'JSXExpressionContainer') {
      const expr = attr.value.expression;
      if (expr.type === 'Literal' && !expr.regex && !expr.bigint) {
        if (typeof expr.value === 'string') return { kind: 'string', name, value: expr.value, index };
        if (typeof expr.value === 'number') return { kind: 'number', name, value: expr.value, index };
        if (typeof expr.value === 'boolean') return { kind: 'boolean', name, value: expr.value, index };
      }
      if (expr.type === 'Identifier') return { kind: 'identifier', name, value: expr.name, index };
      return { kind: 'expression', name, value: source.slice(expr.range[0], expr.range[1]), index };
    }
    return { kind: 'expression', name, value: source.slice(attr.value.range[0], attr.value.range[1]), index };
  });
}

/**
 * An element/fragment node's immediate text and `{expression}` children, in source order (#697). See
 * `parseJsxTree`'s doc for the exact shape and the whitespace-only-text and empty-expression rules.
 *
 * @param {object} node A JSXElement or JSXFragment node (raw estree, as found by `parseJsxTree`).
 * @param {string} source The full source text.
 * @returns {{kind:'text'|'expression', value:string, start:number, end:number}[]} Content records in source order.
 */
function jsxContent(node, source) {
  /** @type {{kind:'text'|'expression', value:string, start:number, end:number}[]} */
  const content = [];
  for (const child of node.children ?? []) {
    if (child.type === 'JSXText') {
      if (child.value.trim() === '') continue; // whitespace-only: skipped, see parseJsxTree's doc
      content.push({ kind: 'text', value: child.value, start: child.range[0], end: child.range[1] });
    } else if (child.type === 'JSXExpressionContainer') {
      const expr = child.expression;
      if (expr.type === 'JSXEmptyExpression') continue; // `{/* comment */}`: no value
      content.push({ kind: 'expression', value: source.slice(expr.range[0], expr.range[1]), start: expr.range[0], end: expr.range[1] });
    }
  }
  return content;
}

/**
 * Parse `source` into `{ roots, byId, ast }`. Each record is
 * `{id, tag, isFragment, isCustomComponent, props, start, end, line, column, children, content, openingElementNode}`
 * (`openingElementNode` is the raw estree opening element, `null` for a fragment -- internal, for
 * offset-exact attribute edits). Nesting is derived from source ranges, so elements found anywhere in a
 * parent's subtree (inside `{cond && <X/>}` or `.map(...)` callbacks) nest correctly. Throws on a syntax error.
 *
 * `content` (#697) lists the element's immediate text and `{expression}` children, in source order:
 * `{kind, value, start, end}[]` where `kind` is `'text'` or `'expression'`. For `'text'`, `value` is the
 * JSXText node's raw text and `[start, end)` its exact span, so `source.slice(start, end) === value`
 * always holds. For `'expression'`, `value` is the JS expression's own source text and `[start, end)` its
 * own span -- excluding the surrounding `{`/`}` of the `JSXExpressionContainer` (same convention as an
 * `'expression'`-kind prop in `jsxAttributes`) -- so `source.slice(start, end) === value` holds there too.
 * An empty `{/* comment only *\/}` container (`JSXEmptyExpression`) is skipped: it has no value. A
 * **whitespace-only text node is skipped** (not listed in `content` at all) -- most are indentation
 * between elements, not visible content, and a consumer collecting "every piece of visible text" (#697)
 * wants signal, not that noise; nothing here flags it, so don't rely on `content` to reconstruct the
 * original whitespace-exact source. `content` only lists this element's own direct text/expression
 * children, the same way `children` only lists its own direct element children.
 *
 * @param {string} source JSX or TSX module text.
 * @returns {{roots:object[], byId:Map<string, object>, ast:object}} The element tree.
 * @throws {Error} On a syntax error.
 * @since 0.8
 *
 * @example
 * const { roots, byId } = parseJsxTree('export const A = () => <div><b /></div>;');
 * roots[0].tag; // => 'div'
 *
 * @example
 * const { roots } = parseJsxTree('const A = () => <p>Hi {user.name}!</p>;');
 * roots[0].content; // => [{kind:'text', value:'Hi ', start:..., end:...}, {kind:'expression', value:'user.name', start:..., end:...}, {kind:'text', value:'!', start:..., end:...}]
 */
export function parseJsxTree(source) {
  const ast = parseJsx(source);
  const found = [];
  walkAst(ast, {
    enter(node) {
      if (node.type === 'JSXElement' || node.type === 'JSXFragment') found.push(node);
    },
  });
  found.sort((a, b) => a.range[0] - b.range[0]); // document order, whatever key order the walker used

  let counter = 0;
  const byId = new Map();
  const roots = [];
  const stack = [];
  for (const node of found) {
    const isFragment = node.type === 'JSXFragment';
    const openingElement = isFragment ? null : node.openingElement;
    const tag = isFragment ? 'Fragment' : jsxNameToString(openingElement.name);
    const record = {
      id: `n${counter++}`,
      tag,
      isFragment,
      isCustomComponent: !isFragment && /^[A-Z]/.test(tag.split('.')[0]),
      props: isFragment ? [] : jsxAttributes(openingElement, source),
      start: node.range[0],
      end: node.range[1],
      line: node.loc?.start.line ?? null,
      column: node.loc ? node.loc.start.column + 1 : null,
      children: [],
      content: jsxContent(node, source),
      openingElementNode: openingElement,
    };
    byId.set(record.id, record);
    while (stack.length && stack[stack.length - 1].end <= record.start) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(record);
    else roots.push(record);
    stack.push(record);
  }
  return { roots, byId, ast };
}

/**
 * The direct parent record of `nodeId` in a parsed tree's `byId`, or `null` for a root.
 *
 * @param {Map<string, object>} byId The `byId` map from `parseJsxTree`.
 * @param {string} nodeId The child's id.
 * @returns {object|null} The parent record, or `null` for a root.
 */
export function findParentRecord(byId, nodeId) {
  for (const candidate of byId.values()) {
    if (candidate.children.some((c) => c.id === nodeId)) return candidate;
  }
  return null;
}
