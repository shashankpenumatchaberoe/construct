// The maths of drawing an automation line: heights, values, text, snapping, and the freehand simplifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisTicks, formatValue, simplify, snapTime, snapValue, strokeToPoints, valueToY, yToValue } from '../src/editor/ui/lane.mjs';
import { PARAMS, laneValueAt } from '../src/editor/ui/effects.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('valueToY and yToValue are inverses inside each param\'s range, and the ends land on the edges', () => {
  for (const [param, values] of Object.entries({ gain: [0.05, 0.0398, 0.25, 0.5, 1, 2, 3.9], pan: [-1, -0.5, 0, 0.3, 1], mute: [0, 0.5, 1], opacity: [0, 0.25, 1] })) {
    for (const v of values) { const y = valueToY(param, v); assert.ok(y >= 0 && y <= 1, `${param} ${v} height ${y}`); near(yToValue(param, y), v, 0.0006 + Math.abs(v) * 0.001, `${param} ${v} round trip`); }
  }
  assert.equal(valueToY('pan', 1), 0); assert.equal(valueToY('pan', -1), 1); assert.equal(valueToY('pan', 0), 0.5);
  assert.equal(valueToY('opacity', 1), 0); assert.equal(valueToY('opacity', 0), 1);
  assert.equal(valueToY('mute', 1), 0); assert.equal(valueToY('mute', 0), 1);
  assert.equal(valueToY('gain', 4), 0, 'the top of a volume lane is +12 dB');
  assert.equal(valueToY('gain', 0), 1, 'and the bottom is silence');
  assert.ok(valueToY('gain', 1) > 0.15 && valueToY('gain', 1) < 0.3, `unity sits about three quarters up: ${valueToY('gain', 1)}`);
  assert.ok(valueToY('gain', 0.5) > valueToY('gain', 1), 'quieter is lower');
  assert.equal(yToValue('gain', 1), 0, 'the bottom edge is silence');
  assert.equal(yToValue('pan', -5), 1, 'a height above the lane clamps to the top: hard right');
  assert.equal(yToValue('pan', 5), -1, 'and below it to the bottom: hard left');
  assert.equal(yToValue('opacity', 9), 0);
  assert.equal(yToValue('opacity', -3), 1);
  for (const param of Object.keys(PARAMS).filter((p) => ['gain', 'pan', 'mute', 'opacity'].includes(p))) for (let y = 0; y <= 1; y += 0.05) { const v = yToValue(param, y); assert.ok(v >= PARAMS[param].min && v <= PARAMS[param].max, `${param} at height ${y}: ${v}`); }
});

test('formatValue reads each param the way a person would say it', () => {
  assert.equal(formatValue('gain', 1), '0.0 dB');
  assert.equal(formatValue('gain', 0.5), '-6.0 dB');
  assert.equal(formatValue('gain', 0), '-inf dB');
  assert.deepEqual([-1, -0.4, 0, 0.004, 0.25, 1].map((v) => formatValue('pan', v)), ['L 100%', 'L 40%', 'C', 'C', 'R 25%', 'R 100%']);
  assert.deepEqual([0, 1, 0.5, 0.001, 0.999].map((v) => formatValue('mute', v)), ['On', 'Muted', '50% muted', 'On', 'Muted']);
  assert.deepEqual([0, 0.5, 1, 0.333].map((v) => formatValue('opacity', v)), ['0%', '50%', '100%', '33%']);
  for (const p of ['gain', 'pan', 'mute', 'opacity']) { const t = axisTicks(p); assert.ok(t.length >= 2 && t.every(([y, s]) => y >= 0 && y <= 1 && s), `${p} has labelled ticks`); }
});

