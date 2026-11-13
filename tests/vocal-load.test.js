import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_PARAMS,
  acceptedPhonation,
  createVocalLoadState,
  doseIncrements,
  halfLife,
  meanDuration,
  memoryFunctions,
  nonPhonationPercentage,
  normalizedAcousticLoad,
  phonationPercentage,
  resolveModelParams,
  stepVocalLoad,
  timeConstant,
  updateLoadState,
} from '../src/vocal-load.js';

const EPS = 1e-12;
const close = (actual, expected, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= EPS * Math.max(1, Math.abs(expected)),
    `${msg ?? ''} expected ${expected}, got ${actual}`,
  );

const voice = (dt, f0 = 200, pressure = 1) => ({
  dt, voiced: true, identityMatch: true, qualityOk: true, f0, pressure,
});
const silence = (dt) => ({ dt, voiced: false, identityMatch: false, qualityOk: true, category: 'silence' });
const run = (state, frames) => frames.reduce(stepVocalLoad, state);

describe('acceptance rule Phi_k = V_k * W_k * Q_k', () => {
  it('is 1 only when all three factors are 1', () => {
    for (const v of [0, 1]) for (const w of [0, 1]) for (const q of [0, 1]) {
      assert.equal(acceptedPhonation(v, w, q), v * w * q);
    }
    assert.equal(acceptedPhonation(true, true, true), 1);
  });

  it('treats non-boolean / missing factors as 0', () => {
    assert.equal(acceptedPhonation(undefined, true, true), 0);
    assert.equal(acceptedPhonation(true, 'yes', true), 0);
    assert.equal(acceptedPhonation(true, true, 0.9), 0);
  });
});

describe('dynamic load state H_k', () => {
  it('increases by Delta_t during phonation from rest', () => {
    close(updateLoadState(0, 1, 0.5, 0.1), 0.5);
  });

  it('decays exponentially in silence', () => {
    const beta = 0.1;
    close(updateLoadState(10, 0, 2, beta), 10 * Math.exp(-0.2));
  });

  it('halves after one half-life and drops to 1/e after one tau', () => {
    const beta = 0.05;
    close(updateLoadState(8, 0, halfLife(beta), beta), 4);
    close(updateLoadState(8, 0, timeConstant(beta), beta), 8 / Math.E);
  });

  it('matches the recurrence over a mixed sequence', () => {
    const beta = 0.2;
    const seq = [[1, 0.1], [1, 0.1], [0, 0.3], [1, 0.05], [0, 1]];
    let expected = 0;
    let h = 0;
    for (const [phi, dt] of seq) {
      expected = expected * Math.exp(-beta * dt) + phi * dt;
      h = updateLoadState(h, phi, dt, beta);
    }
    close(h, expected);
  });

  it('stays at exactly 0 at rest (H=0, no phonation)', () => {
    assert.equal(updateLoadState(0, 0, 10, 0.1), 0);
  });

  it('is unchanged when Delta_t = 0', () => {
    assert.equal(updateLoadState(3.7, 1, 0, 0.1), 3.7);
    assert.equal(updateLoadState(3.7, 0, 0, 0.1), 3.7);
  });

  it('handles very small Delta_t without loss of finiteness', () => {
    const h = updateLoadState(5, 1, 1e-12, 0.1);
    assert.ok(Number.isFinite(h));
    close(h, 5 * Math.exp(-1e-13) + 1e-12);
  });

  it('beta = 0 means no recovery and infinite tau / half-life', () => {
    assert.equal(updateLoadState(4, 0, 100, 0), 4);
    assert.equal(timeConstant(0), Infinity);
    assert.equal(halfLife(0), Infinity);
  });

  it('derives tau = 1/beta and t1/2 = ln2/beta', () => {
    close(timeConstant(0.25), 4);
    close(halfLife(0.25), Math.LN2 / 0.25);
  });

  it('rejects negative or non-finite inputs', () => {
    assert.throws(() => updateLoadState(0, 1, -1, 0.1), RangeError);
    assert.throws(() => updateLoadState(0, 1, NaN, 0.1), RangeError);
    assert.throws(() => updateLoadState(-1, 1, 1, 0.1), RangeError);
    assert.throws(() => updateLoadState(0, 1, 1, -0.1), RangeError);
    assert.throws(() => timeConstant(-1), RangeError);
  });
});

