import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { estimatePitch } from '../src/dsp/pitch.js';
import { FEATURE_DIMENSION, extractSpectralFeatures, fft } from '../src/dsp/spectral.js';
import {
  assessQuality,
  calibrateNoiseFloor,
  crestFactor,
  frameRms,
  snrDb,
  updateNoiseFloor,
} from '../src/dsp/signal-quality.js';
import { enrollProfile } from '../src/dsp/speaker-profile.js';
import {
  CATEGORIES,
  classifyFrame,
  createFrameClassifier,
  decideCategory,
} from '../src/dsp/frame-classifier.js';
import { createVocalLoadState, stepVocalLoad } from '../src/vocal-load.js';
import { add, harmonic, impulse, silence, sine, whiteNoise } from './helpers/signals.js';

const SR = 16000;
const N = 1024;
const relativeError = (actual, expected) => Math.abs(actual - expected) / expected;

describe('pitch (YIN)', () => {
  for (const f of [150, 220]) {
    it(`detects a ${f} Hz sine with < 5 % error and high periodicity`, () => {
      const { f0, periodicity, isPeriodic } = estimatePitch(sine(f, SR, N), SR);
      assert.ok(isPeriodic);
      assert.ok(relativeError(f0, f) < 0.05, `f0=${f0}`);
      assert.ok(periodicity > 0.9, `periodicity=${periodicity}`);
    });
  }

  it('works at 48 kHz across the vocal range limits', () => {
    for (const f of [75, 120, 300, 480]) {
      const { f0 } = estimatePitch(sine(f, 48000, 2048), 48000);
      assert.ok(relativeError(f0, f) < 0.05, `${f} Hz -> ${f0}`);
    }
  });

  it('finds the fundamental of a harmonic-rich signal', () => {
    const { f0 } = estimatePitch(harmonic(130, SR, N), SR);
    assert.ok(relativeError(f0, 130) < 0.05, `f0=${f0}`);
  });

  it('digital silence: no F0, periodicity 0', () => {
    assert.deepEqual(estimatePitch(silence(N), SR), { f0: null, periodicity: 0, isPeriodic: false });
  });

  it('white noise is not periodic', () => {
    const r = estimatePitch(whiteNoise(N), SR);
    assert.equal(r.isPeriodic, false);
    assert.equal(r.f0, null);
    assert.ok(r.periodicity < 0.5, `periodicity=${r.periodicity}`);
  });

  it('rejects frames too short for the minimum F0', () => {
    assert.throws(() => estimatePitch(sine(150, SR, 256), SR), RangeError);
  });
});

describe('spectral features', () => {
  it('FFT of a unit impulse is flat', () => {
    const re = new Float64Array(8);
    const im = new Float64Array(8);
    re[0] = 1;
    fft(re, im);
    for (let k = 0; k < 8; k++) {
      assert.ok(Math.abs(re[k] - 1) < 1e-12 && Math.abs(im[k]) < 1e-12);
    }
  });

  it('returns a 13-dimensional vector (12 Mel envelope + centroid)', () => {
    const { vector, envelope } = extractSpectralFeatures(harmonic(150, SR, N), SR);
    assert.equal(FEATURE_DIMENSION, 13);
    assert.equal(vector.length, 13);
    assert.equal(envelope.length, 12);
    assert.ok(vector.every(Number.isFinite));
  });

  it('centroid of a pure sine sits at its frequency', () => {
    const { centroidHz, centroidNormalized } = extractSpectralFeatures(sine(1000, SR, N), SR);
    assert.ok(relativeError(centroidHz, 1000) < 0.05, `centroid=${centroidHz}`);
    assert.ok(Math.abs(centroidNormalized - centroidHz / (SR / 2)) < 1e-12);
  });

  it('envelope is level invariant (c0 dropped)', () => {
    const a = extractSpectralFeatures(harmonic(150, SR, N, 0.3), SR).envelope;
    const b = extractSpectralFeatures(harmonic(150, SR, N, 0.03), SR).envelope;
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6);
  });

  it('vocal-band ratio: ~1 for a 200 Hz tone, low for a 6 kHz tone', () => {
    assert.ok(extractSpectralFeatures(sine(200, SR, N), SR).vocalBandRatio > 0.99);
    assert.ok(extractSpectralFeatures(sine(6000, SR, N), SR).vocalBandRatio < 0.01);
  });

  it('digital silence yields zero centroid and band ratio without NaN', () => {
    const r = extractSpectralFeatures(silence(N), SR);
    assert.equal(r.centroidHz, 0);
    assert.equal(r.vocalBandRatio, 0);
    assert.ok(r.vector.every(Number.isFinite));
  });
});

