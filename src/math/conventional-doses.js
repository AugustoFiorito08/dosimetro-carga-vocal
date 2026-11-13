// Conventional vocal doses (Titze, Svec & Popolo, 2003): literature anchors that
// carry no memory term, used to compare exposures with equal conventional dose.
import { assertFiniteNonNegative } from './validation.js';

export const CONVENTIONAL_DOSES = Object.freeze(['time', 'cycle']);

export const createConventionalDoses = () => ({ time: 0, cycle: 0 });

/**
 * Per-frame increments:
 *   time dose  D_t: Phi_k * Delta_t          (s)
 *   cycle dose D_c: Phi_k * F0_k * Delta_t   (vibratory cycles)
 * The distance dose needs calibrated SPL and is left for the calibration phase.
 * @returns {{ time: number, cycle: number }}
 */
export function conventionalDoseIncrements({ f0, phi, dt }) {
  assertFiniteNonNegative('Delta_t', dt);
  if (phi !== 1 || dt === 0) return { time: 0, cycle: 0 };
  assertFiniteNonNegative('F0_k', f0);
  return { time: dt, cycle: f0 * dt };
}
