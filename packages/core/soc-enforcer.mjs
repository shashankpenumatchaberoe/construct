// Module 2 — Separation of Concerns Enforcer (Epics 2.1 and 2.2).
// Feature-slice boundary checks (SLICE-001, SLICE-002) and module-cohesion
// checks (MODULE-001, SOC-001, DRY-001). All violations are built through
// makeViolation() from ./diagnostics.mjs with module: 'separation-of-concerns'.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DEFAULT_RULES, DEFAULT_LAYERS } from './config.mjs';
import { walk, rel } from './fs.mjs';
import { makeViolation } from './diagnostics.mjs';
import { exceptionApplies } from './exceptions.mjs';
import { parseToAst } from '../../packages/ast/index.mjs';
import { isNonLayerPath } from './nonLayer.mjs';

const ext = new Set(['.ts', '.tsx', '.js', '.jsx']);

// Layer names (not folder names) that make up a normal feature slice's required folder set --
// mirrors DEFAULT_LAYERS' feature-internal layers. `route` is excluded (it has no per-feature
// folder: it lives outside features/, in app/ or src/App.tsx) and `expression` is excluded (see
// RECOGNIZED_EXTRA_LAYER_NAMES below).
const REQUIRED_LAYER_NAMES = ['controller', 'workflow', 'hook', 'domain', 'service', 'page', 'component'];

// #517 -- 'expression' (#503's additive layer -- architecture-enforcer.mjs / config.mjs's
// DEFAULT_LAYERS) is a real, recognized layer, but is deliberately NOT in REQUIRED_LAYER_NAMES:
// that list also drives checkSkeleton's SLICE-001 "every feature must have all of these folders"
// scaffold check, below, and requiring an expressions/ folder on every pre-existing feature that
// has never opted into this optional layer would be exactly the non-additive regression #500
// phase 1 rules out (no existing project has one today). This name is consulted ONLY by
// checkOwnership's "is this a known folder" SOC-001 check, so a feature that does adopt an
// expressions/ folder (e.g. via `construct refactor extract-expression`, #517) is recognized
// without every other feature being forced to grow the folder too.
const RECOGNIZED_EXTRA_LAYER_NAMES = ['expression'];

/** Folder token (e.g. "controllers") a layer's pattern lives under, mirroring
 * architecture-enforcer.mjs's own (unexported) layerFolder helper -- kept local to this file to
 * avoid a cross-enforcer dependency; both derive the same regex from a layer's `pattern`. */
