// Dedicated-port run for the live-preview specs (see #140):
//   E2E_CLIENT_PORT=3125 E2E_SERVER_PORT=4125 E2E_PREVIEW_PORT=5125 npx playwright test -c playwright.live-preview.config.js
// #558's own spec runs here too (a preview app + a bridge, same as the live-preview spec), on its own
// port (E2E_PREVIEW_PORT2, default 5126) so ordering between the two files is never load-bearing.
import base from './playwright.config.js';

export default {
  ...base,
  testMatch: /pages-editor-(live-preview|preview-error-source)\.spec\.js/,
  timeout: 90_000,
};
