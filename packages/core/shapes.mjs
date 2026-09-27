// #619 (part of epic #616) -- screen shapes: a named recipe whose typed templates fill the units of a feature with real,
// rule-conforming code instead of empty stubs. `list` is the first shape: a screen that lists the items of an entity, with
// loading, empty and error states. #620 adds `detail` (one item by id: loading, not found, ready, error), #626 adds `form` (a typed
// input per field, validation in a domain unit, a submit service), #627 adds `dashboard` (a titled overview of tiles and panels from one typed summary) and #628 adds `wizard` (a multi-step flow run by a state machine in the workflow layer). A person confirms a plan and gets a screen that WORKS, with no
// model involved.
//
//   construct create layer Products --feature products --layers domain,service,hook,component,page,controller \
//     --shape list --entity Product --fields id:string,name:string,price:number
//   (--shape detail: shape-detail.mjs, --shape form: shape-form.mjs, --shape dashboard: shape-dashboard.mjs, --shape wizard: shape-wizard.mjs; this file holds the list templates, the request and the writing)
//
//   shapeFiles(root, request)            pure: the files one layer of the shape writes, `{ path, content, change, layer }`
//   shapeTouches(root, request)          the same files as a plan step's `touches.files` (project-relative, no content)
//   generateShapeLayer / generateShapeVertical   write them, then check them against the project's own rules (selfCheck)
//
// Nothing here calls a model or the network, and the output is a pure function of (shape, entity, fields, unit name, feature,
// framework, and the current types.ts): the same request writes the same bytes, a second run included. Every unit is built with
// the typed factory of its layer (defineDomain, defineService, defineComponent, defineExpression, definePage, defineController,
// useTrackedState from `@line/construct-core/typed-contracts`) and is named `Name.layer.ext` (rule READ-004), so it passes
// `construct validate` with the typed-contracts phase 1 rules on. Record of the decisions: docs/PLACEMENT.md, "The list shape".
import fs from 'node:fs';
import path from 'node:path';
import { write, rel } from './fs.mjs';
import { loadConfig } from './config.mjs';
import { ConstructError, EXIT_CODES } from './diagnostics.mjs';
import { LAYER_ORDER, ensureFeatureExists, pascalCase, selfCheck } from './generators.mjs';
import { PLAN_SHAPES } from './plan.mjs';
import { FIELD_TYPES, TYPED_CONTRACTS_SPECIFIER, cap, importLine, lines, lowerFirst, operationComment, rowText, sampleRows, show, ts, words } from './shape-kit.mjs';
import { operationOf, readSource, storeNames } from './shape-source.mjs';
import { findEntityOperation } from './openapi-spec.mjs';
import { DETAIL_SHAPE } from './shape-detail.mjs';
import { FORM_SHAPE } from './shape-form.mjs';
import { DASHBOARD_SHAPE, dashboardBaseOf } from './shape-dashboard.mjs';
import { WIZARD_SHAPE, parseSteps } from './shape-wizard.mjs';
import { DEFAULT_STATES, STATES_SHAPES, readStates, stateNames, stateView, stateImports, stateComponentFiles, viewsOf } from './shape-states.mjs';

const usage = (message) => new ConstructError(message, { exitCode: EXIT_CODES.USAGE_ERROR });

export { TYPED_CONTRACTS_SPECIFIER, FIELD_TYPES };

/** Most fields a shape takes: a row of the list stays readable. */
export const MAX_FIELDS = 12;

/** The fields used when none are given. */
export const DEFAULT_FIELDS = 'id:string,name:string';

// ------------------------------------------------------------------------------------------------------------- names


/**
 * The singular of a PascalCase plural name, by small fixed rules: categories to Category, boxes to Box, statuses to Status,
 * products to Product. A name the rules leave unchanged (Inventory, Sheep) gets `Item` appended, so the entity never
 * shares its name with the list.
 *
 * @param {string} name A PascalCase unit name such as `Products`.
 * @returns {string} The entity name, for example `Product`.
 *
 * @example
 * singularOf('Categories'); // => 'Category'
 * singularOf('Inventory'); // => 'InventoryItem'
 */
export function singularOf(name) {
  let out = name;
  if (/[^aeiou]ies$/i.test(name)) out = `${name.slice(0, -3)}y`;
  else if (/(?:s|x|z|ch|sh)es$/i.test(name)) out = name.slice(0, -2);
  else if (/s$/i.test(name) && !/(?:ss|us|is)$/i.test(name)) out = name.slice(0, -1);
  return out === name ? `${name}Item` : out;
}

/**
 * The plural of a PascalCase singular name, by small fixed rules (the reverse of `singularOf`): Category to Categories, Box to Boxes,
 * Product to Products. Used for the endpoint of a detail or a form (`/api/products`).
 *
 * @param {string} name A PascalCase entity name such as `Product`.
 * @returns {string} The plural, for example `Products`.
 *
 * @example
 * pluralOf('Category'); // => 'Categories'
 */
