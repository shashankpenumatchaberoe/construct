// Ticket 7.4 -- Zero-LLM controller binder.
//
// Auto-wires a hooks/ layer (an XState machine consumer, from Ticket 7.3)
// into a pristine pages/ component's Props interface (from Ticket 7.2) via
// AST signature matching -- no manual coding, no LLM call. Parses both
// signatures with the TypeScript compiler API directly, the same tool
// already used for #77/#83's cross-file prop resolution
// (ui/server/src/pagesEditor.mjs's findTypeMembers/declaredNamesFromFunction)
// and Ticket 7.3's workflow generator -- reimplemented locally in src/
// rather than imported across the src/ <-> ui/server/ package boundary
// (which doesn't exist today), but the same two-branch approach: prefer an
// explicit type annotation when present, fall back to the value's own
// literal shape otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { ts, parseTsSource as parseTs, findNode } from '../../packages/ast/index.mjs';
import { loadConfig } from '../core/config.mjs';
import { write } from '../core/fs.mjs';
import { selfCheck, pascalCase, ensureFeatureExists } from '../core/generators.mjs';
import { validateEnvelope } from './envelope.mjs';
import { ConstructError, EXIT_CODES } from '../core/diagnostics.mjs';

function usageError(message) {
  return new ConstructError(message, { exitCode: EXIT_CODES.USAGE_ERROR });
}

// ---- PageProps interface introspection (#7.2's output) -------------------

/**
 * Member names (+ whether each member's declared type is a function type)
 * of an exported interface (or type-literal alias) named `typeName` in
 * `source`. Returns `[]` if the type isn't found or has no members.
 */
export function extractPropsInterfaceMembers(source, typeName) {
  const sf = parseTs(source, 'props.ts');
  const decl = findNode(sf, (n) =>
    (ts.isInterfaceDeclaration(n) && n.name.text === typeName) ||
    (ts.isTypeAliasDeclaration(n) && n.name.text === typeName && ts.isTypeLiteralNode(n.type)));
  if (!decl) return [];
  const members = ts.isInterfaceDeclaration(decl) ? decl.members : decl.type.members;
  return members
    .filter((m) => ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name))
    .map((m) => ({ name: m.name.text, isFunctionType: !!m.type && ts.isFunctionTypeNode(m.type), ...(m.questionToken ? { optional: true } : {}) }));
}

// ---- hook return-signature introspection ----------------------------------

/** Member names of a type node if it's (or resolves to, via a same-file
 * alias) an interface/type-literal shape -- used for a hook's explicit
 * return-type annotation. Returns null if unrecognized. */
function typeMembersOf(sf, typeNode) {
  if (!typeNode) return null;
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.filter((m) => ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)).map((m) => m.name.text);
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const target = findNode(sf, (n) =>
      (ts.isInterfaceDeclaration(n) && n.name.text === typeNode.typeName.text) ||
      (ts.isTypeAliasDeclaration(n) && n.name.text === typeNode.typeName.text));
    if (!target) return null;
    const members = ts.isInterfaceDeclaration(target) ? target.members : (ts.isTypeLiteralNode(target.type) ? target.type.members : null);
    if (!members) return null;
    return members.filter((m) => ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)).map((m) => m.name.text);
  }
  return null;
}

/** Property names of the hook's own `return { ... }` object literal
 * (shorthand + regular property assignments; spreads are skipped since
 * their members can't be enumerated statically). */
function returnObjectMemberNames(fnBody) {
  if (!fnBody || !ts.isBlock(fnBody)) return [];
  const ret = [...fnBody.statements].reverse().find((s) => ts.isReturnStatement(s) && s.expression);
  if (!ret || !ts.isObjectLiteralExpression(ret.expression)) return [];
  const names = [];
  for (const prop of ret.expression.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) names.push(prop.name.text);
    else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) names.push(prop.name.text);
  }
  return names;
}

/**
 * The exposed member names of hook `hookName`'s return value: its explicit
 * return-type annotation's members if present and resolvable, else the
 * property names of its own `return { ... }` literal.
 */
