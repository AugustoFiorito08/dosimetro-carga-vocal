// PRE/POST acoustic assessment engine on synthetic sustained vowels.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ASSESSMENT_CONFIG, analyseVoiceSample } from '../src/dsp/voice-assessment.js';
import { sustainedVowel, withLeadIn, withPauses } from './helpers/sustained-vowel.js';

const FS = 16000;
const recording = (options = {}, leadIn = {}) => withLeadIn(sustainedVowel({ sampleRate: FS, ...options }), 1, options.sampleRate ?? FS, leadIn);
const analyse = (signal, task = 'VOWEL', sampleRate = FS, options = {}) => analyseVoiceSample(signal, sampleRate, { task, ...options });

describe('voice assessment: F0', () => {
  const result = analyse(recording({ f0: 210 }));

  it('measures the mean, median and spread of a steady vowel', () => {
    assert.ok(Math.abs(result.f0.mean - 210) < 3, `mean ${result.f0.mean}`);
    assert.ok(Math.abs(result.f0.median - 210) < 3, `median ${result.f0.median}`);
    assert.ok(result.f0.sd < 3, `sd ${result.f0.sd}`);
    assert.ok(result.f0.sdSemitones < 0.3, `sd st ${result.f0.sdSemitones}`);
    assert.ok(result.f0.p5 <= result.f0.median && result.f0.median <= result.f0.p95);
    assert.ok(result.f0.rangeSemitones >= 0 && result.f0.rangeSemitones < 0.5);
  });

  it('counts voiced time without the silent lead-in and reports pitch confidence', () => {
    assert.ok(Math.abs(result.voicedSeconds - 4) < 0.15, `voiced ${result.voicedSeconds}`);
    assert.ok(result.pitchConfidence > 0.9 && result.pitchConfidence <= 1);
  });

  it('gives the same F0 at 48 kHz (analysed after decimation)', () => {
    const hi = analyse(recording({ f0: 210, sampleRate: 48000 }), 'VOWEL', 48000);
    assert.ok(Math.abs(hi.f0.median - result.f0.median) < 2);
    assert.equal(hi.settings.analysisSampleRate, 16000);
  });
});

describe('voice assessment: CPP, CPPS and HNR', () => {
  const clean = analyse(recording({ hnrDb: 40 }));
  const noisy = analyse(recording({ hnrDb: 10 }));

  it('a clean vowel has a prominent cepstral peak; noise lowers CPP and CPPS', () => {
    assert.ok(clean.cpp > noisy.cpp + 3, `CPP ${clean.cpp} vs ${noisy.cpp}`);
    assert.ok(clean.cpps > noisy.cpps + 3, `CPPS ${clean.cpps} vs ${noisy.cpps}`);
  });

  it('HNR follows the added noise', () => {
    assert.ok(clean.hnr > 25, `clean HNR ${clean.hnr}`);
    assert.ok(Math.abs(noisy.hnr - 10) < 3, `HNR ${noisy.hnr} for 10 dB of noise`);
  });

  it('pauses of connected speech do not lower CPPS (excluded by level)', () => {
    const vowel = sustainedVowel({ sampleRate: FS, seconds: 8, hnrDb: 30 });
    const continuous = analyse(withLeadIn(vowel, 1, FS), 'SPEECH');
    const paused = analyse(withLeadIn(withPauses(vowel, FS), 1, FS), 'SPEECH');
    assert.ok(Math.abs(paused.cpps - continuous.cpps) < 1, `${paused.cpps} vs ${continuous.cpps}`);
  });

  it('records the analysis settings with the result', () => {
    const c = DEFAULT_ASSESSMENT_CONFIG.cepstral;
    assert.deepEqual(clean.settings.cepstral, { ...c });
    assert.deepEqual(clean.settings.pitch, { ...DEFAULT_ASSESSMENT_CONFIG.pitch });
    assert.equal(clean.settings.sampleRate, FS);
  });
});