export function pluralOf(name) {
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  return `${name}s`;
}

/**
 * The endpoint a shaped list fetches, from its unit name: `Products` is `/api/products`, `OrderItems` is `/api/order-items`.
 *
 * @param {string} name A PascalCase unit name.
 * @returns {string} The path the generated service requests.
 *
 * @example
 * endpointOf('OrderItems'); // => '/api/order-items'
 */
export function endpointOf(name) {
  return `/api/${words(name).join('-').toLowerCase()}`;
}

/**
 * Read a `--fields` value: `name:type` pairs separated by commas (`id:string,name:string,price:number`). A type is `string`,
 * `number` or `boolean`; a name is camelCase and unique; an `id` field (the row key) is required.
 *
 * @param {string|undefined} text The fields, or nothing for the default `id:string,name:string`.
 * @returns {{ name: string, type: 'string'|'number'|'boolean' }[]} The fields, in the order given.
 * @throws {Error} A usage error naming the first problem, for the CLI and the plan runner.
 *
 * @example
 * parseFields('id:string,price:number'); // => [{ name: 'id', type: 'string' }, { name: 'price', type: 'number' }]
 */
export function parseFields(text) {
  const spec = text === undefined || text === null || String(text).trim() === '' ? DEFAULT_FIELDS : String(text);
  const fields = [];
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, type, ...rest] = part.split(':').map((p) => p.trim());
    if (!name || !type || rest.length) throw usage(`Field "${part}" must be name:type, for example price:number.`);
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw usage(`Field name "${name}" must be camelCase letters and digits, starting with a lowercase letter.`);
    if (!Object.hasOwn(FIELD_TYPES, type)) throw usage(`Field "${name}" has type "${type}"; the types are ${Object.keys(FIELD_TYPES).join(', ')}.`);
    if (fields.some((f) => f.name === name)) throw usage(`Field "${name}" is listed twice.`);
    fields.push({ name, type });
  }
  if (fields.length > MAX_FIELDS) throw usage(`A shape takes at most ${MAX_FIELDS} fields (got ${fields.length}).`);
  const id = fields.find((f) => f.name === 'id');
  if (!id) throw usage('The fields need an "id" field (the key of a row), for example id:string.');
  if (id.type === 'boolean') throw usage('The "id" field must be a string or a number.');
  return fields;
}

const NUMBER_PROPERTY = /(?:price|amount|total|cost|count|quantity|qty|rating|score|balance|age)$/i;
const BOOLEAN_PROPERTY = /^(?:is|has|can)[A-Z]|^(?:active|enabled|archived|done|completed|published|paid)$/;

/**
 * The `--fields` text for the properties of a requirement card's entity: `id:string` first, then each property with a type
 * read off its name (price, amount, count and the like are numbers; isActive and the like are booleans; the rest are strings).
 * Properties that describe the screen rather than the data (`interactive`, `session`, `role`) are left out.
 *
 * @param {string[]} [properties] The entity noun's properties from the card.
 * @returns {string} For example `id:string,name:string,price:number`; `id:string,name:string` when there are none.
 *
 * @example
 * fieldsFromProperties(['name', 'price']); // => 'id:string,name:string,price:number'
 */
export function fieldsFromProperties(properties = []) {
  const skipped = new Set(['interactive', 'session', 'role', 'id']);
  const names = [...new Set(properties.filter((p) => typeof p === 'string' && /^[a-z][A-Za-z0-9]*$/.test(p) && !skipped.has(p)))];
  if (!names.length) return DEFAULT_FIELDS;
  const typeOf = (n) => (NUMBER_PROPERTY.test(n) ? 'number' : BOOLEAN_PROPERTY.test(n) ? 'boolean' : 'string');
  return ['id:string', ...names.slice(0, MAX_FIELDS - 1).map((n) => `${n}:${typeOf(n)}`)].join(',');
}

/**
 * Everything a shape's templates need, worked out from a request: the names of every generated identifier and file, the fields
 * and which of them is the title of a row. Throws a usage error for a bad name, entity or field list, before anything is written.
 *
 * @param {string} root Project root (its architecture.yml decides the framework).
 * @param {{ shape: string, name: string, feature: string, entity?: string, fields?: string, source?: string, steps?: string, states?: string }} request The shape, the unit name (`Products`), the feature and the optional entity, fields, data source (`local`, `endpoint` (what none means) or `openapi`, #621), for the wizard its steps (`details,review,done`) and, for a list, detail or dashboard, how its states are shown (`default` (what none means), `custom`, `skip-empty` or `skip-all`, #622).
 * @returns {object} The resolved context (`names`, `fields`, `title`, `entityPlural`, `steps` (the wizard's steps, else `null`), `endpoint`, `useClient`, `source`, `operation` (the OpenAPI operation of the `openapi` source, else `null`), `store` (the identifiers of the local store), `states` (how the states are shown, #622), `views` (what each state shows: notice, custom or skip; `null` for a shape without fetch states) and `stateNames` (the custom state components, else `null`)).
 * @throws {Error} A usage error naming the problem.
 *
 * @example
 * shapeContext(root, { shape: 'list', name: 'products', feature: 'shop' }).names.hook; // => 'useProducts'
 */
