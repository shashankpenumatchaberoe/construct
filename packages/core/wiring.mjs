// #654 -- the two by-hand steps after a generated screen, as deterministic blocks a plan can carry: point the project's route entry at
// the new controller (`create.route`), and add the one dependency the typed units import (`add.dependency`), plus the files the
// existing `sync` step will touch. No model: every edit is a fixed template or a minimal, line-based change to a known scaffold, and
// running any of them twice changes nothing.
//   routePathOf(name)                       "SubscriptionPlan" -> "/subscription-plan"
//   routeOffer(root, request)               the route the screen gets, and a closed question (q-route) when the name's path is reserved or taken
//   routeEntryFile(root, route)             the route entry file of a route (a route guard edits it, #629)
//   routeEntryTouches(root, request)        the file the route step will write (Next.js: create app/<route>/page.tsx; react-spa: modify src/App.tsx)
//   generateRouteEntry(root, request)       write it (idempotent; refuses a route that something else already owns)
//   wireRouteSource(source, options)        the pure edit of a react-router table (used by generateRouteEntry, testable alone)
//   syncTouches(root, feature)              what `construct sync` will change for a feature: its barrel and the dependency-cruiser config
//   dependencyOffer(root)                   the closed choice (q-dependency) when package.json has no @line/construct-core, with the exact line
//   addDependency(root, request)            add one dependency line to package.json (never runs a package manager)
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { ConstructError, EXIT_CODES } from './diagnostics.mjs';
import { layerFileBaseName } from './generators.mjs';
import { hasTypedContractsDependency } from './shapes.mjs';
import { write } from './fs.mjs';

const usage = (message) => new ConstructError(message, { exitCode: EXIT_CODES.USAGE_ERROR });
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const FEATURE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SEGMENT = '[a-z0-9]+(?:-[a-z0-9]+)*';
const ROUTE_RE = new RegExp(`^/${SEGMENT}(?:/${SEGMENT})*$`);

/** The route segments a Next.js or SPA app already uses for something else; a screen named like one is asked about, not guessed. */
export const RESERVED_ROUTES = Object.freeze(['api']);

/** The id of the closed question about the route, and of the one about the dependency (chooser summary shape, like `q-shape`). */
export const ROUTE_QUESTION_ID = 'q-route';
export const DEPENDENCY_QUESTION_ID = 'q-dependency';

/** The package the typed units import their factories from, and the range the plan would add. */
export const CONSTRUCT_CORE_PACKAGE = '@line/construct-core';

/**
 * The route path of a screen: the kebab-case of its PascalCase name, one segment.
 *
 * @param {string} name The screen (controller unit) name, for example `SubscriptionPlan`.
 * @returns {string} The route, for example `/subscription-plan`.
 *
 * @example
 * routePathOf('SubscriptionPlan'); // => '/subscription-plan'
 */
export function routePathOf(name) {
  return `/${String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

/** Where routes live for this project: `{ framework, entry }`; `entry` is the folder of `page.tsx` files (Next.js) or the router file (react-spa), project-relative. */
function routeTarget(root) {
  const config = loadConfig(root);
  const framework = config.project?.framework ?? 'nextjs';
  const pattern = config.layers?.route?.pattern ?? (framework === 'react-spa' ? 'src/App.tsx' : 'app/**/page.tsx');
  const entry = framework === 'react-spa' ? pattern : pattern.split('/**')[0];
  return { framework, entry, config };
}

/**
 * The route entry file of a route, project-relative: Next.js `<app>/<route>/page.tsx`, react-spa the router file. Reads only the project's architecture.yml; the file need not exist.
 *
 * @param {string} root Project root.
 * @param {string} route The route path (`/products`).
 * @returns {{ framework: string, file: string }} The framework and the route entry file.
 *
 * @example
 * routeEntryFile(root, '/products'); // => { framework: 'nextjs', file: 'app/products/page.tsx' }
 */
export function routeEntryFile(root, route) {
  const { framework, entry } = routeTarget(root);
  return { framework, file: framework === 'react-spa' ? entry : `${entry}${route}/page.tsx` };
}

/** Whether `route` is already served by the project's route entry, and whether by the controller of this screen. */
function routeState(root, request, route) {
  const { framework, entry } = routeTarget(root);
  if (framework === 'react-spa') {
    const file = path.join(root, entry);
    if (!fs.existsSync(file)) return { taken: false, ours: false };
    const source = fs.readFileSync(file, 'utf8');
    const has = new RegExp(`<Route\\b[^>]*\\bpath=(["'])${escapeRe(route)}\\1`).test(source);
    return { taken: has, ours: has && source.includes(`<${request.name}Controller`) };
  }
  const dir = path.join(root, entry, ...route.split('/').filter(Boolean));
  const page = ['page.tsx', 'page.jsx', 'page.ts', 'page.js'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!page) return { taken: false, ours: false };
  return { taken: true, ours: fs.readFileSync(page, 'utf8').includes(`${request.name}Controller`) };
}

const SCAFFOLD_PAGE_RE = /^import \{ ([A-Za-z0-9_]+Controller) \} from '(\.[^']*)';\n+export default function Page\(\) \{\n  return <\1 \/>;\n\}\n?$/;

