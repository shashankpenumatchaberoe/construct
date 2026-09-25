// The editor's pure, immutable operations: each op on every layer kind, locks, overlap rules, copy rules, ripple, history bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, MAX_NOTES, MIN_CLIP_MS, validateProject } from '../src/editor/project.mjs';
import {
  OPS, addNote, deleteNote, editNote, addAutomation, addClip, addLayer, addPoint, clearLane, copyClips, copyLane, deleteClips, deletePoint, flattenLane, moveClips, movePoint, pasteLane, setClipPan, setCurve, setLayerGain, setLayerPan, setMasterGain, setClipOpacity, setClipSpeed, setClipZoom, addSubtitle, applyOp, copyClip, createHistory, deleteClip, deleteLayer, duplicateLayer, moveClip, nextClipId, nextLayerId, setClipGain, setLayerFlag, setSubtitleText, splitClip, splitText, trimClip,
} from '../src/editor/ops.mjs';
import { sampleProject } from '../src/editor/sample.mjs';

const layer = (p, id) => p.layers.find((l) => l.id === id);
const clip = (p, id) => p.layers.flatMap((l) => l.clips).find((c) => c.id === id);
const good = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(validateProject(r.project).ok, true, 'the result is a valid project'); return r.project; };
const code = (r) => { assert.equal(r.ok, false); return r.code; };
const lock = (p, id) => good(setLayerFlag(p, id, 'locked', true));

test('ops never touch their input and results are valid projects', () => {
  const p = sampleProject();
  const frozen = JSON.stringify(p);
  good(splitClip(p, 'c1', 4000));
  good(trimClip(p, 'c1', 'end', 8000));
  good(moveClip(p, 'c4', 100));
  good(copyClip(p, 'c2', 500));
  good(deleteClip(p, 'c4'));
  good(setSubtitleText(p, 'c4', 'new'));
  assert.equal(JSON.stringify(p), frozen);
});

for (const [id, kind] of [['c1', 'video'], ['c2', 'voice'], ['c3', 'music'], ['c4', 'subtitle']]) {
  test(`splitClip on a ${kind} clip: two halves that cover it exactly, the left keeps the id`, () => {
    const p0 = sampleProject();
    const c0 = clip(p0, id);
    const at = c0.start + 1000;
    const r = splitClip(p0, id, at);
    const p = good(r);
    const left = clip(p, id);
    const right = clip(p, r.newClipId);
    assert.equal(left.start, c0.start);
    assert.equal(left.duration, 1000);
    assert.equal(right.start, at);
    assert.equal(right.duration, c0.duration - 1000);
    assert.equal(right.in, kind === 'subtitle' ? 0 : c0.in + 1000, 'the source offset advances for media');
    if (kind === 'subtitle') assert.equal(`${left.text} ${right.text}`, c0.text, 'the text is split, not lost');
    else assert.equal(right.src, c0.src);
    assert.equal(nextClipId(p0), 'c6');
    assert.equal(r.newClipId, 'c6');
  });
}

test('splitClip keeps gain on both halves and refuses a cut outside the clip or too close to an edge', () => {
  const p = good(setClipGain(sampleProject(), 'c3', 0.5));
  const r = splitClip(p, 'c3', 2000);
  assert.equal(clip(r.project, 'c3').gain, 0.5);
  assert.equal(clip(r.project, r.newClipId).gain, 0.5);
  assert.equal(code(splitClip(p, 'c3', 0)), ERR.OUT_OF_CLIP);
  assert.equal(code(splitClip(p, 'c3', 10000)), ERR.OUT_OF_CLIP);
  assert.equal(code(splitClip(p, 'c3', 20000)), ERR.OUT_OF_CLIP);
  assert.equal(code(splitClip(p, 'c3', MIN_CLIP_MS - 1)), ERR.TOO_SHORT);
  assert.equal(code(splitClip(p, 'c3', 1.5)), ERR.BAD_ARG);
  assert.equal(code(splitClip(p, 'zz', 100)), ERR.NO_CLIP);
});

test('a subtitle splits its text at a given character index, or in half at the space nearest the middle', () => {
  const p = sampleProject(); // "Hello there, this is Studio"
  const at = splitClip(p, 'c4', 1500, { textIndex: 5 });
  assert.deepEqual([clip(at.project, 'c4').text, clip(at.project, at.newClipId).text], ['Hello', 'there, this is Studio']);
  const half = splitClip(p, 'c4', 1500);
  assert.deepEqual([clip(half.project, 'c4').text, clip(half.project, half.newClipId).text], ['Hello there,', 'this is Studio']);
  assert.deepEqual(splitText('abcdef'), ['abc', 'def'], 'no space: split at the middle');
  assert.equal(splitText('a'), null);
  assert.equal(code(splitClip(p, 'c4', 1500, { textIndex: 999 })), ERR.BAD_TEXT);
  assert.equal(code(splitClip(p, 'c4', 1500, { textIndex: 0 })), ERR.BAD_ARG);
});

test('trimClip moves the source offset for media and only the times for a subtitle', () => {
  const p = sampleProject();
  const s = good(trimClip(p, 'c1', 'start', 2000));
  assert.deepEqual([clip(s, 'c1').start, clip(s, 'c1').duration, clip(s, 'c1').in], [2000, 8000, 2000], 'the picture stays put: in moves with start');
  const e = good(trimClip(p, 'c2', 'end', 6000));
  assert.deepEqual([clip(e, 'c2').start, clip(e, 'c2').duration, clip(e, 'c2').in], [0, 6000, 0]);
  const t = good(trimClip(p, 'c4', 'start', 1000));
  assert.deepEqual([clip(t, 'c4').start, clip(t, 'c4').duration, clip(t, 'c4').in], [1000, 2500, 0]);
  const again = good(trimClip(s, 'c1', 'start', 1500));
  assert.equal(clip(again, 'c1').in, 1500, 'extending back toward the source start works');
  assert.equal(code(trimClip(good(moveClip(p, 'c1', 5000)), 'c1', 'start', 3000)), ERR.BEFORE_SOURCE, 'cannot reveal what is before the source');
  assert.equal(code(trimClip(p, 'c1', 'end', 10)), ERR.TOO_SHORT);
  assert.equal(code(trimClip(p, 'c1', 'start', 9990)), ERR.TOO_SHORT);
  assert.equal(code(trimClip(p, 'c1', 'middle', 100)), ERR.BAD_ARG);
  assert.equal(code(trimClip(p, 'c1', 'end', -5)), ERR.BAD_ARG);
});

test('a trim that would touch a neighbour on a subtitle layer is an OVERLAP; on video and mixed layers it is fine', () => {
  const p = sampleProject();
  assert.equal(code(trimClip(p, 'c4', 'end', 4500)), ERR.OVERLAP, 'subtitle c4 into c5');
  const v = good(splitClip(p, 'c1', 5000));
  good(trimClip(v, 'c1', 'end', 6000)); // video halves may overlap: the later one goes under
  const mixed = good(splitClip(p, 'c2', 5000));
  good(trimClip(mixed, 'c2', 'end', 7000));
});

test('locked layers refuse every edit; unlocking works on the locked layer itself', () => {
  const p = lock(lock(lock(lock(sampleProject(), 'video'), 'voice'), 'music'), 'subs');
  const attempts = [
    splitClip(p, 'c1', 2000), trimClip(p, 'c2', 'end', 5000), moveClip(p, 'c3', 100), copyClip(p, 'c1', 0, 'video'), deleteClip(p, 'c4'), setSubtitleText(p, 'c4', 'x'),
    addSubtitle(p, 'subs', 8000, 1000, 'x'), addClip(p, 'video', { src: 'a.webm', start: 20000, duration: 1000 }), setClipGain(p, 'c2', 1),
  ];
  for (const r of attempts) assert.equal(code(r), ERR.LOCKED);
  const back = good(setLayerFlag(p, 'subs', 'locked', false));
  good(setSubtitleText(back, 'c4', 'now editable'));
  assert.equal(layer(back, 'video').locked, true);
});

test('moveClip: same-kind layers only; copyClip: same rule; a locked target refuses', () => {
  let p = sampleProject();
  p = good(addClip(p, 'voice', { src: 'b.opus', start: 0, duration: 1000 }));
  p.layers.push({ id: 'voice2', kind: 'voice', name: 'Voice 2', muted: false, locked: false, clips: [] });
  p.layers.push({ id: 'subs2', kind: 'subtitle', name: 'Subs 2', muted: false, locked: false, clips: [] });
  const mv = good(moveClip(p, 'c2', 500, 'voice2'));
  assert.equal(layer(mv, 'voice2').clips[0].start, 500);
  assert.equal(layer(mv, 'voice').clips.some((c) => c.id === 'c2'), false, 'moved off the old layer');
  assert.equal(code(moveClip(p, 'c2', 0, 'music')), ERR.KIND_MISMATCH);
  assert.equal(code(moveClip(p, 'c4', 0, 'video')), ERR.KIND_MISMATCH);
  assert.equal(code(moveClip(p, 'c2', 0, 'nope')), ERR.NO_LAYER);
  assert.equal(code(moveClip(p, 'c2', -1)), ERR.BAD_ARG);
  const cp = copyClip(p, 'c4', 20000, 'subs2');
  const q = good(cp);
  assert.equal(layer(q, 'subs2').clips[0].text, clip(p, 'c4').text);
  assert.notEqual(cp.newClipId, 'c4');
  assert.ok(clip(q, 'c4'), 'the original stays');
  assert.equal(code(copyClip(p, 'c4', 0, 'video')), ERR.KIND_MISMATCH);
  assert.equal(code(copyClip(p, 'c1', 0, 'voice')), ERR.KIND_MISMATCH);
  assert.equal(code(copyClip(lock(p, 'subs2'), 'c4', 0, 'subs2')), ERR.LOCKED);
  // copying out of a locked layer is allowed: only the target must be unlocked
  good(copyClip(lock(p, 'subs'), 'c4', 20000, 'subs2'));
});

