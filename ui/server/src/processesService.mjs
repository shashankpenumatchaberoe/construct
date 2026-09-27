// #292 — the Cockpit's window onto the process runtime (#287, #291).
//
// This file adds no business logic. Which controls are legal is the state
// machine's answer (`processSummary().controls`); this only asks it. What a
// process is, where it lives and how it is driven are core's
// (src/engine/*.mjs). The service opens the store for the current project,
// keeps one engine per project so pause/resume/cancel/retry act on the real
// running work, and republishes every persisted change to whoever listens
// (the WebSocket, see processesSocket.mjs).
//
// SECURITY: a process id from a client is only ever compared against the ids
// the store itself lists. It is never joined into a path, never given to a
// shell. The one place a path from a client matters (the artifact diff) is
// matched against the paths recorded on the process, the same way.
import { spawnSync } from 'node:child_process';
import { containedProjectRoot } from './projectGuard.mjs';
import { openProcessStore, resolveStateDir } from '../../../packages/engine/processStore.mjs';
import { processSummary, createProcess } from '../../../packages/engine/processModel.mjs';
import { createProcessEngine } from '../../../packages/engine/processEngine.mjs';
import { createBotRunner, botBranch } from '../../../packages/engine/botRunner.mjs';
import { createApprovalGate, GATE_CODES } from '../../../packages/engine/approvalGate.mjs';
import { composeExecutors, ANALYSIS_FLOW } from './reviewAnalyses.mjs';
import { TEST_RUN_FLOW } from './testRuns.mjs';

// #417: a Review analysis or a Tests-tab run must never queue behind a running bot plan. Both are
// exactly one step, and that step's flow says which world it belongs to (`isAnalysisPlan`/
// `isTestRunPlan` check the same thing for a whole plan; this checks it for a live process record,
// whose `steps` are what the engine actually runs). Anything else — every real bot plan — is `write`.
const READ_LANE_FLOWS = new Set([ANALYSIS_FLOW, TEST_RUN_FLOW]);
function laneOf(record) {
  const steps = record?.steps;
  return Array.isArray(steps) && steps.length > 0 && steps.every((s) => READ_LANE_FLOWS.has(s?.flow)) ? 'read' : 'write';
}

/** The UI verbs and the machine event each one sends. The client may only
 * name a verb; whether it is legal now is decided by the machine. */
export const CONTROL_EVENTS = Object.freeze({
  pause: 'PAUSE',
  resume: 'RESUME',
  cancel: 'CANCEL',
  retry: 'RETRY',
});

/** How many log lines a view carries. The record keeps up to 2000; a drawer
 * that repaints on every change does not need to ship all of them each time. */
export const LOG_TAIL = 500;

/** `processSummary()` plus a version that only ever grows (the record's log sequence, which every state
 * change advances). Responses and socket frames can reach a client out of order; the version lets it keep
 * the newest instead of whichever arrived last. */
export function versionedSummary(record) {
  return { ...processSummary(record), version: record.logSeq };
}

/** A process as the drawer's detail view shows it: the summary (with the
 * machine's own `controls`), every step, the artifacts as read-only records
 * and the tail of the log. The plan itself and the raw record stay home. */
export function processView(record) {
  const dropped = Math.max(0, record.log.length - LOG_TAIL);
  return {
    summary: versionedSummary(record),
    steps: record.steps.map((s) => ({
      id: s.id,
      title: s.title,
      flow: s.flow,
      executor: s.executor,
      status: s.status,
      attempts: s.attempts,
      durationMs: s.durationMs,
      llm: s.llm,
      error: s.error,
    })),
    artifacts: record.artifacts.map((a) => ({
      path: a.path, change: a.change, stepId: a.stepId, approved: a.approved, before: a.before, after: a.after,
    })),
    log: record.log.slice(dropped),
    logHidden: record.logDropped + dropped,
  };
}