describe('signal quality', () => {
  it('RMS and crest factor of a sine', () => {
    const s = sine(200, SR, 16000, 0.5); // whole periods
    assert.ok(Math.abs(frameRms(s) - 0.5 / Math.SQRT2) < 1e-4);
    assert.ok(Math.abs(crestFactor(s) - Math.SQRT2) < 1e-3);
  });

  it('impulse has a high crest factor', () => {
    assert.ok(crestFactor(impulse(N)) > 30);
  });

  it('silence: RMS 0, crest 0 (no division by zero)', () => {
    assert.equal(frameRms(silence(N)), 0);
    assert.equal(crestFactor(silence(N)), 0);
    assert.equal(frameRms(new Float32Array(0)), 0);
  });

  it('SNR in dB relative to the noise floor', () => {
    assert.ok(Math.abs(snrDb(0.1, 0.001) - 40) < 1e-9);
    assert.ok(Number.isFinite(snrDb(0, 0.001)));
  });

  it('noise floor calibration uses the median and a lower bound', () => {
    assert.equal(calibrateNoiseFloor([0.001, 0.5, 0.002]), 0.002);
    assert.equal(calibrateNoiseFloor([0, 0]), 1e-6);
    assert.throws(() => calibrateNoiseFloor([]), RangeError);
  });

  it('noise floor falls fast, rises slowly, and freezes during voice', () => {
    const down = updateNoiseFloor(0.01, 0.001, { dt: 0.064, voicePresent: false });
    assert.ok(down < 0.01 && down > 0.001);
    const up = updateNoiseFloor(0.001, 0.1, { dt: 1, voicePresent: false });
    assert.ok(Math.abs(20 * Math.log10(up / 0.001) - 1) < 1e-9, 'rises 1 dB/s');
    assert.equal(updateNoiseFloor(0.001, 0.1, { dt: 1, voicePresent: true }), 0.001);
  });

  it('Q_k is 1 only with valid SNR and crest factor', () => {
    assert.deepEqual(assessQuality({ rms: 0.1, crest: 1.5, snr: 40 }), { Q: 1, reason: null });
    assert.deepEqual(assessQuality({ rms: 0.1, crest: 30, snr: 40 }), { Q: 0, reason: 'impulsive' });
    assert.deepEqual(assessQuality({ rms: 0.1, crest: 1.5, snr: 10 }), { Q: 0, reason: 'low_snr' });
    assert.deepEqual(assessQuality({ rms: 0.1, crest: 1.5, snr: 3 }), { Q: 0, reason: 'below_gate' });
    assert.deepEqual(assessQuality({ rms: 0, crest: 0, snr: 99 }), { Q: 0, reason: 'below_gate' });
  });
});

