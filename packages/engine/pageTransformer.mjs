// Ticket 7.2 -- Pristine page transformer (Subframe JSX ingestion).
//
// Ingests an externally-authored JSX/TSX file (simulating a design-tool
// export, e.g. Subframe) into `pages/`: catalogs every interactive JSX
// attribute it finds, strips all local state/logic so the result is
// presentation-only, rewires each catalogued attribute to a same-named prop,
// and emits an explicit `<Feature>PageProps.ts` interface declaring them.
//
// Parsing is typescript-estree/estree-walker (packages/core/parser.mjs's parseToAst,
// reused rather than re-parsed a second way) per the epic's reconciliation
// notes -- not @babel/parser/@babel/traverse. This module only ever *reads*
// AST node ranges to slice/splice the original source text (the same
// range-based technique packages/core/architecture-enforcer.mjs and
// ui/server/src/pagesEditor.mjs already use for source-preserving edits) --
// it never re-prints a whole AST, so original formatting/comments in the
// kept region survive untouched.
import fs from 'node:fs';
import path from 'node:path';
import { parseToAst, walkAst } from '../../packages/ast/index.mjs';
import { loadConfig } from '../core/config.mjs';
import { write } from '../core/fs.mjs';
import { selfCheck, pascalCase, ensureFeatureExists } from '../core/generators.mjs';
import { ConstructError, EXIT_CODES } from '../core/diagnostics.mjs';
import { extractMachines } from './workflowExtractor.mjs';
import { listWorkflowSourceFiles, readWorkflowSource } from './workflowSource.mjs';
import { assignTestIds, slotTestId, eventTestId } from './testAttributes.mjs';

const CALLBACK_ATTR_RE = /^on[A-Z]/;
const VALUE_ATTR_NAMES = new Set(['value', 'checked', 'defaultValue', 'defaultChecked']);

// Well-known React DOM event handler shapes get a real signature; anything
// else recognized as a handler (any onXxx name) falls back to a generic
// niladic callback rather than guessing a payload shape it can't know.
const EVENT_TYPE_BY_NAME = {
  onChange: '(value: string) => void',
  onSubmit: '(event: React.FormEvent<HTMLFormElement>) => void',
  onKeyDown: '(event: React.KeyboardEvent) => void',
  onKeyUp: '(event: React.KeyboardEvent) => void',
};

function classifyAttrName(name) {
  if (VALUE_ATTR_NAMES.has(name)) return 'value';
  if (CALLBACK_ATTR_RE.test(name)) return 'callback';
  return null;
}

function slotType(name, kind) {
  if (EVENT_TYPE_BY_NAME[name]) return EVENT_TYPE_BY_NAME[name];
  if (kind === 'callback') return '() => void';
  if (name === 'checked' || name === 'defaultChecked') return 'boolean';
  return 'string';
}

const isComponentFn = (n) => n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'FunctionDeclaration');
const COMPONENT_WRAPPERS = new Set(['memo', 'forwardRef']);
const calleeName = (c) => (c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' && !c.computed ? c.property?.name : null);

/** #675: the function a top-level binding `name` holds -- `function name() {}` or `const name = <fn>`,
 * exported or not -- or null. */
function declaredFunction(ast, name, depth) {
  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (decl?.type === 'FunctionDeclaration' && decl.id?.name === name) return decl;
    if (decl?.type === 'VariableDeclaration') {
      const d = decl.declarations.find((x) => x.id?.type === 'Identifier' && x.id.name === name);
      if (d) return componentFunctionOf(ast, d.init, depth + 1);
    }
  }
  return null;
}

/** #675: the function an exported expression resolves to: the function itself, a name bound to one in
 * the same file (`export default X;`), a `memo(...)`/`forwardRef(...)` wrapper (`React.` or bare), or a
 * TS `as`/`satisfies` around any of these. Null when it resolves to anything else. */
function componentFunctionOf(ast, n, depth = 0) {
  if (!n || depth > 5) return null;
  if (isComponentFn(n)) return n;
  if (n.type === 'Identifier') return declaredFunction(ast, n.name, depth);
  if (n.type === 'CallExpression' && COMPONENT_WRAPPERS.has(calleeName(n.callee))) return componentFunctionOf(ast, n.arguments[0], depth + 1);
  if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression') return componentFunctionOf(ast, n.expression, depth + 1);
  return null;
}

/** The exported React component function in `ast`, in source order: `export default <fn>`,
 * `export default X;`, `export { X as default }`, `export function X`, `export const X = <fn>`,
 * `export { X }`, each also through `memo`/`forwardRef`. Returns `{ funcNode, exportsSeen }`: `funcNode`
 * is null when none resolves, and `exportsSeen` describes what was found so the error can say why. */
