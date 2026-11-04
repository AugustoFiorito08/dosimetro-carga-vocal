// Spec §5/§7 — frame energy, crest factor, adaptive noise floor, SNR and Q_k.

/** Provisional thresholds: they must be validated experimentally (spec §20). */
export const DEFAULT_QUALITY_CONFIG = Object.freeze({
  absoluteSilenceRms: 1e-5, // below this the frame is digital silence
  gateSnrDb: 6, // adaptive gate: frames under floor + gate are silence
  minSnrDb: 15, // Q_k requires at least this SNR
  maxCrestFactor: 8, // peak / RMS above this is an impulsive transient
  minNoiseFloorRms: 1e-6,
  noiseFloorFallRate: 0.3, // fraction of the gap closed per frame when level < floor
  noiseFloorRiseDbPerSecond: 1, // slow upward drift while no voice is present
});

const DB_FLOOR = 1e-12;

export const toDb = (amplitude) => 20 * Math.log10(Math.max(amplitude, DB_FLOOR));
export const fromDb = (db) => 10 ** (db / 20);

export function frameRms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function framePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/** Peak / RMS. 0 for an all-zero frame (no transient to reject). */
export function crestFactor(samples) {
  const rms = frameRms(samples);
  return rms === 0 ? 0 : framePeak(samples) / rms;
}

export function snrDb(rms, noiseFloorRms) {
  return toDb(rms) - toDb(noiseFloorRms);
}

/** Initial floor from >= 5 s of ambient frames (spec §16): median RMS. */
export function calibrateNoiseFloor(rmsValues, config = {}) {
  const { minNoiseFloorRms } = { ...DEFAULT_QUALITY_CONFIG, ...config };
  if (rmsValues.length === 0) throw new RangeError('calibration requires at least one frame');
  const sorted = [...rmsValues].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.max(minNoiseFloorRms, median);
}

/**
 * Minimum-tracking noise floor in the dB domain: falls quickly toward quieter
 * frames, rises slowly otherwise, and is frozen while voice is present.
 * @returns {number} new floor RMS
 */
export function updateNoiseFloor(floorRms, rms, { dt, voicePresent }, config = {}) {
  const cfg = { ...DEFAULT_QUALITY_CONFIG, ...config };
  const floorDb = toDb(floorRms);
  const levelDb = toDb(rms);
  let next = floorDb;
  if (levelDb < floorDb) next = floorDb + cfg.noiseFloorFallRate * (levelDb - floorDb);
  else if (!voicePresent) next = floorDb + Math.min(levelDb - floorDb, cfg.noiseFloorRiseDbPerSecond * dt);
  return Math.max(cfg.minNoiseFloorRms, fromDb(next));
}

/**
 * Q_k: 1 when SNR and crest factor are in valid ranges.
 * @returns {{ Q: 0 | 1, reason: null | 'below_gate' | 'impulsive' | 'low_snr' }}
 */
export function assessQuality({ rms, crest, snr }, config = {}) {
  const cfg = { ...DEFAULT_QUALITY_CONFIG, ...config };
  if (rms < cfg.absoluteSilenceRms || snr < cfg.gateSnrDb) return { Q: 0, reason: 'below_gate' };
  if (crest > cfg.maxCrestFactor) return { Q: 0, reason: 'impulsive' };
  if (snr < cfg.minSnrDb) return { Q: 0, reason: 'low_snr' };
  return { Q: 1, reason: null };
}