test('overlap rules: only subtitles refuse an overlapping move/copy; video, voice and music allow it', () => {
  const p = sampleProject();
  assert.equal(code(moveClip(p, 'c5', 1000)), ERR.OVERLAP);
  assert.equal(code(copyClip(p, 'c4', 1000)), ERR.OVERLAP);
  assert.equal(layer(good(copyClip(p, 'c1', 5000)), 'video').clips.length, 2, 'video overlaps itself');
  assert.equal(code(addSubtitle(p, 'subs', 3000, 2000, 'x')), ERR.OVERLAP);
  const v = good(copyClip(p, 'c2', 5000));
  assert.equal(layer(v, 'voice').clips.length, 2, 'voice overlaps itself');
  good(copyClip(p, 'c3', 5000));
  good(moveClip(p, 'c4', 1000)); // touching (ends where the next begins) is not overlapping
  good(addSubtitle(p, 'subs', 3500, 500, 'edge to edge'));
});

test('deleteClip closes the gap only with ripple, and only on its own layer', () => {
  const p = sampleProject();
  const plain = good(deleteClip(p, 'c4'));
  assert.equal(clip(plain, 'c5').start, 4000);
  const rip = good(deleteClip(p, 'c4', { ripple: true }));
  assert.equal(clip(rip, 'c5').start, 1000, 'shifted left by the deleted length');
  assert.equal(clip(rip, 'c1').start, 0);
  assert.equal(clip(rip, 'c2').start, 0, 'other layers are not shifted');
  assert.equal(clip(rip, 'c4'), undefined);
  const rippleFirst = good(deleteClip(p, 'c5', { ripple: true }));
  assert.equal(clip(rippleFirst, 'c4').start, 500, 'earlier clips stay');
  assert.equal(code(deleteClip(p, 'zz')), ERR.NO_CLIP);
});

test('subtitle text ops: edit, add, and the errors', () => {
  const p = sampleProject();
  assert.equal(clip(good(setSubtitleText(p, 'c4', '  Fresh words  ')), 'c4').text, 'Fresh words');
  assert.equal(code(setSubtitleText(p, 'c4', '   ')), ERR.BAD_TEXT);
  assert.equal(code(setSubtitleText(p, 'c4', 'x'.repeat(501))), ERR.BAD_TEXT);
  assert.equal(code(setSubtitleText(p, 'c4', 5)), ERR.BAD_TEXT);
  assert.equal(code(setSubtitleText(p, 'c1', 'x')), ERR.NOT_SUBTITLE);
  const a = addSubtitle(p, 'subs', 8000, 1500, 'Added');
  assert.deepEqual([clip(good(a), a.newClipId).start, clip(a.project, a.newClipId).duration, clip(a.project, a.newClipId).in], [8000, 1500, 0]);
  assert.equal(code(addSubtitle(p, 'video', 0, 100, 'x')), ERR.NOT_SUBTITLE);
  assert.equal(code(addSubtitle(p, 'nope', 0, 100, 'x')), ERR.NO_LAYER);
  assert.equal(code(addSubtitle(p, 'subs', 8000, 5, 'x')), ERR.BAD_ARG);
  assert.equal(code(addSubtitle(p, 'subs', 8000, 500, '')), ERR.BAD_TEXT);
});

test('addClip, setClipGain and setLayerFlag validate their arguments', () => {
  const p = sampleProject();
  const a = addClip(p, 'voice', { src: 'extra.opus', start: 1000, duration: 2000, inMs: 500, gain: 0.8 });
  assert.deepEqual(clip(good(a), a.newClipId), { id: a.newClipId, start: 1000, duration: 2000, in: 500, src: 'extra.opus', gain: 0.8 });
  assert.equal(code(addClip(p, 'voice', { src: '../x.opus', start: 0, duration: 100 })), ERR.BAD_ARG);
  assert.equal(code(addClip(p, 'voice', { src: '/etc/passwd', start: 0, duration: 100 })), ERR.BAD_ARG);
  assert.equal(code(addClip(p, 'voice', { src: 'notes.txt', start: 0, duration: 100 })), ERR.BAD_ARG);
  assert.equal(code(addClip(p, 'subs', { src: 'a.webm', start: 0, duration: 100 })), ERR.KIND_MISMATCH);
  assert.equal(code(addClip(p, 'video', { src: 'a.webm', start: 0, duration: 100, gain: 1 })), ERR.BAD_GAIN);
  assert.equal(clip(good(setClipGain(p, 'c3', 0.25)), 'c3').gain, 0.25);
  assert.equal(code(setClipGain(p, 'c3', 9)), ERR.BAD_GAIN);
  assert.equal(code(setClipGain(p, 'c1', 1)), ERR.BAD_GAIN);
  assert.equal(layer(good(setLayerFlag(p, 'video', 'muted', true)), 'video').muted, true);
  assert.equal(code(setLayerFlag(p, 'video', 'hidden', true)), ERR.BAD_ARG);
  assert.equal(code(setLayerFlag(p, 'video', 'muted', 'yes')), ERR.BAD_ARG);
  assert.equal(code(setLayerFlag(p, 'nope', 'muted', true)), ERR.NO_LAYER);
});

test('applyOp maps named ops with args and rejects unknown names and bad args', () => {
  const p = sampleProject();
  assert.deepEqual(Object.keys(OPS).sort(), ['addAutomation', 'addClip', 'addLayer', 'addNote', 'addPoint', 'addSubtitle', 'clearLane', 'copyClip', 'copyClips', 'copyLane', 'deleteClip', 'deleteClips', 'deleteLayer', 'deleteNote', 'deletePoint', 'duplicateLayer', 'editNote', 'flattenLane', 'moveClip', 'moveClips', 'movePoint', 'pasteLane', 'setClipGain', 'setClipOpacity', 'setClipPan', 'setClipSpeed', 'setClipZoom', 'setCurve', 'setLayerFlag', 'setLayerGain', 'setLayerPan', 'setMasterGain', 'setSubtitleText', 'splitClip', 'trimClip']);
  assert.equal(good(applyOp(p, 'splitClip', { clipId: 'c1', atMs: 3000 })).layers[0].clips.length, 2);
  assert.equal(good(applyOp(p, 'deleteClip', { clipId: 'c4', ripple: true })).layers[3].clips[0].start, 1000);
  assert.equal(code(applyOp(p, 'format', {})), ERR.UNKNOWN_OP);
  assert.equal(code(applyOp(p, '__proto__', {})), ERR.UNKNOWN_OP);
  assert.equal(code(applyOp(p, 'toString', {})), ERR.UNKNOWN_OP);
  assert.equal(code(applyOp(p, 'splitClip', null)), ERR.BAD_ARG);
  assert.equal(code(applyOp(p, 'splitClip', { clipId: 'c1', atMs: '3000' })), ERR.BAD_ARG);
});

test('history: undo and redo walk immutable projects; a new edit drops the redo branch; bounded to 100', () => {
  const h = createHistory(sampleProject());
  assert.equal(h.canUndo, false);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), null);
  const p0 = h.present;
  const p1 = h.push(good(setSubtitleText(h.present, 'c4', 'one')));
  const p2 = h.push(good(setSubtitleText(h.present, 'c4', 'two')));
  assert.equal(h.undo(), p1);
  assert.equal(h.undo(), p0);
  assert.equal(h.canUndo, false);
  assert.equal(h.redo(), p1);
  const p3 = h.push(good(setSubtitleText(h.present, 'c4', 'three')));
  assert.equal(h.canRedo, false, 'a new edit forks the history');
  assert.notEqual(p3, p2);
  assert.equal(clip(p0, 'c4').text, 'Hello there, this is Studio', 'old snapshots are untouched');
  const long = createHistory(sampleProject());
  for (let i = 0; i < 150; i++) long.push(good(setClipGain(long.present, 'c3', (i % 40) / 10)));
  assert.equal(long.undoDepth, 100);
  let n = 0;
  while (long.undo()) n++;
  assert.equal(n, 100, 'only the last 100 steps can be undone');
  const tiny = createHistory(sampleProject(), 3);
  for (let i = 0; i < 6; i++) tiny.push(good(setClipGain(tiny.present, 'c3', i / 10)));
  assert.equal(tiny.undoDepth, 3);
  tiny.reset(sampleProject());
  assert.equal(tiny.canUndo || tiny.canRedo, false);
});

test('duplicateLayer: a copy right below with new ids, the same times and sources, never locked; the original is untouched', () => {
  const p0 = lock(sampleProject(), 'subs');
  const r = duplicateLayer(p0, 'subs');
  const p = good(r);
  assert.equal(r.newLayerId, 'l1');
  assert.deepEqual(p.layers.map((l) => l.id), ['video', 'voice', 'music', 'subs', 'l1']);
  const copy = layer(p, 'l1');
  assert.equal(copy.kind, 'subtitle');
  assert.equal(copy.name, 'Subtitles copy');
  assert.equal(copy.locked, false, 'the copy is unlocked even when the original is locked');
  assert.equal(layer(p, 'subs').locked, true);
  assert.deepEqual(r.newClipIds, ['c6', 'c7']);
  assert.deepEqual(copy.clips.map((c) => [c.id, c.start, c.duration, c.text]), [['c6', 500, 3000, 'Hello there, this is Studio'], ['c7', 4000, 3000, 'A second line of text']]);
  assert.deepEqual(layer(p, 'subs').clips.map((c) => c.id), ['c4', 'c5'], 'the original keeps its clip ids');
  assert.equal(layer(p0, 'subs').clips.length, 2, 'the input project is untouched');
});

test('duplicateLayer on a middle layer keeps the order, copies gain and mute, and names copies of copies uniquely', () => {
  let p = good(setClipGain(sampleProject(), 'c2', 0.5));
  p = good(setLayerFlag(p, 'voice', 'muted', true));
  const r = duplicateLayer(p, 'voice');
  p = good(r);
  assert.deepEqual(p.layers.map((l) => l.id), ['video', 'voice', 'l1', 'music', 'subs']);
  assert.equal(layer(p, 'l1').muted, true);
  assert.equal(layer(p, 'l1').clips[0].gain, 0.5);
  assert.equal(layer(p, 'l1').clips[0].src, 'demo.voice.opus');
  p = good(duplicateLayer(p, 'voice'));
  p = good(duplicateLayer(p, 'l1'));
  assert.deepEqual(p.layers.filter((l) => l.kind === 'voice').map((l) => l.name), ['Voice', 'Voice copy 2', 'Voice copy', 'Voice copy 3']);
  assert.equal(nextLayerId(p), 'l4');
  assert.equal(new Set(p.layers.flatMap((l) => [l.id, ...l.clips.map((c) => c.id)])).size, p.layers.length + p.layers.reduce((n, l) => n + l.clips.length, 0), 'ids stay unique across layers and clips');
});