function findComponentFunction(ast, source) {
  const exportsSeen = [];
  const text = (n) => source.slice(n.range[0], n.range[1]).split('\n')[0].slice(0, 60);
  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      const fn = componentFunctionOf(ast, node.declaration);
      if (fn) return { funcNode: fn, exportsSeen };
      exportsSeen.push(`\`${text(node)}\``);
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    const decl = node.declaration;
    if (decl?.type === 'FunctionDeclaration') return { funcNode: decl, exportsSeen };
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        const fn = componentFunctionOf(ast, d.init);
        if (fn) return { funcNode: fn, exportsSeen };
      }
    }
    for (const s of node.specifiers || []) {
      if (node.source) continue; // a re-export from another file: nothing to ingest here
      const fn = declaredFunction(ast, s.local.name, 0);
      if (fn) return { funcNode: fn, exportsSeen };
      exportsSeen.push(`\`export { ${s.local.name}${s.exported.name !== s.local.name ? ` as ${s.exported.name}` : ''} }\``);
    }
  }
  return { funcNode: null, exportsSeen };
}

/** The JSX node this component function actually renders: for a
 * block-bodied function, its last `return <jsx>` statement; for a
 * concise-body arrow (`() => (<jsx/>)`), the body expression itself. Returns
 * `{ jsxNode, wholeRange }` where `wholeRange` is what gets kept verbatim
 * (return statement including `return`/`;`, or just the expression for a
 * concise arrow, which the caller wraps in an explicit `return (...)`). */
function findRenderedJsx(funcNode, source) {
  if (funcNode.body.type !== 'BlockStatement') {
    return { jsxNode: funcNode.body, wholeRange: funcNode.body.range, concise: true };
  }
  const returns = funcNode.body.body.filter((s) => s.type === 'ReturnStatement' && s.argument);
  const last = returns[returns.length - 1];
  if (!last) return null;
  return { jsxNode: last.argument, wholeRange: last.range, concise: false };
}

/** Every catalogued interactive JSXAttribute under `jsxNode`, in source order, with the element that
 * carries it (`element`) so a repeated attribute name can be told apart by where it sits (#676). */
function collectInteractiveAttrs(jsxNode) {
  const hits = [];
  walkAst(jsxNode, {
    enter(node) {
      if (node.type !== 'JSXElement') return;
      for (const a of node.openingElement.attributes) {
        if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier') continue;
        const kind = classifyAttrName(a.name.name);
        if (kind) hits.push({ name: a.name.name, kind, range: a.range, element: node });
      }
    },
  });
  return hits.sort((a, b) => a.range[0] - b.range[0]);
}

const hasAttr = (opening, attrName) => opening.attributes.some((a) => a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === attrName);

// Icon component prefixes of the common icon sets, dropped when an icon names a button (`FeatherSearch` -> `Search`).
const ICON_PREFIX_RE = /^(Feather|Icon|Lucide|Hero|Md|Fa|Io|Ri|Bi|Tb)(?=[A-Z])/;
const NAMING_ATTRS = ['aria-label', 'title', 'label', 'name', 'id', 'placeholder'];
// What a bare icon button does, for the icons whose glyph name is not the action.
const ICON_ACTION = {
  X: 'Close', XCircle: 'Close', Plus: 'Add', PlusCircle: 'Add', Minus: 'Remove', Trash: 'Delete', Trash2: 'Delete',
  Edit: 'Edit', Edit2: 'Edit', Edit3: 'Edit', Pencil: 'Edit', MoreVertical: 'Menu', MoreHorizontal: 'Menu',
  ChevronDown: 'Expand', ChevronUp: 'Collapse', ChevronLeft: 'Back', ChevronRight: 'Next', ArrowLeft: 'Back',
  ArrowRight: 'Next', Check: 'Confirm', RefreshCw: 'Refresh', RotateCw: 'Refresh', Download: 'Download', Upload: 'Upload',
};

