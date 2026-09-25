// The per-clip effects shared by the preview and the render: speed limits, opacity, the zoom curve and its validation, the atempo steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMATABLE, CURVES, audioMixAt, balance, opacityAt, MAX_POINTS, PARAMS, SPEED_MAX, SPEED_MIN, ZOOM_DEFAULT, atempoFactors, baseValue, curveShape, defaultGain, durationForSource, laneIntegral, laneMean, laneValueAt, lineProblem, opacityProblem, speedProblem, zoomAt, zoomProblem } from '../src/editor/ui/effects.mjs';

test('speedProblem: 0.25 to 16 inclusive, numbers only', () => {
  for (const ok of [SPEED_MIN, 0.5, 1, 2, 4, 8, SPEED_MAX, 1.25]) assert.equal(speedProblem(ok), null, String(ok));
  for (const bad of [0.24, 0, -1, 16.01, 100, NaN, Infinity, '2', null, undefined, {}, [2]]) assert.match(speedProblem(bad), /speed is a number from 0\.25 to 16/, String(bad));
});

test('opacityProblem: 0 to 1 inclusive, numbers only', () => {
  for (const ok of [0, 0.5, 1, 0.001]) assert.equal(opacityProblem(ok), null);
  for (const bad of [-0.01, 1.01, NaN, Infinity, '0.5', null, undefined]) assert.match(opacityProblem(bad), /opacity is a number/, String(bad));
});

const Z = { scale: 2, x: 0.5, y: 0.5, at: 1000, ramp: 1000, hold: null };

test('zoomProblem accepts a good zoom and names the first problem otherwise', () => {
  assert.equal(zoomProblem(Z), null);
  assert.equal(zoomProblem(ZOOM_DEFAULT), null);
  assert.equal(zoomProblem({ ...Z, hold: 0 }), null);
  assert.equal(zoomProblem({ ...Z, at: -500 }), null, 'a clip cut mid-zoom starts part-way through it');
  const bad = [
    [null, /object/], [[], /object/], ['2', /object/], [{ ...Z, extra: 1 }, /unknown zoom field "extra"/],
    [{ ...Z, scale: 1 }, /zoom\.scale/], [{ ...Z, scale: 9 }, /zoom\.scale/], [{ ...Z, scale: NaN }, /zoom\.scale/], [{ ...Z, scale: '2' }, /zoom\.scale/],
    [{ ...Z, x: -0.1 }, /zoom\.x/], [{ ...Z, y: 1.1 }, /zoom\.y/], [{ ...Z, x: undefined }, /zoom\.x/],
    [{ ...Z, at: 1.5 }, /zoom\.at/], [{ ...Z, at: 'a' }, /zoom\.at/], [{ ...Z, ramp: -1 }, /zoom\.ramp/], [{ ...Z, ramp: 0.5 }, /zoom\.ramp/],
    [{ ...Z, hold: -1 }, /zoom\.hold/], [{ ...Z, hold: 1.5 }, /zoom\.hold/], [{ ...Z, hold: undefined }, /zoom\.hold/],
  ];
  for (const [z, re] of bad) assert.match(zoomProblem(z), re, JSON.stringify(z));
});

test('zoomAt: 1x before it starts, eases to the scale over the ramp, holds, and eases back out when there is a hold', () => {
  assert.equal(zoomAt(null, 500), 1);
  assert.equal(zoomAt(undefined, 500), 1);
  assert.equal(zoomAt(Z, 0), 1);
  assert.equal(zoomAt(Z, 1000), 1, 'exactly at the start');
  assert.equal(zoomAt(Z, 1500), 1.5, 'half way through a smoothstep ramp is half way');
  assert.ok(zoomAt(Z, 1250) < 1.25 && zoomAt(Z, 1250) > 1, 'eased: slow at first');
  assert.ok(zoomAt(Z, 1750) > 1.75 && zoomAt(Z, 1750) < 2, 'eased: slow at the end');
  assert.equal(zoomAt(Z, 2000), 2);
  assert.equal(zoomAt(Z, 99999), 2, 'no hold: stays zoomed to the end');
  const back = { ...Z, hold: 2000 }; // in 1000-2000, hold 2000-4000, out 4000-5000
  assert.equal(zoomAt(back, 3000), 2);
  assert.equal(zoomAt(back, 4500), 1.5);
  assert.equal(zoomAt(back, 5000), 1);
  assert.equal(zoomAt(back, 9000), 1);
  const noRamp = { scale: 3, x: 0, y: 0, at: 500, ramp: 0, hold: 1000 };
  assert.deepEqual([zoomAt(noRamp, 499), zoomAt(noRamp, 500), zoomAt(noRamp, 1499), zoomAt(noRamp, 1500)], [1, 3, 3, 1], 'ramp 0 is a cut');
  const partway = { ...Z, at: -500 }; // 500 ms into a 1000 ms ramp at the clip start
  assert.equal(zoomAt(partway, 0), 1.5);
  for (let t = 0; t < 8000; t += 137) { const z = zoomAt(back, t); assert.ok(z >= 1 && z <= 2, `stays within 1..scale at ${t}`); }
});

