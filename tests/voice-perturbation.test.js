// Exploratory jitter and shimmer (local, %) of the sustained vowel (spec §23).
// For Gaussian cycle-to-cycle variation with relative SD σ, the expected local value is
// E|x_i - x_{i+1}| / mean = 2σ/√π ≈ 1.13 σ. The synthesiser changes period and amplitude
// at phase 0 while the marks sit on the waveform peak, so each measured cycle mixes two
// synthetic ones and the measured values come out about 20-25 % lower (0.9 % and 4.1 %).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyseVoiceSample } from '../src/dsp/voice-assessment.js';
import { sustainedVowel, withLeadIn } from './helpers/sustained-vowel.js';

const vowel = (options, sampleRate = 44100) =>
  analyseVoiceSample(withLeadIn(sustainedVowel({ sampleRate, seconds: 4, ...options }), 1, sampleRate), sampleRate, { task: 'VOWEL' });

describe('voice assessment: jitter and shimmer (exploratory)', () => {
  it('are near zero for a perfectly periodic vowel', () => {
    const r = vowel({});
    assert.ok(r.jitterLocal < 0.2, `jitter ${r.jitterLocal}`);
    assert.ok(r.shimmerLocal < 0.5, `shimmer ${r.shimmerLocal}`);
    assert.ok(r.perturbationCycles > 500, `${r.perturbationCycles} cycles`);
  });

  it('measure cycle-to-cycle period variation (σ = 1 %)', () => {
    const r = vowel({ jitter: 0.01, seed: 3 });
    assert.ok(r.jitterLocal > 0.75 && r.jitterLocal < 1.45, `jitter ${r.jitterLocal}`);
  });

  it('measure cycle-to-cycle amplitude variation (σ = 5 %)', () => {
    const r = vowel({ shimmer: 0.05, seed: 4 });
    assert.ok(r.shimmerLocal > 3.3 && r.shimmerLocal < 7, `shimmer ${r.shimmerLocal}`);
    assert.ok(r.jitterLocal < 0.3, `jitter stays low: ${r.jitterLocal}`);
  });

  it('use the recording rate, not the 16 kHz analysis rate', () => {
    const r = vowel({ jitter: 0.01, seed: 3 }, 48000);
    assert.ok(r.jitterLocal > 0.75 && r.jitterLocal < 1.45, `jitter ${r.jitterLocal}`);
    assert.deepEqual(r.settings.perturbation, { periodFloor: 0.0001, periodCeiling: 0.02, maxPeriodFactor: 1.3, maxAmplitudeFactor: 1.6, minCycles: 20 });
  });

  it('are not computed on connected speech', () => {
    const r = analyseVoiceSample(withLeadIn(sustainedVowel({ sampleRate: 16000, seconds: 6 }), 1, 16000), 16000, { task: 'SPEECH' });
    assert.equal(r.jitterLocal, null);
    assert.equal(r.shimmerLocal, null);
  });
});
