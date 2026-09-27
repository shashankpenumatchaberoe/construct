import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, '../../screenshots/demos');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// packages/cli/construct.mjs, the real CLI entry point, run exactly as a
// user would run it -- never a mocked/hand-written stand-in for its output.
const CLI_BIN = path.resolve(__dirname, '../../../../packages/cli/construct.mjs');
const API_BASE = process.env.E2E_API_BASE || 'http://localhost:4000';

/** Runs a real `construct` command and logs the exact command + its real
 * stdout, so the console output doubles as the "real terminal transcript"
 * this Demos-module suite (#125/#148) requires -- nothing fabricated. */
function runCli(args) {
  const out = execFileSync('node', [CLI_BIN, ...args], { encoding: 'utf8' });
  console.log(`\n$ construct ${args.join(' ')}\n${out}`);
  return out;
}

// -----------------------------------------------------------------------
// #149 -- First-time setup: the Cockpit UI's own "this isn't a Construct
// project yet" -> initialized walkthrough (see ui/client/features/
// project-gate). This is the UI's independent path -- it never shells out
// to the CLI; it drives the same in-process `init()` (src/cli.mjs) via
// POST /api/init, exactly as ui/server/src/index.mjs wires it.
// -----------------------------------------------------------------------
test.describe.serial('Demo #149 (UI) -- project-gate: not-a-project -> initialized', () => {
  let freshDir;

  test.beforeAll(async ({ request }) => {
    // A brand-new, genuinely empty directory -- no architecture.yml
    // anywhere above it -- so the gate screen's "needs init" state is the
    // real thing, not simulated.
    freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-demo-gate-'));
    const res = await request.post(`${API_BASE}/api/settings`, { data: { projectDir: freshDir } });
    expect(res.ok()).toBeTruthy();
    const settings = await res.json();
    expect(settings.needsInit).toBe(true);
  });

  test.afterAll(() => {
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  test('1. a fresh directory shows the "No Construct project here yet" gate', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('No Construct project here yet');
    await expect(page.locator('.gate-panel code').first()).toHaveText(freshDir);
    await expect(page.getByRole('button', { name: 'Initialize Construct here' })).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '149-1-gate-not-initialized.png'), fullPage: true });
  });

  test('2. clicking "Initialize Construct here" runs real init and unblocks the Dashboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Initialize Construct here' }).click();
    // The gate re-fetches status after a successful init and swaps to the
    // wrapped route's real content (the Features screen, at "/").
    await expect(page.locator('h1')).toHaveText('Features', { timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '149-2-gate-initialized-dashboard.png'), fullPage: true });

    // Real evidence the UI's init did exactly what `construct init` does on
    // disk -- not just flip a flag in memory.
    expect(fs.existsSync(path.join(freshDir, 'architecture.yml'))).toBe(true);
    expect(fs.existsSync(path.join(freshDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(freshDir, 'app', 'page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(freshDir, 'features', 'core', 'index.ts'))).toBe(true);
  });
});

// -----------------------------------------------------------------------
// #150 -- Settings: project directory switching + per-capability LLM
// provider configuration (ui/client/features/settings), including the
// live guardrail that rejects "ollama" for planAnalysis.
// -----------------------------------------------------------------------
test.describe.serial('Demo #150 (UI) -- Settings: project directory + per-capability LLM config', () => {
  let originalSettings;
  let otherProjectDir;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/settings`);
    originalSettings = await res.json();

    // A second, real, already-initialized Construct project to switch to.
    otherProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-demo-settings-project-'));
    runCli(['init', otherProjectDir]);
  });

  test.afterAll(async ({ request }) => {
    fs.rmSync(otherProjectDir, { recursive: true, force: true });
    // Leave global (in-memory, server-wide) settings state as this suite
    // found it, so later spec files aren't affected by this one.
    await request.post(`${API_BASE}/api/settings`, {
      data: { projectDir: originalSettings.projectDir, llmProviders: originalSettings.llmProviders },
    });
  });

  test('1. Settings page loads; the resolved paths are collapsed and the old "Current resolution" panel is gone (#391)', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('h1')).toHaveText('Settings');
    await expect(page.getByText('Current resolution')).toHaveCount(0);
    const paths = page.locator('details.settings-current');
    await expect(paths.locator('summary')).toHaveText('Show resolved paths');
    await expect(paths).not.toHaveAttribute('open', '');
    await paths.locator('summary').click();
    await expect(paths).toContainText('Project directory');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '150-1-settings-initial.png'), fullPage: true });
  });

  test('2. switching the active project directory to a different real project', async ({ page, request }) => {
    // The project field is read-only since the folder picker (#365), so the switch goes through the same API
    // the picker uses; this test was already failing on the old typed-path placeholder before #391.
    const res = await request.post(`${API_BASE}/api/settings`, { data: { projectDir: otherProjectDir } });
    expect(res.ok()).toBeTruthy();
    await page.goto('/settings');
    await page.locator('details.settings-current summary').click();
    await expect(page.locator('.settings-current')).toContainText(otherProjectDir);
    await expect(page.locator('.settings-current')).toContainText('Resolved Construct project root');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '150-2-settings-project-dir-switched.png'), fullPage: true });
  });

  test('3. selecting a local Qwen model (Ollama) for importFill and createFill', async ({ page }) => {
    await page.goto('/settings');
    // Real, live Ollama -- both options are actually offered because
    // ui/server/src/settings.mjs's availableProvidersByCapability allows
    // 'ollama' for these two capabilities.
    await expect(page.locator('#llm-importFill option', { hasText: 'ollama' })).toHaveCount(1);
    await expect(page.locator('#llm-createFill option', { hasText: 'ollama' })).toHaveCount(1);

    await page.selectOption('#llm-importFill', 'ollama');
    await page.selectOption('#llm-createFill', 'ollama');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('.status-ok')).toBeVisible();
    await expect(page.locator('#llm-importFill')).toHaveValue('ollama');
    await expect(page.locator('#llm-createFill')).toHaveValue('ollama');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '150-3-settings-ollama-selected.png'), fullPage: true });
  });

  test('4. planAnalysis has no Ollama option in the UI, and a direct attempt to set it is rejected live', async ({ page, request }) => {
    await page.goto('/settings');

    // Guardrail, layer 1: the dropdown itself never offers the forbidden
    // option -- a user cannot pick 'ollama' for planAnalysis through
    // normal interaction at all.
    await expect(page.locator('#llm-planAnalysis option', { hasText: 'ollama' })).toHaveCount(0);

    // Guardrail, layer 2 (the real, hard-enforced one, per epic #96): even
    // a direct API request attempting it is rejected server-side -- not
    // just hidden client-side. Real HTTP call against the real running
    // ui/server, no mocking.
    const res = await request.post(`${API_BASE}/api/settings`, {
      data: { llmProviders: { planAnalysis: 'ollama' } },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('cannot be used for planAnalysis');
    console.log(`\nPOST /api/settings {llmProviders:{planAnalysis:"ollama"}} -> HTTP ${res.status()}\n${JSON.stringify(body)}`);

    // Confirm the rejected write left no trace: reloading Settings still
    // shows planAnalysis at whatever it was, never 'ollama'.
    await page.reload();
    await expect(page.locator('#llm-planAnalysis')).not.toHaveValue('ollama');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '150-4-settings-plananalysis-ollama-rejected.png'), fullPage: true });
  });
});
