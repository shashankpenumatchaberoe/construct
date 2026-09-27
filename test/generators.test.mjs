import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFeature, ensureFeatureExists, generateLayer, generateVertical, missingLayerPrerequisites, selfCheck } from '../packages/core/generators.mjs';
import { validateArchitecture } from '../packages/core/architecture-enforcer.mjs';
import { validateSeparationOfConcerns } from '../packages/core/soc-enforcer.mjs';
import { ConstructError, EXIT_CODES } from '../packages/core/diagnostics.mjs';
import { parseToAst } from '../packages/ast/index.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

function tmpProject() {
  return makeTempDir('construct-generators-');
}

// Canonical dependency order: controller's template imports a same-named
// page, so page must be generated first or IMPORT-001 (dangling import)
// fires — every other layer's stub is self-contained.
const LAYERS = ['domain', 'service', 'workflow', 'hook', 'component', 'page', 'controller'];

// ---- #67: controller template branches on project.framework -------------

test('generateLayer writes the nextjs controller template by default (no architecture.yml)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'page', 'Checkout', 'checkout');
  const file = generateLayer(dir, 'controller', 'Checkout', 'checkout');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /import \{ CheckoutPage \} from '\.\.\/pages\/CheckoutPage';/);
  assert.match(content, /export function CheckoutController\(\) \{\s*\n\s*return <CheckoutPage \/>;/);
  // No react-router-specific wiring comment for the nextjs (default) target.
  assert.doesNotMatch(content, /react-router/);
});

test('generateLayer writes a react-spa controller documenting its real router-table wiring', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'project:\n  framework: react-spa\n');
  createFeature(dir, 'checkout');
  generateLayer(dir, 'page', 'Checkout', 'checkout');
  const file = generateLayer(dir, 'controller', 'Checkout', 'checkout');
  const content = fs.readFileSync(file, 'utf8');
  // Same functional composition (controller renders its same-named page) --
  // that part was never actually Next.js-specific.
  assert.match(content, /import \{ CheckoutPage \} from '\.\.\/pages\/CheckoutPage';/);
  assert.match(content, /export function CheckoutController\(\) \{\s*\n\s*return <CheckoutPage \/>;/);
  // But the real entry-point wiring mechanism is now documented explicitly
  // instead of being an unstated nextjs assumption.
  assert.match(content, /Registered directly as this route's element by react-router in\s*\n\/\/ src\/App\.tsx/);
  assert.match(content, /<Route path="\/checkout" element={<CheckoutController \/>} \/>/);
  // And it still passes Construct's own architecture rules (selfCheck ran
  // inside generateLayer without throwing) -- this assertion just documents
  // that expectation for a reader of this test.
  const { ok } = validateArchitecture(dir, { files: [file] });
  assert.ok(ok);
});

test('createFeature scaffolds the full layer folder set plus types/index', () => {
  const dir = tmpProject();
  const base = createFeature(dir, 'checkout');
  for (const folder of ['controllers', 'workflows', 'hooks', 'domain', 'services', 'pages', 'components']) {
    assert.ok(fs.existsSync(path.join(base, folder)), `missing folder: ${folder}`);
  }
  assert.ok(fs.existsSync(path.join(base, 'types.ts')));
  assert.ok(fs.existsSync(path.join(base, 'index.ts')));
});

// #677 -- a `create.unit`/`create.layer` (and plain `create page`/`create <layer>`) request into a feature that
// doesn't exist yet used to write only the requested layer file(s), leaving the feature without its other layer
// folders or its types.ts/index.ts -- a silent, confusing setup for `construct validate`'s later SLICE-001. The
// feature is now scaffolded first (same output as `construct create feature`), so the request ends with a
// feature that passes validate, not a broken partial one.
test('#677: ensureFeatureExists scaffolds a missing feature once, and is a no-op once it exists', () => {
  const dir = tmpProject();
  assert.equal(fs.existsSync(path.join(dir, 'features', 'billing')), false);
  assert.equal(ensureFeatureExists(dir, 'billing'), true, 'created it');
  assert.ok(fs.existsSync(path.join(dir, 'features', 'billing', 'types.ts')));
  assert.ok(fs.existsSync(path.join(dir, 'features', 'billing', 'index.ts')));
  assert.equal(ensureFeatureExists(dir, 'billing'), false, 'already there, nothing to do');
});

