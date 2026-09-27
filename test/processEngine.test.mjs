// #287 — the driver's control semantics, proven rather than described.
//
// The things worth failing a build over, in order:
//  1. cancelling mid-step leaves the project tree completely untouched by
//     that step, and does NOT undo the steps that already committed;
//  2. every step records whether a model was involved, and a deterministic
//     step runs with no model reachable at all;
//  3. a step whose output does not validate writes nothing;
//  4. a process survives the server that was running it being killed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../test-utils/tmpdir.mjs';
import { createProcess } from '../packages/engine/processModel.mjs';
import { openProcessStore } from '../packages/engine/processStore.mjs';
import { createProcessEngine, materializeCommand, StepAborted } from '../packages/engine/processEngine.mjs';
import { validateArchitecture } from '../packages/core/architecture-enforcer.mjs';

/** A clock that ticks one second per call, so every assertion about
 * timestamps and ordering is exact rather than flaky. */
function fakeClock(start = Date.UTC(2026, 8, 20, 12, 0, 0)) {
  let t = start;
  return () => {
    const at = new Date(t).toISOString();
    t += 1000;
    return at;
  };
}

const touching = (file) => ({ features: ['checkout'], files: [{ path: file, change: 'create' }] });

const THREE_STEP_PLAN = {
  version: 1,
  ticket: { source: 'text', title: 'Add totals to checkout' },
  steps: [
    {
      id: 'feature',
      title: 'Create the checkout feature',
      flow: 'create.feature',
      args: { name: 'checkout' },
      executor: 'deterministic',
      touches: touching('features/checkout/index.ts'),
    },
    {
      id: 'domain',
      title: 'Scaffold the Total domain unit',
      flow: 'create.unit',
      args: { layer: 'domain', name: 'Total', feature: 'checkout' },
      executor: 'deterministic',
      dependsOn: ['feature'],
      touches: touching('features/checkout/domain/Total.ts'),
    },
    {
      id: 'fill',
      title: 'Write the totals logic with a local model',
      flow: 'create.unit',
      args: { layer: 'service', name: 'Totals', feature: 'checkout', llm: 'ollama' },
      executor: 'local-model',
      dependsOn: ['domain'],
      touches: touching('features/checkout/services/Totals.ts'),
    },
  ],
};

const FILE_FOR = {
  feature: 'features/checkout/index.ts',
  domain: 'features/checkout/domain/Total.ts',
  fill: 'features/checkout/services/Totals.ts',
};

function harness({ plan = THREE_STEP_PLAN, executeStep, validate, maxConcurrent = 1, id = 'p1' } = {}) {
  const projectRoot = makeTempDir('construct-proc-project-');
  const stateDir = makeTempDir('construct-proc-state-');
  fs.mkdirSync(path.join(projectRoot, 'features', 'checkout'), { recursive: true });
  const now = fakeClock();
  const store = openProcessStore(projectRoot, { stateDir, now });
  const record = store.save(createProcess(plan, { id, projectRoot, now }));
  const changes = [];
  const engine = createProcessEngine({
    store,
    executeStep,
    maxConcurrent,
    validate: validate ?? (() => ({ violations: [], ok: true })),
    now,
    onChange: (p) => changes.push(p),
  });
  return { projectRoot, stateDir, store, engine, record, changes, now };
}

/** The ordinary executor: stages the file the step says it touches into the
 * transaction the engine handed it, and reports its own model involvement. */
const writingExecutor = async ({ step, transaction }) => {
  transaction.writeFile(FILE_FOR[step.id], `// ${step.id}\nexport const ${step.id} = true;\n`);
  return { ok: true, llm: step.executor === 'local-model' ? { provider: 'ollama', calls: 1 } : null };
};

