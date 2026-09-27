// Refresh the browser files the editor page vendors (no CDN, works offline): `node packages/studio/src/editor/vendor-ui.mjs`.
// Downloads the pinned vis-timeline release with `npm pack` (no dependency is added to any package.json), copies its standalone
// browser bundle (which injects its own stylesheet) and licence texts into ui/vendor/, and records name, version, licence and a sha256 in VERSION.json.
// The bundle already contains its own dependencies (vis-data, vis-util, moment, hammerjs, ...): see NOTICE-editor.md.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIS_TIMELINE_VERSION = '8.5.4';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR = path.join(HERE, 'ui', 'vendor');
const FILES = [
  ['package/standalone/umd/vis-timeline-graph2d.min.js', 'vis-timeline.min.js'],
  ['package/LICENSE.MIT.txt', 'LICENSE-vis-timeline-MIT.txt'],
  ['package/LICENSE.Apache-2.0.txt', 'LICENSE-vis-timeline-Apache-2.0.txt'],
];

export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Fetch the release and copy the files into `vendorDir`; returns the VERSION.json content. */
export function vendorVisTimeline({ version = VIS_TIMELINE_VERSION, vendorDir = VENDOR_DIR } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-vendor-'));
  try {
    execFileSync('npm', ['pack', `vis-timeline@${version}`, '--pack-destination', tmp, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp, ...FILES.map(([from]) => from)]);
    fs.mkdirSync(vendorDir, { recursive: true });
    for (const [from, to] of FILES) fs.copyFileSync(path.join(tmp, from), path.join(vendorDir, to));
    const info = {
      name: 'vis-timeline', version, license: '(Apache-2.0 OR MIT)', homepage: 'https://github.com/visjs/vis-timeline',
      files: Object.fromEntries(FILES.map(([, to]) => [to, sha256(path.join(vendorDir, to))])),
    };
    fs.writeFileSync(path.join(vendorDir, 'VERSION.json'), `${JSON.stringify(info, null, 2)}\n`);
    return info;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = vendorVisTimeline();
  for (const [name, hash] of Object.entries(info.files)) console.log(`${name}  ${fs.statSync(path.join(VENDOR_DIR, name)).size} bytes  sha256 ${hash.slice(0, 16)}`);
}