test('atempoFactors: steps of 0.5 to 2 whose product is the speed, for every speed', () => {
  for (const speed of [0.25, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 8, 12.5, 16]) {
    const f = atempoFactors(speed);
    assert.ok(f.length >= 1, String(speed));
    for (const x of f) assert.ok(x >= 0.5 - 1e-9 && x <= 2 + 1e-9, `${speed}: step ${x}`);
    assert.ok(Math.abs(f.reduce((a, b) => a * b, 1) - speed) < 1e-9, `${speed}: product ${f.reduce((a, b) => a * b, 1)}`);
  }
  assert.deepEqual(atempoFactors(4), [2, 2]);
  assert.deepEqual(atempoFactors(0.25), [0.5, 0.5]);
  assert.deepEqual(atempoFactors(1), [1]);
});

// ---- automation lanes

const pt = (t, v, curve = 'linear') => ({ t, v, curve });
const lane = (param, ...points) => ({ param, points });

test('lineProblem: params, ranges, curves, ordering, and which kind of clip may have which line', () => {
  const ok = (param, kind, ...points) => assert.equal(lineProblem(param, points, kind), null, `${param} on ${kind}`);
  ok('gain', 'voice', pt(0, 1), pt(1000, 0.5, 'hold'));
  ok('gain', 'music', pt(0, 0.04));
  ok('pan', 'voice', pt(0, -1), pt(500, 1));
  ok('mute', 'music', pt(0, 0, 'hold'), pt(2000, 1, 'hold'));
  ok('opacity', 'video', pt(0, 0), pt(1000, 1));
  ok('speed', 'video', pt(0, 1), pt(2000, 8));
  ok('speed', 'voice', pt(0, 0.25));
  ok('zoom', 'video', pt(0, 1), pt(500, 4, 'ease-in-out'));
  ok('panX', 'video', pt(0, -1), pt(500, 1));
  const bad = [
    ['volume', 'voice', [pt(0, 1)], /param must be one of/], ['__proto__', 'voice', [pt(0, 1)], /param must be one of/], ['toString', 'voice', [pt(0, 1)], /param must be one of/], [undefined, 'voice', [pt(0, 1)], /param must be one of/],
    ['gain', 'video', [pt(0, 1)], /video clip has no gain line/], ['pan', 'video', [pt(0, 0)], /no pan line/], ['mute', 'video', [pt(0, 0)], /no mute line/], ['opacity', 'voice', [pt(0, 1)], /voice clip has no opacity line/],
    ['zoom', 'subtitle', [pt(0, 2)], /subtitle clip has no zoom line/],
    ['gain', 'voice', [], /1 to 500 points/], ['gain', 'voice', undefined, /points is a list/], ['gain', 'voice', 'x', /points is a list/],
    ['gain', 'voice', Array.from({ length: MAX_POINTS + 1 }, (_, i) => pt(i, 1)), /1 to 500 points/],
    ['gain', 'voice', [pt(0, 5)], /points\[0\]\.v is a number from 0 to 4/], ['gain', 'voice', [pt(0, -0.1)], /\.v is/], ['gain', 'voice', [pt(0, NaN)], /\.v is/], ['gain', 'voice', [pt(0, '1')], /\.v is/],
    ['pan', 'voice', [pt(0, 1.1)], /from -1 to 1/], ['pan', 'voice', [pt(0, -1.1)], /from -1 to 1/], ['mute', 'voice', [pt(0, 2)], /from 0 to 1/],
    ['speed', 'video', [pt(0, 0.2)], /from 0\.25 to 16/], ['speed', 'video', [pt(0, 17)], /\.v is/], ['opacity', 'video', [pt(0, 1.1)], /\.v is/], ['zoom', 'video', [pt(0, 0.9)], /from 1 to 4/], ['zoom', 'video', [pt(0, 4.1)], /\.v is/],
    ['gain', 'voice', [pt(-1, 1)], /\.t is whole milliseconds/], ['gain', 'voice', [pt(1.5, 1)], /\.t is/], ['gain', 'voice', [pt('0', 1)], /\.t is/], ['gain', 'voice', [pt(90000000, 1)], /\.t is/],
    ['gain', 'voice', [pt(0, 1), pt(0, 2)], /points\[1\]\.t must be later/], ['gain', 'voice', [pt(500, 1), pt(100, 2)], /must be later/],
    ['gain', 'voice', [{ t: 0, v: 1 }], /\.curve is one of/], ['gain', 'voice', [pt(0, 1, 'bounce')], /\.curve is one of/], ['gain', 'voice', [{ t: 0, v: 1, curve: 'linear', x: 1 }], /unknown field "x"/], ['gain', 'voice', [null], /points\[0\] is an object/],
  ];
  for (const [param, kind, points, re] of bad) assert.match(lineProblem(param, points, kind), re, `${param} ${kind} ${JSON.stringify(points)?.slice(0, 70)}`);
  for (const c of CURVES) assert.equal(lineProblem('gain', [pt(0, 1, c), pt(10, 2, c)], 'voice'), null, c);
  assert.deepEqual(Object.keys(PARAMS), ['gain', 'pan', 'mute', 'opacity', 'speed', 'zoom', 'panX', 'panY']);
  assert.deepEqual([...AUTOMATABLE], ['gain', 'pan', 'mute', 'opacity'], 'the lines the editor draws today');
});

