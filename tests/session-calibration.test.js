import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MODES, createSessionController } from '../src/audio/session-controller.js';
import { frameSizeFor } from '../src/audio/frame-accumulator.js';
import { CalibrationError, pressureFromSpl } from '../src/dsp/acoustic-calibration.js';
import { frameRms } from '../src/dsp/signal-quality.js';
import { CSV_COLUMNS } from '../src/export/csv-exporter.js';
import { harmonic, sine, whiteNoise } from './helpers/signals.js';

const SR = 16000;
const N = frameSizeFor(SR); // 1024 samples: exactly 64 cycles of 1 kHz, so frames join without phase jumps
const voice = harmonic(150, SR, N);
const ambient = whiteNoise(N, 0.0005, 1);
const tone = (amplitude) => sine(1000, SR, N, amplitude);
const framesFor = (seconds) => Math.ceil((seconds * SR) / N);
const relClose = (actual, expected, tol = 2e-3) =>
  assert.ok(Math.abs(actual - expected) <= tol * Math.abs(expected), `expected ~${expected}, got ${actual}`);

function newSession(options) {
  const session = createSessionController({ sampleRate: SR, ...options });
  let sample = 0;
  const send = (samples, count = 1) => {
    for (let i = 0; i < count; i++) {
      session.handleMessage({ type: 'frame', samples, sequence: sample / N, startSample: sample });
      sample += N;
    }
  };
  return { session, send };
}

async function calibrateWithTone({ session, send }, amplitude, options) {
  const done = session.calibrateAcoustic(options);
  assert.equal(session.mode, MODES.ACOUSTIC_CALIBRATING);
  send(tone(amplitude), framesFor(5));
  return done;
}

async function prepare(ctx) {
  const c = ctx.session.calibrate();
  ctx.send(ambient, framesFor(5));
  await c;
  const e = ctx.session.enroll();
  ctx.send(voice, framesFor(15));
  await e;
}

const rowsOf = (session) =>
  session.exportCsv().trimEnd().split('\r\n').slice(1).map((line) => line.split(','));
const col = (row, name) => row[CSV_COLUMNS.indexOf(name)];

