// Source-filter synthetic speakers (glottal pulse train + formant resonators) for
// speaker-verification tests. A speaker differs by F0 and vocal-tract length
// (formant scale); `f0Factor` raises the pitch as in a raised, classroom voice, and
// `variability` perturbs each vowel's formants and source tilt by up to ±variability and
// randomises its duration (120-370 ms), as coarticulation does in real speech. With
// variability 0 every token of a vowel is identical, which flatters any classifier.
import { prng } from './signals.js';

const VOWEL_FORMANTS = [
  [800, 1200, 2500, 3500], // a
  [500, 1900, 2600, 3500], // e
  [300, 2300, 3000, 3700], // i
  [500, 900, 2500, 3500], // o
  [320, 800, 2400, 3400], // u
];
const BANDWIDTHS = [80, 100, 140, 200];
const SEGMENT_SECONDS = 0.25;

export const SPEAKERS = Object.freeze({
  target: { f0: 210, formantScale: 1.0 },
  similar: { f0: 235, formantScale: 1.06 }, // same sex, close age and timbre
  male: { f0: 115, formantScale: 0.82 },
});

function resonate(x, frequency, bandwidth, sampleRate) {
  const r = Math.exp((-Math.PI * bandwidth) / sampleRate);
  const a1 = 2 * r * Math.cos((2 * Math.PI * frequency) / sampleRate);
  const a2 = -r * r;
  const y = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) y[n] = (1 - r) * x[n] + a1 * (y[n - 1] ?? 0) + a2 * (y[n - 2] ?? 0);
  return y;
}

/** `seconds` of vowels (250 ms each, random order) spoken by `speaker`. */
export function speak(speaker, seconds, sampleRate, seed, { f0Factor = 1, variability = 0 } = {}) {
  const rand = prng(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let phase = 0;
  for (let start = 0; start < out.length; ) {
    const seconds = variability > 0 ? 0.12 + 0.25 * rand() : SEGMENT_SECONDS;
    const length = Math.min(Math.round(seconds * sampleRate), out.length - start);
    const formants = VOWEL_FORMANTS[Math.floor(rand() * VOWEL_FORMANTS.length)].map(
      (f) => f * (1 + variability * (2 * rand() - 1)),
    );
    const tilt = 0.9 + variability * (rand() - 0.5);
    const f0 = speaker.f0 * f0Factor * (0.85 + 0.3 * rand());
    const source = new Float64Array(length);
    let smoothed = 0;
    for (let i = 0; i < length; i++) {
      phase += (f0 * (1 + 0.05 * Math.sin((6 * Math.PI * i) / sampleRate)) * (1 + 0.01 * (rand() - 0.5))) / sampleRate;
      const pulse = phase >= 1 ? 1 : 0;
      if (pulse) phase -= 1;
      smoothed = tilt * smoothed + (1 - tilt) * pulse; // glottal spectral tilt
      source[i] = smoothed + 0.02 * (rand() - 0.5);
    }
    const voice = new Float64Array(length);
    formants.forEach((f, k) => {
      const band = resonate(source, f * speaker.formantScale, BANDWIDTHS[k] * speaker.formantScale, sampleRate);
      for (let i = 0; i < length; i++) voice[i] += band[i] / (k + 1);
    });
    const peak = voice.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
    for (let i = 0; i < length; i++) out[start + i] = (0.3 * voice[i]) / peak;
    start += length;
  }
  return out;
}

/** Contiguous non-overlapping frames of `size` samples. */
export function frames(signal, size) {
  const list = [];
  for (let s = 0; s + size <= signal.length; s += size) list.push(signal.subarray(s, s + size));
  return list;
}