test('a plan runs to done: every step lands, artifacts are collected, and each step records whether a model was involved', async () => {
  const { engine, projectRoot } = harness({ executeStep: writingExecutor });

  engine.start('p1');
  const done = await engine.settled('p1');

  assert.equal(done.state, 'done');
  assert.deepEqual(done.steps.map((s) => s.status), ['done', 'done', 'done']);
  assert.equal(done.finishedAt !== null, true);

  // Every file actually landed on disk.
  for (const rel of Object.values(FILE_FOR)) {
    assert.equal(fs.existsSync(path.join(projectRoot, rel)), true, `${rel} should exist`);
  }

  // Artifacts: one per file, hashed, all still awaiting approval.
  assert.deepEqual(done.artifacts.map((a) => a.path).sort(), Object.values(FILE_FOR).sort());
  assert.equal(done.artifacts.every((a) => a.change === 'create'), true);
  assert.equal(done.artifacts.every((a) => typeof a.after.sha256 === 'string' && a.after.sha256.length === 64), true);
  assert.equal(done.artifacts.every((a) => a.approved === null), true, 'collected, not accepted — the approval gate is a separate decision');

  // The Vision-level property: "was a model involved?" is answerable per step.
  assert.deepEqual(done.steps.map((s) => (s.llm ? s.llm.provider : null)), [null, null, 'ollama']);
});

test('log provenance: deterministic work is ok, model work is llm, and filtering to llm finds every model-touched line', async () => {
  const { engine } = harness({ executeStep: writingExecutor });
  engine.start('p1');
  const done = await engine.settled('p1');

  const provenances = new Set(done.log.map((e) => e.provenance));
  assert.equal([...provenances].every((p) => ['ok', 'llm', 'warn'].includes(p)), true);

  const modelLines = done.log.filter((e) => e.provenance === 'llm');
  assert.equal(modelLines.length > 0, true);
  assert.equal(modelLines.every((e) => e.stepId === 'fill'), true, 'only the local-model step may produce llm lines');
  assert.equal(
    done.log.filter((e) => e.provenance === 'ok' && e.stepId === 'fill').length,
    0,
    'a model step must never be logged as plain deterministic work',
  );
  // Every entry carries a monotonic sequence number, so a UI can stream.
  assert.deepEqual(done.log.map((e) => e.seq), done.log.map((_, i) => i + 1));
});

test('deterministic steps run with no model available at all', async () => {
  const deterministicOnly = {
    ...THREE_STEP_PLAN,
    steps: THREE_STEP_PLAN.steps.filter((s) => s.executor === 'deterministic'),
  };
  const { engine } = harness({
    plan: deterministicOnly,
    executeStep: async (ctx) => {
      // Nothing about a deterministic step may mention a model: not the plan
      // step, not the command the engine derived from it.
      assert.equal(ctx.step.args.llm, undefined);
      assert.equal(ctx.command.argv.includes('--llm'), false);
      ctx.transaction.writeFile(FILE_FOR[ctx.step.id], 'export const x = 1;\n');
      return { ok: true, llm: null };
    },
  });

  engine.start('p1');
  const done = await engine.settled('p1');

  assert.equal(done.state, 'done');
  assert.equal(done.steps.every((s) => s.llm === null), true);
  assert.equal(done.log.some((e) => e.provenance === 'llm'), false, 'a deterministic plan must produce no llm provenance anywhere');
});