/** The Next.js root page `construct init` writes (it renders a `CoreController` that is never generated), when it still is exactly that and its import resolves to nothing: project-relative, or null. */
function danglingRootPage(root, entry) {
  const relFile = `${entry}/page.tsx`;
  const file = path.join(root, relFile);
  if (!fs.existsSync(file)) return null;
  const m = SCAFFOLD_PAGE_RE.exec(fs.readFileSync(file, 'utf8'));
  if (!m) return null;
  const target = path.resolve(path.dirname(file), m[2]);
  return ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx'].some((ext) => fs.existsSync(target + ext)) ? null : relFile;
}

const answerOf = (answer) => (typeof answer === 'string' ? { option: answer } : answer && typeof answer === 'object' ? answer : null);

/**
 * The route a screen gets. Normally `/<kebab-name>` with no question. When that path is reserved (`api`) or already served by
 * something that is not this screen, the answer is a closed question `q-route` (chooser summary shape: options with stable ids,
 * the rules' `default`, `chosen`): `alternate` (the first free of `/<feature>/<name>` when the feature is named otherwise, `/<name>-screen`, `/<name>-2`) or `skip`
 * (no route step; the screen stays unreachable until wired). An unanswered question uses its default, so it never holds a plan back.
 * Reads the project, writes nothing, never throws.
 *
 * @param {string} root Project root.
 * @param {{ name: string, feature: string, answer?: string | { option: string } }} request The controller unit name, its feature, and an answer to `q-route`.
 * @returns {{ route: string | null, skipped: boolean, question: object | null, answer: string | null }}
 *   `route` is where the screen goes (`null` when skipped), `question` the open choice or `null`, `answer` the option used when one was asked.
 *
 * @example
 * routeOffer(root, { name: 'Products', feature: 'products' }); // => { route: '/products', skipped: false, question: null, answer: null }
 */
export function routeOffer(root, request) {
  const base = routePathOf(request.name);
  try {
    const state = routeState(root, request, base);
    const reserved = RESERVED_ROUTES.includes(base.slice(1));
    if ((!state.taken || state.ours) && !reserved) return { route: base, skipped: false, question: null, answer: null };
    const kebab = base.slice(1);
    const candidates = [...(request.feature === kebab ? [] : [`/${request.feature}/${kebab}`]), `${base}-screen`, `${base}-2`].filter((r) => ROUTE_RE.test(r) && !RESERVED_ROUTES.includes(r.split('/')[1]));
    const alternate = candidates.find((r) => !routeState(root, request, r).taken) ?? null;
    const why = reserved ? `"${base}" is a name the app itself uses.` : `"${base}" is already a route of this project.`;
    const options = [
      ...(alternate ? [{ id: 'alternate', label: `Use ${alternate}`, enabled: true, why: `${why} ${alternate} is free.` }] : []),
      { id: 'skip', label: 'Do not wire a route', enabled: true, why: 'The screen stays unreachable until you add it to the route entry yourself.' },
    ];
    const chosen = answerOf(request.answer)?.option;
    const used = options.some((o) => o.id === chosen) ? chosen : options[0].id;
    const question = { id: ROUTE_QUESTION_ID, question: `Where should the "${request.name}" screen live? ${why}`, options, default: options[0].id, chosen: options.some((o) => o.id === chosen) ? chosen : null };
    return { route: used === 'alternate' ? alternate : null, skipped: used === 'skip', question, answer: used };
  } catch {
    return { route: base, skipped: false, question: null, answer: null };
  }
}