test('#677: generateLayer (a single unit, e.g. `create page`) into a missing feature scaffolds the feature first', () => {
  const dir = tmpProject();
  const file = generateLayer(dir, 'page', 'Bad', 'nope'); // the issue's own second repro: `construct create page Bad --feature nope`
  assert.ok(fs.existsSync(file));
  const featureDir = path.join(dir, 'features', 'nope');
  assert.ok(fs.existsSync(path.join(featureDir, 'types.ts')));
  assert.ok(fs.existsSync(path.join(featureDir, 'index.ts')));
  for (const folder of ['controllers', 'workflows', 'hooks', 'domain', 'services', 'pages', 'components']) {
    assert.ok(fs.existsSync(path.join(featureDir, folder)), `missing folder: ${folder}`);
  }
  const { violations } = validateSeparationOfConcerns(dir);
  assert.deepEqual(violations.filter((v) => v.rule === 'SLICE-001'), []);
});

test('#677: generateVertical (`create layer`) into a missing feature scaffolds the feature first, even with a partial --layers list', () => {
  const dir = tmpProject();
  // Deliberately leaves "workflow" out of --layers, exactly like the issue's first repro -- without the fix
  // this alone used to be enough to trip SLICE-001 (a missing workflows/ folder), regardless of the feature.
  const files = generateVertical(dir, 'MyCategories', 'ownership', ['domain', 'service', 'hook', 'component', 'page', 'controller']);
  assert.equal(files.length, 6);
  const featureDir = path.join(dir, 'features', 'ownership');
  assert.ok(fs.existsSync(path.join(featureDir, 'types.ts')));
  assert.ok(fs.existsSync(path.join(featureDir, 'index.ts')));
  for (const folder of ['controllers', 'workflows', 'hooks', 'domain', 'services', 'pages', 'components']) {
    assert.ok(fs.existsSync(path.join(featureDir, folder)), `missing folder: ${folder}`);
  }
  const { violations } = validateSeparationOfConcerns(dir);
  assert.deepEqual(violations.filter((v) => v.rule === 'SLICE-001'), []);
});

test('createFeature PascalCases a hyphenated feature name into a valid type identifier', () => {
  const dir = tmpProject();
  const base = createFeature(dir, 'cpo-v2');
  const typesContent = fs.readFileSync(path.join(base, 'types.ts'), 'utf8');
  assert.match(typesContent, /^export type CpoV2Id = string;$/m);
  assert.doesNotMatch(typesContent, /-/);
});

// #79 — pascalCase's boundary-replace only touches "-"/"_" boundaries; a
// leading digit (or any other character outside [-_a-zA-Z0-9]) passed
// straight through untouched and silently produced an invalid TS
// identifier (e.g. "3d-viewer" -> "export type 3dViewerId"). Both must now
// be rejected clearly, at scaffold time, before anything is written.
test('createFeature rejects a feature name that would PascalCase into an identifier starting with a digit', () => {
  const dir = tmpProject();
  assert.throws(() => createFeature(dir, '3d-viewer'), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.match(err.message, /3d-viewer/);
    assert.match(err.message, /3dViewer/);
    return true;
  });
  // Nothing should have been written for the rejected feature.
  assert.equal(fs.existsSync(path.join(dir, 'features', '3d-viewer')), false);
});

test('createFeature rejects a feature name containing a character illegal in a TS identifier (e.g. a space)', () => {
  const dir = tmpProject();
  assert.throws(() => createFeature(dir, 'foo bar'), ConstructError);
});

test('generateLayer writes every layer into the right folder with expected naming', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  for (const layer of LAYERS) {
    const file = generateLayer(dir, layer, 'Checkout', 'checkout');
    assert.ok(fs.existsSync(file));
    if (layer === 'hook') assert.match(file, /useCheckout\.tsx$/);
    else if (layer === 'page') assert.match(file, /CheckoutPage\.tsx$/);
    else if (layer === 'controller') assert.match(file, /CheckoutController\.tsx$/);
    else assert.match(file, /Checkout\.tsx$/);
  }
});

