// A small, deterministic command registry (#700). `packages/cli/construct.mjs` used to decide what a command
// word runs with a hand-written `if (cmd === '...') await fn(args); else if ...` chain over
// `packages/core/cli.mjs`'s exports -- so adding a command meant editing Construct's own source. This module
// is the one thing both a built-in command (`builtin-commands.mjs`) and an installed package's own command
// (`plugin-commands.mjs`, discovered from its `package.json`) register through: a name maps to one handler,
// looked up once, no special-casing of "built-in" vs "contributed" anywhere in the dispatcher.
//
// No new dependency, no behavior change to any existing command -- this only replaces how the CLI decides
// which function to call, never what that function does.

/**
 * One command entry as `register()` stores and `resolve()`/`list()` return it: `{ name, summary, usage,
 * handler, source, aliases }`.
 * @typedef {object} RegisteredCommand
 * @property {string} name The word typed after `construct` (e.g. `"validate"`).
 * @property {string} summary One line for `construct --help`'s command list.
 * @property {string} usage A longer usage line, when the command has one beyond its summary.
 * @property {(args: string[]) => (void | Promise<void>)} handler Runs the command; receives the words after `name`.
 * @property {string} source Where this command came from (a file path for a built-in, `"<package> (<file>)"` for a contributed one) -- shown in error messages and the docs reference, never executed.
 * @property {string[]} aliases Other words that resolve to this same command (e.g. `"g"` for `"generate"`).
 */

/**
 * A fresh, empty command registry. `packages/cli/construct.mjs` creates one per invocation, registers the
 * built-ins, then (only when needed -- see that file) an installed package's own commands, and dispatches by
 * looking a single name up in it.
 *
 * @returns {{register: Function, resolve: Function, list: Function, has: Function}}
 * @since 0.11
 *
 * @example
 * const registry = createCommandRegistry();
 * registry.register({ name: 'validate', summary: 'Run the enforcers', handler: validate, source: 'packages/core/cli.mjs' });
 * registry.resolve('validate').handler(['--format', 'json']);
 */
export function createCommandRegistry() {
  /** @type {Map<string, RegisteredCommand>} */
  const commands = new Map();
  /** @type {Map<string, string>} alias -> canonical name */
  const aliasOf = new Map();

  /**
   * Registers one command. Throws (never partially registers) when `name`/`handler` are missing, or `name` or
   * any of `aliases` collides with a command or alias already registered -- a closed, one-owner-per-word
   * registry, so two contributors can never silently shadow each other.
   * @param {{name: string, summary?: string, usage?: string, handler: (args: string[]) => (void | Promise<void>), source?: string, aliases?: string[]}} command
   */
  function register({ name, summary = '', usage = '', handler, source = 'unknown', aliases = [] }) {
    if (!name || typeof name !== 'string') throw new TypeError('register: a command needs a string "name"');
    if (typeof handler !== 'function') throw new TypeError(`register: command "${name}" needs a "handler" function`);
    const taken = (word) => (commands.has(word) ? commands.get(word) : aliasOf.has(word) ? commands.get(aliasOf.get(word)) : undefined);
    const clash = taken(name);
    if (clash) throw new Error(`register: "${name}" is already registered (from ${clash.source})`);
    for (const alias of aliases) {
      const aliasClash = taken(alias);
      if (aliasClash) throw new Error(`register: alias "${alias}" of "${name}" collides with "${aliasClash.name}" (from ${aliasClash.source})`);
    }
    commands.set(name, { name, summary, usage, handler, source, aliases: [...aliases] });
    for (const alias of aliases) aliasOf.set(alias, name);
  }

  /** The command registered for `name`, resolving an alias to its canonical entry, or `undefined`. */
  function resolve(name) {
    if (commands.has(name)) return commands.get(name);
    if (aliasOf.has(name)) return commands.get(aliasOf.get(name));
    return undefined;
  }

  /** Every registered command, canonical entries only (no separate row per alias), sorted by name. */
  function list() {
    return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  return { register, resolve, list, has: (name) => resolve(name) !== undefined };
}
