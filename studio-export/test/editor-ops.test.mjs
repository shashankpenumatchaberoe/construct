// The editor's pure, immutable operations: each op on every layer kind, locks, overlap rules, copy rules, ripple, history bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, MIN_CLIP_MS, validateProject } from '../src/editor/project.mjs';
import {
  OPS, addClip, addSubtitle, applyOp, copyClip, createHistory, deleteClip, moveClip, nextClipId, setClipGain, setLayerFlag, setSubtitleText, splitClip, splitText, trimClip,
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

test('a trim that would touch a neighbour on a single-track layer is an OVERLAP; on a mixed layer it is fine', () => {
  const p = sampleProject();
  assert.equal(code(trimClip(p, 'c4', 'end', 4500)), ERR.OVERLAP, 'subtitle c4 into c5');
  const v = good(splitClip(p, 'c1', 5000));
  assert.equal(code(trimClip(v, 'c1', 'end', 6000)), ERR.OVERLAP, 'video halves');
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

test('overlap rules: video and subtitle refuse an overlapping move/copy; voice and music allow it', () => {
  const p = sampleProject();
  assert.equal(code(moveClip(p, 'c5', 1000)), ERR.OVERLAP);
  assert.equal(code(copyClip(p, 'c4', 1000)), ERR.OVERLAP);
  assert.equal(code(copyClip(p, 'c1', 5000)), ERR.OVERLAP);
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
  assert.deepEqual(Object.keys(OPS).sort(), ['addClip', 'addSubtitle', 'copyClip', 'deleteClip', 'moveClip', 'setClipGain', 'setLayerFlag', 'setSubtitleText', 'splitClip', 'trimClip']);
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