export function extractHookSignature(source, hookName) {
  const sf = parseTs(source, 'hook.tsx');
  const fn = findNode(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === hookName) return true;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === hookName && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return true;
    return false;
  });
  if (!fn) return [];
  const fnLike = ts.isVariableDeclaration(fn) ? fn.initializer : fn;

  if (fnLike.type) {
    const viaType = typeMembersOf(sf, fnLike.type);
    if (viaType) return viaType;
  }
  return returnObjectMemberNames(fnLike.body);
}

// ---- exact + fuzzy matching ------------------------------------------------

const HANDLER_SUFFIXES = ['Change', 'Click', 'Submit', 'Toggle', 'Update', 'Select', 'Focus', 'Blur'];

/** Deterministic naming-convention candidates for a slot like `onCategoryChange`:
 * strip the leading `on` and a known trailing shape (Change/Click/...), then try the
 * usual setter-ish prefixes against the hook's own member names. E.g.
 * `onCategoryChange` -> subject `Category` -> tries `setCategory`, `toggleCategory`,
 * `handleCategory`. Not a generic string-distance fuzzy match (deliberately, to avoid
 * false-positive bindings) -- a fixed, explainable naming convention only. */
function fuzzyCandidateNames(slotName) {
  if (!/^on[A-Z]/.test(slotName)) return [];
  let subject = slotName.slice(2);
  for (const suffix of HANDLER_SUFFIXES) {
    if (subject.endsWith(suffix) && subject.length > suffix.length) {
      subject = subject.slice(0, -suffix.length);
      break;
    }
  }
  if (!subject) return [];
  return [`set${subject}`, `toggle${subject}`, `handle${subject}`];
}

/**
 * Match each page prop slot to a hook member: exact name match first, then
 * the deterministic fuzzy convention above. Returns one entry per slot,
 * always -- `handler: null` for a slot nothing matched (still reported,
 * never silently dropped).
 */
export function matchSlotsToHandlers(slotNames, hookMemberNames) {
  const hookSet = new Set(hookMemberNames);
  return slotNames.map((slotName) => {
    if (hookSet.has(slotName)) return { slot: slotName, handler: slotName, matchType: 'exact' };
    const fuzzy = fuzzyCandidateNames(slotName).find((c) => hookSet.has(c));
    if (fuzzy) return { slot: slotName, handler: fuzzy, matchType: 'fuzzy' };
    return { slot: slotName, handler: null, matchType: 'unmatched' };
  });
}

// ---- controller synthesis --------------------------------------------------

/** Resolve the {pagePropsFile, hookFile} to read for feature `feature`'s
 * `<name>` controller: from an (already schema-validated) Context Envelope's
 * `layers.page`/`layers.hook` entries if one is given, else this repo's own
 * naming convention. */
function resolveSourceFiles(root, name, feature, envelope) {
  const cap = pascalCase(name, 'Controller');
  if (envelope) {
    const { valid, errors } = validateEnvelope(envelope);
    if (!valid) throw usageError(`Invalid Context Envelope: ${errors.join('; ')}`);
    const pagePropsRel = (envelope.layers?.page || []).find((f) => f.endsWith('PageProps.ts'));
    const hookRel = (envelope.layers?.hook || [])[0];
    if (pagePropsRel && hookRel) {
      return {
        pagePropsFile: path.join(root, pagePropsRel),
        hookFile: path.join(root, hookRel),
        propsTypeName: `${cap}PageProps`,
        hookName: `use${cap}`,
      };
    }
    // Envelope given but missing the layers this needs -- fall through to convention
    // below rather than failing outright; the envelope may simply predate those steps.
  }
  const config = loadConfig(root);
  const featuresRoot = config.features?.root || 'features';
  return {
    pagePropsFile: path.join(root, featuresRoot, feature, 'pages', `${cap}PageProps.ts`),
    hookFile: path.join(root, featuresRoot, feature, 'hooks', `use${cap}.tsx`),
    propsTypeName: `${cap}PageProps`,
    hookName: `use${cap}`,
  };
}