test('duplicateLayer refuses an unknown layer, a full project, and a non-text layer id', () => {
  const p = sampleProject();
  assert.equal(code(duplicateLayer(p, 'nope')), ERR.NO_LAYER);
  assert.equal(code(duplicateLayer(p, undefined)), ERR.NO_LAYER);
  const full = JSON.parse(JSON.stringify(p));
  for (let i = 0; i < 60; i++) full.layers.push({ id: `x${i}`, kind: 'music', name: `M${i}`, muted: false, locked: false, clips: [] });
  assert.equal(full.layers.length, 64);
  assert.equal(code(duplicateLayer(full, 'video')), ERR.BAD_ARG);
  assert.equal(good(applyOp(p, 'duplicateLayer', { layerId: 'music' })).layers.length, 5);
  assert.equal(code(applyOp(p, 'duplicateLayer', null)), ERR.BAD_ARG);
});

test('addLayer: an empty layer of any kind, placed after the last layer of that kind, named with the first free number', () => {
  let p = sampleProject();
  const r = addLayer(p, 'video');
  p = good(r);
  assert.equal(r.newLayerId, 'l1');
  assert.deepEqual(p.layers.map((l) => l.id), ['video', 'l1', 'voice', 'music', 'subs']);
  assert.deepEqual([layer(p, 'l1').name, layer(p, 'l1').kind, layer(p, 'l1').muted, layer(p, 'l1').locked, layer(p, 'l1').clips], ['Video 2', 'video', false, false, []]);
  p = good(addLayer(p, 'video'));
  assert.deepEqual(p.layers.map((l) => l.name), ['Video', 'Video 2', 'Video 3', 'Voice', 'Music', 'Subtitles']);
  for (const kind of ['voice', 'music', 'subtitle']) p = good(addLayer(p, kind));
  assert.deepEqual(p.layers.map((l) => l.kind), ['video', 'video', 'video', 'voice', 'voice', 'music', 'music', 'subtitle', 'subtitle']);
  assert.equal(layer(p, 'l5').name, 'Subtitles 2');
  assert.equal(nextLayerId(p), 'l6');
});

test('addLayer without any layer of that kind goes last, honours a name, and refuses a bad kind, bad name or a full project', () => {
  const bare = { ...sampleProject(), layers: sampleProject().layers.filter((l) => l.kind !== 'music') };
  const p = good(addLayer(bare, 'music', { name: '  Ambience  ' }));
  assert.deepEqual(p.layers.map((l) => l.name), ['Video', 'Voice', 'Subtitles', 'Ambience']);
  assert.equal(code(addLayer(bare, 'overlay')), ERR.BAD_KIND);
  assert.equal(code(addLayer(bare, 'automation')), ERR.BAD_KIND, 'an automation layer needs a clip to link to');
  assert.equal(code(addLayer(bare, undefined)), ERR.BAD_KIND);
  assert.equal(code(addLayer(bare, 'music', { name: '   ' })), ERR.BAD_NAME);
  assert.equal(code(addLayer(bare, 'music', { name: 'x'.repeat(81) })), ERR.BAD_NAME);
  assert.equal(code(addLayer(bare, 'music', { name: 7 })), ERR.BAD_NAME);
  const full = JSON.parse(JSON.stringify(sampleProject()));
  for (let i = 0; i < 60; i++) full.layers.push({ id: `x${i}`, kind: 'music', name: `M${i}`, muted: false, locked: false, clips: [] });
  assert.equal(code(addLayer(full, 'video')), ERR.BAD_ARG);
  assert.equal(good(applyOp(sampleProject(), 'addLayer', { kind: 'voice', name: 'Narrator 2' })).layers[2].name, 'Narrator 2');
  assert.equal(code(applyOp(sampleProject(), 'addLayer', {})), ERR.BAD_KIND);
});

test('deleteLayer: the layer and its clips go, the others are untouched; a locked or unknown layer is refused', () => {
  const p0 = sampleProject();
  const r = deleteLayer(p0, 'subs');
  const p = good(r);
  assert.deepEqual(p.layers.map((l) => l.id), ['video', 'voice', 'music']);
  assert.equal(r.removedClips, 2);
  assert.equal(clip(p, 'c4'), undefined);
  assert.deepEqual(clip(p, 'c1'), clip(p0, 'c1'), 'other layers keep their clips exactly');
  assert.equal(p0.layers.length, 4, 'the input project is untouched');
  assert.equal(code(deleteLayer(lock(p0, 'music'), 'music')), ERR.LOCKED);
  assert.equal(code(deleteLayer(p0, 'nope')), ERR.NO_LAYER);
  assert.equal(code(deleteLayer(p0, undefined)), ERR.NO_LAYER);
  assert.equal(good(applyOp(p0, 'deleteLayer', { layerId: 'video' })).layers.length, 3);
  assert.equal(code(applyOp(p0, 'deleteLayer', null)), ERR.BAD_ARG);
});

test('deleteLayer then undo: the history brings the whole layer back; an empty layer can go too, and the last layer can be deleted', () => {
  const h = createHistory(sampleProject());
  h.push(good(deleteLayer(h.present, 'voice')));
  assert.equal(h.present.layers.length, 3);
  h.undo();
  assert.deepEqual(h.present.layers.map((l) => l.id), ['video', 'voice', 'music', 'subs']);
  assert.equal(clip(h.present, 'c2').src, 'demo.voice.opus');
  let p = addLayer(sampleProject(), 'video').project;
  p = good(deleteLayer(p, 'l1'));
  assert.equal(p.layers.length, 4);
  const one = { ...sampleProject(), layers: [sampleProject().layers[0]] };
  assert.deepEqual(good(deleteLayer(one, 'video')).layers, []);
});

// ---- batch ops: many clips at once, all or nothing, one undo step

const threeSubs = () => good(addSubtitle(sampleProject(), 'subs', 8000, 1000, 'third')); // c4 500-3500, c5 4000-7000, c6 8000-9000

test('deleteClips: several clips on several layers in one go; ripple closes every gap; nothing is deleted when one clip cannot be', () => {
  const p0 = sampleProject();
  const r = deleteClips(p0, ['c4', 'c5', 'c2']);
  const p = good(r);
  assert.equal(r.removed, 3);
  assert.deepEqual([layer(p, 'subs').clips.length, layer(p, 'voice').clips.length, layer(p, 'video').clips.length], [0, 0, 1]);
  const s = threeSubs();
  assert.deepEqual(layer(good(deleteClips(s, ['c4', 'c5'])), 'subs').clips.map((c) => [c.id, c.start]), [['c6', 8000]], 'without ripple the rest stays put');
  assert.deepEqual(layer(good(deleteClips(s, ['c4', 'c5'], { ripple: true })), 'subs').clips.map((c) => [c.id, c.start]), [['c6', 2000]], 'ripple: both gaps (3000 + 3000) close');
  assert.deepEqual(layer(good(deleteClips(s, ['c4', 'c6'], { ripple: true })), 'subs').clips.map((c) => [c.id, c.start]), [['c5', 1000]], 'a gap before a kept clip closes, one after it does not matter');
  assert.deepEqual(layer(good(deleteClips(s, ['c5', 'c4'], { ripple: true })), 'subs').clips.map((c) => c.start), [2000], 'the order of the ids does not matter');
  const frozen = JSON.stringify(s);
  assert.equal(code(deleteClips(lock(s, 'voice'), ['c4', 'c2'])), ERR.LOCKED, 'one locked layer refuses the whole batch');
  assert.equal(code(deleteClips(s, ['c4', 'nope'])), ERR.NO_CLIP);
  assert.equal(JSON.stringify(s), frozen, 'a refused batch changed nothing');
});

test('deleteClips refuses bad lists: empty, not a list, duplicates, non-text ids, too many', () => {
  const p = sampleProject();
  for (const bad of [[], undefined, null, 'c1', ['c1', 'c1'], ['c1', 7], Array.from({ length: 501 }, (_, i) => `c${i}`)]) assert.equal(code(deleteClips(p, bad)), ERR.BAD_ARG, JSON.stringify(bad)?.slice(0, 40));
  assert.equal(good(applyOp(p, 'deleteClips', { clipIds: ['c4'], ripple: true })).layers[3].clips.length, 1);
  assert.equal(code(applyOp(p, 'deleteClips', {})), ERR.BAD_ARG);
});

test('copyClips: the earliest lands at the point and the rest keep their distances and layers; new ids come in start order', () => {
  const p0 = sampleProject();
  const r = copyClips(p0, ['c5', 'c4'], 10000);
  const p = good(r);
  assert.deepEqual(r.newClipIds, ['c6', 'c7']);
  assert.deepEqual(layer(p, 'subs').clips.slice(2).map((c) => [c.id, c.start, c.duration, c.text]), [['c6', 10000, 3000, 'Hello there, this is Studio'], ['c7', 13500, 3000, 'A second line of text']], 'c4 (0.5 s) lands at 10 s, c5 keeps its 3.5 s distance');
  const both = good(copyClips(p0, ['c1', 'c2', 'c3'], 12000));
  assert.deepEqual([layer(both, 'video').clips.length, layer(both, 'voice').clips.length, layer(both, 'music').clips.length], [2, 2, 2], 'each copy stays on its own layer');
  assert.equal(layer(both, 'voice').clips[1].src, 'demo.voice.opus');
  assert.equal(good(setClipGain(p0, 'c2', 0.5)) && layer(good(copyClips(good(setClipGain(p0, 'c2', 0.5)), ['c2'], 20000)), 'voice').clips[1].gain, 0.5, 'gain is copied');
  assert.equal(p0.layers[3].clips.length, 2, 'the input project is untouched');
});

