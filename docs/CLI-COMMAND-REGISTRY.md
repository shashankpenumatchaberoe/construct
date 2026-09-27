# CLI command registry (#700)

`packages/cli/construct.mjs` used to decide what a command word runs with a hand-written
`if (cmd === 'x') await fn(args); else if (cmd === 'y') ...` chain over `packages/core/cli.mjs`'s exports.
Adding a command meant editing Construct's own source. It now dispatches through a small registry instead, and
an installed package can add its own command with no edit to Construct at all.

## The pieces

- **`packages/core/command-registry.mjs`** -- `createCommandRegistry()`. A name maps to one
  `{ name, summary, usage, handler, source, aliases }` entry. `register()` throws on a missing name/handler or
  a name/alias collision (one owner per word, closed set, no silent shadowing); `resolve(name)` looks up a
  command or alias; `list()` returns every command, sorted.
- **`packages/core/builtin-commands.mjs`** -- `registerBuiltinCommands(registry)`. Registers every command
  Construct ships (`init`, `feature`, `generate`/`g`, `sync`, `validate`, `summarize`, `doctor`, `create`,
  `refactor`, `research`, `review`, `test`, `template`, `import`, `pipeline`, `traces`, `decide`, `model`,
  `repl`) with the exact function (or exact inline branch, for `import`'s `--route` case and `repl`'s lazy
  import + explicit exit) the old if-chain called. This is a refactor of dispatch only -- no built-in
  command's flags, output or exit code changed.
- **`packages/core/plugin-commands.mjs`** -- `discoverPluginCommands(registry, roots)`. Finds every package
  installed directly under `<root>/node_modules` (for each `root` in `roots`, one level deep, no walking into a
  package's own nested `node_modules`) whose own `package.json` declares a `construct.commands` field, imports
  the file it names, and registers every command that module exports. A broken plugin (missing file, throws on
  import, exports no `commands` array, or registers a name that collides with one already taken) is skipped
  with one warning line on stderr -- it never takes down the built-in commands.
- **`packages/cli/construct.mjs`** -- creates one registry per invocation, registers the built-ins, then runs
  discovery only when it might change the answer: `cmd` isn't already a built-in, or the caller asked for the
  full list (`--help`/`-h`/no command). A recognized built-in -- the overwhelming majority of invocations --
  never pays the `node_modules` scan.

## Contributing a command from an installed package

Add a `construct` field to your package's own `package.json`:

```json
{
  "name": "@line/construct-trace",
  "construct": {
    "commands": "./construct-commands.mjs"
  }
}
```

`commands` is a path, relative to your package's own directory, to an ES module that exports a named
`commands` array:

```js
// construct-commands.mjs
export const commands = [
  {
    name: 'trace',
    summary: 'Match a captured trace against the project\'s workflows',
    usage: 'construct trace <file> [--feature <name>] [--dir <path>]',
    handler: async (args) => {
      // args is everything after "trace", exactly what a built-in command's handler receives.
    },
  },
];
```

A command entry takes the same shape `command-registry.mjs`'s `register()` does (`aliases` is optional). Once
your package is installed (`npm install`) alongside a project that also has `construct` installed,
`construct trace ...` finds and runs it -- nothing in Construct's own source changes. Discovery looks under
`process.cwd()`'s `node_modules` and, when the invocation passes `--dir <path>`, that path's `node_modules`
too; it does not walk up parent directories, so your package needs to be installed where `construct` is
actually run from (the common case for a project's own devDependency).

## Docs stay derived, not hand-maintained

`construct --help` prints the real usage text plus a "Registered commands" list read straight from the
registry (built-ins and, when discovery ran, contributed commands both) -- never a hand-copied list.

The docs site's CLI reference (`packages/docs-site/lib/cliCommands.mjs`) reads the same registry:
`dispatchedCommandNames()` registers the built-ins the same way `construct.mjs` does and returns their names,
so `site/test/cliCommands.test.mjs` can keep asserting the generated reference page never falls behind what
the CLI actually dispatches -- now checked against the registry instead of regexing `construct.mjs`'s source
for `cmd === '...'` (there is no such string left to find once dispatch goes through the registry).
