// Deterministic synthetic signals for DSP tests.

export function sine(frequency, sampleRate, length, amplitude = 0.5, phase = 0) {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase));
}

/** Glottal-like harmonic signal: harmonics with 1/h amplitude roll-off. */
export function harmonic(frequency, sampleRate, length, amplitude = 0.3, harmonics = 8) {
  return Float32Array.from({ length }, (_, i) => {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * frequency * h * i) / sampleRate) / h;
    return amplitude * v;
  });
}

export function silence(length) {
  return new Float32Array(length);
}

/** Mulberry32 PRNG so noise tests are reproducible. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function whiteNoise(length, amplitude = 0.5, seed = 42) {
  const rand = prng(seed);
  return Float32Array.from({ length }, () => amplitude * (2 * rand() - 1));
}

export function impulse(length, amplitude = 0.9, position = Math.floor(length / 2)) {
  const out = new Float32Array(length);
  out[position] = amplitude;
  return out;
}

export const add = (a, b) => Float32Array.from(a, (v, i) => v + b[i]);