test('copyClips: toLayerId sends a single-layer selection to another layer of the same kind; the rules refuse the rest, all or nothing', () => {
  let p = good(duplicateLayer(sampleProject(), 'voice')); // l1 is a copy of the voice layer
  p = good(copyClips(p, ['c2'], 3000, { toLayerId: 'l1' }));
  assert.equal(layer(p, 'l1').clips.length, 2);
  const s = sampleProject();
  assert.equal(code(copyClips(s, ['c1', 'c2'], 0, { toLayerId: 'voice' })), ERR.BAD_ARG, 'two source layers cannot share one target');
  assert.equal(code(copyClips(s, ['c2'], 1000, { toLayerId: 'music' })), ERR.KIND_MISMATCH);
  assert.equal(code(copyClips(s, ['c2'], 1000, { toLayerId: 'nope' })), ERR.NO_LAYER);
  assert.equal(code(copyClips(lock(s, 'subs'), ['c4', 'c5'], 20000)), ERR.LOCKED, 'the target layer is locked');
  assert.equal(good(copyClips(lock(s, 'subs'), ['c1'], 20000)).layers[0].clips.length, 2, 'a locked SOURCE layer is fine, only targets must be unlocked');
  assert.equal(code(copyClips(s, ['c4', 'c5'], 1000)), ERR.OVERLAP, 'a subtitle paste that lands on its own source is refused as a whole');
  assert.equal(code(copyClips(s, ['c4', 'c1'], 1000)), ERR.OVERLAP, 'even when the video half of the paste is fine');
  assert.equal(code(copyClips(s, ['c1'], -1)), ERR.BAD_ARG);
  assert.equal(code(copyClips(s, ['c1'], 90000000)), ERR.BAD_ARG);
  assert.equal(code(copyClips(s, ['zz'], 0)), ERR.NO_CLIP);
  assert.equal(good(applyOp(s, 'copyClips', { clipIds: ['c1'], toStartMs: 12000 })).layers[0].clips.length, 2);
});

test('moveClips: clips move together and may swap places; overlaps are only judged at the end; a bad move refuses them all', () => {
  const p0 = sampleProject();
  const swapped = good(moveClips(p0, [{ clipId: 'c4', toStartMs: 4000 }, { clipId: 'c5', toStartMs: 500 }]));
  assert.deepEqual(layer(swapped, 'subs').clips.map((c) => [c.id, c.start]), [['c5', 500], ['c4', 4000]], 'swapping two clips would clash one at a time, but not as a batch');
  const shifted = good(moveClips(p0, [{ clipId: 'c4', toStartMs: 1500 }, { clipId: 'c5', toStartMs: 5000 }, { clipId: 'c2', toStartMs: 250 }]));
  assert.deepEqual([clip(shifted, 'c4').start, clip(shifted, 'c5').start, clip(shifted, 'c2').start], [1500, 5000, 250], 'a whole selection can slide by one distance');
  const withLane = good(duplicateLayer(p0, 'voice'));
  assert.equal(layer(good(moveClips(withLane, [{ clipId: 'c2', toStartMs: 0, toLayerId: 'l1' }])), 'l1').clips.length, 2, 'a clip can change layer within its kind');
  const frozen = JSON.stringify(p0);
  assert.equal(code(moveClips(p0, [{ clipId: 'c4', toStartMs: 4000 }])), ERR.OVERLAP, 'a subtitle onto its neighbour');
  assert.equal(code(moveClips(p0, [{ clipId: 'c2', toStartMs: 100 }, { clipId: 'c5', toStartMs: 1000 }])), ERR.OVERLAP, 'one bad move refuses the good one too');
  assert.equal(code(moveClips(lock(p0, 'voice'), [{ clipId: 'c2', toStartMs: 100 }])), ERR.LOCKED);
  assert.equal(code(moveClips(p0, [{ clipId: 'c2', toStartMs: 100, toLayerId: 'music' }])), ERR.KIND_MISMATCH);
  assert.equal(code(moveClips(p0, [{ clipId: 'c2', toStartMs: 100, toLayerId: 'zz' }])), ERR.NO_LAYER);
  assert.equal(code(moveClips(p0, [{ clipId: 'c2', toStartMs: '100' }])), ERR.BAD_ARG);
  assert.equal(code(moveClips(p0, [{ clipId: 'c2', toStartMs: 1 }, { clipId: 'c2', toStartMs: 2 }])), ERR.BAD_ARG, 'the same clip twice');
  for (const bad of [[], undefined, [null], [{}], 'x']) assert.equal(code(moveClips(p0, bad)), ERR.BAD_ARG);
  assert.equal(code(moveClips(p0, [{ clipId: 'nope', toStartMs: 1 }])), ERR.NO_CLIP);
  assert.equal(JSON.stringify(p0), frozen);
  assert.equal(good(applyOp(p0, 'moveClips', { moves: [{ clipId: 'c3', toStartMs: 100 }] })).layers[2].clips[0].start, 100);
});

test('a batch is ONE undo step: delete, copy and move several clips, then a single undo brings the project back', () => {
  const h = createHistory(sampleProject());
  const start = JSON.stringify(h.present);
  h.push(good(copyClips(h.present, ['c4', 'c5'], 10000)));
  h.push(good(moveClips(h.present, [{ clipId: 'c4', toStartMs: 1000 }, { clipId: 'c1', toStartMs: 500 }])));
  h.push(good(deleteClips(h.present, ['c6', 'c7'])));
  assert.equal(h.undoDepth, 3, 'three batches, three steps (not one per clip)');
  h.undo(); h.undo(); h.undo();
  assert.equal(JSON.stringify(h.present), start);
});

// ---- speed, opacity and zoom

test('setClipSpeed: the clip keeps its part of the source, so its length on the timeline changes; 1 removes the field', () => {
  const p0 = sampleProject();
  const fast = good(setClipSpeed(p0, 'c1', 4));
  assert.deepEqual([clip(fast, 'c1').speed, clip(fast, 'c1').duration, clip(fast, 'c1').in], [4, 2500, 0]);
  const slow = good(setClipSpeed(p0, 'c1', 0.5));
  assert.equal(clip(slow, 'c1').duration, 20000);
  const again = good(setClipSpeed(fast, 'c1', 8));
  assert.deepEqual([clip(again, 'c1').speed, clip(again, 'c1').duration], [8, 1250], 'from 4x to 8x halves it again: the source span is what is kept');
  const back = good(setClipSpeed(fast, 'c1', 1));
  assert.equal(clip(back, 'c1').speed, undefined, 'normal speed leaves no field');
  assert.equal(clip(back, 'c1').duration, 10000, 'and the original length');
  assert.equal(good(setClipSpeed(p0, 'c2', 2)).layers[1].clips[0].duration, 5000, 'voice');
  assert.equal(good(setClipSpeed(p0, 'c3', 16)).layers[2].clips[0].duration, 625, 'music');
  assert.equal(clip(good(setClipSpeed(p0, 'c1', 16)), 'c1').duration, 625);
  assert.equal(p0.layers[0].clips[0].duration, 10000, 'the input project is untouched');
});

test('setClipSpeed with ripple moves the later clips on that layer by the difference, and only that layer', () => {
  const p = good(splitClip(sampleProject(), 'c1', 5000)); // c1 0-5000, c6 5000-10000
  assert.equal(clip(good(setClipSpeed(p, 'c1', 2)), 'c6').start, 5000, 'without ripple the next clip stays');
  const r = good(setClipSpeed(p, 'c1', 2, { ripple: true }));
  assert.deepEqual([clip(r, 'c1').duration, clip(r, 'c6').start, clip(r, 'c6').duration], [2500, 2500, 5000]);
  assert.equal(clip(r, 'c2').start, 0, 'other layers do not move');
  const slower = good(setClipSpeed(p, 'c1', 0.5, { ripple: true }));
  assert.equal(clip(slower, 'c6').start, 10000, 'slowing pushes the next clip later');
  assert.equal(good(applyOp(p, 'setClipSpeed', { clipId: 'c1', speed: 2, ripple: true })).layers[0].clips[1].start, 2500);
});

test('setClipSpeed refuses bad speeds, subtitles, locked layers, unknown clips and a clip that would be too long', () => {
  const p = sampleProject();
  for (const bad of [0.24, 16.01, 0, -2, NaN, Infinity, '2', null, undefined]) assert.equal(code(setClipSpeed(p, 'c1', bad)), ERR.BAD_SPEED, String(bad));
  assert.equal(code(setClipSpeed(p, 'c4', 2)), ERR.BAD_SPEED, 'a subtitle has no speed');
  assert.equal(code(setClipSpeed(lock(p, 'video'), 'c1', 2)), ERR.LOCKED);
  assert.equal(code(setClipSpeed(p, 'nope', 2)), ERR.NO_CLIP);
  const huge = good(addClip(p, 'video', { src: 'demo.webm', start: 0, duration: 80000000 }));
  assert.equal(code(setClipSpeed(huge, huge.layers[0].clips.at(-1).id, 0.25)), ERR.BAD_SPEED, '4x longer than the limit');
  const tail = good(addClip(p, 'video', { src: 'demo.webm', start: 86390000, duration: 5000 })); // 10 s from the 24 h limit
  assert.equal(code(setClipSpeed(tail, 'c1', 0.25, { ripple: true })), ERR.BAD_SPEED, 'the later clip would be pushed past the limit');
  assert.equal(code(applyOp(p, 'setClipSpeed', { clipId: 'c1' })), ERR.BAD_SPEED);
});

