import path from 'node:path'; import fs from 'node:fs'; import {ensureDir,write,rel} from './fs.mjs'; import {loadConfig} from './config.mjs'; import {validateArchitecture} from './architecture-enforcer.mjs'; import {ConstructError,EXIT_CODES} from './diagnostics.mjs'; import {requestFileText} from './llm-fill.mjs';
// The controller template's own composition (importing a same-named Page
// from the feature's pages/ folder) is Construct's own feature-internal
// convention, not Next.js's -- it works unchanged for either framework.
// What genuinely differs per framework is which file wires the controller
// into the app's actual router in the first place: for nextjs that's a
// physical `app/<route>/page.tsx` (outside the feature entirely -- see
// cli.mjs's init()); for react-spa (#65/#66) it's a `<Route path=...
// element={<XController/>}/>` entry in the centralized src/App.tsx. The
// react-spa template documents that real wiring explicitly instead of
// leaving it an unstated nextjs assumption.
const controllerTemplates={
 nextjs:(n)=>`import { ${n}Page } from '../pages/${n}Page';\n\nexport function ${n}Controller() {\n  return <${n}Page />;\n}\n`,
 'react-spa':(n)=>`import { ${n}Page } from '../pages/${n}Page';\n\n// Registered directly as this route's element by react-router in\n// src/App.tsx (e.g. <Route path="/${n.toLowerCase()}" element={<${n}Controller />} />)\n// -- no per-route page.tsx wrapper file like the Next.js target uses.\nexport function ${n}Controller() {\n  return <${n}Page />;\n}\n`,
};
const templates={
 controller:(n,{framework='nextjs'}={})=>(controllerTemplates[framework]||controllerTemplates.nextjs)(n),
 workflow:(n)=>`import { setup } from 'xstate';\n\nexport const ${n}Workflow = setup({}).createMachine({\n  id: '${n.toLowerCase()}',\n  initial: 'idle',\n  states: { idle: {} }\n});\n`,
 hook:(n)=>`import { useCallback } from 'react';\n\nexport function use${n}() {\n  return { action: useCallback(() => {}, []) };\n}\n`,
 domain:(n)=>`export function ${n}() {\n  return true;\n}\n`,
 // #594 -- takes and forwards the caller's AbortSignal (SERVICE-003, off by default): a stale
 // response that lands after its request is superseded should not, and XState's fromPromise
 // already hands the invoking function a signal for free.
 service:(n)=>`export async function ${n}({ signal }: { signal: AbortSignal }) {\n  const response = await fetch('/api/${n.toLowerCase()}', { method: 'GET', signal });\n  if (!response.ok) throw new Error('Request failed');\n  return response.json();\n}\n`,
 page:(n)=>`import type { ReactNode } from 'react';\n\nexport function ${n}Page(): ReactNode {\n  return <main>${n}</main>;\n}\n`,
 component:(n)=>`export function ${n}() {\n  return <div>${n}</div>;\n}\n`
};
export const folderFor=(layer)=>layer==='hook'?'hooks':layer==='controller'?'controllers':layer==='workflow'?'workflows':layer==='domain'?'domain':layer==='service'?'services':layer==='page'?'pages':'components';

// Reverse of folderFor — which layer a generated file's own parent folder
// name implies. Single source of truth shared by import.mjs's per-file
// fill (porting) and this module's own fillGeneratedFile (scaffolding-from-
// scratch, #101) so both ever call an LLM with exactly the same
// layer-constraint text for a given file, never two copies that could
// drift apart.
export const FOLDER_TO_LAYER={controllers:'controller',workflows:'workflow',hooks:'hook',domain:'domain',services:'service',pages:'page',components:'component'};
/**
 * The layer a generated file belongs to, read from its folder name.
 *
 * @param {string} file Path of a generated file.
 * @returns {string} The layer name, or `'component'` when the folder is not a known layer folder.
 */