test('baseValue and defaultGain: what a param is when no line drives it', () => {
  assert.equal(defaultGain('voice'), 1);
  assert.equal(defaultGain('music'), 0.0398);
  assert.equal(baseValue({}, 'music', 'gain'), 0.0398, 'a music clip is a quiet bed unless told otherwise');
  assert.equal(baseValue({ gain: 0.5 }, 'voice', 'gain'), 0.5);
  assert.deepEqual([baseValue({}, 'voice', 'pan'), baseValue({ pan: -0.3 }, 'voice', 'pan'), baseValue({}, 'voice', 'mute')], [0, -0.3, 0]);
  assert.deepEqual([baseValue({}, 'video', 'opacity'), baseValue({ opacity: 0.4 }, 'video', 'opacity'), baseValue({ speed: 4 }, 'video', 'speed'), baseValue({}, 'video', 'zoom')], [1, 0.4, 4, 1]);
});

test('laneValueAt: before the first point, after the last, between, hold, every curve, and one point', () => {
  const p = [pt(1000, 0), pt(2000, 1)];
  assert.equal(laneValueAt([], 5), undefined);
  assert.equal(laneValueAt(undefined, 5), undefined);
  assert.equal(laneValueAt(p, 0), 0, 'before the first point: the first value');
  assert.equal(laneValueAt(p, 1000), 0);
  assert.equal(laneValueAt(p, 1500), 0.5, 'linear halfway');
  assert.equal(laneValueAt(p, 2000), 1);
  assert.equal(laneValueAt(p, 99999), 1, 'after the last point: the last value');
  assert.equal(laneValueAt([pt(500, 3)], 0), 3);
  assert.equal(laneValueAt([pt(500, 3)], 9999), 3, 'a single point is a constant');
  const hold = [pt(0, 1, 'hold'), pt(1000, 3, 'linear'), pt(2000, 1)];
  assert.deepEqual([0, 500, 999, 1000, 1500, 2000].map((t) => laneValueAt(hold, t)), [1, 1, 1, 3, 2, 1], 'hold stays until the next point, then the next curve takes over');
  const seg = (curve) => [pt(0, 0, curve), pt(1000, 1)];
  assert.equal(laneValueAt(seg('ease-in'), 500), 0.25);
  assert.equal(laneValueAt(seg('ease-out'), 500), 0.75);
  assert.equal(laneValueAt(seg('ease-in-out'), 500), 0.5);
  assert.ok(laneValueAt(seg('ease-in-out'), 250) < 0.25 && laneValueAt(seg('ease-in-out'), 750) > 0.75, 'ease-in-out is slow at both ends');
  assert.deepEqual([curveShape('linear', 0.3), curveShape('hold', 0.3), curveShape('nonsense', 0.3)], [0.3, 0.3, 0.3]);
  const down = [pt(0, 4), pt(1000, 0)];
  assert.equal(laneValueAt(down, 250), 3, 'a falling line');
  const many = Array.from({ length: 200 }, (_, i) => pt(i * 10, i));
  for (const i of [0, 1, 57, 198, 199]) assert.equal(laneValueAt(many, i * 10), i, `a hit on point ${i}`);
  assert.equal(laneValueAt(many, 575), 57.5, 'between two of 200 points');
  const dup = [pt(100, 1), pt(100, 2)]; // never valid, but the evaluator must not divide by zero
  assert.ok(Number.isFinite(laneValueAt(dup, 100)) && Number.isFinite(laneValueAt(dup, 50)) && Number.isFinite(laneValueAt(dup, 150)));
});