describe('frame classifier', () => {
  const voiceFrame = harmonic(150, SR, N);
  const profile = enrollProfile([extractSpectralFeatures(voiceFrame, SR).vector]);
  const foreignProfile = enrollProfile([extractSpectralFeatures(voiceFrame, SR).vector.map((v) => -v)]);
  const classify = (samples, options) => classifyFrame(createFrameClassifier(options), samples, SR);

  it('digital silence -> "silencio", Phi = 0', () => {
    const { analysis, frame } = classify(silence(N), { profile });
    assert.equal(analysis.category, CATEGORIES.SILENCE);
    assert.equal(analysis.phi, 0);
    assert.equal(analysis.rejectionReason, 'below_gate');
    assert.equal(frame.category, 'silence');
  });

  it('enrolled voice -> "fonacion_atribuida", Phi = 1, frame feeds stepVocalLoad', () => {
    const { analysis, frame } = classify(voiceFrame, { profile });
    assert.equal(analysis.category, CATEGORIES.ATTRIBUTED);
    assert.deepEqual([analysis.V, analysis.W, analysis.Q, analysis.phi], [1, 1, 1, 1]);
    assert.equal(analysis.rejectionReason, null);
    assert.ok(relativeError(analysis.f0, 150) < 0.05);
    const engine = stepVocalLoad(createVocalLoadState(), frame);
    assert.equal(engine.lastFrame.phi, 1);
    assert.ok(Math.abs(engine.h - N / SR) < 1e-12);
    assert.ok(engine.doses.none > 0);
  });

  it('pure sines at 150 and 220 Hz are detected as voiced (V = 1)', () => {
    for (const f of [150, 220]) {
      const { analysis } = classify(sine(f, SR, N), { profile });
      assert.equal(analysis.V, 1);
      assert.ok(relativeError(analysis.f0, f) < 0.05);
      assert.ok(analysis.periodicity > 0.9);
    }
  });

  it('voice not matching the profile -> "voz_no_atribuida" (W = 0)', () => {
    const { analysis, frame } = classify(voiceFrame, { profile: foreignProfile });
    assert.equal(analysis.category, CATEGORIES.UNATTRIBUTED_VOICE);
    assert.deepEqual([analysis.V, analysis.W, analysis.Q, analysis.phi], [1, 0, 1, 0]);
    assert.equal(analysis.rejectionReason, 'speaker_mismatch');
    const engine = stepVocalLoad(createVocalLoadState(), frame);
    assert.equal(engine.h, 0);
    assert.equal(engine.metrics.timeByCategory.unattributed_voice, N / SR);
  });

  it('voice without an enrolled profile is never attributed', () => {
    const { analysis } = classify(voiceFrame);
    assert.equal(analysis.category, CATEGORIES.UNATTRIBUTED_VOICE);
    assert.equal(analysis.rejectionReason, 'no_profile');
  });

  it('white noise -> "ruido_descartado" with V = 0', () => {
    const { analysis, frame } = classify(whiteNoise(N), { profile });
    assert.equal(analysis.category, CATEGORIES.NOISE);
    assert.equal(analysis.V, 0);
    assert.equal(analysis.phi, 0);
    assert.ok(['aperiodic', 'out_of_band'].includes(analysis.rejectionReason));
    assert.equal(frame.category, 'noise');
  });

  it('impulse -> "ruido_descartado" with Q = 0 (impulsive)', () => {
    const { analysis } = classify(impulse(N), { profile });
    assert.equal(analysis.category, CATEGORIES.NOISE);
    assert.equal(analysis.Q, 0);
    assert.equal(analysis.rejectionReason, 'impulsive');
  });

  it('voice barely above the floor -> "senal_incierta" (low SNR)', () => {
    const quiet = harmonic(150, SR, N, 0.003); // ~ 6.5 dB over a 1e-3 floor... above gate, below 15 dB
    const { analysis } = classify(quiet, { profile, config: { quality: { gateSnrDb: 3 } } });
    assert.equal(analysis.category, CATEGORIES.UNCERTAIN);
    assert.equal(analysis.Q, 0);
    assert.equal(analysis.rejectionReason, 'low_snr');
  });

  it('out-of-band periodic tone is rejected as noise', () => {
    const { analysis } = classify(add(sine(150, SR, N, 0.05), sine(6000, SR, N, 0.5)), { profile });
    assert.equal(analysis.phi, 0);
    assert.equal(analysis.category, CATEGORIES.NOISE);
    assert.equal(analysis.rejectionReason, 'out_of_band');
  });

  it('categories are mutually exclusive and cover the decision table', () => {
    const base = { V: 1, W: 1, Q: 1, qualityReason: null, periodicity: 0.95, inVocalBand: true, hasProfile: true };
    const cases = [
      [{ qualityReason: 'below_gate', Q: 0, V: 0 }, CATEGORIES.SILENCE, 'below_gate'],
      [{ qualityReason: 'impulsive', Q: 0 }, CATEGORIES.NOISE, 'impulsive'],
      [{ V: 0, periodicity: 0.2 }, CATEGORIES.NOISE, 'aperiodic'],
      [{ V: 0, inVocalBand: false }, CATEGORIES.NOISE, 'out_of_band'],
      [{ V: 0, periodicity: 0.7 }, CATEGORIES.UNCERTAIN, 'weak_periodicity'],
      [{ Q: 0, qualityReason: 'low_snr' }, CATEGORIES.UNCERTAIN, 'low_snr'],
      [{ W: 0 }, CATEGORIES.UNATTRIBUTED_VOICE, 'speaker_mismatch'],
      [{}, CATEGORIES.ATTRIBUTED, null],
    ];
    for (const [override, category, reason] of cases) {
      assert.deepEqual(decideCategory({ ...base, ...override }), { category, reason }, JSON.stringify(override));
    }
  });

  it('is pure: input state is not mutated and time advances by the frame duration', () => {
    const s0 = createFrameClassifier({ profile });
    const before = structuredClone({ noise: s0.noiseFloorRms, identity: s0.identity, time: s0.time });
    const { state } = classifyFrame(s0, voiceFrame, SR);
    assert.deepEqual({ noise: s0.noiseFloorRms, identity: s0.identity, time: s0.time }, before);
    assert.equal(state.time, N / SR);
  });

  it('noise floor adapts during noise and stays frozen during voice', () => {
    let s = createFrameClassifier({ profile, noiseFloorRms: 1e-3 });
    s = classifyFrame(s, voiceFrame, SR).state;
    assert.equal(s.noiseFloorRms, 1e-3);
    s = classifyFrame(s, whiteNoise(N, 0.01), SR).state;
    assert.ok(s.noiseFloorRms > 1e-3);
  });
});
