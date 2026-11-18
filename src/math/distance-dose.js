// Vibratory distance dose D_d (Titze, Švec & Popolo, 2003, JSLHR 46:919-932):
// total path travelled by the vocal folds, from F0 and the SPL at 0.5 m from the mouth.
import { splFromPressure } from '../dsp/acoustic-calibration.js';
import { assertFinite, assertFiniteNonNegative, assertFinitePositive } from './validation.js';

/** Eq. 14 (L0, reference vocal-fold length, m) and eq. 15 (F0N, nominal speaking F0, Hz). */
export const VOCAL_FOLD_PROFILES = Object.freeze({
  male: Object.freeze({ l0: 0.016, f0n: 120 }),
  female: Object.freeze({ l0: 0.01, f0n: 190 }),
});

/** Distance from the mouth at which eq. 16 expects the SPL, m. */
export const PAPER_SPL_DISTANCE_M = 0.5;

function profileOf(name) {
  const profile = VOCAL_FOLD_PROFILES[name];
  if (!profile) throw new RangeError(`profile must be "male" or "female", got ${name}`);
  return profile;
}

/** Eq. 15: P_th = 0.14 + 0.06 (F0 / F0N)^2, kPa. */
export function phonationThresholdPressure(f0, profileName) {
  const { f0n } = profileOf(profileName);
  return 0.14 + 0.06 * (f0 / f0n) ** 2;
}

/** Eq. 16: P_L = P_th + 10^((SPL - 78.5) / 27.3), kPa, with SPL in dB at 0.5 m. */
export function lungPressure(f0, spl50cm, profileName) {
  return phonationThresholdPressure(f0, profileName) + 10 ** ((spl50cm - 78.5) / 27.3);
}

/** Eq. 14: A = 0.05 L0 [(P_L - P_th) / P_th]^(1/2), m. */
export function vibrationAmplitude(f0, spl50cm, profileName) {
  const { l0 } = profileOf(profileName);
  const pth = phonationThresholdPressure(f0, profileName);
  const excess = lungPressure(f0, spl50cm, profileName) - pth;
  return 0.05 * l0 * Math.sqrt(excess / pth);
}

/**
 * SPL_mic - SPL_0.5m under inverse-distance (spherical) spreading from a point source.
 * An approximation: close to the mouth the field is not spherical, so a measured offset
 * (sustained vowel recorded at the microphone and by a sound level meter at 0.5 m) is preferred.
 */
export function inverseDistanceOffsetDb(mouthDistanceM) {
  assertFinitePositive('mouthDistanceM', mouthDistanceM);
  return 20 * Math.log10(PAPER_SPL_DISTANCE_M / mouthDistanceM);
}

/**
 * @param {{ profile: 'male' | 'female', spl50cmOffsetDb?: number, mouthDistanceM?: number }} options
 *   exactly one of spl50cmOffsetDb (measured SPL_mic - SPL_0.5m) or mouthDistanceM (approximation)
 */
export function resolveDistanceDoseOptions({ profile, spl50cmOffsetDb, mouthDistanceM } = {}) {
  profileOf(profile);
  const measured = spl50cmOffsetDb !== undefined;
  const byDistance = mouthDistanceM !== undefined;
  if (measured === byDistance) {
    throw new RangeError('give exactly one of spl50cmOffsetDb (measured) or mouthDistanceM (approximation)');
  }
  if (measured) {
    assertFinite('spl50cmOffsetDb', spl50cmOffsetDb);
    return { profile, offsetDb: spl50cmOffsetDb, offsetSource: 'measured' };
  }
  return { profile, offsetDb: inverseDistanceOffsetDb(mouthDistanceM), offsetSource: 'inverse_distance', mouthDistanceM };
}

/**
 * Eq. 22 for one frame: 4 * k_v * A * F0 * dt, m. k_v is the accepted phonation Phi_k.
 * @param {{ f0: number, splMic: number, phi: 0 | 1, dt: number }} frame splMic in dB SPL at the microphone
 */
export function distanceDoseIncrement({ f0, splMic, phi, dt }, options) {
  assertFiniteNonNegative('Delta_t', dt);
  if (phi !== 1 || dt === 0 || splMic === -Infinity) return 0;
  assertFiniteNonNegative('F0_k', f0);
  assertFinite('SPL', splMic);
  return 4 * vibrationAmplitude(f0, splMic - options.offsetDb, options.profile) * f0 * dt;
}

/** dB SPL at the microphone of a calibrated pressure in Pa; -Infinity for silence. */
export const splAtMicrophone = (pressurePa) => (pressurePa > 0 ? splFromPressure(pressurePa) : -Infinity);
