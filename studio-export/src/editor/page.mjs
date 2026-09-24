// Assemble the editor page as ONE document: the server's access-token gate covers /editor and /api/, and a browser cannot attach
// a header to <script src>, <link> or a module import, so the page cannot load its own files by URL. Instead editor.html is a
// template whose `<!-- inline:style|script|module FILE -->` markers are replaced by the file's content (module files are joined
// in dependency order, their `import ./x.mjs` lines and `export` keywords removed), and the Content-Security-Policy allows
// exactly those inline scripts by sha256. The source stays in small ES modules under ui/; nothing is built or written to disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const MARK = /<!-- inline:(style|script|module) ([A-Za-z0-9._/-]+) -->/g;
const IMPORT = /^import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+'\.\/([A-Za-z0-9._-]+\.mjs)';\s*$/;

const inside = (dir, rel) => {
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) throw new Error(`refusing ${rel}: outside the ui folder`);
  return file;
};

/** Join an ES module and its relative imports into one script: dependencies first, `import` lines dropped, `export` removed. */
export function bundleModules(dir, entry) {
  const done = new Set();
  const parts = [];
  const visit = (name) => {
    if (done.has(name)) return;
    done.add(name);
    const lines = fs.readFileSync(inside(dir, name), 'utf8').split('\n');
    const body = [];
    for (const line of lines) {
      if (/^import\s/.test(line)) {
        const m = IMPORT.exec(line);
        if (!m) throw new Error(`${name}: only single-line \`import ... from './x.mjs'\` is supported: ${line}`);
        visit(m[1]);
      } else body.push(line.replace(/^export (?=(?:async\s+)?(?:function|class|const|let)\b)/, ''));
    }
    if (body.some((l) => /^export\b/.test(l))) throw new Error(`${name}: unsupported export form`);
    parts.push(`// ---- ${name}\n${body.join('\n')}`);
  };
  visit(entry);
  return parts.join('\n');
}

const sha = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
const safeInline = (text) => text.replace(/<\/(script|style)/gi, '<\\/$1').replace(/^\/\/# sourceMappingURL=.*$/gm, '');

/** `{ html, csp }`: the finished page and the policy that allows exactly its inline scripts (style is inline too; vis-timeline adds its own). */
export function buildPage({ uiDir = UI_DIR } = {}) {
  const dir = fs.realpathSync(uiDir);
  const hashes = [];
  const html = fs.readFileSync(inside(dir, 'editor.html'), 'utf8').replace(MARK, (_all, kind, file) => {
    if (kind === 'module') {
      const code = safeInline(bundleModules(dir, file));
      hashes.push(sha(code));
      return `<script type="module">${code}</script>`;
    }
    const text = safeInline(fs.readFileSync(inside(dir, file), 'utf8'));
    if (kind === 'style') return `<style>${text}</style>`;
    hashes.push(sha(text));
    return `<script>${text}</script>`;
  });
  const csp = `default-src 'none'; script-src ${hashes.join(' ')}; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; img-src 'self' data:; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
}

/** The page, rebuilt only when a file under ui/ changed. */
export function pageCache(uiDir = UI_DIR) {
  let key = '';
  let built = null;
  return () => {
    const dir = fs.realpathSync(uiDir);
    const files = [dir, path.join(dir, 'vendor')].flatMap((d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(d, e.name)));
    const next = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}:${fs.statSync(f).size}`).join('|');
    if (next !== key || !built) { built = buildPage({ uiDir }); key = next; }
    return built;
  };
}
