// #287 — the driver: control semantics for a running process.
//
// The boundary against #291, stated once so it does not get blurred later:
// this file owns *when* a step runs, *whether* a pause or cancel takes
// effect, *when* the transaction commits, and *what gets recorded*. It does
// NOT own how a step actually executes — spawning, LLM routing, capturing a
// CLI's console output. That is the `executeStep` function a caller supplies,
// and it is the whole of #291's surface here.
//
// Two guarantees are structural rather than left to each executor's good
// behaviour, because the approval gate on #291 is a safety property:
//
//  1. **Every step runs inside its own transaction.** The engine creates a
//     `createTransaction(projectRoot)` and hands it to the executor; staged
//     writes land only when the step succeeds AND `commit()` passes
//     validation. So a step that fails, is cancelled, or produces a tree that
//     does not validate has written nothing, and there is nothing to roll
//     back. This is why cancel does not undo: at step granularity there is
//     nothing to undo, and at process granularity undoing work the user
//     watched land would be a surprise, not a safety feature (the decision
//     recorded on #287).
//  2. **Every finished step records whether a model was involved.**
//     `completeStep`/`failStep` refuse a missing `llm` field, so an executor
//     cannot quietly omit it.
//
// Concurrency (the third decision on #287): processes do NOT queue behind
// `ui/server/src/commandRunner.mjs`. That queue exists because `runCapturing`
// patches `console.*` process-globally, which is real, but it serialises
// *command executions* — and a plan is minutes of them. Putting processes on
// it would wedge every interactive Cockpit command behind a running plan, and
// a Pause request would queue behind the very step it is trying to stop.
// Instead the engine has its own slot queue, `maxConcurrent` (default 1:
// parallel writers in one tree collide, which is why this repo's own agents
// use worktrees). The console-global constraint stays where it belongs —
// whichever executor #291 supplies still routes its in-process cli.mjs calls
// through `runCapturing`. Core imports nothing from `ui/`.
import fs from 'node:fs';
import path from 'node:path';
import { planToCommand } from '../core/plan.mjs';
import { createTransaction } from './transactionalWriter.mjs';
import { topLevelState, isTerminal } from './processMachine.mjs';
import {
  applyEvent,
  appendLog,
  recordArtifact,
  startStep,
  completeStep,
  failStep,
  skipStep,
  stepStatus,
  planStep,
  nextRunnableStep,
  unreachableSteps,
} from './processModel.mjs';

/** Thrown by the engine when a step is abandoned because cancel was asked
 * for. Not a failure: nothing was written, and the step goes back to
 * `pending`. */
export class StepAborted extends Error {
  constructor(stepId) {
    super(`Step "${stepId}" was abandoned because the process was cancelled.`);
    this.name = 'StepAborted';
    this.stepId = stepId;
  }
}

const defaultNow = () => new Date().toISOString();

// #417 — a box-wide cap on the WRITE lane, shared by every engine in this process no matter how many
// projects are open. Read-only work (`review.analyze`, `test.run`) never touches this: it was queuing
// for minutes behind a running bot plan in the SAME engine, which lanes fix per project; this fixes the
// other half — N open projects each getting their own engine meant N concurrent bots on one 15 GB box.
// Deliberately module-level rather than an option threaded through every call site, and read fresh
// (never cached) so it reacts to `CONSTRUCT_BOT_CONCURRENCY` the same way `botRunner.mjs`'s own
// `resolveMaxConcurrent()` does, and so a test can flip it between cases without restarting anything.
const globalWriteLane = { active: 0, pumps: new Set() };