test('cancel mid-step: the in-flight step writes nothing, already-committed steps are kept, and the rest are skipped', async () => {
  let releaseSecondStep;
  const blocked = new Promise((resolve) => { releaseSecondStep = resolve; });
  let sawAbort = false;

  const { engine, projectRoot } = harness({
    executeStep: async ({ step, transaction, signal }) => {
      transaction.writeFile(FILE_FOR[step.id], `// ${step.id}\n`);
      if (step.id !== 'domain') return { ok: true, llm: null };
      // Step 2 hangs until cancelled, the way a real long command would.
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { sawAbort = true; reject(new StepAborted(step.id)); });
        blocked.then(resolve);
      });
      return { ok: true, llm: null };
    },
  });

  engine.start('p1');
  await new Promise((r) => setTimeout(r, 20)); // let step 1 commit and step 2 begin

  const cancelled = engine.cancel('p1');
  assert.equal(cancelled.accepted, true);
  const final = await engine.settled('p1');
  releaseSecondStep();

  assert.equal(sawAbort, true, 'cancel aborts the step in flight rather than waiting for it');
  assert.equal(final.state, 'cancelled');

  // The step that was in flight wrote NOTHING — there is nothing to roll back.
  assert.equal(fs.existsSync(path.join(projectRoot, FILE_FOR.domain)), false);
  assert.equal(final.steps.find((s) => s.id === 'domain').status, 'skipped');

  // The step that already committed is NOT undone: cancel stops, it does not
  // reverse work the user watched land.
  assert.equal(fs.existsSync(path.join(projectRoot, FILE_FOR.feature)), true);
  assert.equal(final.steps.find((s) => s.id === 'feature').status, 'done');
  assert.deepEqual(final.artifacts.map((a) => a.path), [FILE_FOR.feature]);
  assert.equal(final.artifacts[0].approved, null, 'kept for review, not silently accepted');

  // A step never reached is skipped, not left pending forever.
  assert.equal(final.steps.find((s) => s.id === 'fill').status, 'skipped');
});

test('pause is cooperative: the step in flight finishes and commits, then the process settles in paused and can resume', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });

  const { engine, projectRoot, store } = harness({
    executeStep: async ({ step, transaction }) => {
      transaction.writeFile(FILE_FOR[step.id], `// ${step.id}\n`);
      if (step.id === 'domain') await blocked;
      return { ok: true, llm: step.executor === 'local-model' ? { provider: 'ollama', calls: 1 } : null };
    },
  });

  engine.start('p1');
  await new Promise((r) => setTimeout(r, 20));

  const paused = engine.pause('p1');
  assert.equal(paused.accepted, true);
  assert.equal(paused.process.state, 'running.stopping', 'honest about winding down rather than claiming paused while a step still runs');
  assert.equal(paused.process.pendingControl, 'pause');

  release();
  const settled = await engine.settled('p1');
  assert.equal(settled.state, 'paused');
  // Unlike cancel, the step that was in flight kept its committed work.
  assert.equal(fs.existsSync(path.join(projectRoot, FILE_FOR.domain)), true);
  assert.equal(settled.steps.find((s) => s.id === 'domain').status, 'done');
  assert.equal(settled.steps.find((s) => s.id === 'fill').status, 'pending');

  engine.resume('p1');
  const done = await engine.settled('p1');
  assert.equal(done.state, 'done');
  assert.equal(store.load('p1').state, 'done');
});

test('a failing step fails the process, skips what depended on it, and retry re-runs only what is left', async () => {
  let failOnce = true;
  const { engine, projectRoot } = harness({
    executeStep: async ({ step, transaction }) => {
      if (step.id === 'domain' && failOnce) {
        transaction.writeFile(FILE_FOR[step.id], 'half a file\n');
        return { ok: false, llm: null, error: 'the generator blew up' };
      }
      transaction.writeFile(FILE_FOR[step.id], `// ${step.id}\n`);
      return { ok: true, llm: step.executor === 'local-model' ? { provider: 'ollama', calls: 2 } : null };
    },
  });

  engine.start('p1');
  const failed = await engine.settled('p1');

  assert.equal(failed.state, 'failed');
  assert.equal(failed.steps.find((s) => s.id === 'domain').status, 'failed');
  assert.equal(failed.steps.find((s) => s.id === 'domain').error, 'the generator blew up');
  assert.equal(failed.steps.find((s) => s.id === 'fill').status, 'skipped', 'a step whose dependency failed is skipped, not left pending forever');
  assert.equal(fs.existsSync(path.join(projectRoot, FILE_FOR.domain)), false, 'a failed step commits nothing');
  assert.equal(failed.log.some((e) => e.provenance === 'warn' && e.stepId === 'domain'), true);
  // Even a failed step records whether a model was involved.
  assert.equal(failed.steps.find((s) => s.id === 'domain').llm, null);

  failOnce = false;
  engine.retry('p1');
  const done = await engine.settled('p1');

  assert.equal(done.state, 'done');
  assert.equal(done.steps.find((s) => s.id === 'feature').attempts, 1, 'a completed step is not re-run by retry');
  assert.equal(done.steps.find((s) => s.id === 'domain').attempts, 2);
  assert.equal(done.steps.find((s) => s.id === 'fill').llm.calls, 2);
});

