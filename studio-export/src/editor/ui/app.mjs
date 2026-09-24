// The editor page. It holds the project the server last sent, the selection, the playhead and a clipboard (a clip id); every
// change to the project is an op sent to the server (api.ops), which answers with the whole new project. Undo, redo, save and
// the recovery copy are the server's too. Here: wiring, shortcuts, the inspector and the export panel.
import { api } from './api.mjs';
import { ask, fmt, h } from './dom.mjs';
import { createPlayer } from './player.mjs';
import { mountHome } from './projects.mjs';
import { createTimeline } from './timeline.mjs';

const $ = (id) => document.getElementById(id);
const S = { slug: null, project: null, rev: 0, dirty: false, canUndo: false, canRedo: false, selected: null, clipboard: null, playhead: 0, ripple: false, media: [] };
let tl = null;
let player = null;
let chain = Promise.resolve();
let toastTimer = 0;
let autosaveTimer = 0;
let editing = null;

const clips = () => (S.project ? S.project.layers.flatMap((l) => l.clips.map((c) => ({ ...c, kind: l.kind, layerId: l.id, locked: l.locked }))) : []);
const clipById = (id) => clips().find((c) => c.id === id) || null;
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
  document.title = 'Studio editor';
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
      onTime(t) { S.playhead = t; tl.setPlayhead(t); showTime(); },
      onEnd() { $('play').textContent = 'Play'; $('play').setAttribute('aria-pressed', 'false'); },
    });
    tl = createTimeline($('timeline'), {
      select: (id) => { S.selected = id; renderInspector(); renderToolbar(); if (id) announce(id); },
      playhead: (ms) => { S.playhead = ms; player.seek(ms); showTime(); },
      move: (m) => moveOrTrim(m),
      edit: (id) => editSubtitle(id),
      layerFlag: (layerId, flag, value) => op('setLayerFlag', { layerId, flag, value }),
    });
  }
}

function showTime() {
  $('time').textContent = `${fmt(S.playhead)} / ${fmt(total())}`;
}

function announce(id) {
  const c = clipById(id);
  if (c) $('live').textContent = `${c.kind} clip ${c.kind === 'subtitle' ? c.text : c.src}, ${fmt(c.start)} to ${fmt(c.start + c.duration)}`;
}

function render() {
  if (!S.project) return;
  $('project-name').textContent = S.project.name || S.slug;
  document.title = `${S.project.name || S.slug} - Studio editor`;
  if (S.selected && !clipById(S.selected)) S.selected = null;
  tl.setProject(S.project, S.selected);
  player.setProject(S.project);
  renderInspector();
  renderToolbar();
  renderSaveState();
  showTime();
}

function renderSaveState() {
  const el = $('save-state');
  el.textContent = S.dirty ? 'Unsaved changes' : 'Saved';
  el.dataset.state = S.dirty ? 'dirty' : 'saved';
  $('save').disabled = !S.dirty;
  clearTimeout(autosaveTimer);
  if (S.dirty) autosaveTimer = setTimeout(() => { if (S.dirty) el.textContent = 'Unsaved changes, recovery copy kept'; }, 1600);
}

function renderToolbar() {
  const sel = S.selected ? clipById(S.selected) : null;
  const here = S.project ? clips().filter((c) => S.playhead > c.start && S.playhead < c.start + c.duration) : [];
  $('split').disabled = !(sel ? sel.start < S.playhead && S.playhead < sel.start + sel.duration : here.length);
  $('copy').disabled = !sel;
  $('paste').disabled = !S.clipboard;
  $('duplicate').disabled = !sel;
  $('delete').disabled = !sel;
  $('undo').disabled = !S.canUndo;
  $('redo').disabled = !S.canRedo;
}

