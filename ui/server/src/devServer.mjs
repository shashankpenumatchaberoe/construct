// #378 — the target app's dev server as a managed, per-project process.
//
// "Start dev server" runs the open project's OWN script (`scripts.dev`, else `scripts.start` from its
// package.json) as `npm run <script>`: never a different command, never extra flags. The Cockpit only
// chooses a free port and hands it over the way every dev server already accepts one (PORT / HOST env);
// the real address is then read from what the server itself prints and confirmed with a TCP connect, so a
// framework that picks its own port (Vite does) is still reported truthfully.
//
// Why not the plan/bot process engine (processesService)? A process there is a validated plan of steps that
// ends and produces artifacts for the approval gate. A dev server has no steps, no artifacts and no end: it
// runs until someone stops it. So this is its own small lifecycle (not-running -> starting -> running |
// failed), and its output goes to the Cockpit's Logs tab through the same `serverLog` registry the command
// runner feeds: into the ring of the login that started it (#569), named explicitly on every line because
// child-process events and timers fire outside that user's request context.
//
// SESSION BRANCH: nothing here copies or checks out anything. Cockpit's session branch IS the branch checked
// out in the project's own working tree (autoCommit.mjs `createBranch` = `git checkout -b`), and the dev
// server runs in that same directory, so Cockpit's saves and the dev server's view of the files are the same
// files by construction. `branch`/`branchKind` in the status only REPORT which kind of branch that is.
//
// Guardrails (they hold whatever the UI does):
//   - never started without an explicit start call; nothing in this file starts one on its own;
//   - the project must be inside the workspace root (#365): refused when its root escapes it, and the working
//     directory is re-verified by real path just before spawning;
//   - an allowlisted environment, so the Cockpit's own secrets (session secret, OAuth, tokens) never reach
//     project code;
//   - its own process group, killed as a group; stopped on Close project, Sign out, and when the Cockpit
//     server itself exits (same pattern as clone jobs, #422).
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { containedProjectRoot, rootEscapesWorkspace } from './projectGuard.mjs';
import { serverLog } from './logBuffer.mjs';
import { currentLogin, isInside, normalizeLogin, workspaceRoot } from './workspace.mjs';

/** The port tried first: Vite's default, so a typical app lands where its developer expects. */
export const DEFAULT_PORT_BASE = 5173;
/** Ports the Cockpit will not hand out (its own defaults and the web's), whether or not they look free. */
export const RESERVED_PORTS = Object.freeze([80, 443, 3000, 4000]);
const PORT_SEARCH = 200;
const LOG_KEEP = 200;
export const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
export const DEFAULT_KILL_GRACE_MS = 4_000;
const POLL_MS = 250;
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'FNM_DIR'];

export const REFUSALS = Object.freeze({
  NO_PROJECT: { code: 'NO_PROJECT', message: 'No project is open. Open a project from the workspace first.' },
  OUTSIDE_WORKSPACE: { code: 'PROJECT_ROOT_OUTSIDE_WORKSPACE', message: 'This project is not inside the workspace root, so the Cockpit will not start a server for it.' },
  NO_SCRIPT: { code: 'NO_DEV_SCRIPT', message: 'This project\'s package.json has no "dev" or "start" script, so there is nothing to run.' },
});

/** `{script, text, display}` for the project at `root`, or `{refusal}`. `dev` wins over `start`. Reads only. */
export function readDevCommand(root) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return { refusal: REFUSALS.NO_SCRIPT };
  }
  const scripts = pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  for (const script of ['dev', 'start']) {
    if (typeof scripts[script] === 'string' && scripts[script].trim()) return { script, text: scripts[script].trim(), display: `npm run ${script}` };
  }
  return { refusal: REFUSALS.NO_SCRIPT };
}

/** A local address in a line of dev-server output (`Local: http://localhost:5173/`), as a port, or null. */
export function parseLocalPort(line) {
  const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})/i.exec(String(line));
  const port = m ? Number(m[1]) : null;
  return port && port <= 65535 ? port : null;
}

/** Does this output say the port was taken? Covers Node's own EADDRINUSE and the wording Vite/Next/webpack use. */
export function looksLikePortBusy(text) {
  return /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|port \d+ is (?:currently )?(?:busy|taken)/i.test(String(text));
}

