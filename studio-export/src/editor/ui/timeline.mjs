// The timeline widget: one row per layer, clips as draggable, resizable blocks, a ruler and a playhead. The drawing, dragging,
// zooming and panning are vis-timeline's (vendored in vendor/, Apache-2.0 OR MIT); this file only maps our project onto it and
// reports what the user did. It never edits: a drop is reported as (clip, new start, new end, new layer) and app.mjs sends it
// to the server as an op, then hands the answer back through setProject().
import { h, fmt } from './dom.mjs';

const vis = window.vis;
const SNAP_PX = 8;

export function createTimeline(el, on) {
  const items = new vis.DataSet();
  const groups = new vis.DataSet();
  let byId = new Map();
  let playhead = 0;

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
    zoomKey: 'ctrlKey',
    selectable: true,
    multiselect: false,
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
  timeline.on('select', ({ items: sel }) => on.select(sel[0] || null));
  timeline.on('timechange', ({ id, time }) => { if (id === 'playhead') { playhead = Math.max(0, Math.round(time.getTime())); on.playhead(playhead, true); } });
  timeline.on('timechanged', ({ id, time }) => { if (id === 'playhead') { playhead = Math.max(0, Math.round(time.getTime())); on.playhead(playhead, false); } });
  timeline.on('click', (p) => {
    if ((p.what === 'background' || p.what === 'axis') && p.time) { playhead = Math.max(0, Math.round(p.time.getTime())); timeline.setCustomTime(new Date(playhead), 'playhead'); on.playhead(playhead, false); }
  });
  timeline.on('doubleClick', (p) => { if (p.item !== null && p.item !== undefined) on.edit(p.item); });

  const clipLabel = (kind, c) => (kind === 'subtitle' ? c.text : `${c.src}${c.gain !== undefined ? ` (gain ${c.gain})` : ''}`);

  function setProject(p, selectedId) {
    byId = new Map();
    const rows = [];
    p.layers.forEach((layer, order) => {
      const flag = (name, label, key) => h('button', {
        type: 'button', class: `flag ${layer[name] ? 'on' : ''}`, 'aria-pressed': String(layer[name]), 'aria-label': `${label} ${layer.name}`, title: `${label} ${layer.name}`,
        onclick: (e) => { e.stopPropagation(); on.layerFlag(layer.id, name, !layer[name]); },
        onmousedown: (e) => e.stopPropagation(),
        ontouchstart: (e) => e.stopPropagation(),
      }, key);
      groups.update({ id: layer.id, order, kind: layer.kind, className: `lane kind-${layer.kind}${layer.muted ? ' muted' : ''}${layer.locked ? ' locked' : ''}`, content: h('div', { class: 'lane-label' }, h('span', { class: 'lane-name' }, layer.name), h('span', { class: 'lane-flags' }, flag('muted', 'Mute', 'M'), flag('locked', 'Lock', 'L'))) });
      for (const c of layer.clips) {
        byId.set(c.id, { ...c, kind: layer.kind, layerId: layer.id });
        rows.push({
          id: c.id, group: layer.id, type: 'range', start: new Date(c.start), end: new Date(c.start + c.duration),
          className: `clip kind-${layer.kind}${layer.locked ? ' locked' : ''}${layer.muted ? ' muted' : ''}`,
          content: h('span', { class: 'clip-text', 'data-clip': c.id }, clipLabel(layer.kind, c)),
          title: `${clipLabel(layer.kind, c)}\n${fmt(c.start)} - ${fmt(c.start + c.duration)}`,
          editable: layer.locked ? false : { updateTime: true, updateGroup: true, remove: false },
        });
      }
    });
    for (const id of groups.getIds()) if (!p.layers.some((l) => l.id === id)) groups.remove(id);
    items.clear();
    items.add(rows);
    const total = p.layers.reduce((m, l) => l.clips.reduce((n, c) => Math.max(n, c.start + c.duration), m), 0);
    timeline.setOptions({ max: new Date(total + 60000) });
    if (selectedId && byId.has(selectedId)) timeline.setSelection([selectedId]); else timeline.setSelection([]);
  }

  return {
    setProject,
    setSelection: (id) => timeline.setSelection(id ? [id] : []),
    setPlayhead(ms) { playhead = ms; timeline.setCustomTime(new Date(ms), 'playhead'); },
    zoomIn: () => timeline.zoomIn(0.5),
    zoomOut: () => timeline.zoomOut(0.5),
    fit(total) { timeline.setWindow(new Date(-total * 0.03), new Date(total * 1.03 + 500), { animation: false }); },
    /** The on-screen element of a clip (for placing an inline editor), or null. */
    elementOf: (id) => el.querySelector(`.vis-item .clip-text[data-clip="${CSS.escape(id)}"]`)?.closest('.vis-item') || null,
    redraw: () => timeline.redraw(),
    destroy: () => timeline.destroy(),
  };
}
