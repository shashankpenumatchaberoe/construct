import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFeature, generateLayer } from '../packages/core/generators.mjs';
import { moveLayerFile, renameLayerFile } from '../packages/core/refactor.mjs';
import { validateArchitecture } from '../packages/core/architecture-enforcer.mjs';
import { ConstructError, EXIT_CODES } from '../packages/core/diagnostics.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

function tmpProject() {
  return makeTempDir('construct-refactor-');
}

test('moveLayerFile relocates the file and updates another file that imports it', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'domain', 'Foo', 'checkout');
  generateLayer(dir, 'hook', 'Bar', 'checkout');
  const hookFile = path.join(dir, 'features', 'checkout', 'hooks', 'useBar.tsx');
  fs.writeFileSync(hookFile, `import { Foo } from '../domain/Foo';\nexport function useBar() { return Foo(); }\n`);

  const result = moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service');
  assert.equal(result.from, 'features/checkout/domain/Foo.tsx');
  assert.equal(result.to, 'features/checkout/services/Foo.tsx');
  assert.equal(result.importersUpdated, 1);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'checkout', 'domain', 'Foo.tsx')), false);
  assert.equal(fs.existsSync(path.join(dir, 'features', 'checkout', 'services', 'Foo.tsx')), true);
  assert.match(fs.readFileSync(hookFile, 'utf8'), /from '\.\.\/services\/Foo'/);

  const res = validateArchitecture(dir);
  assert.equal(res.violations.some((v) => v.rule === 'IMPORT-001'), false);
});

test('moveLayerFile re-resolves the moved file\'s own same-layer relative import', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'domain', 'Helper', 'checkout');
  const fooFile = path.join(dir, 'features', 'checkout', 'domain', 'Foo.tsx');
  fs.writeFileSync(fooFile, `import { Helper } from './Helper';\nexport function Foo() { return Helper(); }\n`);

  const result = moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service');
  const moved = fs.readFileSync(path.join(dir, result.to), 'utf8');
  assert.match(moved, /from '\.\.\/domain\/Helper'/);

  const res = validateArchitecture(dir);
  assert.equal(res.violations.some((v) => v.rule === 'IMPORT-001'), false);
});

test('moveLayerFile throws if the source file does not exist', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  assert.throws(() => moveLayerFile(dir, 'checkout', 'Nope', 'domain', 'service'), ConstructError);
});

// #677 sweep: refactor.move/rename assume the unit (and so the feature) already exists -- the
// "reverse case" the issue also asks to check. Already correct: a feature that was never created
// refuses clearly, with nothing written, rather than a confusing SLICE-001 later.
test('moveLayerFile into a feature that does not exist at all refuses clearly, nothing written (#677, already correct)', () => {
  const dir = tmpProject();
  assert.throws(
    () => moveLayerFile(dir, 'nope', 'Foo', 'domain', 'service'),
    (e) => e instanceof ConstructError && /No domain file found for "Foo" in feature "nope"/.test(e.message),
  );
  assert.equal(fs.existsSync(path.join(dir, 'features', 'nope')), false);
});

test('renameLayerFile into a feature that does not exist at all refuses clearly, nothing written (#677, already correct)', () => {
  const dir = tmpProject();
  assert.throws(
    () => renameLayerFile(dir, 'nope', 'Foo', 'Bar', 'domain'),
    (e) => e instanceof ConstructError && /No domain file found for "Foo" in feature "nope"/.test(e.message),
  );
  assert.equal(fs.existsSync(path.join(dir, 'features', 'nope')), false);
});

test('moveLayerFile throws if the target already exists', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'domain', 'Foo', 'checkout');
  generateLayer(dir, 'service', 'Foo', 'checkout');
  assert.throws(() => moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service'), ConstructError);
});

test('moveLayerFile throws when --from and --to are the same layer', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'domain', 'Foo', 'checkout');
  assert.throws(() => moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'domain'), ConstructError);
});

test('renameLayerFile renames within the same layer and updates importers', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'domain', 'Foo', 'checkout');
  generateLayer(dir, 'hook', 'Bar', 'checkout');
  const hookFile = path.join(dir, 'features', 'checkout', 'hooks', 'useBar.tsx');
  fs.writeFileSync(hookFile, `import { Foo } from '../domain/Foo';\nexport function useBar() { return Foo(); }\n`);

  const result = renameLayerFile(dir, 'checkout', 'Foo', 'Baz', 'domain');
  assert.equal(result.to, 'features/checkout/domain/Baz.tsx');
  assert.equal(result.importersUpdated, 1);
  assert.match(fs.readFileSync(hookFile, 'utf8'), /from '\.\.\/domain\/Baz'/);
});