export function shapeContext(root, request) {
  if (!PLAN_SHAPES.includes(request?.shape) || !Object.hasOwn(SHAPES, request.shape)) throw usage(`Unknown shape "${request?.shape}". The shapes are: ${Object.keys(SHAPES).join(', ')}.`);
  const shape = SHAPES[request.shape];
  const Name = pascalCase(String(request.name ?? ''), 'Shape unit');
  const Entity = request.entity === undefined || request.entity === '' ? shape.defaultEntity(Name) : pascalCase(String(request.entity), 'Entity');
  if (Entity !== String(request.entity ?? Entity)) throw usage(`Entity "${request.entity}" must be PascalCase, for example ${Entity}.`);
  const fields = parseFields(request.fields);
  if (request.steps !== undefined && request.steps !== '' && request.shape !== 'wizard') throw usage(`--steps only applies to the wizard shape (it is the steps of the flow), not to ${request.shape}.`);
  let steps = null;
  if (request.shape === 'wizard') {
    try {
      steps = parseSteps(request.steps);
    } catch (e) {
      throw usage(e.message);
    }
  }
  if (shape.inputFieldsOnly && !fields.some((f) => f.name !== 'id')) throw usage(`The ${request.shape} shape needs at least one field besides "id" (the server assigns it), for example id:string,name:string.`);
  if (request.shape === 'dashboard' && fields.some((f) => f.name === 'count')) throw usage('The dashboard shape keeps the number of rows in "count", so a field cannot be named that. Rename the field, for example itemCount.');
  const dataSource = readSource(request.source);
  const states = readStates(request.states, request.shape);
  const wanted = operationOf(request.shape);
  const operation = dataSource === 'openapi' ? findEntityOperation(root, { kind: wanted.kind, plural: pluralOf(Entity) }) : null;
  if (dataSource === 'openapi' && !operation) {
    const path = `/${pluralOf(Entity).toLowerCase()}${wanted.tail}`;
    throw usage(`The openapi source needs an OpenAPI file (openapi.yaml, openapi.yml or openapi.json, at the project root or in api/) with the operation ${wanted.method} on a path ending in ${path}. Nothing was written; choose the local or endpoint source, or add the operation to the spec.`);
  }
  const store = storeNames(request.shape, Name);
  const names = shape.names(Name, Entity);
  const views = STATES_SHAPES.includes(request.shape) ? viewsOf(states, request.shape) : null;
  const customNames = states === 'custom' ? stateNames(Name, request.shape) : null;
  const generated = [...Object.entries(names).filter(([role]) => role !== 'Name' && role !== 'Entity').map(([, identifier]) => identifier), ...(dataSource === 'local' ? [store.seed, store.op] : []), ...(customNames ? Object.values(customNames).filter((n) => typeof n === 'string' && !n.endsWith('Props')) : [])];
  const pool = [...generated, Entity, ...(shape.nameMayEqualEntity ? [] : [Name])];
  const clashes = pool.filter((n, i, all) => all.indexOf(n) !== i);
  if (clashes.length) throw usage(`The unit name "${Name}" and the entity "${Entity}" produce clashing names (${[...new Set(clashes)].join(', ')}); give the entity a different name with --entity.`);
  const stringFields = fields.filter((f) => f.type === 'string' && f.name !== 'id');
  const title = fields.find((f) => ['name', 'title', 'label'].includes(f.name) && f.type === 'string') ?? stringFields[0] ?? fields.find((f) => f.name === 'id');
  const config = loadConfig(root);
  const framework = config.project?.framework ?? 'nextjs';
  return {
    request: { shape: request.shape, name: Name, feature: request.feature, entity: Entity, fields: fields.map((f) => `${f.name}:${f.type}`).join(','), source: dataSource, ...(states !== DEFAULT_STATES ? { states } : {}), ...(steps ? { steps: steps.map((st) => st.name).join(',') } : {}) },
    names, fields, title, source: dataSource, operation, store, steps, states, views, stateNames: customNames,
    plural: words(Name).join(' ').toLowerCase(), singular: words(Entity).join(' ').toLowerCase(), entityPlural: words(pluralOf(Entity)).join(' ').toLowerCase(), heading: words(Name).map(cap).join(' '),
    endpoint: operation ? operation.url : shape.endpoint(Name, Entity),
    useClient: framework !== 'react-spa',
  };
}

// ------------------------------------------------------------------------------------------------------------ templates