test('simplify keeps the shape of a stroke with far fewer points, always keeps both ends, and a tolerance changes how many', () => {
  const sine = Array.from({ length: 400 }, (_, i) => ({ x: i / 399, y: 0.5 + 0.4 * Math.sin((i / 399) * Math.PI * 4) }));
  const loose = simplify(sine, 0.08);
  const tight = simplify(sine, 0.005);
  assert.ok(loose.length < 40 && loose.length >= 5, `a loose tolerance leaves few points: ${loose.length}`);
  assert.ok(tight.length > loose.length * 2 && tight.length < 400, `a tight one keeps more: ${tight.length}`);
  for (const s of [loose, tight]) { assert.deepEqual(s[0], sine[0]); assert.deepEqual(s.at(-1), sine.at(-1)); }
  // the simplified shape stays within the tolerance of every sample (measured vertically, which is at least the perpendicular distance)
  const at = (pts, x) => { let i = 0; while (i < pts.length - 2 && pts[i + 1].x < x) i++; const a = pts[i]; const b = pts[i + 1]; return b.x === a.x ? a.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x); };
  const worst = Math.max(...sine.map((p) => Math.abs(at(tight, p.x) - p.y)));
  assert.ok(worst < 0.05, `the tight version follows the stroke: worst gap ${worst}`);
  assert.deepEqual(simplify([], 0.1), []);
  assert.deepEqual(simplify([{ x: 0, y: 0 }], 0.1), [{ x: 0, y: 0 }]);
  const two = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(simplify(two, 0.1), two);
  const straight = Array.from({ length: 50 }, (_, i) => ({ x: i / 49, y: i / 49 }));
  assert.equal(simplify(straight, 0.001).length, 2, 'a straight stroke is just its ends');
  const same = Array.from({ length: 10 }, () => ({ x: 0.5, y: 0.5 }));
  assert.equal(simplify(same, 0.01).length, 2, 'a stroke that goes nowhere does not divide by zero');
});

test('strokeToPoints turns a mouse stroke into a valid line: sorted, unique times, inside the clip, a few points', () => {
  const dur = 4000;
  const stroke = Array.from({ length: 200 }, (_, i) => ({ t: (i / 199) * dur, v: Math.max(0.05, 1 - (i / 199) * 0.9) })); // a smooth fade
  const pts = strokeToPoints('gain', stroke, dur, 0.03);
  assert.ok(pts.length >= 2 && pts.length < 20, `a smooth fade needs few points: ${pts.length}`);
  assert.equal(pts[0].t, 0); assert.equal(pts.at(-1).t, dur);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].t > pts[i - 1].t, 'times strictly increase');
  assert.ok(pts.every((p) => p.curve === 'linear' && Number.isInteger(p.t)));
  assert.equal(strokeToPoints('mute', stroke, dur, 0.03)[0].curve, 'hold', 'a mute line is made of steps');
  const messy = [{ t: 900, v: 0.5 }, { t: 100, v: 1 }, { t: 100, v: 0.2 }, { t: -50, v: 0.3 }, { t: 9999, v: 0.9 }, { t: 500, v: 0.7 }];
  const cleaned = strokeToPoints('opacity', messy, dur, 0.001);
  assert.deepEqual(cleaned.map((p) => p.t), [100, 500, 900], 'sorted, one point per time (the first drawn wins), outside the clip dropped');
  assert.deepEqual(strokeToPoints('gain', [], dur, 0.03), []);
  assert.deepEqual(strokeToPoints('gain', [{ t: 5, v: 1 }], dur, 0.03).map((p) => p.t), [5], 'a single dab is one point');
  // what the line does agrees with what was drawn
  const line = strokeToPoints('opacity', Array.from({ length: 100 }, (_, i) => ({ t: (i / 99) * dur, v: i / 99 })), dur, 0.02);
  near(laneValueAt(line, 2000), 0.5, 0.02, 'a ramp drawn 0 to 1 is 0.5 half way');
});

test('snapping: a time snaps to the nearest target within reach, a value snaps to its resting height', () => {
  assert.equal(snapTime(1000, [0, 1010, 5000], 30), 1010);
  assert.equal(snapTime(1000, [0, 1100, 5000], 30), 1000, 'out of reach: unchanged');
  assert.equal(snapTime(1000, [980, 1015], 30), 1015, 'the nearer wins');
  assert.equal(snapTime(1000, [], 30), 1000);
  assert.equal(snapValue('gain', 0.97, [1], 0.03), 1, 'close to unity: snaps to unity');
  assert.equal(snapValue('gain', 0.5, [1], 0.03), 0.5, 'far: unchanged');
  assert.equal(snapValue('pan', 0.02, [0], 0.03), 0, 'close to centre snaps to centre');
  assert.equal(snapValue('opacity', 0.99, [1, 0], 0.03), 1);
});
