// Standardised own-voice reference (spec §10.1): a reading of the standard text in the
// habitual voice, separate from the enrolment, gives A_0,i = median RMS of the accepted
// phonation, with its P10 and P90 kept to judge how steady the reference was.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MODES, createSessionController } from '../src/audio/session-controller.js';
import { frameSizeFor } from '../src/audio/frame-accumulator.js';
import { frameRms, toDb } from '../src/dsp/signal-quality.js';
import { harmonic, sine, whiteNoise } from './helpers/signals.js';

const SR = 16000;
const N = frameSizeFor(SR);
const voice = harmonic(150, SR, N);
const ambient = whiteNoise(N, 0.0005, 1);
const scaled = (signal, gain) => signal.map((v) => v * gain);
const framesFor = (seconds) => Math.ceil((seconds * SR) / N);
const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected}`);

async function enrolled(options) {
  const session = createSessionController({ sampleRate: SR, ...options });
  let sample = 0;
  const send = (samples, count = 1) => {
    for (let i = 0; i < count; i++) {
      session.handleMessage({ type: 'frame', samples, sequence: sample / N, startSample: sample });
      sample += N;
    }
  };
  const c = session.calibrate();
  send(ambient, framesFor(5));
  await c;
  const e = session.enroll();
  send(voice, framesFor(15));
  await e;
  return { session, send };
}

describe('standardised own-voice reference', () => {
  it('the enrolment alone no longer sets the reference, and an uncalibrated start needs it', async () => {
    const { session } = await enrolled();
    assert.equal(session.voiceReference, null);
    assert.throws(() => session.start(), (e) => e.code === 'voice_reference_required');
    assert.equal(session.mode, MODES.IDLE);
  });

  it('needs a profile first', async () => {
    const session = createSessionController({ sampleRate: SR });
    await assert.rejects(session.captureVoiceReference(), /enrol/);
  });

  it('A_0 is the median RMS of the accepted phonation, with P10 and P90', async () => {
    const { session, send } = await enrolled();
    const done = session.captureVoiceReference({ textId: 'viento-norte-sol-v1' });
    assert.equal(session.mode, MODES.REFERENCING);
    // 30 s of reading: pauses, then the same voice at two levels 6 dB apart.
    send(ambient, framesFor(4));
    send(scaled(voice, 0.5), framesFor(10));
    send(voice, framesFor(16));
    const ref = await done;
    assert.equal(session.mode, MODES.IDLE);
    assert.equal(session.voiceReference, ref);
    assert.equal(ref.method, 'connected_speech');
    assert.equal(ref.textId, 'viento-norte-sol-v1');
    const loud = toDb(frameRms(voice));
    const soft = toDb(frameRms(scaled(voice, 0.5)));
    near(ref.p50Dbfs, loud, 0.5, 'P50 = the level most of the reading had');
    near(ref.p10Dbfs, soft, 0.5, 'P10 = the softer part');
    near(ref.p90Dbfs, loud, 0.5, 'P90');
    assert.equal(ref.levelDbfs, ref.p50Dbfs);
    near(toDb(ref.rms), ref.p50Dbfs, 1e-9, 'rms is A_0');
    near(ref.durationS, 30, 0.1, 'duration of the take');
    assert.ok(ref.validS > 20 && ref.validS <= 26, `accepted phonation ${ref.validS} s`);
  });

  it('normalises the session to the reference and carries it in the load and the CSV parameters', async () => {
    const { session, send } = await enrolled();
    const done = session.captureVoiceReference({ textId: 'viento-norte-sol-v1' });
    send(voice, framesFor(30));
    const ref = await done;
    const load = session.start();
    assert.equal(load.units, 'normalized');
    assert.equal(load.ownVoiceReferenceDbfs, ref.levelDbfs);
    assert.deepEqual(load.ownVoiceReference, {
      method: 'connected_speech', textId: 'viento-norte-sol-v1',
      p10Dbfs: ref.p10Dbfs, p50Dbfs: ref.p50Dbfs, p90Dbfs: ref.p90Dbfs, durationS: ref.durationS, validS: ref.validS,
    });
    send(voice, framesFor(10));
    session.stop();
    const meanIntensity = session.load.doses.none / session.load.conventionalDoses.cycle;
    near(meanIntensity, 1, 0.05, 'I = 1 at the reference voice');
    const params = session.exportCsv().split('\r\n')[1];
    assert.match(params, /ownVoiceRefMethod=connected_speech/);
    assert.match(params, /ownVoiceRefP10Dbfs=-\d/);
    assert.match(params, /ownVoiceRefP90Dbfs=-\d/);
  });

  it('rejects a take with too little accepted phonation and keeps no reference', async () => {
    const { session, send } = await enrolled();
    const done = session.captureVoiceReference();
    send(voice, framesFor(5));
    send(ambient, framesFor(25));
    await assert.rejects(done, (e) => e.code === 'reference_too_short');
    assert.equal(session.voiceReference, null);
    assert.equal(session.mode, MODES.IDLE);
  });

  it('a new enrolment or ambient calibration drops the reference', async () => {
    const { session, send } = await enrolled();
    let done = session.captureVoiceReference();
    send(voice, framesFor(30));
    await done;
    const e = session.enroll();
    send(voice, framesFor(15));
    await e;
    assert.equal(session.voiceReference, null, 'a new profile needs a new reference');
    done = session.captureVoiceReference();
    send(voice, framesFor(30));
    await done;
    const c = session.calibrate();
    send(ambient, framesFor(5));
    await c;
    assert.equal(session.voiceReference, null);
  });

  it('a calibrated session does not need the reference', async () => {
    const { session, send } = await enrolled();
    const cal = session.calibrateAcoustic();
    send(sine(1000, SR, N, 0.1), framesFor(5));
    await cal;
    assert.equal(session.start().units, 'calibrated');
  });
});

describe('capture settings of the microphone', () => {
  it('records the browser processing state in the load and the CSV parameters', async () => {
    const { session, send } = await enrolled();
    session.setCaptureSettings({ autoGainControl: false, noiseSuppression: true, echoCancellation: undefined, sampleRate: 48000 });
    const done = session.captureVoiceReference();
    send(voice, framesFor(30));
    await done;
    const load = session.start();
    assert.deepEqual(load.capture, { autoGainControl: false, noiseSuppression: true, echoCancellation: null });
    send(voice, 2);
    session.stop();
    const params = session.exportCsv().split('\r\n')[1];
    assert.match(params, /agc=off/);
    assert.match(params, /noiseSuppression=on/);
    assert.match(params, /echoCancellation=unknown/);
  });

  it('defaults to unknown when the browser reports nothing', async () => {
    const { session, send } = await enrolled();
    const done = session.captureVoiceReference();
    send(voice, framesFor(30));
    await done;
    assert.deepEqual(session.start().capture, { autoGainControl: null, noiseSuppression: null, echoCancellation: null });
  });
});
