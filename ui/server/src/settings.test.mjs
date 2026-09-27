// Per-capability LLM routing (#100/Epic 6.4) — settings.mjs's own state is
// module-level (not reset between tests), so every test here re-sets the
// fields it cares about (and restores projectDir) rather than assuming a
// fresh module each time; Node's test runner loads this module once.
import '../../../test-utils/workspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, updateSettings, getProjectDir, preloadProject } from './settings.mjs';
import { WorkspaceError, workspaceRoot } from './workspace.mjs';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { PROVIDERS } from '../../../packages/core/llm.mjs';

test('getSettings returns a per-capability llmProviders map defaulting every capability to the same provider', () => {
  const settings = getSettings();
  assert.ok(settings.llmProviders);
  assert.equal(typeof settings.llmProviders.importFill, 'string');
  assert.equal(typeof settings.llmProviders.createFill, 'string');
  assert.equal(typeof settings.llmProviders.planAnalysis, 'string');
});

test('getSettings never lists ollama among planAnalysis\'s available providers, even though it is a real provider', () => {
  const settings = getSettings();
  assert.ok(settings.availableProviders.includes('claude'));
  // This assertion is only meaningful once #98's ollama provider exists;
  // guard so this test still passes (harmlessly) if PROVIDERS ever loses it.
  if (settings.availableProviders.includes('ollama')) {
    assert.equal(settings.availableProvidersByCapability.planAnalysis.includes('ollama'), false);
  }
  assert.deepEqual(
    settings.availableProvidersByCapability.importFill.sort(),
    settings.availableProviders.slice().sort(),
  );
  assert.deepEqual(
    settings.availableProvidersByCapability.createFill.sort(),
    settings.availableProviders.slice().sort(),
  );
});

test('updateSettings sets one capability at a time without disturbing the others', () => {
  updateSettings({ llmProviders: { importFill: 'claude' } });
  const before = getSettings().llmProviders;
  updateSettings({ llmProviders: { createFill: 'claude' } });
  const after = getSettings().llmProviders;
  assert.equal(after.importFill, before.importFill);
  assert.equal(after.createFill, 'claude');
});

test('updateSettings throws on an unknown provider for any capability, and does not apply it', () => {
  const before = getSettings().llmProviders.importFill;
  assert.throws(() => updateSettings({ llmProviders: { importFill: 'gpt-nope' } }), /Unknown LLM provider "gpt-nope"/);
  assert.equal(getSettings().llmProviders.importFill, before);
});

test('updateSettings HARD-REJECTS ollama for planAnalysis — the #96 guardrail — even though ollama is a valid provider elsewhere', { skip: !PROVIDERS.ollama }, () => {
  const before = getSettings().llmProviders.planAnalysis;
  assert.throws(
    () => updateSettings({ llmProviders: { planAnalysis: 'ollama' } }),
    /planAnalysis.*never delegated to a local model/s,
  );
  assert.equal(getSettings().llmProviders.planAnalysis, before, 'must not have been applied');
});

test('updateSettings accepts ollama for importFill and createFill (only planAnalysis is restricted)', { skip: !PROVIDERS.ollama }, () => {
  updateSettings({ llmProviders: { importFill: 'ollama' } });
  assert.equal(getSettings().llmProviders.importFill, 'ollama');
  updateSettings({ llmProviders: { createFill: 'ollama' } });
  assert.equal(getSettings().llmProviders.createFill, 'ollama');
  // Restore for any later test relying on defaults.
  updateSettings({ llmProviders: { importFill: 'claude', createFill: 'claude' } });
});

test('#365: the server starts with NO project open (never process.cwd()), and no project is offered to reopen yet', () => {
  const s = getSettings();
  assert.equal(s.projectDir, null);
  assert.notEqual(s.projectDir, process.cwd());
  assert.equal(s.projectRelative, null);
  assert.equal(s.lastProject, null);
  assert.equal(s.workspaceRoot, workspaceRoot());
});

