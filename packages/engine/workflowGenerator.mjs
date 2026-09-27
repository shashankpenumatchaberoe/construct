// Ticket 7.3 -- JSON state graph -> XState v5 workflow AST generator.
//
// Compiles a plain JSON state-machine descriptor into a strongly typed
// XState v5 `setup({...}).createMachine({...})` file, entirely
// deterministically (no LLM). The dynamic, arbitrary-shaped parts of the
// output -- the context interface's members, the event union type, the
// runtime context default-value object, and the recursive `states` object
// (including guarded and array-form transitions) -- are built as real
// TypeScript compiler API AST nodes (`ts.factory`) and printed via
// `ts.createPrinter()`, per the epic's reconciliation notes: this is
// genuine AST *synthesis* from arbitrary input, the class of work the
// compiler API is for (not ts-morph, not a templating library). The
// never-varying wrapper around it (the `import { setup } from 'xstate'`
// line, the `setup(...).createMachine(...)` call shape, the exported
// const) stays a plain template string, matching packages/core/generators.mjs's own
// style for boilerplate that needs no real synthesis.
import path from 'node:path';
import { ts, printNode as print } from '../../packages/ast/index.mjs';
import { loadConfig } from '../core/config.mjs';
import fs from 'node:fs';
import { write } from '../core/fs.mjs';
import { selfCheck, pascalCase, ensureFeatureExists } from '../core/generators.mjs';
import { ConstructError, EXIT_CODES } from '../core/diagnostics.mjs';

// A lazy view of `ts.factory`: reading it at import time would load the compiler for every importer (#657).
const factory = new Proxy({}, { get: (_target, key) => ts.factory[key] });
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function usageError(message) {
  return new ConstructError(message, { exitCode: EXIT_CODES.USAGE_ERROR });
}

function propName(key) {
  return IDENT_RE.test(key) ? factory.createIdentifier(key) : factory.createStringLiteral(key);
}

/**
 * Parse a standalone TS type string (e.g. "number", "string | null") into a real `ts.TypeNode` via
 * the compiler API's own parser -- so a hand-authored type string in a descriptor (a context field,
 * or #593's function input/output types) prints back out exactly as valid TS, whatever its shape,
 * instead of being pasted in as unchecked text. Exported so other generators that accept the same
 * kind of free-form TS-type-as-string field (`packages/core/research/specToCode.mjs`'s function
 * stubs) reuse this exact parse-and-reprint step instead of a second copy of it.
 *
 * @param {string} typeStr A standalone TypeScript type expression (e.g. `"string | null"`).
 * @returns {import('typescript').TypeNode} The parsed type node, ready to print or splice into other AST.
 * @throws {ConstructError} When `typeStr` is not a valid standalone TS type.
 */