describe('normalized acoustic load I_k = (P_k / P_0)^2', () => {
  it('computes the squared ratio', () => {
    close(normalizedAcousticLoad(0.4, 0.2), 4);
    close(normalizedAcousticLoad(0.02, 0.02), 1);
  });

  it('defaults P_0 = 1 for relative magnitudes', () => {
    close(normalizedAcousticLoad(0.5), 0.25);
  });

  it('is 0 for zero pressure', () => {
    assert.equal(normalizedAcousticLoad(0, 2), 0);
  });

  it('rejects P_0 <= 0 (division by zero) and invalid P_k', () => {
    assert.throws(() => normalizedAcousticLoad(1, 0), RangeError);
    assert.throws(() => normalizedAcousticLoad(1, -1), RangeError);
    assert.throws(() => normalizedAcousticLoad(-1, 1), RangeError);
    assert.throws(() => normalizedAcousticLoad(NaN, 1), RangeError);
  });

  it('labels results as relative unless calibrated', () => {
    assert.equal(createVocalLoadState().units, 'relative');
    assert.equal(createVocalLoadState({ calibrated: true, referencePressure: 0.02 }).units, 'calibrated');
  });
});

describe('dose models (exact formulas)', () => {
  const params = resolveModelParams({ alphaL: 0.03, a: 2, p: 1.5, hRef: 10, alphaE: 0.02, A: 3, kH: 5 });
  const f0 = 220;
  const intensity = 1.44;
  const h = 7.5;
  const dt = 0.02;
  const base = f0 * intensity * dt;
  const inc = doseIncrements({ f0, intensity, phi: 1, h, dt }, params);

  it('D_0: F0 * I * Phi * Delta_t', () => close(inc.none, base));
  it('D_L: ... * (1 + alpha_L * H)', () => close(inc.linear, base * (1 + 0.03 * 7.5)));
  it('D_P: ... * [1 + a * (H / H_ref)^p]', () => close(inc.power, base * (1 + 2 * (7.5 / 10) ** 1.5)));
  it('D_E: ... * exp(alpha_E * H)', () => close(inc.exponential, base * Math.exp(0.02 * 7.5)));
  it('D_S: ... * [1 + A * H / (K_H + H)]', () => close(inc.saturating, base * (1 + (3 * 7.5) / (5 + 7.5))));

  it('all memory functions equal 1 at H = 0', () => {
    for (const [name, f] of Object.entries(memoryFunctions)) close(f(0, params), 1, name);
  });

  it('saturating model is bounded by 1 + A as H grows', () => {
    const value = memoryFunctions.saturating(1e12, params);
    assert.ok(value < 1 + params.A);
    // 1 + A - A*K_H/(K_H + H) -> 1 + A
    assert.ok(1 + params.A - value < 1e-10, 'approaches 1 + A');
  });

  it('accumulates over frames using H_k updated in the same frame', () => {
    const p = resolveModelParams({ beta: 0.1, alphaL: 0.05, a: 1, p: 2, hRef: 2, alphaE: 0.1, A: 2, kH: 1 });
    const frames = [voice(0.5, 200, 2), voice(0.5, 180, 1), silence(1), voice(0.25, 250, 0.5)];
    const expected = { none: 0, linear: 0, power: 0, exponential: 0, saturating: 0 };
    let hk = 0;
    for (const fr of frames) {
      const phi = fr.voiced ? 1 : 0;
      hk = hk * Math.exp(-0.1 * fr.dt) + phi * fr.dt;
      if (!phi) continue;
      const b = fr.f0 * fr.pressure ** 2 * fr.dt;
      expected.none += b;
      expected.linear += b * (1 + 0.05 * hk);
      expected.power += b * (1 + 1 * (hk / 2) ** 2);
      expected.exponential += b * Math.exp(0.1 * hk);
      expected.saturating += b * (1 + (2 * hk) / (1 + hk));
    }
    const state = run(createVocalLoadState({ params: p }), frames);
    close(state.h, hk, 'H');
    for (const m of Object.keys(expected)) close(state.doses[m], expected[m], m);
  });

  it('exposes configurable defaults and validates parameters', () => {
    assert.deepEqual(resolveModelParams(), { ...DEFAULT_MODEL_PARAMS });
    assert.equal(resolveModelParams({ beta: 0.5 }).beta, 0.5);
    assert.throws(() => resolveModelParams({ hRef: 0 }), RangeError);
    assert.throws(() => resolveModelParams({ kH: 0 }), RangeError);
    assert.throws(() => resolveModelParams({ p: 0 }), RangeError);
    assert.throws(() => resolveModelParams({ beta: -1 }), RangeError);
    assert.throws(() => resolveModelParams({ alphaE: NaN }), RangeError);
  });
});