export const layerFromGeneratedFile=(file)=>FOLDER_TO_LAYER[path.basename(path.dirname(file))]||'component';

// The rule each layer's generated file must keep obeying, whether a human,
// import's fill, or this module's own create/generate fill writes its real
// body — handed verbatim to whichever LLM does that writing, in its
// prompt, so the constraint is an example the model sees rather than
// something enforced only after the fact by construct validate.
// #522 -- page/component each end with the same reminder: if the JSX genuinely needs a
// conditional or a loop, do not write it inline (PAGE-008/COMPONENT-005) and do not hand-split it
// into a pseudo-Expression yourself either -- `construct refactor extract-expression <file>`
// (packages/core/extractExpression.mjs, #517) is the deterministic block that already does this
// extraction correctly (including EXPR-004/005/006 compliance for the new unit); reach for it
// instead of reinventing the extraction in raw tokens.
const NO_INLINE_JSX_LOGIC='If the JSX needs a conditional or a loop, keep it out of this file rather than writing it inline — a human or bot can mechanically extract it afterward into a compliant named Expression by running `construct refactor extract-expression <this file>`; never hand-author that extraction yourself.';

export const LAYER_CONSTRAINTS={
 domain:'Pure function(s) only. Never write the words fetch, window, document, localStorage, sessionStorage, or navigator anywhere in the file, even in a comment. No React import.',
 service:'Owns an external effect on behalf of the feature. Never import React or any react-related package.',
 workflow:'A state machine (e.g. via xstate\'s setup/createMachine). Never import "react" or any package path containing "react/".',
 hook:'A React hook — the exported function name must start with "use". May import anything.',
 component:`Presentation-only, from props. Never write the substring "controllers/", "workflows/", "services/", or "domain/" anywhere in the file, even in a comment. ${NO_INLINE_JSX_LOGIC}`,
 page:`Presentation composition from props only. Never write "workflows/", "services/", or "domain/" anywhere in the file (even in a comment), never call fetch(), never use useMachine/useActor/createMachine. ${NO_INLINE_JSX_LOGIC}`,
 controller:'Composes hooks/domain/pages for a route and nothing else: it calls hooks and renders its own Page, passing them props. It must contain NO control flow at all (no if/else, loops, switch, or try/catch) and never call fetch() — CONTROLLER-001 rejects both. Any conditional, loop, error handling or async handler belongs in a hook (or workflow/domain function) that the controller calls. No import restrictions.',
};

// Shared by generateLayer and refactor.mjs's move/rename: the filename base a
// layer's naming convention expects for a given capitalized name — a hook
// gets a `use` prefix, page/controller get a suffix, everything else is bare.
export const layerFileBaseName=(layer,cap)=>{
 const suffix=layer==='page'?'Page':layer==='controller'?'Controller':'';
 return layer==='hook'?`use${cap}`:`${cap}${suffix}`;
};

// Epic 1.3 — per-layer template override hook. A project may supply a custom
// template for a layer either via architecture.yml's `templates: { <layer>: <path> }`
// or by placing a file named `<layer>.*` under a `templates/` dir at the project
// root. Custom templates are plain text with `{{Name}}` / `{{name}}` / `{{NAME}}`
// placeholders substituted in (no code execution, no new dependency).
function findCustomTemplate(root,layer,config){
 const configured=config?.templates?.[layer];
 if(configured){const p=path.isAbsolute(configured)?configured:path.join(root,configured); if(fs.existsSync(p))return p;}
 const dir=path.join(root,'templates');
 if(fs.existsSync(dir)){const entry=fs.readdirSync(dir).find(f=>f.replace(/\.[^./]+$/,'')===layer); if(entry)return path.join(dir,entry);}
 return null;
}
function renderCustomTemplate(templatePath,name,cap){
 return fs.readFileSync(templatePath,'utf8').replaceAll('{{Name}}',cap).replaceAll('{{name}}',name).replaceAll('{{NAME}}',name.toUpperCase());
}