function jsxPropFor(slot, isFunctionType) {
  if (slot.handler) return `      ${slot.slot}={${slot.handler}}`;
  const placeholder = isFunctionType
    ? `() => { /* TODO(controller): no hook handler matched "${slot.slot}" */ }`
    : `undefined as any /* TODO(controller): no hook handler matched "${slot.slot}" */`;
  return `      ${slot.slot}={${placeholder}}`;
}

/**
 * Synthesize `controllers/<Feature>Controller.tsx`, binding hook return
 * members to matching page prop slots (exact, then fuzzy).
 *
 * @param {string} root
 * @param {string} name - layer base name (will be capitalized).
 * @param {string} feature
 * @param {{envelope?: object}} [opts] - an optional Context Envelope (#7.1)
 *   to resolve the page/hook files from instead of this repo's naming
 *   convention.
 * @returns {{file: string, bindings: Array<{slot:string, handler:string|null, matchType:string}>}}
 */
export function generateController(root, name, feature, opts = {}) {
  const cap = pascalCase(name, 'Controller');
  const { pagePropsFile, hookFile, propsTypeName, hookName } = resolveSourceFiles(root, name, feature, opts.envelope);

  // #677: a feature that doesn't exist yet at all is scaffolded first (same
  // as every other create.* flow) -- it still refuses just below, since
  // --bind's own prerequisite (an already-generated page/hook) is a
  // different, already-clear requirement this doesn't create, but the
  // feature itself never silently stays a bare, unscaffolded folder.
  ensureFeatureExists(root, feature);
  if (!fs.existsSync(pagePropsFile)) throw usageError(`PageProps file not found: ${pagePropsFile} (run \`construct create page ... --from\` first).`);
  if (!fs.existsSync(hookFile)) throw usageError(`Hook file not found: ${hookFile} (generate the feature's hook first).`);
  const pageFile = path.join(path.dirname(pagePropsFile), `${cap}Page.tsx`);
  if (!fs.existsSync(pageFile)) throw usageError(`Page file not found: ${pageFile} (run \`construct create page ... --from\` first).`);

  const propsMembers = extractPropsInterfaceMembers(fs.readFileSync(pagePropsFile, 'utf8'), propsTypeName);
  const hookMembers = extractHookSignature(fs.readFileSync(hookFile, 'utf8'), hookName);
  // #348: an OPTIONAL slot (e.g. flowState, rendered as data-flow-state) nothing matches is left unwired, not stubbed.
  const optionalSlots = new Set(propsMembers.filter((m) => m.optional).map((m) => m.name));
  const bindings = matchSlotsToHandlers(propsMembers.map((m) => m.name), hookMembers).filter((b) => b.handler || !optionalSlots.has(b.slot));
  const functionTypeBySlot = new Map(propsMembers.map((m) => [m.name, m.isFunctionType]));

  const usedHandlers = [...new Set(bindings.filter((b) => b.handler).map((b) => b.handler))];
  const propsLines = bindings.map((b) => jsxPropFor(b, functionTypeBySlot.get(b.slot) ?? true));

  const config = loadConfig(root);
  const featuresRoot = config.features?.root || 'features';
  const source = [
    `import { ${cap}Page } from '../pages/${cap}Page';`,
    `import { ${hookName} } from '../hooks/${hookName}';`,
    '',
    `export function ${cap}Controller() {`,
    ...(usedHandlers.length ? [`  const { ${usedHandlers.join(', ')} } = ${hookName}();`] : []),
    '',
    `  return (`,
    `    <${cap}Page`,
    ...propsLines,
    `    />`,
    `  );`,
    `}`,
    '',
  ].join('\n');

  const dir = path.join(root, featuresRoot, feature, 'controllers');
  const file = path.join(dir, `${cap}Controller.tsx`);
  write(file, source);
  selfCheck(root, [file]);

  return { file, bindings };
}