test('a step whose output does not validate writes nothing and fails, using the real architecture enforcer', async () => {
  const plan = {
    version: 1,
    ticket: { source: 'text', title: 'Add a page that calls fetch directly' },
    steps: [{
      id: 'bad',
      title: 'Write a page that fetches',
      flow: 'create.unit',
      args: { layer: 'pages', name: 'CheckoutPage', feature: 'checkout' },
      executor: 'deterministic',
      touches: touching('features/checkout/pages/CheckoutPage.tsx'),
    }],
  };
  const { engine, projectRoot } = harness({
    plan,
    validate: validateArchitecture, // the real one, not a stub
    executeStep: async ({ transaction }) => {
      // PAGE-004: a page may not call fetch() itself.
      transaction.writeFile('features/checkout/pages/CheckoutPage.tsx', "export function CheckoutPage(){ fetch('/api'); return null; }\n");
      return { ok: true, llm: null };
    },
  });

  engine.start('p1');
  const failed = await engine.settled('p1');

  assert.equal(failed.state, 'failed');
  assert.equal(fs.existsSync(path.join(projectRoot, 'features/checkout/pages/CheckoutPage.tsx')), false);
  assert.match(failed.steps[0].error, /did not validate/);
  assert.deepEqual(failed.artifacts, [], 'nothing was written, so there is no artifact to review');
});

test('a "you" step pauses the process and waits, rather than being executed', async () => {
  const plan = {
    version: 1,
    ticket: { source: 'text', title: 'Review what the model wrote' },
    steps: [
      { id: 'auto', title: 'Scaffold it', flow: 'create.feature', args: { name: 'checkout' }, executor: 'deterministic', touches: touching(FILE_FOR.feature) },
      {
        id: 'review',
        title: 'Review the generated file',
        flow: 'manual.task',
        args: { instructions: 'Read features/checkout/index.ts and approve it.' },
        executor: 'user',
        dependsOn: ['auto'],
        touches: { features: [], files: [] },
      },
    ],
  };
  let executed = 0;
  const { engine } = harness({
    plan,
    executeStep: async ({ step, transaction }) => {
      executed += 1;
      transaction.writeFile(FILE_FOR.feature, `// ${step.id}\n`);
      return { ok: true, llm: null };
    },
  });

  engine.start('p1');
  const paused = await engine.settled('p1');

  assert.equal(executed, 1, 'the runner never executes a step that is a person\'s job');
  assert.equal(paused.state, 'paused');
  assert.equal(paused.steps.find((s) => s.id === 'review').status, 'awaiting-user');
  assert.equal(paused.currentStepId, 'review');
  assert.equal(
    paused.log.some((e) => e.provenance === 'warn' && String(e.message).includes('Read features/checkout/index.ts')),
    true,
    'the instructions reach the log a person actually reads',
  );
});

test('control is refused by name rather than silently ignored', async () => {
  const { engine } = harness({ executeStep: writingExecutor });

  const resumed = engine.resume('p1');
  assert.equal(resumed.accepted, false);
  assert.equal(resumed.error.code, 'EVENT_REJECTED');
  assert.match(resumed.error.message, /does not accept "RESUME"/);
  assert.match(resumed.error.message, /Accepted here: START, CANCEL/);

  engine.start('p1');
  await engine.settled('p1');
  const pausedAfterDone = engine.pause('p1');
  assert.equal(pausedAfterDone.accepted, false);
  assert.match(pausedAfterDone.error.message, /it is finished/);
});

test('cancelling a queued process settles immediately and skips every step', async () => {
  const { engine } = harness({ executeStep: writingExecutor });
  const cancelled = engine.cancel('p1');
  assert.equal(cancelled.accepted, true);
  assert.equal(cancelled.process.state, 'cancelled');
  assert.equal(cancelled.process.steps.every((s) => s.status === 'skipped'), true);
});

