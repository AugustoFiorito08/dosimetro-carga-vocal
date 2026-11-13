import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CalibrationError,
  DEFAULT_CALIBRATION_CONFIG,
  REFERENCE_PRESSURE_PA,
  calibrationDrift,
  computeCalibration,
  pressureFromSpl,
  splFromPressure,
} from '../src/dsp/acoustic-calibration.js';

const close = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), `expected ${expected}, got ${actual}`);

const frames = (rmsValues, { dt = 0.1, peak = 0.5 } = {}) => rmsValues.map((rms) => ({ rms, peak, dt }));
const steady = (rms, seconds, opts) => frames(Array.from({ length: Math.round(seconds / 0.1) }, () => rms), opts);

describe('SPL <-> pressure', () => {
  it('uses 20 µPa as reference: 94 dB SPL ~ 1 Pa, 114 dB ~ 10 Pa', () => {
    assert.equal(REFERENCE_PRESSURE_PA, 20e-6);
    close(pressureFromSpl(94), 20e-6 * 10 ** (94 / 20));
    close(pressureFromSpl(114) / pressureFromSpl(94), 10);
    close(splFromPressure(pressureFromSpl(87.3)), 87.3);
  });
});

describe('computeCalibration (protocol §10.1: P_RMS = C_mic * A_digital)', () => {
  it('C_mic = P_ref / A_digital for a steady tone of known level', () => {
    const cal = computeCalibration(steady(0.1, 5), { referenceDbSpl: 94 });
    close(cal.aDigital, 0.1);
    close(cal.coefficient, pressureFromSpl(94) / 0.1);
    close(cal.referencePa, pressureFromSpl(94));
    assert.equal(cal.referenceDbSpl, 94);
    close(cal.duration, 5);
    close(cal.levelStdDb, 0);
  });

  it('A_digital is the energy mean of the frame RMS weighted by duration', () => {
    const input = [{ rms: 0.1, peak: 0.5, dt: 3 }, { rms: 0.102, peak: 0.5, dt: 1 }];
    const cal = computeCalibration(input, { referenceDbSpl: 114 });
    close(cal.aDigital, Math.sqrt((0.1 ** 2 * 3 + 0.102 ** 2 * 1) / 4));
    close(cal.coefficient, pressureFromSpl(114) / cal.aDigital);
  });

  it('defaults to 94 dB SPL', () => {
    assert.equal(DEFAULT_CALIBRATION_CONFIG.referenceDbSpl, 94);
    assert.equal(computeCalibration(steady(0.2, 5)).referenceDbSpl, 94);
  });

  const rejects = (input, reason, config) =>
    assert.throws(() => computeCalibration(input, config), (e) => e instanceof CalibrationError && e.reason === reason);

  it('rejects clipping, unstable, too short and silent captures with a typed reason', () => {
    rejects(steady(0.1, 5, { peak: 1 }), 'clipping');
    rejects(frames(Array.from({ length: 50 }, (_, i) => (i % 2 ? 0.1 : 0.2))), 'unstable');
    rejects(steady(0.1, 1), 'too_short');
    rejects(steady(0, 5), 'silent');
    rejects([], 'too_short');
  });

  it('validates the reference level', () => {
    assert.throws(() => computeCalibration(steady(0.1, 5), { referenceDbSpl: NaN }), RangeError);
  });
});

describe('calibrationDrift (protocol §10.1: δC = 100 (C_post - C_pre) / C_pre)', () => {
  it('reports drift in % and dB and checks the tolerance', () => {
    const d = calibrationDrift({ coefficient: 10 }, { coefficient: 10.5 });
    close(d.percent, 5);
    close(d.db, 20 * Math.log10(1.05));
    assert.equal(d.toleranceDb, 0.5);
    assert.equal(d.withinTolerance, true);
    assert.equal(calibrationDrift({ coefficient: 10 }, { coefficient: 11 }).withinTolerance, false);
    assert.equal(calibrationDrift({ coefficient: 10 }, { coefficient: 9.5 }, { toleranceDb: 1 }).withinTolerance, true);
  });
});
