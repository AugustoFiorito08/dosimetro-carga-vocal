// Per-second series of a workday (perSecond): phonated time and mean F0·I of each measured
// second, enough to recompute the doses without the audio or the frames.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SERIES_SECONDS, createSecondSeries } from '../src/store/second-series.js';
import { createVocalLoadState, stepVocalLoad } from '../src/vocal-load.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe('per-second series', () => {
  it('is null before any frame', () => {
    assert.equal(createSecondSeries().toJSON(), null);
  });

  it('splits a frame that crosses a second boundary by its duration', () => {
    const s = createSecondSeries();
    for (let i = 0; i < 3; i++) s.push({ dt: 0.4, phi: 1, f0: 200, intensity: 1.5 });
    const { phonation, f0I } = s.toJSON();
    assert.equal(phonation.length, 2);
    near(phonation[0], 1, 1e-4);
    near(phonation[1], 0.2, 1e-4);
    assert.deepEqual(f0I, [300, 300]);
  });

  it('keeps phonated time and the F0·I mean weighted by it; unvoiced frames add only time', () => {
    const s = createSecondSeries();
    s.push({ dt: 0.25, phi: 1, f0: 100, intensity: 2 }); // F0·I 200
    s.push({ dt: 0.25, phi: 0, f0: NaN, intensity: 0 });
    s.push({ dt: 0.5, phi: 1, f0: 200, intensity: 2 }); // F0·I 400
    s.push({ dt: 1, phi: 0, f0: NaN, intensity: 0 });
    const { phonation, f0I } = s.toJSON();
    assert.deepEqual(phonation, [0.75, 0]);
    near(f0I[0], (200 * 0.25 + 400 * 0.5) / 0.75, 1e-3);
    assert.equal(f0I[1], 0);
  });

  it('reset empties it for a new session', () => {
    const s = createSecondSeries();
    s.push({ dt: 1, phi: 1, f0: 200, intensity: 1 });
    s.reset();
    assert.equal(s.toJSON(), null);
  });

  it('matches the engine: phonation time and the memory-free dose D0 are recovered', () => {
    let load = createVocalLoadState();
    const s = createSecondSeries();
    const dt = 2048 / 48000; // frames do not align with seconds
    for (let i = 0; i < 3000; i++) {
      const voiced = i % 7 < 5;
      load = stepVocalLoad(load, { dt, voiced, identityMatch: true, qualityOk: true, f0: 150 + (i % 40), pressure: 0.02 + (i % 9) / 1000 });
      s.push({ dt, phi: load.lastFrame.phi, f0: 150 + (i % 40), intensity: load.lastFrame.intensity });
    }
    const { phonation, f0I } = s.toJSON();
    assert.equal(phonation.length, Math.ceil(load.metrics.totalTime));
    near(phonation.reduce((a, b) => a + b, 0), load.metrics.phonationTime, 1e-3);
    const d0 = phonation.reduce((sum, p, k) => sum + p * f0I[k], 0);
    near(d0 / load.doses.none, 1, 1e-4);
  });

  it('covers at most one day', () => {
    assert.equal(MAX_SERIES_SECONDS, 24 * 3600);
  });
});
