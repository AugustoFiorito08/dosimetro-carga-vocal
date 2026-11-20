// PRE/POST acoustic assessment (spec §17): F0, CPP/CPPS, HNR, LTAS and an average
// cepstrum of a short standardised recording (sustained /a/ or a read text), with
// immediate quality control. Pure: the caller owns the samples and discards them after
// the call; the result holds only measures and averaged spectra, never audio.
import { quantile } from '../stats/descriptive.js';
import { estimatePitch } from './pitch.js';
import { nextPowerOfTwo } from './spectral.js';
import { frameRms, toDb } from './signal-quality.js';
import { REFERENCE_PRESSURE_PA } from './acoustic-calibration.js';

export const ASSESSMENT_TASKS = Object.freeze(['VOWEL', 'SPEECH']);

/**
 * The cepstral settings follow Praat's PowerCepstrogram / Get CPPS defaults where
 * practical (Maryn & Weenink, 2015); values are this implementation's and must be
 * validated against Praat before they are compared with published norms.
 */
export const DEFAULT_ASSESSMENT_CONFIG = Object.freeze({
  leadInSeconds: 1, // silence recorded before the task: the noise reference of the SNR
  targetSampleRate: 16000, // analysis rate after integer decimation
  pitch: Object.freeze({ minF0: 70, maxF0: 500, threshold: 0.15, windowSeconds: 0.04, stepSeconds: 0.01 }),
  cepstral: Object.freeze({
    preEmphasisHz: 50,
    pitchFloor: 60, // analysis window = windowPeriods / pitchFloor (Hann)
    windowPeriods: 3,
    stepSeconds: 0.002,
    peakMinF0: 60, // cepstral peak searched between 1/330 and 1/60 s
    peakMaxF0: 330,
    tiltFromSeconds: 0.001, // regression line from 1 ms to the end of the cepstrum (least squares)
    timeSmoothingSeconds: 0.01, // CPPS only
    quefrencySmoothingSeconds: 0.001, // CPPS only
    pauseBelowDb: 30, // frames this far below the loud frames (p95) are pauses, not voice
  }),
  hnr: Object.freeze({ periods: 3, lagTolerance: 0.1 }),
  // Jitter / shimmer (local, %), exploratory and on the sustained vowel only. Limits as
  // Praat's defaults: periods outside 0.1-20 ms, consecutive periods differing by more
  // than ×1.3 or amplitudes by more than ×1.6 do not count.
  perturbation: Object.freeze({ periodFloor: 0.0001, periodCeiling: 0.02, maxPeriodFactor: 1.3, maxAmplitudeFactor: 1.6, minCycles: 20 }),
  ltas: Object.freeze({ minHz: 100, bandsPerOctave: 3 }),
  cepstrum: Object.freeze({ fromSeconds: 0.001, toSeconds: 0.02, stepSeconds: 0.00025 }),
  quality: Object.freeze({
    rejectSnrDb: 20,
    warnSnrDb: 30,
    clipLevel: 0.999,
    maxClipFraction: 0.001,
    minVoicedSeconds: Object.freeze({ VOWEL: 2, SPEECH: 5 }),
  }),
});

function mergeConfig(config = {}) {
  const merged = { ...DEFAULT_ASSESSMENT_CONFIG, ...config };
  for (const key of ['pitch', 'cepstral', 'hnr', 'perturbation', 'ltas', 'cepstrum', 'quality']) {
    merged[key] = { ...DEFAULT_ASSESSMENT_CONFIG[key], ...config[key] };
  }
  return merged;
}

