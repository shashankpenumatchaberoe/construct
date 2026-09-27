import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, ERR, KEYS, LIMITS, hashStoryboard, validateStoryboard } from '../src/storyboard.mjs';
import { checkUrl, isPrivateHost } from '../src/urlpolicy.mjs';

const BASE = 'https://shop.example.com/';
const sb = (steps, extra = {}) => ({ title: 'T', scenes: [{ caption: 'A caption.', steps: [{ action: 'goto', url: BASE }, ...steps] }], ...extra });
const codes = (r) => r.errors.map((e) => e.code);

test('a good storyboard validates and normalises deterministically', () => {
  const input = { title: '  A   tour ', scenes: [{ caption: 'Hello   there.', steps: [{ action: 'goto', url: '/pricing' }, { action: 'highlight', selector: 'h1', label: 'Title' }, { action: 'card', title: 'End' }] }] };
  const a = validateStoryboard(input, { baseUrl: BASE });
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  assert.deepEqual(a.storyboard, {
    version: 1, title: 'A tour', baseUrl: BASE,
    scenes: [{ id: 's01', caption: 'Hello there.', steps: [{ action: 'goto', url: 'https://shop.example.com/pricing' }, { action: 'highlight', selector: 'h1', label: 'Title', ms: 2400 }, { action: 'card', title: 'End', ms: 3000, subtitle: '' }] }],
  });
  // idempotent: the normal form validates to itself, and the hash is stable
  const b = validateStoryboard(a.storyboard, { baseUrl: BASE });
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  assert.deepEqual(b.storyboard, a.storyboard);
  assert.equal(hashStoryboard(b.storyboard), hashStoryboard(a.storyboard));
  assert.match(hashStoryboard(a.storyboard), /^[0-9a-f]{64}$/);
});

test('the closed action set is exactly the ten actions', () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['caption', 'card', 'click', 'fill', 'goto', 'highlight', 'hover', 'press', 'scroll', 'wait']);
  assert.ok(Object.isFrozen(ERR) && Object.isFrozen(ACTIONS) && Object.isFrozen(LIMITS));
});

const CASES = [
  ['NOT_OBJECT', () => validateStoryboard('nope')],
  ['NOT_OBJECT', () => validateStoryboard([])],
  ['UNKNOWN_KEY', () => validateStoryboard({ ...sb([]), extra: 1 })],
  ['BAD_TITLE', () => validateStoryboard({ ...sb([]), title: '' })],
  ['BAD_TITLE', () => validateStoryboard({ ...sb([]), title: 'x'.repeat(LIMITS.title + 1) })],
  ['BAD_BASE_URL', () => validateStoryboard(sb([]), { baseUrl: 'ftp://x.example.com' })],
  ['BASE_URL_MISMATCH', () => validateStoryboard({ ...sb([]), baseUrl: 'https://other.example.com/' }, { baseUrl: BASE })],
  ['NO_SCENES', () => validateStoryboard({ title: 'T', scenes: [] })],
  ['TOO_MANY_SCENES', () => validateStoryboard({ title: 'T', scenes: Array.from({ length: LIMITS.maxScenes + 1 }, () => ({ caption: 'c', steps: [] })) })],
  ['TOO_MANY_STEPS', () => validateStoryboard(sb(Array.from({ length: LIMITS.maxSteps }, () => ({ action: 'wait', ms: 10 }))))],
  ['BAD_SCENE', () => validateStoryboard({ title: 'T', scenes: ['x'] })],
  ['UNKNOWN_KEY', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [], mood: 'x' }] })],
  ['CAPTION_REQUIRED', () => validateStoryboard({ title: 'T', scenes: [{ steps: [] }] })],
  ['CAPTION_REQUIRED', () => validateStoryboard({ title: 'T', scenes: [{ caption: '   ', steps: [] }] })],
  ['CAPTION_TOO_LONG', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'x'.repeat(LIMITS.caption + 1), steps: [] }] })],
  ['BAD_STEPS', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: 'goto' }] })],
  ['BAD_STEP', () => validateStoryboard(sb(['click']))],
  ['UNKNOWN_ACTION', () => validateStoryboard(sb([{ action: 'eval', code: 'alert(1)' }]))],
  ['UNKNOWN_ACTION', () => validateStoryboard(sb([{ action: 'constructor' }]))],
  ['MISSING_ARG', () => validateStoryboard(sb([{ action: 'click' }]))],
  ['UNKNOWN_ARG', () => validateStoryboard(sb([{ action: 'click', selector: 'a', force: true }]))],
  ['BAD_ARG_TYPE', () => validateStoryboard(sb([{ action: 'click', selector: 5 }]))],
  ['BAD_ARG_TYPE', () => validateStoryboard(sb([{ action: 'wait', ms: '500' }]))],
  ['SELECTOR_TOO_LONG', () => validateStoryboard(sb([{ action: 'click', selector: 'a'.repeat(LIMITS.selector + 1) }]))],
  ['TEXT_TOO_LONG', () => validateStoryboard(sb([{ action: 'fill', selector: 'input', text: 'x'.repeat(LIMITS.text + 1) }]))],
  ['MS_OUT_OF_RANGE', () => validateStoryboard(sb([{ action: 'wait', ms: LIMITS.maxMs + 1 }]))],
  ['MS_OUT_OF_RANGE', () => validateStoryboard(sb([{ action: 'wait', ms: -1 }]))],
  ['BAD_KEY', () => validateStoryboard(sb([{ action: 'press', key: 'Control+Alt+Delete' }]))],
  ['BAD_SCROLL', () => validateStoryboard(sb([{ action: 'scroll' }]))],
  ['BAD_SCROLL', () => validateStoryboard(sb([{ action: 'scroll', dy: 10, to: 'top' }]))],
  ['BAD_SCROLL', () => validateStoryboard(sb([{ action: 'scroll', dy: LIMITS.scrollPx + 1 }]))],
  ['FIRST_STEP_NOT_GOTO', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'click', selector: 'a' }] }] })],
  ['DURATION_TOO_LONG', () => validateStoryboard({ title: 'T', scenes: Array.from({ length: 30 }, (_, i) => ({ caption: 'c', steps: i === 0 ? [{ action: 'goto', url: BASE }, ...Array(10).fill({ action: 'wait', ms: 15000 })] : Array(2).fill({ action: 'wait', ms: 15000 }) })) })],
  ['URL_INVALID', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: 'not a url' }] }] })],
  ['URL_SCHEME', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: 'file:///etc/passwd' }] }] })],
  ['URL_PRIVATE_HOST', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: 'http://127.0.0.1:8080/' }] }] })],
  ['URL_CREDENTIALS', () => validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: 'https://user:pw@example.com/' }] }] })],
  ['URL_CROSS_ORIGIN', () => validateStoryboard(sb([{ action: 'goto', url: 'https://evil.example.net/' }]), { baseUrl: BASE })],
];

