import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewBridgeScript } from '../../../packages/engine/previewBridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.E2E_API_BASE || 'http://localhost:4000';
// A port of its own (not the live-preview spec's 5125): the two specs run under the same dedicated-port
// config, one file at a time, but a port of its own means ordering between them is never load-bearing.
const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT2) || 5126;

// #558: the framed app has no click-to-source annotations at all here (no `data-cx-src`) -- this fixture
// exercises the raw-stack-frame fallback path (the annotated-element path is covered by
// packages/engine/previewBridge.test.mjs's unit tests). `Widget.tsx` throws at a known line so the test
// can assert the Navigator opens exactly there; the library script throws from a `/node_modules/` path,
// which the bridge never treats as a project frame.
const WIDGET_JS = '// a comment line, so the throw below is not line 1\n'
  + 'function WidgetRender() {\n'
  + '  throw new Error("Widget blew up");\n'
  + '}\n'
  + 'window.throwProject = WidgetRender;\n';
const LIBRARY_JS = 'function LibraryInternal() {\n  throw new Error("library exploded");\n}\nwindow.throwLibrary = LibraryInternal;\n';

function previewHtml() {
  return `<!doctype html><html><body style="font-family:sans-serif;padding:24px">
<h1>Preview app</h1>
<button id="throw-project" onclick="window.throwProject()">Throw project error</button>
<button id="throw-library" onclick="window.throwLibrary()">Throw library error</button>
<script src="/features/billing/components/Widget.tsx"></script>
<script src="/node_modules/some-lib/index.js"></script>
<script>${previewBridgeScript()}</script>
</body></html>`;
}

test.describe('Pages Editor: live preview app error -> "Show in source" (#558)', () => {
  let tmpProjectDir;
  let previewServer;

  test.beforeAll(async ({ request }) => {
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'construct-ui-e2e-preview-error-source-'));
    await request.post(`${API_BASE}/api/settings`, { data: { projectDir: tmpProjectDir } });
    await request.post(`${API_BASE}/api/init`);
    await request.post(`${API_BASE}/api/create`, { data: { kind: 'single', name: 'Home', feature: 'billing', layer: 'page' } });
    fs.writeFileSync(path.join(tmpProjectDir, 'features/billing/pages/HomePage.tsx'), 'export default function HomePage() { return null; }\n');
    fs.mkdirSync(path.join(tmpProjectDir, 'features/billing/components'), { recursive: true });
    fs.writeFileSync(path.join(tmpProjectDir, 'features/billing/components/Widget.tsx'), '// comment line, so the throw below is not line 1\nexport function Widget() { return null; }\n');

    previewServer = http.createServer((req, res) => {
      if (req.url === '/features/billing/components/Widget.tsx') {
        res.setHeader('content-type', 'application/javascript');
        return res.end(WIDGET_JS);
      }
      if (req.url === '/node_modules/some-lib/index.js') {
        res.setHeader('content-type', 'application/javascript');
        return res.end(LIBRARY_JS);
      }
      res.setHeader('content-type', 'text/html');
      return res.end(previewHtml());
    });
    await new Promise((r) => previewServer.listen(PREVIEW_PORT, '127.0.0.1', r));
  });

  test.afterAll(async ({ request }) => {
    previewServer?.close();
    await request.post(`${API_BASE}/api/settings`, { data: { projectDir: path.resolve(__dirname, '../../..') } });
    fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  });

  test('pages-editor-preview-error-source — a project-file error shows "Show in source" and opens the exact file:line; a library-only error shows no button', async ({ page }) => {
    await page.goto('/pages');
    await page.locator('.pages-browser select').selectOption('billing');
    await page.getByRole('button', { name: 'HomePage.tsx' }).click();
    await expect(page.locator('.tree-panel')).toBeVisible();

    await page.getByLabel('Preview URL').fill(`http://127.0.0.1:${PREVIEW_PORT}/`);
    await page.getByRole('button', { name: 'Load preview' }).click();
    const frame = page.frameLocator('iframe[title="Live app preview"]');
    await expect(frame.locator('#throw-project')).toBeVisible();

    // A library-only stack (every frame under /node_modules/, or none): no "Show in source" button.
    await frame.locator('#throw-library').click();
    const errorCard = page.getByTestId('preview-app-error');
    await expect(errorCard).toBeVisible();
    await expect(errorCard).toContainText('library exploded');
    await expect(errorCard.getByRole('button', { name: 'Show in source' })).toHaveCount(0);
    await errorCard.getByRole('button', { name: 'Dismiss' }).click();
    await expect(errorCard).toBeHidden();

    // A stack with a project frame: the button appears and opens that exact file at that exact line.
    await frame.locator('#throw-project').click();
    await expect(errorCard).toBeVisible();
    await expect(errorCard).toContainText('Widget blew up');
    await errorCard.getByRole('button', { name: 'Show in source' }).click();
    await expect(page.getByTestId('navigator-file')).toContainText('features/billing/components/Widget.tsx');
    await expect(page.getByTestId('navigator-open-line')).toContainText('Opened at line 3');
  });
});
