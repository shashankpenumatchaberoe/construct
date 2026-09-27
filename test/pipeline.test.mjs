import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runPipeline } from '../packages/engine/pipeline.mjs';
import { createEnvelope } from '../packages/engine/envelope.mjs';
import { createFeature } from '../packages/core/generators.mjs';
import { EXIT_CODES } from '../packages/core/diagnostics.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'packages', 'cli', 'construct.mjs');

function tmpProject() {
  const dir = makeTempDir('construct-pipeline-test-');
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'version: 1\npreset: strict-nextjs\nproject:\n  framework: nextjs\nfeatures:\n  root: features\n');
  createFeature(dir, 'checkout');
  return dir;
}

function runCli(args, cwd, input) {
  return spawnSync('node', [bin, ...args], { encoding: 'utf8', cwd, input });
}

test('runPipeline commits every requested step\'s file in one transaction and reports them under layers', () => {
  const dir = tmpProject();
  const input = createEnvelope('checkout', { steps: [{ layer: 'domain', name: 'Total' }] });

  const output = runPipeline(dir, input);

  assert.equal(output.status, 'committed');
  assert.deepEqual(output.diagnostics, []);
  assert.deepEqual(output.layers.domain, ['features/checkout/domain/Total.tsx']);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'checkout', 'domain', 'Total.tsx')), true);
});

test('runPipeline aborts (status "aborted") and writes nothing when a step would fail validate', () => {
  const dir = tmpProject();
  // Override the page template with one that calls fetch() directly, so the
  // rendered content itself trips PAGE-004 (error-severity by default) —
  // proves an aborted run leaves disk completely untouched.
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'page.tsx'), `export function {{Name}}Page(){ fetch('/api'); return null; }\n`);

  const input = createEnvelope('checkout', { steps: [{ layer: 'page', name: 'Bad' }] });
  const output = runPipeline(dir, input);

  assert.equal(output.status, 'aborted');
  assert.ok(output.diagnostics.some((v) => v.rule === 'PAGE-004'));
  assert.equal(fs.existsSync(path.join(dir, 'features', 'checkout', 'pages', 'BadPage.tsx')), false);
});

test('runPipeline against a missing feature aborts with a clear, actionable message naming it (#727), not a bare SLICE-001, and writes nothing', () => {
  const dir = tmpProject(); // only 'checkout' exists
  const input = createEnvelope('ghost', { steps: [{ layer: 'domain', name: 'Total' }] });

  const output = runPipeline(dir, input);

  assert.equal(output.status, 'aborted');
  assert.equal(output.diagnostics.length, 1);
  assert.equal(output.diagnostics[0].rule, 'SLICE-001');
  assert.match(output.diagnostics[0].message, /Feature "ghost" not found \(looked in features\/ghost\)\. Create it first: construct create feature ghost/);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'ghost')), false);
});

test('runPipeline with no steps is a committed no-op that preserves prior envelope state', () => {
  const dir = tmpProject();
  const input = createEnvelope('checkout', { layers: { domain: ['features/checkout/domain/Existing.tsx'] } });
  const output = runPipeline(dir, input);
  assert.equal(output.status, 'committed');
  assert.deepEqual(output.layers.domain, ['features/checkout/domain/Existing.tsx']);
});

// ---- end-to-end via the real CLI binary, stdin/stdout JSON -----------------

test('construct pipeline run: reads an envelope on stdin, writes a committed envelope to stdout, exits 0', () => {
  const dir = tmpProject();
  const input = JSON.stringify(createEnvelope('checkout', { steps: [{ layer: 'domain', name: 'Score' }] }));
  const res = runCli(['pipeline', 'run'], dir, input);

  assert.equal(res.status, EXIT_CODES.OK, res.stderr);
  const output = JSON.parse(res.stdout);
  assert.equal(output.status, 'committed');
  assert.deepEqual(output.layers.domain, ['features/checkout/domain/Score.tsx']);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'checkout', 'domain', 'Score.tsx')), true);
});

test('construct pipeline run: exits non-zero and prints an aborted envelope when validate fails, disk untouched', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'page.tsx'), `export function {{Name}}Page(){ fetch('/api'); return null; }\n`);

  const input = JSON.stringify(createEnvelope('checkout', { steps: [{ layer: 'page', name: 'Bad' }] }));
  const res = runCli(['pipeline', 'run'], dir, input);

  assert.equal(res.status, EXIT_CODES.VIOLATIONS, res.stderr);
  const output = JSON.parse(res.stdout);
  assert.equal(output.status, 'aborted');
  assert.ok(output.diagnostics.some((v) => v.rule === 'PAGE-004'));
  assert.equal(fs.existsSync(path.join(dir, 'features', 'checkout', 'pages', 'BadPage.tsx')), false);
});

test('construct pipeline run: a missing feature exits non-zero with the clear message in the printed envelope, disk untouched', () => {
  const dir = tmpProject(); // only 'checkout' exists
  const input = JSON.stringify(createEnvelope('ghost', { steps: [{ layer: 'domain', name: 'Total' }] }));
  const res = runCli(['pipeline', 'run'], dir, input);

  assert.equal(res.status, EXIT_CODES.VIOLATIONS, res.stderr);
  const output = JSON.parse(res.stdout);
  assert.equal(output.status, 'aborted');
  assert.match(output.diagnostics[0].message, /Feature "ghost" not found \(looked in features\/ghost\)\. Create it first: construct create feature ghost/);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'ghost')), false);
});

test('construct pipeline run: malformed JSON on stdin is a usage error, not an internal crash', () => {
  const dir = tmpProject();
  const res = runCli(['pipeline', 'run'], dir, '{ not valid json');
  assert.equal(res.status, EXIT_CODES.USAGE_ERROR);
  assert.match(res.stderr, /Malformed envelope JSON/);
});

test('construct pipeline run: an envelope missing required fields is a usage error naming what\'s missing', () => {
  const dir = tmpProject();
  const res = runCli(['pipeline', 'run'], dir, JSON.stringify({ feature: 'checkout' }));
  assert.equal(res.status, EXIT_CODES.USAGE_ERROR);
  assert.match(res.stderr, /Invalid Context Envelope/);
  assert.match(res.stderr, /version/);
});