export function parseTypeString(typeStr) {
  const sf = ts.createSourceFile('t.ts', `type T = ${typeStr};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const alias = sf.statements.find((s) => ts.isTypeAliasDeclaration(s));
  if (!alias) throw usageError(`Invalid TypeScript type string in context field: "${typeStr}"`);
  return alias.type;
}

function jsValueToLiteral(v) {
  if (v === null) return factory.createNull();
  if (typeof v === 'string') return factory.createStringLiteral(v);
  if (typeof v === 'boolean') return v ? factory.createTrue() : factory.createFalse();
  if (typeof v === 'number') {
    return v < 0
      ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, factory.createNumericLiteral(Math.abs(v)))
      : factory.createNumericLiteral(v);
  }
  if (Array.isArray(v)) return factory.createArrayLiteralExpression(v.map(jsValueToLiteral), false);
  if (typeof v === 'object') {
    return factory.createObjectLiteralExpression(
      Object.entries(v).map(([k, val]) => factory.createPropertyAssignment(propName(k), jsValueToLiteral(val))),
      false,
    );
  }
  throw usageError(`Unsupported context default value: ${JSON.stringify(v)}`);
}

// ---- descriptor validation --------------------------------------------

/** Throws a clear, actionable ConstructError for a malformed descriptor
 * rather than letting a cryptic factory-API TypeError surface instead. */
function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw usageError('Workflow descriptor must be a JSON object.');
  }
  if (!descriptor.states || typeof descriptor.states !== 'object' || !Object.keys(descriptor.states).length) {
    throw usageError('Workflow descriptor must declare a non-empty "states" object.');
  }
  if (typeof descriptor.initial !== 'string' || !descriptor.initial) {
    throw usageError('Workflow descriptor must declare an "initial" state name.');
  }
  if (!(descriptor.initial in descriptor.states)) {
    throw usageError(`Workflow descriptor's "initial" state "${descriptor.initial}" is not one of its declared states: ${Object.keys(descriptor.states).join(', ')}.`);
  }
  if (descriptor.context !== undefined && (typeof descriptor.context !== 'object' || Array.isArray(descriptor.context))) {
    throw usageError('Workflow descriptor\'s "context" (if given) must be an object mapping field name -> {type, default}.');
  }
  if (descriptor.guards !== undefined && (typeof descriptor.guards !== 'object' || Array.isArray(descriptor.guards))) {
    throw usageError('Workflow descriptor\'s "guards" (if given) must be an object mapping guard name -> a note for its TODO stub.');
  }
  if (descriptor.eventPayloads !== undefined && (typeof descriptor.eventPayloads !== 'object' || descriptor.eventPayloads === null || Array.isArray(descriptor.eventPayloads))) {
    throw usageError('Workflow descriptor\'s "eventPayloads" (if given) must be an object mapping event name -> a TypeScript type string.');
  }
  if (descriptor.typeImports !== undefined && !(Array.isArray(descriptor.typeImports) && descriptor.typeImports.every((i) => i && typeof i.from === 'string' && Array.isArray(i.names)))) {
    throw usageError('Workflow descriptor\'s "typeImports" (if given) must be a list of { from, names[] }.');
  }
}

// ---- event extraction ---------------------------------------------------

/** Normalize a single `on.EVENT` transition value to `{target, guard?}` --
 * accepts a bare target string (shorthand) or the full object form. */
function normalizeTransition(t) {
  if (typeof t === 'string') return { target: t };
  if (!t || typeof t !== 'object' || typeof t.target !== 'string') {
    throw usageError(`Invalid transition target: ${JSON.stringify(t)} (expected a state-name string, or an object with a "target" string).`);
  }
  return t.guard ? { target: t.target, guard: t.guard } : { target: t.target };
}

/** Every distinct event name referenced across all states' `on` maps, in
 * first-appearance order (Object.entries preserves insertion order). */
export function extractEventNames(statesJson) {
  const seen = new Set();
  for (const state of Object.values(statesJson)) {
    for (const eventName of Object.keys(state.on || {})) seen.add(eventName);
  }
  return [...seen];
}

/** Shape `events` (a list of event name strings) into the Context Envelope
 * (schemas/envelope.v1.json) `events: [{type, payload}]` array, for
 * downstream consumers such as Ticket 7.4's controller binder. */
export function eventsToEnvelope(eventNames) {
  return eventNames.map((type) => ({ type, payload: {} }));
}

// ---- AST synthesis (the data-shaped, arbitrary-depth parts) -------------

function buildTransitionValue(transition) {
  const t = normalizeTransition(transition);
  if (t.guard) {
    return factory.createObjectLiteralExpression(
      [
        factory.createPropertyAssignment('target', factory.createStringLiteral(t.target)),
        factory.createPropertyAssignment('guard', factory.createStringLiteral(t.guard)),
      ],
      false,
    );
  }
  return factory.createStringLiteral(t.target);
}

function buildOnValue(transitionOrArray) {
  if (Array.isArray(transitionOrArray)) {
    return factory.createArrayLiteralExpression(transitionOrArray.map(buildTransitionValue), true);
  }
  return buildTransitionValue(transitionOrArray);
}

