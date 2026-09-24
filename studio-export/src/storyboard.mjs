// The storyboard: the ONLY thing a model produces in Studio, and it is data. A closed set of actions, each with typed,
// bounded arguments; a validator that names every problem with a stable code; a deterministic normal form and hash.
// Nothing here evaluates anything; the recorder maps each action to one fixed Playwright call.
//
// Shape:  { title, scenes: [ { caption, steps: [ { action, ...args } ] } ] }
// A scene's caption is required: it is the narration line, shown and spoken when the scene starts.
import crypto from 'node:crypto';
import { URL_CODES, checkUrl } from './urlpolicy.mjs';

export const LIMITS = Object.freeze({
  maxScenes: 30,
  maxSteps: 60, // across the whole storyboard
  title: 120,
  caption: 240,
  selector: 200,
  text: 200, // fill value
  label: 60, // highlight label
  cardTitle: 80,
  cardSubtitle: 160,
  maxMs: 15000, // one wait / highlight / card
  scrollPx: 5000,
  maxTotalSeconds: 600, // estimated length of the whole video
});

/** Every named validation error (frozen). The planner feeds these back to a model, the UI shows them next to the scene. */
export const ERR = Object.freeze({
  NOT_OBJECT: 'NOT_OBJECT',
  UNKNOWN_KEY: 'UNKNOWN_KEY',
  BAD_TITLE: 'BAD_TITLE',
  BAD_BASE_URL: 'BAD_BASE_URL',
  BASE_URL_MISMATCH: 'BASE_URL_MISMATCH',
  NO_SCENES: 'NO_SCENES',
  TOO_MANY_SCENES: 'TOO_MANY_SCENES',
  TOO_MANY_STEPS: 'TOO_MANY_STEPS',
  BAD_SCENE: 'BAD_SCENE',
  CAPTION_REQUIRED: 'CAPTION_REQUIRED',
  CAPTION_TOO_LONG: 'CAPTION_TOO_LONG',
  BAD_STEPS: 'BAD_STEPS',
  BAD_STEP: 'BAD_STEP',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  MISSING_ARG: 'MISSING_ARG',
  UNKNOWN_ARG: 'UNKNOWN_ARG',
  BAD_ARG_TYPE: 'BAD_ARG_TYPE',
  SELECTOR_TOO_LONG: 'SELECTOR_TOO_LONG',
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  MS_OUT_OF_RANGE: 'MS_OUT_OF_RANGE',
  BAD_KEY: 'BAD_KEY',
  BAD_SCROLL: 'BAD_SCROLL',
  FIRST_STEP_NOT_GOTO: 'FIRST_STEP_NOT_GOTO',
  DURATION_TOO_LONG: 'DURATION_TOO_LONG',
  ...URL_CODES,
});