/** The declarations a list shape shares between layers: the entity, the state of the screen and the answer of the service. */
function typesBlocks(ctx) {
  const { names, fields, singular, plural } = ctx;
  return [
    { declares: names.Entity, text: lines(`/** One ${singular}, as the ${plural} list shows it. */`, `export interface ${names.Entity} {`, fields.map((f) => `  ${f.name}: ${ts(f)};`), '}') },
    { declares: names.state, text: lines(`/** What the ${plural} list is doing: loading, showing rows (possibly none) or failed. */`, `export type ${names.state} =`, `  | { status: 'loading' }`, `  | { status: 'ready'; items: ${names.Entity}[] }`, `  | { status: 'error'; message: string };`) },
    { declares: names.result, text: lines(`/** What the ${plural} service answers: a \`${names.state}\` that is no longer loading. */`, `export type ${names.result} = Exclude<${names.state}, { status: 'loading' }>;`) },
  ];
}

function domainFile(ctx) {
  const { names, title, plural } = ctx;
  const compare = title.type === 'string' ? `a.${title.name}.localeCompare(b.${title.name})` : title.type === 'number' ? `a.${title.name} - b.${title.name}` : `Number(a.${title.name}) - Number(b.${title.name})`;
  return lines(
    importLine('defineDomain'), `import type { ${names.Entity} } from '../types';`, '',
    `/** The ${plural} ordered by ${title.name}, without changing the list it is given. */`,
    `export const ${names.sort} = defineDomain<{ items: readonly ${names.Entity}[] }, ${names.Entity}[]>('${names.sort}', ({ items }) =>`,
    `  [...items].sort((a, b) => ${compare}),`, ');',
  );
}

function serviceFile(ctx) {
  const { names, fields, endpoint, plural } = ctx;
  const checks = fields.map((f) => `typeof row.${f.name} === '${f.type}'`).join(' && ');
  return lines(
    importLine('defineService'), `import type { ${names.Entity}, ${names.result} } from '../types';`, operationComment(ctx.operation), '',
    `function is${names.Entity}(value: unknown): value is ${names.Entity} {`,
    `  if (typeof value !== 'object' || value === null) return false;`,
    `  const row = value as Record<string, unknown>;`,
    `  return ${checks};`, '}', '',
    `/** Fetches the ${plural} list. Forwards the caller's AbortSignal and answers with a typed result: a failed request, a bad status or a wrong shape is an error result, never a throw. */`,
    `export const ${names.fetch} = defineService('${names.fetch}', async ({ signal }: { signal: AbortSignal }): Promise<${names.result}> => {`,
    '  try {',
    `    const response = await fetch('${endpoint}', { signal });`,
    `    if (!response.ok) return { status: 'error', message: \`The server answered \${response.status}.\` };`,
    '    const body: unknown = await response.json();',
    `    if (!Array.isArray(body) || !body.every(is${names.Entity})) return { status: 'error', message: 'The server did not answer with a list of ${ctx.plural}.' };`,
    `    return { status: 'ready', items: body };`,
    '  } catch (error) {',
    `    return { status: 'error', message: error instanceof Error ? error.message : 'The request failed.' };`,
    '  }', '});',
  );
}

/** @returns {string} `domain/<Name>Store.domain.ts` (the `local` source): the seed rows and the pure read of a set of rows, as the result the service answers. */
function storeFile(ctx) {
  const { names, store, plural } = ctx;
  return lines(
    importLine('defineDomain'), `import type { ${names.Entity}, ${names.result} } from '../types';`, '',
    `/** The seed rows of the local ${plural} store: what the screen shows until it reads from a real source. Pure. */`,
    `export const ${store.seed} = defineDomain<Record<string, never>, ${names.Entity}[]>('${store.seed}', () => [`,
    sampleRows(names.Entity, ctx.fields).map((row) => `  ${rowText(row)},`), ']);', '',
    `/** Reads a set of ${plural} rows as the result the ${plural} service answers: every row, ready. Pure. */`,
    `export const ${store.op} = defineDomain<{ rows: readonly ${names.Entity}[] }, ${names.result}>('${store.op}', ({ rows }) => ({ status: 'ready', items: [...rows] }));`,
  );
}

/** @returns {string} `services/<Name>.service.ts` (the `local` source): the same typed result as the network service, read from the store in memory. */
function localServiceFile(ctx) {
  const { names, store, plural } = ctx;
  return lines(
    importLine('defineService'), `import { ${store.op}, ${store.seed} } from '../domain/${store.file}.domain';`, `import type { ${names.Entity}, ${names.result} } from '../types';`, '',
    `/** The ${plural} of the local store: the seed rows, held in memory. It is this screen's whole backend until a real source replaces it. */`,
    `const rows: ${names.Entity}[] = ${store.seed}({});`, '',
    `/** Reads the ${plural} from the local store and answers with the same typed result as a network source. Takes the caller's AbortSignal like one: a cancelled request is an error result, never a throw. */`,
    `export const ${names.fetch} = defineService('${names.fetch}', async ({ signal }: { signal: AbortSignal }): Promise<${names.result}> => {`,
    `  if (signal.aborted) return { status: 'error', message: 'The request was cancelled.' };`,
    `  return ${store.op}({ rows });`, '});',
  );
}

