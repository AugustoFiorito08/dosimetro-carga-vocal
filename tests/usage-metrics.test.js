import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createVocalLoadState, meanDuration, stepVocalLoad } from '../src/vocal-load.js';

const voice = (dt) => ({ dt, voiced: true, identityMatch: true, qualityOk: true, f0: 200, pressure: 1 });
const quiet = (dt) => ({ dt, voiced: false, identityMatch: false, qualityOk: true, category: 'silence' });
const run = (frames) => frames.reduce(stepVocalLoad, createVocalLoadState()).metrics;

describe('pauses only between phonation episodes', () => {
  it('excludes the initial silence before the first episode', () => {
    const m = run([quiet(5), voice(1), quiet(0.5), voice(1)]);
    assert.equal(m.pauses.count, 1);
    assert.equal(m.pauses.totalDuration, 0.5);
    assert.equal(meanDuration(m.pauses), 0.5);
    assert.equal(m.nonPhonationTime, 5.5, 'initial silence still counts as non-phonation time');
  });

  it('keeps the trailing run pending until a new episode closes it', () => {
    const m = run([voice(1), quiet(0.25), voice(1), quiet(3)]);
    assert.equal(m.pauses.count, 1);
    assert.equal(meanDuration(m.pauses), 0.25);
    assert.equal(m.pendingPause, 3);
    const closed = stepVocalLoad({ ...createVocalLoadState(), metrics: m }, voice(1)).metrics;
    assert.equal(closed.pauses.count, 2);
    assert.equal(meanDuration(closed.pauses), (0.25 + 3) / 2);
    assert.equal(closed.pendingPause, 0);
  });

  it('only-silence sessions have no pauses', () => {
    const m = run([quiet(10)]);
    assert.equal(m.pauses.count, 0);
    assert.equal(meanDuration(m.pauses), 0);
    assert.equal(m.pendingPause, 0);
  });
});