function layerFolderOf(def) {
  return def?.pattern?.match(/features\/\*\/([^/]+)\//)?.[1];
}

// Static, framework-default folder list -- exported for backward compatibility with anything
// that read this constant before #699. checkSkeleton/checkOwnership below no longer use it
// directly: they read the PROJECT's own (possibly `layers:`-overridden) layer graph instead, via
// requiredFoldersOf/knownFoldersOf, so a project with e.g. a singular `service/` folder is
// recognized instead of being forced into the plural framework default.
export const LAYER_FOLDERS = REQUIRED_LAYER_NAMES.map((name) => layerFolderOf(DEFAULT_LAYERS[name])).filter(Boolean);

/** The folders every feature slice of THIS project is expected to have, per its own layer graph
 * (config.layers, which already reflects any `layers:` override in architecture.yml -- #699). */
function requiredFoldersOf(config) {
  return REQUIRED_LAYER_NAMES.map((name) => layerFolderOf(config.layers?.[name])).filter(Boolean);
}

/** Every folder name checkOwnership recognizes as a real architectural owner for THIS project:
 * the required layers plus the optional/additive ones (RECOGNIZED_EXTRA_LAYER_NAMES), again read
 * from the project's own (possibly overridden) layer graph. */
function knownFoldersOf(config) {
  return [...REQUIRED_LAYER_NAMES, ...RECOGNIZED_EXTRA_LAYER_NAMES].map((name) => layerFolderOf(config.layers?.[name])).filter(Boolean);
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripExt = (p) => p.replace(/\.(tsx|ts|jsx|js)$/, '');

// ---------------------------------------------------------------------------
// Config-driven severity/exceptions, wired through the shared diagnostics
// contract.
// ---------------------------------------------------------------------------
function severityFor(config, rule) {
  const entry = config.rules?.[rule];
  if (typeof entry === 'string') return entry;
  return entry?.severity ?? DEFAULT_RULES[rule]?.severity ?? 'error';
}

function pushViolation(config, out, opts) {
  const severity = severityFor(config, opts.rule);
  if (severity === 'off' || exceptionApplies(config, opts.rule, opts.file)) return;
  out.push(makeViolation({ module: 'separation-of-concerns', severity, ...opts }));
}

function featuresRootOf(config) {
  return config.features?.root || 'features';
}

function listFeatureDirs(root, featuresRoot) {
  const base = path.join(root, featuresRoot);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// index.ts export parsing — shared by SLICE-002 detection, isPublicPath, and
// the API composer (packages/core/api-composer.mjs) which imports parseIndexExports.
// ---------------------------------------------------------------------------
const EXPORT_FROM_RE = /export\s+(type\s+)?(\*|\{[^}]*\})\s*from\s*(['"])(.+?)\3\s*;?/g;

export function parseIndexExports(source) {
  const out = [];
  for (const m of source.matchAll(EXPORT_FROM_RE)) {
    out.push({
      specifier: m[4],
      isWildcard: m[2] === '*',
      isType: Boolean(m[1]),
      line: source.slice(0, m.index).split('\n').length,
      raw: m[0].trim(),
    });
  }
  return out;
}

/**
 * isPublicPath(root, filePath) -> boolean
 * A path is public only if it is re-exported — directly, or via `export *` —
 * from its feature's index.ts. Paths outside the configured features root are
 * considered "not applicable" and return true. Stable signature: reused by
 * other Construct modules (e.g. the API composer) to classify files.
 */
export function isPublicPath(root, filePath) {
  const config = loadConfig(root);
  const featuresRoot = featuresRootOf(config);
  const relFile = path.isAbsolute(filePath) ? rel(root, filePath) : filePath.replaceAll(path.sep, '/');

  const m = relFile.match(new RegExp(`^${escapeRegex(featuresRoot)}/([^/]+)/(.*)$`));
  if (!m) return true; // not under a feature slice — no restriction applies
  const [, featureName, restPath] = m;
  const restNoExt = stripExt(restPath);
  if (restNoExt === 'index') return true; // the index.ts itself

  const indexPath = path.join(root, featuresRoot, featureName, 'index.ts');
  if (!fs.existsSync(indexPath)) return false;
  const exportsList = parseIndexExports(fs.readFileSync(indexPath, 'utf8'));

  return exportsList.some((e) => {
    const resolved = path.posix.normalize(e.specifier.replace(/^\.\//, ''));
    if (resolved === restNoExt) return true;
    if (e.isWildcard && (restNoExt === resolved || restNoExt.startsWith(resolved + '/'))) return true;
    return false;
  });
}

function resolveSpecifier(currentRelFile, spec, featuresRoot) {
  if (spec.startsWith('.')) {
    const dir = path.posix.dirname(currentRelFile);
    return path.posix.normalize(path.posix.join(dir, spec));
  }
  if (spec.startsWith('@features/')) {
    return path.posix.normalize(path.posix.join(featuresRoot, spec.slice('@features/'.length)));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Epic 2.1 — Feature Slice Boundary Enforcer
// ---------------------------------------------------------------------------
function checkSkeleton(config, out, root, featuresRoot, name) {
  const featureDir = path.join(root, featuresRoot, name);
  const missing = requiredFoldersOf(config).filter((f) => !fs.existsSync(path.join(featureDir, f)));
  if (!missing.length) return;
  pushViolation(config, out, {
    rule: 'SLICE-001',
    file: `${featuresRoot}/${name}/`,
    line: 1,
    message: `Feature "${name}" is missing expected folder(s): ${missing.join(', ')}.`,
    why: 'A feature slice must expose a full, predictable set of layer folders so ownership stays unambiguous.',
    expected: missing.map((f) => `${featuresRoot}/${name}/${f}/`),
    suggestedFix: `Run: construct feature create ${name}`,
  });
}

const IMPORT_RE = /(?:import\s+(?:type\s+)?[\s\S]*?from\s*|import\s*\()(['"])(.*?)\1/g;

function checkCrossFeatureImports(config, out, root, featuresRoot, relFile, src) {
  const currentFeature = relFile.match(new RegExp(`^${escapeRegex(featuresRoot)}/([^/]+)/`))?.[1];
  if (!currentFeature) return;
  for (const m of src.matchAll(IMPORT_RE)) {
    const resolved = resolveSpecifier(relFile, m[2], featuresRoot);
    if (!resolved) continue;
    const other = resolved.match(new RegExp(`^${escapeRegex(featuresRoot)}/([^/]+)/(.*)$`));
    if (!other) continue;
    const [, otherFeature, restPath] = other;
    if (otherFeature === currentFeature) continue;
    if (isPublicPath(root, resolved)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    pushViolation(config, out, {
      rule: 'SLICE-002',
      file: relFile,
      line,
      message: `Cross-feature import reaches into "${otherFeature}" internals (${restPath}).`,
      why: 'Features may only consume another feature through its public index API.',
      expected: [`${featuresRoot}/${otherFeature}/index.ts`],
      suggestedFix: `Import from ${featuresRoot}/${otherFeature}/index.ts instead — export the needed symbol there first if it isn't already public.`,
    });
  }
}

// ---------------------------------------------------------------------------
// SLICE-004 (#509/#500 phase 1) — a component or provider re-exported from a feature's index.ts
// for cross-feature use must be a distinct wrapper, not a raw re-export/alias of the internal
// unit. Extends this file's existing index.ts-export-parsing machinery (parseIndexExports /
// isPublicPath, above) rather than building a parallel mechanism -- reads the SAME index.ts source
// through the real AST (parseToAst, already used by countPrimaryExports below) to tell "this export
// forwards the internal function/component AS-IS" from "this export is a genuinely new function
// that happens to wrap it".
//
// Scope: EVERY `components/` export is in scope (a component is always the release point #509
// describes). A `hooks/` export is in scope only when it looks like a Provider (`use<Name>Provider`,
// the same naming convention architecture-enforcer.mjs's HOOK-002/PAGE-006 rely on) -- an ordinary
// hook re-exported directly is a pre-existing, legitimate pattern (see fixtures/soc-clean's
// `export * from './hooks/useAlpha'`) and stays untouched.
const PROVIDER_HOOK_NAME_RE = /^use[A-Z]\w*Provider$/;
const isProviderHookName = (name) => typeof name === 'string' && PROVIDER_HOOK_NAME_RE.test(name);
const specifierBaseName = (specifier) => (specifier.split('/').pop() || '').replace(/\.(tsx?|jsx?)$/, '');

/** 'components' | 'hooks' | null — which internal-unit folder of the CURRENT feature a resolved,
 * feature-relative specifier path (see resolveSpecifier) sits under. */
function internalUnitKind(resolved, featuresRoot) {
  const m = resolved && resolved.match(new RegExp(`^${escapeRegex(featuresRoot)}/[^/]+/(components|hooks)/`));
  return m ? m[1] : null;
}

/** Does SLICE-004 apply to an export whose origin is `origin` (`{kind, baseName}`), given `name`
 * (the specific exported/local identifier, when one applies)? See the scope note above. */
function slice004Applies(origin, name) {
  if (!origin) return false;
  if (origin.kind === 'components') return true;
  return isProviderHookName(name) || isProviderHookName(origin.baseName);
}

function checkDistinctWrapperExports(config, out, root, featuresRoot, relFile, src) {
  let ast;
  try {
    ast = parseToAst(src);
  } catch {
    return; // a syntax error is reported elsewhere, not as a SLICE-004 finding
  }

  const report = (exportedName, kind, line) => pushViolation(config, out, {
    rule: 'SLICE-004',
    file: relFile,
    line,
    message: `"${exportedName}" is re-exported directly from ${kind}/ without a distinct wrapper.`,
    why: 'A component or provider shared across features must go through a distinct wrapper at the public boundary, so the internal unit stays free to change without breaking outside consumers.',
    expected: [`export const ${exportedName} = (props) => <Internal {...props} /> // a real wrapping function`],
    suggestedFix: `Wrap the ${kind === 'hooks' ? 'provider hook' : 'component'} in a distinct function in ${relFile} instead of re-exporting it directly.`,
  });

  // local binding name -> its import origin, for every plain (value) import resolving under this
  // feature's components/ or hooks/.
  const importOrigin = new Map();
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue;
    const resolved = resolveSpecifier(relFile, node.source.value, featuresRoot);
    const kind = internalUnitKind(resolved, featuresRoot);
    if (!kind) continue;
    const baseName = specifierBaseName(node.source.value);
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' || spec.type === 'ImportDefaultSpecifier') {
        importOrigin.set(spec.local.name, { kind, baseName });
      }
    }
  }

  // Top-level `const X = <init>` initializers, to trace a bare `export { B }` (no `from`) back to
  // what B was actually declared as.
  const localInit = new Map();
  for (const node of ast.body) {
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') localInit.set(d.id.name, d.init);
      }
    }
  }

  const isWrapperFn = (node) => node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression');

  /** Resolve `name` to its ultimate import origin ONLY through a bare alias chain (Identifier ->
   * Identifier -> ... -> an import) with no wrapping function anywhere along the way -- a real
   * function found at any point means "distinct wrapper", so tracing stops (returns null) there. */
  function aliasOrigin(name, seen = new Set()) {
    if (seen.has(name)) return null;
    seen.add(name);
    if (importOrigin.has(name)) return importOrigin.get(name);
    const init = localInit.get(name);
    if (init && init.type === 'Identifier') return aliasOrigin(init.name, seen);
    return null; // undeclared, or a real (non-alias) value -- e.g. a wrapper function
  }

  for (const node of ast.body) {
    if (node.type === 'ExportAllDeclaration') {
      const resolved = resolveSpecifier(relFile, node.source.value, featuresRoot);
      const kind = internalUnitKind(resolved, featuresRoot);
      if (!kind) continue;
      const baseName = specifierBaseName(node.source.value);
      if (slice004Applies({ kind, baseName }, baseName)) report(baseName, kind, node.loc.start.line);
      continue;
    }

    if (node.type !== 'ExportNamedDeclaration') continue;
    const line = node.loc.start.line;

    if (node.source) {
      // `export { A as B } from '...'` / `export { A } from '...'` -- a from-export can never be
      // a wrapper (the syntax has no room to call anything); it is always a bare forward.
      const resolved = resolveSpecifier(relFile, node.source.value, featuresRoot);
      const kind = internalUnitKind(resolved, featuresRoot);
      if (!kind) continue;
      const baseName = specifierBaseName(node.source.value);
      for (const spec of node.specifiers || []) {
        const originName = spec.local?.name;
        const exportedName = spec.exported?.name ?? spec.exported?.value ?? originName;
        if (slice004Applies({ kind, baseName }, originName)) report(exportedName, kind, line);
      }
      continue;
    }

    if (node.declaration?.type === 'VariableDeclaration') {
      // `export const B = <init>;`
      for (const d of node.declaration.declarations) {
        if (d.id.type !== 'Identifier' || isWrapperFn(d.init)) continue; // a real wrapper -- passes
        if (d.init?.type === 'Identifier') {
          const origin = aliasOrigin(d.init.name);
          if (slice004Applies(origin, d.init.name)) report(d.id.name, origin.kind, line);
        }
      }
      continue;
    }

    if (node.specifiers?.length) {
      // `export { A }` / `export { A as B };` (no `from` -- refers to a local binding)
      for (const spec of node.specifiers) {
        const localName = spec.local?.name;
        if (!localName) continue;
        const exportedName = spec.exported?.name ?? spec.exported?.value ?? localName;
        const origin = aliasOrigin(localName);
        if (slice004Applies(origin, localName)) report(exportedName, origin.kind, line);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Epic 2.2 — Module Cohesion Enforcer
// ---------------------------------------------------------------------------
/** Names bound by a declaration pattern (`const { a, b: c } = x`, `const [d] = y`). */
function patternNames(node, out) {
  if (!node) return;
  if (node.type === 'Identifier') out.push(node.name);
  else if (node.type === 'ObjectPattern') node.properties.forEach((p) => patternNames(p.type === 'RestElement' ? p.argument : p.value, out));
  else if (node.type === 'ArrayPattern') node.elements.forEach((e) => patternNames(e, out));
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
}

/**
 * countPrimaryExports(source) -> [{name, line}]
 * Top-level exported function/class/const/let/var/default/`export { }` counter,
 * in source order. Reads the real AST (packages/ast), so a comma inside a generic
 * (`Record<A, B>`) is not a second declarator and an `export` written inside a
 * comment or string is not an export (#326).
 * Re-exports (`export * from`, `export {..} from`) never count — they aggregate
 * an API, they don't declare a new responsibility in this file. Type-only
 * declarations (`export type/interface/enum`, `export type { }`) and ambient
 * `export declare` are not counted either, as before. A file that does not parse
 * yields no exports (a syntax error is reported elsewhere, not as a cohesion error).
 */
export function countPrimaryExports(source) {
  let ast;
  try {
    ast = parseToAst(source);
  } catch {
    return [];
  }
  const results = [];
  for (const node of ast.body) {
    const line = node.loc.start.line;
    if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      const named = (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id;
      results.push({ name: named ? d.id.name : 'default', line });
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.exportKind === 'type' || node.source) continue;
      const d = node.declaration;
      if (d) {
        if (d.declare) continue;
        if (d.type === 'VariableDeclaration') {
          const names = [];
          d.declarations.forEach((x) => patternNames(x.id, names));
          names.forEach((name) => results.push({ name, line }));
        } else if ((d.type === 'FunctionDeclaration' || d.type === 'TSDeclareFunction' || d.type === 'ClassDeclaration') && d.id) {
          results.push({ name: d.id.name, line });
        }
      } else {
        for (const spec of node.specifiers) {
          const name = spec.exported?.name ?? spec.exported?.value;
          if (name) results.push({ name, line });
        }
      }
    }
  }
  return results;
}

function checkModuleCohesion(config, out, relFile, src) {
  // Threshold is configurable via architecture.yml as a nested field on the
  // rule's own entry, per config.mjs's uniform rules-map contract:
  //   rules:
  //     MODULE-001:
  //       threshold: 5
  const threshold = Number(config.rules?.['MODULE-001']?.threshold) || 3;
  const exported = countPrimaryExports(src);
  if (exported.length <= threshold) return;
  const overflow = exported.slice(threshold).map((e) => e.name);
  pushViolation(config, out, {
    rule: 'MODULE-001',
    file: relFile,
    line: exported[0]?.line || 1,
    message: `File declares ${exported.length} primary exports (threshold ${threshold}).`,
    why: 'One primary module per file keeps files single-purpose and easy to navigate.',
    expected: [`${threshold} or fewer primary exports per file`],
    suggestedFix: `Split out ${overflow.join(', ')} into their own file(s).`,
  });
}

function checkOwnership(config, out, root, featuresRoot, featureName) {
  const featureDir = path.join(root, featuresRoot, featureName);
  const known = knownFoldersOf(config);
  const knownSet = new Set(known);
  for (const p of walk(featureDir).filter((p) => ext.has(path.extname(p)) && !isNonLayerPath(root, p, config.nonLayer))) {
    const relToFeature = rel(featureDir, p);
    const segments = relToFeature.split('/');
    const top = segments[0];
    const relFull = rel(root, p);
    if (segments.length === 1) {
      if (top === 'index.ts' || top === 'types.ts') continue;
      pushViolation(config, out, {
        rule: 'SOC-001',
        file: relFull,
        line: 1,
        message: `File "${top}" sits directly in the feature root without a recognized role.`,
        why: 'Every responsibility needs an architectural owner.',
        expected: [...known, 'shared/', 'index.ts', 'types.ts'],
        suggestedFix: `Move ${relFull} into a known layer folder (e.g. ${featuresRoot}/${featureName}/domain/) or ${featuresRoot}/${featureName}/shared/.`,
      });
      continue;
    }
    if (top === 'shared' || knownSet.has(top)) continue;
    pushViolation(config, out, {
      rule: 'SOC-001',
      file: relFull,
      line: 1,
      message: `File is under unrecognized folder "${top}/".`,
      why: 'Every responsibility needs an architectural owner (a known layer folder or an explicit shared/).',
      expected: [...known, 'shared/'],
      suggestedFix: `Move ${relFull} into one of ${known.join('/')} or ${featuresRoot}/${featureName}/shared/.`,
    });
  }
}

// DRY-001 — cheap, approximate near-duplicate heuristic. Not a clone detector.
const MIN_BODY_LEN = 60;
const FUNCTION_BLOCK_RE = /(?:function\s*[A-Za-z_$][\w$]*\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g;

function findMatchingBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractFunctionBlocks(src) {
  const blocks = [];
  for (const m of src.matchAll(FUNCTION_BLOCK_RE)) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingBrace(src, openIdx);
    if (closeIdx > openIdx) blocks.push({ text: src.slice(openIdx, closeIdx + 1), line: src.slice(0, m.index).split('\n').length });
  }
  return blocks;
}

function normalizeBody(body) {
  return body
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/["'`][^"'`]*["'`]/g, 'STR')
    .replace(/[A-Za-z_$][\w$]*/g, 'ID')
    .replace(/\s+/g, '');
}

// #338: a body only counts as business LOGIC if it decides or computes something. A thin wiring
// function (`const {a,b} = useX(); return <Page a={build(a)} />`) has the same shape as every other
// one, and identifier erasure makes all of them collide; it has no rule to keep single-sourced.
// Identifiers stay erased on purpose: a copy-pasted function with renamed variables is exactly
// what DRY-001 exists to catch. Heuristic on the comment/string-stripped text: a control-flow
// keyword, a ternary, a logical operator, or a spaced arithmetic/comparison operator. Anything
// else is pure wiring and is skipped.
const LOGIC_RE = /\b(?:if|else|for|while|do|switch|case|try|catch|throw)\b|\?(?![.:])|&&|\|\||\?\?|\s(?:[+\-*%]|[<>]=?|[!=]==?)\s/;

function hasLogic(body) {
  const stripped = body
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/["'`][^"'`]*["'`]/g, 'STR');
  return LOGIC_RE.test(stripped);
}

function checkDuplication(config, out, root, featuresRoot, files) {
  const bodies = [];
  for (const p of files) {
    const rp = rel(root, p);
    const feature = rp.match(new RegExp(`^${escapeRegex(featuresRoot)}/([^/]+)/`))?.[1];
    if (!feature) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const block of extractFunctionBlocks(src)) {
      const norm = normalizeBody(block.text);
      if (norm.length < MIN_BODY_LEN) continue;
      if (!hasLogic(block.text)) continue;
      bodies.push({ feature, file: rp, line: block.line, norm });
    }
  }
  const groups = new Map();
  for (const b of bodies) {
    if (!groups.has(b.norm)) groups.set(b.norm, []);
    groups.get(b.norm).push(b);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((g) => g.feature)).size < 2) continue;
    const [original, ...dupes] = group;
    for (const dup of dupes) {
      pushViolation(config, out, {
        rule: 'DRY-001',
        file: dup.file,
        line: dup.line,
        message: 'Near-identical business logic found in another feature.',
        why: 'Duplicated logic drifts silently and breaks single-source-of-truth for business rules.',
        expected: ['shared/', 'a common domain/service module'],
        suggestedFix: `This looks like a near-duplicate of ${original.file}:${original.line}. Consider extracting the shared logic into a shared/ module.`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Single entry point
// ---------------------------------------------------------------------------
/**
 * Check a project against the separation-of-concerns rules (slices, layers, imports, purity) and return every violation.
 *
 * @param {string} root Project root.
 * @returns {any} The violations (see `makeViolation`); empty when the project is clean.
 *
 * @example
 * validateSeparationOfConcerns(process.cwd()).filter((v) => v.severity === 'error');
 */
export function validateSeparationOfConcerns(root) {
  const config = loadConfig(root);
  const featuresRoot = featuresRootOf(config);
  const out = [];

  if (!fs.existsSync(path.join(root, featuresRoot))) {
    pushViolation(config, out, {
      rule: 'SLICE-001',
      file: `${featuresRoot}/`,
      line: 1,
      message: 'Missing feature root.',
      why: 'Feature slices are mandatory for isolation and ownership.',
      expected: [`${featuresRoot}/<feature>`],
      suggestedFix: 'Run: construct feature create <name>',
    });
    return { violations: out };
  }

  const featureNames = listFeatureDirs(root, featuresRoot);
  for (const name of featureNames) checkSkeleton(config, out, root, featuresRoot, name);

  const featureFiles = walk(root)
    .filter((p) => ext.has(path.extname(p)))
    .filter((p) => rel(root, p).startsWith(featuresRoot + '/'))
    .filter((p) => !isNonLayerPath(root, p, config.nonLayer)); // #348: declared non-layer paths (tests) sit outside the graph

  for (const p of featureFiles) {
    const r = rel(root, p);
    const src = fs.readFileSync(p, 'utf8');
    checkCrossFeatureImports(config, out, root, featuresRoot, r, src);
    checkModuleCohesion(config, out, r, src);
    if (path.basename(r) === 'index.ts') checkDistinctWrapperExports(config, out, root, featuresRoot, r, src);
  }
  for (const name of featureNames) checkOwnership(config, out, root, featuresRoot, name);
  checkDuplication(config, out, root, featuresRoot, featureFiles);

  return { violations: out };
}