test('splitting and trimming a clip with a speed keep the picture where it was: the source moves by time x speed', () => {
  const fast = good(setClipSpeed(sampleProject(), 'c1', 2)); // 5000 ms on the timeline, 10000 ms of source
  const r = splitClip(fast, 'c1', 2000);
  const p = good(r);
  assert.deepEqual([clip(p, 'c1').duration, clip(p, r.newClipId).start, clip(p, r.newClipId).duration, clip(p, r.newClipId).in, clip(p, r.newClipId).speed], [2000, 2000, 3000, 4000, 2], 'the right half starts 4000 ms into the source');
  const t = good(trimClip(clip(p, r.newClipId) && p, r.newClipId, 'start', 3000));
  assert.equal(clip(t, r.newClipId).in, 6000, 'trimming 1000 ms off a 2x clip skips 2000 ms of source');
  assert.equal(clip(good(trimClip(p, r.newClipId, 'start', 0)), r.newClipId).in, 0, 'and back to the very start of the source');
  const shifted = good(setClipSpeed(good(addClip(sampleProject(), 'video', { src: 'demo.webm', start: 5000, duration: 1000, inMs: 1000 })), 'c6', 4));
  assert.equal(code(trimClip(shifted, 'c6', 'start', 4000)), ERR.BEFORE_SOURCE, '1000 ms earlier at 4x would be 4000 ms before the source starts');
  const normal = splitClip(sampleProject(), 'c1', 4000);
  assert.equal(clip(good(normal), normal.newClipId).in, 4000, 'speed 1 is unchanged');
});

test('setClipOpacity: video only, 0 to 1, and 1 removes the field', () => {
  const p = sampleProject();
  assert.equal(clip(good(setClipOpacity(p, 'c1', 0.5)), 'c1').opacity, 0.5);
  assert.equal(clip(good(setClipOpacity(p, 'c1', 0)), 'c1').opacity, 0, 'fully transparent is allowed');
  assert.equal(clip(good(setClipOpacity(good(setClipOpacity(p, 'c1', 0.3)), 'c1', 1)), 'c1').opacity, undefined);
  for (const bad of [-0.1, 1.1, NaN, Infinity, '0.5', null, undefined]) assert.equal(code(setClipOpacity(p, 'c1', bad)), ERR.BAD_OPACITY, String(bad));
  for (const id of ['c2', 'c3', 'c4']) assert.equal(code(setClipOpacity(p, id, 0.5)), ERR.BAD_OPACITY, `${id} is not a video clip`);
  assert.equal(code(setClipOpacity(lock(p, 'video'), 'c1', 0.5)), ERR.LOCKED);
  assert.equal(code(setClipOpacity(p, 'zz', 0.5)), ERR.NO_CLIP);
  assert.equal(clip(good(applyOp(p, 'setClipOpacity', { clipId: 'c1', opacity: 0.25 })), 'c1').opacity, 0.25);
});

test('setClipZoom: video only, missing fields take the defaults, null removes it, bad values are refused', () => {
  const p = sampleProject();
  assert.deepEqual(clip(good(setClipZoom(p, 'c1', { scale: 3 })), 'c1').zoom, { scale: 3, x: 0.5, y: 0.5, at: 0, ramp: 600, hold: null });
  const z = good(setClipZoom(p, 'c1', { scale: 2.5, x: 0.2, y: 0.8, at: 1500, ramp: 800, hold: 3000 }));
  assert.deepEqual(clip(z, 'c1').zoom, { scale: 2.5, x: 0.2, y: 0.8, at: 1500, ramp: 800, hold: 3000 });
  assert.equal(clip(good(setClipZoom(z, 'c1', null)), 'c1').zoom, undefined);
  for (const bad of [{ scale: 1 }, { scale: 9 }, { x: 2 }, { y: -1 }, { at: 1.5 }, { ramp: -5 }, { hold: -1 }, { bogus: 1 }, 'big', 5, [], undefined]) assert.equal(code(setClipZoom(p, 'c1', bad)), ERR.BAD_ZOOM, JSON.stringify(bad));
  assert.equal(code(setClipZoom(p, 'c2', { scale: 2 })), ERR.BAD_ZOOM, 'not a video clip');
  assert.equal(code(setClipZoom(lock(p, 'video'), 'c1', { scale: 2 })), ERR.LOCKED);
  assert.equal(code(setClipZoom(p, 'zz', { scale: 2 })), ERR.NO_CLIP);
  assert.equal(good(applyOp(p, 'setClipZoom', { clipId: 'c1', zoom: { scale: 2 } })).layers[0].clips[0].zoom.scale, 2);
  assert.equal(code(applyOp(p, 'setClipZoom', { clipId: 'c1' })), ERR.BAD_ZOOM);
  const input = { scale: 2 };
  setClipZoom(p, 'c1', input);
  assert.deepEqual(input, { scale: 2 }, 'the argument is not modified');
});

test('a zoom stays where it is in the picture when the clip is split, trimmed or sped up', () => {
  let p = good(setClipZoom(sampleProject(), 'c1', { scale: 2, x: 0.3, y: 0.3, at: 3000, ramp: 1000, hold: 2000 }));
  const s = splitClip(p, 'c1', 2000);
  const both = good(s);
  assert.equal(clip(both, 'c1').zoom.at, 3000, 'the left half keeps its zoom as it was');
  assert.equal(clip(both, s.newClipId).zoom.at, 1000, 'the right half starts 2000 ms further into the zoom, so it begins 1000 ms before it');
  assert.notEqual(clip(both, 'c1').zoom, clip(both, s.newClipId).zoom, 'the halves do not share one object');
  assert.equal(clip(good(trimClip(p, 'c1', 'start', 1000)), 'c1').zoom.at, 2000, 'trimming 1000 ms off the start brings the zoom 1000 ms closer');
  const fast = good(setClipSpeed(p, 'c1', 2));
  assert.deepEqual(clip(fast, 'c1').zoom, { scale: 2, x: 0.3, y: 0.3, at: 1500, ramp: 500, hold: 1000 }, 'twice the speed, half the times');
  const stay = good(setClipSpeed(good(setClipZoom(sampleProject(), 'c1', { scale: 2, at: 1000 })), 'c1', 4));
  assert.equal(clip(stay, 'c1').zoom.hold, null, 'staying zoomed stays');
  assert.deepEqual(clip(good(copyClip(p, 'c1', 20000)), 'c6').zoom, clip(p, 'c1').zoom, 'a copy keeps the zoom');
});

test('setMasterGain: 0 to 4, 1 removes the field, bad values are refused, undo brings the old volume back', () => {
  const p = sampleProject();
  assert.equal(good(setMasterGain(p, 0.5)).master, 0.5);
  assert.equal(good(setMasterGain(p, 0)).master, 0, 'silence is a valid master volume');
  assert.equal(good(setMasterGain(p, 4)).master, 4);
  assert.equal(good(setMasterGain(good(setMasterGain(p, 0.5)), 1)).master, undefined, 'unity leaves no field');
  for (const bad of [-0.1, 4.1, NaN, Infinity, '1', null, undefined]) assert.equal(code(setMasterGain(p, bad)), ERR.BAD_GAIN, String(bad));
  assert.equal(good(applyOp(p, 'setMasterGain', { gain: 2 })).master, 2);
  assert.equal(code(applyOp(p, 'setMasterGain', {})), ERR.BAD_GAIN);
  assert.equal(p.master, undefined, 'the input project is untouched');
  const h = createHistory(p);
  h.push(good(setMasterGain(h.present, 0.25)));
  h.undo();
  assert.equal(h.present.master, undefined);
});

test('setLayerGain: voice and music layers only, 0 to 4, refused on a locked layer, 1 removes the field', () => {
  const p = sampleProject();
  assert.equal(layer(good(setLayerGain(p, 'voice', 0.5)), 'voice').gain, 0.5);
  assert.equal(layer(good(setLayerGain(p, 'music', 3)), 'music').gain, 3);
  assert.equal(layer(good(setLayerGain(good(setLayerGain(p, 'voice', 0.5)), 'voice', 1)), 'voice').gain, undefined);
  assert.equal(code(setLayerGain(p, 'video', 0.5)), ERR.BAD_GAIN, 'a video layer has no volume');
  assert.equal(code(setLayerGain(p, 'subs', 0.5)), ERR.BAD_GAIN);
  assert.equal(code(setLayerGain(lock(p, 'voice'), 'voice', 0.5)), ERR.LOCKED);
  assert.equal(code(setLayerGain(p, 'nope', 0.5)), ERR.NO_LAYER);
  for (const bad of [-1, 4.5, NaN, '1', null, undefined]) assert.equal(code(setLayerGain(p, 'voice', bad)), ERR.BAD_GAIN, String(bad));
  assert.equal(layer(good(applyOp(p, 'setLayerGain', { layerId: 'music', gain: 0.1 })), 'music').gain, 0.1);
  assert.equal(good(duplicateLayer(good(setLayerGain(p, 'voice', 0.5)), 'voice')).layers[2].gain, 0.5, 'a duplicated layer keeps its volume');
});

// ---- automation: a line on a layer of its own, linked to one param of one clip

const ids = (p) => p.layers.map((l) => l.id);
const withLine = (param = 'gain', clipId = 'c2') => { const r = addAutomation(sampleProject(), clipId, param); return { p: good(r), id: r.newLayerId }; };
const pts = (p, id) => layer(p, id).points.map((x) => [x.t, x.v, x.curve]);
const drawn = (param, clipId, points) => { const { p, id } = withLine(param, clipId); return { p: good(pasteLane(p, id, points)), id }; };

