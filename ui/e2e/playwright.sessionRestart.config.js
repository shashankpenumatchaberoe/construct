// Dedicated run for the persisted-session-secret spec (#418):
//
//   npx playwright test -c playwright.sessionRestart.config.js --workers=1
//
// This config exists because the spec needs to SIGTERM and restart ui/server
// mid-test, from the same state directory, to prove a session cookie issued
// before the restart still verifies after it (auth.mjs's persisted
// `<stateDir>/session-secret`, replacing the old "random secret per
// process" that signed everyone out on every restart). Playwright's own
// `webServer` option starts a server once per run and cannot express a
// restart, so the spec manages its own disposable ui/server child process
// on a free port (mirroring docs-logo-status.spec.js's own pattern) and
// this config deliberately starts NEITHER shared dev server — booting the
// ordinary client (:3000) / server (:4000) pair would be pure overhead for
// a spec that never touches them.
import base from './playwright.config.js';

export default {
  ...base,
  testIgnore: [],
  testMatch: /sessionRestart\.spec\.js/,
  timeout: 60_000,
  webServer: [],
};