function renderInspector() {
  const box = $('inspector');
  const c = S.selected ? clipById(S.selected) : null;
  if (!c) { box.replaceChildren(h('p', { class: 'muted' }, 'Select a clip to see its details. Double-click a subtitle to edit its text.')); return; }
  const layer = layerById(c.layerId);
  const facts = h('dl', { class: 'facts' },
    h('dt', {}, 'Layer'), h('dd', {}, `${layer.name}${layer.locked ? ' (locked)' : ''}`),
    h('dt', {}, 'Start'), h('dd', {}, fmt(c.start)), h('dt', {}, 'Length'), h('dd', {}, fmt(c.duration)),
    c.kind === 'subtitle' ? null : [h('dt', {}, 'File'), h('dd', {}, c.src), h('dt', {}, 'From'), h('dd', {}, fmt(c.in))]);
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
    const cur = c.gain !== undefined ? c.gain : c.kind === 'music' ? 0.04 : 1;
    const num = h('output', {}, cur.toFixed(2));
    const range = h('input', { id: 'gain', type: 'range', min: 0, max: 2, step: 0.01, value: String(Math.min(2, cur)), disabled: c.locked, 'aria-label': 'Gain' });
    range.addEventListener('input', () => { num.textContent = Number(range.value).toFixed(2); });
    range.addEventListener('change', () => op('setClipGain', { clipId: c.id, gain: Number(range.value) }));
    parts.push(h('label', { for: 'gain' }, 'Gain ', num), range);
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
      if (r.newClipId && (name === 'copyClip' || name === 'addSubtitle' || name === 'addClip')) S.selected = r.newClipId;
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

function moveOrTrim({ id, start, end, layerId }) {
  const c = clipById(id);
  if (!c) return;
  const cEnd = c.start + c.duration;
  if (end - start !== c.duration) {
    if (start !== c.start && end === cEnd) op('trimClip', { clipId: id, edge: 'start', toMs: start });
    else if (start === c.start && end !== cEnd) op('trimClip', { clipId: id, edge: 'end', toMs: end });
    else render();
  } else if (start !== c.start || layerId !== c.layerId) op('moveClip', { clipId: id, toStartMs: start, toLayerId: layerId });
}

async function save() {
  chain = chain.then(async () => {
    if (!S.slug || !S.project) return;
    try { apply(await api.save(S.slug, S.project, S.rev)); notify('Saved.'); } catch (e) {
      if (e.code === 'STALE_REV') showConflict(e.data.current);
      else notify(e.message, true);
    }
  });
  return chain;
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
  const sel = S.selected ? clipById(S.selected) : null;
  const target = sel && sel.start < S.playhead && S.playhead < sel.start + sel.duration ? sel : (playheadClipOf('video') || clips().find((c) => !c.locked && S.playhead > c.start && S.playhead < c.start + c.duration));
  if (!target) return notify('Put the playhead inside a clip to split it.', true);
  return op('splitClip', { clipId: target.id, atMs: Math.round(S.playhead) });
}
function doCopy() { const c = S.selected && clipById(S.selected); if (c) { S.clipboard = { id: c.id, kind: c.kind, layerId: c.layerId }; renderToolbar(); notify('Copied. Press Ctrl+V to paste at the playhead.'); } }
function doPaste() {
  if (!S.clipboard) return notify('Copy a clip first.', true);
  const sel = S.selected && clipById(S.selected);
  const toLayerId = sel && sel.kind === S.clipboard.kind ? sel.layerId : S.clipboard.layerId;
  return op('copyClip', { clipId: S.clipboard.id, toStartMs: Math.round(S.playhead), toLayerId });
}
function doDuplicate() { const c = S.selected && clipById(S.selected); if (c) op('copyClip', { clipId: c.id, toStartMs: c.start + c.duration }); }
function doDelete() { if (S.selected) { const id = S.selected; S.selected = null; op('deleteClip', { clipId: id, ripple: S.ripple }); } }

function seek(ms) { S.playhead = player.seek(ms); tl.setPlayhead(S.playhead); showTime(); renderToolbar(); }
function togglePlay() {
  const on = player.toggle();
  $('play').textContent = on ? 'Pause' : 'Play';
  $('play').setAttribute('aria-pressed', String(on));
}

function selectRelative(dir) {
  const cur = S.selected && clipById(S.selected);
  if (!cur) { const first = clips().sort((a, b) => a.start - b.start)[0]; if (first) { S.selected = first.id; tl.setSelection(first.id); renderInspector(); renderToolbar(); announce(first.id); } return; }
  const row = clips().filter((c) => c.layerId === cur.layerId).sort((a, b) => a.start - b.start);
  const next = row[row.findIndex((c) => c.id === cur.id) + dir];
  if (next) { S.selected = next.id; tl.setSelection(next.id); renderInspector(); renderToolbar(); announce(next.id); }
}
function selectLane(delta) {
  const cur = S.selected && clipById(S.selected);
  const i = cur ? S.project.layers.findIndex((l) => l.id === cur.layerId) : -1;
  const layer = S.project.layers[Math.max(0, Math.min(S.project.layers.length - 1, i + delta))];
  const pick = layer.clips.find((c) => S.playhead >= c.start && S.playhead < c.start + c.duration) || layer.clips[0];
  if (pick) { S.selected = pick.id; tl.setSelection(pick.id); renderInspector(); renderToolbar(); announce(pick.id); }
}

function editSubtitle(id) {
  const c = clipById(id);
  if (!c || c.kind !== 'subtitle') return;
  if (c.locked) return notify('That layer is locked.', true);
  const item = tl.elementOf(id);
  const wrap = $('timeline-wrap');
  if (editing) editing.remove();
  const box = wrap.getBoundingClientRect();
  const r = item ? item.getBoundingClientRect() : { left: box.left + 60, top: box.top + 60, height: 30 };
  const input = h('input', { type: 'text', class: 'inline-edit', 'aria-label': 'Subtitle text', maxlength: 500, value: c.text });
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

function addSubtitle() {
  const layer = S.project.layers.find((l) => l.kind === 'subtitle' && !l.locked);
  if (!layer) return notify('There is no unlocked subtitle layer.', true);
  op('addSubtitle', { layerId: layer.id, startMs: Math.round(S.playhead), durationMs: 2000, text: 'New subtitle' }).then((r) => { if (r) editSubtitle(r.newClipId); });
}

async function addMedia() {
  const name = $('media-select').value;
  const layerId = $('media-layer').value;
  if (!name || !layerId) return;
  const el = /\.(webm|mp4|mov|mkv)$/i.test(name) ? document.createElement('video') : new Audio();
  const ms = await new Promise((resolve) => {
    el.preload = 'metadata';
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0);
    el.onerror = () => resolve(0);
    el.src = api.mediaUrl(name);
  });
  if (!ms) return notify(`Could not read the length of ${name}. Is it a playable media file?`, true);
  op('addClip', { layerId, src: name, start: Math.round(S.playhead), duration: ms, in: 0 });
}

function renderMediaPicker() {
  const select = $('media-select');
  select.replaceChildren(...S.media.map((m) => h('option', { value: m }, m)));
  const layerSel = $('media-layer');
  layerSel.replaceChildren(...S.project.layers.filter((l) => l.kind !== 'subtitle').map((l) => h('option', { value: l.id }, l.name)));
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
  split: doSplit, copy: doCopy, paste: doPaste, duplicate: doDuplicate, delete: doDelete, save,
  undo: () => op('undo', undefined), redo: () => op('redo', undefined), play: togglePlay,
  'zoom-in': () => tl.zoomIn(), 'zoom-out': () => tl.zoomOut(), fit: () => tl.fit(Math.max(total(), 1000)), 'add-sub': addSubtitle, 'add-media': addMedia, 'export-go': doExport,
})) $(id).addEventListener('click', fn);
$('ripple').addEventListener('change', (e) => { S.ripple = e.target.checked; });
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
  if (mod && key === 'z') { e.preventDefault(); op(e.shiftKey ? 'redo' : 'undo', undefined); return; }
  if (mod && key === 'y') { e.preventDefault(); op('redo', undefined); return; }
  if (mod && key === 'c') { if (!String(window.getSelection())) { e.preventDefault(); doCopy(); } return; }
  if (mod && key === 'v') { e.preventDefault(); doPaste(); return; }
  if (mod && key === 'd') { e.preventDefault(); doDuplicate(); return; }
  if (mod || e.altKey && !['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) return;
  const onButton = e.target.tagName === 'BUTTON';
  if (key === 's') { e.preventDefault(); doSplit(); } else if (key === 'delete' || key === 'backspace') { e.preventDefault(); doDelete(); } else if (key === ' ' && !onButton) { e.preventDefault(); togglePlay(); } else if (key === 'enter' && !onButton && S.selected) { e.preventDefault(); editSubtitle(S.selected); } else if (key === 'escape') { S.selected = null; tl.setSelection(null); renderInspector(); renderToolbar(); } else if (key === 'home') { e.preventDefault(); seek(0); } else if (key === 'end') { e.preventDefault(); seek(total()); } else if (key === '+' || key === '=') { tl.zoomIn(); } else if (key === '-') { tl.zoomOut(); } else if (e.altKey && key === 'arrowleft') { e.preventDefault(); selectRelative(-1); } else if (e.altKey && key === 'arrowright') { e.preventDefault(); selectRelative(1); } else if (e.altKey && key === 'arrowup') { e.preventDefault(); selectLane(-1); } else if (e.altKey && key === 'arrowdown') { e.preventDefault(); selectLane(1); } else if (key === 'arrowleft' && !onButton) { e.preventDefault(); seek(S.playhead - (e.shiftKey ? 1000 : 100)); } else if (key === 'arrowright' && !onButton) { e.preventDefault(); seek(S.playhead + (e.shiftKey ? 1000 : 100)); }
});

route();
