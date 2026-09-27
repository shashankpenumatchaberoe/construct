// #623 -- the proof of a shaped screen: the generator (proofFiles, proofTouches, generateProof), the runner (runProofs, readTap,
// classifyProofFailure), the chain state (proofStatus, proofSummary), the plan flows (`create.proof`, `test.proof`) and the plan
// steps a shaped chain ends with. The whole chain from a sentence, run for real, is test/list-shape-chain.test.mjs.
// The Playwright flow is written only when the project already has a Playwright config; running it in a real browser needs
// CONSTRUCT_RUN_PLAYWRIGHT=1 (ui/e2e node_modules + chromium), like test/testGeneratorPlaywright.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequirement } from '../packages/core/requirement-card.mjs';
import { placeCard, planFromBlocks } from '../packages/core/placement.mjs';
import { PLAN_FLOWS, PLAN_PROOF_KINDS, planToCommand, planTouches, validatePlan } from '../packages/core/plan.mjs';
import { PROOF_KINDS, PROOF_SUMMARY_LIMITS, detectPlaywright, generateProof, proofFiles, proofStatus, proofSummary, proofTouches } from '../packages/core/proof.mjs';
import { expectedFiles } from '../packages/core/plan-touches.mjs';
import { classifyProofFailure, readTap, renderProofRunText, runProofs } from '../packages/engine/proofRunner.mjs';
import { GENERATED_MARKER } from '../packages/engine/testGenerator.mjs';
import { resolveSpecs, runFeatureTests } from '../packages/engine/testRunner.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(REPO, 'packages', 'cli', 'construct.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd });
const FIELDS = 'id:string,name:string,price:number';
const REQUEST = { name: 'Products', feature: 'products', entity: 'Product', fields: FIELDS };
const firstExisting = (...candidates) => candidates.find((p) => fs.existsSync(p));

/** react, react-dom and esbuild are needed to RUN a proof: a CI lane with only the root install has no react-dom (it lives in ui/client), so those tests skip there with a reason. */
const HAVE_RUNTIME = ['react', 'react-dom', 'esbuild', '@esbuild'].every((n) => firstExisting(path.join(REPO, 'node_modules', n), path.join(REPO, 'ui', 'client', 'node_modules', n)));
const NEEDS_RUNTIME = { skip: HAVE_RUNTIME ? false : 'react, react-dom and esbuild are not installed here (a lane with only the root install); the full checkout runs this' };

/** An init project with a `products` feature holding the list shape; nothing linked unless `link` (the proof needs react, react-dom, esbuild to RUN). */
function project({ link = false, playwright = false } = {}) {
  const dir = makeTempDir('construct-proof-');
  assert.equal(run(['init', '--framework', 'react-spa'], dir).status, 0);
  assert.equal(run(['create', 'feature', 'products'], dir).status, 0);
  const layers = run(['create', 'layer', 'Products', '--feature', 'products', '--layers', 'domain,service,hook,component,page,controller', '--shape', 'list', '--entity', 'Product', '--fields', FIELDS], dir);
  assert.equal(layers.status, 0, layers.stderr);
  if (playwright) fs.writeFileSync(path.join(dir, 'playwright.config.ts'), "export default { testDir: 'features' };\n");
  if (link) {
    const modules = path.join(dir, 'node_modules');
    fs.mkdirSync(path.join(modules, '@line'), { recursive: true });
    const at = (name) => firstExisting(path.join(REPO, 'node_modules', name), path.join(REPO, 'ui', 'client', 'node_modules', name));
    for (const name of ['react', 'react-dom', 'esbuild', '@esbuild']) fs.symlinkSync(at(name), path.join(modules, name));
    fs.symlinkSync(path.join(REPO, 'packages', 'core'), path.join(modules, '@line', 'construct-core'));
  }
  return dir;
}

const cardOf = (sentence) => parseRequirement(sentence).card;
const planIn = (dir, options = {}) => {
  const card = cardOf('A user wants to see a list of products');
  const placed = placeCard(card, { framework: 'react-spa', answers: { 'q-shape': { option: 'list', by: 'person' } } });
  // #621: these tests are about the endpoint source (a fetch to mock, a browser flow), so they answer q-source as such; the default is local.
  return planFromBlocks(placed.blocks, { feature: 'products', root: dir, decisions: placed.decisions, ...options, answers: { 'q-source': 'endpoint', ...options.answers } });
};

