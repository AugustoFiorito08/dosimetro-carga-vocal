// Exact recomputation from the primary frames (odd/tasks/tramas-primarias.md, T2, S5): replaying
// the engine on the stored frames gives the stored doses; A_0 and q can then be changed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES } from '../src/dsp/frame-classifier.js';
import { createFrameLog, decodeFrames } from '../src/store/frame-record.js';
import { recomputeFromFrames } from '../src/stats/frame-recompute.js';
import { createVocalLoadState, stepVocalLoad } from '../src/vocal-load.js';

const DT = 2048 / 48000;
const A0 = 0.04;
const near = (a, b, rel) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${a} vs ${b}`);
/**
 * The level is stored in steps of 0.005 dB, so each frame's I = (A/A_0)^2 is off by at most
 * 2·ln(10)/20·0.0025 ≈ 5.8e-4. With few repeated levels (as here) the errors do not cancel.
 */
const LEVEL_ROUNDING = 6e-4;

/** A session measured with the engine (normalized to A_0) and its frame record. */
function measured(params, frames = 12000) {
  let load = createVocalLoadState({ params });
  const log = createFrameLog({ sampleRate: 48000, frameSize: 2048, pressureScale: { mode: 'own_voice', a0Rms: A0 }, referencePressure: 1, units: 'normalized', algorithmVersion: 'test' });
  let t = 0;
  for (let i = 0; i < frames; i++) {
    if (i === 6000) t += 30; // a pause: no frames, the engine does not move
    const voiced = i % 40 < 28;
    const rms = 0.02 + ((i * 7) % 23) / 1000;
    const f0 = 170 + (i % 35);
    const frame = { dt: DT, voiced, identityMatch: i % 11 !== 0, qualityOk: true, f0, pressure: rms / A0 };
    load = stepVocalLoad(load, frame);
    const phi = load.lastFrame.phi;
    log.push({ dt: DT, rms, f0: voiced ? f0 : null, snrDb: 30, V: voiced ? 1 : 0, W: frame.identityMatch ? 1 : 0, Q: 1, phi, category: phi ? CATEGORIES.ATTRIBUTED : CATEGORIES.SILENCE }, t);
    t += DT;
  }
  const { header, bytes } = log.encode();
  return { load, header, frames: decodeFrames(header, bytes) };
}

describe('recomputation from the primary frames', () => {
  it('replaying the engine with the recording parameters gives the stored doses and H', () => {
    const { load, header, frames } = measured({ beta: 0.03 });
    const r = recomputeFromFrames(header, frames, { params: { beta: 0.03 } });
    for (const m of ['none', 'linear', 'power', 'exponential', 'saturating']) near(r.doses[m], load.doses[m], LEVEL_ROUNDING);
    near(r.hFinal, load.h, 1e-9);
    near(r.phonationS, load.metrics.phonationTime, 1e-9);
  });

  it('other parameters give the doses the engine would have given with them', () => {
    const { header, frames } = measured({ beta: 0.03 });
    const other = measured({ beta: 0.01, alphaL: 0.08 });
    const r = recomputeFromFrames(header, frames, { params: { beta: 0.01, alphaL: 0.08 } });
    near(r.doses.linear, other.load.doses.linear, LEVEL_ROUNDING);
  });

  it('another A_0 rescales I = (A/A_0)^2; q changes its exponent', () => {
    const { header, frames } = measured({ beta: 0.03 });
    const base = recomputeFromFrames(header, frames, { params: { beta: 0.03 } });
    const half = recomputeFromFrames(header, frames, { params: { beta: 0.03 }, a0Rms: 2 * A0 });
    near(half.doses.none, base.doses.none / 4, 1e-9);
    const q1 = recomputeFromFrames(header, frames, { params: { beta: 0.03 }, q: 1 });
    assert.ok(q1.doses.none !== base.doses.none);
    assert.equal(base.q, 2);
  });

  it('a calibrated record uses the calibration coefficient and P_0', () => {
    const log = createFrameLog({ sampleRate: 48000, frameSize: 2048, pressureScale: { mode: 'calibrated', coefficient: 2 }, referencePressure: 2e-5, units: 'calibrated', algorithmVersion: 'test' });
    log.push({ dt: DT, rms: 0.01, f0: 200, snrDb: 30, V: 1, W: 1, Q: 1, phi: 1, category: CATEGORIES.ATTRIBUTED }, 0);
    const { header, bytes } = log.encode();
    const r = recomputeFromFrames(header, decodeFrames(header, bytes), { params: { beta: 0.03 } });
    near(r.doses.none, 200 * (0.02 / 2e-5) ** 2 * DT, 2e-3);
  });

  it('refuses an A_0 on a calibrated record and a non-positive q', () => {
    const { header, frames } = measured({ beta: 0.03 }, 10);
    assert.throws(() => recomputeFromFrames(header, frames, { params: {}, q: 0 }), RangeError);
    assert.throws(() => recomputeFromFrames({ ...header, pressureScale: { mode: 'calibrated', coefficient: 1 }, units: 'calibrated' }, frames, { params: {}, a0Rms: 0.1 }), RangeError);
  });
});
