// Sustained /a/ by additive synthesis: every harmonic of a glottal source (1/h roll-off)
// shaped by the vowel's formant resonances. The period can be fractional, so the signal
// is exactly periodic unless `jitter` (relative SD of each cycle's period) or `shimmer`
// (relative SD of each cycle's amplitude) are set; `hnrDb` adds white noise at that
// harmonics-to-noise power ratio.
import { prng } from './signals.js';

const FORMANTS_A = [800, 1200, 2500, 3500];
const BANDWIDTHS = [80, 100, 140, 200];

function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function formantGain(f) {
  return FORMANTS_A.reduce((g, F, k) => {
    const B = BANDWIDTHS[k];
    return g / Math.sqrt((1 - (f / F) ** 2) ** 2 + ((f * B) / (F * F)) ** 2);
  }, 1);
}

export function sustainedVowel({ f0 = 210, seconds = 4, sampleRate = 16000, seed = 1, jitter = 0, shimmer = 0, hnrDb = Infinity } = {}) {
  const rand = prng(seed);
  const harmonics = Math.floor((0.45 * sampleRate) / (f0 * (1 + 4 * jitter)));
  const gains = Array.from({ length: harmonics }, (_, i) => formantGain((i + 1) * f0) / (i + 1));
  const out = new Float64Array(Math.round(seconds * sampleRate));
  let phase = 0;
  let period = 1 / f0;
  let amplitude = 1;
  for (let n = 0; n < out.length; n++) {
    let v = 0;
    for (let h = 0; h < harmonics; h++) v += gains[h] * Math.sin(2 * Math.PI * (h + 1) * phase);
    out[n] = amplitude * v;
    phase += 1 / (period * sampleRate);
    if (phase >= 1) {
      phase -= 1;
      period = (1 + jitter * gaussian(rand)) / f0;
      amplitude = 1 + shimmer * gaussian(rand);
    }
  }
  const rms = Math.sqrt(out.reduce((s, v) => s + v * v, 0) / out.length);
  const noiseRms = Number.isFinite(hnrDb) ? rms * 10 ** (-hnrDb / 20) : 0;
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const scale = 0.3 / (peak + 4 * noiseRms);
  return Float32Array.from(out, (v) => scale * (v + noiseRms * gaussian(rand)));
}

/** `seconds` of near-silence (white noise at `rms`) followed by `signal`. */
export function withLeadIn(signal, seconds, sampleRate, { rms = 1e-4, seed = 99 } = {}) {
  const rand = prng(seed);
  const lead = Math.round(seconds * sampleRate);
  const out = new Float32Array(lead + signal.length);
  for (let i = 0; i < lead; i++) out[i] = rms * gaussian(rand);
  out.set(signal, lead);
  return out;
}

/** Inserts `pause` seconds of near-silence after every `every` seconds of `signal`. */
export function withPauses(signal, sampleRate, { every = 0.8, pause = 0.4, rms = 1e-4, seed = 7 } = {}) {
  const rand = prng(seed);
  const chunk = Math.round(every * sampleRate);
  const gap = Math.round(pause * sampleRate);
  const parts = [];
  for (let s = 0; s < signal.length; s += chunk) {
    parts.push(signal.subarray(s, s + chunk));
    parts.push(Float32Array.from({ length: gap }, () => rms * gaussian(rand)));
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
