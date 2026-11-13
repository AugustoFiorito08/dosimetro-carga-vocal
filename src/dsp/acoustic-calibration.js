// Acoustic calibration (protocol §10.1): P_RMS = C_mic * A_digital, with C_mic obtained
// from a reference tone of known level (acoustic calibrator or a steady tone read with
// a sound level meter), and the pre/post drift of C_mic.

/** Reference pressure of dB SPL, Pa. */
export const REFERENCE_PRESSURE_PA = 20e-6;

/**
 * Provisional limits: the protocol requires preregistering them after bench validation.
 * - referenceDbSpl: 94 dB SPL (~1 Pa), the usual calibrator level at 1 kHz.
 * - maxLevelStdDb: a reference tone must be steady; larger spread means a bad capture.
 * - driftToleranceDb: maximum |pre - post| difference for a valid session.
 */
export const DEFAULT_CALIBRATION_CONFIG = Object.freeze({
  referenceDbSpl: 94,
  minSeconds: 3,
  maxLevelStdDb: 0.5,
  clipPeak: 0.999,
  driftToleranceDb: 0.5,
});

/** Rejected capture. `reason` is one of: too_short, clipping, silent, unstable. */
export class CalibrationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'CalibrationError';
    this.reason = reason;
  }
}

export const pressureFromSpl = (dbSpl) => REFERENCE_PRESSURE_PA * 10 ** (dbSpl / 20);

export const splFromPressure = (pressurePa) => 20 * Math.log10(pressurePa / REFERENCE_PRESSURE_PA);

/**
 * @param {{ rms: number, peak: number, dt: number }[]} frames frames of the reference tone
 * @param {object} [config] see DEFAULT_CALIBRATION_CONFIG
 * @returns {{ coefficient: number, aDigital: number, referenceDbSpl: number, referencePa: number,
 *   levelStdDb: number, duration: number }} coefficient = C_mic in Pa per digital unit
 */
export function computeCalibration(frames, config = {}) {
  const cfg = { ...DEFAULT_CALIBRATION_CONFIG, ...config };
  if (typeof cfg.referenceDbSpl !== 'number' || !Number.isFinite(cfg.referenceDbSpl)) {
    throw new RangeError(`referenceDbSpl must be a finite number, got ${cfg.referenceDbSpl}`);
  }
  const duration = frames.reduce((sum, f) => sum + f.dt, 0);
  if (duration < cfg.minSeconds - 1e-9) {
    throw new CalibrationError('too_short', `need ${cfg.minSeconds} s of reference tone, got ${duration.toFixed(2)} s`);
  }
  if (frames.some((f) => f.peak >= cfg.clipPeak)) {
    throw new CalibrationError('clipping', 'the reference tone clips the input; lower the input gain');
  }
  const energy = frames.reduce((sum, f) => sum + f.rms * f.rms * f.dt, 0) / duration;
  const aDigital = Math.sqrt(energy);
  if (!(aDigital > 0) || frames.some((f) => !(f.rms > 0))) {
    throw new CalibrationError('silent', 'no reference tone detected');
  }
  const levels = frames.map((f) => 20 * Math.log10(f.rms));
  const meanLevel = levels.reduce((sum, l, i) => sum + l * frames[i].dt, 0) / duration;
  const levelStdDb = Math.sqrt(levels.reduce((sum, l, i) => sum + (l - meanLevel) ** 2 * frames[i].dt, 0) / duration);
  if (levelStdDb > cfg.maxLevelStdDb) {
    throw new CalibrationError('unstable', `reference level varies ${levelStdDb.toFixed(2)} dB (max ${cfg.maxLevelStdDb} dB)`);
  }
  const referencePa = pressureFromSpl(cfg.referenceDbSpl);
  return {
    coefficient: referencePa / aDigital,
    aDigital,
    referenceDbSpl: cfg.referenceDbSpl,
    referencePa,
    levelStdDb,
    duration,
  };
}

/**
 * δC = 100 * (C_post - C_pre) / C_pre, also expressed in dB.
 * @returns {{ percent: number, db: number, toleranceDb: number, withinTolerance: boolean }}
 */
export function calibrationDrift(pre, post, { toleranceDb = DEFAULT_CALIBRATION_CONFIG.driftToleranceDb } = {}) {
  const ratio = post.coefficient / pre.coefficient;
  const db = 20 * Math.log10(ratio);
  return { percent: 100 * (ratio - 1), db, toleranceDb, withinTolerance: Math.abs(db) <= toleranceDb };
}