/**
 * The file the route step of a screen writes, as its `touches.files`: Next.js creates `<app>/<route>/page.tsx`, react-spa modifies
 * its router file (`src/App.tsx`). Read-only and never throws: an invalid request answers `null`.
 *
 * @param {string} root Project root (its architecture.yml decides the framework and the route entry).
 * @param {{ name: string, feature: string, route?: string }} request The controller unit name, its feature and the route (default: the kebab-case of the name).
 * @returns {{ path: string, change: 'create'|'modify'|'delete', layer: string }[] | null} The file, and (Next.js) the dangling init root page it removes; or `null`.
 *
 * @example
 * routeEntryTouches(root, { name: 'Products', feature: 'products' }); // => [{ path: 'app/products/page.tsx', change: 'create', layer: 'route' }]
 */
export function routeEntryTouches(root, request) {
  try {
    checkRequest(request);
    const route = request.route ?? routePathOf(request.name);
    if (!ROUTE_RE.test(route)) return null;
    const { framework, entry } = routeTarget(root);
    if (framework === 'react-spa') return [{ path: entry, change: 'modify', layer: 'route' }];
    const dangling = danglingRootPage(root, entry);
    return [{ path: `${entry}${route}/page.tsx`, change: 'create', layer: 'route' }, ...(dangling ? [{ path: dangling, change: 'delete', layer: 'route' }] : [])];
  } catch {
    return null;
  }
}

function checkRequest(request) {
  if (!request || typeof request.name !== 'string' || !NAME_RE.test(request.name)) throw usage(`"${request?.name ?? ''}" is not a PascalCase controller name such as Products.`);
  if (typeof request.feature !== 'string' || !FEATURE_RE.test(request.feature)) throw usage(`Invalid feature name ${JSON.stringify(request.feature ?? '')}: use letters, numbers, "_" and "-" only.`);
  if (request.route !== undefined && !ROUTE_RE.test(request.route)) throw usage(`"${request.route}" is not a route path: use lowercase segments such as /products or /shop/products.`);
}

