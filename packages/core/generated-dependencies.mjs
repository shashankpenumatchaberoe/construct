// #678 -- every generator that writes a bare `import ... from '<package>'` into a project (the shape flow's
// `@line/construct-core/typed-contracts`, the workflow generator's `xstate`, the OpenAPI service generator's
// `zod` when `--schema` forces it, the generated Playwright/unit-test files' `@playwright/test` and
// `@xstate/graph`) used to just print a note telling a person to edit package.json by hand, or say nothing at
// all. This is the one deterministic check every one of those call sites now runs after writing its files:
// "generated imports subseteq declared dependencies" (the exact ⊆ check the issue asked for), preferred over a
// scattered per-template fix.
//
//   bareImportPackages(source)                  the bare (non-relative, non-node:) package names a file's `import` statements name
//   missingGeneratedDependencies(root, files)   which of those, across a set of written files, package.json does not declare (null: no package.json to check against)
//   ensureGeneratedDependencies(root, files)    add the ones this module knows a concrete version for via the existing `add.dependency`
//                                                flow (`addDependency`, wiring.mjs) -- never a second way to edit package.json -- and
//                                                report a note for anything it does not know how to add safely (a dev-only tool
//                                                `add.dependency` cannot place in the right section yet, or a package this table
//                                                has no entry for at all)
import fs from 'node:fs';
import path from 'node:path';
import { addDependency, constructCoreRange, CONSTRUCT_CORE_PACKAGE } from './wiring.mjs';

// Mirrors the issue's own sweep command (`grep -rhoE "from '[^./][^']*'" ...`): a specifier that starts with
// neither `.` nor `/` is a package import, never a relative one; `node:` builtins need nothing declared.
const FROM_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

/**
 * The packages the templates this repo ships are known to introduce, and how `add.dependency` should declare
 * each one: `dependencies` (this checkout's `addDependency` writes there) or `devDependencies` (which
 * `add.dependency` cannot place a line into yet, #678 sweep finding -- reported as a note instead of guessed
 * into the wrong section). Versions mirror `packages/core/scaffold.mjs` (what a fresh `construct init` project
 * already gets) or, for `@line/construct-core` itself, this checkout's own version.
 */
export const KNOWN_GENERATED_DEPENDENCIES = Object.freeze({
  [CONSTRUCT_CORE_PACKAGE]: { section: 'dependencies', version: () => constructCoreRange() },
  xstate: { section: 'dependencies', version: () => '^5.0.0' },
  zod: { section: 'dependencies', version: () => '^4.6.5' },
  '@xstate/graph': { section: 'devDependencies', version: () => '^3.0.4' },
  '@playwright/test': { section: 'devDependencies', version: () => '^1.63.0' },
});

/**
 * The bare package names a generated file's `import` statements name: `import { x } from 'xstate'` is `xstate`,
 * `import { defineDomain } from '@line/construct-core/typed-contracts'` is `@line/construct-core` (the subpath
 * collapses to the package root, since that's the unit npm installs and package.json declares). A relative
 * (`./x`, `../x`), absolute (`/x`) or `node:` specifier is never a package to declare, so none of those appear.
 *
 * @param {string} source A file's text.
 * @returns {Set<string>} The bare package names it imports from, in no particular order.
 *
 * @example
 * bareImportPackages("import { defineDomain } from '@line/construct-core/typed-contracts';\n");
 * // => Set(1) { '@line/construct-core' }
 */
export function bareImportPackages(source) {
  const names = new Set();
  const consider = (spec) => {
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return;
    const parts = spec.split('/');
    names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  };
  for (const m of source.matchAll(FROM_RE)) consider(m[1]);
  for (const m of source.matchAll(SIDE_EFFECT_IMPORT_RE)) consider(m[1]);
  return names;
}

/** The package names declared in `dependencies`, `devDependencies` or `peerDependencies` of a project's package.json, or `null` when it has none / it is not readable JSON. */
function declaredDependencyNames(root) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
}

/**
 * The bare package names a set of just-written files import that the project's package.json does not declare
 * anywhere (`dependencies`, `devDependencies` or `peerDependencies`) -- the "generated imports ⊆ declared
 * dependencies" check, run the same way after every generator instead of a bespoke note per template. A package
 * already declared (in either section) is never reported, so a project that pins its own range is left alone.
 *
 * @param {string} root Project root.
 * @param {string[]} filePaths Absolute paths of the files a generator just wrote.
 * @returns {string[] | null} The missing package names, sorted; `null` when the project has no readable package.json to check against.
 *
 * @example
 * missingGeneratedDependencies(root, [domainFile]); // => ['@line/construct-core']
 */
export function missingGeneratedDependencies(root, filePaths) {
  const declared = declaredDependencyNames(root);
  if (!declared) return null;
  const found = new Set();
  for (const file of filePaths) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const name of bareImportPackages(source)) found.add(name);
  }
  return [...found].filter((name) => !declared.has(name)).sort();
}

/**
 * Declare, in package.json, every missing dependency a set of just-written files import that this module knows a
 * concrete version for (`KNOWN_GENERATED_DEPENDENCIES`), through the existing `add.dependency` flow
 * (`addDependency`, wiring.mjs) -- the same one-line, idempotent, never-installs edit used everywhere else a plan
 * adds a dependency. Never runs a package manager. A missing package this module cannot place safely (no known
 * version, or a dev-only tool `add.dependency` cannot yet target `devDependencies` for) is returned as a note
 * instead of guessed at.
 *
 * @param {string} root Project root.
 * @param {string[]} filePaths Absolute paths of the files a generator just wrote.
 * @returns {{ added: { name: string, line: string }[], notes: string[] }} The dependencies actually added (each with the exact package.json line), and a note per package left for a person to add by hand.
 *
 * @example
 * ensureGeneratedDependencies(root, [domainFile]);
 * // => { added: [{ name: '@line/construct-core', line: '"@line/construct-core": "^0.9.0"' }], notes: [] }
 */
export function ensureGeneratedDependencies(root, filePaths) {
  const missing = missingGeneratedDependencies(root, filePaths);
  if (missing === null) {
    return { added: [], notes: filePaths.length ? ['This project has no readable package.json yet: once it has one, make sure it declares whatever the generated files import.'] : [] };
  }
  const added = [];
  const notes = [];
  for (const name of missing) {
    const known = KNOWN_GENERATED_DEPENDENCIES[name];
    if (!known) {
      notes.push(`"${name}" is not declared in package.json and is not a package this module knows a version for: the generated code imports it, so add it (and a version) by hand before you build or type-check.`);
      continue;
    }
    if (known.section === 'devDependencies') {
      notes.push(`"${name}" is not declared in package.json: the generated code imports it as a dev-only tool. Run npm install -D ${name}@${known.version(root).replace(/^[\^~]/, '')} (add.dependency only declares "dependencies" today).`);
      continue;
    }
    const result = addDependency(root, { name, version: known.version(root) });
    if (result.changed) added.push({ name, line: result.line });
  }
  return { added, notes };
}