test('renameLayerFile applies the target layer naming convention (hook keeps its use- prefix)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'hook', 'Foo', 'checkout');
  const result = renameLayerFile(dir, 'checkout', 'Foo', 'Bar', 'hook');
  assert.equal(result.to, 'features/checkout/hooks/useBar.tsx');
});

test('renameLayerFile with hyphenated names maps to PascalCase files and rejects an invalid new name before touching anything (#218)', () => {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'hook', 'refund-request', 'checkout');
  const result = renameLayerFile(dir, 'checkout', 'refund-request', 'refund_status', 'hook');
  assert.equal(result.from, 'features/checkout/hooks/useRefundRequest.tsx');
  assert.equal(result.to, 'features/checkout/hooks/useRefundStatus.tsx');
  assert.throws(() => renameLayerFile(dir, 'checkout', 'refund_status', '3d-status', 'hook'), (err) => {
    assert.ok(err instanceof ConstructError);
    assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
    return true;
  });
  assert.ok(fs.existsSync(path.join(dir, 'features', 'checkout', 'hooks', 'useRefundStatus.tsx')));
});

// ---- #435: the TypeScript engine (tsconfig present) --------------------------------------------------------------

function tsProject(extraConfig = {}) {
  const dir = tmpProject();
  createFeature(dir, 'checkout');
  generateLayer(dir, 'domain', 'Foo', 'checkout');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2020', module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', baseUrl: '.', paths: { '@/*': ['./*'] }, strict: false },
    include: ['features/**/*', 'app/**/*'],
    ...extraConfig,
  }));
  const put = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  return { dir, put, read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8') };
}

