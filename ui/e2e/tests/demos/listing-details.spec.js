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
const OPENAPI_FIXTURE = path.resolve(__dirname, '../../../../fixtures/openapi-products/products.yaml');
// Overridable so this spec can run against any E2E_SERVER_PORT (the config
// exports the matching origin as E2E_API_BASE; see playwright.config.js, #140).
const API_BASE = process.env.E2E_API_BASE || 'http://localhost:4000';

/** Runs a real `construct` command against the shared scratch project and
 * logs the exact command + its real stdout, so the run's own console output
 * doubles as the real terminal transcript — nothing here is fabricated. */
function runCli(args) {
  const out = execFileSync('node', [CLI_BIN, ...args], { encoding: 'utf8' });
  console.log(`\n$ construct ${args.join(' ')}\n${out}`);
  return out;
}

// Issue #133 (Demos epic #125): the "Products" listing/details example.
// Each `test.describe.serial` block below is this file's independent slice
// for ONE of #133's three subtasks' UI section (#135 deterministic
// scaffolding, #136 LLM-assisted — UI gap, #137 zero-LLM data layer from an
// OpenAPI spec). They share one scratch project + dev-server session as
// test *infrastructure* only; the write-ups on each issue stand on their
// own, with no narrative cross-references between them.
test.describe.serial('Demo #133 — Products listing & details (UI)', () => {
  let projectDir;

  test.beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-demo-products-ui-'));
    runCli(['init', projectDir]);
  });

  test.afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // #135 — deterministic scaffolding via the Dashboard's Create form: the
  // whole Products feature, then its listing and details vertical slices,
  // built purely by clicking through the UI, zero LLM involvement.
  test('#135 — scaffold the Products feature + listing/details pages from the Dashboard', async ({ page, request }) => {
    const settingsRes = await request.post(`${API_BASE}/api/settings`, { data: { projectDir } });
    expect(settingsRes.ok()).toBeTruthy();

    await page.goto('/dashboard');
    await expect(page.locator('h1')).toHaveText('Dashboard');
    const createForm = page.locator('.command-form', { has: page.getByRole('heading', { name: 'Create' }) });

    // 1. A new feature.
    await createForm.getByPlaceholder('e.g. CpoAccess').fill('products');
    await createForm.getByRole('button', { name: /^Create (feature|slice|file)$/ }).click();
    await expect(createForm.locator('.attribution-label.tool').first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'listing-details-1-ui-create-feature.png'), fullPage: true });

    // 2. The listing page's vertical slice (domain/service/hook/component/page/controller).
    await createForm.locator('select').first().selectOption('layer');
    await createForm.getByPlaceholder('e.g. CpoAccess').fill('ProductsListing');
    await createForm.getByPlaceholder('e.g. cpo-v2').fill('products');
    for (const layer of ['domain', 'service', 'hook', 'component', 'page', 'controller']) {
      await createForm.locator('.layer-checkboxes .checkbox', { hasText: layer }).locator('input[type="checkbox"]').check();
    }
    await createForm.getByRole('button', { name: /^Create (feature|slice|file)$/ }).click();
    await expect(createForm.locator('.command-output')).toContainText('ProductsListingPage', { timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'listing-details-2-ui-create-listing-slice.png'), fullPage: true });

    // 3. The details page's vertical slice — same layers, same one form.
    await createForm.getByPlaceholder('e.g. CpoAccess').fill('ProductDetails');
    await createForm.getByRole('button', { name: /^Create (feature|slice|file)$/ }).click();
    await expect(createForm.locator('.command-output')).toContainText('ProductDetailsPage', { timeout: 10_000 });

    // Both pages are immediately browsable in Pages Editor — same project on disk.
    await page.goto('/pages');
    await page.locator('.pages-browser select').selectOption('products');
    await expect(page.getByRole('button', { name: 'ProductsListingPage.tsx' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'ProductDetailsPage.tsx' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'ProductsListingPage.tsx' }).click();
    await expect(page.locator('.tree-panel')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'listing-details-3-ui-browse-pages.png'), fullPage: true });
  });

  // #136 — LLM-assisted create from the UI. Since #109 the Create form has an
  // opt-in, per-run checkbox that uses the provider chosen in Settings; it
  // stays OFF by default so nothing calls a model unless the user asks.
  test('#136 — the Dashboard Create form has an opt-in LLM checkbox, off by default', async ({ page }) => {
    await page.goto('/dashboard');
    const createForm = page.locator('.command-form', { has: page.getByRole('heading', { name: 'Create' }) });
    await expect(createForm).toBeVisible();
    await createForm.locator('select').first().selectOption('layer'); // the checkbox applies to layer / vertical-slice creates
    const llmBox = createForm.getByLabel(/Have the LLM write the implementation/);
    await expect(llmBox).toBeVisible();
    await expect(llmBox).not.toBeChecked();
    await llmBox.check();
    await expect(llmBox).toBeChecked();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'listing-details-4-ui-llm-option-on-create.png'), fullPage: true });
    await llmBox.uncheck();
  });

  // #137 — the zero-LLM data layer: `construct create service` with
  // --openapi is CLI-only today (ui/server's /api/create has no openapi
  // field), so this proves that honestly: the real CLI-generated service
  // files show up via the Dashboard's Research form (read-only, browses
  // the same project on disk), and the UI's own Create form is shown
  // producing only a plain stub for a "service" layer — no spec field
  // exists on it.
  test('#137 — CLI-generated OpenAPI service files are visible via Research; the UI Create form only offers a plain stub', async ({ page }) => {
    runCli(['create', 'service', 'products', '--feature', 'products', '--openapi', OPENAPI_FIXTURE, '--dir', projectDir]);

    await page.goto('/dashboard');
    await page.locator('.dashboard-more > summary').click(); // #391: Research sits under More actions
    const researchForm = page.locator('.command-form', { has: page.getByRole('heading', { name: 'Research' }) });
    await researchForm.locator('select').selectOption('summarize');
    await researchForm.getByLabel(/Feature/).fill('products');
    await researchForm.getByRole('button', { name: 'Run research' }).click();
    await expect(researchForm.locator('.command-output')).toContainText('productsApi', { timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'listing-details-5-ui-research-openapi-service.png'), fullPage: true });

    // Contrast: the Create form's "single layer" path for a service is a
    // plain stub — no OpenAPI spec field exists anywhere on this form.
    const createForm = page.locator('.command-form', { has: page.getByRole('heading', { name: 'Create' }) });
    await createForm.locator('select').first().selectOption('single');
    await createForm.getByPlaceholder('e.g. CpoAccess').fill('Reviews');
    await createForm.getByPlaceholder('e.g. cpo-v2').fill('products');
    await createForm.locator('select').nth(1).selectOption('service');
    await expect(createForm.getByText(/openapi/i)).toHaveCount(0);
    await createForm.getByRole('button', { name: /^Create (feature|slice|file)$/ }).click();
    await expect(createForm.locator('.command-output')).toContainText('Reviews', { timeout: 10_000 });
  });
});