const IMPORT_RE = /^import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*(['"])(\.[^'"]*)\2;?\s*$/;

/**
 * The pure edit of a react-router table (`src/App.tsx`): add the import of the controller and a `<Route>` for it before `</Routes>`,
 * and drop a dangling controller import (a relative import of a `...Controller` whose file is gone, the scaffold `construct init`
 * leaves) with its own `<Route>` line. Line-based and minimal: everything else is kept byte for byte. Idempotent: a route that
 * already renders this controller changes nothing.
 *
 * @param {string} source The current text of the route entry.
 * @param {{ ident: string, importPath: string, route: string, exists?: (specifier: string) => boolean }} options The controller's exported name, the import path from the entry, the route, and a check for whether a relative import resolves (default: everything does).
 * @returns {{ source: string, changed: boolean, removed: string[] }} The new text, whether it differs, and the dangling imports it dropped.
 * @throws {Error} A usage error when the route belongs to something else, or the text has no `</Routes>` to add the route to.
 *
 * @example
 * wireRouteSource('<Routes>\n</Routes>\n', { ident: 'ProductsController', importPath: '../features/products/controllers/ProductsController', route: '/products' }).changed; // => true
 */
export function wireRouteSource(source, { ident, importPath, route, exists = () => true }) {
  const owned = new RegExp(`<Route\\b[^>]*\\bpath=(["'])${escapeRe(route)}\\1`).test(source);
  if (owned) {
    if (source.includes(`<${ident}`)) return { source, changed: false, removed: [] };
    throw usage(`The route ${route} already belongs to another element in the route entry. Pick another route, or skip the route step.`);
  }
  let lines = source.split('\n');
  const removed = [];
  for (const line of lines) {
    const m = IMPORT_RE.exec(line);
    if (m && /Controller$/.test(m[1]) && m[1] !== ident && !exists(m[3])) removed.push(m[1]);
  }
  if (removed.length) {
    lines = lines.filter((line) => {
      const m = IMPORT_RE.exec(line);
      if (m && removed.includes(m[1]) && !exists(m[3])) return false;
      return !removed.some((id) => new RegExp(`^\\s*<Route\\b[^>]*element=\\{<${escapeRe(id)}\\s*/>\\}[^>]*/>\\s*$`).test(line));
    });
  }
  const close = lines.findIndex((line) => line.includes('</Routes>'));
  if (close < 0) throw usage('The route entry has no <Routes> table to add the route to. Add `<Route path="' + route + '" element={<' + ident + ' />} />` by hand, or skip the route step.');
  const lastRoute = lines.slice(0, close).map((l, i) => [l, i]).reverse().find(([l]) => /^\s*<Route\b/.test(l));
  const indent = lastRoute ? /^\s*/.exec(lastRoute[0])[0] : `${/^\s*/.exec(lines[close])[0]}  `;
  lines.splice(close, 0, `${indent}<Route path="${route}" element={<${ident} />} />`);
  if (!lines.some((l) => new RegExp(`^import\\s*\\{[^}]*\\b${escapeRe(ident)}\\b[^}]*\\}`).test(l))) {
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^(import\b|.*\bfrom\s+['"][^'"]+['"];?\s*$)/.test(lines[i])) at = i + 1;
      else if (/^(export|function|const|let|class|type|interface)\b/.test(lines[i])) break;
    }
    lines.splice(at, 0, `import { ${ident} } from '${importPath}';`);
  }
  const next = lines.join('\n');
  return { source: next, changed: next !== source, removed };
}

/** The controller file of a screen (`X.controller.tsx` of a shape, else `X.tsx`) as an import path from `fromDir`, or null when neither exists. */
function controllerImport(root, request, fromDir, config) {
  const cap = request.name;
  const dir = path.join(root, config.features?.root || 'features', request.feature, 'controllers');
  const base = layerFileBaseName('controller', cap);
  const found = [`${base}.controller.tsx`, `${base}.tsx`].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!found) return null;
  const spec = path.relative(fromDir, found.replace(/\.tsx$/, '')).split(path.sep).join('/');
  return spec.startsWith('.') ? spec : `./${spec}`;
}

/**
 * Point the project's route entry at the controller of a generated screen. Next.js: create `<app>/<route>/page.tsx` that renders the
 * controller and nothing else (ROUTE-001 and ROUTE-002 hold). react-spa: add the import and a `<Route>` to the router file, and drop
 * the dangling `CoreController` import the init scaffold leaves (Next.js: it removes the scaffold's root `app/page.tsx` when it still is exactly that dangling page). Writes nothing and says why when there is nothing to do; refuses a
 * route that something else already owns. Deterministic, no model, idempotent.
 *
 * @param {string} root Project root.
 * @param {{ name: string, feature: string, route?: string }} request The controller unit name, its feature and the route (default: the kebab-case of the name).
 * @returns {{ framework: string, route: string, file: string, changed: boolean, removed: string[] }} The route entry file (project-relative), whether it was written, and what it dropped (react-spa: dangling controller names; Next.js: the removed scaffold page).
 * @throws {Error} A usage error for a bad name, feature or route, a controller that does not exist yet, a route already owned, or a router file that has no `<Routes>`.
 *
 * @example
 * generateRouteEntry(root, { name: 'Products', feature: 'products' }); // => { framework: 'nextjs', route: '/products', file: 'app/products/page.tsx', changed: true, removed: [] }
 */