test('addAutomation: a line on its own layer right below the clip\'s layer, pushing the rest down, starting at the clip\'s current value', () => {
  const p0 = sampleProject();
  const r = addAutomation(p0, 'c2', 'gain');
  const p = good(r);
  assert.equal(r.newLayerId, 'l1');
  assert.deepEqual(ids(p), ['video', 'voice', 'l1', 'music', 'subs'], 'below the voice layer, above music');
  assert.deepEqual([layer(p, 'l1').kind, layer(p, 'l1').link, layer(p, 'l1').clips, layer(p, 'l1').muted, layer(p, 'l1').locked], ['automation', { clipId: 'c2', param: 'gain' }, [], false, false]);
  assert.equal(layer(p, 'l1').name, 'demo.voice.opus: Volume');
  assert.deepEqual(pts(p, 'l1'), [[0, 1, 'linear']], 'one point at the start: nothing changes until you draw');
  // a second line for the same clip goes below the first, still above the next layer
  const two = good(addAutomation(p, 'c2', 'pan'));
  assert.deepEqual(ids(two), ['video', 'voice', 'l1', 'l2', 'music', 'subs']);
  assert.deepEqual(pts(two, 'l2'), [[0, 0, 'linear']]);
  assert.deepEqual(pts(good(addAutomation(p0, 'c2', 'mute')), 'l1'), [[0, 0, 'linear']]);
  assert.deepEqual(pts(good(addAutomation(p0, 'c3', 'gain')), 'l1'), [[0, 0.0398, 'linear']], 'a music clip starts at its quiet bed level');
  assert.deepEqual(pts(good(addAutomation(good(setClipGain(p0, 'c2', 0.5)), 'c2', 'gain')), 'l1'), [[0, 0.5, 'linear']], 'or at its own gain');
  assert.deepEqual(pts(good(addAutomation(p0, 'c1', 'opacity')), 'l1'), [[0, 1, 'linear']]);
  assert.deepEqual(pts(good(addAutomation(good(setClipOpacity(p0, 'c1', 0.4)), 'c1', 'opacity')), 'l1'), [[0, 0.4, 'linear']]);
  assert.deepEqual(ids(good(addAutomation(p0, 'c1', 'opacity'))), ['video', 'l1', 'voice', 'music', 'subs'], 'a video clip\'s line sits under the video layer');
  assert.equal(p0.layers.length, 4, 'the input project is untouched');
});

test('addAutomation refuses what a clip cannot have, a second line for the same param, locked layers and unknown clips', () => {
  const p = sampleProject();
  assert.equal(code(addAutomation(p, 'zz', 'gain')), ERR.NO_CLIP);
  assert.equal(code(addAutomation(p, undefined, 'gain')), ERR.BAD_ARG);
  assert.equal(code(addAutomation(lock(p, 'voice'), 'c2', 'gain')), ERR.LOCKED);
  for (const param of ['speed', 'zoom', 'panX', 'volume', '', undefined, 7, '__proto__']) assert.equal(code(addAutomation(p, 'c2', param)), ERR.BAD_AUTOMATION, `not drawable yet: ${String(param)}`);
  assert.equal(code(addAutomation(p, 'c1', 'gain')), ERR.BAD_AUTOMATION, 'video has no volume line');
  assert.equal(code(addAutomation(p, 'c1', 'pan')), ERR.BAD_AUTOMATION);
  assert.equal(code(addAutomation(p, 'c2', 'opacity')), ERR.BAD_AUTOMATION, 'voice has no opacity line');
  assert.equal(code(addAutomation(p, 'c4', 'gain')), ERR.BAD_AUTOMATION, 'a subtitle has none');
  assert.equal(code(addAutomation(p, 'c4', 'opacity')), ERR.BAD_AUTOMATION);
  const { p: has } = withLine('gain');
  assert.equal(code(addAutomation(has, 'c2', 'gain')), ERR.BAD_AUTOMATION, 'one line per param per clip');
  const full = JSON.parse(JSON.stringify(p));
  for (let i = 0; i < 60; i++) full.layers.push({ id: `x${i}`, kind: 'music', name: `M${i}`, muted: false, locked: false, clips: [] });
  assert.equal(code(addAutomation(full, 'c2', 'gain')), ERR.BAD_ARG, 'a full project');
  assert.equal(good(applyOp(p, 'addAutomation', { clipId: 'c2', param: 'pan' })).layers.length, 5);
  assert.equal(code(applyOp(p, 'addAutomation', {})), ERR.BAD_ARG, 'no clip id at all');
});

test('addPoint: sorted in, with its index; the curve defaults to linear; times may not repeat; ranges are per param', () => {
  const { p, id } = withLine('gain');
  const r = addPoint(p, id, 4000, 0.25);
  const a = good(r);
  assert.equal(r.pointIndex, 1);
  assert.deepEqual(pts(a, id), [[0, 1, 'linear'], [4000, 0.25, 'linear']]);
  const b = good(addPoint(a, id, 2000, 2, 'ease-in-out'));
  assert.deepEqual(pts(b, id), [[0, 1, 'linear'], [2000, 2, 'ease-in-out'], [4000, 0.25, 'linear']], 'inserted in time order');
  assert.equal(addPoint(a, id, 2000, 2).pointIndex, 1);
  assert.equal(addPoint(a, id, 9000, 1).pointIndex, 2, 'past the end');
  assert.equal(pts(good(addPoint(a, id, 100, 0.123456789)), id)[1][1], 0.1235, 'values are tidied to 4 decimals');
  assert.equal(code(addPoint(a, id, 4000, 1)), ERR.POINT_CROSSING, 'a point already sits there');
  assert.equal(code(addPoint(a, id, 0, 1)), ERR.POINT_CROSSING);
  for (const t of [-1, 1.5, '5', NaN, 90000000, undefined, null]) assert.equal(code(addPoint(a, id, t, 1)), ERR.BAD_ARG, `t ${String(t)}`);
  for (const v of [-0.1, 4.1, NaN, Infinity, '1', undefined, null]) assert.equal(code(addPoint(a, id, 100, v)), ERR.BAD_AUTOMATION, `v ${String(v)}`);
  assert.equal(code(addPoint(a, id, 100, 1, 'bounce')), ERR.BAD_AUTOMATION);
  for (const [param, bad, okv] of [['pan', 1.1, -1], ['pan', -1.1, 1], ['mute', 1.5, 1], ['mute', -0.5, 0]]) {
    const l = withLine(param, 'c2');
    assert.equal(code(addPoint(l.p, l.id, 500, bad)), ERR.BAD_AUTOMATION, `${param} ${bad}`);
    assert.equal(addPoint(l.p, l.id, 500, okv).ok, true, `${param} ${okv}`);
  }
  const o = withLine('opacity', 'c1');
  assert.equal(code(addPoint(o.p, o.id, 500, 1.1)), ERR.BAD_AUTOMATION);
  assert.equal(addPoint(o.p, o.id, 500, 0).ok, true, 'fully transparent is allowed');
  assert.equal(code(addPoint(a, 'voice', 100, 1)), ERR.BAD_AUTOMATION, 'not an automation layer');
  assert.equal(code(addPoint(a, 'nope', 100, 1)), ERR.NO_LAYER);
  assert.equal(code(addPoint(lock(a, id), id, 100, 1)), ERR.LOCKED);
  assert.equal(good(applyOp(a, 'addPoint', { layerId: id, t: 500, v: 0.5, curve: 'hold' })).layers[2].points[1].curve, 'hold');
  let many = a; // two points already
  for (let i = 1; i < 499; i++) many = good(addPoint(many, id, 10000 + i, 1));
  assert.equal(layer(many, id).points.length, 500, 'up to 500 points');
  assert.equal(code(addPoint(many, id, 99999, 1)), ERR.BAD_AUTOMATION, 'at most 500');
});

test('movePoint: time and value change, the order does not; a point may not cross or touch its neighbours', () => {
  const { p, id } = drawn('gain', 'c2', [{ t: 0, v: 1, curve: 'linear' }, { t: 1000, v: 0.5, curve: 'hold' }, { t: 2000, v: 2, curve: 'ease-in' }]);
  assert.deepEqual(pts(good(movePoint(p, id, 1, 1500, 0.8)), id), [[0, 1, 'linear'], [1500, 0.8, 'hold'], [2000, 2, 'ease-in']], 'the curve stays');
  assert.deepEqual(pts(good(movePoint(p, id, 0, 500, 1)), id)[0], [500, 1, 'linear'], 'the first point may move later, up to its neighbour');
  assert.deepEqual(pts(good(movePoint(p, id, 2, 90000, 4)), id)[2], [90000, 4, 'ease-in'], 'the last one as far as it likes');
  assert.equal(code(movePoint(p, id, 1, 2000, 1)), ERR.POINT_CROSSING, 'onto the next point');
  assert.equal(code(movePoint(p, id, 1, 0, 1)), ERR.POINT_CROSSING, 'onto the previous');
  assert.equal(code(movePoint(p, id, 1, 2500, 1)), ERR.POINT_CROSSING, 'past the next');
  assert.equal(code(movePoint(p, id, 0, 1000, 1)), ERR.POINT_CROSSING);
  assert.equal(good(movePoint(p, id, 1, 1000, 0.7)).layers[2].points[1].v, 0.7, 'the same time is fine for the point itself');
  for (const i of [-1, 3, 1.5, '1', undefined, NaN]) assert.equal(code(movePoint(p, id, i, 500, 1)), ERR.NO_POINT, `index ${String(i)}`);
  assert.equal(code(movePoint(p, id, 1, -5, 1)), ERR.BAD_ARG);
  assert.equal(code(movePoint(p, id, 1, 500, 9)), ERR.BAD_AUTOMATION);
  assert.equal(code(movePoint(lock(p, id), id, 1, 1200, 1)), ERR.LOCKED);
  assert.equal(code(movePoint(p, 'voice', 0, 1, 1)), ERR.BAD_AUTOMATION);
  assert.equal(good(applyOp(p, 'movePoint', { layerId: id, index: 1, t: 1200, v: 0.9 })).layers[2].points[1].t, 1200);
});

