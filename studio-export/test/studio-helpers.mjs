// Shared helpers for the studio-*.test.mjs files: a mock Ollama on a throwaway port (48300-48399), a static test site, a
// valid storyboard, and a recording of requests. Not a test itself (it defines no tests).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Listen on the first free port of `from..from+span-1` (48300-48399 is Studio's test range); resolves { server, port }. */
export async function listenInRange(server, from, span = 20, host = '127.0.0.1') {
  for (let i = 0; i < span; i++) {
    const port = from + ((process.pid + i) % span);
    const ok = await new Promise((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(port, host, () => { server.off('error', onError); resolve(true); });
    });
    if (ok) return port;
  }
  throw new Error(`no free port in ${from}-${from + span - 1}`);
}

export const closeServer = (server) => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });

/**
 * A stand-in for Ollama. `replies` is consumed one per POST /api/chat: a string (the assistant text), or
 * { status } for an HTTP error. `calls` collects the request bodies. `base` picks the port range start.
 */
export async function mockOllama({ replies = [], models = [{ name: 'llama3.2', size: 1 }], base = 48300 } = {}) {
  const calls = [];
  const queue = [...replies];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        calls.push(body);
        const next = queue.length ? queue.shift() : '';
        if (next && typeof next === 'object' && next.status) { res.writeHead(next.status, { 'content-type': 'application/json' }); res.end('{"error":"x"}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: String(next) }, done: true }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const port = await listenInRange(server, base);
  return { url: `http://127.0.0.1:${port}`, port, calls, queue, close: () => closeServer(server) };
}

/** A small static site: home (title, a link, an input, a button), /about. Port from the OS. */
export async function staticSite() {
  const pages = {
    '/': '<!doctype html><html><head><title>Test Shop</title></head><body><h1>Test Shop</h1><nav><a href="/about">About us</a></nav><input id="name" placeholder="Your name"><button id="go" type="button" onclick="document.getElementById(\'out\').textContent=\'Hello \'+document.getElementById(\'name\').value">Say hello</button><p id="out"></p><div style="height:2000px"></div><h2>Bottom</h2></body></html>',
    '/about': '<!doctype html><html><head><title>About</title></head><body><h1>About the shop</h1></body></html>',
  };
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const body = pages[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}/`, port, hits, close: () => closeServer(server) };
}

/** A storyboard that validates against `baseUrl`. */
export const goodStoryboard = (baseUrl = 'http://127.0.0.1:1/') => ({
  title: 'Tour',
  scenes: [
    { caption: 'This is the shop.', steps: [{ action: 'goto', url: baseUrl }, { action: 'wait', ms: 200 }] },
    { caption: 'Say hello.', steps: [{ action: 'fill', selector: '#name', text: 'Ada' }, { action: 'click', selector: '#go' }, { action: 'highlight', selector: '#out', label: 'The greeting', ms: 300 }] },
  ],
});

/** A fake Playwright: records every call in order, runs on a virtual clock, writes a tiny "video" where recordVideo says. */
export function fakePlaywright({ failOn, launchError } = {}) {
  const calls = [];
  const clock = { t: 0 };
  let routeHandler = null;
  let videoDir = null;
  const page = {
    goto: async (url) => { calls.push(['goto', url]); },
    click: async (sel) => { if (failOn === 'click') throw new Error('Timeout 8000ms exceeded.\n  waiting for locator'); calls.push(['click', sel]); },
    fill: async (sel, text) => { calls.push(['fill', sel, text]); },
    hover: async (sel) => { calls.push(['hover', sel]); },
    keyboard: { press: async (k) => { calls.push(['press', k]); } },
    mouse: { move: async () => { calls.push(['mouse.move']); } },
    locator: (sel) => ({ first: () => ({ boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 30 }), scrollIntoViewIfNeeded: async () => { calls.push(['scrollIntoView', sel]); } }) }),
    evaluate: async (fn, arg) => { calls.push(['evaluate', fn.name || (String(fn).includes('scrollTo') ? 'scrollTo' : 'inline'), arg]); },
    addInitScript: async () => { calls.push(['addInitScript']); },
    waitForTimeout: async (ms) => { clock.t += ms; },
    video: () => ({ path: async () => path.join(videoDir, 'raw.webm') }),
    close: async () => { calls.push(['page.close']); },
  };
  const context = {
    setDefaultTimeout: () => {},
    route: async (glob, handler) => { calls.push(['route', glob]); routeHandler = handler; },
    newPage: async () => page,
    close: async () => { calls.push(['context.close']); },
  };
  const browser = {
    newContext: async (opts) => { calls.push(['newContext', opts]); videoDir = opts.recordVideo.dir; fs.writeFileSync(path.join(videoDir, 'raw.webm'), 'fake-webm'); return context; },
    close: async () => { calls.push(['browser.close']); },
  };
  return {
    calls, clock, get routeHandler() { return routeHandler; },
    playwright: { chromium: { launch: async () => { if (launchError) throw new Error(launchError); calls.push(['launch']); return browser; } } },
  };
}

