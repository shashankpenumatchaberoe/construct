// Run: cd ui/client && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { openSourceTargetFromCxSrc } from './OpenSource.ts';

test('openSourceTargetFromCxSrc parses a data-cx-src-shaped string (#558)', () => {
  assert.deepEqual(openSourceTargetFromCxSrc('features/billing/pages/HomePage.tsx:12:5'), {
    file: 'features/billing/pages/HomePage.tsx',
    line: 12,
    column: 5,
  });
});

test('openSourceTargetFromCxSrc rejects anything that does not parse', () => {
  assert.equal(openSourceTargetFromCxSrc('not-a-src'), null);
  assert.equal(openSourceTargetFromCxSrc(''), null);
});
