// Preview bridge: the tiny in-page half of click-to-source. Runs inside the
// previewed app (dev only). On click it finds the nearest element carrying a
// `data-cx-src` attribute (added by ./jsxSourceAnnotator.mjs) and posts
// `{ type: 'construct:select', src }` to the embedding Cockpit window. Two more
// messages exist so the Cockpit can tell the states of the preview apart (#378):
// `{ type: 'construct:ready' }` once, when the bridge installs (its absence, with
// the dev server answering, means the target app does not load the preview
// plugin), and `{ type: 'construct:error', message, src }` when the app throws an
// uncaught error or leaves a promise rejection unhandled. `src` (#558) is the
// stack's top project frame as a `data-cx-src`-shaped "file:line:col" string, or
// null when every frame belongs to a dependency/runtime, never the project itself
// (a library frame gets no "Show in source" button). Nothing else is sent and
// nothing else is read from the page.
//
// `installPreviewBridge` is a plain function with no closure over module scope
// so `previewBridgeScript()` can serialise it into an inline <script>, while
// tests call it directly against a fake window. Every helper `report()` needs
// (stack parsing, the data-cx-src lookup) is declared INSIDE it for the same
// reason -- a module-level helper would not be part of the serialised source.
export const PREVIEW_MESSAGE_TYPE = 'construct:select';

export function installPreviewBridge(win) {
  if (win.__constructPreviewBridge || win.parent === win) return false;
  win.__constructPreviewBridge = true;
  const ATTR = 'data-cx-src';
  win.parent.postMessage({ type: 'construct:ready' }, '*');
  if (win.addEventListener) {
    // #558: a stack frame's line/col are the EXECUTED (dev-server-transformed)
    // script's own coordinates, not necessarily the original source's -- the
    // annotator only ever inserts an attribute within a line (never a newline),
    // so a `data-cx-src` value for the same file is always exact where the raw
    // frame can be off. Prefer it; fall back to the raw frame when the file has
    // no annotated element on screen (e.g. the error came from a hook body with
    // no host elements of its own).
    const parseCxSrcAttr = (value) => {
      const m = /^(.*):(\d+):(\d+)$/.exec(String(value || ''));
      return m ? { file: m[1], line: Number(m[2]), column: Number(m[3]) } : null;
    };
    const stackFrames = (stack) => {
      const frames = [];
      for (const raw of String(stack || '').split('\n')) {
        const line = raw.trim();
        const m = /\(?([^\s()]+):(\d+):(\d+)\)?$/.exec(line);
        if (m && /^(?:https?:|file:|\/)/.test(m[1])) frames.push({ url: m[1], line: Number(m[2]), column: Number(m[3]) });
      }
      return frames;
    };
    /** Same-origin, non-dependency source file this frame's URL names, as the project-root-relative
     * path string the annotator writes into `data-cx-src` (Vite serves every source file at a URL
     * path equal to that same string), or null for a library/runtime/cross-origin frame. */
    const frameProjectFile = (url) => {
      try {
        const u = new win.URL(url, win.location.href);
        if (u.origin !== win.location.origin) return null;
        if (/\/node_modules\//.test(u.pathname) || !/\.[jt]sx?$/.test(u.pathname)) return null;
        return u.pathname.replace(/^\//, '');
      } catch {
        return null;
      }
    };
    const nearestAnnotatedSrc = (file, line) => {
      const nodes = win.document && win.document.querySelectorAll ? win.document.querySelectorAll('[' + ATTR + ']') : [];
      let best = null;
      for (const el of nodes) {
        const parsed = parseCxSrcAttr(el.getAttribute(ATTR));
        if (!parsed || parsed.file !== file) continue;
        const d = Math.abs(parsed.line - line);
        if (!best || d < best.d) best = { d, value: el.getAttribute(ATTR) };
      }
      return best ? best.value : null;
    };
    const topProjectFrameSrc = (stack) => {
      for (const frame of stackFrames(stack)) {
        const file = frameProjectFile(frame.url);
        if (!file) continue;
        return nearestAnnotatedSrc(file, frame.line) || (file + ':' + frame.line + ':' + frame.column);
      }
      return null;
    };
    const report = (raw, stack) => win.parent.postMessage({ type: 'construct:error', message: String(raw || 'Unknown error').slice(0, 300), src: topProjectFrameSrc(stack) }, '*');
    win.addEventListener('error', (e) => report(e && e.message, e && e.error && e.error.stack));
    win.addEventListener('unhandledrejection', (e) => {
      const reason = e && e.reason;
      report((reason && reason.message) || reason || 'Unhandled promise rejection', reason && reason.stack);
    });
  }
  const find = (el) => (el && el.closest ? el.closest('[' + ATTR + ']') : null);
  let hovered = null;
  win.document.addEventListener('mouseover', (e) => {
    const t = find(e.target);
    if (hovered && hovered !== t) hovered.style.outline = hovered.__cxOutline || '';
    if (t && t !== hovered) { t.__cxOutline = t.style.outline; t.style.outline = '2px solid #7c5cff'; }
    hovered = t;
  }, true);
  // Pointer left the document/iframe (mouseout/mouseleave with no relatedTarget):
  // no mouseover follows, so clear the outline here or it sticks.
  const clear = (e) => {
    if (e.relatedTarget || !hovered) return;
    hovered.style.outline = hovered.__cxOutline || '';
    hovered = null;
  };
  win.document.addEventListener('mouseout', clear, true);
  win.document.addEventListener('mouseleave', clear, true);
  win.document.addEventListener('click', (e) => {
    const t = find(e.target);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    win.parent.postMessage({ type: 'construct:select', src: t.getAttribute(ATTR) }, '*');
  }, true);
  return true;
}

/** Inline-script source that installs the bridge in the page. */
export function previewBridgeScript() {
  return `(${installPreviewBridge.toString()})(window);`;
}
