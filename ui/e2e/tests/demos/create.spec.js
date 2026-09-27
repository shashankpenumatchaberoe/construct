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
// user would run it — never a mocked/hand-written stand-in for its output.
const CLI_BIN = path.resolve(__dirname, '../../../../packages/cli/construct.mjs');
const API_BASE = process.env.E2E_API_BASE || 'http://localhost:4000';

/** Runs a real `construct` command against the shared scratch project and
 * logs the exact command + its real stdout, so the run's own console output
 * doubles as the "real terminal transcript" the Demos module (#125) and
 * #127 require — nothing here is fabricated after the fact. */
function runCli(args) {
  const out = execFileSync('node', [CLI_BIN, ...args], { encoding: 'utf8' });
  console.log(`\n$ construct ${args.join(' ')}\n${out}`);
  return out;
}

// This suite is issue #127's demo evidence (Demos epic #125): one
// continuous story per subtask, alternating between the real CLI and the
// real Cockpit UI against the SAME scratch project, proving they are two
// faces of the same engine rather than two disconnected features. Serial +
// one worker (see playwright.config.js) because every step below shares
// state in the same scratch project directory and the same backend
// process's in-memory "current project" setting.
test.describe.serial('Demo #127 — construct create (connected CLI <-> UI walkthrough)', () => {
  let projectDir;

  test.beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-demo-create-'));
    runCli(['init', projectDir]);
  });

  test.afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // Subtask 1: creating a new feature — a command typed in the terminal
  // shows up moments later in the Cockpit UI, with no extra step needed to
  // "sync" it — both surfaces read the same real project on disk.
  test('1. create a feature via the CLI, see it in the UI', async ({ page, request }) => {
    runCli(['create', 'feature', 'billing', '--dir', projectDir]);
    // Same result, shorter form of the command:
    runCli(['feature', 'create', 'payments', '--dir', projectDir]);

    const settingsRes = await request.post(`${API_BASE}/api/settings`, { data: { projectDir } });
    expect(settingsRes.ok()).toBeTruthy();

    await page.goto('/pages');
    await expect(page.locator('h1')).toHaveText('Pages Editor');
    const select = page.locator('.pages-browser select');
    await select.click();
    const optionTexts = await select.locator('option').allTextContents();
    expect(optionTexts).toEqual(expect.arrayContaining(['billing', 'payments']));
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '1-feature-visible-in-ui.png'), fullPage: true });
  });

  // Subtask 2: creating one piece of a feature (a single "layer" file) —
  // again typed in the terminal, then opened straight from the browser.
  test('2. create a single file via the CLI, open it in the UI', async ({ page }) => {
    runCli(['create', 'page', 'Invoice', '--feature', 'billing', '--dir', projectDir]);
    // Same result, shorter form of the command:
    runCli(['generate', 'hook', 'InvoiceTotals', '--feature', 'billing', '--dir', projectDir]);

    await page.goto('/pages');
    await page.locator('.pages-browser select').selectOption('billing');
    const openButton = page.getByRole('button', { name: 'InvoicePage.tsx' });
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.click();
    await expect(page.locator('.tree-panel')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '2-single-file-open-in-ui.png'), fullPage: true });
  });

  // Subtask 3: creating a whole working slice of a feature (several
  // related files) in one command, then browsing the result in the UI.
  test('3. create several files at once via the CLI, browse them in the UI', async ({ page }) => {
    runCli(['create', 'layer', 'OrderFlow', '--feature', 'billing', '--layers', 'domain,service,workflow,hook,component,page,controller', '--dir', projectDir]);
    // Same result, shorter form — and given out of the usual order, to
    // show Construct still builds everything in the right order for you.
    runCli(['generate', 'layer', 'AltFlow', '--feature', 'billing', '--layers', 'controller,page,domain', '--dir', projectDir]);

    await page.goto('/pages');
    await page.locator('.pages-browser select').selectOption('billing');
    const openButton = page.getByRole('button', { name: 'OrderFlowPage.tsx' });
    await expect(openButton).toBeVisible({ timeout: 10_000 });
    await openButton.click();
    await expect(page.locator('.tree-panel')).toBeVisible();
    await page.locator('.tree-node').first().click();
    await expect(page.locator('.snippet-editor')).toBeVisible();
    await expect(page.locator('.props-inspector')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '3-multi-file-slice-in-ui.png'), fullPage: true });
  });

  // Subtask 4: the reverse direction — using the Dashboard's Create form in
  // the browser, then confirming the result back in the terminal.
  test('4. create via the Dashboard form in the UI, confirm via the CLI', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('h1')).toHaveText('Dashboard');
    const createForm = page.locator('.command-form', { has: page.getByRole('heading', { name: 'Create' }) });

    // Create a new feature from the form.
    await createForm.getByPlaceholder('e.g. CpoAccess').fill('storefront');
    await createForm.getByRole('button', { name: /^Create (feature|slice|file)$/ }).click();
    await expect(createForm.locator('.attribution-label.tool').first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '4-ui-create-feature-result.png'), fullPage: true });

    // Create several files at once into that new feature, from the form.
    await createForm.locator('select').first().selectOption('layer');
    await createForm.getByPlaceholder('e.g. CpoAccess').fill('Checkout');
    await createForm.getByPlaceholder('e.g. cpo-v2').fill('storefront');
    for (const layer of ['domain', 'service', 'page']) {
      await createForm.locator('.layer-checkboxes .checkbox', { hasText: layer }).locator('input[type="checkbox"]').check();
    }
    await createForm.getByRole('button', { name: /^Create (feature|slice|file)$/ }).click();
    await expect(createForm.locator('.command-output')).toContainText('CheckoutPage', { timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '5-ui-create-layer-result.png'), fullPage: true });

    // Create one more single file from the form.
    await createForm.locator('select').first().selectOption('single');
    await createForm.getByPlaceholder('e.g. CpoAccess').fill('PromoBanner');
    await createForm.getByPlaceholder('e.g. cpo-v2').fill('storefront');
    await createForm.locator('select').nth(1).selectOption('component');
    await createForm.getByRole('button', { name: /^Create (feature|slice|file)$/ }).click();
    await expect(createForm.locator('.command-output')).toContainText('PromoBanner', { timeout: 10_000 });

    // Back in the terminal: everything the form just did is there for real
    // (--format json lists each file's real path, so this checks the exact
    // files the form created, not just an aggregate count).
    const out = runCli(['research', 'summarize', '--feature', 'storefront', '--format', 'json', '--dir', projectDir]);
    expect(out).toContain('CheckoutPage.tsx');
    expect(out).toContain('PromoBanner.tsx');
  });
});
