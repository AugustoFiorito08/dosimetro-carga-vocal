// Outcomes of the dose-response analysis (Analítica): the end-of-workday fatigue change ΔF
// and the recovery indices AUC_F (0-4 h, comparable) and T90 (src/stats/recovery.js). Each
// one has a value per workday (NaN when unknown) and a case rule (1, 0 or null) for the ROC.
import { recoveryIndices } from './recovery.js';

export const OUTCOMES = Object.freeze({
  deltaF: Object.freeze({
    label: 'ΔF · cambio de fatiga (EVA post − pre)', short: 'ΔEVA', unit: 'pts',
    thresholdKey: 'caseThreshold', defaultThreshold: 20, min: 1, max: 100,
    caseText: (t) => `ΔEVA ≥ ${t}`, thresholdText: 'Caso: aumento de EVA ≥', thresholdUnit: 'puntos',
  }),
  aucF: Object.freeze({
    label: 'AUC_F · fatiga residual de 0 a 4 h', short: 'AUC_F', unit: 'EVA·h',
    thresholdKey: 'aucThreshold', defaultThreshold: 20, min: 1, max: 400,
    caseText: (t) => `AUC_F ≥ ${t} EVA·h`, thresholdText: 'Caso: AUC_F ≥', thresholdUnit: 'EVA·h',
  }),
  t90: Object.freeze({
    label: 'T₉₀ · tiempo hasta recuperar el 90 %', short: 'T₉₀', unit: 'min',
    thresholdKey: 't90Threshold', defaultThreshold: 240, min: 30, max: 2160,
    caseText: (t) => `T₉₀ > ${t} min`, thresholdText: 'Caso: 90 % no recuperado a los', thresholdUnit: 'min',
  }),
});

const indices = (w) => recoveryIndices({ pre: w.fatigue?.pre ?? null, post: w.fatigue?.post ?? null, points: w.fatigue?.recovery ?? [] });
const orNaN = (v) => (Number.isFinite(v) ? v : NaN);

/** Value of the outcome for one workday; NaN when unknown (a censored T90 included). */
export function outcomeValue(w, outcome) {
  if (outcome === 'deltaF') return w.fatigue?.pre == null || w.fatigue?.post == null ? NaN : w.fatigue.post - w.fatigue.pre;
  const r = indices(w);
  if (outcome === 'aucF') return orNaN(r.aucF4h);
  if (outcome === 't90') return orNaN(r.t90Min);
  throw new RangeError(`unknown outcome ${outcome}`);
}

/**
 * 1 (case), 0 (control) or null (unknown). T90: a case when 90 % was not recovered by the
 * threshold, which a censored time shows only if the workday was followed that long; a
 * workday whose fatigue did not rise has nothing left to recover (a control).
 */
export function outcomeCase(w, outcome, threshold) {
  if (outcome === 't90') {
    const r = indices(w);
    if (r.deltaF === null || !r.points.length) return null;
    if (r.deltaF <= 0) return 0;
    if (Number.isFinite(r.t90Min)) return r.t90Min > threshold ? 1 : 0;
    return r.horizonMin >= threshold ? 1 : null;
  }
  const v = outcomeValue(w, outcome);
  return Number.isFinite(v) ? (v >= threshold ? 1 : 0) : null;
}
