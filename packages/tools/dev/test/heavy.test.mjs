// #414 -- packages/tools/dev/heavy.sh, run for real against a sandbox: prune by owner liveness (never by age alone),
// a bounded lock wait that names the holder, a bounded RAM wait that releases the lock, exit-code passthrough.
//
//   node --test packages/tools/dev/test/            (also picked up by the root `npm test`)
//
// Everything points at a sandbox: CONSTRUCT_HEAVY_TMP (the directory pruned), CONSTRUCT_HEAVY_LOCK (a private
// lock file), CONSTRUCT_MIN_FREE_MB=0 (no real RAM wait). The machine-wide lock is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../../../test-utils/tmpdir.mjs';

const HEAVY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'heavy.sh');

function sandbox(extraEnv = {}) {
  const dir = makeTempDir('heavy-');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  const env = {
    ...process.env,
    CONSTRUCT_HEAVY_TMP: tmp,
    CONSTRUCT_HEAVY_LOCK: path.join(dir, 'heavy.lock'),
    CONSTRUCT_MIN_FREE_MB: '0',
    CONSTRUCT_HEAVY_POLL_SEC: '0.2',
    ...extraEnv,
  };
  delete env.NODE_OPTIONS;
  return { dir, tmp, env };
}

const run = (args, env) => spawnSync('bash', [HEAVY, ...args], { env, encoding: 'utf8', timeout: 30_000 });

/** A pid that certainly refers to no live process: a child that has already exited. */
function deadPid() {
  const r = spawnSync('true');
  assert.ok(r.pid > 1);
  return r.pid;
}

/**
 * A PATH with every real command available except `flock` (#686: macOS has no flock binary at
 * all). Built by symlinking every executable found in the real PATH, skipping the name "flock",
 * into one fresh directory -- so a script run with this PATH sees a normal-looking machine that
 * merely lacks flock, not a machine missing everything else too.
 */
function pathWithoutFlock() {
  const fakeBin = makeTempDir('heavy-noflock-bin-');
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'flock') continue; // the one thing this PATH must not have
      const target = path.join(fakeBin, entry.name);
      if (fs.existsSync(target)) continue; // earlier PATH dir already claimed this name
      try {
        fs.symlinkSync(path.join(dir, entry.name), target);
      } catch {
        // unreadable/odd entry: skip it, it wasn't going to be flock anyway
      }
    }
  }
  return fakeBin;
}

const mk = (tmp, name, files = {}) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), body);
  }
  return d;
};

test('prune removes only directories whose owner pid is gone; live, unknown and foreign ones stay', () => {
  const { tmp, env } = sandbox();
  const dead = deadPid();
  const live = process.pid;
  const kept = [
    mk(tmp, `construct-tests-${live}-abc123`),
    mk(tmp, `construct-e2e-state-${live}-XyZ`),
    mk(tmp, 'construct-txn-legacy', { '.owner': `${live}\n` }),
    mk(tmp, 'construct-unknown-owner-fresh'), // no pid anywhere, brand new: kept
    mk(tmp, 'not-construct-at-all'),
  ];
  const removed = [
    mk(tmp, `construct-tests-${dead}-abc123`),
    mk(tmp, `construct-prhealth-${dead}-q1w2e3`, { 'deep/file.txt': 'x' }),
    mk(tmp, `construct-txn-${dead}-zz`),
    mk(tmp, 'construct-step-legacy', { '.owner': `${dead}\n` }),
  ];
  // A symlink named like a dead family must never be followed or removed through.
  const target = mk(tmp, 'target-dir', { 'keep.txt': 'x' });
  fs.symlinkSync(target, path.join(tmp, `construct-tests-${dead}-link`));

  const r = run(['--prune-only'], env);
  assert.equal(r.status, 0, r.stderr);
  for (const d of kept) assert.ok(fs.existsSync(d), `kept ${path.basename(d)}`);
  for (const d of removed) assert.equal(fs.existsSync(d), false, `removed ${path.basename(d)}`);
  assert.ok(fs.existsSync(path.join(target, 'keep.txt')), 'the symlink target is untouched');
  assert.ok(fs.lstatSync(path.join(tmp, `construct-tests-${dead}-link`)).isSymbolicLink(), 'the symlink itself is left alone');
  assert.match(r.stderr, new RegExp(`pruned .*construct-tests-${dead}-abc123 \\(owner pid ${dead} is gone\\)`));
});

