// AST package: deterministic text edits on JSX nodes located by parseJsxTree (#173).
//
// Every edit is an exact-offset textual splice of the ORIGINAL source (never a whole-file reprint), so
// every byte outside the edited range is preserved. Functions take a node record from `parseJsxTree`
// (`{start, end, isFragment, tag, openingElementNode}`) and the source it was parsed from. Pure: no
// I/O, no validation of the *result* (callers re-parse with `jsxParseError`).
import { jsxNameToString } from './jsxTree.mjs';
import { walkAst } from './walk.mjs';

/**
 * Splice `newText` over `node`'s range.
 *
 * @param {string} source Full source text.
 * @param {{start:number, end:number}} node A record with source offsets.
 * @param {string} newText Replacement text.
 * @returns {string} The source with `newText` in place of the node.
 */
export function spliceNode(source, node, newText) {
  return source.slice(0, node.start) + newText + source.slice(node.end);
}

/**
 * Source text of one attribute value: `` for a bare `true`, else `="..."` / `={...}`.
 *
 * @param {'string'|'number'|'boolean'|'identifier'|'expression'} kind How the value is written.
 * @param {string|number|boolean} value The value (raw expression text for `expression`).
 * @returns {string} The attribute's value text, including the leading `=` (empty for a bare `true`).
 *
 * @example
 * renderAttrValue('string', 'hi'); // => '="hi"'
 */
export function renderAttrValue(kind, value) {
  if (kind === 'boolean' && value === true) return '';
  if (kind === 'boolean') return `={${value ? 'true' : 'false'}}`;
  if (kind === 'string') return `="${String(value).replaceAll('"', '&quot;')}"`;
  if (kind === 'number') return `={${Number(value)}}`;
  if (kind === 'identifier') return `={${value}}`;
  return `={${value}}`; // 'expression' -- value is raw source text of the expression
}

const namedAttribute = (opening, propName) =>
  opening.attributes.find((a) => a.type === 'JSXAttribute' && jsxNameToString(a.name) === propName);

/**
 * The whole node's new text after setting one named attribute: replaced in place if it exists,
 * otherwise appended at the end of the attribute list, right after the last existing attribute (or the
 * tag name, if there are none). The existing whitespace run leading into the closing bracket (`>` /
 * `/>`), which may be a single space or a newline plus indentation, is left untouched -- so a single
 * space before `/>` is preserved, and on a multi-line tag the new attribute is inserted on its own new
 * line, indented like its siblings, ahead of that untouched run (#696).
 *
 * @param {string} source Full source text.
 * @param {object} node An element record from `parseJsxTree`.
 * @param {string} propName Attribute name.
 * @param {'string'|'number'|'boolean'|'identifier'|'expression'} kind How the value is written.
 * @param {string|number|boolean} value The value.
 * @returns {string} The element's new source text.
 */
export function setAttributeText(source, node, propName, kind, value) {
  const opening = node.openingElementNode;
  const rendered = renderAttrValue(kind, value);
  const existing = namedAttribute(opening, propName);
  if (existing) {
    return source.slice(node.start, existing.range[0]) + propName + rendered + source.slice(existing.range[1], node.end);
  }
  const openingEnd = opening.range[1];
  const bracketPos = opening.selfClosing ? openingEnd - 2 : openingEnd - 1;
  const lastAttr = opening.attributes[opening.attributes.length - 1];
  const refEnd = lastAttr ? lastAttr.range[1] : opening.name.range[1];
  if (lastAttr && /\n/.test(source.slice(refEnd, bracketPos))) {
    const lineStart = source.lastIndexOf('\n', lastAttr.range[0]) + 1;
    const indent = source.slice(lineStart, lastAttr.range[0]);
    return source.slice(node.start, refEnd) + `\n${indent}` + propName + rendered + source.slice(refEnd, node.end);
  }
  const needsSpace = !/\s/.test(source.slice(refEnd - 1, refEnd));
  return source.slice(node.start, refEnd) + (needsSpace ? ' ' : '') + propName + rendered + source.slice(refEnd, node.end);
}

/**
 * The whole node's new text after replacing the spread attribute at `index` with `{...value}`, or
 * `null` if there is no spread attribute at that position.
 *
 * @param {string} source Full source text.
 * @param {object} node An element record from `parseJsxTree`.
 * @param {number} index Position of the spread in the attribute list.
 * @param {string} value Source text of the new spread argument.
 * @returns {string|null} The element's new source text, or `null` when there is no spread at `index`.
 */
export function setSpreadText(source, node, index, value) {
  const candidate = typeof index === 'number' ? node.openingElementNode.attributes[index] : undefined;
  if (!candidate || candidate.type !== 'JSXSpreadAttribute') return null;
  return source.slice(node.start, candidate.range[0]) + `{...${value}}` + source.slice(candidate.range[1], node.end);
}

/**
 * The whole node's new text with one named attribute deleted (plus the whitespace run before it), or
 * `null` if the node has no such attribute.
 *
 * @param {string} source Full source text.
 * @param {object} node An element record from `parseJsxTree`.
 * @param {string} propName Attribute to delete.
 * @returns {string|null} The element's new source text, or `null` when the attribute does not exist.
 */
