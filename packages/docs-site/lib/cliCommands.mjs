// CLI command reference (#467/#463): every command in the real command registry — `packages/core/command-
// registry.mjs`, populated by `packages/core/builtin-commands.mjs` exactly the way `packages/cli/
// construct.mjs` populates it for a real invocation (#700) — plus `packages/core/repl.mjs`'s
// `HELP_TOPICS`/`TOPIC_ORDER` (the exact text `construct repl`'s own "help"/"help <topic>" prints) — rendered
// as one page, so this can never say something the CLI itself doesn't. Deterministic; no LLM.
// `site/test/cliCommands.test.mjs` guards that the command list here never falls behind what the registry
// actually dispatches.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTicketRefs } from './markdown.mjs';

/** A short alias dispatched to the same command as a longer name ("g" -> "generate") — not a command of its
 * own, so it never needs (or gets) its own reference page. Kept as a lookup table (rather than read off the
 * registry's own `aliases`) so a doc page can still say "also g" without importing the registry twice. */
export const ALIASES = { g: 'generate' };

/** Every top-level command name the CLI actually dispatches — built through the exact same
 * `createCommandRegistry()` + `registerBuiltinCommands()` pair `packages/cli/construct.mjs` uses for a real
 * invocation (#700), read from `repoRoot` rather than statically imported so this keeps working for any repo
 * checkout, not only this one — deduplicated, in registry order (alphabetical; aliases are not separate
 * entries) — the one source of truth for "is this really a command". Installed-package commands
 * (`plugin-commands.mjs`) are deliberately not included: the reference page documents Construct itself. */
export async function dispatchedCommandNames(repoRoot) {
  const { createCommandRegistry } = await import(pathToFileURL(path.join(repoRoot, 'packages/core/command-registry.mjs')).href);
  const { registerBuiltinCommands } = await import(pathToFileURL(path.join(repoRoot, 'packages/core/builtin-commands.mjs')).href);
  const registry = createCommandRegistry();
  registerBuiltinCommands(registry);
  return registry.list().map((c) => c.name);
}

// stripTicketRefs (site/lib/markdown.mjs) handles "(see #96)", "(#314/#316, epic #285)" and "Tracked under
// issue #104"; a bare "-- Ticket 7.1." (no "#") is this codebase's other ticket-reference idiom, so it needs
// its own pass too.
const stripInternal = (s) => stripTicketRefs(s.replace(/\s*--?\s*Ticket \d+(?:\.\d+)?\.?/gi, '')).replace(/\s+/g, ' ').trim();

/** The JSDoc block comment immediately above `export (async )?function <name>(` in `src`: `{ description,
 * example }` (`example` is a real `@example` tag's content, verbatim — already real code). Empty strings when
 * there is no such function or no such comment. Anchored on the function's own declaration and then scanned
 * backward (blank lines skipped, nothing else) — never a lazy scan across the whole file, which could walk
 * through unrelated code and pick up a comment that isn't actually this function's own. */
function jsdocAbove(src, name) {
  const declIdx = src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (declIdx < 0) return { description: '', example: '' };
  const lines = src.slice(0, declIdx).split('\n');
  let i = lines.length - 2; // last line is the (partial) declaration line itself
  while (i >= 0 && /^\s*$/.test(lines[i])) i--;
  if (i < 0 || !/\*\/\s*$/.test(lines[i])) return { description: '', example: '' };
  const block = [];
  while (i >= 0 && !/^\s*\/\*\*/.test(lines[i])) {
    block.unshift(lines[i]);
    i--;
  }
  if (i < 0) return { description: '', example: '' };
  block.unshift(lines[i]);
  const commentLines = block.map((l) => l.replace(/^\s*\/\*+\s?|\*+\/\s*$|^\s*\*\s?/g, ''));
  const descLines = [];
  const exampleLines = [];
  let inExample = false;
  for (const l of commentLines) {
    const t = l.trim();
    if (/^@example\b/.test(t)) {
      inExample = true;
      continue;
    }
    if (/^@\w+/.test(t)) {
      inExample = false;
      continue;
    }
    (inExample ? exampleLines : descLines).push(l);
  }
  return { description: stripInternal(descLines.join('\n')), example: exampleLines.join('\n').trim() };
}