test('laneIntegral and laneMean: exact for lines and constants, before and after the points', () => {
  const ramp = [pt(0, 1), pt(4000, 8)];
  assert.equal(Math.round(laneIntegral(ramp, 0, 4000)), 18000, '1 to 8 over 4 s: mean 4.5 x 4000');
  assert.equal(Math.round(laneIntegral(ramp, 0, 6000)), 34000, 'then 8 for 2 s more');
  assert.equal(Math.round(laneIntegral([pt(500, 2)], 0, 1000)), 2000, 'a constant');
  assert.equal(laneIntegral(ramp, 100, 100), 0);
  assert.equal(laneIntegral(ramp, 500, 100), 0);
  assert.equal(laneIntegral([], 0, 100), 0);
  assert.equal(Math.round(laneIntegral([pt(0, 0, 'hold'), pt(1000, 4)], 0, 2000)), 4000, 'hold 0 for 1 s, then 4 for 1 s');
  const eased = laneIntegral([pt(0, 0, 'ease-in-out'), pt(1000, 1)], 0, 1000);
  assert.ok(Math.abs(eased - 500) < 0.5, `a symmetric ease has the same area as a line: ${eased}`);
  assert.ok(Math.abs(laneIntegral([pt(0, 0, 'ease-in'), pt(1000, 1)], 0, 1000) - 1000 / 3) < 0.5, 'ease-in is a parabola: a third');
  assert.equal(Math.round(laneMean(ramp, 0, 4000) * 100) / 100, 4.5);
  assert.equal(laneMean(ramp, 0, 0), 1, 'a zero-length range is the value there');
  assert.equal(Math.round(laneIntegral(ramp, 1000, 3000)), Math.round(laneIntegral(ramp, 0, 3000) - laneIntegral(ramp, 0, 1000)), 'additive');
});

test('durationForSource: how long a speed lane needs to play a stretch of source (the clip grows or shrinks to fit)', () => {
  const ramp = [pt(0, 1), pt(4000, 8)]; // plays 18000 ms of source in its first 4 s
  assert.equal(durationForSource(ramp, 18000), 4000);
  assert.equal(durationForSource(ramp, 26000), 5000, 'the rest at 8x: 8000 more source is 1000 ms');
  assert.equal(durationForSource([pt(0, 1)], 10000), 10000, 'constant 1x');
  assert.equal(durationForSource([pt(0, 4)], 10000), 2500, 'constant 4x');
  assert.equal(durationForSource([pt(0, 0.5)], 10000), 20000);
  assert.equal(durationForSource(ramp, 0), 0);
  const d = durationForSource([pt(0, 1, 'ease-in-out'), pt(3000, 16)], 20000);
  assert.ok(Math.abs(laneIntegral([pt(0, 1, 'ease-in-out'), pt(3000, 16)], 0, d) - 20000) < 20, 'the integral over the answer is the source asked for');
  const there = [pt(0, 1), pt(1000, 8), pt(2000, 8), pt(3000, 1)]; // 1x -> 8x -> back
  const span = laneIntegral(there, 0, 3000);
  assert.equal(durationForSource(there, span), 3000, 'the round trip');
});