test('generateLayer throws on an unknown layer name', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  assert.throws(() => generateLayer(dir, 'nope', 'Checkout', 'checkout'), /Unknown layer/);
});

// ---- generateVertical: one logical unit across several layers -------------

test('generateVertical scaffolds every requested layer regardless of the order given', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const files = generateVertical(dir, 'Checkout', 'checkout', ['controller', 'page', 'hook', 'domain']);
  assert.equal(files.length, 4);
  for (const f of files) assert.ok(fs.existsSync(f));
  assert.match(files[0], /domain[/\\]Checkout\.tsx$/);
  assert.match(files[1], /hooks[/\\]useCheckout\.tsx$/);
  assert.match(files[2], /pages[/\\]CheckoutPage\.tsx$/);
  assert.match(files[3], /controllers[/\\]CheckoutController\.tsx$/);
});

test('generateVertical throws on an unknown layer name before writing anything', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  assert.throws(() => generateVertical(dir, 'Checkout', 'checkout', ['domain', 'nope']), /Unknown layer/);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'checkout', 'domain', 'Checkout.tsx')), false);
});

// #275 superseded this test's original assertion: requesting a controller
// without its page used to get as far as writing the controller and then fail
// with a raw IMPORT-001 "template bug". It is now refused up front, by name,
// with nothing written — see the #275 block at the bottom of this file for the
// full message/exit-code/no-write assertions.
test('generateVertical requesting a controller without its page fails fast, naming the missing page (#275)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  assert.throws(
    () => generateVertical(dir, 'Checkout', 'checkout', ['domain', 'hook', 'controller']),
    (err) => err.message.includes('a "controller" needs a "page" layer'),
  );
});

test('generateVertical deduplicates a layer listed twice', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const files = generateVertical(dir, 'Checkout', 'checkout', ['domain', 'domain']);
  assert.equal(files.length, 1);
});

// ---- idempotent-clean composition: generated code passes the enforcer -----

test('a freshly generated feature + every layer produces zero architecture violations', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  for (const layer of LAYERS) generateLayer(dir, layer, 'Checkout', 'checkout');
  const res = validateArchitecture(dir);
  const errors = res.violations.filter((v) => v.severity === 'error');
  assert.deepEqual(errors, [], `expected zero error-severity violations, got: ${JSON.stringify(errors)}`);
});

test('re-running the enforcer against generated output alone (scoped) is also clean', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const files = LAYERS.map((layer) => generateLayer(dir, layer, 'Checkout', 'checkout'));
  const rels = files.map((f) => path.relative(dir, f).replaceAll(path.sep, '/'));
  const res = validateArchitecture(dir, { files: rels });
  assert.deepEqual(res.violations, []);
});

// ---- per-layer template override hook -------------------------------------

test('a templates/<layer> file overrides the built-in template', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'component.tsx'), 'export function {{Name}}() { return <span>{{name}}</span>; }\n');
  const file = generateLayer(dir, 'component', 'Widget', 'checkout');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /export function Widget\(\)/);
  assert.match(content, /<span>Widget<\/span>/);
});

test('architecture.yml `templates:` map takes precedence and resolves a relative path', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  fs.mkdirSync(path.join(dir, 'custom-templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'custom-templates', 'my-domain.ts'), 'export function {{Name}}() { return {{name}}Total; }\n');
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'templates:\n  domain: custom-templates/my-domain.ts\n');
  const file = generateLayer(dir, 'domain', 'Order', 'checkout');
  assert.match(fs.readFileSync(file, 'utf8'), /export function Order\(\)/);
});

test('post-generation self-check throws a ConstructError when a custom template violates architecture', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'templates', 'domain.ts'), 'export function {{Name}}() { return fetch("/x"); }\n');
  assert.throws(() => generateLayer(dir, 'domain', 'Bad', 'checkout'), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.match(err.message, /DOMAIN-001/);
    assert.equal(err.violations[0].rule, 'DOMAIN-001');
    return true;
  });
});

// ---- #218: layer templates use pascalCase like createFeature/the engine generators

