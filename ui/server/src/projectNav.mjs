// Click-to-navigate (#321): the server half. Given a file the person is looking at, work out which of
// its references lead to another file INSIDE THE PROJECT and hand back only root-relative paths.
//
// This reads files on a machine that runs commands, so the rules are strict and live in ONE place:
//   - a page is opened only through resolvePageFile (the editor's own pages/ guard);
//   - every later hop is `{from, ref}`: the target is DERIVED from an import in `from`, never taken
//     from the client. The client never names the file it wants to read, only a reference in a file;
//   - `from` and every target must be a plain relative path whose REAL path (symlinks followed) is
//     inside the project root's real path, a regular source file (.ts/.tsx/.js/.jsx), not under
//     node_modules and not oversized. `..`, absolute paths, and symlinks that leave the root all
//     come out as "unresolved" and are never read.
// An unresolved reference is not an error: it is `{target: null, reason}` and the client shows it as
// plain text. Each one is also logged (info) to the Diagnostics log so it stays diagnosable.
import fs from 'node:fs';
import path from 'node:path';
import { collectReferences, exportOrigin } from '../../../packages/engine/referenceLinks.mjs';
import { loadLayerGraph, classifyFile } from '../../../packages/core/architecture-graph.mjs';
import { resolvePageFile, featuresRootOf, PagesEditorError } from './pagesEditor.mjs';
import { serverLog } from './logBuffer.mjs';

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const MAX_BYTES = 1024 * 1024;
const MAX_HOPS = 8; // barrel re-export chain depth

const toPosix = (p) => p.split(path.sep).join('/');
const isInside = (realRoot, realPath) => realPath === realRoot || realPath.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
const hasNodeModules = (rel) => rel.split(/[\\/]/).includes('node_modules');

/** Real (symlink-resolved) path of `abs` iff it is a regular source file inside `root`, else null. */
function safeRealFile(root, abs) {
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(abs);
  } catch {
    return null;
  }
  if (!isInside(realRoot, real)) return null;
  const relFromRoot = path.relative(realRoot, real);
  if (!relFromRoot || hasNodeModules(relFromRoot) || !SOURCE_EXTENSIONS.includes(path.extname(real))) return null;
  try {
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
  } catch {
    return null;
  }
  return real;
}

/** A client-supplied root-relative path -> real absolute path, or null (never throws, never reads). */
export function resolveProjectFile(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  if (rel.split(/[\\/]/).includes('..')) return null;
  return safeRealFile(root, path.resolve(root, rel));
}

/** Relative specifier as written in `fromReal` -> real file inside the project, or null. */
function resolveSpecifier(root, fromReal, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromReal), specifier);
  const candidates = SOURCE_EXTENSIONS.includes(path.extname(base))
    ? [base]
    : [...SOURCE_EXTENSIONS.map((e) => base + e), ...SOURCE_EXTENSIONS.map((e) => path.join(base, 'index' + e))];
  for (const c of candidates) {
    const real = safeRealFile(root, c);
    if (real) return real;
  }
  return null;
}

