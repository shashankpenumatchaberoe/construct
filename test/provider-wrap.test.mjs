// #631 -- `wrap.provider`: wrap a component or page with one provider of the project (a hook built with defineProvider), as a previewed, minimal
// AST edit of the controller that renders it. The provider list is a scan of `features/*/hooks/*Provider*`; the options are closed and stable;
// running it twice changes nothing; a file that cannot be edited safely is refused with the reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN_FLOWS, planToCommand, validatePlan } from '../packages/core/plan.mjs';
import { expectedFiles } from '../packages/core/plan-touches.mjs';
import { flowBlock, flowScopeKind } from '../packages/core/block-flows.mjs';
import { suggest } from '../packages/core/decision-provider.mjs';
import { providersOf, providerOffer, wrapProvider, wrapProviderTouches, PROVIDER_QUESTION_ID, MAX_PROVIDER_OPTIONS } from '../packages/core/provider-wrap.mjs';
import { jsxParseError } from '../packages/ast/index.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(REPO, 'packages', 'cli', 'construct.mjs');
const run = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd });
const put = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');

/** A provider hook file, built the way HOOK-002 wants (`defineProvider`), exporting its hook and its root component. */
const providerFile = (name, { root = `${name}ProviderRoot`, extra = '' } = {}) => `import { defineProvider } from '@line/construct-core';\n\nconst ${name}Provider = defineProvider<Record<string, never>, { ready: boolean }>('${name}', () => ({ ready: true }));\n${root ? `export const ${root} = ${name}Provider.ProviderComponent;\n` : ''}export const use${name}Provider = ${name}Provider.useProvider;\n${extra}`;
const CONTROLLER = "import { CartPage } from '../pages/CartPage';\n\nexport function CartController() {\n  return <CartPage />;\n}\n";
const PAGE = "export function CartPage() {\n  return <main>Cart</main>;\n}\n";

/** An init project (react-spa) with a `cart` feature (page, controller) and a provider of its own, plus an `auth` feature with a provider its index exports. */
function project() {
  const dir = makeTempDir('construct-wrap-');
  assert.equal(run(['init', '--framework', 'react-spa'], dir).status, 0);
  put(dir, 'features/cart/hooks/useCartProvider.ts', providerFile('Cart'));
  put(dir, 'features/cart/pages/CartPage.tsx', PAGE);
  put(dir, 'features/cart/controllers/CartController.tsx', CONTROLLER);
  put(dir, 'features/auth/hooks/useAuthProvider.ts', providerFile('Auth'));
  put(dir, 'features/auth/index.ts', "export { AuthProviderRoot, useAuthProvider } from './hooks/useAuthProvider';\n");
  return dir;
}
const request = (over = {}) => ({ name: 'CartPage', feature: 'cart', provider: 'useCartProvider', ...over });