const EXPECTED_218 = {
  domain: ['domain/RefundRequest.tsx', /export function RefundRequest\(/],
  service: ['services/RefundRequest.tsx', /export async function RefundRequest\(/],
  workflow: ['workflows/RefundRequest.tsx', /export const RefundRequestWorkflow = /],
  hook: ['hooks/useRefundRequest.tsx', /export function useRefundRequest\(/],
  component: ['components/RefundRequest.tsx', /export function RefundRequest\(/],
  page: ['pages/RefundRequestPage.tsx', /export function RefundRequestPage\(/],
  controller: ['controllers/RefundRequestController.tsx', /export function RefundRequestController\(/],
};

for (const layer of LAYERS) {
  test(`generateLayer ${layer}: hyphen / underscore / camel names give identical valid output (#218)`, () => {
    const outputs = [];
    for (const name of ['refund-request', 'refund_request', 'refundRequest']) {
      const dir = tmpProject();
      createFeature(dir, 'checkout');
      if (layer === 'controller') generateLayer(dir, 'page', name, 'checkout');
      const file = generateLayer(dir, layer, name, 'checkout');
      const [relFile, re] = EXPECTED_218[layer];
      assert.equal(path.relative(path.join(dir, 'features', 'checkout'), file), relFile);
      const content = fs.readFileSync(file, 'utf8');
      assert.doesNotThrow(() => parseToAst(content));
      assert.match(content, re);
      outputs.push(content);
    }
    assert.equal(outputs[0], outputs[1]);
    assert.equal(outputs[0], outputs[2]);
  });

  test(`generateLayer ${layer}: a leading-digit name is rejected with nothing written (#218)`, () => {
    const dir = tmpProject();
    createFeature(dir, 'checkout');
    const featureDir = path.join(dir, 'features', 'checkout');
    const snapshot = () => fs.readdirSync(featureDir, { recursive: true }).sort();
    const before = snapshot();
    assert.throws(() => generateLayer(dir, layer, '3d-refund', 'checkout'), (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /name "3d-refund" can't be turned into a valid TypeScript identifier/);
      return true;
    });
    assert.deepEqual(snapshot(), before);
  });
}

test('generateVertical with a hyphenated name scaffolds every layer with valid identifiers and validates clean (#218)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const files = generateVertical(dir, 'refund-request', 'checkout', LAYERS);
  assert.equal(files.length, LAYERS.length);
  for (const f of files) assert.doesNotThrow(() => parseToAst(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(validateArchitecture(dir).violations.filter((v) => v.severity === 'error'), []);
});

test('generateVertical rejects an invalid name before writing any layer (#218)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const featureDir = path.join(dir, 'features', 'checkout');
  const before = fs.readdirSync(featureDir, { recursive: true }).sort();
  assert.throws(() => generateVertical(dir, '9lives', 'checkout', LAYERS), ConstructError);
  assert.deepEqual(fs.readdirSync(featureDir, { recursive: true }).sort(), before);
});

test('custom template {{Name}} is PascalCased for a hyphenated name (#218)', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, 'templates'));
  fs.writeFileSync(path.join(dir, 'templates', 'domain.txt'), 'export const {{Name}} = "{{name}}";\n');
  createFeature(dir, 'checkout');
  const file = generateLayer(dir, 'domain', 'refund-request', 'checkout');
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const RefundRequest = "refund-request";\n');
});

// ---- #275: a controller without its page is a layer-set error, not a
// "template bug" ----------------------------------------------------------
//
// Before this, generateVertical happily wrote the controller (whose stub
// imports '../pages/<Name>Page'), selfCheck re-validated it, IMPORT-001 fired,
// and the user was told "Construct generated code that fails its own
// architecture rules (template bug)" with an INTERNAL_ERROR exit code — for
// what is entirely a problem with the layers they asked for.

test('#275 generateVertical rejects controller-without-page with an actionable message and writes nothing', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const featureDir = path.join(dir, 'features', 'checkout');
  const before = fs.readdirSync(featureDir, { recursive: true }).sort();
  assert.throws(() => generateVertical(dir, 'Products', 'checkout', ['domain', 'hook', 'controller']), (err) => {
    assert.ok(err instanceof ConstructError);
    // A user-input problem, not an internal one.
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.doesNotMatch(err.message, /template bug/);
    assert.match(err.message, /a "controller" needs a "page" layer/);
    // Says what to do about it, all three ways.
    assert.match(err.message, /--layers domain,hook,page,controller/);
    assert.match(err.message, /construct create page Products --feature checkout/);
    assert.match(err.message, /drop "controller"/);
    return true;
  });
  // Crucially: the half-written controller is not left behind either.
  assert.deepEqual(fs.readdirSync(featureDir, { recursive: true }).sort(), before);
});

test('#275 generateLayer controller alone is rejected the same way, with nothing written', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const featureDir = path.join(dir, 'features', 'checkout');
  const before = fs.readdirSync(featureDir, { recursive: true }).sort();
  assert.throws(() => generateLayer(dir, 'controller', 'Products', 'checkout'), (err) => {
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.doesNotMatch(err.message, /template bug/);
    assert.match(err.message, /a "controller" needs a "page" layer/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(featureDir, { recursive: true }).sort(), before);
});

test('#275 a page already on disk satisfies the controller prerequisite (create page, then create controller)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'page', 'Products', 'checkout');
  const file = generateLayer(dir, 'controller', 'Products', 'checkout');
  assert.ok(fs.existsSync(file));
  assert.deepEqual(validateArchitecture(dir).violations.filter((v) => v.severity === 'error'), []);
});

test('#275 a hand-written page with a non-.tsx extension also satisfies the prerequisite', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  fs.writeFileSync(
    path.join(dir, 'features', 'checkout', 'pages', 'ProductsPage.ts'),
    'export function ProductsPage() { return null; }\n',
  );
  assert.doesNotThrow(() => generateLayer(dir, 'controller', 'Products', 'checkout'));
});

test('#275 page+controller in one vertical still works, in dependency order', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  // Deliberately listed controller-first: LAYER_ORDER reorders it.
  const files = generateVertical(dir, 'Products', 'checkout', ['controller', 'page']);
  assert.deepEqual(files.map((f) => path.basename(f)), ['ProductsPage.tsx', 'ProductsController.tsx']);
  assert.deepEqual(validateArchitecture(dir).violations.filter((v) => v.severity === 'error'), []);
});