describe('Phi_k = 0 never increases H or doses', () => {
  const rejected = {
    noise: { dt: 1, voiced: false, identityMatch: false, qualityOk: false, category: 'noise' },
    'foreign voice': { dt: 1, voiced: true, identityMatch: false, qualityOk: true, f0: 150, pressure: 1, category: 'unattributed_voice' },
    'low quality': { dt: 1, voiced: true, identityMatch: true, qualityOk: false, f0: 150, pressure: 1, category: 'uncertain' },
  };

  for (const [label, frame] of Object.entries(rejected)) {
    it(`${label}: H does not grow and doses stay constant`, () => {
      const loaded = run(createVocalLoadState(), [voice(2)]);
      const next = stepVocalLoad(loaded, frame);
      assert.equal(next.lastFrame.phi, 0);
      assert.ok(next.h < loaded.h, 'H must decay');
      assert.deepEqual(next.doses, loaded.doses);
      assert.ok(Object.values(next.lastFrame.increments).every((v) => v === 0));
    });
  }

  it('ignores missing F0 / pressure when Phi_k = 0 (no NaN propagation)', () => {
    const next = stepVocalLoad(createVocalLoadState(), { dt: 1, voiced: false, identityMatch: true, qualityOk: true, f0: NaN });
    assert.ok(Object.values(next.doses).every((v) => v === 0));
    assert.equal(next.h, 0);
  });

  it('a long rejected stream from rest keeps everything at zero', () => {
    const frames = Array.from({ length: 100 }, () => rejected.noise);
    const state = run(createVocalLoadState(), frames);
    assert.equal(state.h, 0);
    assert.ok(Object.values(state.doses).every((v) => v === 0));
  });
});

