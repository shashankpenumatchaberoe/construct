// The editor page. It holds the project the server last sent, the selection, the playhead and a clipboard (a clip id); every
// change to the project is an op sent to the server (api.ops), which answers with the whole new project. Undo, redo, save and
// the recovery copy are the server's too. Here: wiring, shortcuts, the inspector and the export panel.
import { api } from './api.mjs';
import { ask, fmt, h, icon, setIcon } from './dom.mjs';
import { createPlayer } from './player.mjs';
import { AUTOMATABLE, CURVES, PARAMS, SPEED_MAX, SPEED_MIN, ZOOM_DEFAULT, ZOOM_SCALE_MAX, ZOOM_SCALE_MIN, defaultGain, formatSpeed, speedSyncWarning } from './effects.mjs';
import { createKnob } from './knob.mjs';
import { CURVE_LABEL, formatValue } from './lane.mjs';
import { closeMenu, openMenu } from './menu.mjs';
import { mountHome } from './projects.mjs';
import { createTimeline } from './timeline.mjs';

const $ = (id) => document.getElementById(id);
const S = { slug: null, project: null, rev: 0, dirty: false, canUndo: false, canRedo: false, selected: null, selection: [], clipboard: null, playhead: 0, ripple: false, media: [], tool: 'pencil', tolerance: 0.04, lineClip: null };
let tl = null;
let masterKnob = null;
let player = null;
let chain = Promise.resolve();
let toastTimer = 0;
let autosaveTimer = 0;
let autoTimer2 = 0;
let editing = null;

const clips = () => (S.project ? S.project.layers.flatMap((l) => l.clips.map((c) => ({ ...c, kind: l.kind, layerId: l.id, locked: l.locked }))) : []);
const clipById = (id) => clips().find((c) => c.id === id) || null;
const selectedClips = () => S.selection.map(clipById).filter(Boolean);
/** Change the selection to `ids`; the last one is the primary clip (what the inspector shows). `toTimeline: false` when the timeline itself changed it. */
function setSel(ids, { toTimeline = true } = {}) {
  S.selection = [...new Set(ids)].filter((id) => clipById(id));
  S.selected = S.selection.at(-1) || null;
  if (toTimeline) tl.setSelection(S.selection);
  renderInspector();
  renderToolbar();
  if (S.selection.length > 1) $('live').textContent = `${S.selection.length} clips selected`;
  else if (S.selected) announce(S.selected);
}
const layerById = (id) => (S.project ? S.project.layers.find((l) => l.id === id) : null);
const total = () => clips().reduce((m, c) => Math.max(m, c.start + c.duration), 0);
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

function notify(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = !text;
  $('live').textContent = text;
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 9000 : 4500);
}

// ---------------------------------------------------------------- views

function showHome() {
  closeMenu();
  document.title = 'Edward';
  $('home').hidden = false;
  $('editor').hidden = true;
  $('project-bar').hidden = true;
  if (player) player.pause();
  S.slug = null;
  home.refresh();
}

function showEditor() {
  $('home').hidden = true;
  $('editor').hidden = false;
  $('project-bar').hidden = false;
  if (!tl) {
    player = createPlayer({
      video: $('video'), overlay: $('subtitle-overlay'), black: $('black'),
      onTime(t) { S.playhead = t; tl.setPlayhead(t, true); showTime(); },
      onEnd() { setPlayState(false); },
    });
    masterKnob = createKnob({
      label: 'Master', title: 'Master volume: the whole mix, in the preview and in every export', value: 1, def: 1,
      onInput: (g) => player.override({ master: g }),
      onCommit: (g) => { player.override(null); op('setMasterGain', { gain: g }); },
    });
    masterKnob.el.id = 'master-knob';
    $('master-slot').append(masterKnob.el);
    tl = createTimeline($('timeline'), {
      select: (ids) => setSel(ids, { toTimeline: false }),
      playhead: (ms) => { S.playhead = ms; player.seek(ms); showTime(); },
      move: (m) => moveOrTrim(m),
      layerFlag: (layerId, flag, value) => op('setLayerFlag', { layerId, flag, value }),
      layerDuplicate: (layerId) => op('duplicateLayer', { layerId }),
      edit: (id) => editSubtitle(id),
      view: (v) => { S.view = v; renderPan(v); renderNoteMarks(); },
      layerGainLive: (layerId, gain) => player.override({ layer: [layerId, gain] }),
      layerGain: (layerId, gain) => { player.override(null); op('setLayerGain', { layerId, gain }); },
      layerPanLive: (layerId, pan) => player.override({ layerPan: [layerId, pan] }),
      layerPan: (layerId, pan) => { player.override(null); op('setLayerPan', { layerId, pan }); },
      // the lines: what the drawing widgets report becomes an op, and focus returns to the point that was touched
      tool: () => S.tool,
      tolerance: () => S.tolerance,
      lineAdd: (layerId, t, v, curve) => op('addPoint', { layerId, t, v, curve }).then((r) => { if (r && r.pointIndex !== undefined) tl.focusPoint(layerId, r.pointIndex); }),
      lineMove: (layerId, index, t, v) => op('movePoint', { layerId, index, t, v }).then((r) => { if (r) tl.focusPoint(layerId, index); }),
      lineRemove: (layerId, index) => op('deletePoint', { layerId, index }).then((r) => { if (r) tl.focusPoint(layerId, Math.max(0, index - 1)); }),
      lineCurve: (layerId, index, curve) => op('setCurve', { layerId, index, curve }).then((r) => { if (r) tl.focusPoint(layerId, index); }),
      lineReplace: (layerId, points) => op('pasteLane', { layerId, points }),
      lineDelete: (layerId) => op('deleteLayer', { layerId }),
      lineMenu: (where) => openLineMenu(where),
      laneMenu: (where) => openLaneMenu(where),
      clipMenu: (where) => openClipMenu(where),
    });
  }
}

/** The scroll slider under the timeline: where the window is, in the part of the project that does not fit. Hidden when it all fits. */
function renderPan({ start, end, total }) {
  const pan = $('pan');
  const span = end - start;
  const room = total - span;
  pan.hidden = !(room > 200);
  if (pan.hidden) return;
  pan.value = String(Math.round(Math.min(1, Math.max(0, start / room)) * 1000));
  paintRange(pan);
  pan.setAttribute('aria-valuetext', `Showing ${fmt(Math.max(0, start))} to ${fmt(Math.min(total, end))} of ${fmt(total)}`);
}

// ---------------------------------------------------------------- notes