test('the plan flows: create.proof and test.proof are registered, typed, and their kinds match the generator', () => {
  assert.deepEqual([...PLAN_PROOF_KINDS], [...PROOF_KINDS]);
  const create = PLAN_FLOWS['create.proof'];
  assert.equal(create.writes, true);
  assert.deepEqual(create.executors, ['deterministic', 'user'], 'no model in a proof');
  assert.deepEqual(Object.keys(create.args), ['name', 'feature', 'shape', 'entity', 'fields', 'steps', 'states', 'source', 'kind', 'route', 'dir']);
  const verify = PLAN_FLOWS['test.proof'];
  assert.equal(verify.writes, false, 'the verification is read-only');
  assert.deepEqual(verify.executors, ['deterministic']);
  assert.deepEqual(planToCommand({ flow: 'create.proof', args: { ...REQUEST, shape: 'list', kind: 'render' } }).argv, ['create', 'proof', 'Products', '--feature', 'products', '--shape', 'list', '--entity', 'Product', '--fields', FIELDS, '--kind', 'render']);
  assert.deepEqual(planToCommand({ flow: 'test.proof', args: { feature: 'products', name: 'ProductsScreen.proof.test.ts' } }).argv, ['test', 'proof', 'products', '--name', 'ProductsScreen.proof.test.ts']);
  const step = (flow, args) => validatePlan({ version: 1, ticket: { source: 'text', title: 't' }, steps: [{ id: 's1', title: 'x', flow, args, executor: 'deterministic', ...(flow === 'create.proof' ? { touches: { features: [], files: [] } } : {}) }] }).errors.map((e) => e.code);
  assert.deepEqual(step('create.proof', { name: 'Products', feature: 'products', kind: 'browser' }), ['STEP_ARG_ENUM']);
  assert.deepEqual(step('create.proof', { name: 'Products', feature: '../x' }), ['STEP_ARG_TYPE']);
  assert.deepEqual(step('test.proof', { feature: 'products', name: 'a/b.proof.test.ts' }), ['STEP_ARG_TYPE']);
  assert.deepEqual(step('test.proof', { feature: 'products' }), []);
});

test('proofFiles is pure and deterministic: the same request is the same bytes, and nothing is written', () => {
  const dir = project();
  const before = fs.readdirSync(path.join(dir, 'features', 'products'), { recursive: true }).sort();
  const [file] = proofFiles(dir, REQUEST);
  assert.equal(path.relative(dir, file.path), 'features/products/tests/generated/ProductsScreen.proof.test.ts', 'Name.layer.ext (READ-004), in the generated-test region');
  assert.equal(file.content, proofFiles(dir, REQUEST)[0].content);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'features', 'products'), { recursive: true }).sort(), before);
  assert.ok(file.content.startsWith(`${GENERATED_MARKER}\n`));
  // Every field value of the sample rows is asserted by its exact markup; a boolean and a second string field appear too.
  const richer = proofFiles(dir, { name: 'Orders', feature: 'products', entity: 'Order', fields: 'id:number,title:string,isPaid:boolean,total:number,note:string' })[0].content;
  for (const want of ['{ id: 1, title: "Order title 1", isPaid: true, total: 12.5, note: "Order note 1" }', '"<strong>Order title 1</strong>", "<span>isPaid: true</span>", "<span>total: 12.5</span>", "<span>note: Order note 1</span>"', "Loading orders...", 'No orders yet.']) assert.ok(richer.includes(want), want);
  assert.throws(() => proofFiles(dir, { ...REQUEST, kind: 'video' }), /Unknown proof kind "video"/);
  assert.throws(() => proofFiles(dir, { ...REQUEST, fields: 'name:string' }), /"id" field/);
  assert.throws(() => proofFiles(dir, { ...REQUEST, feature: '../up' }), /Invalid feature name/);
});

test('proofTouches declares the proof and architecture.yml, before the feature exists, and answers null for a request it cannot name', () => {
  const dir = makeTempDir('construct-proof-touch-');
  assert.equal(run(['init', '--framework', 'react-spa'], dir).status, 0);
  assert.deepEqual(proofTouches(dir, REQUEST), [{ path: 'features/products/tests/generated/ProductsScreen.proof.test.ts', change: 'create' }, { path: 'architecture.yml', change: 'modify' }]);
  assert.deepEqual(expectedFiles(dir, 'create.proof', { name: 'Products', feature: 'products' }).map((f) => f.path), ['features/products/tests/generated/ProductsScreen.proof.test.ts', 'architecture.yml']);
  assert.equal(proofTouches(dir, { ...REQUEST, name: '1 bad' }), null);
  assert.deepEqual(proofTouches(dir, { ...REQUEST, kind: 'playwright' }), [], 'no Playwright config: nothing to declare');
});

