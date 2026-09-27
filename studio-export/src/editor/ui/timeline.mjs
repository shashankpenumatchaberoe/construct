// The timeline widget: one row per layer, clips as draggable, resizable blocks, a ruler and a playhead. The drawing, dragging,
// zooming and panning are vis-timeline's (vendored in vendor/, Apache-2.0 OR MIT); this file only maps our project onto it and
// reports what the user did. It never edits: a drop is reported as (clip, new start, new end, new layer) and app.mjs sends it
// to the server as an op, then hands the answer back through setProject().
import { h, fmt, icon } from './dom.mjs';
import { createKnob, formatDb } from './knob.mjs';
import { createLineWidget } from './lane.mjs';

const vis = window.vis;
const SNAP_PX = 8;

export function createTimeline(el, on) {
  const items = new vis.DataSet();
  const groups = new vis.DataSet();
  let byId = new Map();
  let playhead = 0;
  let projectTotal = 0;
  let want = null; // { layerId, index, until }: a point that should hold the keyboard focus
  let widgets = new Map(); // automation layer id -> its line widget (rebuilt with every project)
  let dragging = false;

  const labelFor = (date, scale) => {
    const ms = Number(date.valueOf());
    if (scale === 'millisecond') return `${Math.floor(ms / 1000)}.${String(((ms % 1000) + 1000) % 1000).padStart(3, '0')}`;
    return fmt(ms).replace(/\.0$/, '');
  };
  const timeline = new vis.Timeline(el, items, groups, {
    orientation: { axis: 'top' },
    stack: false,
    showCurrentTime: false,
    min: new Date(-2000),
    max: new Date(60 * 60 * 1000),
    zoomMin: 1000,
    zoomMax: 60 * 60 * 1000,
    zoomKey: 'ctrlKey', // Ctrl + wheel and a trackpad pinch zoom; a plain wheel or swipe is handled below
    selectable: true,
    multiselect: true, // Ctrl or Shift + click adds and removes clips
    itemsAlwaysDraggable: { item: true, range: true },
    editable: { add: false, remove: false, updateTime: true, updateGroup: true, overrideItems: false },
    margin: { item: { horizontal: 0, vertical: 5 }, axis: 4 },
    snap: null,
    groupOrder: 'order',
    moment: (d) => vis.moment(d).utc(),
    format: { minorLabels: labelFor, majorLabels: () => '' },
    tooltip: { followMouse: true, overflowMethod: 'cap', delay: 400 },
    onMoving(item, callback) {
      const orig = byId.get(item.id);
      if (!orig) return callback(null);
      // Several selected clips dragged together: no snapping (each clip would snap differently and the spacing would change) and no layer change.
      const picked = timeline.getSelection();
      if (picked.length > 1 && picked.includes(item.id) && Math.round(item.end.getTime()) - Math.round(item.start.getTime()) === orig.duration) {
        item.group = orig.layerId;
        return callback(item);
      }
      let start = Math.round(item.start.getTime());
      let end = Math.round(item.end.getTime());
      const msPerPx = (timeline.getWindow().end - timeline.getWindow().start) / Math.max(1, el.clientWidth);
      const edges = [playhead];
      for (const c of byId.values()) if (c.id !== orig.id) edges.push(c.start, c.start + c.duration);
      const near = (ms) => { let best = null; for (const e of edges) { const d = Math.abs(e - ms); if (d <= SNAP_PX * msPerPx && (best === null || d < best.d)) best = { e, d }; } return best; };
      const resizedStart = end === orig.start + orig.duration && start !== orig.start;
      const resizedEnd = start === orig.start && end !== orig.start + orig.duration;
      const a = resizedEnd ? null : near(start);
      const b = resizedStart ? null : near(end);
      if (a && (!b || a.d <= b.d)) { end += a.e - start; start = a.e; } else if (b) { start += b.e - end; end = b.e; }
      if (resizedStart) { const s = near(start); if (s) start = s.e; }
      if (resizedEnd) { const s = near(end); if (s) end = s.e; }
      if (start < 0) { end -= start; start = 0; }
      item.start = new Date(start);
      item.end = new Date(end);
      const target = groups.get(item.group);
      if (!target || target.kind !== orig.kind) item.group = orig.layerId;
      return callback(item);
    },
    onMove(item, callback) {
      callback(item);
      on.move({ id: item.id, start: Math.round(item.start.getTime()), end: Math.round(item.end.getTime()), layerId: item.group });
    },
  });
  timeline.addCustomTime(new Date(0), 'playhead');

  const view = () => { const w = timeline.getWindow(); return { start: w.start.getTime(), end: w.end.getTime(), total: projectTotal }; };
  const setView = (start, span) => timeline.setWindow(new Date(Math.max(-2000, start)), new Date(Math.max(-2000, start) + span), { animation: false });
  // A plain wheel or a two-finger swipe over the timeline scrolls it sideways: down or right always means later in time (vis-timeline's
  // own wheel scroll maps a vertical wheel the other way round, and lets the page scroll instead when it is off).
  el.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const { start, end } = view();
    const span = end - start;
    setView(start + d * (e.deltaMode === 1 ? 16 : 1) * (span / Math.max(1, el.clientWidth)), span);
  }, { capture: true, passive: false });
  timeline.on('rangechange', () => { if (on.view) on.view(view()); });
  timeline.on('rangechanged', () => { if (on.view) on.view(view()); });
  /**
   * Keep the playhead in view. A seek (the user moved it) always brings it in: a quarter of the way from the left. During playback
   * (`tick`) the view only turns the page when the playhead reaches the right edge, so a view scrolled away on purpose stays where it is.
   */
  function reveal(ms, tick) {
    if (dragging) return;
    const { start, end } = view();
    const span = end - start;
    const edge = end - span * 0.06;
    if (tick ? ms >= edge && ms <= end + span * 0.02 : ms < start || ms > edge) setView(ms - span * 0.25, span);
  }
  timeline.on('select', ({ items: sel }) => on.select(sel));
  timeline.on('timechange', ({ id, time }) => { if (id === 'playhead') { dragging = true; playhead = Math.max(0, Math.round(time.getTime())); on.playhead(playhead, true); } });
  timeline.on('timechanged', ({ id, time }) => { if (id === 'playhead') { dragging = false; playhead = Math.max(0, Math.round(time.getTime())); on.playhead(playhead, false); } });
  const moveHere = (p) => { playhead = Math.max(0, Math.round(p.time.getTime())); timeline.setCustomTime(new Date(playhead), 'playhead'); on.playhead(playhead, false); };
  const pointOf = (p) => {
    const e = p.event?.srcEvent || p.event;
    return { x: e?.clientX ?? p.pageX - window.scrollX, y: e?.clientY ?? p.pageY - window.scrollY };
  };
  const isItem = (p) => p.item !== null && p.item !== undefined;
  // What was hit decides the menu: a clip opens the clip's controls, empty lane space opens the lane's controls.
  const menuAt = (p) => {
    if (p.what === 'group-label' && p.group !== null && p.group !== undefined) { on.laneMenu({ layerId: p.group, time: playhead, ...pointOf(p) }); return; }
    if (isItem(p)) { on.clipMenu({ id: p.item, ...pointOf(p) }); return; }
    if (!p.time || p.group === null || p.group === undefined || p.what === 'axis') return;
    moveHere(p);
    on.laneMenu({ layerId: p.group, time: playhead, ...pointOf(p) });
  };
  // A click on empty lane space or the ruler moves the playhead; a right-click opens the menu; a double-click on a clip edits it in place.
  timeline.on('click', (p) => { if ((p.what === 'background' || p.what === 'axis') && p.time) moveHere(p); });
  // vis-timeline adds and removes clips with Shift or Cmd + click but treats Ctrl + click as a plain click; Ctrl + click is the usual way
  // on Windows and Linux, so toggle the clip here, from the selection as it was when the button went down (idempotent where vis agrees).
  let selAtDown = [];
  el.addEventListener('pointerdown', () => { selAtDown = timeline.getSelection(); }, true);
  timeline.on('click', (p) => {
    const e = p.event?.srcEvent;
    if (!isItem(p) || !e || !e.ctrlKey || e.metaKey || e.shiftKey) return;
    setTimeout(() => {
      const next = selAtDown.includes(p.item) ? selAtDown.filter((x) => x !== p.item) : [...selAtDown, p.item];
      timeline.setSelection(next);
      on.select(next);
    }, 0);
  });
  timeline.on('doubleClick', (p) => { if (isItem(p)) on.edit(p.item); });
  timeline.on('contextmenu', (p) => { if (p.event?.preventDefault) p.event.preventDefault(); menuAt(p); });
  function applyFocus() {
    if (!want) return;
    if (performance.now() > want.until) { want = null; return; }
    const w = widgets.get(want.layerId);
    if (!w) return;
    const dots = w.el.querySelectorAll('.pt');
    const el = dots[Math.min(dots.length - 1, want.index)];
    if (el && el.isConnected && document.activeElement !== el) el.focus({ preventScroll: true });
  }
  timeline.on('changed', applyFocus);

  const clipLabel = (kind, c) => (kind === 'subtitle' ? c.text : `${c.src}${c.gain !== undefined ? ` (${formatDb(c.gain)})` : ''}`);

  function setProject(p, selectedIds) {
    byId = new Map();
    widgets = new Map();
    const rows = [];
    p.layers.forEach((layer, order) => {
      if (layer.kind === 'automation') {
        // an automation layer is one lane holding one item, exactly as wide as the clip it is linked to, that carries the drawing of the line
        const target = p.layers.flatMap((l) => l.clips).find((c) => c.id === layer.link.clipId);
        const btn = (label, ico, run, pressed) => h('button', {
          type: 'button', class: `flag${pressed ? ' on' : ''}`, ...(pressed !== undefined ? { 'aria-pressed': String(pressed) } : {}), 'aria-label': `${label} ${layer.name}`, title: `${label} ${layer.name}`,
          onclick: (e) => { e.stopPropagation(); run(); }, onmousedown: (e) => e.stopPropagation(), ontouchstart: (e) => e.stopPropagation(),
        }, icon(ico));
        groups.update({
          id: layer.id, order, kind: 'automation', className: `lane kind-automation${layer.muted ? ' muted' : ''}${layer.locked ? ' locked' : ''}`,
          content: h('div', { class: 'lane-label auto' }, h('span', { class: 'lane-name' }, layer.name), h('span', { class: 'lane-flags' },
            btn('Bypass', 'power', () => on.layerFlag(layer.id, 'muted', !layer.muted), layer.muted), btn('Lock', 'lock', () => on.layerFlag(layer.id, 'locked', !layer.locked), layer.locked), btn('Delete', 'trash', () => on.lineDelete(layer.id)))),
        });
        if (target) {
          const siblings = p.layers.filter((l) => l.kind === 'automation' && l.id !== layer.id && l.link.clipId === target.id).flatMap((l) => l.points.map((pt) => pt.t));
          const w = createLineWidget({
            line: layer, clip: target, fps: p.fps || 30, disabled: layer.locked, siblings, getTool: on.tool, getTolerance: on.tolerance, getPlayhead: () => playhead,
            on: {
              add: (t, v, curve) => on.lineAdd(layer.id, t, v, curve), move: (i, t, v) => on.lineMove(layer.id, i, t, v), remove: (i) => on.lineRemove(layer.id, i),
              curve: (i, c) => on.lineCurve(layer.id, i, c), replace: (points) => on.lineReplace(layer.id, points), menu: (where) => on.lineMenu({ ...where, layerId: layer.id }),
            },
          });
          widgets.set(layer.id, w);
          rows.push({ id: `line-${layer.id}`, group: layer.id, type: 'range', start: new Date(target.start), end: new Date(target.start + target.duration), className: `line-item kind-automation${layer.muted ? ' muted' : ''}${layer.locked ? ' locked' : ''}`, content: w.el, editable: false, selectable: false });
        }
        return;
      }
      const flag = (name, label, key) => h('button', {
        type: 'button', class: `flag ${layer[name] ? 'on' : ''}`, 'aria-pressed': String(layer[name]), 'aria-label': `${label} ${layer.name}`, title: `${label} ${layer.name}`,
        onclick: (e) => { e.stopPropagation(); on.layerFlag(layer.id, name, !layer[name]); },
        onmousedown: (e) => e.stopPropagation(),
        ontouchstart: (e) => e.stopPropagation(),
      }, key);
      const visual = layer.kind === 'video' || layer.kind === 'subtitle'; // on these, "mute" hides the layer from the picture
      const vol = layer.kind === 'voice' || layer.kind === 'music'
        ? h('span', { class: 'lane-knobs' },
          createKnob({ label: `${layer.name} volume`, title: `${layer.name} volume`, value: layer.gain ?? 1, def: 1, small: true, disabled: layer.locked, onInput: (g) => on.layerGainLive && on.layerGainLive(layer.id, g), onCommit: (g) => on.layerGain && on.layerGain(layer.id, g) }).el,
          createKnob({ label: `${layer.name} pan`, title: `${layer.name} pan`, value: layer.pan ?? 0, def: 0, mode: 'pan', small: true, disabled: layer.locked, onInput: (v) => on.layerPanLive && on.layerPanLive(layer.id, v), onCommit: (v) => on.layerPan && on.layerPan(layer.id, v) }).el)
        : null;
      const dup = h('button', {
        type: 'button', class: 'flag', 'aria-label': `Duplicate ${layer.name}`, title: `Duplicate ${layer.name} with its clips`,
        onclick: (e) => { e.stopPropagation(); on.layerDuplicate(layer.id); },
        onmousedown: (e) => e.stopPropagation(),
        ontouchstart: (e) => e.stopPropagation(),
      }, icon('duplicate'));
      groups.update({ id: layer.id, order, kind: layer.kind, className: `lane kind-${layer.kind}${layer.muted ? ' muted' : ''}${layer.locked ? ' locked' : ''}`, content: h('div', { class: 'lane-label' }, h('span', { class: 'lane-name' }, layer.name), h('span', { class: 'lane-flags' }, flag('muted', 'Mute', icon(layer.muted ? (visual ? 'eye-off' : 'volume-off') : (visual ? 'eye' : 'volume'))), flag('locked', 'Lock', icon('lock')), dup, vol)) });
      // Video clips may overlap: the one that starts first is on top. A clip with an earlier one over it is drawn dashed and dim, and the
      // earlier clips get the higher stacking order, so the picture on the timeline matches the picture in the export.
      const covered = new Set();
      const stack = new Map();
      if (layer.kind === 'video') {
        const sorted = [...layer.clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        sorted.forEach((c, i) => {
          stack.set(c.id, 100 - Math.min(i, 90));
          if (sorted.slice(0, i).some((e) => e.start + e.duration > c.start)) covered.add(c.id);
        });
      }
      for (const c of layer.clips) {
        byId.set(c.id, { ...c, kind: layer.kind, layerId: layer.id });
        rows.push({
          id: c.id, group: layer.id, type: 'range', start: new Date(c.start), end: new Date(c.start + c.duration),
          className: `clip kind-${layer.kind}${layer.locked ? ' locked' : ''}${layer.muted ? ' muted' : ''}${covered.has(c.id) ? ' under' : ''}`,
          ...(stack.has(c.id) ? { style: `z-index: ${stack.get(c.id)}` } : {}),
          content: h('span', { class: 'clip-text', 'data-clip': c.id }, clipLabel(layer.kind, c)),
          title: `${clipLabel(layer.kind, c)}\n${fmt(c.start)} - ${fmt(c.start + c.duration)}${covered.has(c.id) ? '\nUnder an earlier clip where they overlap' : ''}`,
          editable: layer.locked ? false : { updateTime: true, updateGroup: true, remove: false },
        });
      }
    });
    for (const id of groups.getIds()) if (!p.layers.some((l) => l.id === id)) groups.remove(id);
    items.clear();
    items.add(rows);
    const total = p.layers.reduce((m, l) => l.clips.reduce((n, c) => Math.max(n, c.start + c.duration), m), 0);
    projectTotal = total;
    timeline.setOptions({ max: new Date(total + 60000) });
    timeline.setSelection((selectedIds || []).filter((id) => byId.has(id)));
  }

  return {
    setProject,
    /** Focus a point of a line (after an edit re-drew it), so the keyboard can carry on from there. */
    // vis-timeline puts an item's content into the page a frame after setProject and moves it again on later redraws, which drops the focus:
    // so the focus wanted is remembered for a moment and re-applied after every redraw
    focusPoint: (layerId, index) => { want = { layerId, index, until: performance.now() + 700 }; applyFocus(); },
    setSelection: (ids) => timeline.setSelection(Array.isArray(ids) ? ids : ids ? [ids] : []),
    setPlayhead(ms, tick = false) { playhead = ms; timeline.setCustomTime(new Date(ms), 'playhead'); reveal(ms, tick); },
    view,
    /** Scroll so the window starts at `fraction` (0 to 1) of the way through the part of the project that is not on screen. */
    panTo(fraction) { const { start, end, total } = view(); const span = end - start; setView(Math.max(0, total - span) * Math.min(1, Math.max(0, fraction)), span); },
    /** Scroll by `pages` windows (negative: back). */
    panBy(pages) { const { start, end } = view(); const span = end - start; setView(Math.max(-2000, start + span * pages), span); },
    zoomIn: () => timeline.zoomIn(0.5),
    zoomOut: () => timeline.zoomOut(0.5),
    fit(total) { timeline.setWindow(new Date(-total * 0.03), new Date(total * 1.03 + 500), { animation: false }); },
    /** The on-screen element of a clip (for placing an inline editor), or null. */
    elementOf: (id) => el.querySelector(`.vis-item .clip-text[data-clip="${CSS.escape(id)}"]`)?.closest('.vis-item') || null,
    redraw: () => timeline.redraw(),
    destroy: () => timeline.destroy(),
  };
}