test('a live directory older than any age is never pruned by age: mtime is not an owner', () => {
  const { tmp, env } = sandbox();
  const old = mk(tmp, `construct-testrun-${process.pid}-old`, { 'run.log': 'x' });
  const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(old, past, past);
  const r = run(['--prune-only'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(old), 'three hours old, owner alive: kept');
});

test('runs the command, passes its exit status through, and prunes afterwards', () => {
  const { tmp, env } = sandbox();
  const dead = mk(tmp, `construct-step-${deadPid()}-x`);
  const ok = run(['sh', '-c', 'echo ran; exit 0'], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ran/);
  assert.equal(fs.existsSync(dead), false, 'pruned after the command');
  assert.equal(run(['sh', '-c', 'exit 3'], env).status, 3, 'the command exit status is the script exit status');
  assert.equal(run([], env).status, 2, 'usage');
});

test('the holder file names the pid, the start time and the command while the job runs, and is removed after', () => {
  const { env } = sandbox();
  const holder = `${env.CONSTRUCT_HEAVY_LOCK}.holder`;
  const r = run(['sh', '-c', `cat "${holder}"`], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^pid \d+ since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z: sh -c cat/);
  assert.equal(fs.existsSync(holder), false, 'holder file removed on exit');
});

test('a lock held by another process: gives up after CONSTRUCT_HEAVY_LOCK_WAIT_SEC with exit 75 and the holder named', async () => {
  const { env } = sandbox({ CONSTRUCT_HEAVY_LOCK_WAIT_SEC: '1' });
  fs.writeFileSync(`${env.CONSTRUCT_HEAVY_LOCK}.holder`, 'pid 424242 since 2026-01-01T00:00:00Z: sleep forever\n');
  // `flock <file> <cmd>` holds the lock for the life of <cmd>.
  const holder = spawn('flock', [env.CONSTRUCT_HEAVY_LOCK, 'sleep', '30'], { stdio: 'ignore' });
  try {
    // Wait until the lock is really held before starting the waiter.
    for (let i = 0; i < 100; i += 1) {
      if (spawnSync('flock', ['-n', env.CONSTRUCT_HEAVY_LOCK, 'true']).status !== 0) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const started = Date.now();
    const r = run(['sh', '-c', 'echo must-not-run'], env);
    assert.equal(r.status, 75, r.stderr);
    assert.ok(Date.now() - started < 15_000, 'gave up within the wait, not at the 30 s sleep');
    assert.doesNotMatch(r.stdout, /must-not-run/);
    assert.match(r.stderr, /could not get the heavy-job lock .* within 1s/);
    assert.match(r.stderr, /Held by: pid 424242 since 2026-01-01T00:00:00Z: sleep forever/);
  } finally {
    holder.kill('SIGKILL');
  }
});

test('the RAM wait is bounded and the lock is released while waiting and after giving up', () => {
  const { env } = sandbox({ CONSTRUCT_MIN_FREE_MB: '999999999', CONSTRUCT_HEAVY_RAM_WAIT_SEC: '1' });
  const started = Date.now();
  const r = run(['sh', '-c', 'echo must-not-run'], env);
  assert.equal(r.status, 75, r.stderr);
  assert.ok(Date.now() - started < 15_000);
  assert.doesNotMatch(r.stdout, /must-not-run/);
  assert.match(r.stderr, /waiting for >= 999999999 MB free RAM/);
  assert.match(r.stderr, /gave up waiting for >= 999999999 MB free RAM after 1s .*Lock released/);
  // Another job can take the lock right away.
  assert.equal(spawnSync('flock', ['-n', env.CONSTRUCT_HEAVY_LOCK, 'true']).status, 0, 'the lock is free');
});

// ---- #686: no flock on the PATH (e.g. macOS) -- the mkdir fallback --------------------------

test('flock missing: uses the mkdir lock dir instead, and cleans it up after the job', () => {
  const { env } = sandbox();
  const noFlock = { ...env, PATH: pathWithoutFlock() };
  assert.equal(spawnSync('flock', ['-h'], { env: noFlock }).error?.code, 'ENOENT', 'sanity: flock really is hidden from this PATH');

  const lockDir = `${env.CONSTRUCT_HEAVY_LOCK}.d`;
  const r = run(['sh', '-c', `[ -d "${lockDir}" ] && echo lockdir-present; echo ran`], noFlock);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lockdir-present/, 'the mkdir lock exists while the job runs');
  assert.match(r.stdout, /ran/);
  assert.equal(fs.existsSync(lockDir), false, 'lock dir removed once the job exits');
});

test('flock missing: still serializes two overlapping jobs (mutual exclusion via mkdir)', async () => {
  const { tmp, env } = sandbox();
  const noFlock = { ...env, PATH: pathWithoutFlock() };
  const log = path.join(tmp, 'order.log');
  const stamp = (label) => `echo "${label} $(date +%s%N)" >> "${log}"`;

  const a = spawn('bash', [HEAVY, 'sh', '-c', `${stamp('a-start')}; sleep 0.5; ${stamp('a-end')}`], { env: noFlock });
  await new Promise((res) => setTimeout(res, 150)); // let A actually take the lock first
  const b = spawn('bash', [HEAVY, 'sh', '-c', `${stamp('b-start')}; ${stamp('b-end')}`], { env: noFlock });

  const waitExit = (p) => new Promise((res) => p.on('exit', res));
  const [codeA, codeB] = await Promise.all([waitExit(a), waitExit(b)]);
  assert.equal(codeA, 0);
  assert.equal(codeB, 0);
  assert.equal(fs.existsSync(`${env.CONSTRUCT_HEAVY_LOCK}.d`), false, 'lock dir cleaned up after both jobs');

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const idx = (label) => lines.findIndex((l) => l.startsWith(label));
  assert.ok(idx('a-start') < idx('a-end') && idx('a-end') < idx('b-start'), `expected a-start, a-end, b-start, b-end in order, got: ${lines.join(' | ')}`);
});

test('flock missing: a lock dir left by a dead process is cleaned up immediately, never waited out', () => {
  const { env } = sandbox({ CONSTRUCT_HEAVY_LOCK_WAIT_SEC: '20' });
  const noFlock = { ...env, PATH: pathWithoutFlock() };
  const lockDir = `${env.CONSTRUCT_HEAVY_LOCK}.d`;
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), `${deadPid()}\n`);

  const started = Date.now();
  const r = run(['sh', '-c', 'echo ran'], noFlock);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ran/);
  assert.ok(Date.now() - started < 5000, `picked up the dead holder's lock right away, did not sit out the 20s wait (took ${Date.now() - started}ms)`);
  assert.equal(fs.existsSync(lockDir), false, 'lock dir removed after the job');
});

