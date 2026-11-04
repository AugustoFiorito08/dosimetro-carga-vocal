// Spec §6.2/§7 — Mel spectral envelope, global spectral centroid, vocal-band energy.

export const DEFAULT_SPECTRAL_CONFIG = Object.freeze({
  melFilters: 24,
  coefficients: 12, // cepstral c1..c12 (c0 dropped -> level invariant)
  minFrequency: 80, // Hz
  maxFrequency: 8000, // Hz, clipped to Nyquist
  vocalBandLow: 70, // Hz
  vocalBandHigh: 4000, // Hz
});

export const FEATURE_DIMENSION = DEFAULT_SPECTRAL_CONFIG.coefficients + 1;

// Log floor relative to the strongest Mel band (80 dB range) keeps the envelope
// level invariant; the absolute term only guards all-zero frames.
const RELATIVE_LOG_FLOOR = 1e-8;
const ABSOLUTE_LOG_FLOOR = 1e-30;

const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

export function nextPowerOfTwo(n) {
  let size = 1;
  while (size < n) size <<= 1;
  return size;
}

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = start + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** One-sided power spectrum of a Hann-windowed, zero-padded frame. */
export function powerSpectrum(samples) {
  const size = nextPowerOfTwo(samples.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const hann = n > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) : 1;
    re[i] = samples[i] * hann;
  }
  fft(re, im);
  const power = new Float64Array(size / 2 + 1);
  for (let k = 0; k < power.length; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

const filterbankCache = new Map();

/** Triangular Mel filterbank as arrays of { start, weights } over FFT bins. */
export function melFilterbank(fftSize, sampleRate, filters, minFrequency, maxFrequency) {
  const key = `${fftSize}|${sampleRate}|${filters}|${minFrequency}|${maxFrequency}`;
  if (filterbankCache.has(key)) return filterbankCache.get(key);
  const top = Math.min(maxFrequency, sampleRate / 2);
  const melLow = hzToMel(minFrequency);
  const melHigh = hzToMel(top);
  const binHz = sampleRate / fftSize;
  const edges = Array.from({ length: filters + 2 }, (_, i) =>
    melToHz(melLow + ((melHigh - melLow) * i) / (filters + 1)),
  );
  const bank = [];
  for (let m = 1; m <= filters; m++) {
    const [left, center, right] = [edges[m - 1], edges[m], edges[m + 1]];
    const start = Math.floor(left / binHz);
    const end = Math.ceil(right / binHz);
    const weights = [];
    for (let k = start; k <= end; k++) {
      const f = k * binHz;
      const w = f <= center ? (f - left) / (center - left) : (right - f) / (right - center);
      weights.push(Math.max(0, w));
    }
    bank.push({ start, weights });
  }
  filterbankCache.set(key, bank);
  return bank;
}

/**
 * Spectral features of one frame.
 * `vector` (13 dims) = 12 Mel-cepstral envelope coefficients + centroid / Nyquist.
 * @returns {{ vector: Float64Array, envelope: Float64Array, centroidHz: number,
 *   centroidNormalized: number, vocalBandRatio: number, totalPower: number }}
 */
export function extractSpectralFeatures(samples, sampleRate, config = {}) {
  const cfg = { ...DEFAULT_SPECTRAL_CONFIG, ...config };
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  if (samples.length < 2) throw new RangeError('frame must contain at least 2 samples');
  const power = powerSpectrum(samples);
  const fftSize = (power.length - 1) * 2;
  const binHz = sampleRate / fftSize;
  const nyquist = sampleRate / 2;

  let totalPower = 0;
  let bandPower = 0;
  let weightedMagnitude = 0;
  let totalMagnitude = 0;
  for (let k = 1; k < power.length; k++) {
    const f = k * binHz;
    const magnitude = Math.sqrt(power[k]);
    totalPower += power[k];
    if (f >= cfg.vocalBandLow && f <= cfg.vocalBandHigh) bandPower += power[k];
    weightedMagnitude += f * magnitude;
    totalMagnitude += magnitude;
  }
  const centroidHz = totalMagnitude === 0 ? 0 : weightedMagnitude / totalMagnitude;

  const bank = melFilterbank(fftSize, sampleRate, cfg.melFilters, cfg.minFrequency, cfg.maxFrequency);
  const energies = bank.map(({ start, weights }) => {
    let energy = 0;
    for (let i = 0; i < weights.length; i++) energy += (power[start + i] ?? 0) * weights[i];
    return energy;
  });
  const floor = Math.max(...energies) * RELATIVE_LOG_FLOOR + ABSOLUTE_LOG_FLOOR;
  const logEnergies = energies.map((e) => Math.log(Math.max(e, floor)));

  // DCT-II of log Mel energies; keep c1..cN.
  const envelope = new Float64Array(cfg.coefficients);
  const m = logEnergies.length;
  for (let c = 1; c <= cfg.coefficients; c++) {
    let sum = 0;
    for (let i = 0; i < m; i++) sum += logEnergies[i] * Math.cos((Math.PI * c * (i + 0.5)) / m);
    envelope[c - 1] = sum * Math.sqrt(2 / m);
  }

  const centroidNormalized = centroidHz / nyquist;
  const vector = new Float64Array(cfg.coefficients + 1);
  vector.set(envelope);
  vector[cfg.coefficients] = centroidNormalized;
  return {
    vector,
    envelope,
    centroidHz,
    centroidNormalized,
    vocalBandRatio: totalPower === 0 ? 0 : bandPower / totalPower,
    totalPower,
  };
}
