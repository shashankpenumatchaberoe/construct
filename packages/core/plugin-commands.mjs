// Installed-package command discovery (#700). A package built on Construct (the motivating example: Trace,
// a line-matcher tool) registers `construct <name>` commands by adding a "construct" field to its OWN
// package.json -- no edit to Construct's source, no new registration API to call at publish time. Discovery
// is filesystem-only (read package.json, then import the one file it names): it never runs arbitrary
// "postinstall"-style code, and a broken or malicious plugin can only fail its own commands (see
// `discoverPluginCommands`'s per-package try/catch), never the built-in ones.
//
// package.json contract, documented in docs/CLI-COMMAND-REGISTRY.md:
//
//   { "construct": { "commands": "./construct-commands.mjs" } }
//
// `commands` is a path, relative to the package's own directory, to an ES module that exports a named
// `commands` array: `[{ name, summary, usage, handler }, ...]` -- the exact shape `command-registry.mjs`'s
// `register()` takes (source/aliases optional). `packages/cli/construct.mjs` sets each one's `source` to
// `"<package name> (<path>)"` before registering it, so `construct --help` and any registration error always
// say which package a command came from.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every directory directly under `<dir>/node_modules` that looks like an installed package, `@scope/name`
 * included -- one level only: discovery never descends into a package's own nested node_modules. */
function installedPackageDirs(dir) {
  const nodeModules = path.join(dir, 'node_modules');
  let entries;
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModules, entry.name);
      let scoped;
      try {
        scoped = fs.readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) if (s.isDirectory()) dirs.push(path.join(scopeDir, s.name));
    } else if (!entry.name.startsWith('.')) {
      dirs.push(path.join(nodeModules, entry.name));
    }
  }
  return dirs;
}

/**
 * Every installed package, found directly under `<root>/node_modules` for each `root` in `roots`, whose own
 * package.json declares `construct.commands`: `{ pkgName, commandsFile }[]`, deduplicated by resolved file
 * path (the same commands file named twice, e.g. because `--dir` points inside `process.cwd()`, registers
 * once).
 *
 * @param {string[]} roots Directories to look for a `node_modules` under -- `packages/cli/construct.mjs`
 *   passes `process.cwd()` and, when given, the project `--dir` targets. Discovery never walks up parent
 *   directories: it only ever sees packages the invoked project itself installed.
 * @returns {{pkgName: string, commandsFile: string}[]}
 */
export function findCommandPackages(roots) {
  const seen = new Set();
  const found = [];
  for (const root of roots) {
    for (const pkgDir of installedPackageDirs(root)) {
      const pkgJson = readJson(path.join(pkgDir, 'package.json'));
      const commandsRel = pkgJson?.construct?.commands;
      if (!commandsRel || typeof commandsRel !== 'string') continue;
      const commandsFile = path.resolve(pkgDir, commandsRel);
      if (seen.has(commandsFile)) continue;
      seen.add(commandsFile);
      found.push({ pkgName: pkgJson.name ?? path.basename(pkgDir), commandsFile });
    }
  }
  return found;
}

/**
 * Registers every command an installed package contributes via its own `package.json`'s `"construct":
 * { "commands": "<path>" }` field (#700). Never throws: a package whose commands file is missing, fails to
 * import, exports no `commands` array, or registers a name/alias that collides with one already registered
 * is skipped with one warning line on stderr, so one broken plugin never takes the rest of the CLI down with
 * it.
 *
 * @param {ReturnType<typeof import('./command-registry.mjs').createCommandRegistry>} registry
 * @param {string[]} roots See `findCommandPackages`.
 * @returns {Promise<void>}
 * @since 0.11
 */
export async function discoverPluginCommands(registry, roots) {
  for (const { pkgName, commandsFile } of findCommandPackages(roots)) {
    let mod;
    try {
      mod = await import(pathToFileURL(commandsFile).href);
    } catch (e) {
      console.error(`Construct: skipping commands from "${pkgName}" (could not load ${commandsFile}): ${e.message}`);
      continue;
    }
    const commands = Array.isArray(mod.commands) ? mod.commands : [];
    if (!commands.length) {
      console.error(`Construct: "${pkgName}" declares construct.commands but ${commandsFile} exports no "commands" array`);
      continue;
    }
    for (const cmd of commands) {
      const source = `${pkgName} (${path.relative(process.cwd(), commandsFile)})`;
      try {
        registry.register({ ...cmd, source });
      } catch (e) {
        console.error(`Construct: skipping command "${cmd?.name}" from "${pkgName}": ${e.message}`);
      }
    }
  }
}
