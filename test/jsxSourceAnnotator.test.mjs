import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotateJsxSource, annotateJsxFile, parseCxSrc } from '../packages/engine/jsxSourceAnnotator.mjs';
import { parseJsxTree } from '../packages/ast/index.mjs';

const fixture = (n) => new URL(`./fixtures/annotator/${n}`, import.meta.url);
const input = fs.readFileSync(fixture('Page.input.tsx'), 'utf8');

test('golden: annotated output matches the checked-in file', () => {
  const { code } = annotateJsxSource(input, { file: 'features/x/pages/Page.tsx' });
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(fixture('Page.expected.tsx'), code);
  assert.equal(code, fs.readFileSync(fixture('Page.expected.tsx'), 'utf8'));
});

test('annotates host elements only; skips components, fragments and already-annotated', () => {
  const { code, count } = annotateJsxSource(input, { file: 'F.tsx' });
  assert.equal(count, 5); // main h1 ul li input (span already annotated)
  assert.match(code, /<Card title="x">/);
  assert.equal((code.match(/data-cx-src="keep:1:1"/g) || []).length, 1);
});

test('each value is the tree node line:column of the same element', () => {
  const { code } = annotateJsxSource(input, { file: 'F.tsx' });
  const { byId } = parseJsxTree(input);
  const all = [...byId.values()];
  let checked = 0;
  for (const m of code.matchAll(/<(\w+) data-cx-src="F\.tsx:(\d+):(\d+)"/g)) {
    const node = all.find((n) => n.line === Number(m[2]) && n.column === Number(m[3]));
    assert.ok(node, `no tree node at ${m[2]}:${m[3]}`);
    assert.equal(node.tag, m[1]);
    checked++;
  }
  assert.equal(checked, 5);
});

test('output stays parseable and preserves the tree shape', () => {
  const { code } = annotateJsxSource(input, { file: 'F.tsx' });
  assert.equal(parseJsxTree(code).byId.size, parseJsxTree(input).byId.size);
});

test('is idempotent', () => {
  const once = annotateJsxSource(input, { file: 'F.tsx' }).code;
  assert.equal(annotateJsxSource(once, { file: 'F.tsx' }).count, 0);
});

test('requires a file and throws on syntax errors', () => {
  assert.throws(() => annotateJsxSource(input, {}), /file/);
  assert.throws(() => annotateJsxSource('<div', { file: 'a' }));
});

test('parseCxSrc splits from the right and rejects garbage', () => {
  assert.deepEqual(parseCxSrc('C:/a/b.tsx:12:3'), { file: 'C:/a/b.tsx', line: 12, column: 3 });
  assert.equal(parseCxSrc('nope'), null);
  assert.equal(parseCxSrc(null), null);
});

test('annotateJsxFile (#701): standalone entry point reads a file and matches annotateJsxSource', () => {
  const filePath = fileURLToPath(fixture('Page.input.tsx'));
  const root = path.dirname(filePath);
  const { code, count, file } = annotateJsxFile(filePath, { root });
  assert.equal(file, 'Page.input.tsx');
  const direct = annotateJsxSource(input, { file: 'Page.input.tsx' });
  assert.equal(code, direct.code);
  assert.equal(count, direct.count);
});

test('annotateJsxFile defaults root to cwd and throws on a missing file', () => {
  const filePath = fileURLToPath(fixture('Page.input.tsx'));
  const { file } = annotateJsxFile(filePath);
  assert.equal(file, path.relative(process.cwd(), filePath).split(path.sep).join('/'));
  assert.throws(() => annotateJsxFile('/no/such/file.tsx'));
});