test('generateProof declares the test regions once, refuses to overwrite what it did not write, and refuses a half-declared project', () => {
  const dir = project();
  const first = generateProof(dir, REQUEST);
  assert.deepEqual([first.regions, first.skipped, first.needs], [['frozen', 'nonLayer'], null, ['react', 'react-dom', 'esbuild']]);
  const yml = fs.readFileSync(path.join(dir, 'architecture.yml'), 'utf8');
  assert.match(yml, /\nfrozen:\n {2}- features\/\*\/tests\/generated\/\*\*\nnonLayer:\n {2}- features\/\*\/tests\/\*\*\n$/);
  assert.deepEqual(generateProof(dir, REQUEST).regions, [], 'the second run declares nothing');
  assert.equal(fs.readFileSync(path.join(dir, 'architecture.yml'), 'utf8'), yml);

  fs.writeFileSync(first.files[0], '// mine\n');
  assert.throws(() => generateProof(dir, REQUEST), /not a generated proof/);
  assert.equal(fs.readFileSync(first.files[0], 'utf8'), '// mine\n', 'refused, untouched');

  const half = project();
  fs.appendFileSync(path.join(half, 'architecture.yml'), '\nfrozen:\n  - somewhere/**\n');
  const before = fs.readFileSync(path.join(half, 'architecture.yml'), 'utf8');
  assert.throws(() => generateProof(half, REQUEST), /already has frozen but not the test region/);
  assert.equal(fs.readFileSync(path.join(half, 'architecture.yml'), 'utf8'), before, 'nothing was rewritten');
  assert.equal(fs.existsSync(path.join(half, 'features', 'products', 'tests')), false, 'and nothing was written');

  assert.throws(() => generateProof(dir, { ...REQUEST, feature: 'missing' }), /Feature "missing" not found/);
});

test('the CLI: create proof writes the file and says what it needs; --format json has the same facts; --llm and a missing feature are usage errors', () => {
  const dir = project();
  const text = run(['create', 'proof', 'Products', '--feature', 'products', '--entity', 'Product', '--fields', FIELDS], dir);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Updated architecture\.yml \(declared frozen: for the generated tests\)/);
  assert.match(text.stdout, /Created features\/products\/tests\/generated\/ProductsScreen\.proof\.test\.ts/);
  assert.match(text.stdout, /Needs react, react-dom, esbuild in the project \(esbuild comes with tsx and with vite\)\. Run: construct test proof products/);
  const json = JSON.parse(run(['create', 'proof', 'Products', '--feature', 'products', '--entity', 'Product', '--fields', FIELDS, '--format', 'json'], dir).stdout);
  assert.deepEqual([json.ok, json.kind, json.proofKind, json.files, json.regions, json.skipped], [true, 'proof', 'render', ['features/products/tests/generated/ProductsScreen.proof.test.ts'], [], null]);
  assert.equal(run(['create', 'proof', 'Products', '--feature', 'products', '--llm', 'claude'], dir).status, 2);
  assert.equal(run(['create', 'proof', 'Products'], dir).status, 2);
  assert.match(run(['test', 'proof'], dir).stderr, /Usage: construct test run/);
});

test('without a Playwright config the browser flow is skipped in words, and nothing is installed or written', () => {
  const dir = project();
  assert.equal(detectPlaywright(dir), null);
  const res = run(['create', 'proof', 'Products', '--feature', 'products', '--kind', 'playwright'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Skipped: Playwright is not configured in this project \(no playwright\.config\.\* at the root\), so no Playwright flow was written and nothing was installed\./);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'products', 'tests')), false);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
  assert.equal(planIn(dir).proof.playwright.configured, false);
});