/** Keys `press` accepts (a closed list, no chords). */
export const KEYS = Object.freeze(['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

// Argument specs: type 'selector' | 'text' | 'url' | 'ms' | 'key' | 'px' | 'to'; required args; defaults fill in when absent.
const A = {
  selector: { type: 'selector', required: true },
  url: { type: 'url', required: true },
  text: (max) => ({ type: 'text', required: true, max }),
};
/** The closed action set. `describe` is for the planner's prompt and the UI. */
export const ACTIONS = Object.freeze({
  goto: { describe: 'open a page of the site (an absolute URL on the same site, or a path such as /pricing)', args: { url: A.url } },
  click: { describe: 'click an element', args: { selector: A.selector } },
  fill: { describe: 'type text into an input', args: { selector: A.selector, text: A.text(LIMITS.text) } },
  press: { describe: 'press one key', args: { key: { type: 'key', required: true } } },
  scroll: { describe: 'scroll by dy pixels (negative is up), to "top" or "bottom", or bring a selector into view (give exactly one)', args: { dy: { type: 'px' }, to: { type: 'to' }, selector: { type: 'selector' } } },
  wait: { describe: 'pause so the viewer can look', args: { ms: { type: 'ms', required: true } } },
  hover: { describe: 'move the pointer over an element', args: { selector: A.selector } },
  highlight: { describe: 'draw a ring and a short label around an element', args: { selector: A.selector, label: { type: 'text', required: true, max: LIMITS.label }, ms: { type: 'ms', default: 2400 } } },
  caption: { describe: 'an extra narration line inside a scene', args: { text: A.text(LIMITS.caption) } },
  card: { describe: 'a full-screen title card', args: { title: { type: 'text', required: true, max: LIMITS.cardTitle }, subtitle: { type: 'text', max: LIMITS.cardSubtitle }, ms: { type: 'ms', default: 3000 } } },
});

const clean = (s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KNOWN_TOP = ['title', 'baseUrl', 'scenes', 'version'];

/** Reading time of a caption in seconds (same rule as the media pipeline: about 14 characters a second, at least 3 s). */
export const readingSeconds = (text) => Math.max(3, text.length * 0.07);

/**
 * Validate and normalise a storyboard. Deterministic: the same input always gives the same output and hash.
 * opts: { baseUrl (the user's URL; goto must stay on its origin), allowPrivateNetwork }.
 * Returns { ok, errors: [{ code, path, message }], storyboard } where storyboard is the normal form when ok.
 */
export function validateStoryboard(sb, opts = {}) {
  const errors = [];
  const err = (code, path, message) => errors.push({ code, path, message });
  const policy = { allowPrivateNetwork: Boolean(opts.allowPrivateNetwork) };

  if (!isObj(sb)) {
    err(ERR.NOT_OBJECT, '', 'the storyboard must be a JSON object { title, scenes }');
    return { ok: false, errors };
  }
  for (const k of Object.keys(sb)) if (!KNOWN_TOP.includes(k)) err(ERR.UNKNOWN_KEY, k, `unknown key "${k}"; allowed: ${KNOWN_TOP.join(', ')}`);

  let baseUrl;
  if (opts.baseUrl !== undefined) {
    const b = checkUrl(opts.baseUrl, { ...policy, sameOrigin: false });
    if (!b.ok) err(ERR.BAD_BASE_URL, 'baseUrl', `${b.code}: ${b.message}`);
    else baseUrl = b.url;
  }
  if (sb.baseUrl !== undefined) {
    const own = typeof sb.baseUrl === 'string' ? checkUrl(sb.baseUrl, { ...policy, sameOrigin: false }) : { ok: false, code: ERR.BAD_BASE_URL, message: 'must be a string' };
    if (!own.ok) err(ERR.BAD_BASE_URL, 'baseUrl', `${own.code}: ${own.message}`);
    else if (baseUrl && new URL(own.url).origin !== new URL(baseUrl).origin) err(ERR.BASE_URL_MISMATCH, 'baseUrl', 'the storyboard names a different site than the one requested');
    else if (!baseUrl) baseUrl = own.url;
  }

  let title = '';
  if (typeof sb.title !== 'string' || !clean(sb.title) || clean(sb.title).length > LIMITS.title) err(ERR.BAD_TITLE, 'title', `title is required, a string of at most ${LIMITS.title} characters`);
  else title = clean(sb.title);

  const scenes = [];
  let stepCount = 0;
  let seconds = 0;
  let sawFirst = false;
  if (!Array.isArray(sb.scenes) || sb.scenes.length === 0) err(ERR.NO_SCENES, 'scenes', 'scenes must be a non-empty array');
  else {
    if (sb.scenes.length > LIMITS.maxScenes) err(ERR.TOO_MANY_SCENES, 'scenes', `at most ${LIMITS.maxScenes} scenes (got ${sb.scenes.length})`);
    sb.scenes.slice(0, LIMITS.maxScenes).forEach((sc, si) => {
      const sp = `scenes[${si}]`;
      if (!isObj(sc)) { err(ERR.BAD_SCENE, sp, 'a scene is an object { caption, steps }'); return; }
      for (const k of Object.keys(sc)) if (k !== 'caption' && k !== 'steps' && k !== 'id') err(ERR.UNKNOWN_KEY, `${sp}.${k}`, `unknown key "${k}" in a scene; allowed: caption, steps`);
      let caption = '';
      if (typeof sc.caption !== 'string' || !clean(sc.caption)) err(ERR.CAPTION_REQUIRED, `${sp}.caption`, 'every scene needs a caption (the narration line)');
      else if (clean(sc.caption).length > LIMITS.caption) err(ERR.CAPTION_TOO_LONG, `${sp}.caption`, `caption is at most ${LIMITS.caption} characters`);
      else caption = clean(sc.caption);
      let sceneSeconds = readingSeconds(caption);
      const steps = [];
      if (sc.steps !== undefined && !Array.isArray(sc.steps)) err(ERR.BAD_STEPS, `${sp}.steps`, 'steps must be an array');
      else {
        (sc.steps || []).forEach((st, ti) => {
          stepCount++;
          if (stepCount > LIMITS.maxSteps) { if (stepCount === LIMITS.maxSteps + 1) err(ERR.TOO_MANY_STEPS, `${sp}.steps[${ti}]`, `at most ${LIMITS.maxSteps} steps in total`); return; }
          const out = normaliseStep(st, `${sp}.steps[${ti}]`, { err, policy, baseUrl });
          if (!out) return;
          if (!sawFirst && out.action !== 'card' && out.action !== 'caption') {
            sawFirst = true;
            if (out.action !== 'goto') err(ERR.FIRST_STEP_NOT_GOTO, `${sp}.steps[${ti}]`, 'the first step (cards and captions aside) must be a goto');
          }
          if (out.action === 'wait' || out.action === 'card' || out.action === 'highlight') sceneSeconds += out.ms / 1000;
          else if (out.action === 'caption') sceneSeconds += readingSeconds(out.text);
          else sceneSeconds += 1;
          steps.push(out);
        });
      }
      seconds += sceneSeconds;
      scenes.push({ id: `s${String(si + 1).padStart(2, '0')}`, caption, steps });
    });
  }
  if (seconds > LIMITS.maxTotalSeconds) err(ERR.DURATION_TOO_LONG, 'scenes', `the video would run about ${Math.round(seconds)} s; the limit is ${LIMITS.maxTotalSeconds} s`);
  if (errors.length) return { ok: false, errors };
  const storyboard = { version: 1, title, ...(baseUrl ? { baseUrl } : {}), scenes };
  return { ok: true, errors: [], storyboard };
}

function normaliseStep(st, path, { err, policy, baseUrl }) {
  if (!isObj(st)) { err(ERR.BAD_STEP, path, 'a step is an object { action, ...args }'); return null; }
  const spec = typeof st.action === 'string' && Object.hasOwn(ACTIONS, st.action) ? ACTIONS[st.action] : null;
  if (!spec) { err(ERR.UNKNOWN_ACTION, `${path}.action`, `unknown action ${JSON.stringify(st.action)}; allowed: ${Object.keys(ACTIONS).join(', ')}`); return null; }
  const out = { action: st.action };
  let ok = true;
  for (const k of Object.keys(st)) if (k !== 'action' && !Object.hasOwn(spec.args, k)) { err(ERR.UNKNOWN_ARG, `${path}.${k}`, `"${k}" is not an argument of ${st.action}; allowed: ${Object.keys(spec.args).join(', ')}`); ok = false; }
  for (const [name, def] of Object.entries(spec.args)) {
    const v = st[name];
    const p = `${path}.${name}`;
    if (v === undefined || v === null || v === '') {
      if (def.required) { err(ERR.MISSING_ARG, p, `${st.action} needs "${name}"`); ok = false; } else if (def.default !== undefined) out[name] = def.default;
      continue;
    }
    const r = coerce(def, v, p, { err, policy, baseUrl });
    if (r === undefined) ok = false; else out[name] = r;
  }
  if (ok && st.action === 'scroll') {
    const given = ['dy', 'to', 'selector'].filter((k) => out[k] !== undefined);
    if (given.length !== 1) { err(ERR.BAD_SCROLL, path, 'scroll needs exactly one of dy, to, selector'); ok = false; }
  }
  if (ok && st.action === 'card' && out.subtitle === undefined) out.subtitle = '';
  return ok ? out : null;
}

function coerce(def, v, p, { err, policy, baseUrl }) {
  switch (def.type) {
    case 'selector':
    case 'text': {
      if (typeof v !== 'string') { err(ERR.BAD_ARG_TYPE, p, 'must be a string'); return undefined; }
      const s = def.type === 'selector' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : clean(v);
      const max = def.type === 'selector' ? LIMITS.selector : def.max;
      if (!s) { err(ERR.MISSING_ARG, p, 'must not be empty'); return undefined; }
      if (s.length > max) { err(def.type === 'selector' ? ERR.SELECTOR_TOO_LONG : ERR.TEXT_TOO_LONG, p, `at most ${max} characters (got ${s.length})`); return undefined; }
      return s;
    }
    case 'url': {
      if (typeof v !== 'string') { err(ERR.BAD_ARG_TYPE, p, 'must be a string'); return undefined; }
      const r = checkUrl(v, { ...policy, baseUrl, sameOrigin: Boolean(baseUrl) });
      if (!r.ok) { err(r.code, p, r.message); return undefined; }
      return r.url;
    }
    case 'ms': {
      if (typeof v !== 'number' || !Number.isFinite(v)) { err(ERR.BAD_ARG_TYPE, p, 'must be a number of milliseconds'); return undefined; }
      if (v < 0 || v > LIMITS.maxMs) { err(ERR.MS_OUT_OF_RANGE, p, `between 0 and ${LIMITS.maxMs} ms (got ${v})`); return undefined; }
      return Math.round(v);
    }
    case 'px': {
      if (typeof v !== 'number' || !Number.isFinite(v)) { err(ERR.BAD_ARG_TYPE, p, 'must be a number of pixels'); return undefined; }
      if (Math.abs(v) > LIMITS.scrollPx) { err(ERR.BAD_SCROLL, p, `between -${LIMITS.scrollPx} and ${LIMITS.scrollPx} px (got ${v})`); return undefined; }
      return Math.round(v);
    }
    case 'to': {
      if (v !== 'top' && v !== 'bottom') { err(ERR.BAD_SCROLL, p, 'must be "top" or "bottom"'); return undefined; }
      return v;
    }
    case 'key': {
      if (typeof v !== 'string' || !KEYS.includes(v)) { err(ERR.BAD_KEY, p, `key must be one of: ${KEYS.join(', ')}`); return undefined; }
      return v;
    }
    default:
      err(ERR.BAD_ARG_TYPE, p, 'unsupported argument'); return undefined;
  }
}

/** Canonical JSON of a normalised storyboard (key order is fixed by the normaliser). */
export const canonicalJson = (sb) => JSON.stringify(sb);
/** SHA-256 (hex) of the canonical form: the approval gate compares this. */
export const hashStoryboard = (sb) => crypto.createHash('sha256').update(canonicalJson(sb)).digest('hex');

/** The action set as JSON Schema-like text for a model's system prompt and for the UI's editor. */
export function describeActions() {
  return Object.entries(ACTIONS).map(([name, spec]) => ({
    action: name,
    describe: spec.describe,
    args: Object.fromEntries(Object.entries(spec.args).map(([k, d]) => [k, { type: d.type, required: Boolean(d.required), ...(d.max ? { max: d.max } : {}), ...(d.default !== undefined ? { default: d.default } : {}) }])),
  }));
}
