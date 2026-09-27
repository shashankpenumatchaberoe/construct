import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDevServerView, describeBranch, projectName } from './DevServerView.ts';

const command = { script: 'dev', text: 'vite', display: 'npm run dev' };
const idle = {
  ok: true, version: 0, state: 'not-running', refusal: null, command, root: '/ws/storefront', port: null, url: null, pid: null,
  startedAt: null, failure: null, networkWarning: null, branch: 'main', branchKind: 'other',
};
const opts = { acknowledged: false, confirming: false, busy: false };
const view = (patch = {}, o = {}) => buildDevServerView({ ...idle, ...patch }, { ...opts, ...o });

test('every state of ia-preview-states has a card with its own words', () => {
  assert.equal(view().card, 'not-running');
  assert.equal(view().title, 'Dev server not running');
  assert.equal(view({ state: 'starting', port: 5173 }).card, 'starting');
  assert.equal(view({ refusal: { code: 'PROJECT_ROOT_OUTSIDE_WORKSPACE', message: 'This project is not inside the workspace root.' } }).card, 'outside-workspace');
  assert.equal(view({ state: 'failed', failure: { kind: 'port-busy', message: 'Port 5173 is in use by another process.', port: 5173, suggestedPort: 5174 } }).card, 'port-busy');
  assert.equal(view({ state: 'failed', failure: { kind: 'exited', message: 'exited', code: 1 } }).card, 'stopped');
  assert.equal(view({ state: 'running', port: 5173, url: 'http://127.0.0.1:5173/' }).card, 'running');
  assert.equal(view({ refusal: { code: 'NO_DEV_SCRIPT', message: 'no script' }, command: null }).card, 'no-script');
  assert.equal(view({ refusal: { code: 'NO_PROJECT', message: 'none' } }).card, 'no-project');
  assert.equal(buildDevServerView(null, opts).card, 'not-running');
});

test('not running offers Start and shows the exact command; nothing else', () => {
  const v = view();
  assert.deepEqual(v.command, { display: 'npm run dev', text: 'vite' });
  assert.equal(v.canStart, true);
  assert.equal(v.canStop, false);
  assert.equal(v.canRestart, false);
  assert.equal(v.showLog, false);
  assert.match(v.message, /inside your workspace, for storefront only/);
});

test('the first start of a command asks once: confirming hides Start until answered, and a seen command does not ask', () => {
  const asking = view({}, { confirming: true, acknowledged: false });
  assert.equal(asking.confirming, true);
  assert.equal(asking.canStart, false);
  const seen = view({}, { confirming: true, acknowledged: true });
  assert.equal(seen.confirming, false);
  assert.equal(seen.canStart, true);
});

test('starting can be stopped and points at the log; running offers Restart and Stop and the address', () => {
  const starting = view({ state: 'starting', port: 5173 });
  assert.deepEqual([starting.canStop, starting.canRestart, starting.canStart, starting.showLog], [true, false, false, true]);
  assert.match(starting.message, /npm run dev is starting on port 5173/);
  const running = view({ state: 'running', port: 5173, url: 'http://127.0.0.1:5173/' });
  assert.deepEqual(running.running, { url: 'http://127.0.0.1:5173/', port: 5173 });
  assert.deepEqual([running.canStop, running.canRestart, running.canStart], [true, true, false]);
});

test('running also reachable from the network (#557) carries the warning through; loopback-only running has none', () => {
  const loopbackOnly = view({ state: 'running', port: 5173, url: 'http://127.0.0.1:5173/', networkWarning: null });
  assert.equal(loopbackOnly.networkWarning, null);
  const lanReachable = view({ state: 'running', port: 5173, url: 'http://127.0.0.1:5173/', networkWarning: 'This server is also reachable from your network: 10.0.0.5:5173' });
  assert.equal(lanReachable.networkWarning, 'This server is also reachable from your network: 10.0.0.5:5173');
});

test('port busy offers "Use port N" only when a free port was found; outside the workspace offers no start', () => {
  const busy = view({ state: 'failed', failure: { kind: 'port-busy', message: 'Port 5173 is in use by another process.', suggestedPort: 5174 } });
  assert.equal(busy.usePort, 5174);
  assert.equal(busy.canStart, true);
  assert.equal(busy.message, 'Port 5173 is in use by another process.');
  assert.equal(view({ state: 'failed', failure: { kind: 'port-busy', message: 'x', suggestedPort: null } }).usePort, null);
  assert.equal(view({ state: 'failed', failure: { kind: 'exited', message: 'x' } }).usePort, null);
  const outside = view({ refusal: { code: 'PROJECT_ROOT_OUTSIDE_WORKSPACE', message: 'not inside' } });
  assert.deepEqual([outside.canStart, outside.canStop, outside.canRestart], [false, false, false]);
});

test('branch provenance: cockpit session branch vs any other, as words; nothing when there is no git branch', () => {
  const session = describeBranch({ branch: 'cockpit/billing-a3f7', branchKind: 'session' });
  assert.equal(session.label, 'Session branch');
  assert.equal(session.kind, 'session');
  assert.match(session.hint, /same files Cockpit saves/);
  const other = describeBranch({ branch: 'feature/login', branchKind: 'other' });
  assert.equal(other.label, 'Other branch');
  assert.match(other.hint, /cannot promise/);
  assert.equal(describeBranch({ branch: null, branchKind: null }), null);
  assert.equal(describeBranch(null), null);
  assert.equal(view({ branch: 'cockpit/x-1', branchKind: 'session' }).branch.label, 'Session branch');
  assert.equal(view({ branch: null, branchKind: null }).branch, null);
});

test('project name is the last path segment', () => {
  assert.equal(projectName('/ws/storefront'), 'storefront');
  assert.equal(projectName('C:\\ws\\shop\\'), 'shop');
  assert.equal(projectName(null), 'this project');
});