test('#365: updateSettings applies a projectDir inside the workspace and refuses everything else, leaving state unchanged', () => {
  const dir = makeTempDir('settings-ws-');
  const inside = path.join(dir, 'proj');
  fs.mkdirSync(inside);
  const result = updateSettings({ projectDir: inside });
  assert.equal(result.projectDir, inside);
  assert.equal(result.projectRelative, path.relative(workspaceRoot(), inside));
  for (const bad of ['/definitely/not/a/real/path/xyz', '/', '/etc', path.join(workspaceRoot(), '..'), `${inside}\0`, path.join(inside, 'nope')]) {
    assert.throws(() => updateSettings({ projectDir: bad }), (e) => e instanceof WorkspaceError, bad);
    assert.equal(getSettings().projectDir, inside, `unchanged after refusing ${JSON.stringify(bad)}`);
  }
  fs.symlinkSync('/etc', path.join(dir, 'escape'));
  assert.throws(() => updateSettings({ projectDir: path.join(dir, 'escape') }), (e) => e.code === 'OUTSIDE_WORKSPACE');
  assert.equal(getSettings().projectDir, inside);
});

test('#365: a bad provider in the same request does not switch the project', () => {
  const before = getSettings().projectDir;
  const other = makeTempDir('settings-ws-other-');
  assert.throws(() => updateSettings({ projectDir: other, llmProviders: { importFill: 'gpt-nope' } }), /Unknown LLM provider/);
  assert.equal(getSettings().projectDir, before);
});

test('#365: closeProject closes it, and the closed project is offered as lastProject (never auto-loaded)', () => {
  const dir = makeTempDir('settings-ws-close-');
  updateSettings({ projectDir: dir });
  const closed = updateSettings({ closeProject: true });
  assert.equal(closed.projectDir, null);
  assert.equal(closed.lastProject, dir);
  assert.equal(getSettings().projectDir, null, 'still closed on the next read');
  const reopened = updateSettings({ projectDir: closed.lastProject });
  assert.equal(reopened.projectDir, dir);
  assert.equal(reopened.lastProject, null, 'the open project is not offered as "reopen"');
});

test('#365: a project replaced by a symlink out of the workspace stops being served on the next read (TOCTOU per use)', () => {
  const dir = makeTempDir('settings-ws-swap-');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  updateSettings({ projectDir: proj });
  assert.equal(getSettings().projectDir, proj);
  fs.rmSync(proj, { recursive: true });
  fs.symlinkSync('/etc', proj);
  assert.equal(getProjectDir(), null);
  assert.equal(getSettings().projectDir, null);
});

test('#365: a last-project file that points outside the workspace is never offered (fresh process reads it)', async () => {
  const state = makeTempDir('settings-ws-state-');
  fs.writeFileSync(path.join(state, 'last-project.json'), JSON.stringify({ projectDir: '/etc' }));
  const script = `import('${new URL('./settings.mjs', import.meta.url).href}').then((m) => console.log(JSON.stringify(m.getSettings().lastProject)))`;
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, CONSTRUCT_STATE_DIR: state }, encoding: 'utf8' });
  assert.equal(out.trim(), 'null');
});

test('#365: browseRoots can no longer be set by a client', () => {
  assert.throws(() => updateSettings({ browseRoots: ['/'] }), (e) => e.code === 'BROWSE_ROOTS_FIXED');
});

test('#365: preloadProject (harness) is contained exactly like a client choice', () => {
  assert.throws(() => preloadProject('/etc'), (e) => e instanceof WorkspaceError);
  const dir = makeTempDir('settings-ws-preload-');
  preloadProject(dir);
  assert.equal(getSettings().projectDir, dir);
  updateSettings({ closeProject: true });
});

test('#365 harness: when the open project vanishes, the preloaded one comes back; closing stays closed; a vanished preload is null', () => {
  const preloaded = makeTempDir('settings-ws-preload-');
  preloadProject(preloaded);
  const other = makeTempDir('settings-ws-other-');
  updateSettings({ projectDir: other });
  assert.equal(getProjectDir(), other);
  fs.rmSync(other, { recursive: true, force: true });
  assert.equal(getProjectDir(), preloaded, 'falls back to the preloaded project, not to "no project"');
  updateSettings({ closeProject: true });
  assert.equal(getProjectDir(), null, 'an explicit close is respected');
  preloadProject(preloaded);
  fs.rmSync(preloaded, { recursive: true, force: true });
  assert.equal(getProjectDir(), null, 'a preload that itself vanished is not served');
});

