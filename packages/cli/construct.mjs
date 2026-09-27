#!/usr/bin/env node
import path from 'node:path';
import { getVersion } from './version.mjs';

const [cmd, ...args] = process.argv.slice(2);

// #648: `--version` answers before the engine is loaded (loading it is most of a cold start: about a fifth of a gigabyte
// and over half a second on a small machine), so the cheapest command stays cheap.
if (cmd === '--version' || cmd === '-v') {
  console.log(getVersion());
  process.exit(0);
}

const { EXIT_CODES, ConstructError } = await import('../core/diagnostics.mjs');
const { USAGE } = await import('../core/usage.mjs');
const { createCommandRegistry } = await import('../core/command-registry.mjs');
const { registerBuiltinCommands } = await import('../core/builtin-commands.mjs');
const { discoverPluginCommands } = await import('../core/plugin-commands.mjs');

// #700: a command registry replaces the old hand-written if-chain. Built-in commands
// (packages/core/cli.mjs, via builtin-commands.mjs) and an installed package's own commands (its
// package.json's "construct.commands" field, via plugin-commands.mjs) register through the exact same
// registry, so dispatch is one lookup and never special-cases either kind. See docs/CLI-COMMAND-REGISTRY.md.
const registry = createCommandRegistry();
registerBuiltinCommands(registry);

// Discovery reads every installed package's package.json under node_modules, so it only runs when it might
// change the answer: the caller asked for the full command list (--help/no command), or `cmd` isn't a
// built-in -- a plugin command, or a genuinely unknown one, either way worth one look before giving up. A
// recognized built-in (the overwhelming majority of invocations) pays nothing extra.
const wantsHelp = cmd === '--help' || cmd === '-h' || !cmd;
let command = wantsHelp ? undefined : registry.resolve(cmd);
if (!command) {
  const dirIndex = args.indexOf('--dir');
  const roots = [process.cwd(), ...(dirIndex >= 0 && args[dirIndex + 1] ? [path.resolve(args[dirIndex + 1])] : [])];
  await discoverPluginCommands(registry, roots);
  if (!wantsHelp) command = registry.resolve(cmd);
}

function printUsage() {
  console.log(USAGE);
  console.log('\nRegistered commands (built-in + installed packages):');
  for (const c of registry.list()) {
    const aliasNote = c.aliases.length ? ` (alias: ${c.aliases.join(', ')})` : '';
    console.log(`  construct ${c.name}${aliasNote}${c.summary ? ` -- ${c.summary}` : ''}`);
  }
}

try {
  if (wantsHelp) {
    printUsage();
    process.exit(cmd ? EXIT_CODES.OK : EXIT_CODES.USAGE_ERROR);
  } else if (command) {
    await command.handler(args);
  } else {
    printUsage();
    process.exit(EXIT_CODES.USAGE_ERROR);
  }
  process.exit(process.exitCode ?? EXIT_CODES.OK);
} catch (e) {
  console.error(`\nConstruct error: ${e.message}`);
  process.exit(e instanceof ConstructError ? e.exitCode : EXIT_CODES.INTERNAL_ERROR);
}
