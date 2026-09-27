import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gotoCockpit } from './support/cockpit.js';

// #370 - the Dashboard is retired as a landing: `/` is the Features screen, and the Dashboard's four forms
// (Create, Refactor, Research, Import) are its stage actions. The forms behave exactly as before (walkthrough.spec.js
// runs a real Create through them); this spec covers how they are reached.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, '../screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

test('/ lands on Features, the stage actions are collapsed, and each opens its own form', async ({ page }) => {
  await gotoCockpit(page, '/');
  await expect(page.locator('h1')).toHaveText('Features');
  await expect(page.getByRole('navigation', { name: 'Screens', exact: true }).getByRole('link', { name: 'Features' })).toHaveAttribute('aria-current', 'page');
  const actions = page.getByTestId('stage-actions');
  await expect(actions.getByRole('button')).toHaveText(['Create', 'Refactor', 'Research', 'Import']);
  // Quiet by default: no form is open until one is chosen.
  await expect(page.getByTestId('stage-action-panel')).toHaveCount(0);
  await expect(page.locator('.command-form')).toHaveCount(0);

  const panel = page.getByTestId('stage-action-panel');
  for (const [id, heading] of [['create', 'Create'], ['refactor', 'Refactor'], ['research', 'Research'], ['import', 'Import an existing file']]) {
    await page.getByTestId(`stage-action-${id}`).click();
    await expect(page.getByTestId(`stage-action-${id}`)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.locator('.command-form')).toHaveCount(1); // one at a time
    await expect(panel).toBeFocused(); // a keyboard user lands on the form
  }
  await page.getByTestId('stage-action-create').click();
  await page.screenshot({ path: path.join(SHOTS, '370-features-stage-actions.png') });

  // Choosing the open action again closes it.
  await page.getByTestId('stage-action-create').click();
  await expect(page.getByTestId('stage-action-panel')).toHaveCount(0);
});

test('a stage action runs the same deterministic command as the Dashboard did, with attribution', async ({ page }) => {
  await gotoCockpit(page, '/');
  await page.getByTestId('stage-action-research').click();
  const form = page.locator('.command-form');
  await form.getByRole('button', { name: /Run research/ }).click();
  await expect(form.locator('.attribution-label.tool').first()).toBeVisible({ timeout: 30_000 });
  await expect(form.locator('.command-output')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, '370-features-research-result.png') });
});

test('/plan is the same Features screen, and /dashboard still answers for old links', async ({ page }) => {
  await gotoCockpit(page, '/plan');
  await expect(page.locator('h1')).toHaveText('Features');
  await expect(page.getByTestId('stage-actions')).toBeVisible();
  await page.getByRole('tablist', { name: 'Browser' }).getByRole('tab', { name: 'Notes' }).click();
  await expect(page.getByTestId('plan-ticket')).toBeVisible(); // the Notes tab is still in the Browser, beside the Features list
  await page.goto('/dashboard');
  await expect(page.locator('h1')).toHaveText('Dashboard');
  await expect(page.getByRole('navigation', { name: 'Screens', exact: true }).getByRole('link', { name: 'Features' })).toHaveAttribute('aria-current', 'page');
});