test('updateSettings back-compat: a bare legacy { llmProvider } body sets importFill only, never planAnalysis/createFill', () => {
  updateSettings({ llmProviders: { createFill: 'claude', planAnalysis: 'claude' } });
  const before = getSettings().llmProviders;
  updateSettings({ llmProvider: 'claude' });
  const after = getSettings().llmProviders;
  assert.equal(after.importFill, 'claude');
  assert.equal(after.createFill, before.createFill);
  assert.equal(after.planAnalysis, before.planAnalysis);
});

test('getSettings exposes a legacy llmProvider field mirroring importFill, for any old reader', () => {
  updateSettings({ llmProviders: { importFill: 'claude' } });
  assert.equal(getSettings().llmProvider, getSettings().llmProviders.importFill);
});

// ---------------------------------------------------------------------------
// #418: llmProviders persisted at <stateDir>/settings.json, so the choice
// survives a server restart. Each case runs in a fresh child process (like
// the #365 last-project test above) so it sees a fresh module rather than
// this file's already-populated in-memory state.
// ---------------------------------------------------------------------------

async function runInFreshProcess(state, script) {
  const { execFileSync } = await import('node:child_process');
  return execFileSync(process.execPath, ['-e', script], { env: { ...process.env, CONSTRUCT_STATE_DIR: state }, encoding: 'utf8' });
}

test('#418: a capability provider set via updateSettings is read back by a fresh process from the same state dir', async () => {
  const state = makeTempDir('settings-llm-persist-');
  const setScript = `import('${new URL('./settings.mjs', import.meta.url).href}').then((m) => { m.updateSettings({ llmProviders: { createFill: 'claude' } }); console.log('done'); })`;
  await runInFreshProcess(state, setScript);
  assert.ok(fs.existsSync(path.join(state, 'settings.json')), 'settings.json must have been written');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'settings.json'), 'utf8')).llmProviders.createFill, 'claude');

  const readScript = `import('${new URL('./settings.mjs', import.meta.url).href}').then((m) => console.log(JSON.stringify(m.getSettings().llmProviders)))`;
  const out = await runInFreshProcess(state, readScript);
  assert.equal(JSON.parse(out.trim()).createFill, 'claude');
});

test('#418: settings.json is re-validated against PROVIDERS on read — an unknown provider from a stale/hand-edited file is dropped, not trusted', async () => {
  const state = makeTempDir('settings-llm-invalid-');
  fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ llmProviders: { importFill: 'no-such-provider-anymore' } }));
  const readScript = `import('${new URL('./settings.mjs', import.meta.url).href}').then((m) => console.log(JSON.stringify(m.getSettings().llmProviders)))`;
  const out = await runInFreshProcess(state, readScript);
  const providers = JSON.parse(out.trim());
  assert.notEqual(providers.importFill, 'no-such-provider-anymore');
  assert.equal(typeof providers.importFill, 'string');
});

test(
  '#418: settings.json is re-validated against the #96 planAnalysis guardrail on read — a stale file naming ollama for planAnalysis is dropped',
  { skip: !PROVIDERS.ollama },
  async () => {
    const state = makeTempDir('settings-llm-ollama-plan-');
    fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ llmProviders: { planAnalysis: 'ollama' } }));
    const readScript = `import('${new URL('./settings.mjs', import.meta.url).href}').then((m) => console.log(JSON.stringify(m.getSettings().llmProviders)))`;
    const out = await runInFreshProcess(state, readScript);
    assert.notEqual(JSON.parse(out.trim()).planAnalysis, 'ollama');
  },
);

test('#418: a corrupt settings.json is ignored in favor of defaults, rather than crashing the server', async () => {
  const state = makeTempDir('settings-llm-corrupt-');
  fs.writeFileSync(path.join(state, 'settings.json'), '{ not valid json');
  const readScript = `import('${new URL('./settings.mjs', import.meta.url).href}').then((m) => console.log(JSON.stringify(m.getSettings().llmProviders)))`;
  const out = await runInFreshProcess(state, readScript);
  const providers = JSON.parse(out.trim());
  assert.equal(typeof providers.importFill, 'string');
});