function globalWriteLimit(env = process.env) {
  const n = Number.parseInt(env.CONSTRUCT_BOT_CONCURRENCY, 10);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * `planToCommand()` for a step, with the `files` placeholders already
 * materialised into real temp files — the concrete example the mantra asks
 * each layer to hand the next, so #291's executor spawns a command rather
 * than re-deriving how each of the 23 flows is invoked.
 *
 * Returns `{ argv, stdin, manual, cleanup() }`. Call `cleanup()` when the
 * step is over; it removes whatever temp files were written.
 *
 * @param {object} step a plan step
 * @param {object} [options]
 * @param {string} [options.tmpDir] write the materialised files here instead of a fresh temp dir
 */
export function materializeCommand(step, { tmpDir } = {}) {
  const command = planToCommand(step);
  if (command.manual) return { ...command, cleanup: () => {} };
  const written = [];
  let argv = command.argv;
  for (const file of command.files) {
    // The pid in the name is what lets packages/tools/dev/heavy.sh tell a live step dir from a dead one (#414).
    const dir = tmpDir || fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', `construct-step-${process.pid}-`));
    const target = path.join(dir, `${file.arg}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(file.value, null, 2)}\n`);
    written.push({ target, dir: tmpDir ? null : dir });
    argv = argv.map((a) => (a === file.placeholder ? target : a));
  }
  return {
    ...command,
    argv,
    cleanup() {
      for (const { target, dir } of written) {
        try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
        if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      }
    },
  };
}

/**
 * Create an engine over one process store.
 *
 * @returns {object} The engine: `start`, `pause`, `resume`, `cancel` and `retry` by process id, `settled(id)`, `runningIds()`, plus `store` and `maxConcurrent`.
 * @throws {TypeError} When `store` or `executeStep` is missing.
 * @typedef {(shadowRoot: string) => { violations: any[], ok: boolean }} ValidateFn
 * @param {object} [options]
 * @param {any} [options.store]            an `openProcessStore()` result; every state change is persisted
 * @param {(context: any) => Promise<any>} [options.executeStep] `async ({ process, step, status, command, transaction, projectRoot, log, signal }) => { ok, llm, artifacts?, error? }`
 *                                         — #291 supplies this. `llm` is required in the result:
 *                                         `null` for "no model was involved", `{ provider, calls }` otherwise.
 * @param {number} [options.maxConcurrent] processes running at once when `lanes` is not given. Default 1.
 * @param {{read?: number, write?: number}} [options.lanes] (#417) split the one slot queue into two —
 *                                         `read` for `review.analyze`/`test.run` (never blocked by a
 *                                         running bot plan) and `write` for everything else (bot plans;
 *                                         parallel writers in one tree still collide, so this stays 1
 *                                         unless told otherwise). Omit `lanes` to keep the single-queue
 *                                         behaviour keyed by `maxConcurrent` exactly as before. The write
 *                                         lane is ALSO capped box-wide (`CONSTRUCT_BOT_CONCURRENCY`,
 *                                         module-level, shared by every engine in this process) so N open
 *                                         projects cannot mean N concurrent bots.
 * @param {(record: any) => 'read'|'write'} [options.laneOf] required with `lanes`: which lane a queued
 *                                         process belongs in, decided from its own record (e.g. its
 *                                         steps' `flow`). Anything not recognised falls back to `write`,
 *                                         the more conservative lane.
 * @param {(record: any) => void} [options.onChange] called with every persisted process record — the seam #292's
 *                                         WebSocket streams from, so the engine needs no socket of its own.
 * @param {ValidateFn} [options.validate] passed to `transaction.commit()`; defaults to the writer's own
 *                                         `validateArchitecture`.
 * @param {() => string} [options.now]    clock, injected for deterministic tests.
 */
export function createProcessEngine({ store, executeStep, maxConcurrent = 1, lanes = null, laneOf = null, onChange = null, validate, now = defaultNow } = {}) {
  if (!store) throw new TypeError('createProcessEngine() needs a store (see openProcessStore()).');
  if (typeof executeStep !== 'function') {
    throw new TypeError('createProcessEngine() needs an executeStep function — running a step is the runner\'s job (#291), not the runtime model\'s.');
  }

  // Lane caps, only when `lanes` is given — this is what keeps every existing single-queue caller
  // (this file's own `maxConcurrent` tests, any executeStep swap that never passes `lanes`) byte-for-byte
  // unchanged: no lanes object, no lane bookkeeping, no global semaphore involvement at all.
  const laneCaps = lanes ? {
    read: Number.isInteger(lanes.read) && lanes.read >= 1 ? lanes.read : 1,
    write: Number.isInteger(lanes.write) && lanes.write >= 1 ? lanes.write : 1,
  } : null;
  const laneOfRecord = (record) => (laneOf && laneOf(record) === 'read' ? 'read' : 'write');

  /** id -> { promise, abort, settled } for processes this engine is driving. */
  const running = new Map();
  const waiting = []; // legacy single-queue path (no `lanes`)
  const laneWaiting = laneCaps ? { read: [], write: [] } : null;
  const laneRunning = laneCaps ? { read: 0, write: 0 } : null;

  const persist = (record) => {
    const saved = store.save(record);
    if (onChange) onChange(saved);
    return saved;
  };

  /** Load the authoritative record. Control methods always re-read from the
   * store rather than trusting a caller's stale copy — a Cancel arriving
   * from an HTTP request must act on what is true now. */
  const current = (id) => {
    const record = store.load(id);
    if (!record) throw new Error(`No process "${id}" in ${store.dir}.`);
    return record;
  };

  function send(id, eventType, options = {}) {
    const result = applyEvent(current(id), eventType, { now, ...options });
    if (!result.accepted) return result;
    return { ...result, process: persist(result.process) };
  }

  async function runStep(record, signalHolder) {
    const status = nextRunnableStep(record);
    if (!status) return { record, done: true };
    const step = planStep(record, status.id);

    // A `user`-executor step is not something to execute — it is something to
    // wait for. The process pauses and the step sits in `awaiting-user`,
    // which is exactly why #291 needs a real `paused` state rather than a
    // boolean (see its "You steps" note).
    if (step.executor === 'user') {
      let next = startStep(record, status.id, { now });
      next = appendLog(next, {
        provenance: 'warn',
        message: `Waiting for you: ${step.title}${step.args?.instructions ? ` — ${step.args.instructions}` : ''}`,
        stepId: step.id,
        now,
      });
      next = { ...next, pendingControl: 'pause' };
      persist(next);
      const paused = applyEvent(next, 'PAUSE', { now, message: `Paused for a step only you can do: ${step.title}.` });
      const yielded = applyEvent(paused.process, 'YIELDED', { now, message: 'Paused, waiting for you.' });
      // discardStepTransaction would reset the step to `pending`; an
      // awaiting-user step must keep its status, so restore it.
      const restored = {
        ...yielded.process,
        steps: yielded.process.steps.map((s) => (s.id === step.id ? { ...s, status: 'awaiting-user', finishedAt: null } : s)),
        currentStepId: step.id,
      };
      return { record: persist(restored), done: true };
    }

    let working = startStep(record, status.id, { now });
    working = appendLog(working, {
      provenance: step.executor === 'local-model' ? 'llm' : 'ok',
      message: `Step ${step.id} started: ${step.title} (${step.flow}, ${step.executor}).`,
      stepId: step.id,
      now,
    });
    persist(working);

    const transaction = createTransaction(record.projectRoot);
    const command = materializeCommand(step);
    const collected = [];
    const logs = [];

    // Everything from here through the commit shares one catch (#415): a
    // throw from `transaction.commit()` (e.g. ENOSPC building the shadow
    // copy) is an engine-level failure exactly like a throwing `executeStep`,
    // and must fail the step the same way rather than escaping to
    // `pump().catch` with the transaction left dangling.
    try {
      const result = await executeStep({
        process: working,
        step,
        status: stepStatus(working, step.id),
        command,
        transaction,
        projectRoot: record.projectRoot,
        signal: signalHolder.controller.signal,
        log: (provenance, message, detail) => logs.push({ provenance, message, detail: detail ?? null }),
        artifact: (a) => collected.push(a),
      });
      command.cleanup();

      // Re-read rather than building on `working`: a pause or cancel may have
      // arrived from an HTTP request while the step was in flight, and writing
      // back a snapshot taken before it started would silently clobber it.
      // (Caught by the "pause is cooperative" test, which went straight to
      // `done` because the stale record still said `running.active`.)
      let next = applyLogs(current(record.id), logs, step.id);

      // Commit the step's staged writes, if it used the transaction. Nothing
      // has touched the tree before this line.
      const staged = transaction.pendingFiles();
      if (result?.ok !== false && staged.length) {
        const before = new Map(staged.map((rel) => [rel, readIfExists(path.join(record.projectRoot, rel))]));
        const after = new Map(staged.map((rel) => [rel, transaction.readFile(rel)]));
        const commit = transaction.commit(validate ? { validate } : undefined);
        if (!commit.committed) {
          next = failStep(next, step.id, {
            llm: result?.llm ?? null,
            error: `the step's changes did not validate, so nothing was written: ${commit.violations.length} violation(s)`,
            now,
          });
          next = appendLog(next, {
            provenance: 'warn',
            message: `Step ${step.id} produced a tree that does not validate; ${staged.length} staged file(s) were discarded and the project is untouched.`,
            stepId: step.id,
            detail: commit.violations.slice(0, 20),
            now,
          });
          return { record: persist(next), failed: true };
        }
        for (const rel of staged) {
          collected.push({ path: rel, change: before.get(rel) === undefined ? 'create' : 'modify', before: before.get(rel), after: after.get(rel) });
        }
      } else if (staged.length) {
        transaction.reset();
      }

      for (const a of [...collected, ...(result?.artifacts || [])]) {
        next = recordArtifact(next, { ...a, stepId: a.stepId ?? step.id, now });
      }

      if (result?.ok === false) {
        next = failStep(next, step.id, { llm: result.llm ?? null, error: result.error || 'step failed', now });
        next = appendLog(next, { provenance: 'warn', message: `Step ${step.id} failed: ${result.error || 'no reason given'}.`, stepId: step.id, now });
        return { record: persist(next), failed: true };
      }

      next = completeStep(next, step.id, { llm: result?.llm ?? null, now });
      next = appendLog(next, {
        provenance: result?.llm ? 'llm' : 'ok',
        message: `Step ${step.id} finished: ${step.title}.${result?.llm ? ` Model: ${result.llm.provider ?? 'unknown'} (${result.llm.calls ?? 0} call(s)) — review before trusting it.` : ''}`,
        stepId: step.id,
        now,
      });
      const settled = applyEvent(next, 'STEP_COMPLETED', { now });
      return { record: persist(settled.accepted ? settled.process : next) };
    } catch (e) {
      command.cleanup();
      transaction.reset();
      if (e instanceof StepAborted || signalHolder.controller.signal.aborted) {
        return { record: current(record.id), aborted: true };
      }
      let next = applyLogs(current(record.id), logs, step.id);
      next = failStep(next, step.id, { llm: llmOf(e), error: e.message, now });
      next = appendLog(next, { provenance: 'warn', message: `Step ${step.id} threw: ${e.message}`, stepId: step.id, now });
      return { record: persist(next), failed: true };
    }
  }

  function applyLogs(record, logs, stepId) {
    let next = record;
    for (const entry of logs) next = appendLog(next, { ...entry, stepId, now });
    return next;
  }

  async function loop(id) {
    const signalHolder = running.get(id);
    for (;;) {
      let record = current(id);
      if (isTerminal(record.state) || topLevelState(record.state) !== 'running') return record;

      // Control requested before this step: settle it here, at the boundary.
      if (record.pendingControl) {
        const yielded = applyEvent(record, 'YIELDED', { now, message: record.pendingControl === 'cancel' ? 'Cancelled.' : 'Paused.' });
        record = persist(yielded.accepted ? yielded.process : record);
        if (topLevelState(record.state) === 'cancelled') record = persist(skipRemaining(record, 'the process was cancelled'));
        return record;
      }

      const outcome = await runStep(record, signalHolder);
      if (outcome.done) {
        const after = persist(skipUnreachable(current(id)));
        if (topLevelState(after.state) !== 'running') return after; // a user step paused it
        const finished = applyEvent(after, 'FINISHED', { now, message: 'All steps finished.' });
        return persist(finished.accepted ? finished.process : after);
      }
      if (outcome.aborted) {
        const yielded = applyEvent(current(id), 'YIELDED', { now, message: 'Cancelled while a step was in flight; its staged changes were discarded and the project is untouched.' });
        let settled = persist(yielded.accepted ? yielded.process : current(id));
        if (topLevelState(settled.state) === 'cancelled') settled = persist(skipRemaining(settled, 'the process was cancelled'));
        return settled;
      }
      if (outcome.failed) {
        const failed = applyEvent(current(id), 'STEP_FAILED', { now, message: `Stopped: step ${outcome.record.currentStepId || ''} failed.`.replace('  ', ' ') });
        let settled = persist(failed.accepted ? failed.process : outcome.record);
        settled = persist(skipUnreachable(settled));
        return settled;
      }
    }
  }

  function skipRemaining(record, reason) {
    let next = record;
    for (const s of next.steps) {
      if (s.status === 'pending' || s.status === 'awaiting-user') next = skipStep(next, s.id, { reason, now });
    }
    return next;
  }

  function skipUnreachable(record) {
    let next = record;
    for (const s of unreachableSteps(next)) {
      next = skipStep(next, s.id, { reason: 'an earlier step it depends on did not finish', now });
    }
    return next;
  }

  /** Queue `id` to run, unless it is already running or already queued. Picks its lane (when this
   * engine has lanes) from `record` — the freshly-persisted process, never a stale caller copy. */
  function enqueue(id, record) {
    if (running.has(id)) return;
    if (laneCaps) {
      const lane = laneOfRecord(record);
      if (!laneWaiting[lane].includes(id)) laneWaiting[lane].push(id);
    } else if (!waiting.includes(id)) {
      waiting.push(id);
    }
  }

  /** Remove `id` from whichever queue it is sitting in (used by cancel). Returns whether it was found. */
  function dequeue(id) {
    const i = waiting.indexOf(id);
    if (i >= 0) { waiting.splice(i, 1); return true; }
    if (laneCaps) {
      for (const lane of ['read', 'write']) {
        const j = laneWaiting[lane].indexOf(id);
        if (j >= 0) { laneWaiting[lane].splice(j, 1); return true; }
      }
    }
    return false;
  }

  function isQueued(id) {
    return waiting.includes(id) || (laneCaps ? laneWaiting.read.includes(id) || laneWaiting.write.includes(id) : false);
  }

  function launch(id, lane) {
    const controller = new AbortController();
    const holder = { controller, lane };
    running.set(id, holder);
    if (laneCaps) {
      laneRunning[lane] += 1;
      if (lane === 'write') globalWriteLane.active += 1;
    }
    holder.promise = loop(id)
      .catch((e) => {
        // An engine-level failure (a full disk, an unwritable state dir, a
        // bug here) used to just log a line and leave `state` untouched —
        // which left the record saying `running`, with a live owner pid,
        // forever (#415). Apply a real STEP_FAILED instead, the same event
        // a step's own failure sends, so the process actually stops.
        let record;
        try {
          record = current(id);
        } catch { return null; } // the store itself is gone; nothing useful left to do
        const message = `The process runtime stopped this process: ${e.message}`;
        const failed = applyEvent({ ...record, error: e.message }, 'STEP_FAILED', { now, message });
        const patched = failed.accepted ? failed.process : { ...record, error: e.message };
        try {
          persist(patched);
        } catch {
          // The store would not even take the failure — plausibly the same
          // full disk that caused the original error. Nothing on disk, but
          // at least tell anyone watching live so the socket does not sit
          // on a stale "running" (the best-effort record is `patched`,
          // already carrying the failure message and log entry).
          if (onChange) onChange(patched);
        }
        return null;
      })
      .finally(() => {
        running.delete(id);
        if (laneCaps) {
          laneRunning[lane] -= 1;
          if (lane === 'write') {
            globalWriteLane.active -= 1;
            // A box-wide write slot just freed up: give every engine's queue (not only this one's) a
            // chance to claim it — that is the whole point of the semaphore being shared, not per-engine.
            for (const otherPump of globalWriteLane.pumps) otherPump();
            return; // this engine's own pump is IN globalWriteLane.pumps, so the loop above just called it too
          }
        }
        pump();
      });
  }

  function pump() {
    if (!laneCaps) {
      while (running.size < maxConcurrent && waiting.length) launch(waiting.shift(), null);
      return;
    }
    for (const lane of ['read', 'write']) {
      while (
        laneRunning[lane] < laneCaps[lane]
        && (lane !== 'write' || globalWriteLane.active < globalWriteLimit())
        && laneWaiting[lane].length
      ) {
        launch(laneWaiting[lane].shift(), lane);
      }
    }
  }
  if (laneCaps) globalWriteLane.pumps.add(pump);

  const engine = {
    store,
    maxConcurrent,

    /** Processes this engine is currently driving. */
    runningIds: () => [...running.keys()],

    /**
     * Queue a process and start it. Returns the record after the START event
     * (so `state` is already `running.active`); `await engine.settled(id)` to
     * wait for it to reach a rest state.
     */
    start(id) {
      const started = send(id, 'START', { message: 'Process started.' });
      if (!started.accepted) return started;
      enqueue(id, started.process);
      pump();
      return started;
    },

    /**
     * Ask a running process to pause. Cooperative: the step in flight is NOT
     * aborted — pausing should not throw away work that is nearly done — so
     * the process sits in `running.stopping` until the step yields, then
     * settles into `paused`. The state is honest about that the whole time.
     */
    pause(id) {
      return send(id, 'PAUSE', { message: 'Pause requested; finishing the step in flight first.' });
    },

    /** Resume a paused process from its next pending step. */
    resume(id) {
      const resumed = send(id, 'RESUME', { message: 'Resumed.' });
      if (!resumed.accepted) return resumed;
      enqueue(id, resumed.process);
      pump();
      return resumed;
    },

    /**
     * Cancel. Unlike pause, this aborts the step in flight immediately via
     * its `AbortSignal` — a cancelled step's staged writes are discarded and
     * the tree is untouched by it, so there is nothing to wait for and
     * nothing to undo. Steps that already committed stay committed and stay
     * in `artifacts`, still pending approval; reverting them is the user's
     * decision, not a side effect of pressing Cancel.
     */
    cancel(id) {
      const record = current(id);
      const asked = send(id, 'CANCEL', { message: 'Cancel requested.' });
      if (!asked.accepted) return asked;
      const holder = running.get(id);
      if (holder) {
        holder.controller.abort();
        return asked;
      }
      // Nothing in flight (queued, paused or failed): CANCEL settles at once.
      if (topLevelState(asked.process.state) === 'running') {
        const yielded = send(id, 'YIELDED', { message: 'Cancelled.' });
        const settled = yielded.accepted ? yielded.process : asked.process;
        return { process: persist(skipRemaining(settled, 'the process was cancelled')), accepted: true, error: null };
      }
      dequeue(id);
      void record;
      return { ...asked, process: persist(skipRemaining(asked.process, 'the process was cancelled')) };
    },

    /** Retry a failed process: its failed step goes back to `pending`, along
     * with everything that was skipped because of it, and the loop resumes
     * from there. Completed steps are not re-run. */
    retry(id) {
      const record = current(id);
      const reset = {
        ...record,
        steps: record.steps.map((s) => (s.status === 'failed' || s.status === 'skipped' ? { ...s, status: 'pending', error: null, finishedAt: null } : s)),
      };
      const saved = persist(reset);
      const retried = applyEvent(saved, 'RETRY', { now, message: 'Retrying from the step that failed.' });
      if (!retried.accepted) return retried;
      const out = persist(retried.process);
      enqueue(id, out);
      pump();
      return { process: out, accepted: true, error: null };
    },

    /** Resolve once the process is no longer being driven — it reached
     * `done`, `failed`, `cancelled`, or `paused`. Returns the final record. */
    async settled(id) {
      for (let i = 0; i < 10000; i += 1) {
        const holder = running.get(id);
        if (!holder) {
          if (!isQueued(id)) return current(id);
          await new Promise((r) => setImmediate(r));
          continue;
        }
        await holder.promise;
      }
      return current(id);
    },
  };

  return engine;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function llmOf(e) {
  return e && typeof e === 'object' && e.llm !== undefined ? e.llm : null;
}