/** Radix-2 FFT with cached bit-reversal and twiddle tables (thousands of frames per call). */
function createFft(n) {
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = Float64Array.from({ length: n / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / n));
  const sin = Float64Array.from({ length: n / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / n));
  return (re, im) => {
    for (let i = 1; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const stride = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < halfLen; k++) {
          const wr = cos[k * stride];
          const wi = sin[k * stride];
          const a = start + k;
          const b = a + halfLen;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

/** Integer decimation with a Blackman-windowed sinc low-pass at 0.45 of the new rate. */
function decimate(samples, sampleRate, target) {
  const factor = Math.max(1, Math.floor(sampleRate / target));
  if (factor === 1) return { signal: Float64Array.from(samples), sampleRate };
  const half = 32 * factor;
  const cutoff = 0.45 / factor; // cycles per input sample
  const taps = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const sinc = i === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * i) / (Math.PI * i);
    const w = 0.42 + 0.5 * Math.cos((Math.PI * i) / half) + 0.08 * Math.cos((2 * Math.PI * i) / half);
    sum += taps[i + half] = sinc * w;
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum;
  const out = new Float64Array(Math.floor(samples.length / factor));
  for (let m = 0; m < out.length; m++) {
    const c = m * factor;
    let acc = 0;
    for (let n = Math.max(0, c - half), end = Math.min(samples.length - 1, c + half); n <= end; n++) acc += taps[n - c + half] * samples[n];
    out[m] = acc;
  }
  return { signal: out, sampleRate: sampleRate / factor };
}

const DB_PER_NEPER = 10 / Math.LN10; // 10·log10(p) = DB_PER_NEPER·ln(p), cheaper in tight loops
const energyMeanDb = (rmsValues) => toDb(Math.sqrt(rmsValues.reduce((s, r) => s + r * r, 0) / Math.max(1, rmsValues.length)));
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v) => {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
};

/** Frame-wise YIN; a frame is voiced when periodic and not a pause by level. */
function pitchTrack(x, fs, cfg, pauseBelowDb) {
  const size = Math.round(cfg.windowSeconds * fs);
  const hop = Math.round(cfg.stepSeconds * fs);
  const frames = [];
  for (let start = 0; start + size <= x.length; start += hop) {
    const seg = x.subarray(start, start + size);
    const p = estimatePitch(seg, fs, cfg);
    const rms = frameRms(seg);
    frames.push({ start, size, rms, levelDb: toDb(rms), f0: p.isPeriodic ? p.f0 : null, periodicity: p.periodicity });
  }
  const loud = frames.length ? quantile(frames.map((f) => f.levelDb), 0.95) : 0;
  for (const f of frames) f.voiced = f.f0 !== null && f.levelDb >= loud - pauseBelowDb;
  return frames;
}

function f0Summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5, { sorted: true });
  const p5 = quantile(sorted, 0.05, { sorted: true });
  const p95 = quantile(sorted, 0.95, { sorted: true });
  return {
    mean: mean(values),
    median,
    sd: sd(values),
    sdSemitones: sd(values.map((f) => 12 * Math.log2(f / median))),
    p5,
    p95,
    rangeSemitones: 12 * Math.log2(p95 / p5),
  };
}

/** Mean HNR (dB) of voiced frames: normalised cross-correlation at the local period. */
function harmonicsToNoise(x, fs, frames, cfg) {
  const values = [];
  for (const f of frames) {
    if (!f.voiced) continue;
    const period = fs / f.f0;
    const width = Math.round(cfg.periods * period);
    const lo = Math.max(2, Math.floor(period * (1 - cfg.lagTolerance)));
    const hi = Math.ceil(period * (1 + cfg.lagTolerance));
    const s0 = Math.round(f.start + f.size / 2 - (width + period) / 2);
    if (s0 < 0 || s0 + width + hi + 1 > x.length) continue;
    const r = new Float64Array(hi + 2);
    let e0 = 0;
    for (let i = 0; i < width; i++) e0 += x[s0 + i] ** 2;
    let best = lo;
    for (let lag = lo - 1; lag <= hi + 1; lag++) {
      let cross = 0;
      let e1 = 0;
      for (let i = 0; i < width; i++) {
        cross += x[s0 + i] * x[s0 + lag + i];
        e1 += x[s0 + lag + i] ** 2;
      }
      r[lag] = e0 > 0 && e1 > 0 ? cross / Math.sqrt(e0 * e1) : 0;
      if (lag >= lo && lag <= hi && r[lag] > r[best]) best = lag;
    }
    const [a, b, c] = [r[best - 1], r[best], r[best + 1]];
    const curvature = a - 2 * b + c;
    const peak = curvature < 0 ? b - ((a - c) ** 2) / (8 * curvature) : b;
    const rho = Math.min(Math.max(peak, 1e-9), 1 - 1e-6);
    values.push(10 * Math.log10(rho / (1 - rho)));
  }
  return values.length ? mean(values) : null;
}