/** Recursively builds one state's object literal: `{ type?: 'final', on?: {...} }`. */
function buildStateLiteral(stateJson) {
  const props = [];
  if (stateJson.type === 'final') props.push(factory.createPropertyAssignment('type', factory.createStringLiteral('final')));
  const onEntries = Object.entries(stateJson.on || {});
  if (onEntries.length) {
    props.push(
      factory.createPropertyAssignment(
        'on',
        factory.createObjectLiteralExpression(
          onEntries.map(([eventName, transition]) => factory.createPropertyAssignment(propName(eventName), buildOnValue(transition))),
          true,
        ),
      ),
    );
  }
  return factory.createObjectLiteralExpression(props, true);
}

function buildStatesObjectLiteral(statesJson) {
  return factory.createObjectLiteralExpression(
    Object.entries(statesJson).map(([name, def]) => factory.createPropertyAssignment(propName(name), buildStateLiteral(def))),
    true,
  );
}

function buildContextInterfaceMembers(contextJson) {
  return Object.entries(contextJson).map(([field, def]) =>
    factory.createPropertySignature(undefined, propName(field), undefined, parseTypeString(def.type)),
  );
}

function buildContextDefaultsLiteral(contextJson) {
  return factory.createObjectLiteralExpression(
    Object.entries(contextJson).map(([field, def]) => factory.createPropertyAssignment(propName(field), jsValueToLiteral(def.default))),
    false,
  );
}

// #593 -- opt-in `descriptor.guards`: `{ [guardName]: note }`, one per named guard a transition
// refers to. Nothing in this module inferred guard behavior before this (a hand-authored
// descriptor's guard names were just strings on a transition, with no matching setup() entry) --
// R2 (spec-to-code) needs every guard `construct research spec --generate` derives from a
// machine-spec.v1 transition to exist as a real, named stub the generated file actually compiles
// against, not just a string XState would fail to resolve at runtime. Each stub is deliberately a
// plain template (not AST-synthesized): the shape never varies (one arrow function, one TODO
// comment, one `return false`) -- only the name and the note text do, which is exactly the class
// of boilerplate this module's own header says stays a template string.
const GUARD_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function buildGuardsText(guardsJson) {
  const entries = Object.entries(guardsJson || {});
  if (!entries.length) return null;
  const lines = entries.map(([name, note]) => {
    if (!GUARD_NAME_RE.test(name)) throw usageError(`Invalid guard name in descriptor: ${JSON.stringify(name)} (must be a valid identifier).`);
    const todo = String(note ?? '').replace(/\s+/g, ' ').trim() || `implement guard "${name}"`;
    return [`    ${name}: () => {`, `      // TODO: ${todo}`, '      return false;', '    },'].join('\n');
  });
  return `  guards: {\n${lines.join('\n')}\n  },`;
}

/**
 * One event's member of the union: `{ type: "NAME" }`, or, with a payload type (#576), the payload's
 * own members beside `type` -- XState's flat-event convention, `{ type: "SUBMIT"; email: string }`.
 * A payload that is not an object literal (a named type, an intersection) becomes `{ type } & Payload`.
 */
function eventMember(name, payloadStr) {
  const typeProp = factory.createPropertySignature(undefined, factory.createIdentifier('type'), undefined, factory.createLiteralTypeNode(factory.createStringLiteral(name)));
  if (!payloadStr) return factory.createTypeLiteralNode([typeProp]);
  const payload = parseTypeString(payloadStr);
  if (ts.isTypeLiteralNode(payload) && !payload.members.some((m) => m.name && m.name.getText() === 'type')) {
    return factory.createTypeLiteralNode([typeProp, ...payload.members]);
  }
  return factory.createIntersectionTypeNode([factory.createTypeLiteralNode([typeProp]), payload]);
}

function buildEventUnionType(eventNames, payloads = {}) {
  const members = eventNames.map((name) => eventMember(name, payloads[name]));
  // A machine with no events at all still needs a valid (if unusable) event type.
  return members.length ? factory.createUnionTypeNode(members) : factory.createTypeLiteralNode([]);
}