function runGit(cwd, args) {
  // --literal-pathspecs: the artifact path reaches git after `--`, and it must be a path, never a
  // pathspec pattern (`:(glob)`, `:(top)`), exactly as the approval gate (#337) does.
  const res = spawnSync('git', ['--literal-pathspecs', ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { ok: res.status === 0, out: res.stdout ?? '', err: (res.stderr || res.error?.message || '').trim() };
}

/**
 * #611: why a plan may not start because of the project's block settings, or null. Fail closed: settings that cannot be
 * read refuse every plan (the Blocks tab offers a reset), the same rule the plan check applies (planService.mjs).
 * Nothing is saved or started when this answers.
 */
function blockRefusal(getBlockSettings, root, plan) {
  if (!getBlockSettings) return null;
  let s;
  try {
    s = getBlockSettings(root);
  } catch (e) {
    s = { flows: [], unreadable: String(e?.message || e) };
  }
  if (s?.unreadable) return 'This project\'s block settings could not be read, so nothing can be started. Open Features, Blocks tab, and save the settings again to reset them.';
  const off = new Set(Array.isArray(s?.flows) ? s.flows : []);
  const hit = (Array.isArray(plan?.steps) ? plan.steps : []).find((step) => off.has(step?.flow));
  return hit ? `The block "${hit.flow}" is turned off for this project. Turn it on in Features, Blocks tab, then try again.` : null;
}

/**
 * @param {object} options
 * @param {() => string} options.getProjectDir the project directory the Cockpit is pointed at right now
 * @param {string} [options.stateDir]
 * @param {(ctx: any) => Promise<any>} [options.executeStep] defaults to the real bot runner (#291)
 * @param {{executeStep: Function}} [options.reviewExecutor] #351: runs `review.analyze` steps (read-only, no
 *   worktree, no branch, never any artifact); every other flow still goes to the bot runner
 * @param {{executeStep: Function}} [options.testRunExecutor] #305: runs `test.run` steps the same way (read-only, forked
 *   worker, never any artifact)
 * @param {(root: string) => {flows: string[], unreadable?: string|null}} [options.getBlockSettings] #611: the blocks turned
 *   off for a project (Features, Blocks tab), read fresh on every start. `startPlan` refuses a plan that uses one, so the
 *   Git screen's Review analysis and the Tests screen's run, which start their own plans, cannot forget the check.
 * @param {number} [options.adoptIntervalMs] #415: how often every open project's `adoptInterrupted()` re-runs, not
 *   only at server start. A killed server is caught at the next `open()`, but a server that is merely wedged
 *   (an engine-level failure whose own record could not be saved, a store gone unwritable) needs the same
 *   liveness check to run again without a restart. `0` disables the timer (tests that don't care).
 * @param {typeof setInterval} [options.setIntervalFn] test seam.
 * @param {typeof clearInterval} [options.clearIntervalFn] test seam.
 * @param {(pid: number) => boolean} [options.isAlive] forwarded to every `adoptInterrupted()` call (start-up and
 *   timer alike); test seam so a test can fake a dead pid deterministically instead of racing a real one.
 */
export function createProcessesService({
  getProjectDir,
  stateDir = resolveStateDir(),
  executeStep = null,
  reviewExecutor = null,
  testRunExecutor = null,
  getBlockSettings = null,
  adoptIntervalMs = 5 * 60 * 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  isAlive = null,
} = {}) {
  /** project root -> { store, engine, root } */
  const projects = new Map();
  const listeners = new Set();
  let executor = executeStep;
  let runner = null;

  const emit = (record) => {
    for (const fn of listeners) {
      try { fn(record); } catch { /* one bad listener must not stop the engine */ }
    }
  };

  /** Re-run `adoptInterrupted()` on every project already opened this server
   * run. `open()` only checks once, the moment a project is first touched
   * (the comment there says so); this is the same check run again, later,
   * for a server that is still up but wedged rather than killed (#415). */
  function reAdoptAll() {
    for (const entry of projects.values()) {
      for (const record of entry.store.adoptInterrupted(isAlive ? { isAlive } : undefined)) emit(record);
    }
  }

  const adoptTimer = adoptIntervalMs > 0 ? setIntervalFn(reAdoptAll, adoptIntervalMs) : null;
  adoptTimer?.unref?.();

  const engineOptions = () => {
    if (executor) return { executeStep: executor };
    runner ||= createBotRunner({ stateDir });
    const bot = runner.executeStep;
    const routed = reviewExecutor || testRunExecutor;
    if (!routed) return { executeStep: bot, maxConcurrent: runner.maxConcurrent };
    // #417: once a step can be a read-only analysis or test run, it gets its own lane so it never
    // queues behind a running bot plan. The write lane keeps `runner.maxConcurrent` (default 1) as its
    // cap — unchanged plan-vs-plan behaviour — plus the box-wide semaphore the engine enforces itself.
    return {
      executeStep: composeExecutors({ bot, review: reviewExecutor?.executeStep ?? bot, testRun: testRunExecutor?.executeStep ?? null }),
      lanes: { write: runner.maxConcurrent, read: 1 },
      laneOf,
    };
  };

  function open() {
    const dir = getProjectDir();
    const root = dir ? containedProjectRoot(dir) || dir : null;
    if (!root) return null;
    let entry = projects.get(root);
    if (!entry) {
      const store = openProcessStore(root, { stateDir });
      // A record left `running` by a server that was killed is not running;
      // pause it so it can be resumed. Once per project per server start
      // (the timer below, #415, is what covers a wedge found later).
      store.adoptInterrupted(isAlive ? { isAlive } : undefined);
      const engine = createProcessEngine({ store, ...engineOptions(), onChange: emit });
      // The approval gate (#337) is the only writer of a bot's output into the tree; the service
      // only hands it what the router derived (see decide() below).
      const gate = createApprovalGate({ store, runner });
      entry = { store, engine, root, gate };
      projects.set(root, entry);
    }
    return entry;
  }

  /** The record for `id`, matched against what the store lists. */
  function find(entry, id) {
    if (typeof id !== 'string') return null;
    return entry.store.all().processes.find((p) => p.id === id) ?? null;
  }

  return {
    /** Swap the executor (tests and the e2e harness). Applies to projects opened afterwards. */
    setExecutor(fn) { executor = fn; projects.clear(); },
    currentRoot: () => open()?.root ?? null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** #415: fire the periodic re-adoption check right now, instead of waiting `adoptIntervalMs` — what the
     * timer does on its own schedule, exposed so a test (or an admin action) can trigger it deterministically. */
    reAdoptInterrupted: reAdoptAll,
    /** Stop the periodic re-adoption timer. Harmless to skip (it's `unref()`d and does not block process
     * exit), but a test that creates many services in a loop, or a graceful shutdown, can call it to be tidy. */
    close() { if (adoptTimer) clearIntervalFn(adoptTimer); },
    /** The engine for the current project, for a harness that has to start work. */
    engine: () => open()?.engine ?? null,
    store: () => open()?.store ?? null,
    /** Does `record` belong to the project the Cockpit is looking at? */
    isCurrent(record) { return open()?.root === record.projectRoot; },

    /** #289 — create a process from a plan the caller has ALREADY validated (planService.run) and start it.
     * The project is the service's own; createProcess() validates the plan once more and throws on a bad one. */
    startPlan(plan) {
      const entry = open();
      if (!entry) return { ok: false, status: 409, error: 'No Construct project is open.' };
      const refused = blockRefusal(getBlockSettings, entry.root, plan);
      if (refused) return { ok: false, status: 409, error: refused };
      let record;
      try {
        record = entry.store.save(createProcess(plan, { projectRoot: entry.root }));
      } catch (e) {
        return { ok: false, status: 400, error: String(e?.message || e) };
      }
      emit(record);
      const started = entry.engine.start(record.id);
      if (!started.accepted) return { ok: false, status: 409, error: started.error?.message || 'The process could not be started.' };
      return { ok: true, processId: record.id };
    },

    list() {
      const entry = open();
      if (!entry) return { projectRoot: null, processes: [], problems: [] };
      const { processes: records, problems } = entry.store.all();
      return { projectRoot: entry.root, processes: records.map(versionedSummary), problems: problems.map((p) => ({ id: p.id, reason: p.reason })) };
    },

    /** -> { status, body } */
    detail(id) {
      const entry = open();
      const record = entry && find(entry, id);
      if (!record) return { status: 404, body: { ok: false, error: 'No such process.' } };
      return { status: 200, body: { ok: true, process: processView(record) } };
    },

    control(id, verb) {
      const event = Object.hasOwn(CONTROL_EVENTS, verb) ? CONTROL_EVENTS[verb] : null;
      if (!event) return { status: 400, body: { ok: false, error: `Unknown control "${String(verb).slice(0, 40)}". Expected one of: ${Object.keys(CONTROL_EVENTS).join(', ')}.` } };
      const entry = open();
      const record = entry && find(entry, id);
      if (!record) return { status: 404, body: { ok: false, error: 'No such process.' } };
      // The machine decides. This check happens BEFORE the engine is asked,
      // because `engine.retry()` prepares the record before it consults the
      // machine, so an illegal retry must never reach it.
      const { controls } = processSummary(record);
      if (!controls.includes(event)) {
        return { status: 409, body: { ok: false, error: `A process in "${record.state}" does not accept ${verb}.`, controls } };
      }
      const result = entry.engine[verb](record.id);
      if (!result.accepted) return { status: 409, body: { ok: false, error: result.error?.message || 'Refused.', controls } };
      return { status: 200, body: { ok: true, process: processView(entry.store.load(record.id)) } };
    },

    /** #341 — the gate's read-only review of one process: per artifact the exact diff, its sha256, the
     * refusals and whether it is `applicable`. -> { status, body } */
    review(id) {
      const entry = open();
      const record = entry && find(entry, id);
      if (!record) return { status: 404, body: { ok: false, error: 'No such process.' } };
      const review = entry.gate.review(record.id);
      if (!review.ok) return { status: 409, body: { ok: false, error: review.error.message, code: review.error.code } };
      return { status: 200, body: review };
    },

    /** #341 — ONE decision on ONE artifact. `by` is an argument the ROUTER derives from the signed session;
     * nothing in the request body can reach it. `diffSha256` is passed through exactly as the client echoed
     * it; it is never computed or defaulted here, so the gate compares it with the diff it re-derives.
     * -> { status, body } */
    decide(id, { by, path, verdict, diffSha256 }) {
      const entry = open();
      const record = entry && find(entry, id);
      if (!record) return { status: 404, body: { ok: false, error: 'No such process.' } };
      const decision = { path, verdict };
      if (diffSha256 !== undefined) decision.diffSha256 = diffSha256;
      const result = entry.gate.decide(record.id, { by, decisions: [decision] });
      if (!result.ok) {
        const status = result.error.code === GATE_CODES.PROCESS_NOT_FOUND ? 404 : result.error.code === GATE_CODES.PROCESS_ACTIVE ? 409 : 400;
        return { status, body: { ok: false, error: result.error.message, code: result.error.code } };
      }
      // The gate saves the record directly, not through the engine, so tell the socket.
      const fresh = entry.store.load(record.id);
      if (fresh) emit(fresh);
      const outcome = result.results[0];
      const body = { ok: true, ...result, decided: outcome.decided, refusals: outcome.refusals };
      return { status: outcome.decided ? 200 : 409, body: outcome.decided ? body : { ...body, ok: false, error: outcome.refusals[0]?.message || 'Refused.' } };
    },

    /** The unified diff of one recorded artifact, read from the bot's branch.
     * `filePath` must equal a path recorded on the process; the branch name
     * is derived from the id the store returned, not the client's string. */
    artifactDiff(id, filePath) {
      const entry = open();
      const record = entry && find(entry, id);
      if (!record) return { status: 404, body: { ok: false, error: 'No such process.' } };
      const artifact = record.artifacts.find((a) => a.path === filePath);
      if (!artifact) return { status: 404, body: { ok: false, error: 'That file is not one of this process\'s artifacts.' } };
      const branch = botBranch(record.id);
      const exists = runGit(entry.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (!exists.ok) return { status: 200, body: { ok: true, diff: null, reason: 'The bot\'s branch is gone, so there is no diff to show.' } };
      const diff = runGit(entry.root, ['diff', '--no-color', `HEAD...refs/heads/${branch}`, '--', artifact.path]);
      if (!diff.ok) return { status: 200, body: { ok: true, diff: null, reason: diff.err || 'git could not produce a diff.' } };
      return { status: 200, body: { ok: true, diff: diff.out.slice(0, 200_000), truncated: diff.out.length > 200_000 } };
    },
  };
}