describe('voice assessment: stored derived spectra (no audio)', () => {
  const result = analyse(recording());

  it('LTAS in 1/3-octave bands from 100 Hz, relative to the total power', () => {
    const { centersHz, db } = result.ltas;
    assert.equal(centersHz[0], 100);
    assert.equal(centersHz.length, db.length);
    assert.ok(centersHz.at(-1) <= 0.45 * FS);
    assert.ok(Math.max(...db) <= 0);
    const total = db.reduce((s, v) => s + 10 ** (v / 10), 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `bands add up to ${total}`);
    // The /a/ has its first formant near 800 Hz: that band dominates the 100 Hz one.
    assert.ok(db[centersHz.indexOf(800)] > db[0]);
  });

  it('average cepstrum from 1 to 20 ms in 0.25 ms steps, peaking at the period', () => {
    const { fromSeconds, stepSeconds, db } = result.cepstrum;
    assert.equal(fromSeconds, 0.001);
    assert.equal(stepSeconds, 0.00025);
    assert.equal(db.length, 77);
    const peak = fromSeconds + stepSeconds * db.indexOf(Math.max(...db.slice(4)));
    assert.ok(Math.abs(peak - 1 / 210) < 0.0003, `peak at ${peak}`);
  });

  it('marks the audio as not retained and holds no sample arrays', () => {
    assert.equal(result.audioRetained, false);
    const longest = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? Math.max(v.length, ...Array.from(v, longest)) : v && typeof v === 'object' ? Math.max(0, ...Object.values(v).map(longest)) : 0);
    assert.ok(longest(result) <= 100, `longest array ${longest(result)}`);
  });
});

describe('voice assessment: quality control', () => {
  it('accepts a clean take', () => {
    const r = analyse(recording());
    assert.equal(r.quality.status, 'ok');
    assert.deepEqual(r.quality.reasons, []);
    assert.ok(r.snrDb > 30);
  });

  it('rejects a take with a noisy background', () => {
    const r = analyse(recording({}, { rms: 0.02 }));
    assert.equal(r.quality.status, 'rejected');
    assert.ok(r.quality.reasons.includes('low_snr'));
  });

  it('warns on a marginal background (20-30 dB SNR)', () => {
    const r = analyse(recording({}, { rms: 0.006 }));
    assert.ok(r.snrDb >= 20 && r.snrDb < 30, `snr ${r.snrDb}`);
    assert.equal(r.quality.status, 'warning');
    assert.deepEqual(r.quality.reasons, ['marginal_snr']);
  });

  it('a voice that starts during the second half of the silent lead-in is still a valid take', () => {
    const vowel = sustainedVowel({ sampleRate: FS, seconds: 4.6 });
    const early = withLeadIn(vowel, 0.6, FS); // starts 0.4 s before the lead-in ends
    const r = analyse(early);
    assert.equal(r.quality.status, 'ok', `reasons ${r.quality.reasons} snr ${r.snrDb}`);
  });

  it('says so when the voice fills the silent lead-in (started too early)', () => {
    const r = analyse(sustainedVowel({ sampleRate: FS, seconds: 5 }));
    assert.equal(r.quality.status, 'rejected');
    assert.deepEqual(r.quality.reasons, ['voice_in_lead_in']);
  });

  it('ignores the tap of the record button at the start of the lead-in', () => {
    const take = recording();
    for (let i = 0; i < 0.03 * FS; i++) take[i] = 0.5 * Math.sin(i / 3) * Math.exp(-i / 80);
    const r = analyse(take);
    assert.equal(r.quality.status, 'ok', `reasons ${r.quality.reasons} snr ${r.snrDb}`);
    assert.ok(r.snrDb > 30);
  });

  it('rejects a clipped take', () => {
    const r = analyse(recording().map((v) => Math.max(-0.2, Math.min(0.2, v)) * 5));
    assert.equal(r.quality.status, 'rejected');
    assert.ok(r.quality.reasons.includes('clipping'));
  });

  it('rejects too little voice for the task', () => {
    assert.ok(analyse(recording({ seconds: 1.5 })).quality.reasons.includes('too_little_voice'));
    assert.ok(analyse(recording({ seconds: 4 }), 'SPEECH').quality.reasons.includes('too_little_voice'));
    assert.equal(analyse(recording({ seconds: 6 }), 'SPEECH').quality.status, 'ok');
  });

  it('returns no measures when there is no voice at all', () => {
    const r = analyse(withLeadIn(new Float32Array(3 * FS), 1, FS));
    assert.equal(r.quality.status, 'rejected');
    assert.equal(r.f0, null);
    assert.equal(r.cpps, null);
    assert.equal(r.hnr, null);
  });

  it('reports the level in dB SPL only with an acoustic calibration', () => {
    assert.equal(analyse(recording()).splDb, null);
    const r = analyse(recording(), 'VOWEL', FS, { pressureScale: 2 });
    assert.ok(Math.abs(r.splDb - (r.levelDbfs + 20 * Math.log10(2 / 20e-6))) < 1e-9);
  });

  it('rejects an unknown task', () => {
    assert.throws(() => analyse(recording(), 'READING'), RangeError);
  });
});