test('with a Playwright config the plan adds the browser flow and its run; the spec is a locked generated test the runner finds', () => {
  const dir = project({ playwright: true });
  assert.equal(detectPlaywright(dir), 'playwright.config.ts');
  const planned = planIn(dir);
  assert.equal(planned.ok, true, JSON.stringify(planned.errors));
  // #678: project() generates the shape through the real CLI, which now declares @line/construct-core itself (add.dependency,
  // wired into --shape); the project already has it by the time this plan is built, so dependencyOffer finds nothing missing
  // and plans no add.dependency step here (see test/shapes.test.mjs for that flow's own coverage).
  assert.deepEqual(planned.plan.steps.slice(7).map((s) => `${s.id} ${s.flow} ${s.args.kind ?? ''} ${(s.dependsOn ?? []).join('+')}`), ['s8 sync  s2+s3+s4+s5+s6+s7', 's9 create.route  s7+s8', 's10 check.types  s2+s3+s4+s5+s6+s7+s8+s9', 's11 create.proof render s2+s3+s4+s5+s6+s7+s8+s9', 's12 test.proof  s11', 's13 create.proof playwright s2+s3+s4+s5+s6+s7+s8+s9', 's14 test.run  s13+s12']);
  assert.deepEqual(planned.plan.steps[12].args, { name: 'Products', feature: 'products', shape: 'list', entity: 'Product', fields: FIELDS, source: 'endpoint', kind: 'playwright', route: '/products' }, '#654: the browser flow opens the route the plan wired');
  assert.deepEqual(planned.plan.steps[13].args, { feature: 'products', name: 'products--screen.spec.ts', area: 'generated' });
  assert.deepEqual(planned.proof.verifiedBy, ['s12', 's14']);
  assert.deepEqual(planned.proof.playwright, { configured: true, config: 'playwright.config.ts', skipped: null });
  assert.deepEqual(planned.notes, ['The Products screen calls GET /api/products; that endpoint must exist in your app (a route handler or your backend), nothing in this plan creates it.'], 'the only note is what the endpoint source leaves to do by hand');
  assert.deepEqual(planTouches(planned.plan).files.filter((f) => f.path.includes('tests/')).map((f) => f.path), ['features/products/tests/generated/ProductsScreen.proof.test.ts', 'features/products/tests/generated/products--screen.spec.ts']);

  const spec = run(['create', 'proof', 'Products', '--feature', 'products', '--entity', 'Product', '--fields', FIELDS, '--kind', 'playwright', '--route', '/products'], dir);
  assert.equal(spec.status, 0, spec.stderr);
  const file = path.join(dir, 'features', 'products', 'tests', 'generated', 'products--screen.spec.ts');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(`${GENERATED_MARKER}\n`));
  for (const want of ['const START_URL: string | null = "/products";', 'page.route("**/api/products"', "toBe('loading')", "toBe('items')", "toBe('empty')", "toBe('error')", "getByRole('alert')", 'Product name 1']) assert.ok(text.includes(want), want);
  const found = resolveSpecs(dir, 'products', { name: 'products--screen.spec.ts', area: 'generated' });
  assert.equal(found.ok, true, 'the Playwright runner (construct test run) picks it up as a generated spec');
});

test('a plan for a card without the shape has no proof; proof: false leaves a shaped plan as it was', () => {
  const dir = project();
  const plain = planFromBlocks(placeCard(cardOf('A user wants to see a list of products'), { framework: 'react-spa' }).blocks, { feature: 'products', root: dir });
  assert.deepEqual([plain.proof, plain.notes, plain.plan.steps.length], [null, [], 3]);
  const shaped = planIn(dir, { proof: false, wire: false });
  assert.deepEqual([shaped.proof, shaped.wiring, shaped.offers.map((o) => o.id), shaped.plan.steps.length], [null, null, ['q-source', 'q-states'], 7], 'the data source is asked whether or not the plan is wired');
  // #678: project() already declares @line/construct-core (the real CLI --shape call adds it), so no add.dependency step is
  // planned here; sync, route and type-check still are, unless wire: false.
  assert.equal(planIn(dir, { proof: false }).plan.steps.length, 10, '#654 and #632: the sync, route and type-check steps are planned unless wire: false');
});