function hookFile(ctx) {
  const { names } = ctx;
  return lines(
    ctx.useClient ? ["'use client';", ''] : [],
    `import { useEffect } from 'react';`, importLine('useTrackedState'),
    `import { ${names.sort} } from '../domain/${names.Name}.domain';`, `import { ${names.fetch} } from '../services/${names.Name}.service';`, `import type { ${names.state} } from '../types';`, '',
    `/** Loads the ${ctx.plural} once, and holds what the screen shows: loading, the sorted rows or an error. The request is aborted when the screen goes away. */`,
    `export function ${names.hook}(): ${names.state} {`,
    `  const [state, setState] = useTrackedState<${names.state}>('${lowerFirst(names.Name)}', { status: 'loading' });`,
    '  useEffect(() => {', '    const controller = new AbortController();',
    `    ${names.fetch}({ signal: controller.signal }).then((result) => {`,
    '      if (controller.signal.aborted) return;',
    `      setState(result.status === 'ready' ? { status: 'ready', items: ${names.sort}({ items: result.items }) } : result);`,
    '    });', '    return () => controller.abort();', '  }, [setState]);', '  return state;', '}',
  );
}

function rowFile(ctx) {
  const { names, fields, title, singular } = ctx;
  const others = fields.filter((f) => f.name !== 'id' && f !== title);
  return lines(
    importLine('defineComponent'), `import type { ${names.Entity} } from '../types';`, '',
    `export interface ${names.rowProps} {`, `  item: ${names.Entity};`, '}', '',
    `/** One ${singular} as a row of the list. */`,
    `export const ${names.row} = defineComponent<${names.rowProps}>('${names.row}', ({ item }) => (`,
    '  <li>', `    <strong>{${show(title)}}</strong>`, others.flatMap((f) => ["    {' '}", `    <span>{\`${f.name}: \${${show(f)}}\`}</span>`]), '  </li>', '));',
  );
}

function listFile(ctx) {
  const { names, heading, singular } = ctx;
  return lines(
    `import type { ReactNode } from 'react';`, importLine('defineComponent'), '',
    `export interface ${names.listProps} {`, '  children?: ReactNode;', '}', '',
    `/** The list the ${singular} rows sit in. */`,
    `export const ${names.list} = defineComponent<${names.listProps}>('${names.list}', ({ children }) => <ul aria-label="${heading}">{children}</ul>);`,
  );
}

function noticeFile(ctx) {
  const { names, plural } = ctx;
  return lines(
    importLine('defineComponent'), '',
    `export interface ${names.noticeProps} {`, `  role: 'status' | 'alert';`, '  text: string;', '}', '',
    `/** A short message in place of the ${plural} list: loading, empty or an error. */`,
    `export const ${names.notice} = defineComponent<${names.noticeProps}>('${names.notice}', ({ role, text }) => <p role={role}>{text}</p>);`,
  );
}

function expressionFile(ctx) {
  const { names, plural } = ctx;
  const loading = stateView(ctx, 'loading', `<${names.notice} role="status" text="Loading ${plural}..." />`);
  const failed = stateView(ctx, 'error', `<${names.notice} role="alert" text={state.message} />`);
  return lines(
    importLine('defineExpression'),
    `import { ${names.list} } from '../components/${names.list}.component';`, `import { ${names.row} } from '../components/${names.row}.component';`, stateImports(ctx, ['loading', 'error']),
    `import type { ${names.state} } from '../types';`, '',
    `export interface ${names.expressionProps} {`, `  state: ${names.state};`, '}', '',
    `/** Decides what the ${plural} screen shows: a loading or error notice, its children when there are no rows, else the rows. */`,
    `export const ${names.expression} = defineExpression<${names.expressionProps}>('${names.expression}', ({ state, children }) => {`,
    `  if (state.status === 'loading') return ${loading ?? '<></>'};`,
    `  if (state.status === 'error') return ${failed ?? '<></>'};`,
    '  if (state.items.length === 0) return <>{children}</>;',
    `  const rows = state.items.map((item) => <${names.row} key={String(item.id)} item={item} />);`,
    `  return <${names.list}>{rows}</${names.list}>;`, '});',
  );
}