// ---- the mix at one moment (what the preview plays)

const none = () => undefined;
const lineSet = (o) => (param) => o[param];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('audioMixAt: constants, lines, mute, pan and the layer, and a knob being turned', () => {
  const voice = { id: 'c2', gain: 0.8 };
  const layer = { id: 'voice' };
  let m = audioMixAt(voice, 'voice', layer, none, 500);
  assert.deepEqual([m.gain, m.left, m.right], [0.8, 1, 1], 'the clip\'s own constants');
  m = audioMixAt({ id: 'c3' }, 'music', { id: 'music' }, none, 0);
  assert.equal(m.gain, 0.0398, 'a music clip with no gain is a quiet bed');
  m = audioMixAt(voice, 'voice', { id: 'voice', gain: 0.5 }, none, 0);
  near(m.gain, 0.4, 'the layer volume multiplies');
  m = audioMixAt({ ...voice, pan: -0.5 }, 'voice', { id: 'voice', pan: 0.5 }, none, 0);
  assert.deepEqual([m.left, m.right], [0.5, 0.5], 'clip pan -0.5 gives sides (1, 0.5), layer pan +0.5 gives (0.5, 1): they multiply to (0.5, 0.5)');
  const ramp = [{ t: 0, v: 1, curve: 'linear' }, { t: 2000, v: 0, curve: 'linear' }];
  near(audioMixAt(voice, 'voice', layer, lineSet({ gain: ramp }), 500).gain, 0.75, 'a volume line replaces the constant 0.8');
  near(audioMixAt(voice, 'voice', layer, lineSet({ gain: ramp }), 5000).gain, 0, 'and holds its last value');
  const steps = [{ t: 0, v: 0, curve: 'hold' }, { t: 1000, v: 1, curve: 'hold' }];
  assert.equal(audioMixAt(voice, 'voice', layer, lineSet({ mute: steps }), 500).gain, 0.8, 'not muted yet');
  assert.equal(audioMixAt(voice, 'voice', layer, lineSet({ mute: steps }), 1500).gain, 0, 'muted after 1 s');
  near(audioMixAt(voice, 'voice', layer, lineSet({ mute: [{ t: 0, v: 0.25, curve: 'linear' }] }), 0).gain, 0.6, 'a mute of 0.25 takes the volume down by a quarter');
  const sweep = [{ t: 0, v: -1, curve: 'linear' }, { t: 2000, v: 1, curve: 'linear' }];
  assert.deepEqual([audioMixAt(voice, 'voice', layer, lineSet({ pan: sweep }), 0).left, audioMixAt(voice, 'voice', layer, lineSet({ pan: sweep }), 0).right], [1, 0], 'hard left at the start');
  assert.deepEqual([audioMixAt(voice, 'voice', layer, lineSet({ pan: sweep }), 2000).left, audioMixAt(voice, 'voice', layer, lineSet({ pan: sweep }), 2000).right], [0, 1], 'hard right at the end');
  assert.deepEqual([audioMixAt(voice, 'voice', layer, lineSet({ pan: sweep }), 1000).left, audioMixAt(voice, 'voice', layer, lineSet({ pan: sweep }), 1000).right], [1, 1], 'centred in the middle: no level change');
  // a knob being turned overrides the constants, and only the constants
  near(audioMixAt(voice, 'voice', layer, none, 0, { clip: ['c2', 0.3] }).gain, 0.3, 'a clip knob');
  near(audioMixAt(voice, 'voice', layer, none, 0, { clip: ['other', 0.3] }).gain, 0.8, 'a different clip\'s knob does nothing');
  near(audioMixAt(voice, 'voice', layer, none, 0, { layer: ['voice', 0.5] }).gain, 0.4, 'a layer knob');
  near(audioMixAt(voice, 'voice', layer, lineSet({ gain: ramp }), 0, { clip: ['c2', 0.3] }).gain, 1, 'a line still decides when there is one');
  assert.deepEqual([...balance(0.5), ...balance(-0.5)], [0.5, 1, 1, 0.5]);
});