/** The port the output says was taken (`EADDRINUSE ... :5173`, `Port 5173 is in use`), or null. */
export function busyPortFrom(text) {
  const m = /(?:EADDRINUSE[^\n]*?:|port )(\d{2,5})\b/i.exec(String(text));
  const port = m ? Number(m[1]) : null;
  return port && port <= 65535 ? port : null;
}

/** Can something listen on 127.0.0.1:`port` right now? */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** The first free port at or above `from`, skipping the reserved ones and any in `taken` (ports another slot has claimed but not bound yet); null when none in the search window. */
export async function findFreePort(from = DEFAULT_PORT_BASE, { reserved = RESERVED_PORTS, taken = null } = {}) {
  for (let p = from; p < from + PORT_SEARCH && p <= 65535; p += 1) {
    if (reserved.includes(p) || taken?.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  return null;
}

/** Can something be reached by a TCP connect to `host`:`port`? */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(700, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Does something accept a connection on `port`? Returns the host that answered ('127.0.0.1' or '::1'), or null. */
function answers(port) {
  const tryHost = (host) => canConnect(host, port).then((ok) => (ok ? host : null));
  return tryHost('127.0.0.1').then((h) => h ?? tryHost('::1'));
}

/** This machine's own addresses other than loopback, on every interface (what a LAN peer could reach it by). */
export function nonLoopbackAddresses() {
  const out = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (!info.internal && (info.family === 'IPv4' || info.family === 'IPv6')) out.push(info.address);
    }
  }
  return out;
}

// #557: the Cockpit never invents a `--host` flag; it only hands the project's `scripts.dev` PORT/HOST/HOSTNAME
// and frames a loopback address. A framework that ignores those and binds 0.0.0.0 anyway (Next.js's default) is
// still reachable from the LAN while the card says "Running", so once the loopback probe answers, also try this
// machine's own non-loopback addresses on the same port: the first that answers is worth a warning.
/** The first of this machine's non-loopback addresses that also answers on `port`, or null. */
async function networkReachableAddress(port) {
  for (const address of nonLoopbackAddresses()) {
    if (await canConnect(address, port)) return address; // addresses are few; this runs once, right after "running"
  }
  return null;
}

const liveChildren = new Set();
let handlersInstalled = false;

function killGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
}

/** SIGKILL every live dev server's process group. Registered on exit and the terminating signals; exported for tests. */
export function killLiveDevServers() {
  for (const child of liveChildren) killGroup(child, 'SIGKILL');
  liveChildren.clear();
}

// `exit` covers a normal end and process.exit(); a signal with its default disposition does not run `exit`
// handlers, so SIGINT/SIGTERM/SIGHUP clean up, drop the handler and re-raise (as cloneJobs.mjs does, #422).
function installExitHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on('exit', killLiveDevServers);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      killLiveDevServers();
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

