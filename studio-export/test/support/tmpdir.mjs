// A fresh temp directory per call, for tests. Stand-in for the monorepo's shared test-utils helper, which is not part of this package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTempDir(prefix = 'studio-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