// Re-validate freshly generated files against Epic 1.2's enforcer. A failure
// here means Construct's own template produced non-conforming code — an
// internal bug, not a user mistake — so it throws rather than returning a
// normal violation report. Exported so other generators (e.g. Ticket 7.2's
// pageTransformer.mjs, ingesting an externally-authored JSX file) reuse the
// same re-validate-after-write step instead of a second copy of it.
export function selfCheck(root,absFiles){
 const files=absFiles.map(f=>rel(root,f));
 const {violations}=validateArchitecture(root,{files});
 const errors=violations.filter(v=>v.severity==='error');
 if(!errors.length)return;
 const detail=errors.map(v=>`${v.rule} in ${v.file} — ${v.message}`).join('; ');
 // #275: a purely dangling-relative-import failure is NOT the template
 // misbehaving — every template renders valid code on its own; IMPORT-001
 // means the file this one composes hasn't been generated (an incomplete or
 // out-of-order set of layers, which is the caller's input, not our bug).
 // Calling that a "template bug" sent people looking in the wrong place and
 // reported it as an internal error. Only claim a template bug when the
 // generated set is otherwise a valid ordering; this stays as a backstop for
 // any future cross-layer template import, not just controller -> page (which
 // assertLayerPrerequisites below now catches before anything is written).
 if(errors.every(v=>v.rule==='IMPORT-001')) throw new ConstructError(
  `Generated ${files.join(', ')} references a file that doesn't exist yet — ${detail} That's an incomplete or out-of-order set of layers: generate the missing layer first (order: ${LAYER_ORDER.join(' -> ')}), then retry.`,
  {violations:errors,exitCode:EXIT_CODES.USAGE_ERROR}
 );
 throw new ConstructError(
  `Construct generated code that fails its own architecture rules (template bug): ${detail}`,
  {violations:errors,exitCode:EXIT_CODES.INTERNAL_ERROR}
 );
}

// Feature names are conventionally kebab-case (e.g. "cpo-v2") but a type
// identifier can't contain "-"/"_" — PascalCase across those word
// boundaries the same way `cap` elsewhere assumes a single already-capped
// word, so createFeature's own scaffolded types.ts is always valid TS.
//
// #24 handled the "-"/"_" boundaries themselves; #79 closed the gap that
// left: any character the boundary-replace doesn't touch (a leading digit,
// a space, anything outside [-_a-zA-Z0-9]) passed straight through into the
// result untouched, so a feature name like "3d-viewer" silently produced
// "3dViewer" -- a syntactically invalid `export type 3dViewerId` in the
// scaffolded types.ts. Reject that at scaffold time instead of writing it.
const TS_IDENTIFIER_RE=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
// `label` names what is being converted in the error message (default
// "Feature", the original caller); the engine generators (#216) pass
// "Workflow"/"Page"/"Controller"/"Service" so the message stays accurate.
export function pascalCase(name,label='Feature'){
 const result=name.replace(/(^|[-_]+)([a-zA-Z0-9])/g,(_,__,c)=>c.toUpperCase());
 if(!TS_IDENTIFIER_RE.test(result)) throw new ConstructError(
  `${label} name "${name}" can't be turned into a valid TypeScript identifier (got "${result}") — identifiers can't start with a digit and can only contain letters, digits, "_", and "$". Rename the ${label.toLowerCase()}.`,
  {exitCode:EXIT_CODES.USAGE_ERROR}
 );
 return result;
}

/**
 * Scaffold a feature folder: the seven layer directories plus `types.ts` and `index.ts` (the public API). Validates the name before writing anything, then self-checks the result against the architecture rules.
 *
 * @param {string} root Project root.
 * @param {string} name Feature name (must be a legal identifier).
 * @returns {string} Absolute path of the new feature directory.
 *
 * @example
 * createFeature(root, 'billing'); // => '<root>/features/billing'
 */
