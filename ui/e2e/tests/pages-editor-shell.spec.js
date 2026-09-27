import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, '../screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const API_BASE = process.env.E2E_API_BASE || 'http://localhost:4000';

// #247 — the Pages Editor inside the Cockpit shell: page/feature tree in the
// Browser pane, previews in the stage, Inspector / Scope / Source / Diff as
// Tools tabs (design mock: pages-editor-in-shell).
const FIXTURE_PAGE = `import React, { useState } from 'react';

export default function LoginPage({ title }: { title: string }) {
  const [email, setEmail] = useState('');

  return (
    <main>
      <h1>{title}</h1>
      <form onSubmit={() => setEmail('')}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit" disabled={!email}>Sign in</button>
      </form>
    </main>
  );
}
`;

test.describe.serial('Pages Editor inside the shell (#247)', () => {
  let tmpProjectDir;
  let pagePath;

  test.beforeAll(async ({ request }) => {
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-ui-e2e-pe-shell-'));
    await request.post(`${API_BASE}/api/settings`, { data: { projectDir: tmpProjectDir } });
    await request.post(`${API_BASE}/api/init`);
    await request.post(`${API_BASE}/api/create`, { data: { kind: 'single', name: 'Login', feature: 'auth', layer: 'page' } });
    pagePath = path.join(tmpProjectDir, 'features/auth/pages/LoginPage.tsx');
    fs.writeFileSync(pagePath, FIXTURE_PAGE);
  });

  test.afterAll(async ({ request }) => {
    await request.post(`${API_BASE}/api/settings`, { data: { projectDir: path.resolve(__dirname, '../../..') } });
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  async function openLogin(page) {
    await page.goto('/pages');
    await page.locator('.pages-browser select').selectOption('auth');
    await page.getByRole('button', { name: 'LoginPage.tsx' }).click();
    await expect(page.locator('.tree-panel')).toBeVisible();
  }

  test('tree in the Browser, previews in the stage, Tools tabs switch, preview click selects', async ({ page }) => {
    await openLogin(page);
    const browser = page.getByRole('complementary', { name: 'Browser' });
    const tools = page.getByRole('complementary', { name: 'Tools' });
    const main = page.getByRole('main');

    // Arrangement: Pages tab (first) holds the picker and the JSX tree; the stage holds the previews.
    // #683's rail merge moved this tablist out of the complementary "Browser" landmark into a
    // standalone sibling tablist of the same name (see #706) -- query it from `page`, not `browser`.
    await expect(page.getByRole('tablist', { name: 'Browser' }).getByRole('tab').first()).toHaveText('Pages');
    await expect(browser.locator('.pages-browser')).toBeVisible();
    await expect(browser.locator('.tree-panel')).toBeVisible();
    await expect(main.locator('.tree-panel')).toHaveCount(0);
    await expect(main.locator('.live-preview-panel')).toBeVisible();
    await expect(main.locator('.preview-panel')).toBeVisible();

    // Tools tabs, Inspector first; Scope / Source / Palette / Diff enabled once a page is open.
    // (#535: #527 added the real Palette tab between Source and Diff but never updated this
    // assertion — pre-existing, unrelated to #533/#534's own changes; fixed independently on
    // both branches, this comment is the merged version.)
    await expect(tools.getByRole('tab')).toHaveText(['Inspector', 'Scope', 'Source', 'Palette', 'Diff', 'Project']);
    await expect(tools.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    await expect(tools.getByText('Select a tree node or preview element to inspect it.')).toBeVisible();

    // Clicking an element in the preview selects it in the tree and fills the Inspector.
    await main.locator('.preview-node-label', { hasText: 'button' }).click();
    await expect(browser.locator('.tree-node.selected')).toContainText('<button>');
    await expect(tools.locator('.snippet-editor')).toBeVisible();
    await expect(tools.locator('.props-inspector')).toContainText('type');

    // Switching tabs keeps the selection and changes the panel.
    await tools.getByRole('tab', { name: 'Scope' }).click();
    await expect(tools.locator('.scope-panel')).toBeVisible();
    await tools.getByRole('tab', { name: 'Source' }).click();
    await expect(tools.getByRole('button', { name: 'View source' })).toBeVisible();
    await tools.getByRole('tab', { name: 'Diff' }).click();
    await expect(tools.getByText('No outside changes.')).toBeVisible();
    await tools.getByRole('tab', { name: 'Inspector' }).click();
    await expect(tools.locator('.snippet-editor')).toBeVisible();
    await expect(browser.locator('.tree-node.selected')).toContainText('<button>');
  });

  for (const theme of ['dark', 'light']) {
    test(`pages-editor-shell-${theme}.png — the arrangement in the ${theme} theme`, async ({ page }) => {
      if (theme === 'light') await page.addInitScript(() => localStorage.setItem('construct.theme', 'light'));
      await openLogin(page);
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
      await page.getByRole('main').locator('.preview-node-label', { hasText: 'button' }).click();
      await expect(page.getByRole('complementary', { name: 'Tools' }).locator('.snippet-editor')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `pages-editor-shell-${theme}.png`) });
    });
  }

  test('an outside change flags the Diff tab and the stage; Diff shows it', async ({ page }) => {
    await openLogin(page);
    fs.writeFileSync(pagePath, FIXTURE_PAGE.replace('Sign in', 'Log in'));
    const tools = page.getByRole('complementary', { name: 'Tools' });
    const diffTab = tools.getByRole('tab', { name: /^Diff/ });
    await expect(diffTab.locator('.sh-badge')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Changed on disk' })).toBeVisible();
    await diffTab.click();
    await expect(tools.locator('.external-change-notice')).toContainText('Log in', { timeout: 10_000 });
  });
});