function pageFile(ctx) {
  const { names, plural, heading } = ctx;
  const empty = stateView(ctx, 'empty', `<${names.notice} role="status" text="No ${plural} yet." />`);
  return lines(
    importLine('definePage'),
    stateImports(ctx, ['empty']), `import { ${names.expression} } from '../expressions/${names.expression}.expression';`, `import type { ${names.state} } from '../types';`, '',
    `export interface ${names.pageProps} {`, `  state: ${names.state};`, '}', '',
    `/** The ${plural} screen, from props: a heading, and the list with its loading, empty and error states. */`,
    `export const ${names.page} = definePage<${names.pageProps}>('${names.page}', ({ state }) => (`,
    '  <main>', `    <h1>${heading}</h1>`, empty ? [`    <${names.expression} state={state}>`, `      ${empty}`, `    </${names.expression}>`] : `    <${names.expression} state={state} />`, '  </main>', '));',
  );
}

function controllerFile(ctx) {
  const { names, plural } = ctx;
  return lines(
    ctx.useClient ? ["'use client';", ''] : [],
    importLine('defineController'), `import { ${names.hook} } from '../hooks/${names.hook}.state';`, `import { ${names.page} } from '../pages/${names.page}.page';`, '',
    `/** Wires the ${plural} hook to the ${plural} page: no logic of its own. */`,
    `export const ${names.controller} = defineController<Record<string, never>>('${names.controller}', () => {`,
    `  const state = ${names.hook}();`, `  return <${names.page} state={state} />;`, '});',
  );
}

/** The write verbs a form shape's unit name may start with (`AddProduct`), which are not part of the entity name. */
export const FORM_VERBS = Object.freeze(['create', 'add', 'submit', 'save', 'register', 'update']);

/** The entity of a form unit name when none is given: the name without its leading write verb (`AddProduct` is `Product`), else the name itself. */
function formEntityOf(Name) {
  const [first, ...rest] = words(Name);
  return rest.length && FORM_VERBS.includes(first.toLowerCase()) ? rest.map(cap).join('') : Name;
}

/** The entity of a dashboard unit name when none is given: the name without its trailing Dashboard word, singularised (`OrdersDashboard` is `Order`); a base the rules leave unchanged (`OrderDashboard`) is kept as it is. */
function dashboardEntityOf(Name) {
  const base = dashboardBaseOf(Name);
  const one = singularOf(base);
  return one === `${base}Item` ? base : one;
}

/**
 * The shapes and what each one writes. A layer entry lists its files as `{ folder, base, content }`: the folder under the
 * feature, the file name including the `.layer` suffix (rule READ-004) and the text. `requires` are the layers a layer's
 * files import, which must be in the same request or already exist.
 */
export const SHAPES = Object.freeze({
  list: Object.freeze({
    summary: 'A screen that lists the items of an entity, with loading, empty and error states.',
    defaultEntity: singularOf,
    endpoint: (Name) => endpointOf(Name),
    names: (Name, Entity) => ({
      Name, Entity,
      state: `${Name}State`, result: `${Name}Result`, fetch: `fetch${Name}`, sort: `sort${Name}`, hook: `use${Name}`,
      page: `${Name}Page`, pageProps: `${Name}PageProps`, controller: `${Name}Controller`, expression: `${Name}ByStatus`, expressionProps: `${Name}ByStatusProps`,
      row: `${Entity}Row`, rowProps: `${Entity}RowProps`, list: `${Entity}List`, listProps: `${Entity}ListProps`, notice: `${Name}Notice`, noticeProps: `${Name}NoticeProps`,
    }),
    layers: Object.freeze(['domain', 'service', 'hook', 'component', 'page', 'controller']),
    requires: Object.freeze({ service: ['domain'], hook: ['service', 'domain'], component: ['domain'], page: ['component', 'domain'], controller: ['hook', 'page'] }),
    files: (ctx) => ({
      domain: [{ folder: 'domain', base: `${ctx.names.Name}.domain.ts`, content: domainFile(ctx) }, ...(ctx.source === 'local' ? [{ folder: 'domain', base: `${ctx.store.file}.domain.ts`, content: storeFile(ctx) }] : [])],
      service: [{ folder: 'services', base: `${ctx.names.Name}.service.ts`, content: ctx.source === 'local' ? localServiceFile(ctx) : serviceFile(ctx) }],
      hook: [{ folder: 'hooks', base: `${ctx.names.hook}.state.ts`, content: hookFile(ctx) }],
      component: [
        { folder: 'components', base: `${ctx.names.row}.component.tsx`, content: rowFile(ctx) },
        { folder: 'components', base: `${ctx.names.list}.component.tsx`, content: listFile(ctx) },
        ...stateComponentFiles(ctx, noticeFile),
      ],
      page: [
        { folder: 'pages', base: `${ctx.names.page}.page.tsx`, content: pageFile(ctx) },
        { folder: 'expressions', base: `${ctx.names.expression}.expression.tsx`, content: expressionFile(ctx) },
      ],
      controller: [{ folder: 'controllers', base: `${ctx.names.controller}.controller.tsx`, content: controllerFile(ctx) }],
    }),
    types: typesBlocks,
  }),
  detail: Object.freeze({ ...DETAIL_SHAPE, defaultEntity: (Name) => Name, endpoint: (Name, Entity) => endpointOf(pluralOf(Entity)), nameMayEqualEntity: true }),
  form: Object.freeze({ ...FORM_SHAPE, defaultEntity: formEntityOf, endpoint: (Name, Entity) => endpointOf(pluralOf(Entity)), nameMayEqualEntity: false, inputFieldsOnly: true }),
  dashboard: Object.freeze({ ...DASHBOARD_SHAPE, defaultEntity: dashboardEntityOf, endpoint: (Name, Entity) => `${endpointOf(pluralOf(Entity))}/summary`, nameMayEqualEntity: false }),
  wizard: Object.freeze({ ...WIZARD_SHAPE, defaultEntity: (Name) => Name, endpoint: (Name, Entity) => endpointOf(pluralOf(Entity)), nameMayEqualEntity: true, inputFieldsOnly: true }),
});