export function createFeature(root,name){
 // Validate before any side effect: an illegal-identifier name (#79) must
 // fail clearly with nothing written, not leave a half-scaffolded feature
 // directory behind it.
 const capName=pascalCase(name);
 const config=loadConfig(root);
 const base=path.join(root,config.features?.root||'features',name);
 for(const d of ['controllers','workflows','hooks','domain','services','pages','components'])ensureDir(path.join(base,d));
 const typesFile=path.join(base,'types.ts'), indexFile=path.join(base,'index.ts');
 write(typesFile,`export type ${capName}Id = string;\n`);
 write(indexFile,`// Public API for feature: ${name}\n/** Types shared across this feature. */\nexport type * from './types';\n`);
 selfCheck(root,[typesFile,indexFile]);
 return base;
}

/**
 * Create the feature folder first when `feature`'s folder doesn't exist yet — the shared check every
 * writing flow that scaffolds INTO a feature (rather than modifying one that must already be there) runs
 * before it writes a single layer file (#677). Without it, a layer/unit generator happily writes into a
 * feature missing its other layer folders and its `types.ts`/`index.ts`, which only fails later, confusingly,
 * at `construct validate` (SLICE-001) — the person never even sees the feature was never created. Idempotent
 * (a no-op past the first call for the same feature) and safe to call from a loop over several layers.
 *
 * @param {string} root Project root.
 * @param {string} feature Feature name.
 * @returns {boolean} `true` when the feature was just scaffolded, `false` when it already existed.
 *
 * @example
 * ensureFeatureExists(root, 'ownership'); // => true — features/ownership now has its full skeleton
 * ensureFeatureExists(root, 'ownership'); // => false — already there, nothing written
 */
export function ensureFeatureExists(root,feature){
 const config=loadConfig(root);
 const dir=path.join(root,config.features?.root||'features',feature);
 if(fs.existsSync(dir)&&fs.statSync(dir).isDirectory())return false;
 createFeature(root,feature);
 return true;
}

// Pure: compute the {file, content} a layer's template would produce,
// without touching disk. Shared by generateLayer (below, unchanged disk-
// writing behavior) and the Ticket 7.1 pipeline runner (packages/engine/pipeline.mjs),
// which stages the same content into a transactionalWriter buffer instead of
// writing it directly -- so template logic lives in exactly one place either way.
// Pure: where a layer's file for `name` in `feature` would be written, without
// rendering or writing anything. Shared by renderLayer and #275's
// prerequisite check (which needs the path of a layer it is NOT generating).
export function layerTargetFile(root,layer,name,feature,config=loadConfig(root)){
 // #218: same PascalCase + validation as createFeature/the engine generators,
 // before anything is rendered or written, so "refund-request" is
 // RefundRequest everywhere and an illegal name fails clearly with nothing on disk.
 const cap=pascalCase(name,layer[0].toUpperCase()+layer.slice(1));
 const dir=path.join(root,config.features?.root||'features',feature,folderFor(layer));
 return path.join(dir,`${layerFileBaseName(layer,cap)}.tsx`);
}

export function renderLayer(root,layer,name,feature){
 if(!templates[layer])throw new Error(`Unknown layer: ${layer}`);
 const config=loadConfig(root);
 const cap=pascalCase(name,layer[0].toUpperCase()+layer.slice(1));
 const file=layerTargetFile(root,layer,name,feature,config);
 const custom=findCustomTemplate(root,layer,config);
 const content=custom?renderCustomTemplate(custom,name,cap):templates[layer](cap,{framework:config.project?.framework});
 return {file,content};
}

/**
 * Generate one layer file (for example a service or a page) for a feature from its template, write it, and self-check it against the architecture rules. Nothing is written when the request is invalid or a prerequisite layer is missing.
 *
 * @param {string} root Project root.
 * @param {string} layer Layer name (`domain`, `service`, `workflow`, `hook`, `component`, `page`, `controller`).
 * @param {string} name Unit name (turned into a valid identifier).
 * @param {string} feature Feature that owns the file.
 * @returns {string} Absolute path of the file written.
 *
 * @example
 * generateLayer(root, 'service', 'invoice', 'billing');
 */