test('opacityAt: the line, else the clip\'s constant, else 1; always between 0 and 1', () => {
  assert.equal(opacityAt({}, none, 0), 1);
  assert.equal(opacityAt({ opacity: 0.4 }, none, 0), 0.4);
  const line = lineSet({ opacity: [{ t: 0, v: 0, curve: 'linear' }, { t: 1000, v: 1, curve: 'linear' }] });
  assert.equal(opacityAt({ opacity: 0.4 }, line, 250), 0.25, 'the line wins over the constant');
  assert.equal(opacityAt({}, line, 5000), 1);
  assert.equal(opacityAt({}, lineSet({ opacity: [{ t: 0, v: 9, curve: 'linear' }] }), 0), 1, 'clamped (a line cannot hold more than 1 anyway)');
});

test('speedSyncWarning: only a video clip and a voice clip that overlap at different speeds disagree; music, subtitles, muted layers and equal speeds do not', async () => {
  const { speedSyncWarning, formatSpeed } = await import('../src/editor/ui/effects.mjs');
  const clip = (id, start, duration, extra = {}) => ({ id, start, duration, in: 0, src: `${id}.webm`, ...extra });
  const layer = (id, kind, clips, muted = false) => ({ id, kind, name: id, muted, locked: false, clips });
  const project = (video, voice, music = []) => ({ layers: [layer('v', 'video', video), layer('a', 'voice', voice), layer('m', 'music', music)] });
  assert.equal(formatSpeed(2), '2x');
  assert.equal(formatSpeed(0.5), '0.5x');
  assert.equal(formatSpeed(1.2345), '1.23x');
  assert.equal(speedSyncWarning(project([clip('c1', 0, 5000)], [clip('c2', 0, 5000)]), 'c1'), null, 'both at normal speed');
  const w = speedSyncWarning(project([clip('c1', 0, 2500, { speed: 2 })], [clip('c2', 0, 5000)]), 'c1');
  assert.match(w, /video clip runs at 2x, but the voice it overlaps \(c2\.webm\) is at 1x/);
  assert.match(speedSyncWarning(project([clip('c1', 0, 2500, { speed: 2 })], [clip('c2', 0, 5000)]), 'c2'), /voice clip runs at 1x, but the video it overlaps \(c1\.webm\) is at 2x/, 'either side gets the warning');
  assert.equal(speedSyncWarning(project([clip('c1', 0, 2500, { speed: 2 })], [clip('c2', 0, 2500, { speed: 2 })]), 'c1'), null, 'the same speed keeps them together');
  assert.equal(speedSyncWarning(project([clip('c1', 0, 2500, { speed: 2 })], [clip('c2', 2500, 2500)]), 'c1'), null, 'no overlap, no drift (touching is not overlapping)');
  assert.equal(speedSyncWarning(project([clip('c1', 0, 2500, { speed: 2 })], [], [clip('c3', 0, 5000)]), 'c1'), null, 'music is not lined up with the picture');
  const muted = project([clip('c1', 0, 2500, { speed: 2 })], [clip('c2', 0, 5000)]);
  muted.layers[1].muted = true;
  assert.equal(speedSyncWarning(muted, 'c1'), null, 'a muted layer is not heard, so nothing drifts');
  assert.equal(speedSyncWarning(project([clip('c1', 0, 5000)], []), 'nope'), null, 'an unknown clip');
  assert.equal(speedSyncWarning(project([clip('c1', 0, 5000)], [], [clip('c3', 0, 5000, { speed: 2 })]), 'c3'), null, 'a music clip has no partner');
});

test('zoomWindow: centred on the point, held inside the frame at the edges, the whole frame at 1x', async () => {
  const { zoomWindow } = await import('../src/editor/ui/effects.mjs');
  assert.deepEqual(zoomWindow({ x: 0.5, y: 0.5 }, 2), { left: 0.25, top: 0.25 });
  assert.deepEqual(zoomWindow({ x: 0.5, y: 0.5 }, 1), { left: 0, top: 0 });
  assert.deepEqual(zoomWindow({ x: 0, y: 0 }, 4), { left: 0, top: 0 }, 'a corner point cannot pull the window out of the frame');
  assert.deepEqual(zoomWindow({ x: 1, y: 1 }, 4), { left: 0.75, top: 0.75 });
  assert.deepEqual(zoomWindow({ x: 0.8, y: 0.1 }, 2), { left: 0.5, top: 0 });
});