test('proofStatus: the chain is complete only when every proof step is green or explicitly skipped', () => {
  const green = { ok: true, counts: { total: 10, failed: 0 } };
  assert.deepEqual(proofStatus([{ id: 's9', result: green }]), { complete: true, state: 'green', steps: [{ id: 's9', state: 'green', summary: '10 passed.' }] });
  assert.equal(proofStatus([{ id: 's9', result: green }, { id: 's11' }]).state, 'pending', 'a step that has not run keeps the chain open');
  assert.equal(proofStatus([{ id: 's9', result: green }, { id: 's11', result: { skipped: 'no browser on this machine' } }]).complete, true, 'an explicit skip completes it');
  assert.deepEqual(proofStatus([{ id: 's11', result: { skipped: 'x' } }]).state, 'skipped');
  const failed = proofStatus([{ id: 's9', result: { ok: true, counts: { total: 10, failed: 1 } } }, { id: 's11', result: { skipped: 'x' } }]);
  assert.deepEqual([failed.complete, failed.state, failed.steps[0].summary], [false, 'failed', '1 of 10 failed.']);
  assert.equal(proofStatus([{ id: 's9', result: { ok: false, error: { code: 'NO_PROOF', message: 'no proof yet' } } }]).steps[0].summary, 'no proof yet');
  assert.equal(proofStatus([{ id: 's9', result: { ok: true, counts: { total: 0, failed: 0 } } }]).complete, false, 'a run that found no test proves nothing');
  assert.deepEqual(proofStatus([]), { complete: false, state: 'pending', steps: [] });
});

test('proofSummary is the fixed-size, closed-option summary of a proof run (AI-ready by design)', () => {
  assert.deepEqual(proofSummary(null).options.map((o) => o.id), ['run-proof', 'skip-proof']);
  const failure = (kind, i) => ({ title: `test ${i}`, status: 'failed', failure: { kind, expected: 'empty', reached: 'blank', summary: `${'long '.repeat(80)}\nsecond line` } });
  const many = { chain: { state: 'failed' }, counts: { total: 9, passed: 1, failed: 8 }, tests: Array.from({ length: 8 }, (_, i) => failure('app', i)) };
  const summary = proofSummary(many);
  assert.equal(summary.failures.length, PROOF_SUMMARY_LIMITS.failures);
  assert.ok(summary.failures.every((f) => f.summary.length <= PROOF_SUMMARY_LIMITS.text && !f.summary.includes('\n')));
  assert.deepEqual(summary.options.map((o) => o.id), ['edit-code', 'fill-with-ai', 'skip-proof']);
  assert.deepEqual(proofSummary({ ...many, tests: [failure('convention', 1)] }).options.map((o) => o.id), ['regenerate-screen', 'edit-code', 'skip-proof']);
  assert.deepEqual(proofSummary({ ...many, tests: [failure('other', 1)] }).options.map((o) => o.id), ['edit-code', 'skip-proof']);
  assert.deepEqual(proofSummary({ chain: { state: 'green' }, counts: { total: 1, passed: 1, failed: 0 }, tests: [] }).options, []);
  assert.doesNotMatch(JSON.stringify(summary), /(?:\/(?:tmp|home|Users)\/|\.(?:tsx?|mjs)\b)/, 'no paths');
});

test('readTap and classifyProofFailure read node\'s TAP and name the state in the words of the Playwright runner', () => {
  const tap = [
    'TAP version 13', 'ok 1 - a passing test', '  ---', '  duration_ms: 1.4', '  ...',
    'not ok 2 - Products screen: the empty state', '  ---', '  duration_ms: 0.8', "  error: |-", '    The page given no rows: the empty state is wrong, the screen shows blank.', '    Expected: "empty"', '    Received: "blank"', "  code: 'ERR_ASSERTION'", '  ...',
    '1..2', '# tests 2',
  ].join('\n');
  const [pass, fail] = readTap(tap);
  assert.deepEqual([pass.title, pass.ok, pass.durationMs], ['a passing test', true, 1]);
  assert.deepEqual([fail.ok, fail.error.split('\n')[0]], [false, 'The page given no rows: the empty state is wrong, the screen shows blank.']);
  const c = classifyProofFailure(fail.error);
  assert.deepEqual([c.kind, c.expected, c.reached, c.title], ['app', 'empty', 'blank', 'The app behaved differently']);
  assert.equal(c.summary, 'The page given no rows: the empty state is wrong, the screen shows blank.');
  assert.equal(classifyProofFailure('boom').kind, 'other');
});

