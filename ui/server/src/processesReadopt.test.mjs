// #415 -- adoptInterrupted() used to run only once per project, at the moment
// processesService.open() first touches it. That catches a server that was
// killed and restarted, but not a process left `running` by something else
// that died AFTER this server's one-time check already ran (a separate
// `construct` invocation against the same state dir, or this server's own
// engine wedging on a save it could not persist even after processEngine's
// pump().catch retry). The mitigation: run the same check again on a timer.
import '../../../test-utils/workspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { createProcess, startStep } from '../../../packages/engine/processModel.mjs';
import { createProcessesService } from './processesService.mjs';

const touching = (file) => ({ features: ['checkout'], files: [{ path: file, change: 'create' }] });
const PLAN = {
  version: 1,
  ticket: { source: 'text', title: 'Add totals to checkout' },
  steps: [{ id: 'a', title: 'Create the checkout feature', flow: 'create.feature', args: { name: 'checkout' }, executor: 'deterministic', touches: touching('features/checkout/index.ts') }],
};

/** A fake `setInterval`/`clearInterval` pair: never actually schedules
 * anything, just remembers the callback and delay so a test can fire it
 * whenever it likes, deterministically, instead of waiting real minutes. */
function fakeTimers() {
  const calls = [];
  return {
    calls,
    setIntervalFn: (fn, ms) => { const handle = { fn, ms }; calls.push(handle); return handle; },
    clearIntervalFn: (handle) => { handle.cleared = true; },
  };
}

function setup({ adoptIntervalMs } = {}) {
  const root = makeTempDir('og415-project-');
  const stateDir = makeTempDir('og415-state-');
  const timers = fakeTimers();
  const service = createProcessesService({
    getProjectDir: () => root,
    stateDir,
    executeStep: () => new Promise(() => {}), // never resolves; nothing under test starts a real run
    isAlive: () => false, // deterministic: every owner pid in this file reads as dead
    ...timers,
    ...(adoptIntervalMs === undefined ? {} : { adoptIntervalMs }),
  });
  return { root, stateDir, service, timers };
}

/** Write a record straight to the store's file, the way processStore.test.mjs
 * fakes "another server, long gone" — bypassing store.save()'s own pid
 * stamping (which would always stamp THIS test process's very-much-alive pid). */
function leaveRunning(service, id = 'stuck') {
  const store = service.store();
  const record = startStep({ ...createProcess(PLAN, { id, projectRoot: service.currentRoot() }), state: 'running.active' }, 'a', {});
  const saved = store.save(record);
  fs.writeFileSync(path.join(store.dir, `${id}.json`), JSON.stringify({ ...saved, owner: { pid: 424242, since: saved.owner.since } }));
  return store;
}

test('the timer is armed for 5 minutes by default, and can be disabled', () => {
  const { timers } = setup();
  assert.equal(timers.calls.length, 1);
  assert.equal(timers.calls[0].ms, 5 * 60 * 1000);

  const off = fakeTimers();
  createProcessesService({ getProjectDir: () => makeTempDir('og415-off-'), stateDir: makeTempDir('og415-off-state-'), adoptIntervalMs: 0, ...off });
  assert.equal(off.calls.length, 0, 'adoptIntervalMs: 0 starts no timer');
});

test('close() clears the timer', () => {
  const { service, timers } = setup();
  service.close();
  assert.equal(timers.calls[0].cleared, true);
});

test('a process left running by something that died AFTER open()\'s one-time check already ran is still caught, once the timer fires', () => {
  const { service, timers } = setup();
  // Touch the project once, the way any API call would — this is what runs
  // open()'s one-time adoptInterrupted(), before the stuck record even exists.
  assert.equal(service.list().processes.length, 0);

  const store = leaveRunning(service);
  assert.equal(store.load('stuck').state, 'running.active', 'still says running: the one-time check already happened and missed it');

  // Nobody called the timer's callback yet — the record is exactly as stuck
  // as #415 describes.
  assert.equal(store.load('stuck').state, 'running.active');

  // Fire the same callback the real 5-minute setInterval would have fired.
  timers.calls[0].fn();

  const after = store.load('stuck');
  assert.equal(after.state, 'paused', 'the periodic check repairs it without a server restart');
  assert.equal(after.owner, null);
  assert.equal(after.steps.find((s) => s.id === 'a').status, 'pending');
});

test('reAdoptInterrupted() runs the same check on demand, for a caller that does not want to wait for the timer', () => {
  const { service } = setup();
  const store = leaveRunning(service, 'stuck2');
  service.reAdoptInterrupted();
  assert.equal(store.load('stuck2').state, 'paused');
});

test('emits the adopted record to subscribers, the same way any other persisted change is', () => {
  const { service, timers } = setup();
  service.list();
  leaveRunning(service, 'stuck3');
  const seen = [];
  service.subscribe((record) => seen.push(record));
  timers.calls[0].fn();
  assert.equal(seen.some((r) => r.id === 'stuck3' && r.state === 'paused'), true);
});