for (const [code, run] of CASES) {
  test(`error code ${code} is reported`, () => {
    const r = run();
    assert.equal(r.ok, false);
    assert.ok(codes(r).includes(ERR[code]), `expected ${code}, got ${codes(r).join(', ')}`);
    for (const e of r.errors) { assert.ok(Object.values(ERR).includes(e.code), `unnamed code ${e.code}`); assert.equal(typeof e.message, 'string'); }
  });
}

test('every named error code is exercised by a case above', () => {
  const seen = new Set(CASES.map(([c]) => c));
  for (const name of Object.keys(ERR)) assert.ok(seen.has(name), `no test for ${name}`);
});

test('max 60 steps is enforced across scenes, and 60 exactly is allowed', () => {
  const ok = validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: BASE }, ...Array(59).fill({ action: 'wait', ms: 10 })] }] });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  const over = validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: BASE }, ...Array(30).fill({ action: 'wait', ms: 10 })] }, { caption: 'd', steps: Array(30).fill({ action: 'wait', ms: 10 }) }] });
  assert.equal(over.ok, false);
  assert.equal(over.errors.filter((e) => e.code === ERR.TOO_MANY_STEPS).length, 1);
});

test('press accepts only the listed keys', () => {
  for (const key of KEYS) assert.equal(validateStoryboard(sb([{ action: 'press', key }])).ok, true, key);
});

test('a goto to another site is refused when a base URL is set, allowed when there is none', () => {
  assert.equal(validateStoryboard(sb([{ action: 'goto', url: 'https://cdn.example.org/' }]), { baseUrl: BASE }).ok, false);
  assert.equal(validateStoryboard(sb([{ action: 'goto', url: 'https://cdn.example.org/' }])).ok, true);
});

test('URL policy: schemes', () => {
  for (const bad of ['file:///etc/passwd', 'data:text/html,<b>x</b>', 'javascript:alert(1)', 'ftp://example.com/', 'blob:https://example.com/x', 'chrome://settings', 'view-source:https://example.com']) {
    assert.equal(checkUrl(bad).ok, false, bad);
    assert.equal(checkUrl(bad).code, 'URL_SCHEME', bad);
  }
  assert.equal(checkUrl('https://example.com/a?b=1#frag').url, 'https://example.com/a?b=1');
  assert.equal(checkUrl('http://example.com').ok, true);
});

test('URL policy: loopback, private, link-local and odd encodings are blocked unless allowPrivateNetwork', () => {
  const blocked = [
    'http://localhost/', 'http://LOCALHOST:3000/', 'http://foo.localhost/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://0.0.0.0/',
    'http://[::1]/', 'http://[::]/', 'http://[fe80::1]/', 'http://[fd12:3456::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/', 'http://intranet/', 'http://printer.local/', 'http://db.internal/',
  ];
  for (const u of blocked) {
    const r = checkUrl(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.code, 'URL_PRIVATE_HOST', u);
    assert.equal(checkUrl(u, { allowPrivateNetwork: true }).ok, true, `${u} with allowPrivateNetwork`);
  }
  for (const u of ['https://example.com/', 'http://8.8.8.8/', 'http://172.32.0.1/', 'http://[2606:4700::1111]/', 'http://192.169.0.1/']) assert.equal(checkUrl(u).ok, true, u);
});

test('URL policy: credentials refused even with allowPrivateNetwork, relative URLs need a base', () => {
  assert.equal(checkUrl('https://a:b@example.com/', { allowPrivateNetwork: true }).code, 'URL_CREDENTIALS');
  assert.equal(checkUrl('/pricing').ok, false);
  assert.equal(checkUrl('/pricing', { baseUrl: BASE }).url, 'https://shop.example.com/pricing');
  assert.equal(checkUrl('//evil.example.net/x', { baseUrl: BASE }).code, 'URL_CROSS_ORIGIN');
  assert.equal(checkUrl('javascript:alert(1)', { baseUrl: BASE }).code, 'URL_SCHEME');
  assert.equal(checkUrl('x'.repeat(3000)).ok, false);
});

test('isPrivateHost fails closed on junk', () => {
  assert.equal(isPrivateHost(''), true);
  assert.equal(isPrivateHost('[1:2:3]'), true);
  assert.equal(isPrivateHost('example.com'), false);
});