/**
 * Compile a JSON state-graph descriptor into an XState v5 workflow source
 * file. Pure -- no filesystem access.
 *
 * @param {object} descriptor - `{id?, initial, context?: {field: {type, default}}, guards?: {name: note}, states: {...}}`.
 *   `guards` (#593) is optional: each entry becomes a named stub in `setup()`'s `guards:` map that
 *   returns `false` with a `// TODO: <note>` comment -- typically the req sentence the guard exists
 *   to satisfy -- so a transition that names a guard always compiles against a real (if unimplemented)
 *   predicate instead of a dangling string.
 *   `eventPayloads` (#576) maps an event name to a TS type string whose members join `{ type }` in
 *   the event union; `typeImports` (`[{from, names[]}]`) adds `import type` lines for the names those
 *   payload types (or context fields) refer to.
 * @param {{name: string}} opts - `name` is the already-capitalized layer base name (e.g. "Checkout").
 * @returns {{source: string, events: string[], contextFields: string[]}}
 */
export function compileWorkflow(descriptor, { name }) {
  validateDescriptor(descriptor);
  const contextJson = descriptor.context || {};
  const events = extractEventNames(descriptor.states);
  const contextFields = Object.keys(contextJson);
  const guardsText = buildGuardsText(descriptor.guards);

  const contextTypeName = `${name}Context`;
  const eventTypeName = `${name}Event`;

  const contextInterfaceText = contextFields.length
    ? print(factory.createInterfaceDeclaration(
        [factory.createModifier(ts.SyntaxKind.ExportKeyword)],
        contextTypeName,
        undefined,
        undefined,
        buildContextInterfaceMembers(contextJson),
      ))
    : `export type ${contextTypeName} = Record<string, never>;`;

  const eventUnionText = print(
    factory.createTypeAliasDeclaration(
      [factory.createModifier(ts.SyntaxKind.ExportKeyword)],
      eventTypeName,
      undefined,
      buildEventUnionType(events, descriptor.eventPayloads),
    ),
  );

  const statesText = print(buildStatesObjectLiteral(descriptor.states));
  const contextDefaultsText = contextFields.length ? print(buildContextDefaultsLiteral(contextJson)) : null;
  const machineId = descriptor.id || name.toLowerCase();

  const typeImportLines = (descriptor.typeImports || [])
    .filter((i) => i.names.length)
    .map((i) => `import type { ${[...i.names].sort().join(', ')} } from ${quote(i.from)};`);

  const source = [
    `import { setup } from 'xstate';`,
    ...typeImportLines,
    '',
    contextInterfaceText,
    '',
    eventUnionText,
    '',
    `export const ${name}Workflow = setup({`,
    `  types: {} as {`,
    `    context: ${contextTypeName};`,
    `    events: ${eventTypeName};`,
    `  },`,
    ...(guardsText ? [guardsText] : []),
    `}).createMachine({`,
    `  id: '${machineId}',`,
    `  initial: '${descriptor.initial}',`,
    // A machine typed with an empty context still needs `context: {}`: XState's config type requires the key.
    `  context: ${contextDefaultsText ?? '{}'},`,
    `  states: ${statesText},`,
    `});`,
    '',
  ].join('\n');

  return { source, events, contextFields };
}

// ---- opt-in typed state union (#580) ------------------------------------

/** First line of every emitted state-union file. It is the one signal
 * `generateWorkflow` trusts to tell "a file this block wrote, free to
 * regenerate" apart from "hand-written content, never overwrite". */
export const STATE_UNION_MARKER = '// Generated by `construct generate workflow --state-union`.';