test('flock missing: a lock held by another live process times out, names the holder, exit 75', async () => {
  const { env } = sandbox({ CONSTRUCT_HEAVY_LOCK_WAIT_SEC: '1' });
  const noFlock = { ...env, PATH: pathWithoutFlock() };
  const lockDir = `${env.CONSTRUCT_HEAVY_LOCK}.d`;
  const holderProc = spawn('sleep', ['30']); // a real, live pid to hold the lock, independent of heavy.sh
  try {
    await new Promise((res) => setTimeout(res, 50));
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), `${holderProc.pid}\n`);
    fs.writeFileSync(`${env.CONSTRUCT_HEAVY_LOCK}.holder`, 'pid 424242 since 2026-01-01T00:00:00Z: sleep forever\n');

    const started = Date.now();
    const r = run(['sh', '-c', 'echo must-not-run'], noFlock);
    assert.equal(r.status, 75, r.stderr);
    assert.ok(Date.now() - started < 15_000, 'gave up within the wait, not forever');
    assert.doesNotMatch(r.stdout, /must-not-run/);
    assert.match(r.stderr, /could not get the heavy-job lock .* within 1s/);
    assert.match(r.stderr, /Held by: pid 424242 since 2026-01-01T00:00:00Z: sleep forever/);
  } finally {
    holderProc.kill('SIGKILL');
  }
});