export function removeAttributeText(source, node, propName) {
  const existing = namedAttribute(node.openingElementNode, propName);
  if (!existing) return null;
  let start = existing.range[0];
  while (start > node.start && /\s/.test(source[start - 1])) start--;
  return source.slice(node.start, start) + source.slice(existing.range[1], node.end);
}

/**
 * The full source with `node` (and its subtree) deleted, plus its leading indentation and one trailing newline.
 *
 * @param {string} source Full source text.
 * @param {{start:number, end:number}} node The element to delete.
 * @returns {string} The full source without the element.
 */
export function removeNodeText(source, node) {
  let start = node.start;
  while (start > 0 && /[ \t]/.test(source[start - 1])) start--;
  let end = node.end;
  if (source.slice(end, end + 2) === '\r\n') end += 2;
  else if (source[end] === '\n') end += 1;
  return source.slice(0, start) + source.slice(end);
}

/**
 * The full source with two sibling nodes' texts swapped (`a` must precede `b`); text between them stays put.
 *
 * @param {string} source Full source text.
 * @param {{start:number, end:number}} a The first sibling.
 * @param {{start:number, end:number}} b The second sibling; must come after `a`.
 * @returns {string} The full source with the two elements exchanged.
 */
export function swapNodesText(source, a, b) {
  const between = source.slice(a.end, b.start);
  return source.slice(0, a.start) + source.slice(b.start, b.end) + between + source.slice(a.start, a.end) + source.slice(b.end);
}

/** The deliberately minimal child that `addChildText` appends. */
export const NEW_CHILD_SNIPPET = '<div />';

/**
 * The full source with a new child appended right before `parent`'s closing tag. Returns
 * `{ok: true, source}`, or `{ok: false, reason: 'self-closing' | 'no-position'}` when the element is
 * `<Tag />` (not silently converted to an open/close pair) or the insertion point can't be determined.
 *
 * @param {string} source Full source text.
 * @param {object} parent Element record of the new child's parent.
 * @param {string} [childSnippet] Source of the child (defaults to `NEW_CHILD_SNIPPET`).
 * @returns {{ok:true, source:string}|{ok:false, reason:'self-closing'|'no-position'}} The new full source, or why it could not be added.
 */
export function addChildText(source, parent, childSnippet = NEW_CHILD_SNIPPET) {
  if (!parent.isFragment && parent.openingElementNode.selfClosing) return { ok: false, reason: 'self-closing' };
  const closingLength = parent.isFragment ? 3 /* </> */ : parent.tag.length + 3; /* </Tag> */
  const insertAt = parent.end - closingLength;
  if (insertAt < parent.start) return { ok: false, reason: 'no-position' };
  return { ok: true, source: source.slice(0, insertAt) + childSnippet + source.slice(insertAt) };
}

const ENCLOSING_FUNCTION_TYPES = new Set(['FunctionDeclaration', 'ArrowFunctionExpression', 'FunctionExpression']);

/**
 * #532 (Slice 2 of #518's design) -- insert a new statement as the FIRST statement of the nearest
 * enclosing function BODY (a real `{ ... }` block) around `targetNode`, e.g. adding a Provider hook
 * call (`const cart = useCartProvider();`) to the top of a page component's body -- located relative
 * to a JSX node it already returns (`targetNode`, typically the page's own root element from
 * `parseJsxTree`), rather than by guessing which export "is" the component. Indentation matches the
 * body's existing first statement, or falls back to two spaces for an empty body.
 *
 * @param {string} source Full source text.
 * @param {object} ast The Program AST `targetNode` was found in (`parseJsxTree(source).ast`).
 * @param {{start:number, end:number}} targetNode A node record with source offsets (e.g. a JSX root).
 * @param {string} statementText The new statement's source text (no trailing newline needed).
 * @returns {{ok:true, source:string}|{ok:false, reason:'no-enclosing-function'}} The new full source, or why it could not be added.
 */
export function insertStatementBeforeJsx(source, ast, targetNode, statementText) {
  let enclosing = null;
  const stack = [];
  walkAst(ast, {
    enter(node) {
      const isBlockFn = ENCLOSING_FUNCTION_TYPES.has(node.type) && node.body?.type === 'BlockStatement';
      if (isBlockFn) stack.push(node);
      if (node.range[0] === targetNode.start && node.range[1] === targetNode.end && stack.length) {
        enclosing = stack[stack.length - 1];
      }
    },
    leave(node) {
      const isBlockFn = ENCLOSING_FUNCTION_TYPES.has(node.type) && node.body?.type === 'BlockStatement';
      if (isBlockFn && stack[stack.length - 1] === node) stack.pop();
    },
  });
  if (!enclosing) return { ok: false, reason: 'no-enclosing-function' };

  const block = enclosing.body;
  const bodyStart = block.range[0] + 1; // right after the block's own '{'
  const firstStmt = block.body[0];
  let indent = '  ';
  if (firstStmt) {
    const lineStart = source.lastIndexOf('\n', firstStmt.range[0]) + 1;
    indent = source.slice(lineStart, firstStmt.range[0]);
  }
  return { ok: true, source: source.slice(0, bodyStart) + `\n${indent}${statementText}` + source.slice(bodyStart) };
}
