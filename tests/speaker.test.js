import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cosineSimilarity,
  createIdentityState,
  enrollProfile,
  speakerScore,
  updateIdentity,
} from '../src/dsp/speaker-profile.js';
import { prng } from './helpers/signals.js';

const DIM = 13;
const unit = (i) => Float64Array.from({ length: DIM }, (_, d) => (d === i ? 1 : 0));
const A = Float64Array.from({ length: DIM }, (_, d) => (d < 6 ? 1 + d * 0.1 : 0));
const B = Float64Array.from({ length: DIM }, (_, d) => (d >= 6 ? 1 : 0)); // orthogonal to A
const jitter = (v, amount, rand) => Float64Array.from(v, (x) => x + amount * (2 * rand() - 1));

describe('cosine similarity', () => {
  it('is 1 for parallel, 0 for orthogonal, -1 for opposite vectors', () => {
    assert.ok(Math.abs(cosineSimilarity(A, A.map((v) => 3 * v)) - 1) < 1e-12);
    assert.equal(cosineSimilarity(A, B), 0);
    assert.ok(Math.abs(cosineSimilarity(A, A.map((v) => -v)) + 1) < 1e-12);
  });

  it('returns 0 for zero vectors and rejects dimension mismatch', () => {
    assert.equal(cosineSimilarity(new Float64Array(DIM), A), 0);
    assert.throws(() => cosineSimilarity(A, [1, 2]), RangeError);
  });
});

describe('enrolment', () => {
  const rand = prng(7);
  const enrolment = Array.from({ length: 600 }, () => jitter(A, 0.05, rand)); // 600 x 20 ms = 12 s

  it('matches a vector similar to A and rejects orthogonal B', () => {
    const profile = enrollProfile(enrolment, { frameDuration: 0.02 });
    assert.ok(speakerScore(profile, jitter(A, 0.05, prng(99))) > 0.95);
    assert.ok(Math.abs(speakerScore(profile, B)) < 0.1);
  });

  it('keeps at most 8 prototypes and drops empty clusters', () => {
    const profile = enrollProfile(enrolment);
    assert.ok(profile.prototypes.length >= 1 && profile.prototypes.length <= 8);
    assert.equal(profile.counts.reduce((a, b) => a + b, 0), 600);
    assert.ok(profile.counts.every((n) => n > 0));
    assert.equal(profile.dimension, DIM);
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
    for (let c = 0; c < 10; c++) assert.ok(speakerScore(profile, unit(c)) > 0.6, `cluster ${c}`);
  });

  it('is deterministic', () => {
    assert.deepEqual(enrollProfile(enrolment), enrollProfile(enrolment));
  });

  it('enforces the minimum enrolment duration when frameDuration is known', () => {
    assert.throws(() => enrollProfile(enrolment.slice(0, 100), { frameDuration: 0.02 }), /10 s/);
    assert.doesNotThrow(() => enrollProfile(enrolment.slice(0, 500), { frameDuration: 0.02 }));
  });

  it('rejects empty, zero-only, non-finite or ragged inputs', () => {
    assert.throws(() => enrollProfile([]), RangeError);
    assert.throws(() => enrollProfile([new Float64Array(DIM)]), RangeError);
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
    const { history } = feed([scoreA, scoreA, ...Array(6).fill(scoreB)]);
    assert.equal(history.at(-1), 0);
    assert.equal(history[0], 1);
  });

  it('hysteresis: score between thresholds keeps the previous decision', () => {
    assert.equal(feed([0.8]).state.W, 0);
    assert.equal(feed([0.9, 0.8, 0.8, 0.8]).state.W, 1);
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
