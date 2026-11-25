// Dose recomputation from the per-second series of a workday (perSecond, src/store/second-series.js)
// for Analítica: the same recorded workdays with other parameters, without recording again.
// The records are only read; the recomputed doses live in new objects.
//
// Second by second, with the memory functions and parameter rules of the engine
// (src/math/dose-models.js):
//   H_k = H_(k-1)·e^(−β) + phonation_k          (the engine's update over one second)
//   D_m += phonation_k · f0I_k · f_m(H_k)
// so D0 is the sum of phonation_k · f0I_k. Within a second H is taken at its end, which is the
// only difference with the per-frame engine: the series does not say how the voice was spread
// inside each second. Measured against the engine, the doses with memory differ by about 0.1 %
// with β = 0.005 s⁻¹, 1 % with 0.03 and 2-3 % with 0.1; D0 is exact to the stored rounding.
import { DOSE_MODELS, memoryFunctions, resolveModelParams } from '../math/dose-models.js';
import { rocCurve, spearman } from './inference.js';
import { outcomeCase, outcomeValue } from './outcomes.js';

/**
 * Search ranges and initial values of the adjustable parameters (Parámetros de f(H), §2 and
 * §16): memory (β), linear (α_L), power (a, p), exponential (α_E) and saturating (A, K_H).
 */
export const PARAM_RANGES = Object.freeze({
  beta: Object.freeze({ min: 0.005, max: 0.1, step: 0.005, initial: 0.03 }),
  alphaL: Object.freeze({ min: 0.005, max: 0.1, step: 0.005, initial: 0.05 }),
  a: Object.freeze({ min: 0.1, max: 3, step: 0.05, initial: 1 }),
  p: Object.freeze({ min: 0.5, max: 3, step: 0.05, initial: 2 }),
  alphaE: Object.freeze({ min: 0.002, max: 0.06, step: 0.001, initial: 0.025 }),
  A: Object.freeze({ min: 0.25, max: 6, step: 0.05, initial: 3 }),
  kH: Object.freeze({ min: 5, max: 120, step: 1, initial: 40 }),
});

/**
 * H_ref of the power model, fixed and not adjusted (Parámetros de f(H), §7: a, p and H_ref
 * compensate each other, so H_ref is fixed before estimating the rest).
 */
export const FIXED_H_REF = 20;

/** Models recomputed from the series (the distance dose needs SPL, which the series does not keep). */
export const RECOMPUTED_MODELS = DOSE_MODELS;

function checkRange(name, value) {
  const r = PARAM_RANGES[name];
  if (typeof value !== 'number' || !(value >= r.min - 1e-12 && value <= r.max + 1e-12)) {
    throw new RangeError(`${name} must be in ${r.min}-${r.max}, got ${value}`);
  }
}

/**
 * Full parameter set for a recomputation: each adjustable parameter as given (inside
 * PARAM_RANGES) or its initial value, and H_ref = FIXED_H_REF unless given. Every shape is
 * explicit, so moving β changes only the memory, never the shape of f(H).
 */
export function recomputeParams(params = {}) {
  const chosen = {};
  for (const [name, r] of Object.entries(PARAM_RANGES)) {
    const value = params[name] ?? r.initial;
    checkRange(name, value);
    chosen[name] = value;
  }
  return resolveModelParams({ ...chosen, hRef: params.hRef ?? FIXED_H_REF });
}

/**
 * Every dose model of one per-second series.
 * @param {{ phonation: number[], f0I: number[] }} perSecond
 * @param {{ beta?: number, alphaL?: number }} params
 * @returns {Record<string, number>}
 */
export function recomputeDoses(perSecond, params = {}) {
  const p = recomputeParams(params);
  const decay = Math.exp(-p.beta);
  const doses = Object.fromEntries(DOSE_MODELS.map((m) => [m, 0]));
  let h = 0;
  const { phonation, f0I } = perSecond;
  for (let k = 0; k < phonation.length; k++) {
    h = h * decay + phonation[k];
    const base = phonation[k] * f0I[k];
    if (base === 0) continue;
    for (const m of DOSE_MODELS) doses[m] += base * memoryFunctions[m](h, p);
  }
  return doses;
}

/**
 * Recomputed doses of the workdays that have a per-second series; the others (recorded before
 * it existed, imported or demo) are returned apart. The workdays are not modified.
 * @returns {{ params: object, entries: { workday: object, doses: Record<string, number> }[], withoutSeries: object[] }}
 */
export function recomputeWorkdays(workdays, params = {}) {
  const resolved = recomputeParams(params);
  const entries = [];
  const withoutSeries = [];
  for (const w of workdays) {
    if (w.perSecond?.phonation?.length) entries.push({ workday: w, doses: recomputeDoses(w.perSecond, params) });
    else withoutSeries.push(w);
  }
  return { params: resolved, entries, withoutSeries };
}

/**
 * Each recomputed model against the outcome, next to D0: Spearman ρ with the outcome value,
 * the ROC AUC (95 % CI) for the case rule and its difference with D0's AUC.
 */
export function compareModels(entries, outcomeKey, threshold) {
  const values = entries.map((e) => outcomeValue(e.workday, outcomeKey));
  const labels = entries.map((e) => outcomeCase(e.workday, outcomeKey, threshold));
  const models = {};
  for (const m of RECOMPUTED_MODELS) {
    const doses = entries.map((e) => e.doses[m]);
    const roc = rocCurve(doses, labels);
    models[m] = { rho: spearman(doses, values), auc: roc.auc, ci: roc.ci };
  }
  for (const m of RECOMPUTED_MODELS) models[m].deltaAuc = models[m].auc - models.none.auc;
  return {
    n: entries.length,
    cases: labels.filter((l) => l === 1).length,
    controls: labels.filter((l) => l === 0).length,
    models,
  };
}
