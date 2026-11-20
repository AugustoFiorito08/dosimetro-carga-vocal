import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORE_SCALE,
  createIdentityState,
  enrollProfile,
  ownAcceptance,
  speakerDistance,
  speakerScore,
  updateIdentity,
} from '../src/dsp/speaker-profile.js';
import { prng } from './helpers/signals.js';

const DIM = 13;
const unit = (i) => Float64Array.from({ length: DIM }, (_, d) => (d === i ? 1 : 0));
const A = Float64Array.from({ length: DIM }, (_, d) => (d < 6 ? 1 + d * 0.1 : 0));
const B = Float64Array.from({ length: DIM }, (_, d) => (d >= 6 ? 1 : 0)); // orthogonal to A
const jitter = (v, amount, rand) => Float64Array.from(v, (x) => x + amount * (2 * rand() - 1));

describe('enrolment', () => {
  const rand = prng(7);
  const enrolment = Array.from({ length: 600 }, () => jitter(A, 0.05, rand)); // 600 x 20 ms = 12 s

  it('scores a new vector of the same speaker high and a distant one near zero', () => {
    const profile = enrollProfile(enrolment, { frameDuration: 0.02 });
    assert.ok(speakerScore(profile, jitter(A, 0.05, prng(99))) > 0.5); // same distribution: delta ~ 1
    assert.ok(speakerScore(profile, B) < 0.01);
  });

  it('score is exp(-distance / (SCORE_SCALE * referenceDistance)), 1 at a cluster centre', () => {
    const profile = enrollProfile(enrolment);
    const v = jitter(A, 0.05, prng(5));
    const expected = Math.exp(-speakerDistance(profile, v) / (SCORE_SCALE * profile.referenceDistance));
    assert.ok(Math.abs(speakerScore(profile, v) - expected) < 1e-12);
    const centre = Float64Array.from(profile.prototypes[0], (z, j) => profile.mean[j] + z * profile.scale[j]);
    assert.ok(Math.abs(speakerScore(profile, centre) - 1) < 1e-12);
    const farther = Float64Array.from(A, (x, j) => x + 0.2 * (j < 6 ? 1 : 0));
    const farthest = Float64Array.from(A, (x, j) => x + 0.5 * (j < 6 ? 1 : 0));
    assert.ok(speakerScore(profile, farther) > speakerScore(profile, farthest));
  });

  it('is not fooled by a scaled copy of the enrolled envelope (cosine would score it 1)', () => {
    const profile = enrollProfile(enrolment);
    assert.ok(speakerScore(profile, A.map((v) => 1.5 * v)) < 0.1);
  });

  it('keeps at most 8 prototypes and drops empty clusters', () => {
    const profile = enrollProfile(enrolment);
    assert.ok(profile.prototypes.length >= 1 && profile.prototypes.length <= 8);
    assert.equal(profile.counts.reduce((a, b) => a + b, 0), 600);
    assert.ok(profile.counts.every((n) => n > 0));
    assert.equal(profile.dimension, DIM);
    assert.equal(profile.variances.length, profile.prototypes.length);
  });

  it('identical frames collapse into a single prototype', () => {
    const profile = enrollProfile(Array.from({ length: 50 }, () => A));
    assert.equal(profile.prototypes.length, 1);
    assert.deepEqual(profile.counts, [50]);
  });

  it('separates distinct phonetic clusters into different prototypes', () => {
    const r = prng(3);
    const vectors = [];
    for (let c = 0; c < 10; c++) for (let i = 0; i < 20; i++) vectors.push(jitter(unit(c), 0.02, r));
    const profile = enrollProfile(vectors);
    assert.equal(profile.prototypes.length, 8);
    for (let c = 0; c < 10; c++) assert.ok(speakerScore(profile, unit(c)) > 0.5, `cluster ${c}`);
  });

  it('is deterministic', () => {
    assert.deepEqual(enrollProfile(enrolment), enrollProfile(enrolment));
  });

  it('enforces the minimum enrolment duration when frameDuration is known', () => {
    assert.throws(() => enrollProfile(enrolment.slice(0, 100), { frameDuration: 0.02 }), /10 s/);
    assert.doesNotThrow(() => enrollProfile(enrolment.slice(0, 500), { frameDuration: 0.02 }));
  });

  it('rejects empty, non-finite or ragged inputs', () => {
    assert.throws(() => enrollProfile([]), RangeError);
    assert.throws(() => enrollProfile([A, [1, NaN, 0]]), RangeError);
    assert.throws(() => enrollProfile([A, [1, 2]]), RangeError);
    assert.throws(() => enrollProfile([A], { maxPrototypes: 0 }), RangeError);
  });

  it('speakerScore rejects vectors of another dimension', () => {
    assert.throws(() => speakerScore(enrollProfile([A]), [1, 2, 3]), RangeError);
  });
});

