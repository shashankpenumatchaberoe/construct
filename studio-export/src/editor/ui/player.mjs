// Preview: shows what the timeline shows at the playhead. One <video> follows the topmost unmuted video clip, voice and music clips
// play through <audio> elements, and the subtitle active at the playhead is drawn over the picture (live, before any export).
// A steady clock drives playback; media elements are re-aligned to it when they drift. Nothing here edits the project.
import { api } from './api.mjs';

const endOf = (c) => c.start + c.duration;
const covers = (c, t) => t >= c.start && t < endOf(c);

export function createPlayer({ video, overlay, black, onTime, onEnd }) {
  let project = null;
  let t = 0;
  let playing = false;
  let raf = 0;
  let wallStart = 0;
  let base = 0;
  const audios = new Map();
  let videoSrc = null;

  const layers = (kind) => (project ? project.layers.filter((l) => l.kind === kind && !l.muted) : []);
  const activeClip = (kind, at) => { for (const l of layers(kind)) { const c = l.clips.find((x) => covers(x, at)); if (c) return c; } return null; };
  const total = () => (project ? project.layers.reduce((m, l) => l.clips.reduce((n, c) => Math.max(n, endOf(c)), m), 0) : 0);

  function align(el, clip, at) {
    const want = (clip.in + at - clip.start) / 1000;
    if (Math.abs(el.currentTime - want) > 0.25 || !playing) { try { el.currentTime = want; } catch { /* metadata not loaded yet */ } }
  }
  const play = (el) => { const p = el.play(); if (p && p.catch) p.catch(() => {}); };

  function sync() {
    const vc = activeClip('video', t);
    if (vc) {
      const url = api.mediaUrl(vc.src);
      if (videoSrc !== url) { videoSrc = url; video.src = url; }
      video.hidden = false;
      black.hidden = true;
      align(video, vc, t);
      if (playing && video.paused) play(video); else if (!playing && !video.paused) video.pause();
    } else {
      video.hidden = true;
      black.hidden = false;
      if (!video.paused) video.pause();
    }
    const live = new Set();
    for (const kind of ['voice', 'music']) {
      for (const layer of layers(kind)) {
        for (const c of layer.clips) {
          if (!covers(c, t)) continue;
          live.add(c.id);
          let a = audios.get(c.id);
          if (!a) { a = new Audio(api.mediaUrl(c.src)); a.preload = 'auto'; audios.set(c.id, a); }
          a.volume = Math.min(1, c.gain !== undefined ? c.gain : kind === 'music' ? 0.04 : 1);
          align(a, c, t);
          if (playing && a.paused) play(a); else if (!playing && !a.paused) a.pause();
        }
      }
    }
    for (const [id, a] of audios) if (!live.has(id) && !a.paused) a.pause();
    const sub = activeClip('subtitle', t);
    overlay.textContent = sub ? sub.text : '';
    overlay.hidden = !sub;
  }

  function tick() {
    t = base + (performance.now() - wallStart);
    if (t >= total()) {
      t = total();
      pause();
      sync();
      onTime(t);
      if (onEnd) onEnd();
      return;
    }
    sync();
    onTime(t);
    raf = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    video.pause();
    for (const a of audios.values()) a.pause();
  }

  return {
    setProject(p) {
      project = p;
      const ids = new Set(p.layers.flatMap((l) => l.clips.map((c) => c.id)));
      for (const [id, a] of audios) if (!ids.has(id)) { a.pause(); audios.delete(id); }
      if (t > total()) t = total();
      sync();
    },
    seek(ms) {
      t = Math.max(0, Math.min(ms, total()));
      base = t;
      wallStart = performance.now();
      sync();
      return t;
    },
    toggle() {
      if (playing) { pause(); sync(); return false; }
      if (t >= total()) t = 0;
      base = t;
      wallStart = performance.now();
      playing = true;
      sync();
      raf = requestAnimationFrame(tick);
      return true;
    },
    get playing() { return playing; },
    get time() { return t; },
    pause() { pause(); sync(); },
  };
}
