import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCliCommands, renderCliCommandsMarkdown, dispatchedCommandNames } from '../../packages/docs-site/lib/cliCommands.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const blobUrl = (f) => `https://github.com/o/r/blob/main/${f}`;

test('collectCliCommands: never falls behind what bin/construct.mjs actually dispatches', async () => {
  const dispatched = await dispatchedCommandNames(REPO_ROOT);
  assert.ok(dispatched.length > 10, `expected many dispatched commands, got ${dispatched.length}`);
  const { commands } = await collectCliCommands(REPO_ROOT);
  const names = commands.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'no command listed twice');
  for (const d of dispatched) assert.ok(names.includes(d), `dispatched command "${d}" has no reference entry`);
});

test('collectCliCommands: real commands carry real flags/usage, and no internal ticket number leaks', async () => {
  const { commands, topLevelHelp } = await collectCliCommands(REPO_ROOT);
  assert.match(topLevelHelp, /Capabilities:/);
  const create = commands.find((c) => c.name === 'create');
  assert.ok(create.fromHelpTopic);
  assert.match(create.description, /--llm <provider>/);
  assert.match(create.description, /Example: create feature/);

  const review = commands.find((c) => c.name === 'review');
  assert.ok(!review.fromHelpTopic);
  assert.match(review.description, /deterministic indicators/);
  assert.match(review.usage, /construct review <base> <head>/);

  for (const c of commands) {
    assert.doesNotMatch(c.description, /#\d+/, `${c.name}: description leaks a ticket ref`);
    assert.doesNotMatch(c.usage, /#\d+/, `${c.name}: usage leaks a ticket ref`);
  }
});

test('renderCliCommandsMarkdown: one heading per command, with its own flags/example', async () => {
  const data = await collectCliCommands(REPO_ROOT);
  const md = renderCliCommandsMarkdown(data, blobUrl);
  assert.match(md, /## `construct create`/);
  assert.match(md, /## `construct review`/);
  assert.match(md, /## `construct repl`/);
  assert.match(md, /Usage:\n\n```text\nconstruct review <base> <head>/);
});
