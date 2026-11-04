// Spec §7-§8 — cumulative vocal-use metrics.

/** Frame categories (spec §7). Only `attributed` counts as phonation. */
export const FRAME_CATEGORIES = Object.freeze([
  'attributed',
  'unattributed_voice',
  'noise',
  'silence',
  'uncertain',
]);

const emptyRuns = () => ({ count: 0, totalDuration: 0, maxDuration: 0, currentDuration: 0 });

export function createUsageMetrics() {
  return {
    totalTime: 0,
    phonationTime: 0,
    nonPhonationTime: 0,
    timeByCategory: Object.fromEntries(FRAME_CATEGORIES.map((c) => [c, 0])),
    episodes: emptyRuns(),
    pauses: emptyRuns(),
    pendingPause: 0,
    lastPhi: null,
  };
}

function extendRun(runs, dt, isNewRun) {
  const currentDuration = isNewRun ? dt : runs.currentDuration + dt;
  return {
    count: runs.count + (isNewRun ? 1 : 0),
    totalDuration: runs.totalDuration + dt,
    maxDuration: Math.max(runs.maxDuration, currentDuration),
    currentDuration,
  };
}

function commitPause(pauses, duration) {
  if (duration === 0) return pauses;
  return {
    count: pauses.count + 1,
    totalDuration: pauses.totalDuration + duration,
    maxDuration: Math.max(pauses.maxDuration, duration),
    currentDuration: duration,
  };
}

/**
 * Pure reducer: returns new metrics after one frame.
 * An episode is a maximal run of Phi = 1 frames. A pause is a maximal run of
 * Phi = 0 frames *between* two episodes: non-phonation before the first
 * episode is never a pause, and the run after the last episode stays in
 * `pendingPause` until the next episode closes it. Zero-length frames are
 * ignored so they cannot split or open runs.
 */
export function updateUsageMetrics(metrics, { phi, dt, category }) {
  if (dt === 0) return metrics;
  const isPhonation = phi === 1;
  const resolvedCategory = isPhonation ? 'attributed' : category ?? 'uncertain';
  if (!FRAME_CATEGORIES.includes(resolvedCategory) || (!isPhonation && resolvedCategory === 'attributed')) {
    throw new RangeError(`invalid category "${category}" for phi=${phi}`);
  }
  const isNewRun = metrics.lastPhi !== (isPhonation ? 1 : 0);
  return {
    totalTime: metrics.totalTime + dt,
    phonationTime: metrics.phonationTime + (isPhonation ? dt : 0),
    nonPhonationTime: metrics.nonPhonationTime + (isPhonation ? 0 : dt),
    timeByCategory: {
      ...metrics.timeByCategory,
      [resolvedCategory]: metrics.timeByCategory[resolvedCategory] + dt,
    },
    episodes: isPhonation ? extendRun(metrics.episodes, dt, isNewRun) : metrics.episodes,
    pauses: isPhonation ? commitPause(metrics.pauses, metrics.pendingPause) : metrics.pauses,
    pendingPause: isPhonation || metrics.episodes.count === 0 ? 0 : metrics.pendingPause + dt,
    lastPhi: isPhonation ? 1 : 0,
  };
}

/** Porcentaje_fonacion = 100 * T_fonacion / (T_fonacion + T_no_fonacion); 0 when no time elapsed. */
export function phonationPercentage({ phonationTime, nonPhonationTime }) {
  const total = phonationTime + nonPhonationTime;
  return total === 0 ? 0 : (100 * phonationTime) / total;
}

export function nonPhonationPercentage(metrics) {
  const total = metrics.phonationTime + metrics.nonPhonationTime;
  return total === 0 ? 0 : 100 - phonationPercentage(metrics);
}

/** Mean duration of runs; 0 when none. */
export const meanDuration = ({ count, totalDuration }) => (count === 0 ? 0 : totalDuration / count);