/** A TS string literal in the repo's single-quote style. */
function quote(s) {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * Compile a descriptor's states into a `<Name>State` discriminated union
 * (one `{ status: '<state>' }` member per state, nothing else) plus an
 * exhaustive-match helper and an `assertNever` for `switch` statements.
 * Pure -- no filesystem access; byte-stable for the same descriptor.
 *
 * @param {object} descriptor - The same JSON state-graph descriptor `compileWorkflow` takes.
 * @param {{name: string}} opts - `name` is the already-capitalized layer base name (e.g. "Checkout").
 * @returns {{source: string, states: string[]}} The file text and the state names, in descriptor order.
 */
export function compileStateUnion(descriptor, { name }) {
  validateDescriptor(descriptor);
  const states = Object.keys(descriptor.states);
  const stateType = `${name}State`;
  const source = [
    STATE_UNION_MARKER,
    '// Regenerated from the workflow descriptor; edit the descriptor, not this file.',
    '',
    `export type ${stateType} =`,
    ...states.map((s, i) => `  | { status: ${quote(s)} }${i === states.length - 1 ? ';' : ''}`),
    '',
    `/** One handler per ${stateType} status; a missing key is a compile error. */`,
    `export type ${name}StateHandlers<R> = {`,
    `  [S in ${stateType} as S['status']]: (state: S) => R;`,
    '};',
    '',
    `/** Exhaustive match over ${stateType}: leave a state out and this stops compiling. */`,
    `export function match${name}State<R>(state: ${stateType}, handlers: ${name}StateHandlers<R>): R {`,
    `  const handle = handlers[state.status as ${stateType}['status']] as (s: ${stateType}) => R;`,
    '  return handle(state);',
    '}',
    '',
    `/** Put in a switch's default branch: an unhandled ${stateType} status is a compile error. */`,
    `export function assertNever${name}State(state: never): never {`,
    '  throw new Error(`Unhandled state: ${JSON.stringify(state)}`);',
    '}',
    '',
  ].join('\n');
  return { source, states };
}

/** Refuses (before anything is written) when `file` exists and is not one this block generated. */
function assertStateUnionWritable(file, root) {
  if (!fs.existsSync(file)) return;
  if (fs.readFileSync(file, 'utf8').startsWith(STATE_UNION_MARKER)) return;
  throw usageError(`Refusing to write ${path.relative(root, file)} -- it already exists with real content (not a file generated by --state-union). Remove or rename it first; nothing was written.`);
}

/**
 * Ingest a JSON state-graph descriptor as feature `feature`'s `<name>`
 * workflow: writes `features/<feature>/workflows/<Name>Workflow.tsx`, then
 * re-validates via generators.mjs's shared selfCheck. With
 * `{ stateUnion: true }` it also writes `<Name>WorkflowState.ts` beside it
 * (see compileStateUnion); nothing at all is written if that file already
 * holds real content.
 *
 * @param {string} root Project root.
 * @param {string} name Workflow name (turned into a valid identifier).
 * @param {string} feature Feature that owns the workflow.
 * @param {object} descriptor JSON state-graph descriptor.
 * @param {{stateUnion?: boolean}} [options] `stateUnion` also emits the typed state union and exhaustive matcher.
 * @returns {{file:string, events:string[], contextFields:string[], stateFile?:string}} The written file(s) and what the machine exposes.
 */
export function generateWorkflow(root, name, feature, descriptor, { stateUnion = false } = {}) {
  const config = loadConfig(root);
  // #216: same identifier handling as the layer generators; throws before any write.
  const cap = pascalCase(name, 'Workflow');
  const { source, events, contextFields } = compileWorkflow(descriptor, { name: cap });

  ensureFeatureExists(root, feature); // #677: a missing feature is scaffolded first, not silently written into
  const dir = path.join(root, config.features?.root || 'features', feature, 'workflows');
  const file = path.join(dir, `${cap}Workflow.tsx`);
  if (!stateUnion) {
    write(file, source);
    selfCheck(root, [file]);
    return { file, events, contextFields };
  }
  const union = compileStateUnion(descriptor, { name: cap });
  const stateFile = path.join(dir, `${cap}WorkflowState.ts`);
  assertStateUnionWritable(stateFile, root);
  write(file, source);
  write(stateFile, union.source);
  selfCheck(root, [file, stateFile]);
  return { file, events, contextFields, stateFile };
}
