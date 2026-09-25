// Preview: shows what the timeline shows at the playhead. One <video> follows the topmost unmuted video clip, voice and music clips
// play through <audio> elements, and the subtitle active at the playhead is drawn over the picture (live, before any export).
// A steady clock drives playback; media elements are re-aligned to it when they drift. Nothing here edits the project.
import { api } from './api.mjs';
import { audioMixAt, laneValueAt, opacityAt, zoomAt, zoomWindow } from './effects.mjs';

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
  let muted = false;
  let captions = true;
  // Web Audio: every voice and music element goes through its own gain node into one master node, so volumes above 1 and the master work
  // (an <audio> element's own volume stops at 1). Without Web Audio the clip volume falls back to the element, capped at 1.
  let ctx = null;
  let out = null;
  const nodes = new Map();
  let lines = new Map(); // `${clipId}:${param}` -> the points of the line drawn for it (a muted automation layer is left out: the clip's own constant applies)
  let note = '';
  let ov = null; // a live override while a knob is being turned: { master?, layer?: [id, gain], clip?: [id, gain] }
  function graph() {
    if (ctx === null) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = AC ? new AC() : false;
        if (ctx) { out = ctx.createGain(); out.connect(ctx.destination); }
      } catch { ctx = false; }
    }
    return ctx || null;
  }
  // each clip: element -> upmix to stereo -> split -> a gain per side (the pan) -> merge -> the clip's own gain -> the master
  function wire(id, a) {
    const c = graph();
    let node = null;
    if (c) {
      try {
        const src = c.createMediaElementSource(a);
        const up = c.createGain();
        up.channelCount = 2;
        up.channelCountMode = 'explicit';
        up.channelInterpretation = 'speakers';
        const split = c.createChannelSplitter(2);
        const merge = c.createChannelMerger(2);
        node = { gain: c.createGain(), left: c.createGain(), right: c.createGain() };
        src.connect(up);
        up.connect(split);
        split.connect(node.left, 0);
        split.connect(node.right, 1);
        node.left.connect(merge, 0, 0);
        node.right.connect(merge, 0, 1);
        merge.connect(node.gain);
        node.gain.connect(out);
      } catch { node = null; }
    }
    nodes.set(id, node);
    return node;
  }
  // a short glide to each new value, so a line that moves does not click
  const glide = (param, v) => { if (ctx) param.setTargetAtTime(v, ctx.currentTime, 0.012); else param.value = v; };
  const lineOf = (clipId) => (param) => lines.get(`${clipId}:${param}`);
  function applyGain(c, layer, kind, a) {
    const mix = audioMixAt(c, kind, layer, lineOf(c.id), t - c.start, ov);
    const master = muted ? 0 : (ov && ov.master !== undefined ? ov.master : (project.master ?? 1));
    const node = nodes.has(c.id) ? nodes.get(c.id) : wire(c.id, a);
    if (node) { glide(node.gain.gain, mix.gain); glide(node.left.gain, mix.left); glide(node.right.gain, mix.right); glide(out.gain, master); a.volume = 1; } else a.volume = Math.min(1, mix.gain * master);
    a.muted = muted;
  }

  const layers = (kind) => (project ? project.layers.filter((l) => l.kind === kind && !l.muted) : []);
  // A layer listed first is on top; inside a layer the clip that starts first is on top of a later one it overlaps (same start: the lower id).
  const byStart = (a, b) => a.start - b.start || a.id.localeCompare(b.id);
  const activeClip = (kind, at) => { for (const l of layers(kind)) { const c = [...l.clips].sort(byStart).find((x) => covers(x, at)); if (c) return c; } return null; };
  const total = () => (project ? project.layers.reduce((m, l) => l.clips.reduce((n, c) => Math.max(n, endOf(c)), m), 0) : 0);

  // at speed s a clip plays s ms of its source per ms of the timeline: the element's rate is s (pitch kept) and its position is the source time
  function align(el, clip, at) {
    const speed = clip.speed ?? 1;
    if (el.playbackRate !== speed) el.playbackRate = speed;
    const want = (clip.in + (at - clip.start) * speed) / 1000;
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
      const op = opacityAt(vc, lineOf(vc.id), t - vc.start);
      video.style.opacity = String(Math.round(op * 1000) / 1000);
      // zoom: the window of the picture the export crops, drawn by scaling from the top left and shifting it into view (the picture clips it)
      const z = zoomAt(vc.zoom, t - vc.start);
      if (z > 1.0001) { const w = zoomWindow(vc.zoom, z); video.style.transformOrigin = '0 0'; video.style.transform = `scale(${z}) translate(${-w.left * 100}%, ${-w.top * 100}%)`; } else video.style.transform = '';
      // the picture shows one clip, so an opacity below 1 fades to black here; the export blends it with whatever is underneath: say so
      note = op < 0.999 && layers('video').some((l) => l.clips.some((x) => x.id !== vc.id && covers(x, t))) ? 'Preview fades to black; the export blends the clip underneath.' : '';
      align(video, vc, t);
      if (playing && video.paused) play(video); else if (!playing && !video.paused) video.pause();
    } else {
      video.hidden = true;
      black.hidden = false;
      note = '';
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
          applyGain(c, layer, kind, a);
          align(a, c, t);
          if (playing && a.paused) play(a); else if (!playing && !a.paused) a.pause();
        }
      }
    }
    for (const [id, a] of audios) if (!live.has(id) && !a.paused) a.pause();
    const sub = activeClip('subtitle', t);
    overlay.textContent = sub ? sub.text : '';
    overlay.hidden = !sub || !captions;
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
      lines = new Map(p.layers.filter((l) => l.kind === 'automation' && !l.muted).map((l) => [`${l.link.clipId}:${l.link.param}`, l.points]));
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
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (t >= total()) t = 0;
      base = t;
      wallStart = performance.now();
      playing = true;
      sync();
      raf = requestAnimationFrame(tick);
      return true;
    },
    /** Silence the preview's sound (the project is not changed and the export is not affected). */
    setMuted(on) { muted = Boolean(on); video.muted = muted; for (const a of audios.values()) a.muted = muted; if (out) out.gain.value = muted ? 0 : (project?.master ?? 1); sync(); },
    /** A volume being turned right now, heard before it is saved: { master?, layer?: [layerId, gain], clip?: [clipId, gain] }, or null to stop. */
    override(o) { ov = o; sync(); },
    /** Show or hide the subtitle line drawn over the picture (a preview aid only). */
    setCaptions(on) { captions = Boolean(on); sync(); },
    get muted() { return muted; },
    /** Something the preview cannot show exactly (empty when it shows everything as it will export). */
    get note() { return note; },
    get captions() { return captions; },
    get playing() { return playing; },
    get time() { return t; },
    pause() { pause(); sync(); },
  };
}
