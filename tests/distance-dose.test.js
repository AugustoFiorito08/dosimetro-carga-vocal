import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VOCAL_FOLD_PROFILES,
  distanceDoseIncrement,
  inverseDistanceOffsetDb,
  lungPressure,
  phonationThresholdPressure,
  resolveDistanceDoseOptions,
  vibrationAmplitude,
} from '../src/math/distance-dose.js';
import { createVocalLoadState, stepVocalLoad } from '../src/vocal-load.js';

const close = (actual, expected, tol = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), `expected ${expected}, got ${actual}`);
const spl = (pa) => 20 * Math.log10(pa / 20e-6);

describe('Titze, Švec & Popolo (2003) empirical rules', () => {
  it('profiles: L0 = 16 / 10 mm and F0N = 120 / 190 Hz (eqs. 14-15)', () => {
    assert.deepEqual(VOCAL_FOLD_PROFILES.male, { l0: 0.016, f0n: 120 });
    assert.deepEqual(VOCAL_FOLD_PROFILES.female, { l0: 0.01, f0n: 190 });
  });

  it('eq. 15: P_th = 0.14 + 0.06 (F0/F0N)^2 kPa', () => {
    close(phonationThresholdPressure(120, 'male'), 0.2);
    close(phonationThresholdPressure(190, 'female'), 0.2);
    close(phonationThresholdPressure(240, 'male'), 0.14 + 0.06 * 4);
  });

  it('eq. 16: P_L = P_th + 10^((SPL - 78.5)/27.3) kPa, SPL at 0.5 m', () => {
    close(lungPressure(120, 78.5, 'male'), 0.2 + 1);
    close(lungPressure(150, 70, 'female'), phonationThresholdPressure(150, 'female') + 10 ** ((70 - 78.5) / 27.3));
  });

  it('eq. 14: A = 0.05 L0 [(P_L - P_th)/P_th]^(1/2) m', () => {
    close(vibrationAmplitude(120, 78.5, 'male'), 0.05 * 0.016 * Math.sqrt(1 / 0.2));
    const f0 = 210;
    const pth = 0.14 + 0.06 * (f0 / 190) ** 2;
    close(vibrationAmplitude(f0, 72, 'female'), 0.05 * 0.01 * Math.sqrt(10 ** ((72 - 78.5) / 27.3) / pth));
  });

  it('gives the 1-2 mm order of amplitude the paper reports for speech', () => {
    const a = vibrationAmplitude(120, 75, 'male');
    assert.ok(a > 0.0005 && a < 0.003, `A = ${a} m`);
  });

  it('eq. 22: increment 4 * k_v * A * F0 * dt, 0 without accepted phonation', () => {
    const options = resolveDistanceDoseOptions({ profile: 'male', spl50cmOffsetDb: 20 });
    const a = vibrationAmplitude(130, 70, 'male');
    close(distanceDoseIncrement({ f0: 130, splMic: 90, phi: 1, dt: 0.5 }, options), 4 * a * 130 * 0.5);
    assert.equal(distanceDoseIncrement({ f0: 130, splMic: 90, phi: 0, dt: 0.5 }, options), 0);
    assert.equal(distanceDoseIncrement({ f0: 130, splMic: -Infinity, phi: 1, dt: 0.5 }, options), 0);
  });
});

describe('SPL reference at 0.5 m', () => {
  it('inverse-distance approximation: offset = 20 log10(0.5 / r)', () => {
    close(inverseDistanceOffsetDb(0.05), 20);
    close(inverseDistanceOffsetDb(0.5), 0);
    assert.throws(() => inverseDistanceOffsetDb(0), RangeError);
  });

  it('resolves a measured offset or a mouth-microphone distance, never both', () => {
    assert.deepEqual(resolveDistanceDoseOptions({ profile: 'female', spl50cmOffsetDb: 18.4 }), {
      profile: 'female', offsetDb: 18.4, offsetSource: 'measured',
    });
    const byDistance = resolveDistanceDoseOptions({ profile: 'male', mouthDistanceM: 0.05 });
    assert.equal(byDistance.offsetSource, 'inverse_distance');
    assert.equal(byDistance.mouthDistanceM, 0.05);
    close(byDistance.offsetDb, 20);
    assert.throws(() => resolveDistanceDoseOptions({ profile: 'male' }), RangeError);
    assert.throws(() => resolveDistanceDoseOptions({ profile: 'male', spl50cmOffsetDb: 20, mouthDistanceM: 0.05 }), RangeError);
    assert.throws(() => resolveDistanceDoseOptions({ profile: 'child', spl50cmOffsetDb: 20 }), RangeError);
    assert.throws(() => resolveDistanceDoseOptions({ profile: 'male', spl50cmOffsetDb: NaN }), RangeError);
  });
});

describe('distance dose in the vocal-load engine', () => {
  const voiced = (dt, f0, pressure) => ({ dt, voiced: true, identityMatch: true, qualityOk: true, f0, pressure });
  const silent = (dt) => ({ dt, voiced: false, identityMatch: false, qualityOk: true, category: 'silence' });

  it('is null unless requested', () => {
    assert.equal(createVocalLoadState({ calibrated: true }).distanceDose, null);
  });

  it('accumulates 4 * A(F0, SPL_0.5m) * F0 * dt over accepted phonation (calibrated pressure in Pa)', () => {
    const distanceDose = { profile: 'female', spl50cmOffsetDb: 20 };
    const frames = [voiced(0.5, 200, 0.6), silent(1), voiced(0.25, 230, 1.1)];
    const state = frames.reduce(stepVocalLoad, createVocalLoadState({ calibrated: true, distanceDose }));
    const expected =
      4 * vibrationAmplitude(200, spl(0.6) - 20, 'female') * 200 * 0.5 +
      4 * vibrationAmplitude(230, spl(1.1) - 20, 'female') * 230 * 0.25;
    close(state.distanceDose, expected, 1e-9);
    assert.deepEqual(state.distanceDoseOptions, { profile: 'female', offsetDb: 20, offsetSource: 'measured' });
  });

  it('refuses a distance dose on an uncalibrated session', () => {
    assert.throws(() => createVocalLoadState({ distanceDose: { profile: 'male', spl50cmOffsetDb: 20 } }), /calibrat/);
  });
});