export function generateRouteEntry(root, request) {
  checkRequest(request);
  const route = request.route ?? routePathOf(request.name);
  const { framework, entry, config } = routeTarget(root);
  const ident = `${request.name}Controller`;
  if (framework === 'react-spa') {
    const file = path.join(root, entry);
    if (!fs.existsSync(file)) throw usage(`The route entry ${entry} does not exist. Run "construct init" first, or wire the route by hand.`);
    const importPath = controllerImport(root, request, path.dirname(file), config);
    if (!importPath) throw usage(`The controller ${ident} does not exist yet in feature "${request.feature}": create it first (construct create controller ${request.name} --feature ${request.feature}).`);
    const exists = (spec) => ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx'].some((ext) => fs.existsSync(path.resolve(path.dirname(file), spec + ext)));
    const out = wireRouteSource(fs.readFileSync(file, 'utf8'), { ident, importPath, route, exists });
    if (out.changed) write(file, out.source);
    return { framework, route, file: entry, changed: out.changed, removed: out.removed };
  }
  const relFile = `${entry}${route}/page.tsx`;
  const file = path.join(root, relFile);
  const importPath = controllerImport(root, request, path.dirname(file), config);
  if (!importPath) throw usage(`The controller ${ident} does not exist yet in feature "${request.feature}": create it first (construct create controller ${request.name} --feature ${request.feature}).`);
  const state = routeState(root, request, route);
  if (state.taken && !state.ours) throw usage(`The route ${route} already belongs to another page (${rel(root, path.dirname(file))}). Pick another route, or skip the route step.`);
  if (state.ours) return { framework, route, file: relFile, changed: false, removed: [] };
  write(file, `import { ${ident} } from '${importPath}';\n\nexport default function Page() {\n  return <${ident} />;\n}\n`);
  // The init scaffold's root page renders a CoreController nobody generated: validate flags it (IMPORT-001) and the build cannot resolve it.
  const dangling = danglingRootPage(root, entry);
  if (dangling) fs.rmSync(path.join(root, dangling));
  return { framework, route, file: relFile, changed: true, removed: dangling ? [dangling] : [] };
}

/**
 * What `construct sync` will change for a screen's feature, as the `touches` a plan step declares: the feature's barrel
 * (`index.ts`, `modify`: the controller and the hook are exported from it) and the dependency-cruiser config it regenerates.
 * Sync also refreshes the barrels of other features that have drifted; a step declares only its own feature.
 *
 * @param {string} root Project root.
 * @param {string} feature The feature the screen belongs to.
 * @returns {{ features: string[], files: { path: string, change: 'create'|'modify' }[] }} The declared scope.
 *
 * @example
 * syncTouches(root, 'products').files.map((f) => f.path); // => ['features/products/index.ts', '.dependency-cruiser.cjs']
 */
export function syncTouches(root, feature) {
  const featuresRoot = (loadConfig(root).features?.root || 'features').split('/').filter(Boolean).join('/');
  const cruiser = '.dependency-cruiser.cjs';
  return { features: [feature], files: [{ path: `${featuresRoot}/${feature}/index.ts`, change: 'modify' }, { path: cruiser, change: fs.existsSync(path.join(root, cruiser)) ? 'modify' : 'create' }] };
}

/**
 * The range of `@line/construct-core` a plan would add: this checkout's own version, caret. Exported so any other
 * generator that introduces the same import (not just the wired shape flow) can add the identical line through
 * `addDependency` without duplicating the read of this package's own version.
 *
 * @returns {string} A caret range, for example `^0.9.0`.
 */
export function constructCoreRange() {
  const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  return `^${pkg.version}`;
}

/**
 * The closed choice about `@line/construct-core` (chooser summary shape, id `q-dependency`): raised only when the project has a
 * package.json that lists neither it nor a devDependency of that name, since the typed units import its factories. `add-dependency`
 * carries the exact line it adds; `skip` leaves package.json alone. An unanswered choice uses its default (`add-dependency`), so it
 * never holds a plan back. Reads only; nothing is installed.
 *
 * @param {string} root Project root.
 * @param {string | { option: string }} [answer] An answer to `q-dependency`.
 * @returns {{ question: object, line: string, add: boolean, version: string } | null} The question, the line, whether the plan adds it, or `null` when the project needs nothing.
 *
 * @example
 * dependencyOffer(root)?.line; // => '"@line/construct-core": "^0.9.0"'
 */