test('providersOf: the scan of features/*/hooks/*Provider*; only files built with defineProvider that export a use<Name>Provider hook; the root component is found, or the provider is unusable with a reason', () => {
  const dir = project();
  put(dir, 'features/cart/hooks/useCartTotals.ts', 'export function useCartTotals() { return 1; }\n');
  put(dir, 'features/cart/hooks/useFakeProvider.ts', 'export function useFakeProvider() { return 1; }\n');
  put(dir, 'features/cart/hooks/useThemeProvider.ts', providerFile('Theme', { root: null }));
  put(dir, 'features/cart/hooks/useCartProvider.test.ts', providerFile('Ghost'));
  const found = providersOf(dir, { feature: 'cart' });
  assert.deepEqual(found.map((p) => [p.id, p.root, p.feature, p.file, p.usable]), [
    ['useAuthProvider', 'AuthProviderRoot', 'auth', 'features/auth/hooks/useAuthProvider.ts', true],
    ['useCartProvider', 'CartProviderRoot', 'cart', 'features/cart/hooks/useCartProvider.ts', true],
    ['useThemeProvider', null, 'cart', 'features/cart/hooks/useThemeProvider.ts', false],
  ]);
  assert.match(found[2].why, /exports no ProviderComponent/);
  assert.deepEqual(providersOf(makeTempDir('construct-wrap-empty-')), [], 'a folder with no features has no providers');
  // A provider of another feature is usable only through that feature's public index (SLICE-002).
  put(dir, 'features/billing/hooks/usePayProvider.ts', providerFile('Pay'));
  const pay = providersOf(dir, { feature: 'cart' }).find((p) => p.id === 'usePayProvider');
  assert.deepEqual([pay.usable, /public index does not export PayProviderRoot/.test(pay.why)], [false, true]);
  assert.equal(providersOf(dir, { feature: 'billing' }).find((p) => p.id === 'usePayProvider').usable, true, 'its own feature reaches it directly');
  // Two features defining the same hook name are told apart by their feature.
  put(dir, 'features/cart2/hooks/useCartProvider.ts', providerFile('Cart'));
  assert.deepEqual(providersOf(dir).filter((p) => p.hook === 'useCartProvider').map((p) => p.id), ['cart.useCartProvider', 'cart2.useCartProvider']);
});

test('providerOffer: a closed question (2-5 options, stable ids, the usable providers first, none last); a disabled option says why; the default is the first enabled one', () => {
  const dir = project();
  const offer = providerOffer(dir, { feature: 'cart', name: 'CartPage' });
  assert.deepEqual([offer.question.id, offer.question.default, offer.question.chosen, offer.hidden], [PROVIDER_QUESTION_ID, 'useAuthProvider', null, 0]);
  assert.deepEqual(offer.question.options.map((o) => [o.id, o.enabled]), [['useAuthProvider', true], ['useCartProvider', true], ['none', true]]);
  assert.equal(offer.question.default, offer.question.options.find((o) => o.enabled).id);
  assert.ok(offer.question.question.length <= 160 && offer.question.options.every((o) => o.label.length <= 60 && o.why.length <= 120), 'the chooser summary limits hold');
  assert.equal(offer.question.options.length >= 2 && offer.question.options.length <= 5, true);
  assert.equal(providerOffer(makeTempDir('construct-wrap-none-'), { feature: 'x', name: 'X' }), null, 'no provider, no question');

  const many = project();
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) put(many, `features/cart/hooks/use${name}Provider.ts`, providerFile(name));
  const capped = providerOffer(many, { feature: 'cart', name: 'CartPage' });
  assert.equal(capped.question.options.length, 5, 'four providers and "do not wrap": the chooser limit');
  assert.equal(MAX_PROVIDER_OPTIONS, 4);
  assert.deepEqual([capped.question.options.at(-1).id, capped.hidden, capped.providers.length], ['none', 3, 7]);
  assert.deepEqual(capped.question.options.slice(0, 4).map((o) => o.id), ['useAlphaProvider', 'useAuthProvider', 'useBetaProvider', 'useCartProvider'], 'sorted by id: the same list every time');
  const unusable = project();
  put(unusable, 'features/cart/hooks/useThemeProvider.ts', providerFile('Theme', { root: null }));
  const withDisabled = providerOffer(unusable, { feature: 'cart', name: 'CartPage' });
  const theme = withDisabled.question.options.find((o) => o.id === 'useThemeProvider');
  assert.deepEqual([theme.enabled, /exports no ProviderComponent/.test(theme.why)], [false, true]);
  assert.deepEqual(providerOffer(unusable, { feature: 'cart', name: 'CartPage', answer: 'useThemeProvider' }).question.chosen, null, 'a disabled option cannot be chosen');
  assert.equal(providerOffer(unusable, { feature: 'cart', name: 'CartPage', answer: { option: 'useCartProvider', by: 'person' } }).question.chosen, 'useCartProvider');
});

