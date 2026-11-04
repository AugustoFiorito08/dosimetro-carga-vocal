// Spec §9 — dynamic recent-load state.
import { assertFiniteNonNegative } from './validation.js';

/**
 * H_k = H_(k-1) * exp(-beta * Delta_t) + Phi_k * Delta_t
 * @param {number} previousH H_(k-1), >= 0
 * @param {0 | 1} phi accepted phonation
 * @param {number} dt Delta_t in seconds, >= 0
 * @param {number} beta recovery constant in s^-1, >= 0 (0 = no recovery)
 */
export function updateLoadState(previousH, phi, dt, beta) {
  assertFiniteNonNegative('H_(k-1)', previousH);
  assertFiniteNonNegative('Delta_t', dt);
  assertFiniteNonNegative('beta', beta);
  return previousH * Math.exp(-beta * dt) + (phi === 1 ? 1 : 0) * dt;
}

/** tau = 1 / beta. Infinity when beta = 0 (no recovery). */
export function timeConstant(beta) {
  assertFiniteNonNegative('beta', beta);
  return beta === 0 ? Infinity : 1 / beta;
}

/** t_1/2 = ln(2) / beta. Infinity when beta = 0 (no recovery). */
export function halfLife(beta) {
  assertFiniteNonNegative('beta', beta);
  return beta === 0 ? Infinity : Math.LN2 / beta;
}