/**
 * Cycle marks by waveform matching at the recording rate: from one mark, the next is
 * the lag (0.8-1.25 of the local period) whose period-long segment best correlates with
 * the current one, refined by parabolic interpolation. Amplitude = peak-to-peak per cycle.
 */
function cycleMarks(y, a, b, periodAt) {
  let T = periodAt(a);
  let p = a + Math.ceil(T); // one period in, so the first window fits in the run
  for (let n = p + 1; n < Math.min(b, a + 2 * Math.ceil(T)); n++) if (y[n] > y[p]) p = n;
  const marks = [p];
  for (;;) {
    const at = Math.round(p);
    T = periodAt(at);
    const half = Math.round(T / 2);
    const lo = Math.floor(T / 1.25);
    const hi = Math.ceil(T * 1.25);
    if (at - half < a || at + hi + half + 1 >= b) break;
    const corr = new Float64Array(hi + 2);
    let e0 = 0;
    for (let i = -half; i <= half; i++) e0 += y[at + i] ** 2;
    let best = lo;
    for (let lag = lo - 1; lag <= hi + 1; lag++) {
      let cross = 0;
      let e1 = 0;
      for (let i = -half; i <= half; i++) {
        cross += y[at + i] * y[at + lag + i];
        e1 += y[at + lag + i] ** 2;
      }
      corr[lag] = e0 > 0 && e1 > 0 ? cross / Math.sqrt(e0 * e1) : 0;
      if (lag >= lo && lag <= hi && corr[lag] > corr[best]) best = lag;
    }
    const [u, v, w] = [corr[best - 1], corr[best], corr[best + 1]];
    const curvature = u - 2 * v + w;
    p = at + best + (curvature < 0 ? (0.5 * (u - w)) / curvature : 0);
    marks.push(p);
  }
  return marks;
}

function perturbation(y, fs, runs, periodAt, cfg) {
  const periodDiffs = [];
  const periodsUsed = [];
  const ampDiffs = [];
  const ampsUsed = [];
  let cycles = 0;
  for (const [a, b] of runs) {
    const marks = cycleMarks(y, a, b, periodAt);
    const periods = [];
    const amps = [];
    for (let i = 0; i + 1 < marks.length; i++) {
      periods.push((marks[i + 1] - marks[i]) / fs);
      let max = -Infinity;
      let min = Infinity;
      for (let n = Math.round(marks[i]); n < Math.round(marks[i + 1]); n++) {
        if (y[n] > max) max = y[n];
        if (y[n] < min) min = y[n];
      }
      amps.push(max - min);
    }
    cycles += periods.length;
    const valid = (t) => t >= cfg.periodFloor && t <= cfg.periodCeiling;
    for (let i = 0; i + 1 < periods.length; i++) {
      const [t0, t1] = [periods[i], periods[i + 1]];
      if (!valid(t0) || !valid(t1) || Math.max(t0, t1) / Math.min(t0, t1) > cfg.maxPeriodFactor) continue;
      periodDiffs.push(Math.abs(t0 - t1));
      periodsUsed.push(t0);
      const [a0, a1] = [amps[i], amps[i + 1]];
      if (Math.min(a0, a1) > 0 && Math.max(a0, a1) / Math.min(a0, a1) <= cfg.maxAmplitudeFactor) {
        ampDiffs.push(Math.abs(a0 - a1));
        ampsUsed.push(a0);
      }
    }
  }
  return {
    cycles,
    jitterLocal: periodDiffs.length >= cfg.minCycles ? (100 * mean(periodDiffs)) / mean(periodsUsed) : null,
    shimmerLocal: ampDiffs.length >= cfg.minCycles ? (100 * mean(ampDiffs)) / mean(ampsUsed) : null,
  };
}