test('wrapProvider: the controller gets the import and the element goes inside the root, everything else byte for byte; the result parses', () => {
  const dir = project();
  assert.deepEqual(wrapProviderTouches(dir, request()), [{ path: 'features/cart/controllers/CartController.tsx', change: 'modify', layer: 'controller' }]);
  const r = wrapProvider(dir, request());
  assert.deepEqual([r.file, r.changed, r.provider, r.root], ['features/cart/controllers/CartController.tsx', true, 'useCartProvider', 'CartProviderRoot']);
  assert.equal(r.message, 'Wrapped <CartPage /> with <CartProviderRoot> in features/cart/controllers/CartController.tsx');
  assert.equal(read(dir, r.file), "import { CartPage } from '../pages/CartPage';\nimport { CartProviderRoot } from '../hooks/useCartProvider';\n\nexport function CartController() {\n  return <CartProviderRoot><CartPage /></CartProviderRoot>;\n}\n");
  assert.equal(jsxParseError(read(dir, r.file)), null);
  assert.equal(r.before, CONTROLLER);
  assert.ok(r.notes.some((n) => /construct test types/.test(n)), 'the provider\'s own props are not filled in, and the result says how to find them');
  assert.equal(read(dir, 'features/cart/hooks/useCartProvider.ts'), providerFile('Cart'), 'no other file changed');
});

test('wrapProvider: an element on its own line is wrapped on lines, keeping the indentation; a cross-feature provider is imported through its public index', () => {
  const dir = project();
  put(dir, 'features/cart/controllers/CartController.tsx', "import { CartPage } from '../pages/CartPage';\n\nexport function CartController() {\n  return (\n    <section>\n      <CartPage\n        id=\"a\"\n      />\n    </section>\n  );\n}\n");
  wrapProvider(dir, request({ provider: 'useAuthProvider' }));
  assert.equal(read(dir, 'features/cart/controllers/CartController.tsx'), "import { CartPage } from '../pages/CartPage';\nimport { AuthProviderRoot } from '../../auth/index';\n\nexport function CartController() {\n  return (\n    <section>\n      <AuthProviderRoot>\n        <CartPage\n          id=\"a\"\n        />\n      </AuthProviderRoot>\n    </section>\n  );\n}\n");
  assert.equal(jsxParseError(read(dir, 'features/cart/controllers/CartController.tsx')), null);
  // The second provider nests inside the first: wrapping again with another provider is a new edit, not a no-op.
  const again = wrapProvider(dir, request());
  assert.equal(again.changed, true);
  assert.match(read(dir, 'features/cart/controllers/CartController.tsx'), /<AuthProviderRoot>\n {8}<CartProviderRoot>\n {10}<CartPage/);
});

test('wrapProvider is idempotent: an element already inside the root is a no-op with a message, and running it twice leaves the file as after the first run', () => {
  const dir = project();
  wrapProvider(dir, request());
  const once = read(dir, 'features/cart/controllers/CartController.tsx');
  const twice = wrapProvider(dir, request());
  assert.deepEqual([twice.changed, twice.message], [false, 'Unchanged features/cart/controllers/CartController.tsx: <CartPage /> is already inside <CartProviderRoot>.']);
  assert.equal(read(dir, 'features/cart/controllers/CartController.tsx'), once);
  put(dir, 'features/cart/controllers/CartController.tsx', "import { CartPage } from '../pages/CartPage';\nimport { CartProviderRoot } from '../hooks/useCartProvider';\n\nexport function CartController() {\n  return (\n    <CartProviderRoot>\n      <div>\n        <CartPage />\n      </div>\n    </CartProviderRoot>\n  );\n}\n");
  assert.equal(wrapProvider(dir, request()).changed, false, 'inside the root at any depth');
  assert.equal(wrapProviderTouches(dir, request()) !== null, true);
});

