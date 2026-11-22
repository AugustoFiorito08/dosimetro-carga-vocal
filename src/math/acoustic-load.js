// Spec §10 — normalized acoustic load.
import { assertFiniteNonNegative, assertFinitePositive } from './validation.js';

/**
 * I_k = (P_k / P_0)^2
 * Without calibration, P_k is a relative magnitude and P_0 defaults to 1, so
 * I_k must be labelled as relative (see `acousticLoadUnits`).
 * @param {number} pressure P_k (Pa when calibrated, relative magnitude otherwise)
 * @param {number} [reference=1] P_0, > 0
 */
export function normalizedAcousticLoad(pressure, reference = 1) {
  assertFiniteNonNegative('P_k', pressure);
  assertFinitePositive('P_0', reference);
  const ratio = pressure / reference;
  return ratio * ratio;
}

/**
 * 'calibrated': P_k in Pa; 'normalized': P_k relative to the speaker's own normal voice
 * (I = 1 at that voice, spec §10.1); 'relative': uncalibrated digital magnitude.
 * @returns {'calibrated' | 'normalized' | 'relative'}
 */
export function acousticLoadUnits(calibrated, normalized = false) {
  if (calibrated === true) return 'calibrated';
  return normalized === true ? 'normalized' : 'relative';
}