test('deletePoint, setCurve and clearLane', () => {
  const { p, id } = drawn('gain', 'c2', [{ t: 0, v: 1, curve: 'linear' }, { t: 1000, v: 0.5, curve: 'hold' }, { t: 2000, v: 2, curve: 'linear' }]);
  assert.deepEqual(pts(good(deletePoint(p, id, 1)), id), [[0, 1, 'linear'], [2000, 2, 'linear']]);
  assert.deepEqual(pts(good(deletePoint(p, id, 0)), id)[0], [1000, 0.5, 'hold'], 'the first point can go too');
  const one = good(clearLane(p, id));
  assert.deepEqual(pts(one, id), [[0, 1, 'linear']], 'cleared: one point at the start with the first value');
  assert.equal(code(deletePoint(one, id, 0)), ERR.BAD_AUTOMATION, 'a line keeps one point; delete its layer to remove it');
  for (const i of [-1, 3, 0.5, 'x']) assert.equal(code(deletePoint(p, id, i)), ERR.NO_POINT);
  assert.equal(pts(good(setCurve(p, id, 0, 'ease-out')), id)[0][2], 'ease-out');
  for (const c of ['bounce', undefined, 5]) assert.equal(code(setCurve(p, id, 0, c)), ERR.BAD_AUTOMATION);
  assert.equal(code(setCurve(p, id, 9, 'hold')), ERR.NO_POINT);
  assert.equal(code(setCurve(lock(p, id), id, 0, 'hold')), ERR.LOCKED);
  assert.equal(code(clearLane(lock(p, id), id)), ERR.LOCKED);
  assert.equal(code(clearLane(p, 'voice')), ERR.BAD_AUTOMATION);
  assert.equal(good(applyOp(p, 'deletePoint', { layerId: id, index: 2 })).layers[2].points.length, 2);
  assert.equal(good(applyOp(p, 'setCurve', { layerId: id, index: 1, curve: 'linear' })).layers[2].points[1].curve, 'linear');
  assert.equal(good(applyOp(p, 'clearLane', { layerId: id })).layers[2].points.length, 1);
  const h = createHistory(p);
  h.push(good(deletePoint(h.present, id, 1)));
  h.undo();
  assert.equal(layer(h.present, id).points.length, 3, 'undo brings the point back');
});

test('copyLane puts a line onto another clip (stretched to fit on request); pasteLane redraws one; both check everything', () => {
  const { p, id } = drawn('gain', 'c2', [{ t: 0, v: 1, curve: 'linear' }, { t: 5000, v: 0.2, curve: 'hold' }, { t: 10000, v: 3, curve: 'linear' }]);
  const r = copyLane(p, id, 'c3');
  const q = good(r);
  assert.deepEqual(ids(q), ['video', 'voice', id, 'music', 'l2', 'subs'], 'the copy sits below the music layer');
  assert.deepEqual([layer(q, r.newLayerId).link, layer(q, r.newLayerId).name], [{ clipId: 'c3', param: 'gain' }, 'demo.music.mp3: Volume']);
  assert.deepEqual(pts(q, r.newLayerId), pts(p, id), 'the same drawing');
  // fit: onto a clip of a different length the times are squeezed
  const short = good(addClip(p, 'music', { src: 'demo.music.mp3', start: 0, duration: 5000 }));
  const sid = short.layers.find((l) => l.kind === 'music').clips.at(-1).id;
  const fitted = good(copyLane(short, id, sid, { fit: true }));
  assert.deepEqual(layer(fitted, 'l2').points.map((x) => x.t), [0, 2500, 5000], 'a 10 s line squeezed onto a 5 s clip');
  assert.deepEqual(layer(good(copyLane(short, id, sid)), 'l2').points.map((x) => x.t), [0, 5000, 10000], 'not fitted: as drawn');
  assert.equal(code(copyLane(q, id, 'c3')), ERR.BAD_AUTOMATION, 'the clip already has that line');
  assert.equal(code(copyLane(p, id, 'c1')), ERR.BAD_AUTOMATION, 'a video clip has no volume line');
  assert.equal(code(copyLane(p, id, 'zz')), ERR.NO_CLIP);
  assert.equal(code(copyLane(p, 'voice', 'c3')), ERR.BAD_AUTOMATION);
  assert.equal(code(copyLane(p, 'nope', 'c3')), ERR.NO_LAYER);
  assert.equal(code(copyLane(lock(p, 'music'), id, 'c3')), ERR.LOCKED, 'a locked target refuses');
  assert.equal(good(copyLane(lock(p, id), id, 'c3')).layers.length, 6, 'a locked SOURCE line is fine to copy');
  const pv = drawn('pan', 'c2', [{ t: 0, v: -1, curve: 'linear' }, { t: 100, v: 1, curve: 'linear' }]);
  assert.equal(good(copyLane(pv.p, pv.id, 'c3')).layers.some((l) => l.kind === 'automation' && l.link.clipId === 'c3' && l.link.param === 'pan'), true);
  // pasteLane
  const redrawn = good(pasteLane(p, id, [{ t: 0, v: 0, curve: 'linear' }, { t: 500, v: 4, curve: 'ease-out' }]));
  assert.deepEqual(pts(redrawn, id), [[0, 0, 'linear'], [500, 4, 'ease-out']]);
  assert.deepEqual(pts(good(pasteLane(p, id, [{ t: 0, v: 1, curve: 'linear', extra: 1 }])), id), [[0, 1, 'linear']], 'extra fields are dropped');
  for (const bad of [[], undefined, 'x', [{ t: 0, v: 9, curve: 'linear' }], [{ t: 5, v: 1, curve: 'linear' }, { t: 5, v: 1, curve: 'linear' }], [{ t: 0, v: 1 }], [null]]) assert.equal(code(pasteLane(p, id, bad)), ERR.BAD_AUTOMATION, JSON.stringify(bad));
  assert.equal(code(pasteLane(lock(p, id), id, [{ t: 0, v: 1, curve: 'linear' }])), ERR.LOCKED);
  assert.equal(good(applyOp(p, 'copyLane', { fromLayerId: id, toClipId: 'c3' })).layers.length, 6);
  assert.equal(good(applyOp(p, 'pasteLane', { layerId: id, points: [{ t: 0, v: 1, curve: 'linear' }] })).layers[2].points.length, 1);
});

test('flattenLane bakes a line into the clip\'s own constant and removes the line', () => {
  const pts3 = [{ t: 0, v: 1, curve: 'linear' }, { t: 10000, v: 0.2, curve: 'linear' }];
  const { p, id } = drawn('gain', 'c2', pts3);
  const start = good(flattenLane(p, id));
  assert.equal(clip(start, 'c2').gain, 1);
  assert.equal(start.layers.some((l) => l.kind === 'automation'), false, 'the line is gone');
  assert.equal(clip(good(flattenLane(p, id, { at: 'end' })), 'c2').gain, 0.2);
  assert.equal(clip(good(flattenLane(p, id, { at: 'mean' })), 'c2').gain, 0.6, 'the average of a 1 to 0.2 ramp over the whole clip');
  assert.equal(clip(good(flattenLane(p, id, { at: 0.35 })), 'c2').gain, 0.35);
  for (const at of ['middle', 9, -1, null, NaN]) assert.equal(code(flattenLane(p, id, { at })), ERR.BAD_ARG, String(at));
  const pn = drawn('pan', 'c2', [{ t: 0, v: -0.5, curve: 'linear' }]);
  assert.equal(clip(good(flattenLane(pn.p, pn.id)), 'c2').pan, -0.5);
  const op = drawn('opacity', 'c1', [{ t: 0, v: 0.4, curve: 'linear' }]);
  assert.equal(clip(good(flattenLane(op.p, op.id)), 'c1').opacity, 0.4);
  const op1 = drawn('opacity', 'c1', [{ t: 0, v: 1, curve: 'linear' }]);
  assert.equal(clip(good(flattenLane(good(setClipOpacity(op1.p, 'c1', 0.3)), op1.id)), 'c1').opacity, undefined, 'opacity 1 leaves no field');
  const mu = drawn('mute', 'c2', [{ t: 0, v: 1, curve: 'hold' }]);
  assert.equal(code(flattenLane(mu.p, mu.id)), ERR.BAD_AUTOMATION, 'mute has no constant');
  assert.equal(code(flattenLane(lock(p, 'voice'), id)), ERR.LOCKED, 'the clip\'s layer is locked');
  assert.equal(code(flattenLane(p, 'voice')), ERR.BAD_AUTOMATION);
  assert.equal(clip(good(applyOp(p, 'flattenLane', { layerId: id, at: 'end' })), 'c2').gain, 0.2);
});

test('setClipPan and setLayerPan: voice and music, -1 to 1, 0 removes the field', () => {
  const p = sampleProject();
  assert.equal(clip(good(setClipPan(p, 'c2', -0.5)), 'c2').pan, -0.5);
  assert.equal(clip(good(setClipPan(p, 'c3', 1)), 'c3').pan, 1);
  assert.equal(clip(good(setClipPan(good(setClipPan(p, 'c2', 0.5)), 'c2', 0)), 'c2').pan, undefined);
  for (const bad of [-1.1, 1.1, NaN, '0', null, undefined]) assert.equal(code(setClipPan(p, 'c2', bad)), ERR.BAD_PAN, String(bad));
  assert.equal(code(setClipPan(p, 'c1', 0.5)), ERR.BAD_PAN, 'video');
  assert.equal(code(setClipPan(p, 'c4', 0.5)), ERR.BAD_PAN, 'a subtitle');
  assert.equal(code(setClipPan(lock(p, 'voice'), 'c2', 0.5)), ERR.LOCKED);
  assert.equal(code(setClipPan(p, 'zz', 0.5)), ERR.NO_CLIP);
  assert.equal(layer(good(setLayerPan(p, 'voice', 0.25)), 'voice').pan, 0.25);
  assert.equal(layer(good(setLayerPan(good(setLayerPan(p, 'voice', 0.25)), 'voice', 0)), 'voice').pan, undefined);
  assert.equal(code(setLayerPan(p, 'video', 0.5)), ERR.BAD_PAN);
  assert.equal(code(setLayerPan(lock(p, 'music'), 'music', 0.5)), ERR.LOCKED);
  assert.equal(code(setLayerPan(p, 'nope', 0.5)), ERR.NO_LAYER);
  assert.equal(code(setLayerPan(p, 'voice', 2)), ERR.BAD_PAN);
  assert.equal(clip(good(applyOp(p, 'setClipPan', { clipId: 'c2', pan: 0.7 })), 'c2').pan, 0.7);
  assert.equal(layer(good(applyOp(p, 'setLayerPan', { layerId: 'music', pan: -1 })), 'music').pan, -1);
});