/** The literal `Usage: ...` string a command throws/prints on a bad invocation — a real, always-current fallback
 * for the four commands that have no repl help topic and no `@example` tag. Bounded to `name`'s own function
 * body (its declaration through the next top-level `export`), so it can't pick up another command's usage line. */
function usageLineFrom(src, name) {
  const start = src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const rest = src.slice(start + name.length);
  const nextExport = rest.search(/^export /m);
  const body = nextExport < 0 ? src.slice(start) : src.slice(start, start + name.length + nextExport);
  const m = /Usage: ([^'"\n]+)/.exec(body);
  return m ? m[1].trim() : '';
}

// Pseudo-topics in TOPIC_ORDER explain a flag ("dir") or a rule ("import-001"), not a command.
const PSEUDO_TOPICS = new Set(['dir', 'import-001']);
// Dispatched commands with no repl help topic (no interactive equivalent, or read-only/one-shot only).
const EXTRA_COMMANDS = [
  { name: 'review', fn: 'review' },
  { name: 'test', fn: 'testCommand' },
  { name: 'template', fn: 'template' },
  { name: 'pipeline', fn: 'pipeline' },
  { name: 'traces', fn: 'traces' },
  { name: 'decide', fn: 'decide' },
  { name: 'model', fn: 'model' },
];

/**
 * The CLI's full command list, read from the registry that actually runs it.
 *
 * @param {string} repoRoot Repository root.
 * @returns {Promise<{commands: object[], topLevelHelp: string}>} `commands`: `{ name, description, example, usage, fromHelpTopic, source }[]`.
 */
export async function collectCliCommands(repoRoot) {
  const { HELP_TOPICS, TOPIC_ORDER, getTopLevelHelpText } = await import(pathToFileURL(path.join(repoRoot, 'packages/core/repl.mjs')));
  const cliSrc = fs.readFileSync(path.join(repoRoot, 'packages/core/cli.mjs'), 'utf8');
  const commands = [];
  for (const name of TOPIC_ORDER) {
    if (PSEUDO_TOPICS.has(name)) continue;
    commands.push({ name, description: stripInternal(HELP_TOPICS[name]), example: '', usage: '', fromHelpTopic: true, source: 'packages/core/repl.mjs' });
  }
  for (const { name, fn } of EXTRA_COMMANDS) {
    const { description, example } = jsdocAbove(cliSrc, fn);
    commands.push({ name, description, example, usage: example ? '' : usageLineFrom(cliSrc, fn), fromHelpTopic: false, source: 'packages/core/cli.mjs' });
  }
  commands.push({
    name: 'repl',
    description: 'Interactive shell over the exact same functions a one-shot invocation dispatches to — no new command logic. Type any command above without the leading "construct", plus "help"/"help <topic>", "cd <path>" and "pwd".',
    example: 'construct repl',
    usage: '',
    fromHelpTopic: false,
    source: 'packages/core/repl.mjs',
  });
  return { commands, topLevelHelp: stripInternal(getTopLevelHelpText()) };
}

/** The whole reference as one markdown page. `blobUrl(repoRelativePath)` -> GitHub link. */
export function renderCliCommandsMarkdown({ commands, topLevelHelp }, blobUrl) {
  const lines = [
    "Every command `construct` (and `construct repl`) actually dispatches, generated at build time from the real command registry: `bin/construct.mjs`'s dispatch table, `src/cli.mjs`'s command functions, and `src/repl.mjs`'s `HELP_TOPICS` — the exact text `construct repl`'s own `help`/`help <topic>` prints, not a hand-copied duplicate.",
    '',
    '## Overview',
    '',
    '```text',
    topLevelHelp,
    '```',
    '',
  ];
  for (const c of commands) {
    lines.push(`## \`construct ${c.name}\``, '');
    if (c.fromHelpTopic) {
      lines.push('```text', c.description, '```', '');
    } else {
      if (c.description) lines.push(c.description, '');
      if (c.example) lines.push('Example:', '', '```sh', c.example, '```', '');
      else if (c.usage) lines.push('Usage:', '', '```text', c.usage, '```', '');
    }
    lines.push(`*Source: [\`${c.source}\`](${blobUrl(c.source)}).*`, '');
  }
  return lines.join('\n');
}