/** Up to four words of `text` as PascalCase (`Add category` -> `AddCategory`), or null when nothing usable. */
function pascalWords(text) {
  const words = String(text).match(/[A-Za-z][A-Za-z0-9]*/g);
  if (!words) return null;
  return words.slice(0, 4).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

/** #676: what an interactive element is, read from the element itself, deterministically: a naming
 * attribute (`aria-label`, `title`, `label`, `name`, `id`, `placeholder`), else its own text, else the
 * icon it shows (`icon={<FeatherSearch />}` or a lone icon child). Null when none of these exists. */
function elementContext(element) {
  const open = element.openingElement;
  for (const n of NAMING_ATTRS) {
    const a = open.attributes.find((x) => x.type === 'JSXAttribute' && x.name?.name === n);
    const v = a?.value?.type === 'Literal' && typeof a.value.value === 'string' ? pascalWords(a.value.value) : null;
    if (v) return v;
  }
  const ownText = pascalWords(element.children.filter((c) => c.type === 'JSXText').map((c) => c.value).join(' '));
  if (ownText) return ownText;
  const iconAttr = open.attributes.find((x) => x.type === 'JSXAttribute' && x.name?.name === 'icon');
  const iconEl = iconAttr?.value?.type === 'JSXExpressionContainer' && iconAttr.value.expression.type === 'JSXElement'
    ? iconAttr.value.expression
    : element.children.filter((c) => c.type === 'JSXElement').length === 1 ? element.children.find((c) => c.type === 'JSXElement') : null;
  const iconName = iconEl?.openingElement.name.type === 'JSXIdentifier' ? iconEl.openingElement.name.name : null;
  if (!iconName) return null;
  const glyph = iconName.replace(ICON_PREFIX_RE, '').replace(/Icon$/, '');
  return ICON_ACTION[glyph] ?? glyph;
}

const tagOf = (element, source) => source.slice(element.openingElement.name.range[0], element.openingElement.name.range[1]);

/** The slot name for attribute `attr` on an element named `ctx`: `onClick` -> `on<Ctx>`, another event ->
 * `on<Ctx><Event>` (`onChange` -> `onEmailChange`), a value attribute -> `<ctx><Attr>` (`emailValue`). */
function contextSlotName(attr, kind, ctx) {
  if (kind === 'callback') return attr === 'onClick' ? `on${ctx}` : `on${ctx}${attr.slice(2)}`;
  return `${ctx[0].toLowerCase()}${ctx.slice(1)}${attr[0].toUpperCase()}${attr.slice(1)}`;
}

/**
 * #676: give every interactive attribute occurrence its slot. An attribute name that occurs once keeps
 * its own name (`onClick`), as before. A name that occurs on several elements is split, because each
 * element is a different interaction: each occurrence is named from its element (`elementContext`).
 * Occurrences with the same derived name on the same kind of element are one interaction repeated (rows
 * of a table): a niladic callback becomes ONE slot taking the occurrence index (`onMoreVertical(index)`),
 * anything else gets a numeric suffix. Occurrences with no name get `<attr>1`, `<attr>2`, ... Every
 * resulting slot name is unique. Mutates each attr with `slot` (and `index` when repeated).
 * @returns {Array<{name: string, kind: string, event?: string, repeated?: boolean}>} slots in source order.
 */
function assignSlots(attrs, source) {
  const byName = new Map();
  for (const a of attrs) byName.set(a.name, [...(byName.get(a.name) || []), a]);
  for (const [attr, occ] of byName) {
    if (occ.length === 1) { occ[0].slot = attr; continue; }
    const groups = new Map();
    let unnamed = 0;
    for (const a of occ) {
      const ctx = elementContext(a.element);
      if (!ctx) { a.slot = `${attr}${++unnamed}`; a.event = attr; continue; }
      const key = `${contextSlotName(attr, a.kind, ctx)}\u0000${tagOf(a.element, source)}`;
      groups.set(key, [...(groups.get(key) || []), a]);
    }
    const perName = new Map();
    for (const [key, group] of groups) {
      const base = key.split('\u0000')[0];
      const n = (perName.get(base) || 0) + 1;
      perName.set(base, n);
      const name = n === 1 ? base : `${base}${n}`;
      const repeatable = group.length > 1 && group[0].kind === 'callback' && !EVENT_TYPE_BY_NAME[attr];
      group.forEach((a, i) => {
        a.event = attr;
        if (repeatable) { a.slot = name; a.index = i; a.repeated = true; } else a.slot = i === 0 ? name : `${name}${i + 1}`;
      });
    }
  }
  // Unique across attribute names too (a derived `onSubmit` must not collide with a real one); an
  // attribute that kept its own name is placed first, so it is never the one renamed.
  const used = new Set();
  const renamed = new Map();
  for (const a of [...attrs.filter((x) => x.slot === x.name), ...attrs.filter((x) => x.slot !== x.name)]) {
    const key = `${a.name}\u0000${a.slot}`;
    if (renamed.has(key)) { a.slot = renamed.get(key); continue; }
    let slot = a.slot;
    for (let k = 2; used.has(slot); k++) slot = `${a.slot}${k}`;
    used.add(slot);
    renamed.set(key, slot);
    a.slot = slot;
  }
  const slots = new Map();
  for (const a of attrs) {
    if (slots.has(a.slot)) continue;
    const s = { name: a.slot, kind: a.kind };
    if (a.event && a.event !== a.slot) s.event = a.event;
    if (a.repeated) s.repeated = true;
    slots.set(a.slot, s);
  }
  return [...slots.values()];
}

/** #348: where to add `data-testid="<event>"` -- one per element carrying an `on<Event>` callback (its first
 * one), from that occurrence's slot (a repeated slot adds `-<index>`), unique on the page, never
 * overwriting an existing one. `idFor(slot, base)` may scope the id. */
function testIdInserts(attrs, idFor) {
  const inserts = [];
  const taken = new Set();
  const done = new Set();
  for (const a of attrs) {
    const open = a.element.openingElement;
    if (a.kind !== 'callback' || done.has(open) || hasAttr(open, 'data-testid')) continue;
    const base = slotTestId(a.slot);
    const scoped = base && idFor(a.slot, base);
    const id = scoped && (a.repeated ? `${scoped}-${a.index}` : scoped);
    if (!id || taken.has(id)) continue;
    taken.add(id);
    done.add(open);
    inserts.push({ at: open.name.range[1], text: ` data-testid="${id}"`, testId: id });
  }
  return inserts;
}

/** Rewire `text` (the source slice for `[sliceStart, sliceEnd)`) so every
 * catalogued attribute's value becomes a reference to its slot prop --
 * `name={slot}`, or `name={() => slot(index)}` for a repeated slot -- applied
 * from the last attribute backwards so earlier offsets stay valid. */
function rewireAttrs(text, sliceStart, attrs, inserts = []) {
  const edits = [
    ...attrs.map((a) => ({ start: a.range[0], end: a.range[1], text: a.repeated ? `${a.name}={() => ${a.slot}(${a.index})}` : `${a.name}={${a.slot}}` })),
    ...inserts.map((i) => ({ start: i.at, end: i.at, text: i.text })),
  ];
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, e.start - sliceStart) + e.text + out.slice(e.end - sliceStart);
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Original top-level `ImportDeclaration` source lines whose specifiers are
 * still referenced (by a simple word-boundary text search — this is an
 * import-retention heuristic, not an architecture rule, so a cheap,
 * conservative check is fine here) somewhere in `keptBodyText`. Whole
 * import statements are kept or dropped together, never split into "some
 * specifiers used, some not" — safer than editing a specifier list. */
function retainedImportLines(ast, source, keptBodyText) {
  const lines = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const localNames = node.specifiers.map((s) => s.local?.name).filter(Boolean);
    const anyUsed = localNames.some((n) => new RegExp(`\\b${escapeRegExp(n)}\\b`).test(keptBodyText));
    if (anyUsed) lines.push(source.slice(node.range[0], node.range[1]));
  }
  return lines;
}