/** Follow `name` exported by `fileReal` through re-exports (barrels) to the file that declares it. */
function followExport(root, fileReal, name, seen = new Set(), depth = 0) {
  if (depth > MAX_HOPS || seen.has(`${fileReal}#${name}`)) return null;
  seen.add(`${fileReal}#${name}`);
  let origin;
  try {
    origin = exportOrigin(fs.readFileSync(fileReal, 'utf8'), name);
  } catch {
    return null;
  }
  if (!origin) return null;
  if (origin.kind === 'local') return fileReal;
  if (origin.kind === 'reexport') {
    const next = resolveSpecifier(root, fileReal, origin.source);
    if (!next) return null;
    return origin.importedName === '*' ? next : followExport(root, next, origin.importedName, seen, depth + 1);
  }
  for (const s of origin.sources) {
    const next = resolveSpecifier(root, fileReal, s);
    const hit = next && followExport(root, next, name, seen, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function featureOf(root, rel) {
  const base = featuresRootOf(root);
  return rel.startsWith(`${base}/`) ? rel.slice(base.length + 1).split('/')[0] || null : null;
}

function relationOf(root, graph, fromRel, toRel) {
  const fromLayer = classifyFile(fromRel, graph);
  const toLayer = classifyFile(toRel, graph);
  const fromFeature = featureOf(root, fromRel);
  const toFeature = featureOf(root, toRel);
  const crossFeature = Boolean(fromFeature && toFeature && fromFeature !== toFeature);
  const layers = `${fromLayer || 'file'} -> ${toLayer || 'file'}`;
  const label = crossFeature ? `${fromFeature} -> ${toFeature}` : layers;
  const description = `a ${toLayer || 'file'}${toFeature ? ` in the ${toFeature} feature` : ''}`;
  return { label, layers, fromLayer, toLayer, fromFeature, toFeature, crossFeature, description };
}

const noFileReason = (ref) => (ref.specifier && !ref.specifier.startsWith('.')
  ? `${ref.specifier} is a package outside this project, so there is no project file to open.`
  : `Could not find the file that defines ${ref.name} inside this project.`);

/** Every reference in `fromReal` with its target (root-relative) or null + a plain reason. Logs the null ones. */
function resolveAll(root, fromReal, source, { log = true } = {}) {
  const realRoot = fs.realpathSync(root);
  const graph = loadLayerGraph(root);
  const fromRel = toPosix(path.relative(realRoot, fromReal));
  return collectReferences(source).map((ref) => {
    const base = { name: ref.name, kind: ref.kind, start: ref.start, end: ref.end, line: ref.line, column: ref.column };
    let targetReal = null;
    let reason = ref.reason || null;
    if (!reason) {
      const modFile = resolveSpecifier(root, fromReal, ref.specifier);
      if (modFile) targetReal = ref.imported === '*' ? modFile : followExport(root, modFile, ref.imported);
      if (!targetReal) reason = noFileReason(ref);
    }
    if (!targetReal || targetReal === fromReal) {
      const why = reason || `${ref.name} refers to the file it is already in.`;
      if (log) serverLog.record('navigation', 'info', `${fromRel}:${ref.line} ${ref.name} is not a link: ${why}`);
      return { ...base, target: null, reason: why };
    }
    const target = toPosix(path.relative(realRoot, targetReal));
    return { ...base, target, reason: null, relation: relationOf(root, graph, fromRel, target) };
  });
}

function buildView(root, real, extra = {}) {
  const realRoot = fs.realpathSync(root);
  const source = fs.readFileSync(real, 'utf8');
  return { ok: true, path: toPosix(path.relative(realRoot, real)), source, references: resolveAll(root, real, source), ...extra };
}

/** First view: a page, through the editor's own pages/ guard. */
export function viewPage(root, feature, file) {
  const { absPath } = resolvePageFile(root, feature, file);
  const real = safeRealFile(root, absPath);
  if (!real) throw new PagesEditorError('That page is not a readable source file inside the project.', { status: 400 });
  return buildView(root, real);
}

/** A file the flow view drew (#328). The caller has already checked `rel` against that flow's own file
 * list; the shared root-relative guard (no "..", no absolute, real path inside the root) runs again here. */
export function viewProjectFile(root, rel) {
  const real = resolveProjectFile(root, rel);
  if (!real) throw new PagesEditorError('That file is not a readable source file inside the project.', { status: 400 });
  return buildView(root, real);
}

/**
 * Follow one reference: `from` (root-relative path of the file being viewed) and `ref` (the name of a
 * reference in it, plus optionally its character offset `start` when the name occurs many times). The
 * target is derived here from the AST -- if the reference does not resolve, this refuses.
 */
export function openReference(root, from, ref, start) {
  const fromReal = resolveProjectFile(root, from);
  if (!fromReal) throw new PagesEditorError('That file is not a source file inside the project.', { status: 400 });
  if (typeof ref !== 'string' || !ref) throw new PagesEditorError('ref is required.', { status: 400 });
  const source = fs.readFileSync(fromReal, 'utf8');
  const refs = resolveAll(root, fromReal, source, { log: false }).filter((r) => r.name === ref && r.target);
  const pick = (Number.isInteger(start) && refs.find((r) => r.start === start)) || refs[0];
  if (!pick) throw new PagesEditorError(`"${ref}" does not lead to a file inside the project.`, { status: 404 });
  const targetReal = resolveProjectFile(root, pick.target); // re-check: never read on trust
  if (!targetReal) throw new PagesEditorError(`"${ref}" does not lead to a file inside the project.`, { status: 404 });
  return buildView(root, targetReal, { name: ref, relation: pick.relation });
}

/**
 * Open a bare project file at a known position (#558): unlike `openReference`, there is no `from` file
 * and no reference name to derive a target from -- the caller (the live preview's "Show in source"
 * button) already has the exact project file and position, resolved client-side from the framed app's
 * own error stack / `data-cx-src` annotation. Same containment as every other nav read here:
 * `resolveProjectFile`'s real-path-inside-root, non-node_modules, source-extension guard.
 */
export function openSourceLocation(root, file, line, column) {
  const real = resolveProjectFile(root, file);
  if (!real) throw new PagesEditorError('That file is not a source file inside the project.', { status: 400 });
  const pos = {
    line: Number.isInteger(line) && line > 0 ? line : null,
    column: Number.isInteger(column) && column > 0 ? column : null,
  };
  return buildView(root, real, pos);
}