export function dependencyOffer(root, answer) {
  if (!fs.existsSync(path.join(root, 'package.json')) || hasTypedContractsDependency(root)) return null;
  const version = constructCoreRange();
  const line = `"${CONSTRUCT_CORE_PACKAGE}": "${version}"`;
  const options = [
    { id: 'add-dependency', label: `Add ${line} to dependencies in package.json`, enabled: true, why: 'The generated units import the typed factories from it; nothing is installed, run your package manager afterwards.' },
    { id: 'skip', label: 'Leave package.json alone', enabled: true, why: 'The generated units cannot resolve their imports until the dependency is there.' },
  ];
  const chosen = answerOf(answer)?.option;
  const known = options.some((o) => o.id === chosen);
  const question = { id: DEPENDENCY_QUESTION_ID, question: `The generated units import "${CONSTRUCT_CORE_PACKAGE}", which this project does not depend on. Add it?`, options, default: 'add-dependency', line, chosen: known ? chosen : null };
  return { question, line, add: (known ? chosen : 'add-dependency') === 'add-dependency', version };
}

const PACKAGE_NAME_RE = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const VERSION_RE = /^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The files an `add.dependency` step touches: `package.json` (`modify`). Read-only and never throws.
 *
 * @param {string} root Project root.
 * @param {{ name: string, version: string }} request The package and its range.
 * @returns {{ path: string, change: 'modify' }[] | null} The file, or `null` for an invalid request or a project with no package.json.
 *
 * @example
 * dependencyTouches(root, { name: '@line/construct-core', version: '^0.9.0' }); // => [{ path: 'package.json', change: 'modify' }]
 */
export function dependencyTouches(root, request) {
  if (typeof request?.name !== 'string' || !PACKAGE_NAME_RE.test(request.name) || typeof request.version !== 'string' || !VERSION_RE.test(request.version)) return null;
  return fs.existsSync(path.join(root, 'package.json')) ? [{ path: 'package.json', change: 'modify' }] : null;
}

/**
 * Add one dependency line to the project's package.json (`dependencies`), keeping the file's indentation and every other line, and
 * never running a package manager: the person installs afterwards. Idempotent: a package already listed (dependency or devDependency)
 * is left alone.
 *
 * @param {string} root Project root.
 * @param {{ name: string, version: string }} request The package (`@line/construct-core`) and its range (`^0.9.0`).
 * @returns {{ file: string, changed: boolean, line: string }} The file (project-relative), whether it was written, and the line added.
 * @throws {Error} A usage error for an invalid package or range, or a missing or unreadable package.json.
 *
 * @example
 * addDependency(root, { name: '@line/construct-core', version: '^0.9.0' }); // => { file: 'package.json', changed: true, line: '"@line/construct-core": "^0.9.0"' }
 */
export function addDependency(root, request) {
  if (typeof request?.name !== 'string' || !PACKAGE_NAME_RE.test(request.name)) throw usage(`"${request?.name ?? ''}" is not a package name such as ${CONSTRUCT_CORE_PACKAGE}.`);
  if (typeof request.version !== 'string' || !VERSION_RE.test(request.version)) throw usage(`"${request.version ?? ''}" is not a version range such as ^0.9.0.`);
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) throw usage('This project has no package.json to add the dependency to.');
  const text = fs.readFileSync(file, 'utf8');
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    throw usage('package.json is not valid JSON, so the dependency cannot be added.');
  }
  const line = `"${request.name}": "${request.version}"`;
  if (pkg.dependencies?.[request.name] || pkg.devDependencies?.[request.name]) return { file: 'package.json', changed: false, line };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [request.name]: request.version };
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? '  ';
  write(file, `${JSON.stringify(pkg, null, indent)}${text.endsWith('\n') ? '\n' : ''}`);
  return { file: 'package.json', changed: true, line };
}
