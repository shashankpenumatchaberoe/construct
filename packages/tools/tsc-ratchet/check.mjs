#!/usr/bin/env node
// tsc error-count ratchet (#606). Deterministic, no LLM. `npm run build` (tsc --noEmit under
// checkJs, per the root tsconfig.json) reports a large number of pre-existing type errors across
// packages/engine/testSteps.mjs, testClone.mjs, packages/core/cli.mjs, architecture-enforcer.mjs,
// packages/ast/jsx*.mjs and others. None affect runtime; the 2100+ tests are unaffected. Rather
// than fix them by file (risking collisions with in-flight PRs touching those exact files) or
// narrow checkJs's scope, this ratchet runs the real `tsc` the same way `npm run build` does and
// FAILS only when the per-file error count rises above packages/tools/tsc-ratchet/baseline.json
// (the baseline only ever decreases; a file with no errors today starts at zero and any error
// introduced in it is caught immediately).
//
//   node packages/tools/tsc-ratchet/check.mjs            check against the baseline (exit 1 on regression)
//   node packages/tools/tsc-ratchet/check.mjs --report   list every error, grouped by file
//   node packages/tools/tsc-ratchet/check.mjs --update   lower the baseline to the current counts (refuses to raise it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASELINE_FILE = path.join(HERE, 'baseline.json');
const TSC = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
const TSCONFIG = path.join(REPO_ROOT, 'tsconfig.json');

const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** Run the real `tsc --noEmit -p tsconfig.json` (the same invocation `npm run build` uses) and
 * parse its diagnostics. Returns { files: { [relPath]: [{ line, col, code, message }] }, total,
 * raw }. Never throws: tsc exits non-zero when there are errors, which is the expected case. */
export function measure(repoRoot = REPO_ROOT, tscPath = TSC, tsconfigPath = TSCONFIG) {
  let raw = '';
  try {
    raw = execFileSync(tscPath, ['--noEmit', '-p', tsconfigPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    raw = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const files = {};
  let total = 0;
  for (const line of raw.split('\n')) {
    const m = ERROR_LINE.exec(line.trim());
    if (!m) continue;
    const [, file, ln, col, code, message] = m;
    const rel = path.posix.normalize(file.split(path.sep).join('/'));
    (files[rel] ??= []).push({ line: Number(ln), col: Number(col), code, message });
    total += 1;
  }
  return { files, total, raw };
}

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
const readBaseline = () => (fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : { files: {} });

/** Compare current per-file error counts with a baseline; returns the regressions (a file with
 * more errors than the baseline allows) and the improvements (fewer). Mirrors
 * packages/tools/api-coverage/check.mjs's compare(). */
export function compare(current, baseline) {
  const regressions = [];
  const improvements = [];
  for (const [f, n] of Object.entries(current)) if (n > (baseline[f] ?? 0)) regressions.push({ file: f, was: baseline[f] ?? 0, now: n });
  for (const [f, n] of Object.entries(baseline)) if ((current[f] ?? 0) < n) improvements.push({ file: f, was: n, now: current[f] ?? 0 });
  return { regressions, improvements };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const { files, total: currentTotal } = measure();
  const counts = Object.fromEntries(Object.entries(files).map(([f, errs]) => [f, errs.length]));
  const baseline = readBaseline();
  const { regressions, improvements } = compare(counts, baseline.files || {});
  if (args.has('--report')) {
    for (const [f, errs] of Object.entries(files)) for (const e of errs) console.log(`${f}:${e.line}  ${e.code}  ${e.message}`);
  }
  console.log(`tsc errors: ${currentTotal} in ${Object.keys(counts).length} files (baseline ${total(baseline.files || {})})`);
  if (args.has('--update')) {
    if (regressions.length && fs.existsSync(BASELINE_FILE)) {
      console.error('Refusing to raise the baseline:\n' + regressions.map((r) => `  ${r.file}: ${r.was} -> ${r.now}`).join('\n'));
      process.exit(1);
    }
    fs.writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        {
          note: 'Per-file tsc --noEmit error counts (npm run build). Only ever decreases: node packages/tools/tsc-ratchet/check.mjs --update. See docs/API-DOCS.md "Coverage is enforced by the ratchet" for the sibling api-coverage ratchet this mirrors, and packages/tools/tsc-ratchet/README.md for how to lower this one.',
          total: currentTotal,
          files: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Baseline written (${currentTotal}).`);
  } else if (regressions.length) {
    console.error('tsc error count regressed (the baseline only decreases):\n' + regressions.map((r) => `  ${r.file}: ${r.was} -> ${r.now}`).join('\n'));
    for (const r of regressions) for (const e of files[r.file]) console.error(`    ${r.file}:${e.line}  ${e.code}  ${e.message}`);
    process.exit(1);
  } else if (improvements.length) {
    console.log(`tsc errors dropped in ${improvements.length} file(s); run with --update to lower the baseline.`);
  }
}