// ------------------------------------------------------------------------------------------------------------- files

const featureDir = (root, feature) => path.join(root, loadConfig(root).features?.root || 'features', feature);

/** The text of `types.ts` once the shape's declarations are in it: an existing declaration is kept, a missing one is appended. */
function typesText(root, feature, ctx) {
  const file = path.join(featureDir(root, feature), 'types.ts');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = SHAPES[ctx.request.shape].types(ctx).filter((b) => !new RegExp(`export\\s+(?:interface|type)\\s+${b.declares}\\b`).test(current));
  if (!missing.length) return current;
  return `${current === '' ? '' : `${current.replace(/\n*$/, '\n')}\n`}${missing.map((b) => b.text).join('\n')}`;
}

/**
 * The files one layer of a shape writes, without touching the disk: `{ path (absolute), content, change, layer }`. The domain
 * layer also owns `types.ts` (an existing declaration is kept, a missing one is appended), so its list ends with that file
 * as a `modify`. The page layer writes its Expression beside the page (`expressions/`), because a page may not hold conditional JSX.
 *
 * @param {string} root Project root.
 * @param {{ shape: string, layer: string, name: string, feature: string, entity?: string, fields?: string }} request What to generate.
 * @returns {{ path: string, content: string, change: 'create'|'modify', layer: string }[]} The files, in write order.
 * @throws {Error} A usage error for an unknown shape or layer, or a bad name, entity or field list.
 *
 * @example
 * shapeFiles(root, { shape: 'list', layer: 'page', name: 'Products', feature: 'shop' }).map((f) => path.basename(f.path));
 * // => ['ProductsPage.page.tsx', 'ProductsByStatus.expression.tsx']
 */
export function shapeFiles(root, request) {
  const ctx = shapeContext(root, request);
  const shape = SHAPES[request.shape];
  if (!shape.layers.includes(request.layer)) throw usage(`The ${request.shape} shape has no "${request.layer}" layer. Its layers are: ${shape.layers.join(', ')}.`);
  if (!request.feature) throw usage('A shape needs the feature it belongs to.');
  const dir = featureDir(root, request.feature);
  const out = shape.files(ctx)[request.layer].map((f) => ({ path: path.join(dir, f.folder, f.base), content: f.content, change: 'create', layer: request.layer }));
  if (request.layer === 'domain') out.push({ path: path.join(dir, 'types.ts'), content: typesText(root, request.feature, ctx), change: 'modify', layer: 'domain' });
  return out;
}

/**
 * The files a shaped plan step will write, as its `touches.files`: project-relative POSIX paths with the change kind and the
 * layer. Read-only and never throws: a request that does not name a valid shaped unit yet answers `null`.
 *
 * @param {string} root Project root.
 * @param {{ shape: string, layer: string, name: string, feature: string, entity?: string, fields?: string }} request The step's arguments.
 * @returns {{ path: string, change: 'create'|'modify', layer: string }[] | null} The files, or `null`.
 *
 * @example
 * shapeTouches(root, { shape: 'list', layer: 'domain', name: 'Products', feature: 'shop' }).map((f) => `${f.change} ${f.path}`);
 * // => ['create features/shop/domain/Products.domain.ts', 'modify features/shop/types.ts']
 */
export function shapeTouches(root, request) {
  try {
    return shapeFiles(root, request).map((f) => ({ path: rel(root, f.path), change: f.change, layer: f.layer }));
  } catch {
    return null;
  }
}

/** The main file of a shape layer (the first it lists; every file of the domain layer, whose second file is the `local` store the service imports), used to tell whether a required layer already exists on disk. */
function layerExists(root, request, layer) {
  const listed = SHAPES[request.shape].files(shapeContext(root, request))[layer] ?? [];
  const needed = layer === 'domain' ? listed : listed.slice(0, 1);
  return needed.length > 0 && needed.every((f) => fs.existsSync(path.join(featureDir(root, request.feature), f.folder, f.base)));
}

