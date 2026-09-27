// Deterministic JSX source annotator (Cockpit live preview, click-to-source).
//
// `annotateJsxSource(source, { file })` returns the same source with a
// `data-cx-src="<file>:<line>:<col>"` attribute added to every HOST element
// (lowercase tag: div, button, ...). line/col are the 1-based start of the
// element's `<`, i.e. exactly the `line`/`column` `parseJsxTree` reports for
// that node, so a click on the rendered DOM node maps back to a node of the
// Pages Editor tree without any guessing. Custom components and fragments are
// left alone (unknown props would be forwarded/rejected; the host elements
// they render are annotated in their own files). Pure: no I/O, no LLM.
//
// Two entry points share this one core (`annotateJsxSource`):
//   - ./previewVitePlugin.mjs wires it into a dev server's transform step, for
//     an in-memory copy Vite serves -- never written back to disk.
//   - `annotateJsxFile` (#701) below is the standalone entry point: given a
//     JSX/TSX file on disk, it reads and annotates it with no bundler or
//     dev-server integration required, for a consumer that wants the same
//     annotations outside a Vite project.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJsxTree, jsxNameToString } from '../../packages/ast/index.mjs';

export const CX_SRC_ATTR = 'data-cx-src';

function walkRecords(records, visit) {
  for (const r of records) {
    visit(r);
    walkRecords(r.children, visit);
  }
}

/** @returns {{ code: string, count: number }} `count` = attributes added. */
export function annotateJsxSource(source, { file }) {
  if (typeof file !== 'string' || !file) throw new Error('annotateJsxSource: `file` is required');
  const { roots } = parseJsxTree(source);
  const inserts = [];
  walkRecords(roots, (r) => {
    if (r.isFragment || r.isCustomComponent) return;
    const opening = r.openingElementNode;
    if (opening.attributes.some((a) => a.type === 'JSXAttribute' && jsxNameToString(a.name) === CX_SRC_ATTR)) return;
    inserts.push({ at: opening.name.range[1], text: ` ${CX_SRC_ATTR}="${file}:${r.line}:${r.column}"` });
  });
  inserts.sort((a, b) => b.at - a.at); // back to front keeps earlier offsets valid
  let code = source;
  for (const { at, text } of inserts) code = code.slice(0, at) + text + code.slice(at);
  return { code, count: inserts.length };
}

/**
 * Standalone entry point (#701): annotate one JSX/TSX file straight from disk, with no Vite
 * plugin, dev server or headless render required. Reads `filePath`, computes the `file` label the
 * same way the Vite plugin does (relative to `root`, forward slashes), and calls `annotateJsxSource`
 * -- the same core the plugin uses, so the resulting `data-cx-src` values are identical to what a
 * Vite-wired consumer would get for the same file.
 *
 * @param {string} filePath Path (absolute or relative to `root`) to a `.jsx`/`.tsx` file.
 * @param {{root?: string}} [options] `root` to relativize the `file` label against (default: `process.cwd()`).
 * @returns {{code: string, count: number, file: string}} `code`/`count` as `annotateJsxSource`; `file` is the label used.
 * @throws {Error} If `filePath` cannot be read, or its contents are not valid JSX/TSX (unlike the Vite
 *   plugin, which swallows a parse error and skips the file so the dev server keeps serving).
 *
 * @example
 * const { code, count } = annotateJsxFile('src/pages/Home.tsx', { root: process.cwd() });
 */
export function annotateJsxFile(filePath, { root = process.cwd() } = {}) {
  const source = readFileSync(filePath, 'utf8');
  const file = path.relative(root, path.resolve(root, filePath)).split(path.sep).join('/');
  const { code, count } = annotateJsxSource(source, { file });
  return { code, count, file };
}

/** Parse a `data-cx-src` value. The file may itself contain ':' so split from the right. */
export function parseCxSrc(value) {
  const m = /^(.*):(\d+):(\d+)$/.exec(String(value ?? ''));
  return m ? { file: m[1], line: Number(m[2]), column: Number(m[3]) } : null;
}