function childEnv({ port }) {
  const env = { FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none', NODE_ENV: 'development', PORT: String(port), HOST: '127.0.0.1', HOSTNAME: '127.0.0.1' };
  for (const k of SAFE_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * @param {object} options
 * @param {() => (string|null)} options.getProjectDir the directory the Cockpit is pointed at right now
 * @param {(root: string) => ({branch: (string|null), isSession: boolean})} [options.getBranchInfo] which branch is checked out, and did Cockpit create it
 * @param {number} [options.portBase] first port tried (default 5173, or CONSTRUCT_DEV_SERVER_PORT_BASE)
 * @param {number} [options.startupTimeoutMs] how long "starting" may last before it is treated as failed
 * @param {number} [options.killGraceMs] SIGTERM -> SIGKILL grace on stop
 * @param {typeof nodeSpawn} [options.spawn] test seam
 * @param {{record: Function}} [options.log] where output lines go (the Logs tab); `record(source, level, text, now, login)`
 */
export function createDevServerService({
  getProjectDir,
  getBranchInfo = () => ({ branch: null, isSession: false }),
  portBase = Number(process.env.CONSTRUCT_DEV_SERVER_PORT_BASE) || DEFAULT_PORT_BASE,
  startupTimeoutMs = Number(process.env.CONSTRUCT_DEV_SERVER_STARTUP_TIMEOUT_MS) || DEFAULT_STARTUP_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  spawn = nodeSpawn,
  log = serverLog,
} = {}) {
  // #569: one slot per (signed-in login, project root). The login is the session's (workspace.mjs currentLogin(),
  // '' when auth is off), so two users never see, stop or replace each other's dev server; single-user is one key.
  /** `login\0root` -> the one dev server slot for that user's project */
  const slots = new Map();
  /** login -> status version, so one user's activity is not visible to another's poll */
  const versions = new Map();
  /** Ports handed to a slot that has not necessarily bound yet, across ALL users: two concurrent starts never get the same one. */
  const claimed = new Set();

  const blank = (root, login) => ({ root, login, state: 'not-running', child: null, exited: null, stopping: false, reported: null, port: null, url: null, pid: null, startedAt: null, failure: null, networkWarning: null, tail: [], timers: [], command: null, claimedPort: null });
  const keyOf = (root, login = currentLogin()) => `${login}\u0000${root}`;
  const slotFor = (root) => { const k = keyOf(root); let s = slots.get(k); if (!s) { s = blank(root, currentLogin()); slots.set(k, s); } return s; };
  const bump = (login) => { versions.set(login, (versions.get(login) ?? 0) + 1); };
  let portLock = Promise.resolve();
  const withPortLock = (fn) => { const r = portLock.then(fn); portLock = r.catch(() => {}); return r; };
  const claim = (slot, port) => { release(slot); if (port) { slot.claimedPort = port; claimed.add(port); } };
  const release = (slot) => { if (slot.claimedPort) { claimed.delete(slot.claimedPort); slot.claimedPort = null; } };

  /** Which project this call is about, and why nothing can start there. Reads only. */
  function target() {
    const dir = getProjectDir();
    if (!dir) return { refusal: REFUSALS.NO_PROJECT, root: null };
    if (rootEscapesWorkspace(dir)) return { refusal: REFUSALS.OUTSIDE_WORKSPACE, root: null };
    const root = containedProjectRoot(dir) || dir;
    const command = readDevCommand(root);
    return { root, ...(command.refusal ? { refusal: command.refusal } : {}) };
  }

  function statusFor(root, refusal) {
    const slot = root ? slots.get(keyOf(root)) : null;
    const branch = root ? getBranchInfo(root) : { branch: null, isSession: false };
    const command = root && !refusal ? readDevCommand(root) : null;
    return {
      ok: true,
      version: versions.get(currentLogin()) ?? 0,
      state: slot ? slot.state : 'not-running',
      refusal: refusal ?? null,
      command: command && !command.refusal ? { script: command.script, text: command.text, display: command.display } : null,
      root: root ?? null,
      port: slot?.port ?? null,
      url: slot?.url ?? null,
      pid: slot?.pid ?? null,
      startedAt: slot?.startedAt ?? null,
      failure: slot?.failure ?? null,
      networkWarning: slot?.networkWarning ?? null,
      branch: branch.branch ?? null,
      // `session` = Cockpit created it (the dev server sees exactly what Cockpit saves, by construction);
      // `other` = pre-existing or hand-made (Cockpit can work on it, but does not control what else touches it).
      branchKind: branch.branch ? (branch.isSession ? 'session' : 'other') : null,
    };
  }

  const clearTimers = (slot) => { for (const t of slot.timers) clearInterval(t); slot.timers = []; };
  /** One Logs-tab line for the login that owns `slot` (never the login of whoever's request, if any, is current). */
  const say = (slot, level, text) => log.record('dev-server', level, text, Date.now(), slot.login);

  function record(slot, level, chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
      if (!text) continue;
      say(slot, level, text);
      slot.tail.push(text);
      if (slot.tail.length > LOG_KEEP) slot.tail.shift();
      // The real address is whatever the server says it is listening on. Only a line that says so counts, so a
      // banner that merely mentions some other local URL (a proxy target, a backend) is not taken for it.
      if (slot.state === 'starting' && !slot.reported && /local|listening|ready|running|started|serving|available/i.test(text)) {
        const port = parseLocalPort(text);
        if (port) slot.reported = port;
      }
    }
  }

  async function failureFor(slot, code) {
    const output = slot.tail.join('\n');
    if (looksLikePortBusy(output)) {
      // The port the server itself says it could not have, which is not ours when the script hardcodes one.
      const busy = busyPortFrom(output) ?? slot.port;
      const suggestedPort = await findFreePort((busy || portBase) + 1, { taken: claimed });
      return { kind: 'port-busy', message: `Port ${busy} is in use by another process.`, port: busy, suggestedPort };
    }
    const last = [...slot.tail].reverse().find((l) => /error|cannot|failed|not found|missing/i.test(l)) || slot.tail[slot.tail.length - 1] || '';
    return { kind: 'exited', message: `The dev server exited (code ${code ?? 'unknown'}) before it was ready.${last ? ` Last output: ${last.slice(0, 200)}` : ''}`, code };
  }

  function watch(slot) {
    const startedAt = Date.now();
    const poll = setInterval(async () => {
      if (slot.state !== 'starting' || slot.exited) return;
      let port = slot.reported || slot.port;
      let host = await answers(port);
      if (!host && slot.reported && slot.reported !== slot.port) { port = slot.port; host = await answers(port); }
      if (slot.state !== 'starting' || slot.exited) return;
      if (host) {
        slot.port = port;
        slot.url = `http://${host === '::1' ? 'localhost' : '127.0.0.1'}:${port}/`;
        slot.state = 'running';
        clearTimers(slot);
        bump(slot.login);
        say(slot, 'info', `Dev server is running at ${slot.url}`);
        const networkAddress = await networkReachableAddress(port);
        // Only a slot still running this same server counts: it may have been stopped or restarted while this awaited.
        if (networkAddress && slot.state === 'running' && slot.port === port) {
          slot.networkWarning = `This server is also reachable from your network: ${networkAddress}:${port}`;
          say(slot, 'warn', slot.networkWarning);
          bump(slot.login);
        }
      } else if (Date.now() - startedAt > startupTimeoutMs) {
        slot.failure = { kind: 'timeout', message: `The dev server did not start answering within ${Math.round(startupTimeoutMs / 1000)} seconds.` };
        clearTimers(slot);
        bump(slot.login);
        killGroup(slot.child, 'SIGTERM');
      }
    }, POLL_MS);
    slot.timers.push(poll);
  }

  function onExit(slot, code, signal) {
    clearTimers(slot);
    liveChildren.delete(slot.child);
    slot.exited = { code, signal };
    release(slot);
    slot.pid = null;
    slot.url = null;
    slot.networkWarning = null;
    const wasStarting = slot.state === 'starting';
    const requested = slot.stopping;
    slot.child = null;
    if (requested) {
      slot.state = 'not-running';
      slot.failure = null;
      bump(slot.login);
      say(slot, 'info', 'Dev server stopped.');
      return Promise.resolve();
    }
    return failureFor(slot, code).then((failure) => {
      // A start that timed out already carries its own reason.
      slot.failure = slot.failure && slot.failure.kind === 'timeout' && wasStarting ? slot.failure : failure;
      slot.state = 'failed';
      bump(slot.login);
      say(slot, 'error', slot.failure.message);
    });
  }

  /** Stop and wait until the process group is gone. Resolves whether or not anything was running. */
  async function stopSlot(slot) {
    const child = slot.child;
    if (!child || slot.exited) return;
    slot.stopping = true;
    const gone = new Promise((resolve) => child.once('close', resolve));
    killGroup(child, 'SIGTERM');
    const force = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs);
    await Promise.race([gone, new Promise((r) => setTimeout(r, killGraceMs + 3000))]);
    clearTimeout(force);
    if (slot.child) killGroup(child, 'SIGKILL');
  }

  async function start({ port: requested } = {}) {
    const t = target();
    if (t.refusal) {
      return { status: 409, body: { ...statusFor(t.root, t.refusal), ok: false, code: t.refusal.code, error: t.refusal.message } };
    }
    const { root } = t;
    const slot = slotFor(root);
    if (slot.state === 'starting' || slot.state === 'running') {
      return { status: 409, body: { ...statusFor(root, null), ok: false, code: 'ALREADY_RUNNING', error: 'The dev server is already running for this project. Stop it first, or use Restart.' } };
    }
    // The workspace rule again, by real path, at the last moment before project code runs.
    let real;
    try { real = fs.realpathSync.native(root); } catch { real = null; }
    if (!real || !isInside(workspaceRoot(), real)) {
      return { status: 409, body: { ...statusFor(null, REFUSALS.OUTSIDE_WORKSPACE), ok: false, code: REFUSALS.OUTSIDE_WORKSPACE.code, error: REFUSALS.OUTSIDE_WORKSPACE.message } };
    }

    const command = readDevCommand(root);
    let port = null;
    if (requested !== undefined && requested !== null) {
      const n = Number(requested);
      if (!Number.isInteger(n) || n < 1024 || n > 65535 || RESERVED_PORTS.includes(n)) {
        return { status: 400, body: { ...statusFor(root, null), ok: false, code: 'BAD_PORT', error: 'Choose a port between 1024 and 65535 that is not one of the Cockpit\'s own.' } };
      }
      port = n;
    }
    // Choose AND claim under one lock: the probing awaits, so without it two users starting at once both see
    // 5173 free. Only the winner's claim is visible to the next probe.
    const wantedFree = await withPortLock(async () => {
      const p = port === null ? await findFreePort(portBase, { taken: claimed }) : ((!claimed.has(port) && await isPortFree(port)) ? port : null);
      if (p !== null) claim(slot, p);
      return p;
    });
    if (wantedFree === null) {
      const suggestedPort = await findFreePort((port ?? portBase) + 1, { taken: claimed });
      release(slot);
      Object.assign(slot, blank(root, slot.login), { state: 'failed', port, failure: { kind: 'port-busy', message: `Port ${port ?? portBase} is in use by another process.`, port, suggestedPort } });
      bump(slot.login);
      return { status: 409, body: { ...statusFor(root, null), ok: false, code: 'PORT_BUSY', error: slot.failure.message } };
    }
    port = wantedFree;

    // (the port is already claimed above; blank() resets claimedPort, so it is set again right after)
    Object.assign(slot, blank(root, slot.login), { state: 'starting', port, startedAt: new Date().toISOString(), command });
    bump(slot.login);
    slot.claimedPort = port;
    installExitHandlers();
    say(slot, 'info', `Starting ${command.display} (${command.text}) in ${path.basename(root)} on port ${port}`);
    let child;
    try {
      child = spawn('npm', ['run', command.script], { cwd: root, env: childEnv({ port }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      release(slot);
      slot.state = 'failed';
      slot.failure = { kind: 'exited', message: `Could not run npm: ${e.message}` };
      bump(slot.login);
      return { status: 500, body: { ...statusFor(root, null), ok: false, code: 'SPAWN_FAILED', error: slot.failure.message } };
    }
    slot.child = child;
    slot.pid = child.pid ?? null;
    liveChildren.add(child);
    child.stdout.on('data', (d) => record(slot, 'info', d));
    child.stderr.on('data', (d) => record(slot, 'warn', d));
    child.once('error', (e) => { record(slot, 'error', `Could not run npm: ${e.message}`); });
    child.once('close', (code, signal) => { onExit(slot, code, signal); });
    watch(slot);
    return { status: 202, body: { ...statusFor(root, null) } };
  }

  async function stop() {
    const t = target();
    const root = t.root;
    const slot = root ? slots.get(keyOf(root)) : null;
    if (slot) {
      await stopSlot(slot);
      // Stopping a failed slot is dismissing it: back to "not running", with the old failure forgotten.
      if (slot.state === 'failed') { release(slot); slots.delete(keyOf(root)); }
    }
    return { status: 200, body: statusFor(root, t.refusal) };
  }

  return {
    status() { const t = target(); return statusFor(t.root, t.refusal); },
    start,
    stop,
    async restart(opts = {}) {
      await stop();
      return start(opts);
    },
    /** Stop the dev server of one project (Close project / switching projects). Never throws. */
    async stopForRoot(root) {
      const slot = root ? slots.get(keyOf(root)) : null;
      if (slot) { await stopSlot(slot).catch(() => {}); release(slot); slots.delete(keyOf(root)); }
    },
    /** Stop every dev server one login started (that login signing out); other users' keep running. `null`/unusable
     * login stops nothing. '' is the no-session (auth off) user. Never throws. */
    async stopForLogin(login) {
      let who;
      try { who = login === '' ? '' : normalizeLogin(login); } catch { return; }
      const mine = [...slots.entries()].filter(([, s]) => s.login === who);
      await Promise.all(mine.map(([, s]) => stopSlot(s).catch(() => {})));
      for (const [k, s] of mine) { release(s); slots.delete(k); }
    },
    /** Stop every user's dev server (the Cockpit itself is shutting down, and tests). Never throws. */
    async stopAll() {
      await Promise.all([...slots.values()].map((s) => stopSlot(s).catch(() => {})));
      slots.clear();
      claimed.clear();
    },
    /** The project root a stop-on-close should target: the one the Cockpit is looking at now, or null. */
    currentRoot() { const dir = getProjectDir(); return dir ? (containedProjectRoot(dir) || dir) : null; },
  };
}