/**
 * Refuse a layer set that would leave an import dangling, before anything is written: every layer a requested layer imports
 * must be in the set or already exist. Names the missing layers and the layer list to use.
 *
 * @param {string} root Project root.
 * @param {{ shape: string, name: string, feature: string, entity?: string, fields?: string }} request The shape request (without a layer).
 * @param {string[]} layers The layers about to be generated.
 * @throws {Error} A usage error when a required layer is missing.
 *
 * @example
 * assertShapeLayers(root, { shape: 'list', name: 'Products', feature: 'shop' }, ['domain', 'service']);
 */
export function assertShapeLayers(root, request, layers) {
  const shape = SHAPES[request.shape];
  if (!shape) throw usage(`Unknown shape "${request.shape}". The shapes are: ${Object.keys(SHAPES).join(', ')}.`);
  const unknown = layers.filter((l) => !shape.layers.includes(l));
  if (unknown.length) throw usage(`The ${request.shape} shape has no "${unknown[0]}" layer. Its layers are: ${shape.layers.join(', ')}.`);
  const wanted = new Set(layers);
  const missing = [];
  for (const layer of wanted) {
    for (const needed of shape.requires[layer] ?? []) {
      if (!wanted.has(needed) && !layerExists(root, request, needed)) missing.push({ layer, needed });
    }
  }
  if (!missing.length) return;
  const needed = [...new Set(missing.map((m) => m.needed))];
  const all = shape.layers.filter((l) => wanted.has(l) || needed.includes(l));
  throw usage(`The ${request.shape} shape's ${[...new Set(missing.map((m) => m.layer))].join(', ')} import${missing.length === 1 ? 's' : ''} ${needed.join(', ')}, which ${needed.length === 1 ? "isn't" : "aren't"} in this request and don't exist yet. Add ${needed.length === 1 ? 'it' : 'them'} to the layers (--layers ${all.join(',')}). Nothing was written.`);
}

/**
 * Generate one layer of a shape: write its files, then check them against the project's own architecture rules (`selfCheck`,
 * which throws when Construct's own template would break a rule). Deterministic: the same request writes the same bytes.
 *
 * @param {string} root Project root.
 * @param {{ shape: string, layer: string, name: string, feature: string, entity?: string, fields?: string }} request What to generate.
 * @returns {string[]} The absolute paths written, in write order.
 * @throws {Error} For a bad request, a missing required layer, or output that fails the rules.
 *
 * @example
 * generateShapeLayer(root, { shape: 'list', layer: 'domain', name: 'Products', feature: 'shop' });
 */
export function generateShapeLayer(root, request) {
  assertShapeLayers(root, request, [request.layer]);
  ensureFeatureExists(root, request.feature); // #677: a missing feature is scaffolded first, not silently written into
  const files = shapeFiles(root, request);
  for (const f of files) write(f.path, f.content);
  selfCheck(root, files.map((f) => f.path));
  return files.map((f) => f.path);
}

/**
 * Generate several layers of a shape in dependency order (the same order as `construct create layer`). The whole set is
 * validated first, so a bad request writes nothing; each layer is self-checked after it is written.
 *
 * @param {string} root Project root.
 * @param {{ shape: string, name: string, feature: string, entity?: string, fields?: string }} request The shape request (without a layer).
 * @param {string[]} layers The layers to generate; duplicates are ignored.
 * @param {{ onLayer?: (info: { layer: string, files: string[], elapsedSeconds: number }) => void }} [options] Called after each layer, for timing output.
 * @returns {string[]} The absolute paths written, in dependency order.
 * @throws {Error} For a bad request or an unbuildable layer set (nothing is written then).
 *
 * @example
 * generateShapeVertical(root, { shape: 'list', name: 'Products', feature: 'shop' }, ['domain', 'service', 'hook', 'component', 'page', 'controller']);
 */
export function generateShapeVertical(root, request, layers, { onLayer } = {}) {
  const unique = [...new Set(layers)];
  shapeContext(root, request); // a bad name, entity or field list writes nothing
  assertShapeLayers(root, request, unique);
  const written = [];
  for (const layer of LAYER_ORDER.filter((l) => unique.includes(l))) {
    const start = process.hrtime.bigint();
    const files = generateShapeLayer(root, { ...request, layer });
    if (onLayer) onLayer({ layer, files, elapsedSeconds: Number(process.hrtime.bigint() - start) / 1e9 });
    written.push(...files);
  }
  return written;
}

/**
 * Whether the project's package.json depends on `@line/construct-core`, which the generated units import their factories from.
 *
 * @param {string} root Project root.
 * @returns {boolean} `true` when it is a dependency or devDependency; `false` when it is not or there is no package.json.
 *
 * @example
 * hasTypedContractsDependency(root); // => false in a fresh `construct init` project
 */
export function hasTypedContractsDependency(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return !!(pkg.dependencies?.['@line/construct-core'] || pkg.devDependencies?.['@line/construct-core']);
  } catch {
    return false;
  }
}