test('TypeScript engine: relative, @/ alias, dynamic import(), re-exports, barrels and import type are all rewritten', () => {
  const { dir, put, read } = tsProject();
  put('features/checkout/hooks/useRel.tsx', `import { Foo } from '../domain/Foo';\nexport const a = Foo;\n`);
  put('features/checkout/hooks/useAlias.tsx', `import { Foo } from '@/features/checkout/domain/Foo';\nexport const b = Foo;\n`);
  put('features/checkout/hooks/useLazy.tsx', `export const load = () => import('../domain/Foo');\nexport const loadAlias = () => import('@/features/checkout/domain/Foo');\n`);
  put('features/checkout/hooks/useType.tsx', `import type { Foo } from '../domain/Foo';\nexport type T = typeof Foo;\n`);
  put('features/checkout/hooks/reexport.tsx', `export { Foo } from '../domain/Foo';\nexport * from '@/features/checkout/domain/Foo';\n`);
  put('features/checkout/domain/index.ts', `export * from './Foo';\n`);
  put('features/checkout/hooks/useBarrel.tsx', `import { Foo } from '../domain';\nexport const c = Foo;\n`);
  put('app/outside/page.tsx', `import { Foo } from '../../features/checkout/domain/Foo';\nexport default Foo;\n`);
  put('scripts/notInTsconfig.ts', `import { Foo } from '../features/checkout/domain/Foo';\nexport default Foo;\n`);

  const result = moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service');
  assert.equal(result.engine, 'typescript');
  assert.match(result.tsVersion, /^\d+\.\d+\.\d+/);
  assert.equal(fs.existsSync(path.join(dir, 'features/checkout/services/Foo.tsx')), true);
  assert.equal(fs.existsSync(path.join(dir, 'features/checkout/domain/Foo.tsx')), false);

  assert.match(read('features/checkout/hooks/useRel.tsx'), /from '\.\.\/services\/Foo'/);
  assert.match(read('features/checkout/hooks/useAlias.tsx'), /from '@\/features\/checkout\/services\/Foo'/); // alias preserved
  const lazy = read('features/checkout/hooks/useLazy.tsx');
  assert.match(lazy, /import\('\.\.\/services\/Foo'\)/);
  assert.match(lazy, /import\('@\/features\/checkout\/services\/Foo'\)/);
  assert.match(read('features/checkout/hooks/useType.tsx'), /import type \{ Foo \} from '\.\.\/services\/Foo'/);
  const re = read('features/checkout/hooks/reexport.tsx');
  assert.match(re, /export \{ Foo \} from '\.\.\/services\/Foo'/);
  assert.match(re, /export \* from '@\/features\/checkout\/services\/Foo'/);
  assert.match(read('features/checkout/domain/index.ts'), /export \* from '\.\.\/services\/Foo'/); // the barrel follows
  assert.match(read('features/checkout/hooks/useBarrel.tsx'), /from '\.\.\/domain'/); // importing the barrel is untouched
  assert.match(read('app/outside/page.tsx'), /features\/checkout\/services\/Foo'/);
  assert.match(read('scripts/notInTsconfig.ts'), /features\/checkout\/services\/Foo'/); // a file outside tsconfig include is still covered
  assert.equal(result.importersUpdated, 8);
});

test('TypeScript engine: the moved file\'s own imports are re-pointed from its new home', () => {
  const { dir, put, read } = tsProject();
  generateLayer(dir, 'domain', 'Helper', 'checkout');
  put('features/checkout/domain/Foo.tsx', `import { Helper } from './Helper';\nexport function Foo() { return Helper(); }\n`);
  const result = moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service');
  assert.equal(result.engine, 'typescript');
  assert.match(read(result.to), /from '\.\.\/domain\/Helper'/);
});

test('dry run lists every touched file and writes nothing', () => {
  const { dir, put } = tsProject();
  const hook = put('features/checkout/hooks/useRel.tsx', `import { Foo } from '../domain/Foo';\nexport const a = Foo;\n`);
  put('features/checkout/hooks/useLazy.tsx', `export const load = () => import('@/features/checkout/domain/Foo');\n`);
  const before = fs.readFileSync(hook, 'utf8');
  const r = moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service', { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.files.sort(), ['features/checkout/hooks/useLazy.tsx', 'features/checkout/hooks/useRel.tsx']);
  assert.equal(fs.readFileSync(hook, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(dir, 'features/checkout/domain/Foo.tsx')), true);
  assert.equal(fs.existsSync(path.join(dir, 'features/checkout/services/Foo.tsx')), false);
});

test('a tsconfig that extends a file outside the project is refused: regex fallback with a clear note, nothing outside is read', () => {
  const { dir, put, read } = tsProject({ extends: '../outside-base.json' });
  fs.writeFileSync(path.join(dir, '..', 'outside-base.json'), '{}');
  put('features/checkout/hooks/useRel.tsx', `import { Foo } from '../domain/Foo';\nexport const a = Foo;\n`);
  put('features/checkout/hooks/useAlias.tsx', `import { Foo } from '@/features/checkout/domain/Foo';\n`);
  const r = moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service');
  assert.equal(r.engine, 'regex');
  assert.match(r.note, /outside the project/);
  assert.match(read('features/checkout/hooks/useRel.tsx'), /\.\.\/services\/Foo/); // the regex engine still handles relative imports
  assert.match(read('features/checkout/hooks/useAlias.tsx'), /@\/features\/checkout\/domain\/Foo/); // and, as documented, misses the alias
  fs.rmSync(path.join(dir, '..', 'outside-base.json'), { force: true });
});

test('no tsconfig -> regex engine with a note; refactor.engine: regex forces it even with a tsconfig', () => {
  const plain = tmpProject();
  createFeature(plain, 'checkout');
  generateLayer(plain, 'domain', 'Foo', 'checkout');
  const r1 = moveLayerFile(plain, 'checkout', 'Foo', 'domain', 'service');
  assert.equal(r1.engine, 'regex');
  assert.match(r1.note, /no tsconfig\.json/);

  const { dir } = tsProject();
  fs.appendFileSync(path.join(dir, 'architecture.yml'), '\nrefactor:\n  engine: regex\n');
  const r2 = moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service');
  assert.equal(r2.engine, 'regex');
  assert.equal(r2.note, undefined);
});

test('a frozen importer refuses the whole TypeScript move before anything is written', () => {
  const { dir, put } = tsProject();
  const importer = put('features/checkout/hooks/useRel.tsx', `import { Foo } from '../domain/Foo';\n`);
  fs.appendFileSync(path.join(dir, 'architecture.yml'), '\nfrozen:\n  - features/checkout/hooks/useRel.tsx\n');
  assert.throws(() => moveLayerFile(dir, 'checkout', 'Foo', 'domain', 'service'), ConstructError);
  assert.equal(fs.existsSync(path.join(dir, 'features/checkout/domain/Foo.tsx')), true);
  assert.match(fs.readFileSync(importer, 'utf8'), /\.\.\/domain\/Foo/);
});

test('the language service is cached per project: a second plan is fast and sees a changed file', async () => {
  const { planFileMove, clearMoveCache } = await import('../packages/engine/tsFileMove.mjs');
  clearMoveCache();
  const { dir, put } = tsProject();
  const old = path.join(dir, 'features/checkout/domain/Foo.tsx');
  const dest = path.join(dir, 'features/checkout/services/Foo.tsx');
  put('features/checkout/hooks/useRel.tsx', `import { Foo } from '../domain/Foo';\n`);
  const t0 = Date.now();
  const first = planFileMove(dir, old, dest);
  const cold = Date.now() - t0;
  const t1 = Date.now();
  planFileMove(dir, old, dest);
  const warm = Date.now() - t1;
  assert.equal(first.ok, true);
  assert.ok(warm <= cold + 50, `warm ${warm}ms vs cold ${cold}ms`);
  put('features/checkout/hooks/useNew.tsx', `import { Foo } from '../domain/Foo';\n`);
  const later = planFileMove(dir, old, dest);
  assert.equal(later.files.length, 2);
  clearMoveCache();
});