const notesOf = () => (S.project && S.project.notes) || [];
/** The list under "Notes" and the flags on the timeline's ruler. Each row is a jump button, the text (editable in place), a done box and a delete button. */
function renderNotes() {
  const notes = notesOf();
  $('note-empty').hidden = notes.length > 0;
  $('note-list').replaceChildren(...notes.map((n) => {
    const field = h('input', { type: 'text', value: n.text, maxlength: 500, 'aria-label': `Note at ${fmt(n.at)}`, 'data-note': n.id });
    field.addEventListener('change', () => { const t = field.value.trim(); if (t && t !== n.text) op('editNote', { noteId: n.id, text: t }); else field.value = n.text; });
    const done = h('input', { type: 'checkbox', 'aria-label': `Mark the note at ${fmt(n.at)} done` });
    done.checked = Boolean(n.done);
    done.addEventListener('change', () => op('editNote', { noteId: n.id, done: done.checked }));
    return h('li', { class: n.done ? 'done' : '' },
      h('button', { type: 'button', class: 'note-time', title: 'Move the playhead here', onclick: () => seek(n.at) }, fmt(n.at)),
      field,
      h('label', { class: 'check', title: 'Done' }, done),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Delete the note at ${fmt(n.at)}`, title: 'Delete the note', onclick: () => op('deleteNote', { noteId: n.id }) }, icon('trash')));
  }));
  renderNoteMarks();
}
/** A flag on the ruler at each note's time, placed from the timeline's visible window (the centre panel of vis-timeline is where time is drawn). */
function renderNoteMarks() {
  const strip = $('note-strip');
  const centre = document.querySelector('#timeline .vis-panel.vis-center');
  const v = S.view;
  if (!v || !centre || !S.project) { strip.replaceChildren(); return; }
  const wrap = strip.getBoundingClientRect();
  const box = centre.getBoundingClientRect();
  const left = box.left - wrap.left;
  const span = Math.max(1, v.end - v.start);
  strip.replaceChildren(...notesOf().filter((n) => n.at >= v.start && n.at <= v.end).map((n) => h('button', {
    type: 'button', class: `note-mark${n.done ? ' done' : ''}`, style: `left:${Math.round(left + ((n.at - v.start) / span) * box.width)}px`,
    title: `${fmt(n.at)}  ${n.text}`, 'aria-label': `Note at ${fmt(n.at)}: ${n.text}`,
    onclick: () => { seek(n.at); const f = document.querySelector(`[data-note="${n.id}"]`); if (f) f.focus(); },
  })));
}
function addNote() {
  const field = $('note-text');
  const text = field.value.trim();
  if (!text) return notify('Write the note first.', true);
  return op('addNote', { at: Math.round(S.playhead), text }).then((r) => { if (r) field.value = ''; });
}

/** A range input shows its filled part in the accent colour: the CSS reads --fill (a percentage) that is set here. */
function paintRange(el) {
  const span = Number(el.max) - Number(el.min);
  el.style.setProperty('--fill', `${span > 0 ? Math.round(((Number(el.value) - Number(el.min)) / span) * 1000) / 10 : 0}%`);
}
document.addEventListener('input', (e) => { if (e.target instanceof HTMLInputElement && e.target.type === 'range') paintRange(e.target); });
let scrubbing = false;
function showTime() {
  $('time').textContent = `${fmt(S.playhead)} / ${fmt(total())}`;
  // the seek bar IS the timeline's playhead: it spans the whole project, not one clip, and follows every way of moving it
  const seekEl = $('seek');
  seekEl.max = String(Math.max(100, total()));
  if (!scrubbing) seekEl.value = String(Math.round(S.playhead));
  paintRange(seekEl);
  seekEl.setAttribute('aria-valuetext', `${fmt(S.playhead)} of ${fmt(total())}`);
  const note = player ? player.note : '';
  if ($('preview-note').textContent !== note) { $('preview-note').textContent = note; $('preview-note').hidden = !note; }
}

function announce(id) {
  const c = clipById(id);
  if (c) $('live').textContent = `${c.kind} clip ${c.kind === 'subtitle' ? c.text : c.src}, ${fmt(c.start)} to ${fmt(c.start + c.duration)}`;
}

function render() {
  if (!S.project) return;
  $('project-name').textContent = S.project.name || S.slug;
  document.title = `${S.project.name || S.slug} - Edward`;
  S.selection = S.selection.filter((id) => clipById(id));
  if (!S.selection.includes(S.selected)) S.selected = S.selection.at(-1) || null;
  tl.setProject(S.project, S.selection);
  if (masterKnob) masterKnob.set(S.project.master ?? 1);
  player.setProject(S.project);
  renderInspector();
  renderNotes();
  renderToolbar();
  renderLayerPicker();
  renderSaveState();
  showTime();
}

function renderSaveState() {
  const el = $('save-state');
  el.textContent = S.dirty ? (autosaveOn ? 'Unsaved, saving soon' : 'Unsaved changes') : 'Saved';
  el.dataset.state = S.dirty ? 'dirty' : 'saved';
  $('save').disabled = !S.dirty;
  clearTimeout(autosaveTimer);
  if (S.dirty && !autosaveOn) autosaveTimer = setTimeout(() => { if (S.dirty) el.textContent = 'Unsaved changes, recovery copy kept'; }, 1600);
  scheduleAutosave();
}

function renderToolbar() {
  const n = S.selection.length;
  const sel = n === 1 ? clipById(S.selected) : null;
  const here = S.project ? clips().filter((c) => S.playhead > c.start && S.playhead < c.start + c.duration) : [];
  $('split').disabled = n > 1 || !(sel ? sel.start < S.playhead && S.playhead < sel.start + sel.duration : here.length);
  $('copy').disabled = n === 0;
  $('paste').disabled = !S.clipboard;
  $('duplicate').disabled = n === 0;
  $('delete').disabled = n === 0;
  $('undo').disabled = !S.canUndo;
  $('redo').disabled = !S.canRedo;
}

function renderInspector() {
  const box = $('inspector');
  if (S.selection.length > 1) {
    const cs = selectedClips();
    const from = Math.min(...cs.map((c) => c.start));
    const to = Math.max(...cs.map((c) => c.start + c.duration));
    const lockedAny = cs.some((c) => c.locked);
    const b = (label, run, disabled = false, cls = '') => h('button', { type: 'button', class: cls, disabled, onclick: run }, label);
    box.replaceChildren(
      h('p', { class: 'batch-count' }, `${cs.length} clips selected`),
      h('dl', { class: 'facts' }, h('dt', {}, 'Span'), h('dd', {}, `${fmt(from)} - ${fmt(to)}`), h('dt', {}, 'Layers'), h('dd', {}, String(new Set(cs.map((c) => c.layerId)).size))),
      h('div', { class: 'row' }, b('Copy', doCopy), b('Duplicate', doDuplicate, lockedAny), b('Delete', doDelete, lockedAny), b('Delete and close gaps', () => doDelete(true), lockedAny), b('Clear selection', () => setSel([]), false, 'quiet')),
      h('p', { class: 'muted small' }, 'Drag any selected clip to move them all. Shift+click or Cmd+click (Ctrl+click on Windows and Linux) adds or removes a clip, Ctrl+A selects everything.'));
    return;
  }
  const c = S.selected ? clipById(S.selected) : null;
  if (!c) { box.replaceChildren(h('p', { class: 'muted' }, 'Select a clip to see its details. Double-click a subtitle to edit its text.')); return; }
  const layer = layerById(c.layerId);
  const facts = h('dl', { class: 'facts' },
    h('dt', {}, 'Layer'), h('dd', {}, `${layer.name}${layer.locked ? ' (locked)' : ''}`),
    h('dt', {}, 'Start'), h('dd', {}, fmt(c.start)), h('dt', {}, 'Length'), h('dd', {}, fmt(c.duration)),
    c.kind === 'subtitle' ? null : [h('dt', {}, 'File'), h('dd', {}, c.src), h('dt', {}, 'From'), h('dd', {}, fmt(c.in))],
    c.speed !== undefined ? [h('dt', {}, 'Speed'), h('dd', {}, formatSpeed(c.speed))] : null,
    c.zoom ? [h('dt', {}, 'Zoom'), h('dd', {}, `${formatSpeed(c.zoom.scale)} from ${fmt(Math.max(0, c.zoom.at))} in the clip`)] : null);
  const parts = [facts];
  if (c.kind === 'subtitle') {
    const area = h('textarea', { id: 'sub-text', rows: 3, maxlength: 500, 'aria-label': 'Subtitle text', disabled: c.locked }, c.text);
    area.value = c.text;
    area.addEventListener('input', () => { if (S.playhead >= c.start && S.playhead < c.start + c.duration) { $('subtitle-overlay').textContent = area.value; } });
    const apply = () => { if (area.value.trim() && area.value.trim() !== c.text) op('setSubtitleText', { clipId: c.id, text: area.value }); };
    area.addEventListener('change', apply);
    area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } });
    parts.push(h('label', { for: 'sub-text' }, 'Text'), area);
  } else if (c.kind === 'voice' || c.kind === 'music') {
    const def = defaultGain(c.kind);
    const cur = c.gain !== undefined ? c.gain : def;
    const num = h('output', {}, cur.toFixed(2));
    const knob = createKnob({
      label: 'Clip volume', title: `Volume of this ${c.kind} clip`, value: cur, def, disabled: c.locked,
      menuExtra: [{ label: 'Automate volume (draw a line)', disabled: c.locked, run: () => automate(c.id, 'gain') }],
      onInput: (g) => { num.textContent = g.toFixed(2); player.override({ clip: [c.id, g] }); },
      onCommit: (g) => { player.override(null); op('setClipGain', { clipId: c.id, gain: g }); },
    });
    knob.el.id = 'clip-knob';
    const panKnob = createKnob({
      label: 'Clip pan', title: `Left and right position of this ${c.kind} clip`, value: c.pan ?? 0, def: 0, mode: 'pan', disabled: c.locked,
      menuExtra: [{ label: 'Automate pan (draw a line)', disabled: c.locked, run: () => automate(c.id, 'pan') }],
      onInput: (v) => player.override({ clipPan: [c.id, v] }),
      onCommit: (v) => { player.override(null); op('setClipPan', { clipId: c.id, pan: v }); },
    });
    panKnob.el.id = 'clip-pan-knob';
    parts.push(h('div', { class: 'inspector-gain' }, h('span', { class: 'inspector-gain-text' }, 'Gain ', num, h('small', { class: 'muted' }, ' (a multiple of the original level)')), h('div', { class: 'inspector-knobs' }, knob.el, panKnob.el)));
  }
  box.replaceChildren(...parts);
}

// ---------------------------------------------------------------- talking to the server

function apply(r) {
  S.project = r.project;
  S.rev = r.rev;
  S.dirty = r.dirty;
  S.canUndo = r.canUndo;
  S.canRedo = r.canRedo;
  render();
}

async function reload(message) {
  try { apply(await api.load(S.slug)); if (message) notify(message, true); } catch (e) { notify(e.message, true); }
}

function op(name, args) {
  chain = chain.then(async () => {
    if (!S.slug) return null;
    try {
      const r = await api.ops(S.slug, name, args, S.rev);
      if (r.newClipId && (name === 'copyClip' || name === 'addSubtitle' || name === 'addClip')) { S.selection = [r.newClipId]; S.selected = r.newClipId; }
      if (r.newLayerId && (name === 'addAutomation' || name === 'copyLane')) S.lastLine = r.newLayerId;
      if (r.newClipIds && name === 'copyClips') { S.selection = r.newClipIds; S.selected = r.newClipIds.at(-1); }
      apply(r);
      return r;
    } catch (e) {
      if (e.code === 'STALE_REV' || e.code === 'NO_SESSION') await reload('The project changed elsewhere; reloaded the latest copy.');
      else { notify(e.message, true); render(); }
      return null;
    }
  });
  return chain;
}

let pendingMoves = [];
let moveTimer = 0;
/** A drop of several selected clips reports each clip separately: gather them and send ONE atomic op (one undo step). */
function queueMove(move) {
  pendingMoves.push(move);
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    const moves = pendingMoves;
    pendingMoves = [];
    const shift = -Math.min(0, ...moves.map((m) => m.toStartMs)); // keep the whole group at or after 0 without changing its spacing
    op('moveClips', { moves: moves.map((m) => ({ ...m, toStartMs: m.toStartMs + shift })) });
  }, 30);
}

function moveOrTrim({ id, start, end, layerId }) {
  const c = clipById(id);
  if (!c) return;
  const cEnd = c.start + c.duration;
  if (end - start !== c.duration) {
    if (start !== c.start && end === cEnd) op('trimClip', { clipId: id, edge: 'start', toMs: start });
    else if (start === c.start && end !== cEnd) op('trimClip', { clipId: id, edge: 'end', toMs: end });
    else render();
  } else if (start !== c.start || layerId !== c.layerId) {
    if (S.selection.length > 1 && S.selection.includes(id)) queueMove({ clipId: id, toStartMs: start });
    else op('moveClip', { clipId: id, toStartMs: start, toLayerId: layerId });
  }
}

/** `quiet` is the automatic save: no "Saved." toast, and an error is shown once, then it waits for the next edit to try again. */
async function save({ quiet = false } = {}) {
  chain = chain.then(async () => {
    if (!S.slug || !S.project) return;
    try { apply(await api.save(S.slug, S.project, S.rev)); if (!quiet) notify('Saved.'); } catch (e) {
      if (e.code === 'STALE_REV') showConflict(e.data.current);
      else notify(quiet ? `Auto-save failed: ${e.message}` : e.message, true);
    }
  });
  return chain;
}

// Auto-save: a moment after the last edit (every edit restarts the wait) the project is saved like Save does. It is a per-browser
// choice, on by default, and waits while a subtitle is being typed or a save conflict is on screen.
const AUTOSAVE_MS = 1500;
const PREF = 'studio-editor-autosave';
const readPref = () => { try { return localStorage.getItem(PREF) !== 'off'; } catch { return true; } };
const writePref = (on) => { try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch { /* private mode: the choice lasts until reload */ } };
let autosaveOn = readPref();
function scheduleAutosave() {
  clearTimeout(autoTimer2);
  if (!autosaveOn || !S.dirty || !S.slug) return;
  autoTimer2 = setTimeout(function tryNow() {
    if (!autosaveOn || !S.dirty || !S.slug) return;
    if (editing || !$('banner').hidden) { autoTimer2 = setTimeout(tryNow, AUTOSAVE_MS); return; }
    save({ quiet: true });
  }, AUTOSAVE_MS);
}

function showConflict(current) {
  const box = $('banner');
  box.hidden = false;
  box.replaceChildren(
    h('span', {}, 'This project was saved from another window since you opened it.'),
    h('button', { type: 'button', onclick: async () => { box.hidden = true; await reload(); } }, 'Load theirs'),
    h('button', { type: 'button', class: 'primary', onclick: async () => { box.hidden = true; try { apply(await api.save(S.slug, S.project, current.rev)); notify('Saved over the other copy.'); } catch (e) { notify(e.message, true); } } }, 'Keep mine'));
}

function showRecover(info) {
  const box = $('banner');
  box.hidden = false;
  box.replaceChildren(
    h('span', {}, `Unsaved edits from ${new Date(info.updatedAt).toLocaleString()} were kept as a recovery copy.`),
    h('button', { type: 'button', class: 'primary', id: 'restore', onclick: async () => { box.hidden = true; await op('restoreAutosave', {}); notify('Recovered. Save to keep it.'); } }, 'Restore'),
    h('button', { type: 'button', id: 'discard', onclick: async () => { box.hidden = true; try { await api.discardAutosave(S.slug); } catch (e) { notify(e.message, true); } } }, 'Discard'));
}

// ---------------------------------------------------------------- actions

const playheadClipOf = (kind) => clips().find((c) => c.kind === kind && !c.locked && S.playhead > c.start && S.playhead < c.start + c.duration);

function doSplit() {
  if (S.selection.length > 1) return notify('Select one clip to split it.', true);
  const sel = S.selected ? clipById(S.selected) : null;
  const target = sel && sel.start < S.playhead && S.playhead < sel.start + sel.duration ? sel : (playheadClipOf('video') || clips().find((c) => !c.locked && S.playhead > c.start && S.playhead < c.start + c.duration));
  if (!target) return notify('Put the playhead inside a clip to split it.', true);
  return op('splitClip', { clipId: target.id, atMs: Math.round(S.playhead) });
}
function doCopy() {
  const cs = selectedClips();
  if (!cs.length) return;
  const kinds = new Set(cs.map((c) => c.kind));
  const layerIds = new Set(cs.map((c) => c.layerId));
  S.clipboard = { ids: cs.map((c) => c.id), kind: kinds.size === 1 ? cs[0].kind : 'mixed', layerId: layerIds.size === 1 ? cs[0].layerId : null };
  renderToolbar();
  notify(cs.length === 1 ? 'Copied. Press Ctrl+V to paste at the playhead.' : `Copied ${cs.length} clips. Press Ctrl+V to paste them at the playhead.`);
}
function doPaste(at = S.playhead, layerId) {
  if (!S.clipboard) return notify('Copy a clip first.', true);
  const sel = S.selected && clipById(S.selected);
  const toLayerId = S.clipboard.layerId ? (layerId || (sel && sel.kind === S.clipboard.kind ? sel.layerId : S.clipboard.layerId)) : undefined;
  if (S.clipboard.ids.length === 1) return op('copyClip', { clipId: S.clipboard.ids[0], toStartMs: Math.round(at), toLayerId });
  return op('copyClips', { clipIds: S.clipboard.ids, toStartMs: Math.round(at), ...(toLayerId ? { toLayerId } : {}) });
}
function doDuplicate() {
  const cs = selectedClips();
  if (cs.length === 1) op('copyClip', { clipId: cs[0].id, toStartMs: cs[0].start + cs[0].duration });
  else if (cs.length > 1) op('copyClips', { clipIds: cs.map((c) => c.id), toStartMs: Math.max(...cs.map((c) => c.start + c.duration)) }); // the group lands right after itself
}
function doDelete(closeGaps = false) {
  const ids = [...S.selection];
  if (!ids.length) return;
  const ripple = closeGaps === true || S.ripple;
  setSel([]);
  if (ids.length === 1) op('deleteClip', { clipId: ids[0], ripple }); else op('deleteClips', { clipIds: ids, ripple });
}

function seek(ms) { S.playhead = player.seek(ms); tl.setPlayhead(S.playhead); showTime(); renderToolbar(); }
/** Keyboard seeks: move by `delta` ms and say where the playhead is (the screen-reader line is not touched while playing). */
function seekBy(delta) { seek(S.playhead + delta); $('live').textContent = `Playhead ${fmt(S.playhead)}`; }
/** Jump to the nearest clip start or end before (dir -1) or after (dir 1) the playhead. */
function jumpEdge(dir) {
  const edges = [...new Set([0, ...clips().flatMap((c) => [c.start, c.start + c.duration])])].sort((a, b) => a - b);
  const to = dir > 0 ? edges.find((t) => t > S.playhead + 1) : [...edges].reverse().find((t) => t < S.playhead - 1);
  if (to !== undefined) { seek(to); $('live').textContent = `Edge at ${fmt(S.playhead)}`; }
}
const stepOf = (e) => ((e.ctrlKey || e.metaKey) ? 5000 : e.shiftKey ? 1000 : 100);
function toggleMute() {
  player.setMuted(!player.muted);
  $('mute').setAttribute('aria-pressed', String(player.muted));
  setIcon($('mute'), player.muted ? 'volume-off' : 'volume');
  $('mute').setAttribute('aria-label', player.muted ? 'Unmute' : 'Mute');
  $('player').dataset.muted = String(player.muted);
  $('live').textContent = player.muted ? 'Preview muted' : 'Preview sound on';
}
function toggleCaptions() {
  player.setCaptions(!player.captions);
  $('cc').setAttribute('aria-pressed', String(player.captions));
  $('live').textContent = player.captions ? 'Subtitles shown' : 'Subtitles hidden';
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.fullscreenEnabled) $('stage').requestFullscreen().catch((e) => notify(`Full screen is not available: ${e.message}`, true));
}
/** The play button shows what pressing it will do: a triangle to start, two bars to pause. */
function setPlayState(on) {
  setIcon($('play'), on ? 'pause' : 'play');
  $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  $('play').setAttribute('aria-pressed', String(on));
}
function togglePlay() {
  const on = player.toggle();
  setPlayState(on);
  $('play').setAttribute('aria-pressed', String(on));
}

function selectRelative(dir) {
  const cur = S.selected && clipById(S.selected);
  if (!cur) { const first = clips().sort((a, b) => a.start - b.start)[0]; if (first) setSel([first.id]); return; }
  const row = clips().filter((c) => c.layerId === cur.layerId).sort((a, b) => a.start - b.start);
  const next = row[row.findIndex((c) => c.id === cur.id) + dir];
  if (next) setSel([next.id]);
}
function selectLane(delta) {
  const cur = S.selected && clipById(S.selected);
  const i = cur ? S.project.layers.findIndex((l) => l.id === cur.layerId) : -1;
  const layer = S.project.layers[Math.max(0, Math.min(S.project.layers.length - 1, i + delta))];
  const pick = layer.clips.find((c) => S.playhead >= c.start && S.playhead < c.start + c.duration) || layer.clips[0];
  if (pick) setSel([pick.id]);
}

function editSubtitle(id) {
  const c = clipById(id);
  if (!c || c.kind !== 'subtitle') return;
  if (c.locked) return notify('That layer is locked.', true);
  const item = tl.elementOf(id);
  const wrap = $('timeline-wrap');
  if (editing && editing.dataset.clip === id) { editing.focus(); return; } // a double-click can report twice: keep the editor that is open
  if (editing) editing.blur(); // the old editor closes through its own blur handler (removing it here would run that handler mid-removal and throw)
  const box = wrap.getBoundingClientRect();
  const r = item ? item.getBoundingClientRect() : { left: box.left + 60, top: box.top + 60, height: 30 };
  const input = h('input', { type: 'text', class: 'inline-edit', 'aria-label': 'Subtitle text', maxlength: 500, value: c.text, 'data-clip': id });
  input.value = c.text;
  input.style.left = `${Math.max(0, Math.min(r.left - box.left, box.width - 240))}px`;
  input.style.top = `${r.top - box.top}px`;
  input.style.height = `${Math.max(28, r.height)}px`;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    editing = null;
    const text = input.value.trim();
    input.remove();
    if (commit && text && text !== c.text) op('setSubtitleText', { clipId: id, text });
    else render();
  };
  input.addEventListener('input', () => { if (S.playhead >= c.start && S.playhead < c.start + c.duration) $('subtitle-overlay').textContent = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
  input.addEventListener('blur', () => finish(true));
  wrap.append(input);
  editing = input;
  input.focus();
  input.select();
}

function addSubtitle(layerId, at = S.playhead) {
  const layer = layerId ? layerById(layerId) : S.project.layers.find((l) => l.kind === 'subtitle' && !l.locked);
  if (!layer || layer.locked) return notify('There is no unlocked subtitle layer.', true);
  op('addSubtitle', { layerId: layer.id, startMs: Math.round(at), durationMs: 2000, text: 'New subtitle' }).then((r) => { if (r) editSubtitle(r.newClipId); });
}

const addMedia = () => addMediaClip($('media-select').value, $('media-layer').value, S.playhead);

async function addMediaClip(name, layerId, at) {
  if (!name || !layerId) return;
  const el = /\.(webm|mp4|mov|mkv)$/i.test(name) ? document.createElement('video') : new Audio();
  const ms = await new Promise((resolve) => {
    el.preload = 'metadata';
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0);
    el.onerror = () => resolve(0);
    el.src = api.mediaUrl(name);
  });
  if (!ms) return notify(`Could not read the length of ${name}. Is it a playable media file?`, true);
  op('addClip', { layerId, src: name, start: Math.round(at), duration: ms, in: 0 });
}

/** The menu for a group of selected clips (right-click on one of them): the batch actions. */
function openBatchMenu({ x, y }) {
  const cs = selectedClips();
  const lockedAny = cs.some((c) => c.locked);
  const items = [
    { heading: `${cs.length} clips selected${lockedAny ? ' (some locked)' : ''}` },
    { label: `Copy ${cs.length} clips`, hint: 'Ctrl+C', run: doCopy },
    { label: 'Duplicate', hint: 'Ctrl+D', disabled: lockedAny, run: doDuplicate },
    { separator: true },
    { label: 'Delete', hint: 'Del', disabled: lockedAny, run: () => doDelete() },
    { label: 'Delete and close the gaps', disabled: lockedAny, run: () => doDelete(true) },
    { separator: true },
    { label: 'Clear selection', hint: 'Esc', run: () => setSel([]) },
  ];
  openMenu({ x, y, label: `${cs.length} clips options`, items });
}

/** The menu for a clip (right-click on it, or the Menu key with it selected): the clip's own controls. */
function openClipMenu({ id, x, y }) {
  const c = clipById(id);
  if (!c) return;
  if (S.selection.length > 1 && S.selection.includes(id)) return openBatchMenu({ x, y });
  setSel([id]);
  const locked = c.locked;
  const inside = S.playhead > c.start && S.playhead < c.start + c.duration;
  const name = c.kind === 'subtitle' ? c.text : c.src;
  const items = [{ heading: `${name.length > 34 ? `${name.slice(0, 33)}...` : name}  ${fmt(c.start)} - ${fmt(c.start + c.duration)}${locked ? ' (locked)' : ''}` }];
  if (c.kind === 'subtitle') items.push({ label: 'Edit text', hint: 'Enter', disabled: locked, run: () => editSubtitle(id) });
  items.push({ label: 'Split at the playhead', hint: 'S', disabled: locked || !inside, run: doSplit });
  items.push({ label: 'Copy', hint: 'Ctrl+C', run: doCopy });
  items.push({ label: 'Duplicate', hint: 'Ctrl+D', disabled: locked, run: doDuplicate });
  if (c.kind === 'voice' || c.kind === 'music') {
    const cur = c.gain !== undefined ? c.gain : c.kind === 'music' ? 0.04 : 1;
    const setGain = (g) => op('setClipGain', { clipId: id, gain: Math.round(Math.max(0, Math.min(4, g)) * 10000) / 10000 });
    items.push({ separator: true });
    items.push({ label: 'Quieter (-3 dB)', disabled: locked, run: () => setGain(cur * 0.708) });
    items.push({ label: 'Louder (+3 dB)', disabled: locked, run: () => setGain(cur * 1.413) });
    items.push({ label: 'Default level', disabled: locked, run: () => setGain(defaultGain(c.kind)) });
  }
  if (c.kind !== 'subtitle') {
    const now = c.speed ?? 1;
    items.push({ separator: true }, { heading: `Speed: ${formatSpeed(now)}` });
    for (const [label, s] of [['Half speed (0.5x)', 0.5], ['Normal speed (1x)', 1], ['Double speed (2x)', 2]]) items.push({ label, disabled: locked || s === now, run: () => setSpeed(c.id, s) });
    items.push({ label: 'Custom speed...', disabled: locked, run: () => askSpeed(c.id) });
  }
  if (c.kind === 'video') {
    items.push({ separator: true }, { heading: c.zoom ? `Zoom: ${formatSpeed(c.zoom.scale)} from ${fmt(Math.max(0, c.zoom.at))}` : 'Zoom' });
    // the zoom starts where the playhead is when it is inside the clip, else at the start of the clip
    const at = inside ? S.playhead - c.start : 0;
    for (const scale of [2, 3]) items.push({ label: `Zoom in ${scale}x from ${inside ? 'the playhead' : 'the start'}`, disabled: locked, run: () => op('setClipZoom', { clipId: id, zoom: { ...(c.zoom ?? ZOOM_DEFAULT), scale, at } }) });
    items.push({ label: 'Custom zoom...', disabled: locked, run: () => askZoom(id, at) });
    if (c.zoom) items.push({ label: 'Remove the zoom', disabled: locked, run: () => op('setClipZoom', { clipId: id, zoom: null }) });
  }
  // lines drawn over the clip, one per param, each on a lane of its own under the clip's layer
  const params = AUTOMATABLE.filter((param) => PARAMS[param].clips.includes(c.kind));
  if (params.length) {
    items.push({ separator: true }, { heading: 'Automation lines' });
    for (const param of params) {
      const has = S.project.layers.some((l) => l.kind === 'automation' && l.link.clipId === c.id && l.link.param === param);
      items.push({ label: `${has ? 'Show' : 'Draw'} the ${PARAMS[param].label.toLowerCase()} line`, disabled: locked && !has, run: () => automate(c.id, param) });
    }
    const copied = S.lineClip && S.project.layers.find((l) => l.id === S.lineClip);
    if (copied && params.includes(copied.link.param) && !S.project.layers.some((l) => l.kind === 'automation' && l.link.clipId === c.id && l.link.param === copied.link.param)) {
      items.push({ label: `Paste the copied ${PARAMS[copied.link.param].label.toLowerCase()} line here`, disabled: locked, run: () => op('copyLane', { fromLayerId: copied.id, toClipId: c.id, fit: true }).then((r) => { if (r && r.newLayerId) revealLine(r.newLayerId); }) });
    }
  }
  items.push({ separator: true });
  items.push({ label: 'Delete', hint: 'Del', disabled: locked, run: doDelete });
  items.push({ label: 'Delete and close the gap', disabled: locked, run: () => doDelete(true) });
  items.push({ separator: true });
  items.push({ label: 'Duplicate this layer', hint: 'Ctrl+Shift+D', run: () => op('duplicateLayer', { layerId: c.layerId }) });
  openMenu({ x, y, label: `${c.kind} clip options`, items });
}

/** Change a clip's speed (its slot on the timeline gets shorter or longer; with Ripple on, the clips after it follow), then say if it no longer lines up with its partner. */
function setSpeed(clipId, speed) {
  return op('setClipSpeed', { clipId, speed, ripple: S.ripple }).then((r) => {
    if (!r) return;
    const warning = speedSyncWarning(S.project, clipId);
    if (warning) notify(warning);
  });
}
async function askSpeed(clipId) {
  const c = clipById(clipId);
  if (!c) return;
  const answer = await ask({ title: 'Custom speed', text: `A number from ${SPEED_MIN} to ${SPEED_MAX}: 2 is twice as fast, 0.5 is half speed. The clip's slot on the timeline gets shorter or longer to match.`, input: String(c.speed ?? 1), confirmLabel: 'Set speed' });
  if (answer === null) return;
  const speed = Number(String(answer).trim().replace(/x$/i, ''));
  if (!Number.isFinite(speed)) return notify(`Speed is a number from ${SPEED_MIN} to ${SPEED_MAX}.`, true);
  setSpeed(clipId, speed);
}

async function askZoom(clipId, at) {
  const c = clipById(clipId);
  if (!c) return;
  const answer = await ask({ title: 'Custom zoom', text: `How far to zoom in, a number from ${ZOOM_SCALE_MIN} to ${ZOOM_SCALE_MAX} (2 shows the middle half of the picture). It eases in over ${ZOOM_DEFAULT.ramp / 1000} s and stays zoomed to the end of the clip.`, input: String(c.zoom?.scale ?? 2), confirmLabel: 'Set zoom' });
  if (answer === null) return;
  const scale = Number(String(answer).trim().replace(/x$/i, ''));
  if (!Number.isFinite(scale) || scale < ZOOM_SCALE_MIN || scale > ZOOM_SCALE_MAX) return notify(`Zoom is a number from ${ZOOM_SCALE_MIN} to ${ZOOM_SCALE_MAX}.`, true);
  op('setClipZoom', { clipId, zoom: { ...(c.zoom ?? ZOOM_DEFAULT), scale, at: c.zoom ? c.zoom.at : at } });
}

const KIND_FILES = { video: /\.(webm|mp4|mov|mkv)$/i, voice: /\.(opus|mp3|wav|ogg|m4a|flac)$/i, music: /\.(opus|mp3|wav|ogg|m4a|flac)$/i };
const KIND_NAME = { video: 'video', voice: 'voice', music: 'music', subtitle: 'subtitle' };

/** The menu for empty space in a lane: what you can put there depends on the layer's kind, then the layer's own actions. */
function openLaneMenu({ layerId, time, x, y }) {
  const layer = layerById(layerId);
  if (!layer) return;
  const at = Math.round(time);
  const locked = layer.locked;
  const items = [{ heading: `${layer.name} at ${fmt(at)}${locked ? ' (locked)' : ''}` }];
  if (layer.kind === 'subtitle') items.push({ label: 'Add a subtitle here', disabled: locked, run: () => addSubtitle(layer.id, at) });
  else {
    const files = S.media.filter((n) => KIND_FILES[layer.kind].test(n));
    for (const name of files.slice(0, 8)) items.push({ label: `Add ${name} here`, disabled: locked, run: () => addMediaClip(name, layer.id, at) });
    if (!files.length) items.push({ label: `No ${KIND_NAME[layer.kind]} files in the workspace`, disabled: true, run() {} });
    else if (files.length > 8) items.push({ heading: `${files.length - 8} more in the Add panel below` });
  }
  items.push({ label: 'Paste here', hint: 'Ctrl+V', disabled: locked || !S.clipboard || S.clipboard.kind !== layer.kind, run: () => doPaste(at, layer.id) });
  if (layer.clips.length) items.push({ label: `Select all ${layer.clips.length} clips in this layer`, run: () => setSel(layer.clips.map((c) => c.id)) });
  items.push({ separator: true });
  items.push({ label: `Add another ${KIND_NAME[layer.kind]} layer`, run: () => op('addLayer', { kind: layer.kind }) });
  items.push({ label: 'Duplicate this layer', hint: 'Ctrl+Shift+D', run: () => op('duplicateLayer', { layerId: layer.id }) });
  items.push({ label: 'Delete this layer...', disabled: locked, run: () => deleteLayerAsk(layer.id) });
  items.push({ label: layer.muted ? 'Unmute this layer' : 'Mute this layer', run: () => op('setLayerFlag', { layerId: layer.id, flag: 'muted', value: !layer.muted }) });
  items.push({ label: layer.locked ? 'Unlock this layer' : 'Lock this layer', run: () => op('setLayerFlag', { layerId: layer.id, flag: 'locked', value: !layer.locked }) });
  openMenu({ x, y, label: `${layer.name} options`, items });
}

async function deleteLayerAsk(layerId) {
  const layer = layerById(layerId);
  if (!layer) return;
  const n = layer.clips.length;
  const yes = await ask({
    title: `Delete "${layer.name}"?`,
    text: `${n === 0 ? 'The layer is empty. ' : n === 1 ? 'Its 1 clip goes with it. ' : `Its ${n} clips go with it. `}Undo (Ctrl+Z) brings it back. The media files are not touched.`,
    confirmLabel: 'Delete layer', danger: true,
  });
  if (yes) op('deleteLayer', { layerId });
}

/** The toolbar's Layers menu: add a layer of any kind, and duplicate or delete the layer of the selected clip. */
function openLayersMenu() {
  const r = $('layers-menu').getBoundingClientRect();
  const sel = S.selected && clipById(S.selected);
  const layer = sel ? layerById(sel.layerId) : null;
  const items = [{ heading: 'Add a layer' }];
  for (const kind of ['video', 'voice', 'music', 'subtitle']) items.push({ label: `Add ${KIND_NAME[kind]} layer`, run: () => op('addLayer', { kind }) });
  items.push({ separator: true });
  items.push({ heading: layer ? `Layer: ${layer.name}` : 'Select a clip to pick its layer' });
  items.push({ label: 'Duplicate layer', hint: 'Ctrl+Shift+D', disabled: !layer, run: () => op('duplicateLayer', { layerId: layer.id }) });
  items.push({ label: 'Delete layer...', disabled: !layer || layer.locked, run: () => deleteLayerAsk(layer.id) });
  openMenu({ x: r.left, y: r.bottom + 4, label: 'Layers', items });
}

/** Bring a line's lane into view and put the keyboard on its first point. */
function revealLine(layerId) {
  const w = document.querySelector(`.line[data-layer="${layerId}"]`);
  if (w) w.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  tl.focusPoint(layerId, 0);
}
/** "Automate": draw the line for a param of a clip, or show the one it already has. */
function automate(clipId, param) {
  const has = S.project.layers.find((l) => l.kind === 'automation' && l.link.clipId === clipId && l.link.param === param);
  if (has) { revealLine(has.id); return Promise.resolve(); }
  return op('addAutomation', { clipId, param }).then((r) => { if (r && r.newLayerId) revealLine(r.newLayerId); });
}

/** The menu of a line: on a point, its curve and delete; anywhere on the lane, clear, copy, paste, bake into a constant, delete the line. */
function openLineMenu({ layerId, kind, index, t, v, x, y }) {
  const line = layerById(layerId);
  if (!line || line.kind !== 'automation') return;
  const param = line.link.param;
  const locked = line.locked;
  const items = [];
  if (kind === 'point') {
    const pt = line.points[index];
    items.push({ heading: `Point ${index + 1}: ${formatValue(param, pt.v)} at ${fmt(pt.t)}` });
    for (const curve of CURVES) items.push({ label: CURVE_LABEL[curve], hint: pt.curve === curve ? 'now' : '', disabled: locked || pt.curve === curve, run: () => op('setCurve', { layerId, index, curve }).then((r) => { if (r) tl.focusPoint(layerId, index); }) });
    items.push({ separator: true }, { label: 'Delete this point', hint: 'Del', disabled: locked || line.points.length < 2, run: () => op('deletePoint', { layerId, index }) });
  } else {
    items.push({ heading: `${PARAMS[param].label} line` });
    items.push({ label: `Add a point here (${formatValue(param, v)})`, disabled: locked, run: () => op('addPoint', { layerId, t, v, curve: param === 'mute' ? 'hold' : 'linear' }).then((r) => { if (r && r.pointIndex !== undefined) tl.focusPoint(layerId, r.pointIndex); }) });
  }
  items.push({ separator: true });
  items.push({ label: 'Clear the drawing', disabled: locked || line.points.length < 2, run: () => op('clearLane', { layerId }) });
  items.push({ label: 'Copy this line', run: () => { S.lineClip = layerId; notify('Line copied. Right-click a clip and choose "Paste the copied line here".'); } });
  const src = S.lineClip && S.lineClip !== layerId && layerById(S.lineClip);
  if (src && src.link.param === param) items.push({ label: 'Paste the copied line over this one', disabled: locked, run: () => op('pasteLane', { layerId, points: src.points }) });
  if (['gain', 'pan', 'opacity'].includes(param)) {
    items.push({ separator: true }, { heading: 'Bake into a constant (removes the line)' });
    for (const [at, label] of [['start', 'the first value'], ['mean', 'the average'], ['end', 'the last value']]) items.push({ label: `Use ${label}`, disabled: locked, run: () => op('flattenLane', { layerId, at }) });
  }
  items.push({ separator: true }, { label: 'Delete this line', run: () => op('deleteLayer', { layerId }) });
  openMenu({ x, y, label: `${PARAMS[param].label} line options`, items });
}

/** Pick the tool the lines are drawn with. */
function setTool(name) {
  S.tool = name;
  for (const t of ['pencil', 'freehand', 'line']) $(`tool-${t}`).setAttribute('aria-pressed', String(t === name));
  $('tolerance').hidden = name !== 'freehand';
  $('timeline-wrap').dataset.tool = name;
}

function renderLayerPicker() {
  const layerSel = $('media-layer');
  const keep = layerSel.value;
  layerSel.replaceChildren(...S.project.layers.filter((l) => l.kind !== 'subtitle').map((l) => h('option', { value: l.id }, l.name)));
  if ([...layerSel.options].some((o) => o.value === keep)) layerSel.value = keep;
}

function renderMediaPicker() {
  const select = $('media-select');
  select.replaceChildren(...S.media.map((m) => h('option', { value: m }, m)));
  renderLayerPicker();
  $('add-media').disabled = !S.media.length;
}

// ---------------------------------------------------------------- export

async function doExport() {
  const status = $('export-status');
  const bar = $('export-bar');
  const links = $('export-links');
  links.replaceChildren();
  $('export-go').disabled = true;
  try {
    if (S.dirty) { await save(); if (S.dirty) { status.textContent = 'Resolve the save conflict first.'; $('export-go').disabled = false; return; } }
    status.textContent = 'Starting...';
    bar.value = 0;
    bar.hidden = false;
    const { id } = await api.render(S.slug, $('burn').checked);
    const es = new EventSource(api.eventsUrl(id));
    let finished = false;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'start') status.textContent = 'Rendering...';
      if (e.type === 'progress') { bar.value = e.pct; status.textContent = `Rendering ${e.pct}%`; }
      if (e.type === 'done') {
        finished = true; es.close(); bar.value = 100; $('export-go').disabled = false;
        status.textContent = $('burn').checked ? 'Done. Subtitles are burned into the picture.' : 'Done. Subtitles are a separate track.';
        links.replaceChildren(...e.outputs.map((name) => h('a', { href: api.mediaUrl(name), download: name }, name)));
      }
      if (e.type === 'error') { finished = true; es.close(); $('export-go').disabled = false; bar.hidden = true; status.textContent = e.message; }
    };
    es.onerror = () => { if (!finished) { es.close(); $('export-go').disabled = false; status.textContent = 'Lost the connection to the render.'; } };
  } catch (e) {
    $('export-go').disabled = false;
    bar.hidden = true;
    status.textContent = e.message;
  }
}

// ---------------------------------------------------------------- opening

async function openProject(slug) {
  showEditor();
  S.slug = slug;
  S.selected = null;
  S.selection = [];
  S.clipboard = null;
  $('banner').hidden = true;
  $('export-links').replaceChildren();
  $('export-status').textContent = '';
  $('export-bar').hidden = true;
  try {
    const [r, src] = await Promise.all([api.load(slug), api.sources().catch(() => ({ media: [] }))]);
    S.media = src.media;
    S.playhead = 0;
    apply(r);
    renderMediaPicker();
    player.seek(0);
    tl.setPlayhead(0);
    tl.fit(Math.max(total(), 1000));
    if (r.recover) showRecover(r.recover);
    document.body.dataset.ready = slug;
  } catch (e) {
    notify(e.message, true);
    location.hash = '#/';
  }
}

// ---------------------------------------------------------------- start

const home = mountHome($('home'), { open: (slug) => { location.hash = `#/p/${encodeURIComponent(slug)}`; }, notify });

function route() {
  const m = /^#\/p\/([^/]+)$/.exec(location.hash);
  if (m) openProject(decodeURIComponent(m[1])); else showHome();
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

for (const [id, fn] of Object.entries({
  split: doSplit, copy: doCopy, paste: () => doPaste(), duplicate: doDuplicate, delete: doDelete, save: () => save(),
  undo: () => op('undo', undefined), redo: () => op('redo', undefined), play: togglePlay,
  'zoom-in': () => tl.zoomIn(), 'zoom-out': () => tl.zoomOut(), fit: () => tl.fit(Math.max(total(), 1000)), 'layers-menu': () => openLayersMenu(), 'add-sub': () => addSubtitle(), 'add-media': addMedia, 'add-layer': () => op('addLayer', { kind: $('add-layer-kind').value }), 'export-go': doExport,
})) $(id).addEventListener('click', fn);
$('player').addEventListener('click', () => { $('player').focus(); togglePlay(); });
$('seek').addEventListener('input', (e) => { scrubbing = true; seek(Number(e.target.value)); });
$('seek').addEventListener('change', () => { scrubbing = false; });
$('seek').addEventListener('pointerup', () => { scrubbing = false; });
$('seek').addEventListener('blur', () => { scrubbing = false; });
$('mute').addEventListener('click', toggleMute);
$('cc').addEventListener('click', toggleCaptions);
$('fullscreen').addEventListener('click', toggleFullscreen);
if (!document.fullscreenEnabled) $('fullscreen').hidden = true;
document.addEventListener('fullscreenchange', () => {
  const on = Boolean(document.fullscreenElement);
  $('fullscreen').setAttribute('aria-pressed', String(on));
  setIcon($('fullscreen'), on ? 'shrink' : 'expand');
  $('fullscreen').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
});
// The preview is big by default and the user's to resize: drag the grip under the controls (or use its keys), double-click to go back to the default.
// The chosen width is remembered for next time; the default is worked out from the window, so it is not stored until the user changes it.
const STAGE_W = 'studio-editor-stage-w';
const STAGE_MIN = 320;
const stageEl = $('stage');
const stageMax = () => Math.min(((stageEl.parentElement && stageEl.parentElement.clientWidth) || 1802) - 2, 1800); // the panel's own 1 px border is inside its width
const pictureW = () => $('picture').offsetWidth; // the preview's size is the width of its picture; the panel around it is always as wide as the timeline
function setStageWidth(px, { save = true } = {}) {
  const w = Math.round(Math.min(stageMax(), Math.max(STAGE_MIN, px)));
  stageEl.style.setProperty('--pic-w', `${w}px`);
  $('stage-grip').setAttribute('aria-valuenow', String(w));
  if (save) { try { localStorage.setItem(STAGE_W, String(w)); } catch { /* private mode: it lasts until reload */ } }
  return w;
}
function resetStage() {
  stageEl.style.removeProperty('--pic-w');
  try { localStorage.removeItem(STAGE_W); } catch { /* ignore */ }
  $('stage-grip').setAttribute('aria-valuenow', String(pictureW()));
}
try { const w = Number(localStorage.getItem(STAGE_W)); if (w >= STAGE_MIN && w <= 3000) stageEl.style.setProperty('--pic-w', `${w}px`); } catch { /* private mode */ }
{
  const grip = $('stage-grip');
  grip.setAttribute('aria-valuemin', String(STAGE_MIN));
  grip.setAttribute('aria-valuenow', String(pictureW()));
  let drag = null;
  grip.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; grip.setPointerCapture(e.pointerId); drag = { y: e.clientY, w: pictureW() }; grip.focus(); });
  grip.addEventListener('pointermove', (e) => { if (drag) setStageWidth(drag.w + ((e.clientY - drag.y) * 16) / 9); }); // dragging down by n px makes the 16:9 picture n px taller
  const endDrag = () => { drag = null; };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', resetStage);
  grip.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 40, ArrowRight: 40, ArrowUp: -40, ArrowLeft: -40, PageDown: 160, PageUp: -160 }[e.key];
    if (step !== undefined) setStageWidth(pictureW() + step);
    else if (e.key === 'Home') setStageWidth(480);
    else if (e.key === 'End') setStageWidth(stageMax());
    else if (e.key === 'Enter') resetStage();
    else return;
    e.preventDefault();
    e.stopPropagation(); // the arrow keys are the grip's while it has focus, not the timeline's
  });
}
$('add-note').addEventListener('click', addNote);
window.addEventListener('resize', () => renderNoteMarks());
$('note-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } e.stopPropagation(); });
$('pan').addEventListener('input', (e) => tl.panTo(Number(e.target.value) / 1000));
$('tool-pencil').addEventListener('click', () => setTool('pencil'));
$('tool-freehand').addEventListener('click', () => setTool('freehand'));
$('tool-line').addEventListener('click', () => setTool('line'));
$('tolerance').addEventListener('input', (e) => { S.tolerance = 0.005 + (Number(e.target.value) / 100) * 0.12; });
$('autosave').checked = autosaveOn;
$('autosave').addEventListener('change', (e) => { autosaveOn = e.target.checked; writePref(autosaveOn); renderSaveState(); notify(autosaveOn ? 'Auto-save is on.' : 'Auto-save is off. Use Save (Ctrl+S).'); });
$('ripple').addEventListener('click', () => { S.ripple = !S.ripple; $('ripple').setAttribute('aria-pressed', String(S.ripple)); });
$('rename-here').addEventListener('click', async () => {
  const name = await ask({ title: 'Rename project', text: 'The new name becomes the file name (letters, digits, dots, dashes).', input: S.slug, confirmLabel: 'Rename' });
  if (!name || name === S.slug) return;
  if (S.dirty) await save();
  try { const r = await api.rename(S.slug, name.trim(), S.rev); location.hash = `#/p/${encodeURIComponent(r.slug)}`; } catch (e) { notify(e.message, true); }
});

document.addEventListener('keydown', (e) => {
  if ($('editor').hidden || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const typing = isTyping(e);
  if (mod && key === 's') { e.preventDefault(); save(); return; }
  if (typing) return;
  if (key === 'contextmenu' || (e.shiftKey && key === 'f10')) {
    e.preventDefault();
    if (!S.selected) return notify('Select a clip first (Alt+arrows), then press the Menu key.', true);
    const r = (tl.elementOf(S.selected) || $('timeline-wrap')).getBoundingClientRect();
    openClipMenu({ id: S.selected, x: r.left + Math.min(40, r.width / 2), y: r.bottom });
    return;
  }
  if (mod && key === 'z') { e.preventDefault(); op(e.shiftKey ? 'redo' : 'undo', undefined); return; }
  if (mod && key === 'y') { e.preventDefault(); op('redo', undefined); return; }
  if (mod && key === 'a') { e.preventDefault(); setSel(clips().map((c) => c.id)); return; }
  if (mod && key === 'c') { if (!String(window.getSelection())) { e.preventDefault(); doCopy(); } return; }
  if (mod && key === 'v') { e.preventDefault(); doPaste(); return; }
  if (mod && key === 'd') {
    e.preventDefault();
    const c = S.selected && clipById(S.selected);
    if (e.shiftKey) { if (c) op('duplicateLayer', { layerId: c.layerId }); else notify('Select a clip on the layer to duplicate.', true); } else doDuplicate();
    return;
  }
  if (mod && (key === 'arrowleft' || key === 'arrowright') && e.target.tagName !== 'BUTTON') { e.preventDefault(); seekBy(key === 'arrowleft' ? -stepOf(e) : stepOf(e)); return; }
  if (mod || e.altKey && !['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) return;
  const onButton = e.target.tagName === 'BUTTON';
  if (key === 's') { e.preventDefault(); doSplit(); } else if (key === 'delete' || key === 'backspace') { e.preventDefault(); doDelete(); } else if (key === ' ' && !onButton) { e.preventDefault(); togglePlay(); } else if (key === 'enter' && !onButton && S.selected) { e.preventDefault(); editSubtitle(S.selected); } else if (key === 'escape') { setSel([]); } else if (key === 'home') { e.preventDefault(); seek(0); } else if (key === 'end') { e.preventDefault(); seek(total()); } else if (key === '+' || key === '=') { tl.zoomIn(); } else if (key === '-') { tl.zoomOut(); } else if (e.altKey && key === 'arrowleft') { e.preventDefault(); selectRelative(-1); } else if (e.altKey && key === 'arrowright') { e.preventDefault(); selectRelative(1); } else if (e.altKey && key === 'arrowup') { e.preventDefault(); selectLane(-1); } else if (e.altKey && key === 'arrowdown') { e.preventDefault(); selectLane(1); } else if (key === 'arrowleft' && !onButton) { e.preventDefault(); seekBy(-stepOf(e)); } else if (key === 'arrowright' && !onButton) { e.preventDefault(); seekBy(stepOf(e)); } else if (key === 'k') { e.preventDefault(); togglePlay(); } else if (key === 'j') { e.preventDefault(); seekBy(-1000); } else if (key === 'l') { e.preventDefault(); seekBy(1000); } else if (key === 'm') { e.preventDefault(); toggleMute(); } else if (key === 'c') { e.preventDefault(); toggleCaptions(); } else if (key === 'f') { e.preventDefault(); toggleFullscreen(); } else if (key === 'pageup') { e.preventDefault(); tl.panBy(-0.8); } else if (key === 'pagedown') { e.preventDefault(); tl.panBy(0.8); } else if (key === '[') { e.preventDefault(); jumpEdge(-1); } else if (key === ']') { e.preventDefault(); jumpEdge(1); }
});

route();
