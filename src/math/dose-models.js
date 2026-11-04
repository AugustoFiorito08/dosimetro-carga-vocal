// Spec §11 — cumulative dose models.
import { assertFinite, assertFiniteNonNegative, assertFinitePositive } from './validation.js';

export const DOSE_MODELS = Object.freeze(['none', 'linear', 'power', 'exponential', 'saturating']);

/**
 * Provisional defaults. The spec (§11.5) requires every parameter to be
 * identified and validated experimentally; these are placeholders only.
 * H is measured in seconds of recent phonation.
 */
export const DEFAULT_MODEL_PARAMS = Object.freeze({
  beta: 1 / 300, // s^-1 -> tau = 300 s
  alphaL: 0.01, // s^-1
  a: 1,
  p: 2,
  hRef: 60, // s
  alphaE: 0.01, // s^-1
  A: 1,
  kH: 60, // s
});

export function resolveModelParams(overrides = {}) {
  const params = { ...DEFAULT_MODEL_PARAMS, ...overrides };
  assertFiniteNonNegative('beta', params.beta);
  assertFinite('alphaL', params.alphaL);
  assertFinite('a', params.a);
  assertFinitePositive('p', params.p);
  assertFinitePositive('hRef', params.hRef);
  assertFinite('alphaE', params.alphaE);
  assertFinite('A', params.A);
  assertFinitePositive('kH', params.kH);
  return Object.freeze(params);
}

/** Memory functions f(H) for each model. */
export const memoryFunctions = Object.freeze({
  none: () => 1,
  linear: (h, { alphaL }) => 1 + alphaL * h,
  power: (h, { a, p, hRef }) => 1 + a * (h / hRef) ** p,
  exponential: (h, { alphaE }) => Math.exp(alphaE * h),
  saturating: (h, { A, kH }) => 1 + (A * h) / (kH + h),
});

/**
 * Dose increments for one frame: F0_k * I_k * Phi_k * f(H_k) * Delta_t.
 * When Phi_k = 0 every increment is exactly 0, even if F0/I are missing.
 * @returns {{none:number, linear:number, power:number, exponential:number, saturating:number}}
 */
export function doseIncrements({ f0, intensity, phi, h, dt }, params) {
  if (phi !== 1 || dt === 0) {
    return { none: 0, linear: 0, power: 0, exponential: 0, saturating: 0 };
  }
  assertFiniteNonNegative('F0_k', f0);
  assertFiniteNonNegative('I_k', intensity);
  assertFiniteNonNegative('H_k', h);
  assertFiniteNonNegative('Delta_t', dt);
  const base = f0 * intensity * dt;
  const out = {};
  for (const model of DOSE_MODELS) out[model] = base * memoryFunctions[model](h, params);
  return out;
}