export function generateLayer(root,layer,name,feature){
 // renderLayer first: it validates the layer name and the identifier (#218)
 // with this layer's own label. Then the #275 prerequisite check — both
 // read-only, so an unbuildable request still leaves nothing on disk, not
 // even a scaffolded feature. Only once the request is known buildable does
 // #677's missing-feature check run (a feature that doesn't exist yet is
 // scaffolded now, so this layer never lands alone in an incomplete one).
 const {file,content}=renderLayer(root,layer,name,feature);
 assertLayerPrerequisites(root,name,feature,[layer]);
 ensureFeatureExists(root,feature);
 write(file,content); // write() ensures the parent dir exists
 selfCheck(root,[file]);
 return file;
}

// Canonical dependency order for a vertical slice: controller's stub template
// imports a same-named page, so page must exist first or IMPORT-001 (a
// dangling relative import) fires — every other layer's stub is
// self-contained. `construct generate layer <name> --layers ...` scaffolds
// one logical unit across several layers in a single command, always in this
// order regardless of the order the caller listed --layers in.
export const LAYER_ORDER=['domain','service','workflow','hook','component','page','controller'];

// #275 — which other layer(s) a layer's own stub template composes, and so
// cannot be generated without. Exactly one exists today: the controller stub
// imports `../pages/<Name>Page`, so a controller generated without its page
// is a dangling import (IMPORT-001) the moment it is written. Declared as data
// rather than hardcoded in one `if` so a future template that composes another
// layer only has to add a line here.
export const LAYER_PREREQUISITES={controller:['page']};

// A prerequisite is satisfied by the file already existing on disk, not just by
// being in the same layer set — `construct create controller X --feature f`
// after the page was created in an earlier command is legitimate and must keep
// working. Extension fallbacks mirror architecture-enforcer's
// resolveRelativeImport, so this agrees with what IMPORT-001 would decide.
const LAYER_FILE_EXTENSIONS=['.tsx','.ts','.jsx','.js'];
function layerFileExists(root,layer,name,feature){
 const base=layerTargetFile(root,layer,name,feature).replace(/\.tsx$/,'');
 return LAYER_FILE_EXTENSIONS.some(ext=>{const p=base+ext; return fs.existsSync(p)&&fs.statSync(p).isFile();});
}

/** Which prerequisite layers are missing for `layers` — `[{layer, requires}]`,
 * empty when the set is buildable. Pure/read-only: never writes. */
export function missingLayerPrerequisites(root,name,feature,layers){
 const requested=new Set(layers);
 const missing=[];
 for(const layer of requested){
  for(const requires of LAYER_PREREQUISITES[layer]||[]){
   if(requested.has(requires))continue;
   if(layerFileExists(root,requires,name,feature))continue;
   missing.push({layer,requires});
  }
 }
 return missing;
}

/** Reject an unbuildable layer combination BEFORE anything is written, with a
 * message that names the real problem and what to do about it — rather than
 * letting the half-written result trip selfCheck's IMPORT-001 afterwards. */