describe('usage metrics', () => {
  // P(0.5) S(0.3) P(0.2) P(0.1) N(0.4) U(0.1) P(0.6)
  const frames = [
    voice(0.5),
    silence(0.3),
    voice(0.2),
    voice(0.1),
    { dt: 0.4, voiced: false, identityMatch: false, qualityOk: false, category: 'noise' },
    { dt: 0.1, voiced: true, identityMatch: false, qualityOk: true, category: 'unattributed_voice' },
    voice(0.6),
  ];
  const { metrics } = run(createVocalLoadState(), frames);

  it('computes total, phonation and non-phonation time', () => {
    close(metrics.totalTime, 2.2);
    close(metrics.phonationTime, 1.4);
    close(metrics.nonPhonationTime, 0.8);
  });

  it('computes phonation percentage 100 * Tf / (Tf + Tnf)', () => {
    close(phonationPercentage(metrics), (100 * 1.4) / 2.2);
    close(nonPhonationPercentage(metrics), (100 * 0.8) / 2.2);
  });

  it('keeps the original non-phonation classification', () => {
    close(metrics.timeByCategory.attributed, 1.4);
    close(metrics.timeByCategory.silence, 0.3);
    close(metrics.timeByCategory.noise, 0.4);
    close(metrics.timeByCategory.unattributed_voice, 0.1);
    assert.equal(metrics.timeByCategory.uncertain, 0);
  });

  it('counts episodes and their durations', () => {
    assert.equal(metrics.episodes.count, 3);
    close(metrics.episodes.totalDuration, 1.4);
    close(metrics.episodes.maxDuration, 0.6);
    close(meanDuration(metrics.episodes), 1.4 / 3);
  });

  it('counts pauses (merged consecutive non-phonation frames) and durations', () => {
    assert.equal(metrics.pauses.count, 2);
    close(metrics.pauses.totalDuration, 0.8);
    close(metrics.pauses.maxDuration, 0.5);
    close(meanDuration(metrics.pauses), 0.4);
  });

  it('returns 0% and 0 means with no elapsed time (no division by zero)', () => {
    const empty = createVocalLoadState().metrics;
    assert.equal(phonationPercentage(empty), 0);
    assert.equal(nonPhonationPercentage(empty), 0);
    assert.equal(meanDuration(empty.episodes), 0);
    assert.equal(meanDuration(empty.pauses), 0);
  });

  it('zero-length frames neither add time nor split episodes', () => {
    const state = run(createVocalLoadState(), [voice(0.2), silence(0), voice(0.3)]);
    assert.equal(state.metrics.episodes.count, 1);
    close(state.metrics.episodes.maxDuration, 0.5);
    assert.equal(state.metrics.pauses.count, 0);
    assert.equal(state.frameIndex, 3);
  });

  it('defaults unclassified non-phonation to "uncertain" and rejects invalid categories', () => {
    const s = stepVocalLoad(createVocalLoadState(), { dt: 1, voiced: false, identityMatch: false, qualityOk: false });
    assert.equal(s.metrics.timeByCategory.uncertain, 1);
    assert.throws(() => stepVocalLoad(createVocalLoadState(), { ...silence(1), category: 'attributed' }), RangeError);
    assert.throws(() => stepVocalLoad(createVocalLoadState(), { ...silence(1), category: 'bogus' }), RangeError);
  });
});

describe('engine purity and edge cases', () => {
  it('does not mutate the previous state', () => {
    const s0 = createVocalLoadState();
    const snapshot = structuredClone(s0);
    stepVocalLoad(s0, voice(1));
    assert.deepEqual(s0, snapshot);
  });

  it('Delta_t = 0 with phonation leaves H and doses unchanged', () => {
    const loaded = run(createVocalLoadState(), [voice(1)]);
    const next = stepVocalLoad(loaded, voice(0));
    assert.equal(next.h, loaded.h);
    assert.deepEqual(next.doses, loaded.doses);
  });

  it('many tiny steps converge to one large step for H in pure phonation (beta = 0)', () => {
    const fine = run(createVocalLoadState({ params: { beta: 0 } }), Array.from({ length: 1000 }, () => voice(1e-3)));
    close(fine.h, 1, 'H');
    assert.ok(Math.abs(fine.doses.none - 200) < 1e-9);
  });

  it('rejects invalid Delta_t and P_0 at the engine boundary', () => {
    assert.throws(() => stepVocalLoad(createVocalLoadState(), voice(-0.1)), RangeError);
    assert.throws(() => stepVocalLoad(createVocalLoadState(), voice(Infinity)), RangeError);
    assert.throws(() => createVocalLoadState({ referencePressure: 0 }), RangeError);
  });

  it('exposes derived tau and half-life from beta', () => {
    const s = createVocalLoadState({ params: { beta: 0.02 } });
    close(s.tau, 50);
    close(s.halfLife, Math.LN2 / 0.02);
  });
});

