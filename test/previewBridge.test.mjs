import test from 'node:test';
import assert from 'node:assert/strict';
import { installPreviewBridge, previewBridgeScript } from '../packages/engine/previewBridge.mjs';
import { transformForPreview } from '../packages/engine/previewVitePlugin.mjs';

function fakeWindow() {
  const listeners = {};
  const posted = [];
  const winListeners = {};
  const win = {
    document: { addEventListener: (t, fn) => { listeners[t] = fn; } },
    addEventListener: (t, fn) => { winListeners[t] = fn; },
    parent: { postMessage: (m, o) => posted.push([m, o]) },
  };
  return { win, listeners, winListeners, posted };
}
const el = (src, style = {}) => ({ style, getAttribute: () => src, closest() { return this; } });

/** A fake window that can also resolve stack frames (#558): a real origin/URL and a DOM query. */
function fakeErrorWindow(annotated = []) {
  const base = fakeWindow();
  base.win.location = { origin: 'http://preview.test', href: 'http://preview.test/' };
  base.win.URL = URL;
  base.win.document.querySelectorAll = () => annotated.map((src) => ({ getAttribute: () => src }));
  return base;
}

test('click on an annotated element posts its src to the parent and suppresses the click', () => {
  const { win, listeners, posted } = fakeWindow();
  assert.equal(installPreviewBridge(win), true);
  posted.length = 0; // the one-time construct:ready is covered below
  let prevented = 0;
  listeners.click({ target: el('a.tsx:3:5'), preventDefault: () => prevented++, stopPropagation() {} });
  assert.deepEqual(posted, [[{ type: 'construct:select', src: 'a.tsx:3:5' }, '*']]);
  assert.equal(prevented, 1);
});

test('installing announces itself once (construct:ready), so the Cockpit can tell "plugin missing" from "plugin on" (#378)', () => {
  const { win, posted } = fakeWindow();
  installPreviewBridge(win);
  installPreviewBridge(win);
  assert.deepEqual(posted, [[{ type: 'construct:ready' }, '*']]);
});

test('an uncaught error or unhandled rejection in the app is forwarded as construct:error, clipped, never anything else (#378)', () => {
  const { win, winListeners, posted } = fakeWindow();
  installPreviewBridge(win);
  posted.length = 0;
  winListeners.error({ message: "Cannot read properties of undefined (reading 'email')" });
  winListeners.unhandledrejection({ reason: new Error('boom') });
  winListeners.unhandledrejection({ reason: 'plain string' });
  winListeners.error({});
  winListeners.error({ message: 'x'.repeat(1000) });
  assert.deepEqual(posted.map(([m]) => m.type), Array(5).fill('construct:error'));
  assert.equal(posted[0][0].message, "Cannot read properties of undefined (reading 'email')");
  assert.equal(posted[1][0].message, 'boom');
  assert.equal(posted[2][0].message, 'plain string');
  assert.equal(posted[3][0].message, 'Unknown error');
  assert.equal(posted[4][0].message.length, 300);
});

test('#558: an error whose stack has no project frame (only dependency/runtime frames, or none) reports src: null -- no "Show in source" button', () => {
  const { win, winListeners, posted } = fakeErrorWindow();
  installPreviewBridge(win);
  posted.length = 0;
  const libraryStack = 'TypeError: boom\n'
    + '    at renderWithHooks (http://preview.test/node_modules/react-dom/cjs/react-dom.development.js:100:2)\n'
    + '    at beginWork (http://preview.test/node_modules/react-dom/cjs/react-dom.development.js:200:3)';
  winListeners.error({ message: 'boom', error: { stack: libraryStack } });
  winListeners.error({ message: 'boom, no error object at all' });
  winListeners.unhandledrejection({ reason: 'plain string, no stack' });
  assert.deepEqual(posted.map(([m]) => m.src), [null, null, null]);
});

