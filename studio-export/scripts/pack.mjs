#!/usr/bin/env node
// Assembles packages/studio/vendor/media/ (a COPY of packages/tools/media: *.mjs, *.sh, *.py, nothing from node_modules or
// caches; nothing is rewritten or moved) and, unless --vendor-only, runs `npm pack`. Fails, and removes the vendored copy, when a
// vendored file reaches outside vendor/ (a relative import or a `../../` path construction) or imports a package that
// package.json does not declare, so a tarball that would break on a machine without this repository is never produced.
//
//   node packages/studio/scripts/pack.mjs [--vendor-only] [--source DIR] [--vendor DIR] [--out DIR]
//   npm run pack --workspace=packages/studio
//
// A line may opt out of the `../` check with `studio-pack: escape-ok` in a trailing comment; use it only where an environment
// override replaces the escaping path in the packed build (see REPO in packages/tools/media/lib.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const DEFAULT_SOURCE = path.resolve(PACKAGE_ROOT, '..', 'tools', 'media');
export const DEFAULT_VENDOR = path.join(PACKAGE_ROOT, 'vendor');
export const VENDORED_EXT = new Set(['.mjs', '.sh', '.py']);
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'test', 'tests']);
const ESCAPE_OK = 'studio-pack: escape-ok';

export class PackError extends Error {
  constructor(violations) {
    super(`vendored media tools are not self-contained (${violations.length} problem${violations.length === 1 ? '' : 's'}):\n  ${violations.join('\n  ')}`);
    this.violations = violations;
  }
}

/** Every file to vendor under `dir` (relative paths, sorted); skips node_modules, caches, dot-directories and test directories. */
export function listVendorable(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(r); }
      else if (e.isFile() && VENDORED_EXT.has(path.extname(e.name))) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

const bareName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const IMPORT_RES = [
  /\bimport\s+(?:[^'"();]*?\sfrom\s+)?['"]([^'"]+)['"]/g, // import x from 'y'; import 'y'
  /\bexport\s+[^'"();]*?\sfrom\s+['"]([^'"]+)['"]/g, // export ... from 'y'
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // import('y')
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // require('y')
];
const UPS_RE = /(?<![.\w])\.\.(?:[/\\]\.\.)*(?![.\w])/g; // '..', '../..', '../../x' inside one string
const ARG_RUN_RE = /['"]\.\.['"](?:\s*,\s*['"]\.\.['"])*/g; // path.resolve(HERE, '..', '..', '..')
const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|#(?!!))/.test(line);

/**
 * Problems in one vendored file, as strings "file:line: what". `vendorRoot` is the directory the file must stay inside,
 * `allowedDeps` the package names it may import besides Node built-ins.
 */
export function scanFile(file, { vendorRoot, allowedDeps }) {
  const problems = [];
  const rel = path.relative(vendorRoot, file);
  const depth = path.dirname(rel).split(path.sep).filter((s) => s && s !== '.').length; // ups a file may climb: up to vendorRoot itself
  const isCode = /\.(mjs|js|cjs)$/.test(file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  lines.forEach((line, i) => {
    if (isCommentLine(line) || line.includes(ESCAPE_OK)) return;
    const at = `${rel}:${i + 1}`;
    let importLine = false;
    if (isCode) {
      for (const re of IMPORT_RES) {
        for (const m of line.matchAll(re)) {
          importLine = true;
          const spec = m[1];
          if (spec.startsWith('node:') || builtins.has(spec)) continue;
          if (spec.startsWith('.')) {
            const target = path.resolve(path.dirname(file), spec);
            if (target !== vendorRoot && !target.startsWith(vendorRoot + path.sep)) problems.push(`${at}: imports "${spec}", outside vendor/`);
          } else if (spec.startsWith('/') || /^[a-z]+:/i.test(spec)) problems.push(`${at}: imports "${spec}", an absolute path or URL`);
          else if (!allowedDeps.has(bareName(spec))) problems.push(`${at}: imports "${spec}", not a declared dependency of @line/studio`);
        }
      }
    }
    if (importLine) return; // a relative import was already judged by where it resolves
    // A run of '..' (or ../../ inside one string) that climbs higher than vendor/ is a path built for the repository layout.
    const climbs = [];
    const rest = line.replace(ARG_RUN_RE, (run) => { climbs.push([run.split('..').length - 1, run]); return ' '; });
    for (const m of rest.matchAll(UPS_RE)) climbs.push([m[0].split(/[/\\]/).length, m[0]]);
    for (const [ups, text] of climbs) {
      if (ups > depth) problems.push(`${at}: climbs ${ups} directories up (${text}); a vendored file may reach at most vendor/ (${depth} up)`);
    }
  });
  return problems;
}

/** Scans every .mjs/.js/.sh/.py file under `vendorRoot`; returns the problems (empty when the copy is self-contained). */
export function scanVendor({ vendorRoot, allowedDeps }) {
  const files = fs.existsSync(vendorRoot) ? listVendorable(vendorRoot) : [];
  return files.flatMap((f) => scanFile(path.join(vendorRoot, f), { vendorRoot, allowedDeps: new Set(allowedDeps) }));
}

/**
 * Copies `sourceDir` to `<vendorDir>/media`, replacing any earlier copy, then scans it. Throws PackError (after deleting the
 * copy) on a problem; returns the vendored file list otherwise. The source is only read.
 */
export function vendorMedia({ sourceDir = DEFAULT_SOURCE, vendorDir = DEFAULT_VENDOR, allowedDeps = declaredDependencies() } = {}) {
  const files = listVendorable(sourceDir);
  if (!files.length) throw new Error(`no .mjs/.sh/.py files to vendor in ${sourceDir}`);
  const dest = path.join(vendorDir, 'media');
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, f), to);
    fs.chmodSync(to, fs.statSync(path.join(sourceDir, f)).mode & 0o777); // add-audio.sh is executed directly
  }
  const problems = scanVendor({ vendorRoot: vendorDir, allowedDeps });
  if (problems.length) { fs.rmSync(dest, { recursive: true, force: true }); throw new PackError(problems); }
  return files;
}

export function declaredDependencies(packageRoot = PACKAGE_ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
}

function parseFlags(argv) {
  const f = { vendorOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vendor-only') f.vendorOnly = true;
    else if (['--source', '--vendor', '--out'].includes(a)) f[a.slice(2)] = path.resolve(argv[++i] ?? '');
    else throw new Error(`unknown option ${a}`);
  }
  return f;
}

async function cli(argv) {
  let flags;
  try { flags = parseFlags(argv); } catch (e) { console.error(`pack: ${e.message}`); return 2; }
  let files;
  try { files = vendorMedia({ sourceDir: flags.source, vendorDir: flags.vendor }); } catch (e) { console.error(`pack: ${e.message}`); return 1; }
  console.log(`vendored ${files.length} files -> ${path.relative(process.cwd(), path.join(flags.vendor || DEFAULT_VENDOR, 'media')) || '.'}`);
  if (flags.vendorOnly) return 0;
  const args = ['pack', '--ignore-scripts', ...(flags.out ? ['--pack-destination', flags.out] : [])];
  const r = spawnSync('npm', args, { cwd: PACKAGE_ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await cli(process.argv.slice(2));