test('runProofs says why it could not run: no feature, no proof yet, no esbuild in the project', async () => {
  const dir = project();
  assert.equal((await runProofs(dir, 'nope')).error.code, 'NO_FEATURE');
  const none = await runProofs(dir, 'products');
  assert.deepEqual([none.ok, none.error.code], [false, 'NO_PROOF']);
  assert.match(none.error.message, /construct create proof <Name> --feature products/);
  generateProof(dir, REQUEST);
  const missing = await runProofs(dir, 'products');
  assert.equal(missing.error.code, 'RUNNER_MISSING');
  assert.match(missing.error.message, /npm install -D tsx/, 'doctor-style guidance: what to install, and the file also runs with npx tsx --test');
  assert.equal(renderProofRunText(missing), missing.error.message);
  assert.equal((await runProofs(dir, 'products', { name: 'Other.proof.test.ts' })).error.code, 'NO_PROOF');
});

test('runProofs runs read-only: nothing is written in the project, and the throwaway directory is gone', NEEDS_RUNTIME, async () => {
  const dir = project({ link: true });
  generateProof(dir, REQUEST);
  const tmp = makeTempDir('construct-proof-tmp-');
  const files = () => fs.readdirSync(dir, { recursive: true }).filter((f) => !f.startsWith('node_modules')).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`);
  const before = files();
  const result = await runProofs(dir, 'products', { tmp });
  assert.deepEqual([result.ok, result.counts.failed, result.chain.complete], [true, 0, true], JSON.stringify(result.tests));
  assert.deepEqual(files(), before);
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.match(renderProofRunText(result), /^Feature "products": proof of the screen, 10 passed, 0 failed \(.* s, no browser\)\n {2}PASS {3}Products screen: the loading state[\s\S]*Chain: complete, the screen is proven\.$/);
});

// ------------------------------------------------------------------------------------------- the browser (opt-in)

const browser = process.env.CONSTRUCT_RUN_PLAYWRIGHT === '1';

test('the generated Playwright flow PASSES against the real screen in a browser, and FAILS as an app failure when the empty branch is gone', { skip: !browser && 'set CONSTRUCT_RUN_PLAYWRIGHT=1 (needs ui/e2e node_modules + chromium)', timeout: 180000 }, async () => {
  const dir = project({ link: true, playwright: true });
  // A project that has Playwright configured has it installed: link the one Construct's own e2e suite ships.
  for (const name of ['@playwright', 'playwright', 'playwright-core']) fs.symlinkSync(fs.realpathSync(path.join(REPO, 'ui', 'e2e', 'node_modules', name)), path.join(dir, 'node_modules', name));
  assert.equal(run(['create', 'proof', 'Products', '--feature', 'products', '--entity', 'Product', '--fields', FIELDS, '--kind', 'playwright'], dir).status, 0);
  const { build } = await import('esbuild');
  const serve = async () => {
    const out = path.join(dir, 'served');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(dir, 'entry.tsx'), "import { createRoot } from 'react-dom/client';\nimport { ProductsController } from './features/products/controllers/ProductsController.controller';\ncreateRoot(document.getElementById('root')!).render(<ProductsController />);\n");
    await build({ entryPoints: [path.join(dir, 'entry.tsx')], outfile: path.join(out, 'app.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: dir, logLevel: 'silent', alias: { react: fs.realpathSync(path.join(dir, 'node_modules', 'react')) } });
    const html = '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>';
    const server = http.createServer((req, res) => {
      if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(path.join(out, 'app.js'))); } else { res.setHeader('content-type', 'text/html'); res.end(html); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const runFlow = async (server) => runFeatureTests(dir, 'products', { name: 'products--screen.spec.ts', area: 'generated', baseUrl: `http://127.0.0.1:${server.address().port}` });
  let server = await serve();
  try {
    const good = await runFlow(server);
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.deepEqual(good.tests.map((t) => t.status), ['passed', 'passed', 'passed'], JSON.stringify(good.tests));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const expression = path.join(dir, 'features', 'products', 'expressions', 'ProductsByStatus.expression.tsx');
  fs.writeFileSync(expression, fs.readFileSync(expression, 'utf8').replace("  if (state.items.length === 0) return <>{children}</>;\n", ''));
  server = await serve();
  try {
    const bad = await runFlow(server);
    const failed = bad.tests.filter((t) => t.status === 'failed');
    assert.deepEqual(failed.map((t) => t.title), ['Products screen: the empty state']);
    assert.deepEqual([failed[0].failure.kind, failed[0].failure.expected, failed[0].failure.reached], ['app', 'empty', 'blank']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