describe('parameter anchoring f(H*) = f* tied to beta', () => {
  const DOSE_SHAPES = ['linear', 'power', 'exponential', 'saturating'];
  const fAt = (params, h) => Object.fromEntries(DOSE_SHAPES.map((m) => [m, memoryFunctions[m](h, params)]));

  it('defaults anchor every memory function at H* = tau with f* = 2', () => {
    const p = resolveModelParams();
    close(p.beta, 1 / 300);
    close(p.hStar, 300);
    assert.equal(p.fStar, 2);
    for (const [model, value] of Object.entries(fAt(p, p.hStar))) close(value, 2, model);
    for (const [model, value] of Object.entries(fAt(p, 0))) close(value, 1, model);
  });

  it('derives the shape parameters from H*, f*, p and K_H', () => {
    const p = resolveModelParams({ beta: 0.01, fStar: 3, p: 1.5, kH: 50 });
    close(p.hStar, 100);
    close(p.alphaL, 2 / 100);
    close(p.a, 2);
    close(p.hRef, 100);
    assert.equal(p.p, 1.5);
    close(p.alphaE, Math.log(3) / 100);
    close(p.A, (2 * (50 + 100)) / 100);
    assert.equal(p.kH, 50);
    for (const [model, value] of Object.entries(fAt(p, 100))) close(value, 3, model);
  });

  it('re-anchors when only beta is overridden', () => {
    const p = resolveModelParams({ beta: 0.02 });
    close(p.hStar, 50);
    for (const [model, value] of Object.entries(fAt(p, 50))) close(value, 2, model);
  });

  it('honours an explicit H* and lets explicit shape parameters win', () => {
    const p = resolveModelParams({ hStar: 20, alphaE: 0.5 });
    close(p.hStar, 20);
    close(memoryFunctions.linear(20, p), 2);
    assert.equal(p.alphaE, 0.5);
  });

  it('falls back to H* = 300 s when beta = 0 and no H* is given', () => {
    const p = resolveModelParams({ beta: 0 });
    close(p.hStar, 300);
    close(memoryFunctions.exponential(300, p), 2);
  });

  it('rejects f* < 1 and non-positive H*', () => {
    assert.throws(() => resolveModelParams({ fStar: 0.5 }), RangeError);
    assert.throws(() => resolveModelParams({ hStar: 0 }), RangeError);
    assert.throws(() => resolveModelParams({ fStar: NaN }), RangeError);
  });

  it('stress test: continuous phonation keeps H <= tau + dt and every f(H) bounded by ~f*', () => {
    const dt = 2048 / 48000;
    const params = resolveModelParams();
    const frames = Array.from({ length: Math.ceil((10 * 300) / dt) }, () => voice(dt));
    const state = run(createVocalLoadState({ params }), frames);
    assert.ok(state.h <= 300 + dt, `H = ${state.h}`);
    for (const [model, value] of Object.entries(fAt(params, state.h))) {
      assert.ok(Number.isFinite(value) && value <= 2 + 1e-3, `${model} f(H) = ${value}`);
    }
  });
});

describe('conventional doses (time and cycle)', () => {
  it('start at zero', () => {
    assert.deepEqual(createVocalLoadState().conventionalDoses, { time: 0, cycle: 0 });
  });

  it('D_t = sum(Phi * dt) and D_c = sum(Phi * F0 * dt), independent of pressure and memory', () => {
    const frames = [voice(0.5, 200, 2), silence(1), voice(0.25, 120, 0), voice(1, 250, 0.1)];
    const state = run(createVocalLoadState({ params: { beta: 0.5 } }), frames);
    close(state.conventionalDoses.time, 1.75);
    close(state.conventionalDoses.cycle, 0.5 * 200 + 0.25 * 120 + 1 * 250);
    close(state.conventionalDoses.time, state.metrics.phonationTime);
  });

  it('rejected frames (Phi = 0) never increase them', () => {
    const frames = [
      { dt: 1, voiced: true, identityMatch: false, qualityOk: true, f0: 150, pressure: 1, category: 'unattributed_voice' },
      { dt: 1, voiced: true, identityMatch: true, qualityOk: false, f0: 150, pressure: 1, category: 'noise' },
      silence(2),
    ];
    assert.deepEqual(run(createVocalLoadState(), frames).conventionalDoses, { time: 0, cycle: 0 });
  });
});