test('lines follow their clip: deleting the clip or its layer takes them along; moving keeps them; muting or locking a line works', () => {
  const { p, id } = drawn('gain', 'c2', [{ t: 0, v: 1, curve: 'linear' }, { t: 1000, v: 0, curve: 'linear' }]);
  const both = good(addAutomation(p, 'c2', 'pan'));
  assert.equal(both.layers.filter((l) => l.kind === 'automation').length, 2);
  assert.equal(good(deleteClip(both, 'c2')).layers.some((l) => l.kind === 'automation'), false, 'both lines went with the clip');
  assert.equal(good(deleteClips(both, ['c2', 'c3'])).layers.some((l) => l.kind === 'automation'), false);
  assert.equal(good(deleteLayer(both, 'voice')).layers.some((l) => l.kind === 'automation'), false, 'deleting the target layer takes its lines');
  const kept = good(deleteLayer(both, id));
  assert.deepEqual([kept.layers.filter((l) => l.kind === 'automation').length, clip(kept, 'c2') !== undefined], [1, true], 'deleting one line leaves the clip and the other line');
  assert.equal(good(deleteClip(p, 'c4')).layers.some((l) => l.id === id), true, 'other clips\' deletes leave it alone');
  const moved = good(moveClip(p, 'c2', 3000));
  assert.deepEqual(pts(moved, id), pts(p, id), 'moving the clip moves the line with it: its times are the clip\'s own');
  assert.equal(layer(good(setLayerFlag(p, id, 'muted', true)), id).muted, true);
  assert.equal(layer(good(setLayerFlag(lock(p, id), id, 'locked', false)), id).locked, false);
  assert.equal(code(duplicateLayer(p, id)), ERR.BAD_AUTOMATION, 'a line belongs to one clip');
  assert.equal(good(duplicateLayer(p, 'voice')).layers.filter((l) => l.kind === 'automation').length, 1, 'duplicating the clip\'s layer does not copy the lines');
  assert.equal(good(deleteLayer(p, id)).layers.length, 4);
  assert.equal(code(deleteLayer(lock(p, id), id)), ERR.LOCKED);
});

test('cutting a clip: the right half gets its own copy of the line, starting from the value at the cut', () => {
  const { p, id } = drawn('gain', 'c2', [{ t: 0, v: 0, curve: 'linear' }, { t: 4000, v: 1, curve: 'hold' }, { t: 8000, v: 0.5, curve: 'ease-in' }]);
  const r = splitClip(p, 'c2', 1000);
  const s = good(r);
  const right = s.layers.find((l) => l.kind === 'automation' && l.link.clipId === r.newClipId);
  assert.ok(right, 'a line for the right half');
  assert.equal(right.link.param, 'gain');
  assert.deepEqual(right.points.map((x) => [x.t, x.v, x.curve]), [[0, 0.25, 'linear'], [3000, 1, 'hold'], [7000, 0.5, 'ease-in']], 'the ramp had reached 0.25 at the cut');
  assert.deepEqual(pts(s, id), pts(p, id), 'the left half keeps its line as it was');
  assert.deepEqual(ids(s), ['video', 'voice', id, right.id, 'music', 'subs'], 'the new line sits right below the old one');
  assert.notEqual(layer(s, id).points, right.points);
  const late = good(splitClip(p, 'c2', 6000));
  const r2 = late.layers.find((l) => l.kind === 'automation' && l.link.clipId !== 'c2');
  assert.deepEqual(r2.points.map((x) => [x.t, x.v, x.curve]), [[0, 1, 'hold'], [2000, 0.5, 'ease-in']], 'a hold segment carries on: still 1 at the cut');
  const onPoint = good(splitClip(p, 'c2', 4000));
  assert.deepEqual(onPoint.layers.find((l) => l.kind === 'automation' && l.link.clipId !== 'c2').points.map((x) => [x.t, x.v]), [[0, 1], [4000, 0.5]], 'a cut exactly on a point');
  assert.equal(good(splitClip(sampleProject(), 'c2', 1000)).layers.filter((l) => l.kind === 'automation').length, 0, 'no line, no new line');
});

test('trimming the start of a clip keeps its lines attached to the picture; trimming the end changes nothing; speed stretches them', () => {
  const { p, id } = drawn('gain', 'c2', [{ t: 0, v: 0, curve: 'linear' }, { t: 4000, v: 1, curve: 'linear' }, { t: 8000, v: 0.5, curve: 'linear' }]);
  assert.deepEqual(pts(good(trimClip(p, 'c2', 'start', 1000)), id), [[0, 0.25, 'linear'], [3000, 1, 'linear'], [7000, 0.5, 'linear']], 'the line starts from what it was at the new start');
  assert.deepEqual(pts(good(trimClip(p, 'c2', 'start', 4000)), id), [[0, 1, 'linear'], [4000, 0.5, 'linear']], 'a trim exactly onto a point');
  assert.deepEqual(pts(good(trimClip(p, 'c2', 'start', 9000)), id), [[0, 0.5, 'linear']], 'past the last point: it holds');
  assert.deepEqual(pts(good(trimClip(p, 'c2', 'end', 6000)), id), pts(p, id), 'the end does not touch it');
  const trimmed = good(trimClip(p, 'c2', 'start', 2000)); // now the line is [0: 0.5, 2000: 1, 6000: 0.5]
  const extended = good(trimClip(trimmed, 'c2', 'start', 1000)); // and the clip starts 1000 ms earlier again
  assert.deepEqual(pts(extended, id).map((x) => [x[0], x[1]]), [[1000, 0.5], [3000, 1], [7000, 0.5]], 'extending earlier shifts the line later: it keeps its place on the picture');
  const fast = good(setClipSpeed(p, 'c2', 2));
  assert.deepEqual(pts(fast, id).map((x) => [x[0], x[1]]), [[0, 0], [2000, 1], [4000, 0.5]], 'twice the speed, half the times');
  const slow = good(setClipSpeed(p, 'c2', 0.5));
  assert.deepEqual(pts(slow, id).map((x) => x[0]), [0, 8000, 16000]);
  const crowded = drawn('gain', 'c2', [{ t: 0, v: 0, curve: 'linear' }, { t: 1, v: 1, curve: 'linear' }, { t: 2, v: 0.5, curve: 'linear' }]);
  assert.deepEqual(pts(good(setClipSpeed(crowded.p, 'c2', 16)), crowded.id).map((x) => x[0]), [0, 1, 2], 'points that would meet stay 1 ms apart');
});

// ---- notes

test('notes: add pins a trimmed text to a time, ids count up, and they stay in time order', () => {
  const p = sampleProject();
  assert.equal(p.notes, undefined, 'a project without notes has no notes field');
  const a = addNote(p, 5000, '  tighten this pause  ');
  const p1 = good(a);
  assert.deepEqual(p1.notes, [{ id: 'n1', at: 5000, text: 'tighten this pause' }]);
  assert.equal(a.newNoteId, 'n1');
  const b = addNote(p1, 1000, 'intro is too long');
  const p2 = good(b);
  assert.equal(b.newNoteId, 'n2');
  assert.deepEqual(p2.notes.map((n) => n.id), ['n2', 'n1'], 'sorted by time');
  assert.equal(good(addNote(p2, 1000, 'same moment')).notes[1].id, 'n3', 'the same time keeps creation order by id');
  assert.equal(p.notes, undefined, 'the input is untouched');
  for (const [at, text] of [[-1, 'x'], [1.5, 'x'], ['1', 'x'], [99999999999, 'x'], [0, ''], [0, '   '], [0, 7], [0, 'x'.repeat(501)]]) assert.ok([ERR.BAD_ARG, ERR.BAD_NOTE].includes(code(addNote(p, at, text))), `${at} ${String(text).slice(0, 8)}`);
  let full = p;
  for (let i = 0; i < MAX_NOTES; i++) full = good(addNote(full, i, `note ${i}`));
  assert.equal(code(addNote(full, 0, 'one too many')), ERR.BAD_NOTE, `at most ${MAX_NOTES}`);
});

test('notes: edit changes the text, the time or done, keeps the order, and refuses nonsense', () => {
  let p = good(addNote(good(addNote(sampleProject(), 1000, 'first')), 4000, 'second'));
  p = good(editNote(p, 'n1', { text: 'first, reworded' }));
  assert.equal(p.notes[0].text, 'first, reworded');
  p = good(editNote(p, 'n1', { at: 6000 }));
  assert.deepEqual(p.notes.map((n) => n.id), ['n2', 'n1'], 'moving a note re-sorts them');
  p = good(editNote(p, 'n2', { done: true }));
  assert.equal(p.notes[0].done, true);
  p = good(editNote(p, 'n2', { done: false }));
  assert.equal('done' in p.notes[0], false, 'not done is no field at all');
  assert.equal(code(editNote(p, 'n9', { text: 'x' })), ERR.NO_NOTE);
  assert.equal(code(editNote(p, 'n1', {})), ERR.BAD_ARG, 'nothing to change');
  assert.equal(code(editNote(p, 'n1', { text: ' ' })), ERR.BAD_NOTE);
  assert.equal(code(editNote(p, 'n1', { at: -5 })), ERR.BAD_ARG);
  assert.equal(code(editNote(p, 'n1', { done: 'yes' })), ERR.BAD_NOTE);
});

test('notes: delete removes one, and the last one takes the field with it; notes never touch a clip', () => {
  const base = sampleProject();
  let p = good(addNote(good(addNote(base, 1000, 'a')), 2000, 'b'));
  p = good(deleteNote(p, 'n1'));
  assert.deepEqual(p.notes.map((n) => n.id), ['n2']);
  assert.equal(code(deleteNote(p, 'n1')), ERR.NO_NOTE);
  p = good(deleteNote(p, 'n2'));
  assert.deepEqual(p, base, 'back to exactly the project it was');
  const withNote = good(addNote(base, 3000, 'x'));
  assert.deepEqual(withNote.layers, base.layers, 'a note changes no layer');
  // ids do not collide with layers and clips, and the ops reach the endpoint's table
  assert.equal(good(applyOp(base, 'addNote', { at: 10, text: 'via the table' })).notes[0].id, 'n1');
  assert.equal(good(applyOp(withNote, 'editNote', { noteId: 'n1', done: true })).notes[0].done, true);
  assert.equal(good(applyOp(withNote, 'deleteNote', { noteId: 'n1' })).notes, undefined);
});
