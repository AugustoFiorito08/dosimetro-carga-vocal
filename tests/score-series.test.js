import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SCORE_DOSES, createScoreSeries } from '../src/ui/score-series.js';

const DT = 0.5;
const frame = (t, { phi = 1, f0 = 200, level = 70, h = t, dose = t, distance = null } = {}) => ({
  t, dt: DT, phi, f0: phi ? f0 : null, level: phi ? level : null, h,
  doses: { none: dose, linear: 2 * dose, power: dose, exponential: dose, saturating: dose }, distanceDose: distance,
});
const fill = (series, frames) => { frames.forEach((f) => series.push(f)); return series; };

describe('score series storage', () => {
  it('lists the selectable doses', () => {
    assert.deepEqual(SCORE_DOSES, ['none', 'linear', 'power', 'exponential', 'saturating', 'distance']);
  });

  it('grows past its initial capacity and keeps every frame', () => {
    const s = createScoreSeries({ initialCapacity: 4 });
    for (let i = 0; i < 100; i++) s.push(frame(i * DT));
    assert.equal(s.length, 100);
    assert.equal(s.startTime, 0);
    assert.equal(s.endTime, 99 * DT + DT);
    assert.equal(s.sampleAt(25).h, 25);
  });

  it('reset empties it', () => {
    const s = fill(createScoreSeries(), [frame(0), frame(0.5)]);
    s.reset();
    assert.equal(s.length, 0);
    assert.equal(s.startTime, null);
  });
});

describe('bucketize (one bucket per pixel column)', () => {
  // 0-2 s voiced (f0 200 then 300), 2-4 s silent, dose rises only while voiced
  const frames = [
    frame(0, { f0: 200, dose: 1 }), frame(0.5, { f0: 200, dose: 2 }), frame(1, { f0: 300, dose: 3 }), frame(1.5, { f0: 300, dose: 4 }),
    frame(2, { phi: 0, dose: 4 }), frame(2.5, { phi: 0, dose: 4 }), frame(3, { phi: 0, dose: 4 }), frame(3.5, { phi: 0, dose: 4 }),
  ];
  const s = fill(createScoreSeries(), frames);

  it('phonation fraction, F0 and level only over voiced frames, last H and dose', () => {
    const b = s.bucketize({ from: 0, to: 4, buckets: 2, dose: 'none' });
    assert.deepEqual([...b.phi], [1, 0]);
    assert.deepEqual([...b.f0].map((v) => (Number.isNaN(v) ? 'NaN' : v)), [250, 'NaN']);
    assert.deepEqual([...b.level].map((v) => (Number.isNaN(v) ? 'NaN' : v)), [70, 'NaN']);
    assert.deepEqual([...b.h], [1.5, 3.5]);
    assert.deepEqual([...b.dose], [4, 4]);
  });

  it('rate is the dose accumulated inside the bucket per minute of elapsed time', () => {
    const b = s.bucketize({ from: 0, to: 4, buckets: 2, dose: 'none' });
    assert.deepEqual([...b.rate], [(4 / 2) * 60, 0]);
    const linear = s.bucketize({ from: 0, to: 4, buckets: 2, dose: 'linear' });
    assert.deepEqual([...linear.rate], [(8 / 2) * 60, 0]);
  });

  it('empty buckets are NaN, not zero', () => {
    const b = s.bucketize({ from: 0, to: 8, buckets: 4, dose: 'none' });
    assert.ok(Number.isNaN(b.phi[3]) && Number.isNaN(b.h[3]) && Number.isNaN(b.dose[3]) && Number.isNaN(b.rate[3]));
  });

  it('distance dose is NaN while the session does not compute it, and readable when it does', () => {
    assert.ok(Number.isNaN(s.bucketize({ from: 0, to: 4, buckets: 1, dose: 'distance' }).dose[0]));
    const d = fill(createScoreSeries(), [frame(0, { distance: 0.1 }), frame(0.5, { distance: 0.3 })]);
    const b = d.bucketize({ from: 0, to: 1, buckets: 1, dose: 'distance' });
    assert.equal(b.dose[0], 0.3);
    assert.ok(Math.abs(b.rate[0] - 0.3 * 60) < 1e-12);
  });

  it('rejects an unknown dose', () => {
    assert.throws(() => s.bucketize({ from: 0, to: 4, buckets: 2, dose: 'bogus' }), RangeError);
  });
});

describe('pauses and session gaps', () => {
  it('finds non-phonation runs of at least minSeconds', () => {
    const s = fill(createScoreSeries(), [
      frame(0), frame(0.5, { phi: 0 }), frame(1),
      frame(1.5, { phi: 0 }), frame(2, { phi: 0 }), frame(2.5, { phi: 0 }), frame(3, { phi: 0 }), frame(3.5),
    ]);
    assert.deepEqual(s.pauses(2), [{ from: 1.5, to: 3.5 }]);
    assert.deepEqual(s.pauses(0.5), [{ from: 0.5, to: 1 }, { from: 1.5, to: 3.5 }]);
  });

  it('a paused session shows up as a gap and splits pauses', () => {
    const s = fill(createScoreSeries(), [frame(0, { phi: 0 }), frame(0.5, { phi: 0 }), frame(10, { phi: 0 }), frame(10.5, { phi: 0 })]);
    assert.deepEqual(s.gaps(), [{ from: 1, to: 10 }]);
    assert.deepEqual(s.pauses(1), [{ from: 0, to: 1 }, { from: 10, to: 11 }]);
    assert.ok(Number.isNaN(s.bucketize({ from: 0, to: 11, buckets: 11, dose: 'none' }).h[5]));
  });

  it('sampleAt returns the frame covering a time, or null inside a gap', () => {
    const s = fill(createScoreSeries(), [frame(0), frame(0.5), frame(10)]);
    assert.equal(s.sampleAt(0.7).t, 0.5);
    assert.equal(s.sampleAt(5), null);
    assert.equal(s.sampleAt(10.2).t, 10);
  });
});

describe('voicedValues', () => {
  it('returns the finite F0 or level values of accepted phonation only', () => {
    const s = fill(createScoreSeries(), [frame(0, { f0: 180, level: 70 }), frame(0.5, { phi: 0 }), frame(1, { f0: 220, level: 80 })]);
    assert.deepEqual([...s.voicedValues('f0')], [180, 220]);
    assert.deepEqual([...s.voicedValues('level')], [70, 80]);
    assert.throws(() => s.voicedValues('h'), RangeError);
  });
});