test('wrapProvider previews: dryRun returns the edit and writes nothing', () => {
  const dir = project();
  const preview = wrapProvider(dir, request(), { dryRun: true });
  assert.deepEqual([preview.changed, preview.message.startsWith('Would wrap')], [true, true]);
  assert.match(preview.after, /<CartProviderRoot><CartPage \/><\/CartProviderRoot>/);
  assert.equal(read(dir, 'features/cart/controllers/CartController.tsx'), CONTROLLER, 'nothing was written');
});

test('wrapProvider refuses, with the reason, what it cannot edit safely: nothing changes', () => {
  const dir = project();
  const refuse = (over, pattern) => {
    const before = read(dir, 'features/cart/controllers/CartController.tsx');
    assert.throws(() => wrapProvider(dir, request(over)), pattern);
    assert.equal(wrapProviderTouches(dir, request(over)), null, 'a refusal derives no touched file');
    assert.equal(read(dir, 'features/cart/controllers/CartController.tsx'), before);
  };
  refuse({ provider: 'useNoSuchProvider' }, /"useNoSuchProvider" is not a provider of this project\. The providers are: useAuthProvider, useCartProvider\./);
  refuse({ name: 'GhostPage' }, /Nothing in the cart feature's controllers renders <GhostPage \/>/);
  refuse({ feature: 'auth', provider: 'useAuthProvider' }, /Nothing in the auth feature's controllers renders <CartPage \/>/);
  // #677 sweep: a feature that was never created at all (not just one with no controllers dir)
  // refuses the same clear way -- already correct, nothing SLICE-001-shaped.
  refuse({ feature: 'nope' }, /(is not a provider of this project|cannot be used here|Nothing in the nope feature's controllers renders)/);
  refuse({ name: 'cartPage' }, /not a PascalCase/);
  refuse({ feature: '../x' }, /Invalid feature name/);
  refuse({ provider: '' }, /Say which provider/);

  put(dir, 'features/cart/hooks/useThemeProvider.ts', providerFile('Theme', { root: null }));
  refuse({ provider: 'useThemeProvider' }, /useThemeProvider cannot be used here: It exports no ProviderComponent/);
  put(dir, 'features/billing/hooks/usePayProvider.ts', providerFile('Pay'));
  refuse({ provider: 'usePayProvider' }, /public index does not export PayProviderRoot/);

  put(dir, 'features/cart/controllers/Other.tsx', "import { CartPage } from '../pages/CartPage';\nexport const Other = () => <CartPage />;\n");
  refuse({}, /rendered in more than one place .*CartController\.tsx \(1\), .*Other\.tsx \(1\)/);
  fs.rmSync(path.join(dir, 'features/cart/controllers/Other.tsx'));
  put(dir, 'features/cart/controllers/CartController.tsx', "import { CartPage } from '../pages/CartPage';\nexport const C = () => <div><CartPage /><CartPage /></div>;\n");
  refuse({}, /rendered in more than one place .*\(2\)/);

  put(dir, 'features/cart/controllers/CartController.tsx', "import { CartPage } from '../pages/CartPage';\nimport { CartProviderRoot } from 'somewhere-else';\nexport const C = () => <CartPage />;\n");
  refuse({}, /CartProviderRoot is already imported from "somewhere-else"/);
  put(dir, 'features/cart/controllers/CartController.tsx', "import { CartPage } from '../pages/CartPage';\nexport const C = () => <CartPage {\n");
  refuse({}, /Nothing in the cart feature's controllers renders/);
});

test('wrapProvider: a route entry may import only controllers, so an element the route renders is refused and says where to wrap instead', () => {
  const dir = project();
  put(dir, 'src/App.tsx', "import { Routes, Route } from 'react-router-dom';\nimport { CartController } from '../features/cart/controllers/CartController';\n\nexport function App() {\n  return (\n    <Routes>\n      <Route path=\"/cart\" element={<CartController />} />\n    </Routes>\n  );\n}\n");
  assert.throws(() => wrapProvider(dir, request({ name: 'CartController' })), /is rendered by the route entry src\/App\.tsx, which may import only controllers, so a provider is not wrapped there\. Wrap inside the controller/);
  assert.equal(read(dir, 'src/App.tsx').includes('CartProviderRoot'), false);
});

test('the flow: registered, mapped to `construct refactor wrap`, scope derived from the composing file, arguments validated', () => {
  const flow = PLAN_FLOWS['wrap.provider'];
  assert.deepEqual([flow.cli, flow.writes, flow.executors, Object.keys(flow.args)], [['refactor', 'wrap'], true, ['deterministic', 'user'], ['name', 'feature', 'provider', 'dir']]);
  assert.equal(flowScopeKind('wrap.provider'), 'derived');
  const dir = project();
  const args = { name: 'CartPage', feature: 'cart', provider: 'useCartProvider' };
  assert.deepEqual(planToCommand({ flow: 'wrap.provider', args }).argv, ['refactor', 'wrap', 'CartPage', '--feature', 'cart', '--provider', 'useCartProvider']);
  assert.deepEqual(expectedFiles(dir, 'wrap.provider', args), [{ path: 'features/cart/controllers/CartController.tsx', change: 'modify', layer: 'controller' }]);
  assert.equal(expectedFiles(dir, 'wrap.provider', { ...args, name: 'GhostPage' }), null, 'nothing to edit: no scope, so the plan builder reports it instead of guessing');
  assert.deepEqual(flowBlock('wrap.provider').declaredScope(args, { root: dir }), { features: ['cart'], files: [{ path: 'features/cart/controllers/CartController.tsx', change: 'modify', layer: 'controller' }] });
  const check = (a) => validatePlan({ version: 1, ticket: { source: 'text', title: 't' }, steps: [{ id: 's1', title: 't', flow: 'wrap.provider', args: a, executor: 'deterministic', touches: { features: ['cart'], files: [{ path: 'features/cart/controllers/CartController.tsx', change: 'modify' }] } }] }).errors.map((e) => `${e.code} ${e.path}`);
  assert.deepEqual(check(args), []);
  assert.deepEqual(check({ ...args, provider: 'useCart' }), ['STEP_ARG_TYPE steps[0].args.provider']);
  assert.deepEqual(check({ ...args, provider: 'cart.useCartProvider' }), []);
  assert.deepEqual(check({ ...args, name: 'cartPage' }), ['STEP_ARG_TYPE steps[0].args.name']);
  assert.deepEqual(check({ name: 'CartPage', feature: 'cart' }), ['STEP_ARG_MISSING steps[0].args.provider']);
});

test('the CLI: refactor wrap prints the closed list without --provider, previews with --dry-run, wraps, is idempotent, refuses, and has a JSON form; the result passes validate', () => {
  const dir = project();
  const listed = run(['refactor', 'wrap', 'CartPage', '--feature', 'cart'], dir);
  assert.equal(listed.status, 2);
  assert.match(listed.stderr, /Which provider\? Run again with --provider <id>:\n {2}useAuthProvider {2}Wraps with <AuthProviderRoot> from auth\.\n {2}useCartProvider {2}Wraps with <CartProviderRoot> from cart\./);
  assert.equal(read(dir, 'features/cart/controllers/CartController.tsx'), CONTROLLER, 'listing writes nothing');

  const violationsOf = () => JSON.parse(run(['validate', '--format', 'json'], dir).stdout).violations.map((v) => `${v.severity} ${v.rule} ${v.file}`).sort();
  const before = violationsOf(); // the init scaffold and the hand-written fixture files have findings of their own (a dangling CoreController route, no barrel yet)
  const dry = run(['refactor', 'wrap', 'CartPage', '--feature', 'cart', '--provider', 'useCartProvider', '--dry-run'], dir);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^Would wrap <CartPage \/> with <CartProviderRoot> in features\/cart\/controllers\/CartController\.tsx\n/);
  assert.match(dry.stdout, /\+ import \{ CartProviderRoot \} from '\.\.\/hooks\/useCartProvider';/);
  assert.match(dry.stdout, /- {3}return <CartPage \/>;\n\+ {3}return <CartProviderRoot><CartPage \/><\/CartProviderRoot>;/);
  assert.equal(read(dir, 'features/cart/controllers/CartController.tsx'), CONTROLLER, 'a dry run writes nothing');

  const real = run(['refactor', 'wrap', 'CartPage', '--feature', 'cart', '--provider', 'useCartProvider'], dir);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /^Wrapped <CartPage \/> with <CartProviderRoot> in features\/cart\/controllers\/CartController\.tsx\n/);
  assert.match(real.stdout, /Note: The provider's own props are not filled in: run `construct test types`/);
  assert.match(real.stdout, /\[tool: wrapped the element with the provider/);
  assert.match(run(['refactor', 'wrap', 'CartPage', '--feature', 'cart', '--provider', 'useCartProvider'], dir).stdout, /^Unchanged features\/cart\/controllers\/CartController\.tsx: <CartPage \/> is already inside <CartProviderRoot>\./);

  assert.deepEqual(violationsOf(), before, 'the wrapped controller passes construct validate: the wrap adds no finding (a controller may import a hook of its feature, and a root component of a provider)');
  assert.equal(before.some((v) => v.includes('CartController')), false);

  const refused = run(['refactor', 'wrap', 'GhostPage', '--feature', 'cart', '--provider', 'useCartProvider'], dir);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Nothing in the cart feature's controllers renders <GhostPage \/>/);
  const json = JSON.parse(run(['refactor', 'wrap', 'CartPage', '--feature', 'cart', '--provider', 'useAuthProvider', '--format', 'json'], dir).stdout);
  assert.deepEqual([json.ok, json.action, json.file, json.changed, json.dryRun, json.violations, json.provider], [true, 'wrap', 'features/cart/controllers/CartController.tsx', true, false, [], 'useAuthProvider']);
  const jsonDry = JSON.parse(run(['refactor', 'wrap', 'CartPage', '--feature', 'cart', '--provider', 'useAuthProvider', '--format', 'json', '--dry-run'], dir).stdout);
  assert.deepEqual([jsonDry.changed, jsonDry.dryRun, jsonDry.attribution], [false, true, null], 'already wrapped by the run above');
  assert.equal(run(['refactor', 'wrap', 'CartPage', '--feature', 'cart', '--provider', 'useCartProvider', '--llm', 'claude'], dir).status, 2, 'no model wraps');
  assert.equal(run(['refactor', 'wrap', 'CartPage', '--provider', 'useCartProvider'], dir).status, 2, 'a missing --feature is a usage error');
});

test('the rules-only provider suggests the first usable provider for q-provider', async () => {
  const offer = providerOffer(project(), { feature: 'cart', name: 'CartPage' });
  const s = await suggest({ id: offer.question.id, question: offer.question.question, options: offer.question.options });
  assert.equal(s.option, 'useAuthProvider');
});

test('the result is the plan step run through its own command: the same file the plan declared, and nothing else, changes', () => {
  const dir = project();
  const step = { id: 's1', title: 'Wrap', flow: 'wrap.provider', executor: 'deterministic', args: { name: 'CartPage', feature: 'cart', provider: 'useCartProvider' } };
  step.touches = { features: ['cart'], files: expectedFiles(dir, 'wrap.provider', step.args) };
  assert.deepEqual(validatePlan({ version: 1, ticket: { source: 'text', title: 't' }, steps: [step] }), { valid: true, errors: [] });
  const snapshot = () => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter((f) => !/^node_modules/.test(f) && fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, read(dir, f)]));
  const before = snapshot();
  const res = run(planToCommand(step).argv, dir);
  assert.equal(res.status, 0, res.stderr);
  const after = snapshot();
  assert.deepEqual(Object.keys(after).filter((f) => after[f] !== before[f]), step.touches.files.map((f) => f.path));
});
