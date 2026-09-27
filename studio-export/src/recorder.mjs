// The recorder: runs a validated storyboard in a real browser (Playwright recordVideo, one context per run) and writes the
// caption timeline. Every action maps to ONE fixed call below; a model's text only ever reaches the page as data (a
// selector Playwright parses, a string typed into an input, or textContent). The Playwright module is injected.
//
// Outputs (all inside `outDir`): <slug>.webm and <slug>.captions.json ([{ id, text, start, end? }], seconds from the start
// of the video, the same shape packages/tools/media reads).
import fs from 'node:fs';
import path from 'node:path';
import { readingSeconds, validateStoryboard } from './storyboard.mjs';
import { checkUrl } from './urlpolicy.mjs';

export const RECORDER_ERR = Object.freeze({
  INVALID_STORYBOARD: 'RECORD_INVALID_STORYBOARD',
  BAD_SLUG: 'RECORD_BAD_SLUG',
  NO_BROWSER: 'RECORD_NO_BROWSER',
  STEP_FAILED: 'RECORD_STEP_FAILED',
  ABORTED: 'RECORD_ABORTED',
  NO_VIDEO: 'RECORD_NO_VIDEO',
});
export class RecorderError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'RecorderError'; this.code = code; Object.assign(this, extra); }
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const STEP_TIMEOUT_MS = 8000;
const NAV_TIMEOUT_MS = 20000;

// --- in-page helpers: fixed source, called with data arguments only ---------------------------------------------------

const CURSOR_SCRIPT = () => {
  const boot = () => {
    if (document.getElementById('studio-cursor')) return;
    const style = document.createElement('style');
    style.textContent = '#studio-cursor{position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;'
      + 'border:3px solid #6c97ff;background:rgba(108,151,255,.22);box-shadow:0 0 0 4px rgba(108,151,255,.18);z-index:2147483647;pointer-events:none;transition:transform .12s ease}'
      + '#studio-cursor.down{transform:scale(.72)}';
    document.head.appendChild(style);
    const dot = document.createElement('div');
    dot.id = 'studio-cursor';
    dot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dot);
    const place = (e) => { dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px'; };
    addEventListener('mousemove', place, true);
    addEventListener('mousedown', (e) => { place(e); dot.classList.add('down'); }, true);
    addEventListener('mouseup', () => dot.classList.remove('down'), true);
  };
  if (document.body) boot(); else addEventListener('DOMContentLoaded', boot);
};

