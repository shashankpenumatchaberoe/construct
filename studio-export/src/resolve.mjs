// The one place that knows where Studio's outside pieces live: the media tools (script.mjs and friends) and Playwright.
// The published package carries the media tools in vendor/media (made by the pack step from packages/tools/media); in a
// checkout of the repository they are read from packages/tools/media. Nothing else in src/ looks outside this package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '..');

/** Directory holding the media tools (contains script.mjs), or null. vendor/media first, then the repository copy. */
export function mediaDir({ candidates } = {}) {
  const list = candidates || [path.join(PACKAGE, 'vendor', 'media'), path.resolve(PACKAGE, '..', 'tools', 'media')];
  return list.find((d) => fs.existsSync(path.join(d, 'script.mjs'))) || null;
}

/** Playwright: the installed package, or (development only) the copy the repository's e2e workspace carries. */
export async function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name); } catch { /* try the next */ }
  }
  const dev = path.resolve(PACKAGE, '..', '..', 'ui', 'e2e', 'node_modules', 'playwright', 'index.mjs');
  if (fs.existsSync(dev)) return import(pathToFileURL(dev).href);
  throw new Error('Playwright is not installed. Run: npm i playwright && npx playwright install chromium');
}

/** ffmpeg on PATH (or FFMPEG), as an absolute path, or null. */
export function findFfmpeg(env = process.env) {
  if (env.FFMPEG) return fs.existsSync(env.FFMPEG) ? env.FFMPEG : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

/** The media tools' model cache (Kokoro package, voice-cloning venv), the same default as packages/tools/media/synth.mjs. */
export const mediaCache = (env = process.env) => env.CONSTRUCT_MEDIA_CACHE || path.join(os.homedir(), '.cache', 'construct-media');
