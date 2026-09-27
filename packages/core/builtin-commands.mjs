// Registers every command `packages/cli/construct.mjs` used to dispatch through its own hand-written
// `if (cmd === '...') ...` chain (#700), now through the same `command-registry.mjs` an installed package's
// own commands (`plugin-commands.mjs`) go through. This is a refactor of the dispatch MECHANISM only: every
// handler below is the exact function (or exact inline logic) the old if-chain called, so no built-in
// command's flags, output or exit behavior changes.
//
// `import` stays one command with its existing `--route` branch (never two commands); `generate` keeps its
// `g` alias; `repl` keeps its own lazy `import('./repl.mjs')` and explicit `process.exit(0)` -- both
// preserved verbatim from packages/cli/construct.mjs, just moved behind a registered handler instead of an
// inline `else if`.
import {
  init, feature, generate, sync, validate, summarize, doctor, create, refactor, research, review,
  testCommand, template, importCommand, runImportRouteWizard, pipeline, traces, decide, model,
} from './cli.mjs';

/** `construct import ...`: the same `--route` vs. plain-import branch `construct.mjs`'s old if-chain had inline. */
function importHandler(args) {
  if (args[0] === '--route') {
    return runImportRouteWizard(args[1]?.startsWith('--') ? undefined : args[1], { planner: args[args.indexOf('--planner') + 1] === 'mechanical' ? 'mechanical' : 'ai' });
  }
  return importCommand(args);
}

/** `construct repl`: the same lazy import + explicit exit the old if-chain had inline (repl.mjs lives beside this file, so the import is now one directory closer instead of `../core/repl.mjs`). */
async function replHandler() {
  const { startRepl } = await import('./repl.mjs');
  await startRepl();
  process.exit(0);
}

const SOURCE = 'packages/core/cli.mjs';

/**
 * Registers every built-in command on `registry`. Called once per CLI invocation by
 * `packages/cli/construct.mjs`, before it looks at whether an installed package contributes any more (#700).
 *
 * @param {ReturnType<typeof import('./command-registry.mjs').createCommandRegistry>} registry
 * @since 0.11
 */
export function registerBuiltinCommands(registry) {
  registry.register({ name: 'init', summary: 'Scaffold architecture.yml, AGENTS.md and a runnable project shell', handler: init, source: SOURCE });
  registry.register({ name: 'feature', summary: 'construct feature create <name>: create a feature', handler: feature, source: SOURCE });
  registry.register({ name: 'generate', aliases: ['g'], summary: 'Scaffold a layer, a vertical slice, or generated tests', handler: generate, source: SOURCE });
  registry.register({ name: 'sync', summary: 'Sync dependency-cruiser config and every feature\'s public API', handler: sync, source: SOURCE });
  registry.register({ name: 'validate', summary: 'Run the architecture enforcers and report violations', handler: validate, source: SOURCE });
  registry.register({ name: 'summarize', summary: 'Deterministic, LLM-free summaries of a unit, feature or project', handler: summarize, source: SOURCE });
  registry.register({ name: 'doctor', summary: 'Report environment and enforcer module availability', handler: doctor, source: SOURCE });
  registry.register({ name: 'create', summary: 'Scaffold a feature, a layer, or a whole vertical slice', handler: create, source: SOURCE });
  registry.register({ name: 'refactor', summary: 'Mechanical, LLM-free moves/renames within the architecture', handler: refactor, source: SOURCE });
  registry.register({ name: 'research', summary: 'Read-only: summarize, explain workflows, compute impact, check tooling', handler: research, source: SOURCE });
  registry.register({ name: 'review', summary: 'Read-only PR health between two git refs', handler: review, source: SOURCE });
  registry.register({ name: 'test', summary: 'Run generated tests/proofs, or type-check/build the project', handler: testCommand, source: SOURCE });
  registry.register({ name: 'template', summary: 'List, show or instantiate a named, reusable, parameterised plan', handler: template, source: SOURCE });
  registry.register({ name: 'import', summary: 'Scaffold layers for an existing, non-Construct file or route', handler: importHandler, source: SOURCE });
  registry.register({ name: 'pipeline', summary: 'Run a Context Envelope through the generator pipeline (stdin/stdout)', handler: pipeline, source: SOURCE });
  registry.register({ name: 'traces', summary: 'Inspect, replay or export recorded decision traces', handler: traces, source: SOURCE });
  registry.register({ name: 'decide', summary: 'Ask the decision model for a suggestion (read-only)', handler: decide, source: SOURCE });
  registry.register({ name: 'model', summary: 'List, import, enable or disable a decision model trained elsewhere', handler: model, source: SOURCE });
  registry.register({ name: 'repl', summary: 'Interactive shell over the same functions a one-shot invocation dispatches to', handler: replHandler, source: 'packages/core/repl.mjs' });
}