describe('acoustic calibration in the session flow', () => {
  it('pre calibration with a 94 dB SPL tone yields C_mic = P_ref / A_digital', async () => {
    const ctx = newSession();
    const cal = await calibrateWithTone(ctx, 0.1);
    assert.equal(ctx.session.mode, MODES.IDLE);
    relClose(cal.coefficient, pressureFromSpl(94) / (0.1 / Math.SQRT2));
    assert.equal(cal.referenceDbSpl, 94);
    assert.equal(ctx.session.acousticCalibration, cal);
  });

  it('accepts another reference level (114 dB SPL)', async () => {
    const cal = await calibrateWithTone(newSession(), 0.1, { referenceDbSpl: 114 });
    relClose(cal.coefficient, pressureFromSpl(114) / (0.1 / Math.SQRT2));
  });

  it('a calibrated session exports pressure in Pa, SPL and the calibration parameters, with P_0 = 1 Pa', async () => {
    const ctx = newSession();
    const cal = await calibrateWithTone(ctx, 0.1);
    await prepare(ctx);
    const load = ctx.session.start();
    assert.equal(load.units, 'calibrated');
    assert.equal(load.referencePressure, 1);
    ctx.send(voice, 3);
    ctx.session.stop();
    const [row] = rowsOf(ctx.session);
    const pressure = Number(col(row, 'pressure_pa'));
    relClose(pressure, cal.coefficient * frameRms(voice), 0.05);
    relClose(Number(col(row, 'spl_db')), 20 * Math.log10(pressure / 20e-6), 1e-6);
    assert.match(col(row, 'parameters'), /referencePressure=1;/);
    assert.match(col(row, 'parameters'), /;calRefDbSpl=94;calCoefficient=[\d.]+$/);
  });

  it('without calibration, pressure_pa and spl_db stay empty and units stay relative', async () => {
    const ctx = newSession();
    await prepare(ctx);
    assert.equal(ctx.session.start().units, 'relative');
    ctx.send(voice, 2);
    ctx.session.stop();
    for (const row of rowsOf(ctx.session)) {
      assert.deepEqual([col(row, 'pressure_pa'), col(row, 'spl_db')], ['', '']);
      assert.doesNotMatch(col(row, 'parameters'), /calCoefficient/);
    }
  });

  it('post check reports the drift and rewrites the parameters of every exported row', async () => {
    const ctx = newSession();
    await calibrateWithTone(ctx, 0.1);
    await prepare(ctx);
    ctx.session.start();
    ctx.send(voice, 3);
    ctx.session.stop();

    await calibrateWithTone(ctx, 0.1 * 1.2, { phase: 'post' }); // mic now 1.58 dB more sensitive
    const drift = ctx.session.calibrationDrift;
    relClose(drift.db, -20 * Math.log10(1.2));
    assert.equal(drift.withinTolerance, false);
    const rows = rowsOf(ctx.session);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.length, CSV_COLUMNS.length);
      assert.match(col(row, 'parameters'), /;calRefDbSpl=94;calCoefficient=[\d.]+;calPostCoefficient=[\d.]+;calDriftPct=-[\d.]+;calDriftDb=-1\.58\d*;calWithinTolerance=0$/);
    }
    assert.equal(ctx.session.acousticCalibration.coefficient, ctx.session.sessionCalibration.coefficient, 'post does not replace the pre calibration');
  });

  it('post check needs a calibrated, measured session', async () => {
    const ctx = newSession();
    await assert.rejects(ctx.session.calibrateAcoustic({ phase: 'post' }), /calibrated session/);
    assert.equal(ctx.session.mode, MODES.IDLE);
  });

  it('a clipping tone is rejected with a typed reason and keeps the previous calibration', async () => {
    const ctx = newSession();
    const good = await calibrateWithTone(ctx, 0.1);
    await assert.rejects(calibrateWithTone(ctx, 1.2), (e) => e instanceof CalibrationError && e.reason === 'clipping');
    assert.equal(ctx.session.mode, MODES.IDLE);
    assert.equal(ctx.session.acousticCalibration, good);
  });

  it('a calibrated session with distance-dose options exports d_d and records them', async () => {
    const ctx = newSession();
    await calibrateWithTone(ctx, 0.1);
    await prepare(ctx);
    ctx.session.setDistanceDoseOptions({ profile: 'male', mouthDistanceM: 0.05 });
    const load = ctx.session.start();
    assert.equal(load.distanceDose, 0);
    ctx.send(voice, 3);
    ctx.session.stop();
    const rows = rowsOf(ctx.session);
    const doses = rows.map((r) => Number(col(r, 'd_d')));
    assert.ok(doses[0] > 0 && doses[1] > doses[0] && doses[2] > doses[1], JSON.stringify(doses));
    assert.equal(doses[2], Number(ctx.session.load.distanceDose.toPrecision(10)));
    assert.match(col(rows[0], 'parameters'), /;ddProfile=male;ddOffsetDb=20;ddOffsetSource=inverse_distance;ddMouthDistanceM=0\.05;/);
  });

  it('distance-dose options: validated when set, cleared with null, and refused without calibration', async () => {
    const ctx = newSession();
    assert.throws(() => ctx.session.setDistanceDoseOptions({ profile: 'child', mouthDistanceM: 0.05 }), RangeError);
    await prepare(ctx);
    ctx.session.setDistanceDoseOptions({ profile: 'female', spl50cmOffsetDb: 18 });
    assert.deepEqual(ctx.session.distanceDoseOptions, { profile: 'female', offsetDb: 18, offsetSource: 'measured' });
    assert.throws(() => ctx.session.start(), (e) => /calibrat/.test(e.message) && e.code === 'distance_dose_needs_calibration');
    assert.equal(ctx.session.mode, MODES.IDLE);
    ctx.session.setDistanceDoseOptions(null);
    assert.equal(ctx.session.start().distanceDose, null);
  });

  it('rejects an unknown phase', async () => {
    await assert.rejects(newSession().session.calibrateAcoustic({ phase: 'mid' }), /phase/);
  });
});
