// Spec §11 — cumulative dose models.
import { assertFinite, assertFiniteNonNegative, assertFinitePositive } from './validation.js';

export const DOSE_MODELS = Object.freeze(['none', 'linear', 'power', 'exponential', 'saturating']);

/** Default recovery constant: beta = 1/300 s^-1 -> tau = 300 s. */
export const DEFAULT_BETA = 1 / 300;

/**
 * Default anchor. Every memory function satisfies f(0) = 1 and f(H*) = f*, so
 * the candidates are comparable and differ only in curvature. H* defaults to
 * tau = 1/beta: under continuous phonation H tends to ~tau, so f* is the
 * largest amplification any candidate can reach on the reachable domain.
 * These are placeholders; spec §11 requires experimental identification.
 */
export const DEFAULT_ANCHOR = Object.freeze({ fStar: 2, p: 2 });

const FALLBACK_H_STAR = 1 / DEFAULT_BETA; // used when beta = 0 (tau is infinite)

/**
 * Shape parameters such that f(0) = 1 and f(H*) = f* for every memory function.
 * @param {object} [anchor]
 * @param {number} [anchor.beta=DEFAULT_BETA] s^-1, >= 0
 * @param {number} [anchor.hStar=1/beta] H* in s (300 s when beta = 0)
 * @param {number} [anchor.fStar=2] f* >= 1
 * @param {number} [anchor.p=2] power-model exponent
 * @param {number} [anchor.kH=hStar] saturating half-effect constant, s
 */
export function anchorModelParams({ beta = DEFAULT_BETA, hStar, fStar = DEFAULT_ANCHOR.fStar, p = DEFAULT_ANCHOR.p, kH } = {}) {
  assertFiniteNonNegative('beta', beta);
  const h = hStar ?? (beta === 0 ? FALLBACK_H_STAR : 1 / beta);
  assertFinitePositive('hStar', h);
  assertFinite('fStar', fStar);
  if (fStar < 1) throw new RangeError(`fStar must be >= 1, got ${fStar}`);
  assertFinitePositive('p', p);
  const k = kH ?? h;
  assertFinitePositive('kH', k);
  return {
    beta,
    hStar: h,
    fStar,
    alphaL: (fStar - 1) / h,
    a: fStar - 1,
    p,
    hRef: h,
    alphaE: Math.log(fStar) / h,
    A: ((fStar - 1) * (k + h)) / h,
    kH: k,
  };
}

/**
 * Resolves model parameters. Anchor inputs (beta, hStar, fStar, p, kH) derive
 * the shape parameters; explicit shape parameters (alphaL, a, hRef, alphaE, A)
 * override the derived ones.
 */
export function resolveModelParams(overrides = {}) {
  const { beta, hStar, fStar, p, kH } = overrides;
  const params = { ...anchorModelParams({ beta, hStar, fStar, p, kH }), ...stripUndefined(overrides) };
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

const stripUndefined = (object) => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));

export const DEFAULT_MODEL_PARAMS = resolveModelParams();

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
