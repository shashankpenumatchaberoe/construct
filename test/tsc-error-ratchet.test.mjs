// tsc error-count ratchet (#606). `npm run build` (tsc --noEmit under checkJs) reports a large
// number of pre-existing type errors; see packages/tools/tsc-ratchet/check.mjs's header comment
// and packages/tools/tsc-ratchet/README.md for why this is a ratchet (baseline only decreases)
// rather than a fix-by-file or a narrowed checkJs scope. Runs the real `tsc` binary the same way
// `npm run build` does -- a real compiler invocation takes real wall-clock time (a few seconds),
// same tradeoff test/typed-contracts-tsc.test.mjs already makes: plain `node --test`, no
// heavy.sh needed per-test (the whole suite is already run through heavy.sh at the top level).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure, compare, REPO_ROOT } from '../packages/tools/tsc-ratchet/check.mjs';

const BASELINE_FILE = path.join(REPO_ROOT, 'packages/tools/tsc-ratchet/baseline.json');

test('tsc error ratchet: compare flags a rise per file and never a fall', () => {
  const { regressions, improvements } = compare({ 'a.mjs': 3, 'b.mjs': 1, 'new.mjs': 1 }, { 'a.mjs': 2, 'b.mjs': 4, 'gone.mjs': 2 });
  assert.deepEqual(regressions.map((r) => r.file).sort(), ['a.mjs', 'new.mjs']);
  assert.deepEqual(improvements.map((r) => r.file).sort(), ['b.mjs', 'gone.mjs']);
});

test('tsc error ratchet: the repository has no more tsc errors than the committed baseline', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).files;
  const { files } = measure();
  const current = Object.fromEntries(Object.entries(files).map(([f, errs]) => [f, errs.length]));
  const { regressions } = compare(current, baseline);
  assert.deepEqual(
    regressions,
    [],
    'a file has more tsc errors than the committed baseline allows; fix the new error(s), or ' +
      'if this is pre-existing debt being paid down, run `node packages/tools/tsc-ratchet/check.mjs --update` ' +
      'once the count is genuinely lower -- the baseline never rises.',
  );
});
