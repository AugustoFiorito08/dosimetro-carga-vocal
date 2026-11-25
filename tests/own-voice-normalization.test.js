// Intensity normalised to the speaker's own normal voice (spec §10.1): without an acoustic
// calibration, I_k = (P_k / P_ref)^2 with P_ref the level of the standardised reference
// reading in the habitual voice, so I = 1 at that voice and the doses do not depend on the phone's sensitivity.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { frameSizeFor } from '../src/audio/frame-accumulator.js';
import { createSessionController } from '../src/audio/session-controller.js';
import { frameRms, toDb } from '../src/dsp/signal-quality.js';
import { harmonic, whiteNoise } from './helpers/signals.js';

const SR = 16000;
const N = frameSizeFor(SR);
const scaled = (signal, gain) => signal.map((v) => v * gain);
const voice = harmonic(150, SR, N);
const ambient = whiteNoise(N, 0.0005, 1);
const framesFor = (seconds) => Math.ceil((seconds * SR) / N);

/** A phone with input `gain`: everything it hears is scaled by it. */
async function measured(gain, { louder = 1, seconds = 20 } = {}) {
  const session = createSessionController({ sampleRate: SR });
  let sample = 0;
  const send = (samples, count) => {
    for (let i = 0; i < count; i++) {
      session.handleMessage({ type: 'frame', samples, sequence: sample / N, startSample: sample });
      sample += N;
    }
  };
  const c = session.calibrate();
  send(scaled(ambient, gain), framesFor(5));
  await c;
  const e = session.enroll();
  send(scaled(voice, gain), framesFor(15));
  await e;
  const r = session.captureVoiceReference(); // standard text in the habitual voice
  send(scaled(voice, gain), framesFor(30));
  await r;
  session.start();
  send(scaled(voice, gain * louder), framesFor(seconds));
  session.stop();
  return session;
}

const intensity = (load) => load.doses.none / load.conventionalDoses.cycle; // D_0 / D_c = mean I while phonating

describe('own-voice normalisation of the intensity', () => {
  it('takes the reference from the reading in the habitual voice and labels the units', async () => {
    const session = await measured(0.1);
    assert.equal(session.load.units, 'normalized');
    const expected = toDb(frameRms(scaled(voice, 0.1)));
    assert.ok(Math.abs(session.voiceReference.levelDbfs - expected) < 0.5, `${session.voiceReference.levelDbfs} vs ${expected}`);
    assert.equal(session.load.ownVoiceReferenceDbfs, session.voiceReference.levelDbfs);
  });

  it('I = 1 at the habitual voice and about 4 at +6 dB', async () => {
    const normal = await measured(0.1);
    assert.ok(normal.load.conventionalDoses.cycle > 0, 'the voice is attributed');
    assert.ok(Math.abs(intensity(normal.load) - 1) < 0.05, `I = ${intensity(normal.load)}`);
    const raised = await measured(0.1, { louder: 2 });
    assert.ok(Math.abs(intensity(raised.load) - 4) < 0.2, `I = ${intensity(raised.load)}`);
  });

  it('gives the same doses on a phone 12 dB more sensitive', async () => {
    const a = await measured(0.1, { louder: 2 });
    const b = await measured(0.4, { louder: 2 });
    for (const model of ['none', 'linear', 'power', 'exponential', 'saturating']) {
      const [da, db] = [a.load.doses[model], b.load.doses[model]];
      assert.ok(Math.abs(da - db) / da < 0.02, `${model}: ${da} vs ${db}`);
    }
    assert.equal(a.load.h, b.load.h, 'H depends only on phonation');
  });

  it('records the method and the reference level in the CSV parameters', async () => {
    const session = await measured(0.1, { seconds: 1 });
    const params = session.exportCsv().split('\r\n')[1];
    assert.match(params, /units=normalized/);
    assert.match(params, /ownVoiceRefDbfs=-\d+(\.\d+)?/);
  });

  it('a new ambient calibration drops the reference with the profile', async () => {
    const session = await measured(0.1, { seconds: 1 });
    const c = session.calibrate();
    for (let i = 0; i < framesFor(5); i++) session.handleMessage({ type: 'frame', samples: ambient, sequence: 10000 + i });
    await c;
    assert.equal(session.voiceReference, null);
  });
});