/** Cepstral peak prominence of one cepstrum (dB) against its least-squares tilt line. */
function peakProminence(db, qLo, qHi, tilt) {
  let best = qLo;
  for (let q = qLo + 1; q <= qHi; q++) if (db[q] > db[best]) best = q;
  let sy = 0;
  let sqy = 0;
  for (let q = tilt.from; q < tilt.to; q++) {
    sy += db[q];
    sqy += q * db[q];
  }
  const slope = (tilt.n * sqy - tilt.sq * sy) / (tilt.n * tilt.sqq - tilt.sq * tilt.sq);
  const intercept = (sy - slope * tilt.sq) / tilt.n;
  const [a, b, c] = [db[best - 1], db[best], db[best + 1]];
  const curvature = a - 2 * b + c;
  const delta = curvature < 0 ? (0.5 * (a - c)) / curvature : 0;
  const peak = b - 0.25 * (a - c) * delta;
  return peak - (slope * (best + delta) + intercept);
}

/**
 * CPP (per-frame cepstra), CPPS (cepstra smoothed in time and quefrency), LTAS and the
 * average smoothed cepstrum, over the frames that are not pauses.
 */
function cepstralAnalysis(x, fs, cfg, ltasCfg, cepCfg) {
  const size = Math.round((cfg.windowPeriods / cfg.pitchFloor) * fs);
  const n = nextPowerOfTwo(size);
  const half = n / 2;
  const fft = createFft(n);
  const hop = Math.max(1, Math.round(cfg.stepSeconds * fs));
  const a = Math.exp((-2 * Math.PI * cfg.preEmphasisHz) / fs);
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const qLo = Math.max(2, Math.floor(fs / cfg.peakMaxF0));
  const qHi = Math.min(half - 2, Math.ceil(fs / cfg.peakMinF0));
  const tilt = { from: Math.max(1, Math.round(cfg.tiltFromSeconds * fs)), to: half };
  tilt.n = tilt.to - tilt.from;
  tilt.sq = 0;
  tilt.sqq = 0;
  for (let q = tilt.from; q < tilt.to; q++) {
    tilt.sq += q;
    tilt.sqq += q * q;
  }
  const timeFrames = Math.max(1, Math.round(cfg.timeSmoothingSeconds / cfg.stepSeconds));
  const qHalf = Math.max(0, Math.round((cfg.quefrencySmoothingSeconds * fs) / 2));

  const starts = [];
  for (let s = 0; s + size <= x.length; s += hop) starts.push(s);
  if (!starts.length) return null;
  const levels = starts.map((s) => toDb(frameRms(x.subarray(s, s + size))));
  const loud = quantile(levels, 0.95);
  const kept = levels.map((l) => l >= loud - cfg.pauseBelowDb);

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const logA = new Float64Array(n);
  const logB = new Float64Array(n);
  const ring = Array.from({ length: timeFrames }, () => new Float64Array(half));
  const timeSum = new Float64Array(half);
  const ltasPower = new Float64Array(half + 1);
  const avgCepstrum = new Float64Array(half);
  const db = new Float64Array(half);
  const smoothedDb = new Float64Array(half);
  const cpp = [];
  const cpps = [];
  const centre = Math.floor(timeFrames / 2);
  let averaged = 0;

  const windowed = (start, out) => {
    for (let k = 0; k < size; k++) {
      const prev = start + k > 0 ? x[start + k - 1] : 0;
      out[k] = (x[start + k] - a * prev) * hann[k];
    }
  };

  const takeCepstrum = (i, buf) => {
    const slot = ring[i % timeFrames];
    for (let q = 0; q < half; q++) {
      const c = buf[q] / n;
      const power = c * c;
      timeSum[q] += power - slot[q];
      slot[q] = power;
      if (kept[i]) db[q] = DB_PER_NEPER * Math.log(power + 1e-20);
    }
    if (kept[i]) cpp.push(peakProminence(db, qLo, qHi, tilt));
    const c = i - (timeFrames - 1 - centre); // frame at the centre of the time window
    if (i < timeFrames - 1 || !kept[c]) return;
    let acc = 0;
    let lo = 0;
    let hi = -1;
    for (let q = 0; q < half; q++) {
      while (hi < Math.min(half - 1, q + qHalf)) acc += timeSum[++hi];
      while (lo < q - qHalf) acc -= timeSum[lo++];
      const value = acc / (hi - lo + 1) / timeFrames;
      smoothedDb[q] = DB_PER_NEPER * Math.log(Math.max(value, 0) + 1e-20);
      avgCepstrum[q] += value;
    }
    averaged++;
    cpps.push(peakProminence(smoothedDb, qLo, qHi, tilt));
  };

  // Two real frames per complex FFT (frame i in re, i + 1 in im), split by symmetry.
  for (let i = 0; i < starts.length; i += 2) {
    const pair = i + 1 < starts.length;
    re.fill(0);
    im.fill(0);
    windowed(starts[i], re);
    if (pair) windowed(starts[i + 1], im);
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      const m = (n - k) % n;
      const xr = (re[k] + re[m]) / 2;
      const xi = (im[k] - im[m]) / 2;
      const yr = (im[k] + im[m]) / 2;
      const yi = (re[m] - re[k]) / 2;
      const pa = xr * xr + xi * xi;
      const pb = yr * yr + yi * yi;
      if (kept[i]) ltasPower[k] += pa;
      if (pair && kept[i + 1]) ltasPower[k] += pb;
      logA[k] = DB_PER_NEPER * Math.log(pa + 1e-20);
      logB[k] = DB_PER_NEPER * Math.log(pb + 1e-20);
      if (k > 0 && k < half) {
        logA[n - k] = logA[k];
        logB[n - k] = logB[k];
      }
    }
    re.set(logA);
    im.set(logB);
    fft(re, im); // both log spectra are real and even: their cepstra come out in re and im
    takeCepstrum(i, re);
    if (pair) takeCepstrum(i + 1, im);
  }

  // LTAS without the pre-emphasis: divide by |1 - a e^{-jw}|^2.
  const binHz = fs / n;
  const bands = [];
  const ratio = 2 ** (1 / ltasCfg.bandsPerOctave);
  for (let k = 0; ; k++) {
    const centreHz = ltasCfg.minHz * ratio ** k;
    if (centreHz * Math.sqrt(ratio) > 0.45 * fs) break;
    let p = 0;
    for (let bin = Math.ceil(centreHz / Math.sqrt(ratio) / binHz); bin * binHz < centreHz * Math.sqrt(ratio); bin++) {
      const w = (2 * Math.PI * bin) / n;
      p += ltasPower[bin] / (1 + a * a - 2 * a * Math.cos(w));
    }
    bands.push({ centreHz: Math.round(centreHz), p });
  }
  const total = bands.reduce((s, b) => s + b.p, 0);

  const grid = [];
  for (let t = cepCfg.fromSeconds; t <= cepCfg.toSeconds + 1e-12; t += cepCfg.stepSeconds) {
    const q = t * fs;
    const q0 = Math.floor(q);
    const frac = q - q0;
    const v = averaged ? ((1 - frac) * avgCepstrum[q0] + frac * avgCepstrum[q0 + 1]) / averaged : 0;
    grid.push(Math.round(10 * 10 * Math.log10(v + 1e-20)) / 10);
  }

  return {
    cpp: cpp.length ? mean(cpp) : null,
    cpps: cpps.length ? mean(cpps) : null,
    ltas: {
      centersHz: bands.map((b) => b.centreHz),
      db: bands.map((b) => (total > 0 && b.p > 0 ? 10 * Math.log10(b.p / total) : -Infinity)),
    },
    cepstrum: { fromSeconds: cepCfg.fromSeconds, stepSeconds: cepCfg.stepSeconds, db: grid },
  };
}