describe('identity smoothing W_k', () => {
  const profile = enrollProfile([A]);
  const scoreA = speakerScore(profile, A);
  const scoreB = speakerScore(profile, B);
  const feed = (scores, state = createIdentityState()) =>
    scores.reduce((acc, s) => {
      const next = updateIdentity(acc.state, s, 0.02);
      return { state: next, history: [...acc.history, next.W] };
    }, { state, history: [] });

  it('accepts the enrolled vector A (W = 1) and rejects orthogonal B (W = 0)', () => {
    assert.equal(feed([scoreA]).state.W, 1);
    assert.equal(feed([scoreB]).state.W, 0);
  });

  it('a single spurious frame does not flip an accepted decision', () => {
    const { history } = feed([scoreA, scoreA, scoreA, scoreB, scoreA, scoreA]);
    assert.deepEqual(history, [1, 1, 1, 1, 1, 1]);
  });

  it('a single spurious match does not flip a rejected decision', () => {
    const { history } = feed([scoreB, scoreB, scoreB, scoreA, scoreB]);
    assert.deepEqual(history, [0, 0, 0, 0, 0]);
  });

  it('a sustained change of speaker eventually flips the decision', () => {
    const { history } = feed([scoreA, scoreA, ...Array(40).fill(scoreB)]);
    assert.equal(history.at(-1), 0);
    assert.equal(history[0], 1);
  });

  it('hysteresis: score between thresholds keeps the previous decision', () => {
    assert.equal(feed([0.62]).state.W, 0);
    assert.equal(feed([0.9, 0.62, 0.62, 0.62]).state.W, 1);
  });

  it('holds the decision through short gaps and resets after long ones', () => {
    let s = feed([scoreA]).state;
    s = updateIdentity(s, null, 0.5);
    assert.equal(s.W, 1);
    s = updateIdentity(s, null, 0.6);
    assert.deepEqual(s, createIdentityState());
  });

  it('rejects inverted thresholds', () => {
    assert.throws(() => updateIdentity(createIdentityState(), 0.9, 0.02, { acceptThreshold: 0.5, rejectThreshold: 0.8 }), RangeError);
  });
});

describe('per-speaker calibration', () => {
  const rand = prng(11);
  const tight = Array.from({ length: 300 }, () => jitter(A, 0.02, rand));
  const loose = Array.from({ length: 300 }, () => jitter(A, 0.2, rand));

  it('referenceDistance is the median held-out distance, so a typical own frame scores about 0.8', () => {
    for (const vectors of [tight, loose]) {
      const profile = enrollProfile(vectors);
      assert.equal(profile.heldOutDistances.length, 5);
      const all = profile.heldOutDistances.flatMap((f) => Array.from(f)).sort((a, b) => a - b);
      assert.ok(Math.abs(profile.referenceDistance - Math.max(0.25, all[Math.floor(all.length / 2)])) < 1e-12);
    }
  });

  it('a more variable speaker gets a proportionally wider acceptance region', () => {
    const t = enrollProfile(tight);
    const l = enrollProfile(loose);
    const sTight = speakerScore(t, jitter(A, 0.02, prng(1)));
    const sLoose = speakerScore(l, jitter(A, 0.2, prng(1)));
    assert.ok(Math.abs(sTight - sLoose) < 0.15, `${sTight} vs ${sLoose}`);
  });

  it('without enough frames to cross-validate, referenceDistance is 1 and ownAcceptance is null', () => {
    const profile = enrollProfile([A, A, A]);
    assert.equal(profile.referenceDistance, 1);
    assert.equal(ownAcceptance(profile), null);
  });
});