test('#558: an error thrown from a project file reports the stack\'s top project frame as file:line:col', () => {
  const { win, winListeners, posted } = fakeErrorWindow();
  installPreviewBridge(win);
  posted.length = 0;
  const stack = 'TypeError: boom\n'
    + '    at Comp (http://preview.test/features/billing/pages/HomePage.tsx:12:5)\n'
    + '    at renderWithHooks (http://preview.test/node_modules/react-dom/cjs/react-dom.development.js:100:2)';
  winListeners.error({ message: 'boom', error: { stack } });
  assert.equal(posted[0][0].src, 'features/billing/pages/HomePage.tsx:12:5');
});

test('#558: when the project file has a data-cx-src element on screen, its (always-original) position wins over the raw frame\'s', () => {
  const { win, winListeners, posted } = fakeErrorWindow(['features/billing/pages/HomePage.tsx:9:3', 'features/billing/components/Footer.tsx:2:3']);
  installPreviewBridge(win);
  posted.length = 0;
  const stack = 'TypeError: boom\n    at Comp (http://preview.test/features/billing/pages/HomePage.tsx:12:5)';
  winListeners.error({ message: 'boom', error: { stack } });
  assert.equal(posted[0][0].src, 'features/billing/pages/HomePage.tsx:9:3');
});

test('#558: an unhandled rejection\'s reason.stack is resolved the same way as a thrown error\'s', () => {
  const { win, winListeners, posted } = fakeErrorWindow();
  installPreviewBridge(win);
  posted.length = 0;
  const stack = 'Error: rejected\n    at load (http://preview.test/features/billing/pages/HomePage.tsx:20:8)';
  winListeners.unhandledrejection({ reason: { message: 'rejected', stack } });
  assert.equal(posted[0][0].src, 'features/billing/pages/HomePage.tsx:20:8');
});

test('hover outline is cleared when the pointer leaves the iframe (null relatedTarget), not on internal moves', () => {
  const { win, listeners } = fakeWindow();
  installPreviewBridge(win);
  const a = el('a.tsx:1:1', { outline: '1px solid red' });
  listeners.mouseover({ target: a });
  assert.equal(a.style.outline, '2px solid #7c5cff');
  listeners.mouseout({ target: a, relatedTarget: el('b.tsx:1:1') });
  assert.equal(a.style.outline, '2px solid #7c5cff');
  listeners.mouseout({ target: a, relatedTarget: null });
  assert.equal(a.style.outline, '1px solid red');
  listeners.mouseover({ target: a });
  listeners.mouseleave({ target: a, relatedTarget: null });
  assert.equal(a.style.outline, '1px solid red');
});

test('click on an unannotated element does nothing', () => {
  const { win, listeners, posted } = fakeWindow();
  installPreviewBridge(win);
  posted.length = 0;
  listeners.click({ target: { closest: () => null }, preventDefault() { throw new Error('no'); }, stopPropagation() {} });
  assert.equal(posted.length, 0);
});

test('installs once, and not when not embedded (parent === window)', () => {
  const { win } = fakeWindow();
  assert.equal(installPreviewBridge(win), true);
  assert.equal(installPreviewBridge(win), false);
  const top = fakeWindow().win;
  top.parent = top;
  assert.equal(installPreviewBridge(top), false);
});

test('serialised script is self-contained and evaluates', () => {
  const { win, listeners } = fakeWindow();
  new Function('window', previewBridgeScript().replace('(window)', '(window)'))(win);
  assert.ok(listeners.click);
});

test('vite transform annotates tsx/jsx with root-relative paths, skips others and syntax errors', () => {
  const r = transformForPreview('export default () => <div/>;', '/root/src/A.tsx?x=1', '/root');
  assert.match(r.code, /data-cx-src="src\/A\.tsx:1:22"/);
  assert.equal(transformForPreview('<div/>', '/root/node_modules/x/A.tsx', '/root'), null);
  assert.equal(transformForPreview('x', '/root/a.ts', '/root'), null);
  assert.equal(transformForPreview('<div', '/root/a.tsx', '/root'), null);
});