/**
 * Analyses one assessment recording: `leadInSeconds` of silence, then the task.
 * @param {Float32Array | Float64Array} samples
 * @param {number} sampleRate Hz
 * @param {{ task: 'VOWEL' | 'SPEECH', pressureScale?: number, config?: object }} options
 *   pressureScale = C_mic (Pa per digital unit) when the microphone is calibrated
 */
export function analyseVoiceSample(samples, sampleRate, { task, pressureScale = null, config } = {}) {
  if (!ASSESSMENT_TASKS.includes(task)) throw new RangeError(`task must be one of ${ASSESSMENT_TASKS.join(', ')}, got ${task}`);
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  const cfg = mergeConfig(config);
  const lead = Math.round(cfg.leadInSeconds * sampleRate);
  if (samples.length < lead + 0.5 * sampleRate) throw new RangeError('recording shorter than the lead-in plus 0.5 s');

  const body = samples.subarray(lead);
  let clipped = 0;
  for (let i = 0; i < body.length; i++) if (Math.abs(body[i]) >= cfg.quality.clipLevel) clipped++;
  const clipFraction = clipped / body.length;

  const { signal, sampleRate: fs } = decimate(samples, sampleRate, cfg.targetSampleRate);
  const leadIn = signal.subarray(0, Math.round(cfg.leadInSeconds * fs));
  const x = signal.subarray(leadIn.length);
  const frames = pitchTrack(x, fs, cfg.pitch, cfg.cepstral.pauseBelowDb);
  const voiced = frames.filter((f) => f.voiced);
  const voicedSeconds = voiced.length * cfg.pitch.stepSeconds;
  const hasVoice = voiced.length > 0;

  const levelDbfs = hasVoice ? energyMeanDb(voiced.map((f) => f.rms)) : null;
  const noiseDbfs = toDb(frameRms(leadIn));
  const snrDb = hasVoice ? levelDbfs - noiseDbfs : null;
  const cepstral = hasVoice ? cepstralAnalysis(x, fs, cfg.cepstral, cfg.ltas, cfg.cepstrum) : null;

  let perturb = { cycles: 0, jitterLocal: null, shimmerLocal: null };
  if (task === 'VOWEL' && hasVoice) {
    // Marks at the recording rate (finer period resolution than the 16 kHz analysis).
    const factor = sampleRate / fs;
    const { windowSeconds, stepSeconds } = cfg.pitch;
    const hop = Math.round(stepSeconds * fs);
    const size = Math.round(windowSeconds * fs);
    const runs = [];
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].voiced) continue;
      let j = i;
      while (j + 1 < frames.length && frames[j + 1].voiced) j++;
      runs.push([Math.round(frames[i].start * factor), Math.min(body.length, Math.round((frames[j].start + size) * factor))]);
      i = j;
    }
    const periodAt = (n) => {
      const k = Math.min(frames.length - 1, Math.max(0, Math.round((n / factor - size / 2) / hop)));
      const f0 = frames[k].f0 ?? voiced[0].f0;
      return sampleRate / f0;
    };
    perturb = perturbation(body, sampleRate, runs, periodAt, cfg.perturbation);
  }

  const q = cfg.quality;
  const reasons = [];
  if (!hasVoice || voicedSeconds < q.minVoicedSeconds[task]) reasons.push('too_little_voice');
  if (snrDb === null || snrDb < q.rejectSnrDb) reasons.push('low_snr');
  else if (snrDb < q.warnSnrDb) reasons.push('marginal_snr');
  if (clipFraction > q.maxClipFraction) reasons.push('clipping');
  const status = reasons.length === 0 ? 'ok' : reasons.every((r) => r === 'marginal_snr') ? 'warning' : 'rejected';

  return {
    task,
    durationSeconds: body.length / sampleRate,
    voicedSeconds,
    f0: hasVoice ? f0Summary(voiced.map((f) => f.f0)) : null,
    pitchConfidence: hasVoice ? mean(voiced.map((f) => f.periodicity)) : null,
    cpp: cepstral?.cpp ?? null,
    cpps: cepstral?.cpps ?? null,
    hnr: hasVoice ? harmonicsToNoise(x, fs, frames, cfg.hnr) : null,
    jitterLocal: perturb.jitterLocal,
    shimmerLocal: perturb.shimmerLocal,
    perturbationCycles: perturb.cycles,
    levelDbfs,
    splDb: hasVoice && pressureScale > 0 ? levelDbfs + 20 * Math.log10(pressureScale / REFERENCE_PRESSURE_PA) : null,
    snrDb,
    clipFraction,
    ltas: cepstral?.ltas ?? null,
    cepstrum: cepstral?.cepstrum ?? null,
    quality: { status, reasons },
    audioRetained: false,
    settings: {
      sampleRate,
      analysisSampleRate: fs,
      leadInSeconds: cfg.leadInSeconds,
      pitch: { ...cfg.pitch },
      cepstral: { ...cfg.cepstral },
      hnr: { ...cfg.hnr },
      perturbation: { ...cfg.perturbation },
    },
  };
}