export function assertLayerPrerequisites(root,name,feature,layers){
 const missing=missingLayerPrerequisites(root,name,feature,layers);
 if(!missing.length)return;
 const detail=missing.map(({layer,requires})=>{
  const cap=pascalCase(name,layer[0].toUpperCase()+layer.slice(1));
  const target=rel(root,layerTargetFile(root,requires,name,feature));
  return `a "${layer}" needs a "${requires}" layer (the generated ${cap}${layer==='controller'?'Controller':''} imports ${target}, which doesn't exist)`;
 }).join('; ');
 const needed=[...new Set(missing.map(m=>m.requires))];
 const dropped=[...new Set(missing.map(m=>m.layer))];
 throw new ConstructError(
  `Can't build layers [${[...new Set(layers)].join(', ')}] for "${name}" in feature "${feature}": ${detail}. `+
  `Add ${needed.map(l=>`"${l}"`).join(' and ')} to the layers (e.g. --layers ${LAYER_ORDER.filter(l=>new Set([...layers,...needed]).has(l)).join(',')}), `+
  `create ${needed.map(l=>`it first with \`construct create ${l} ${name} --feature ${feature}\``).join(' and ')}, `+
  `or drop ${dropped.map(l=>`"${l}"`).join(' and ')}. Nothing was written.`,
  {exitCode:EXIT_CODES.USAGE_ERROR}
 );
}

// `onLayer` (optional, #165) is called once per layer immediately after it
// finishes, with `{ layer, file, elapsedSeconds }` -- the only way to get
// genuine per-layer scaffold timing for cli.mjs's `generate layer` console
// output without duplicating this function's unknown-layer validation /
// dependency-ordering elsewhere (which would risk writing some layers
// before discovering a later one is invalid -- a real behavior change).
// Omitting it is a no-op: every existing caller (import.mjs's
// importVertical, every test) is unaffected.
/**
 * Generate several layers of one unit in dependency order (a vertical slice). The whole set is validated up front, so a bad request writes nothing.
 *
 * @param {string} root Project root.
 * @param {string} name Unit name.
 * @param {string} feature Feature that owns the files.
 * @param {string[]} layers Layers to generate; duplicates are ignored.
 * @param {{onLayer?: (info:{layer:string, file:string, elapsedSeconds:number}) => void}} [options] Called after each layer, for per-layer timing output.
 * @returns {string[]} Absolute paths written, in dependency order.
 * @throws {Error} For an unknown layer or an unbuildable combination (for example a controller without a page).
 *
 * @example
 * generateVertical(root, 'invoice', 'billing', ['domain', 'service', 'workflow']);
 */
export function generateVertical(root,name,feature,layers,{onLayer}={}){
 const unique=[...new Set(layers)];
 const unknown=unique.filter(l=>!templates[l]);
 if(unknown.length)throw new Error(`Unknown layer: ${unknown[0]}`);
 // #275: reject an unbuildable combination (e.g. controller without page) for
 // the whole set up front, so a bad request never writes some layers and then
 // fails on a later one.
 assertLayerPrerequisites(root,name,feature,unique);
 const ordered=LAYER_ORDER.filter(l=>unique.includes(l));
 return ordered.map(layer=>{
  const start=process.hrtime.bigint();
  const file=generateLayer(root,layer,name,feature);
  if(onLayer)onLayer({layer,file,elapsedSeconds:Number(process.hrtime.bigint()-start)/1e9});
  return file;
 });
}

// ---- optional LLM fill for a freshly-scaffolded file (#101/Epic 6.5) -----
//
// Mirrors import.mjs's per-file fill exactly in shape (one call per file,
// layer constraint in the prompt, keep the stub's exported identifier
// name, strip code fences from the response) but writes a real
// implementation from scratch rather than porting one from an old source
// file — there is no "old file" here, only the template stub itself and a
// plain description of what it's for (feature + name + layer). Scoped
// strictly to one already-generated file's own body: this function never
// decides which layers/files exist — cli.mjs's generate()/create() call
// generateLayer/generateVertical first, exactly as before, and only then
// optionally call this once per resulting file.
function buildScaffoldFillPrompt({layer,relFile,stubContent,name,feature}){
 return [
  'You are implementing one freshly-scaffolded file of a Construct-architecture project, from scratch (there is no prior/legacy source to port — write a real, working implementation).',
  `Target file: ${relFile} (layer: "${layer}", feature: "${feature}").`,
  `Layer constraint: ${LAYER_CONSTRAINTS[layer]||'none.'}`,
  `Keep the exact exported identifier name(s) already present in the current stub below unchanged — replace only the body with a real, reasonable implementation appropriate for something named "${name}" at this layer. Do not invent unrelated behavior or additional exports.`,
  '',
  '=== CURRENT STUB (this is the file you are rewriting) ===',
  stubContent,
  '',
  'Return ONLY the new, complete file content. No markdown code fences, no explanation, no commentary — just the raw file content that will be written as-is.',
 ].join('\n');
}

// #522 -- rule ids `construct refactor extract-expression` (packages/core/extractExpression.mjs,
// #517) exists to mechanically fix. Kept as a set (not a single rule) so both PAGE-008
// (page layer) and COMPONENT-005 (component layer) are covered by one check.
const EXTRACTABLE_JSX_RULES=new Set(['PAGE-008','COMPONENT-005']);

/**
 * After an LLM fill writes a page or component layer file, checks whether the model's own output
 * introduced inline conditional/loop JSX (PAGE-008/COMPONENT-005) -- the exact shape `construct
 * refactor extract-expression <file>` exists to mechanically fix (#522). Returns the ready-to-run
 * command when it did, else `undefined`. Advisory only, never throws: an LLM producing this shape
 * is a normal outcome to hand off to the deterministic block, not a template bug (selfCheck above
 * is for the latter and is not reused here for that reason).
 *
 * @param {string} root Project root.
 * @param {string} file The just-filled file (page or component layer).
 * @param {string} layer The file's layer.
 * @returns {string|undefined} A `construct refactor extract-expression ...` command, or `undefined` when nothing to extract.
 */
export function extractExpressionHint(root,file,layer){
 if(layer!=='page'&&layer!=='component')return undefined;
 const relFile=rel(root,file);
 const {violations}=validateArchitecture(root,{files:[relFile]});
 return violations.some(v=>EXTRACTABLE_JSX_RULES.has(v.rule))?`construct refactor extract-expression ${relFile}`:undefined;
}

/**
 * Overwrite one already-generated file's stub content with `llm`'s real
 * implementation. `root` is only used to build the file's prompt-relative
 * path (for the same reason import.mjs's fill does — a clearer prompt, not
 * a behavior difference); `file` must already exist (i.e. call this after
 * generateLayer/generateVertical, never instead of it). `llmOptions` is
 * passed straight through to callLlm — see llm.mjs's ollama provider for
 * what it can carry (model/baseUrl). Returns
 * `{ file, status: 'filled'|'rejected'|'failed', reason?, attempts, fixCommand? }` —
 * see llm-fill.mjs; anything but 'filled' leaves the stub untouched. `fixCommand` (#522) is only
 * present when a 'filled' page/component file's own new content trips PAGE-008/COMPONENT-005 —
 * the `construct refactor extract-expression` invocation that mechanically fixes it.
 *
 * @param {string} root Project root (used for the prompt-relative path).
 * @param {string} file An already-generated file; must exist.
 * @param {string} layer The file's layer, whose constraint goes into the prompt.
 * @param {{feature?:string, name?:string, llm?:string, llmOptions?:object}} [options] `llm` names the provider; `llmOptions` (model, baseUrl) is passed to it.
 * @returns {Promise<object>} `{file, status: 'filled'|'rejected'|'failed', reason?, attempts, fixCommand?}`; anything but `filled` leaves the stub untouched.
 */
export async function fillGeneratedFile(root,file,layer,{feature,name,llm,llmOptions}={}){
 const stubContent=fs.readFileSync(file,'utf8');
 const prompt=buildScaffoldFillPrompt({layer,relFile:rel(root,file),stubContent,name,feature});
 // Never write a response that isn't valid code (#144): on rejection or a
 // failed provider call the scaffolded stub stays exactly as generated.
 const outcome=await requestFileText(llm,prompt,llmOptions);
 if(outcome.status==='filled'){
  write(file,outcome.code);
  const fixCommand=extractExpressionHint(root,file,layer);
  if(fixCommand)outcome.fixCommand=fixCommand;
 }
 const {code:_code,...rest}=outcome;
 return {file,...rest};
}