const showCaption = ([text]) => {
  let el = document.getElementById('studio-caption');
  if (!el) {
    el = document.createElement('div');
    el.id = 'studio-caption';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:88%;z-index:2147483646;padding:12px 22px;border-radius:12px;'
      + 'background:rgba(13,15,18,.92);color:#fff;font:600 24px/1.3 system-ui,sans-serif;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = text;
};

const showRing = ([b, label, ms]) => {
  const ring = document.createElement('div');
  ring.className = 'studio-highlight';
  ring.setAttribute('aria-hidden', 'true');
  ring.style.cssText = `position:fixed;left:${b.x - 4}px;top:${b.y - 4}px;width:${b.width + 8}px;height:${b.height + 8}px;border:2px solid #f5a524;border-radius:8px;`
    + 'box-shadow:0 0 0 4px rgba(245,165,36,.25);z-index:2147483645;pointer-events:none';
  const tag = document.createElement('div');
  tag.className = 'studio-highlight';
  tag.setAttribute('aria-hidden', 'true');
  tag.textContent = label;
  const below = b.y + b.height + 40 < window.innerHeight;
  tag.style.cssText = `position:fixed;left:${Math.max(8, Math.min(b.x, window.innerWidth - 220))}px;top:${below ? b.y + b.height + 10 : Math.max(8, b.y - 36)}px;max-width:210px;`
    + 'padding:5px 10px;border-radius:6px;background:#f5a524;color:#1a1200;font:600 14px/1.3 system-ui,sans-serif;z-index:2147483645;pointer-events:none';
  document.body.append(ring, tag);
  setTimeout(() => document.querySelectorAll('.studio-highlight').forEach((e) => e.remove()), ms);
};

const showCard = ([title, subtitle]) => {
  document.getElementById('studio-card')?.remove();
  const el = document.createElement('div');
  el.id = 'studio-card';
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;'
    + 'background:#0d0f12;color:#f2f4f7;font-family:system-ui,sans-serif;text-align:center;padding:24px';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:48px;font-weight:700';
  h.textContent = title;
  const s = document.createElement('div');
  s.style.cssText = 'font-size:24px;color:#b7bfcc;max-width:900px';
  s.textContent = subtitle;
  el.append(h, s);
  document.body.appendChild(el);
};

// ----------------------------------------------------------------------------------------------------------------------

/** Pure timeline object; `now()` is injectable so tests get exact numbers. */
export function createTimeline(now = Date.now) {
  let t0 = now();
  const lines = [];
  return {
    reset() { t0 = now(); lines.length = 0; },
    stamp(text) { lines.push({ text, start: Math.round(now() - t0) / 1000 }); },
    elapsed: () => (now() - t0) / 1000,
    /** Lines with ids and ends: end = the next start minus 0.1 s, capped at the reading time; the last gets its reading time. */
    toJSON(totalSeconds) {
      return lines.map((l, i) => {
        const next = lines[i + 1];
        const cap = l.start + readingSeconds(l.text);
        const end = next ? Math.min(cap, next.start - 0.1) : Math.min(cap, totalSeconds ?? cap);
        return { id: `l${String(i + 1).padStart(2, '0')}`, text: l.text, start: l.start, end: Math.round(Math.max(end, l.start + 0.2) * 1000) / 1000 };
      });
    },
  };
}

/**
 * Record `storyboard` (validated again here; never records an unvalidated one).
 *   { storyboard, outDir, config, playwright, onEvent, slug, signal, now }
 * Returns { ok, slug, video, captions, seconds, error? }. On a failed step the browser is closed so the video so far is kept.
 */
export async function recordStoryboard({ storyboard, outDir, config, playwright, onEvent = () => {}, slug, signal, now = Date.now }) {
  const emit = (type, data = {}) => { try { onEvent({ stage: 'record', type, ...data }); } catch { /* an observer must not break a recording */ } };
  const rec = { width: 1280, height: 720, pace: 1, burnCaptions: true, ...(config?.recording || {}) };
  const allowPrivateNetwork = Boolean(config?.allowPrivateNetwork);
  const v = validateStoryboard(storyboard, { baseUrl: storyboard?.baseUrl, allowPrivateNetwork });
  if (!v.ok) throw new RecorderError(RECORDER_ERR.INVALID_STORYBOARD, `the storyboard is not valid: ${v.errors[0].path}: ${v.errors[0].message}`, { errors: v.errors });
  const sb = v.storyboard;
  slug = slug || `video-${Math.floor(now() / 1000).toString(36)}`;
  if (!SLUG_RE.test(slug)) throw new RecorderError(RECORDER_ERR.BAD_SLUG, `bad slug "${slug}"`);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, `.rec-${slug}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const timeline = createTimeline(now);
  const pace = Math.min(4, Math.max(0.25, Number(rec.pace) || 1));
  let browser, context, page;
  let failure = null;
  const total = sb.scenes.reduce((n, s) => n + s.steps.length, 0);
  let stepNo = 0;

  const hold = (ms) => (ms > 0 ? page.waitForTimeout(Math.round(ms * pace)) : Promise.resolve());
  const aborted = () => signal?.aborted;

  async function announce(text) {
    timeline.stamp(text);
    emit('caption', { text, at: timeline.elapsed() });
    if (rec.burnCaptions) await page.evaluate(showCaption, [text]);
  }

  async function glide(selector) {
    try {
      const box = await page.locator(selector).first().boundingBox({ timeout: 2000 });
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
    } catch { /* the action itself reports a missing element */ }
  }

  async function run(step) {
    switch (step.action) {
      case 'goto': await page.goto(step.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }); await hold(400); break;
      case 'click': await glide(step.selector); await page.click(step.selector); await hold(500); break;
      case 'hover': await glide(step.selector); await page.hover(step.selector); await hold(500); break;
      case 'fill': await glide(step.selector); await page.fill(step.selector, step.text); await hold(400); break;
      case 'press': await page.keyboard.press(step.key); await hold(400); break;
      case 'scroll':
        if (step.selector) await page.locator(step.selector).first().scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
        else await page.evaluate(([dy, to]) => window.scrollTo({ top: to === 'top' ? 0 : to === 'bottom' ? document.documentElement.scrollHeight : window.scrollY + dy, behavior: 'smooth' }), [step.dy ?? 0, step.to ?? null]);
        await hold(900);
        break;
      case 'wait': await hold(step.ms); break;
      case 'highlight': {
        const box = await page.locator(step.selector).first().boundingBox({ timeout: STEP_TIMEOUT_MS });
        if (!box) throw new Error(`nothing visible matches "${step.selector}"`);
        await page.evaluate(showRing, [box, step.label, Math.round(step.ms * pace)]);
        await hold(step.ms);
        break;
      }
      case 'caption': await announce(step.text); await hold(readingSeconds(step.text) * 1000); break;
      case 'card': {
        timeline.stamp(step.subtitle ? `${step.title}. ${step.subtitle}` : step.title);
        emit('caption', { text: step.title, at: timeline.elapsed() });
        await page.evaluate(showCard, [step.title, step.subtitle]);
        await hold(Math.max(step.ms, 1500));
        await page.evaluate(() => document.getElementById('studio-card')?.remove());
        break;
      }
      default: throw new Error(`unknown action ${step.action}`);
    }
  }

  emit('start', { slug, scenes: sb.scenes.length, steps: total });
  try {
    try {
      browser = await playwright.chromium.launch({ headless: true });
    } catch (e) {
      throw new RecorderError(RECORDER_ERR.NO_BROWSER, `could not start Chromium: ${String(e.message).split('\n')[0]}. Run: npx playwright install chromium`);
    }
    context = await browser.newContext({ viewport: { width: rec.width, height: rec.height }, recordVideo: { dir: tmp, size: { width: rec.width, height: rec.height } } });
    context.setDefaultTimeout?.(STEP_TIMEOUT_MS);
    if (!allowPrivateNetwork && typeof context.route === 'function') {
      // The request guard: even a link on a public page cannot pull the recording to a local or private address.
      await context.route('**/*', (route) => {
        const u = route.request().url();
        if (/^https?:/i.test(u) && !checkUrl(u, { allowPrivateNetwork: false }).ok) return route.abort('blockedbyclient');
        return route.continue();
      });
    }
    page = await context.newPage();
    timeline.reset();
    await page.addInitScript?.(CURSOR_SCRIPT);

    for (const [si, scene] of sb.scenes.entries()) {
      if (aborted()) throw new RecorderError(RECORDER_ERR.ABORTED, 'the recording was cancelled');
      emit('scene', { index: si, count: sb.scenes.length, caption: scene.caption });
      const sceneStart = timeline.elapsed();
      // The first scene opens its page before the caption is stamped, so the narration never plays over a blank page;
      // in every other scene the caption is stamped first and the steps run while it is on screen.
      let steps = scene.steps;
      if (si === 0 && steps[0]?.action === 'goto') {
        stepNo++;
        emit('step', { index: stepNo, total, action: 'goto', done: false });
        try { await run(steps[0]); } catch (e) { throw stepError(stepNo, steps[0], e); }
        emit('step', { index: stepNo, total, action: 'goto', done: true });
        steps = steps.slice(1);
      }
      await announce(scene.caption);
      for (const step of steps) {
        if (aborted()) throw new RecorderError(RECORDER_ERR.ABORTED, 'the recording was cancelled');
        stepNo++;
        emit('step', { index: stepNo, total, action: step.action, done: false });
        try { await run(step); } catch (e) { throw stepError(stepNo, step, e); }
        emit('step', { index: stepNo, total, action: step.action, done: true });
      }
      // Hold until the caption has been readable for its reading time, so scenes do not cut the narration off.
      const spent = timeline.elapsed() - sceneStart;
      const need = readingSeconds(scene.caption) + 0.4;
      if (spent < need) await hold((need - spent) * 1000 / pace);
    }
    await hold(700);
  } catch (e) {
    failure = e instanceof RecorderError ? e : new RecorderError(RECORDER_ERR.STEP_FAILED, e.message);
  }

  const seconds = Math.round(timeline.elapsed() * 1000) / 1000;
  let videoTmp = null;
  try { videoTmp = page ? await page.video?.()?.path?.() : null; } catch { /* no video */ }
  try { await page?.close?.(); } catch { /* already closed */ }
  try { await context?.close?.(); } catch { /* already closed */ }
  try { await browser?.close?.(); } catch { /* already closed */ }

  const result = { ok: false, slug, seconds };
  const file = (ext) => path.join(outDir, `${slug}${ext}`);
  try {
    if (videoTmp && fs.existsSync(videoTmp)) {
      fs.renameSync(videoTmp, file('.webm'));
      result.video = file('.webm');
    } else if (!failure) failure = new RecorderError(RECORDER_ERR.NO_VIDEO, 'the browser produced no video');
    fs.writeFileSync(file('.captions.json'), JSON.stringify(timeline.toJSON(seconds), null, 2) + '\n');
    result.captions = file('.captions.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failure) {
    result.error = { code: failure.code, message: failure.message, ...(failure.step ? { step: failure.step } : {}) };
    emit('error', { ...result.error });
  } else {
    result.ok = true;
    emit('done', { slug, seconds, video: path.basename(result.video) });
  }
  return result;
}

function stepError(index, step, e) {
  const first = String(e?.message || e).split('\n')[0];
  return new RecorderError(RECORDER_ERR.STEP_FAILED, `step ${index} (${step.action}) failed: ${first}`, { step: { index, action: step.action } });
}