/**
 * Parse an externally-authored JSX/TSX source (a "pristine" ingested file --
 * simulating a Subframe export) and produce a presentation-only Construct
 * page plus its explicit Props interface.
 *
 * @param {string} source - the ingested file's raw text.
 * @param {{feature: string, name: string}} opts - `name` is already
 *   capitalized (the layer's conventional PascalCase base name).
 * @returns {{pageSource: string, propsSource: string, slots: Array<{name:string, kind:'callback'|'value'}>}}
 */
export function transformPristineSource(source, { feature, name, flow = null }) {
  const ast = parseToAst(source);
  const { funcNode, exportsSeen } = findComponentFunction(ast, source);
  if (!funcNode) {
    const seenNote = exportsSeen.length
      ? ` Found ${exportsSeen.join(', ')}, which does not resolve to a component function declared in this file.`
      : ' The file has no export.';
    throw new ConstructError(
      `No exported React component function found in the ingested source (expected \`export function X() {...}\`, \`export default function X() {...}\`, \`export const X = () => {...}\`, or \`function X() {...}\` with \`export default X;\`).${seenNote}`,
      { exitCode: EXIT_CODES.USAGE_ERROR },
    );
  }
  const rendered = findRenderedJsx(funcNode, source);
  if (!rendered) {
    throw new ConstructError('The ingested component has no `return <jsx/>` statement — nothing to ingest as a page.', { exitCode: EXIT_CODES.USAGE_ERROR });
  }

  const attrs = collectInteractiveAttrs(rendered.jsxNode);
  const slots = assignSlots(attrs, source);

  // #348: test attributes. `flow` (only when the feature has a workflow) = { machineKey, eventIds: Map(kebab -> testid) }.
  const inserts = testIdInserts(attrs, (slot, base) => flow?.eventIds.get(base) ?? base);
  const root = rendered.jsxNode;
  if (flow && root?.type === 'JSXElement' && !hasAttr(root.openingElement, 'data-flow-state')) {
    inserts.push({ at: root.openingElement.name.range[1], text: ` data-flow="${flow.machineKey}" data-flow-state={flowState}` });
    if (!slots.some((s) => s.name === 'flowState')) slots.push({ name: 'flowState', kind: 'value', optional: true });
  }
  const sliceStart = rendered.wholeRange[0];
  const sliceEnd = rendered.wholeRange[1];
  const rewiredSlice = rewireAttrs(source.slice(sliceStart, sliceEnd), sliceStart, attrs, inserts);
  const bodyText = rendered.concise ? `return (\n    ${rewiredSlice}\n  );` : rewiredSlice;

  const propsTypeName = `${name}PageProps`;
  const importLines = retainedImportLines(ast, source, bodyText);
  const paramsDestructure = slots.length ? `{ ${slots.map((s) => s.name).join(', ')} }: ${propsTypeName}` : `_props: ${propsTypeName}`;

  const pageSource = [
    `import type { ${propsTypeName} } from './${propsTypeName}';`,
    ...importLines,
    '',
    `export function ${name}Page(${paramsDestructure}) {`,
    `  ${bodyText}`,
    `}`,
    '',
  ].join('\n');

  const propsSource = [
    `// Auto-generated by \`construct create page --from\` (Ticket 7.2) from an ingested`,
    `// presentation file -- every prop below is an interactive slot the pristine`,
    `// ${name}Page component found and externalized. Wire these from a controller.`,
    `export interface ${propsTypeName} {`,
    ...slots.map((s) => (s.optional ? `  ${s.name}?: string;` : `  ${s.name}: ${s.repeated ? '(index: number) => void' : slotType(s.event ?? s.name, s.kind)};`)),
    `}`,
    '',
  ].join('\n');

  return { pageSource, propsSource, slots, testIds: inserts.filter((i) => i.testId).map((i) => i.testId) };
}

