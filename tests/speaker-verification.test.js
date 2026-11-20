// End-to-end speaker verification on synthetic voices: enrol the target speaker
// (normal and raised voice, as the enrolment instructions ask), then measure the
// share of voiced frames attributed to her (W_k = 1) for each test voice.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFrame, createFrameClassifier } from '../src/dsp/frame-classifier.js';
import { extractSpectralFeatures } from '../src/dsp/spectral.js';
import { DEFAULT_IDENTITY_CONFIG, enrollProfile, ownAcceptance } from '../src/dsp/speaker-profile.js';
import { SPEAKERS, frames, speak } from './helpers/voices.js';

const SAMPLE_RATE = 16000;
const FRAME = 1024;
const NOISE_FLOOR = 1e-4;

function voicedFrames(signal, profile) {
  let state = createFrameClassifier({ profile, noiseFloorRms: NOISE_FLOOR });
  const out = [];
  for (const frame of frames(signal, FRAME)) {
    const result = classifyFrame(state, frame, SAMPLE_RATE);
    state = result.state;
    if (result.analysis.V === 1 && result.analysis.Q === 1) out.push(result.analysis);
  }
  return out;
}

const enrolment = [
  ...voicedFrames(speak(SPEAKERS.target, 8, SAMPLE_RATE, 1), null),
  ...voicedFrames(speak(SPEAKERS.target, 7, SAMPLE_RATE, 2, { f0Factor: 1.3 }), null),
];
const profile = enrollProfile(enrolment.map((a) => a.features), {
  frameDuration: FRAME / SAMPLE_RATE,
  f0: enrolment.map((a) => a.f0),
});

function acceptedShare(speaker, seed, options) {
  const analyses = voicedFrames(speak(speaker, 20, SAMPLE_RATE, seed, options), profile);
  return analyses.filter((a) => a.W === 1).length / analyses.length;
}

describe('speaker verification on synthetic voices', () => {
  it('attributes the enrolled speaker at normal and moderately raised pitch', () => {
    assert.ok(acceptedShare(SPEAKERS.target, 11) >= 0.95, 'normal voice');
    assert.ok(acceptedShare(SPEAKERS.target, 12, { f0Factor: 1.15 }) >= 0.9, 'raised voice');
  });

  it('rejects a similar voice of the same sex (formants 6 % higher, F0 12 % higher)', () => {
    assert.ok(acceptedShare(SPEAKERS.similar, 13) <= 0.1);
  });

  it('rejects a male voice', () => {
    assert.equal(acceptedShare(SPEAKERS.male, 14), 0);
  });
});

// Real speech varies from one token of a vowel to the next; an absolute threshold tuned on
// identical tokens rejected most of a real speaker's own voice. The threshold is now
// relative to the speaker's own held-out distance, measured during enrolment.
describe('speaker verification with realistic within-speaker variability (±10 %)', () => {
  const variability = 0.1;
  const enrolmentVar = [
    ...voicedFrames(speak(SPEAKERS.target, 8, SAMPLE_RATE, 21, { variability }), null),
    ...voicedFrames(speak(SPEAKERS.target, 7, SAMPLE_RATE, 22, { f0Factor: 1.3, variability }), null),
  ];
  const varProfile = enrollProfile(enrolmentVar.map((a) => a.features), {
    frameDuration: FRAME / SAMPLE_RATE,
    f0: enrolmentVar.map((a) => a.f0),
  });
  const share = (speaker, seed, options = {}) => {
    const analyses = voicedFrames(speak(speaker, 20, SAMPLE_RATE, seed, { variability, ...options }), varProfile);
    return analyses.filter((a) => a.W === 1).length / analyses.length;
  };

  it('attributes the enrolled speaker at normal and raised pitch', () => {
    assert.ok(share(SPEAKERS.target, 31) >= 0.95, 'normal voice');
    assert.ok(share(SPEAKERS.target, 32, { f0Factor: 1.15 }) >= 0.9, 'raised voice');
  });

  it('still rejects a male voice', () => {
    assert.ok(share(SPEAKERS.male, 34) <= 0.05);
  });

  it('enrolment estimates how much of the held-out own voice the profile accepts', () => {
    // Conservative: held-out frames are scored by models trained on 80 % of the enrolment.
    const accepted = ownAcceptance(varProfile, DEFAULT_IDENTITY_CONFIG, FRAME / SAMPLE_RATE);
    assert.ok(accepted >= 0.5 && accepted <= 1, `own acceptance ${accepted}`);
    const stricter = ownAcceptance(varProfile, { acceptThreshold: 0.85, rejectThreshold: 0.8 }, FRAME / SAMPLE_RATE);
    assert.ok(stricter < accepted, 'a stricter threshold accepts less of the own voice');
  });

  it('rejects a child voice (F0 280 Hz, formants 20 % higher)', () => {
    assert.ok(share({ f0: 280, formantScale: 1.2 }, 35) <= 0.05);
  });
});

// Field test (real CSV, 2026-11-20): the enrolled speaker spoke at F0 111-149 Hz and the
// other voice at 194-453 Hz; the F0 range of the enrolment (normal and raised voice)
// separates them even where the spectral score overlaps.
describe('F0 consistency with the enrolment', () => {
  it('stores the enrolled F0 range (normal and raised voice)', () => {
    assert.ok(profile.f0Range.low > 150 && profile.f0Range.low < 210, `low ${profile.f0Range.low}`);
    assert.ok(profile.f0Range.high > 250 && profile.f0Range.high < 330, `high ${profile.f0Range.high}`);
  });

  it('does not attribute a voice with the same vocal tract far above the enrolled F0', () => {
    const analyses = voicedFrames(speak(SPEAKERS.target, 10, SAMPLE_RATE, 61, { f0Factor: 2 }), profile);
    assert.ok(analyses.length > 50);
    assert.equal(analyses.filter((a) => a.W === 1).length, 0);
    // Octave errors of the pitch tracker can land in range; the spectral score rejects those.
    const outOfRange = analyses.filter((a) => a.rejectionReason === 'f0_out_of_range').length;
    assert.ok(outOfRange > analyses.length / 2, `${outOfRange} of ${analyses.length}`);
  });

  it('keeps attributing the enrolled voice slightly above the raised enrolment', () => {
    assert.ok(acceptedShare(SPEAKERS.target, 62, { f0Factor: 1.4 }) >= 0.8);
  });
});

describe('spectral envelope used for identity', () => {
  const vowel = (f0) => speak({ f0, formantScale: 1 }, 0.25, SAMPLE_RATE, 5).subarray(0, FRAME);
  const distance = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));

  it('is less sensitive to F0 when harmonics are smoothed out of the spectrum', () => {
    const [low, high] = [vowel(200), vowel(270)];
    const raw = distance(
      extractSpectralFeatures(low, SAMPLE_RATE, { envelopeSmoothingHz: 0 }).vector,
      extractSpectralFeatures(high, SAMPLE_RATE, { envelopeSmoothingHz: 0 }).vector,
    );
    const smooth = distance(extractSpectralFeatures(low, SAMPLE_RATE).vector, extractSpectralFeatures(high, SAMPLE_RATE).vector);
    assert.ok(smooth < 0.7 * raw, `smoothed ${smooth.toFixed(3)} vs raw ${raw.toFixed(3)}`);
  });
});