test('#275 missingLayerPrerequisites reports the gap without writing anything', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  const featureDir = path.join(dir, 'features', 'checkout');
  const before = fs.readdirSync(featureDir, { recursive: true }).sort();
  assert.deepEqual(missingLayerPrerequisites(dir, 'Products', 'checkout', ['hook', 'controller']), [
    { layer: 'controller', requires: 'page' },
  ]);
  assert.deepEqual(missingLayerPrerequisites(dir, 'Products', 'checkout', ['page', 'controller']), []);
  assert.deepEqual(missingLayerPrerequisites(dir, 'Products', 'checkout', ['domain', 'hook']), []);
  assert.deepEqual(fs.readdirSync(featureDir, { recursive: true }).sort(), before);
});

test('#275 selfCheck reports an all-IMPORT-001 failure as a layer-order problem, not a template bug', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  // Write a controller straight to disk, bypassing the prerequisite check, so
  // selfCheck sees exactly what it used to see before this fix.
  const file = path.join(dir, 'features', 'checkout', 'controllers', 'ProductsController.tsx');
  fs.writeFileSync(file, "import { ProductsPage } from '../pages/ProductsPage';\n\nexport function ProductsController() {\n  return <ProductsPage />;\n}\n");
  assert.throws(() => selfCheck(dir, [file]), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    assert.doesNotMatch(err.message, /template bug/);
    assert.match(err.message, /references a file that doesn't exist yet/);
    assert.match(err.message, /domain -> service -> workflow -> hook -> component -> page -> controller/);
    return true;
  });
});

test('#275 selfCheck still calls a genuine rule violation a template bug (INTERNAL_ERROR)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  // A domain file naming a banned effect word — nothing to do with build order.
  const file = path.join(dir, 'features', 'checkout', 'domain', 'Products.tsx');
  fs.writeFileSync(file, 'export function Products() {\n  return fetch("/api/products");\n}\n');
  assert.throws(() => selfCheck(dir, [file]), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.INTERNAL_ERROR);
    assert.match(err.message, /template bug/);
    return true;
  });
});