/** #348: the feature's first workflow machine key and its event -> data-testid map (scoped on collisions), or
 * null when the feature has no readable workflow. Deterministic: sorted files, source order. */
export function featureFlow(root, feature) {
  const machines = [];
  try {
    for (const file of listWorkflowSourceFiles(root, feature)) {
      machines.push(...extractMachines(readWorkflowSource(root, feature, file)).machines.filter((m) => !m.error && m.initial));
    }
  } catch { return null; }
  if (!machines.length) return null;
  const { keys, testIds } = assignTestIds(machines);
  const eventIds = new Map();
  testIds.forEach((ids) => { for (const [event, id] of ids) if (!eventIds.has(eventTestId(event))) eventIds.set(eventTestId(event), id); });
  return { machineKey: keys[0], eventIds };
}

/**
 * Ingest `fromPath` (an externally-authored JSX/TSX file) as feature
 * `feature`'s `<name>` page: writes `<Feature>Page.tsx` +
 * `<Feature>PageProps.ts` under `features/<feature>/pages/`, then
 * re-validates both via generators.mjs's shared selfCheck.
 *
 * @returns {{pageFile:string, propsFile:string, slots:object[], testIds:string[]}} The written files and the slots and test ids found in the source.
 * @throws {ConstructError} Usage error (exit code 2) when `fromPath` is not a file.
 * @param {string} root Project root.
 * @param {string} name Page name.
 * @param {string} feature Feature that owns the page.
 * @param {string} fromPath The external JSX/TSX file to ingest.
 */
export function ingestPage(root, name, feature, fromPath) {
  const config = loadConfig(root);
  const cap = pascalCase(name, 'Page');
  const sourcePath = path.isAbsolute(fromPath) ? fromPath : path.resolve(fromPath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new ConstructError(`Source file not found: ${sourcePath}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const source = fs.readFileSync(sourcePath, 'utf8');
  const { pageSource, propsSource, slots, testIds } = transformPristineSource(source, { feature, name: cap, flow: featureFlow(root, feature) });

  ensureFeatureExists(root, feature); // #677: a missing feature is scaffolded first, not silently written into
  const dir = path.join(root, config.features?.root || 'features', feature, 'pages');
  const pageFile = path.join(dir, `${cap}Page.tsx`);
  const propsFile = path.join(dir, `${cap}PageProps.ts`);
  write(pageFile, pageSource);
  write(propsFile, propsSource);
  selfCheck(root, [pageFile, propsFile]);

  return { pageFile, propsFile, slots, testIds };
}