test('onChange sees every persisted state change, in order — the seam a live log streams from', async () => {
  const { engine, changes } = harness({ executeStep: writingExecutor });
  engine.start('p1');
  await engine.settled('p1');

  assert.equal(changes.length > 6, true);
  assert.equal(changes[changes.length - 1].state, 'done');
  // Monotonic: a subscriber can rely on never seeing the log go backwards.
  const seqs = changes.map((c) => c.logSeq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test('maxConcurrent serialises processes: the second waits for the first', async () => {
  const projectRoot = makeTempDir('construct-proc-conc-');
  const stateDir = makeTempDir('construct-proc-conc-state-');
  fs.mkdirSync(path.join(projectRoot, 'features', 'checkout'), { recursive: true });
  const now = fakeClock();
  const store = openProcessStore(projectRoot, { stateDir, now });
  const onePlan = {
    version: 1,
    ticket: { source: 'text', title: 'one step' },
    steps: [{ id: 'feature', title: 'Create it', flow: 'create.feature', args: { name: 'checkout' }, executor: 'deterministic', touches: touching(FILE_FOR.feature) }],
  };
  store.save(createProcess(onePlan, { id: 'a', projectRoot, now }));
  store.save(createProcess(onePlan, { id: 'b', projectRoot, now }));

  let concurrent = 0;
  let peak = 0;
  const engine = createProcessEngine({
    store,
    maxConcurrent: 1,
    validate: () => ({ violations: [], ok: true }),
    now,
    executeStep: async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
      return { ok: true, llm: null };
    },
  });

  engine.start('a');
  engine.start('b');
  await engine.settled('a');
  await engine.settled('b');

  assert.equal(peak, 1, 'one plan at a time per project, because parallel writers in one tree collide');
  assert.equal(store.load('a').state, 'done');
  assert.equal(store.load('b').state, 'done');
});

test('#417: an analysis (read lane) starts and finishes while a plan (write lane) is running, rather than queuing behind it', async () => {
  const projectRoot = makeTempDir('construct-lanes-project-');
  const stateDir = makeTempDir('construct-lanes-state-');
  fs.mkdirSync(path.join(projectRoot, 'features', 'checkout'), { recursive: true });
  const now = fakeClock();
  const store = openProcessStore(projectRoot, { stateDir, now });

  const plan = {
    version: 1,
    ticket: { source: 'text', title: 'A bot plan' },
    steps: [{ id: 'feature', title: 'Create it', flow: 'create.feature', args: { name: 'checkout' }, executor: 'deterministic', touches: touching(FILE_FOR.feature) }],
  };
  // Shaped exactly like reviewAnalyses.mjs's real analysisPlan(): one step, flow `review.analyze`, no `touches`.
  const analysis = {
    version: 1,
    ticket: { source: 'text', title: 'Review analysis' },
    steps: [{ id: 'analyse', title: 'Analyse', flow: 'review.analyze', executor: 'deterministic', args: { base: 'a'.repeat(40), head: 'b'.repeat(40) } }],
  };
  store.save(createProcess(plan, { id: 'plan', projectRoot, now }));
  store.save(createProcess(analysis, { id: 'analysis', projectRoot, now }));

  let releasePlan;
  const blocked = new Promise((resolve) => { releasePlan = resolve; });
  let analysisRan = false;

  // Mirrors `laneOf` in ui/server/src/processesService.mjs: every step `review.analyze`/`test.run` -> read, else write.
  const laneOf = (record) => (record.steps.every((s) => s.flow === 'review.analyze' || s.flow === 'test.run') ? 'read' : 'write');

  const engine = createProcessEngine({
    store,
    now,
    validate: () => ({ violations: [], ok: true }),
    lanes: { write: 1, read: 1 },
    laneOf,
    executeStep: async ({ step, transaction }) => {
      if (step.flow === 'review.analyze') {
        analysisRan = true;
        return { ok: true, llm: null, artifacts: [] };
      }
      transaction.writeFile(FILE_FOR.feature, '// plan\n');
      await blocked; // the write-lane step hangs until the test releases it
      return { ok: true, llm: null };
    },
  });

  engine.start('plan');
  await new Promise((r) => setTimeout(r, 15)); // let the plan's step actually start (and hang)

  engine.start('analysis');
  const doneAnalysis = await engine.settled('analysis');

  assert.equal(analysisRan, true, 'the analysis step ran');
  assert.equal(doneAnalysis.state, 'done', 'the analysis finished without waiting for the write-lane plan');
  assert.equal(store.load('plan').state, 'running.active', 'the plan is still mid-step: the analysis neither waited for it nor interrupted it');

  releasePlan();
  const donePlan = await engine.settled('plan');
  assert.equal(donePlan.state, 'done');
});

test('#417: the box-wide write-lane semaphore stops two projects from running two bots at the same time', async () => {
  const prevEnv = process.env.CONSTRUCT_BOT_CONCURRENCY;
  process.env.CONSTRUCT_BOT_CONCURRENCY = '1';
  try {
    const laneOf = () => 'write'; // every step in this test is a bot plan
    const onePlan = (title) => ({
      version: 1,
      ticket: { source: 'text', title },
      steps: [{ id: 'feature', title: 'Create it', flow: 'create.feature', args: { name: 'checkout' }, executor: 'deterministic', touches: touching(FILE_FOR.feature) }],
    });

    let concurrent = 0;
    let peak = 0;
    const executeStep = async ({ step, transaction }) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      transaction.writeFile(FILE_FOR[step.id], `// ${step.id}\n`);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      return { ok: true, llm: null };
    };

    function projectEngine(label) {
      const projectRoot = makeTempDir(`construct-lanes-global-${label}-`);
      const stateDir = makeTempDir(`construct-lanes-global-${label}-state-`);
      fs.mkdirSync(path.join(projectRoot, 'features', 'checkout'), { recursive: true });
      const now = fakeClock();
      const store = openProcessStore(projectRoot, { stateDir, now });
      store.save(createProcess(onePlan(`project ${label}`), { id: 'bot', projectRoot, now }));
      const engine = createProcessEngine({
        store,
        now,
        executeStep,
        validate: () => ({ violations: [], ok: true }),
        lanes: { write: 1, read: 1 }, // each project's OWN cap already allows only 1 — the point of this test is the cap ACROSS projects
        laneOf,
      });
      return { engine, store };
    }

    const a = projectEngine('a');
    const b = projectEngine('b');

    a.engine.start('bot');
    b.engine.start('bot');
    await Promise.all([a.engine.settled('bot'), b.engine.settled('bot')]);

    assert.equal(peak, 1, 'two engines for two different projects must not run a write-lane bot at the same time when the global cap is 1');
    assert.equal(a.store.load('bot').state, 'done');
    assert.equal(b.store.load('bot').state, 'done');
  } finally {
    if (prevEnv === undefined) delete process.env.CONSTRUCT_BOT_CONCURRENCY;
    else process.env.CONSTRUCT_BOT_CONCURRENCY = prevEnv;
  }
});

test('materializeCommand turns an import.plan step into a real runnable command with its plan on disk', () => {
  const step = {
    id: 'import',
    title: 'Run the import plan',
    flow: 'import.plan',
    args: { plan: { feature: 'checkout', units: [{ name: 'Totals', layers: ['domain'], from: 'legacy/totals.ts' }] } },
    executor: 'deterministic',
    touches: { features: ['checkout'], files: [] },
  };
  const command = materializeCommand(step);
  try {
    const planFileIndex = command.argv.indexOf('--plan') + 1;
    const planFile = command.argv[planFileIndex];
    assert.equal(command.argv.includes('{{plan}}'), false, 'the placeholder is replaced by a real path');
    assert.equal(fs.existsSync(planFile), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(planFile, 'utf8')).feature, 'checkout');
  } finally {
    command.cleanup();
  }
});
