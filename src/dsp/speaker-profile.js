// Spec §6 — enrolment (up to 8 phonetic prototypes), statistical scoring, W_k smoothing.
//
// Each feature is standardised with the enrolment mean and spread, the standardised
// frames are clustered (k-means), and each cluster keeps its own per-dimension variance.
// A frame is scored by its normalised Mahalanobis distance to the nearest cluster,
// relative to the speaker's own typical distance on unseen speech:
//   delta = min_c (1/d) * sum_j (z_j - c_j)^2 / v_cj
//   score = exp(-delta / (SCORE_SCALE * delta_ref))
// delta_ref is the median distance of held-out enrolment frames (5-fold cross-validation
// over contiguous blocks), so a typical frame of the enrolled speaker scores about 0.8
// whatever her own variability, microphone or room. An absolute scale (v0.5.0) assumed
// delta ~ 0.3 and rejected most of a real voice, whose own delta is ~1 or more.
// Unlike the cosine of raw cepstra (v0.3), which is close to 1 for almost any voice, the
// distance grows when the spectral envelope departs from the enrolled speaker's.

export const DEFAULT_ENROLLMENT_CONFIG = Object.freeze({
  maxPrototypes: 8,
  iterations: 25,
  minDuration: 10, // s, checked only when frameDuration is given
});

/** Relative distance (delta / delta_ref) at which the score falls to 1/e:
 * score 0.80 at the speaker's typical distance, 0.75 at 1.3 times it, 0.70 at 1.6 times. */
export const SCORE_SCALE = 4.5;
/** Cross-validation folds of the enrolment and the minimum frames to run them. */
const CALIBRATION_FOLDS = 5;
const MIN_CALIBRATION_FRAMES = 20;
/** delta_ref floor: very stable (synthetic) enrolments would otherwise reject any change. */
const REFERENCE_DISTANCE_FLOOR = 0.25;
/** Floors that keep the model from becoming over-confident on a short enrolment. */
const SPREAD_FLOOR_RATIO = 0.1; // of the mean per-dimension spread
const ABSOLUTE_SPREAD_FLOOR = 1e-6;
const CLUSTER_VARIANCE_FLOOR = 0.25; // in standardised units

/**
 * F0 consistency: a voiced frame is attributed only if its F0 lies within the enrolled
 * range (2nd-98th percentile of normal and raised voice) widened by these factors, so a
 * louder voice than the enrolment still counts. Needs at least MIN_F0_FRAMES values.
 */
export const F0_MARGIN_UP = 1.25;
export const F0_MARGIN_DOWN = 1.3;
const MIN_F0_FRAMES = 20;

/**
 * Provisional thresholds with hysteresis: validate experimentally (spec §6.4). Set from a
 * field recording (2026-11-20): the speaker's own frames scored a median of 0.74 and the
 * other voice 0.48; accepting at 0.75 with slow smoothing attributed only 28 % of the own
 * voice, 0.65/0.60 with faster smoothing attributes about 90 %.
 */
export const DEFAULT_IDENTITY_CONFIG = Object.freeze({
  smoothing: 0.2, // EMA weight of the newest score (~5 frames, about 0.2 s at 48 kHz)
  acceptThreshold: 0.65,
  rejectThreshold: 0.6,
  resetAfterSeconds: 1, // forget the decision after this much time without valid voice
});

const squaredDistance = (a, b) => {
  let sum = 0;
  for (let j = 0; j < a.length; j++) sum += (a[j] - b[j]) ** 2;
  return sum;
};

function nearest(centroids, z) {
  let index = 0;
  let best = Infinity;
  centroids.forEach((c, i) => {
    const d = squaredDistance(c, z);
    if (d < best) [index, best] = [i, d];
  });
  return { index, distance: best };
}

const standardise = (vector, mean, scale) => Float64Array.from(vector, (v, j) => (v - mean[j]) / scale[j]);

/**
 * Builds a speaker profile: standardisation + k-means over valid voiced frames, with a
 * diagonal variance per cluster. Deterministic: seeded with the frame closest to the
 * mean, then farthest-point initialisation. Empty clusters are dropped.
 * @param {ArrayLike<number>[]} vectors spectral feature vectors of valid voiced frames
 * @param {{ maxPrototypes?: number, iterations?: number, frameDuration?: number, minDuration?: number,
 *   f0?: (number | null)[] }} [options] `f0` (Hz, one per vector) enables the F0 consistency check
 * @returns {{ dimension: number, mean: Float64Array, scale: Float64Array,
 *   prototypes: Float64Array[], variances: Float64Array[], counts: number[],
 *   referenceDistance: number, heldOutDistances: Float64Array[], f0Range: { low: number, high: number } | null }}
 */
export function enrollProfile(vectors, options = {}) {
  const { maxPrototypes, iterations, frameDuration, minDuration, f0 } = { ...DEFAULT_ENROLLMENT_CONFIG, ...options };
  if (!Number.isInteger(maxPrototypes) || maxPrototypes < 1) throw new RangeError('maxPrototypes must be an integer >= 1');
  if (vectors.length === 0) throw new RangeError('enrolment requires at least one feature vector');
  const dimension = vectors[0].length;
  if (vectors.some((v) => v.length !== dimension || Array.from(v).some((x) => !Number.isFinite(x)))) {
    throw new RangeError('feature vectors must be finite and share one dimension');
  }
  if (f0 !== undefined && f0.length !== vectors.length) {
    throw new RangeError(`f0 must have one value per feature vector (${f0.length} vs ${vectors.length})`);
  }
  if (frameDuration !== undefined && vectors.length * frameDuration < minDuration) {
    throw new RangeError(`enrolment needs >= ${minDuration} s of valid voice, got ${vectors.length * frameDuration} s`);
  }

  const model = fitModel(vectors, maxPrototypes, iterations);
  // Held-out distances, fold by fold in time order: how far the speaker's own unseen speech
  // falls from a model that did not see it.
  const heldOut = [];
  if (vectors.length >= MIN_CALIBRATION_FRAMES) {
    for (let k = 0; k < CALIBRATION_FOLDS; k++) {
      const a = Math.floor((k * vectors.length) / CALIBRATION_FOLDS);
      const b = Math.floor(((k + 1) * vectors.length) / CALIBRATION_FOLDS);
      const foldModel = fitModel([...vectors.slice(0, a), ...vectors.slice(b)], maxPrototypes, iterations);
      heldOut.push(Float64Array.from(vectors.slice(a, b), (v) => modelDistance(foldModel, v)));
    }
  }
  const all = heldOut.flatMap((fold) => Array.from(fold)).sort((x, y) => x - y);
  const referenceDistance = all.length ? Math.max(REFERENCE_DISTANCE_FLOOR, all[Math.floor(all.length / 2)]) : 1;
  return Object.freeze({ ...model, referenceDistance, heldOutDistances: heldOut, f0Range: f0Range(f0) });
}

function f0Range(values) {
  const valid = (values ?? []).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (valid.length < MIN_F0_FRAMES) return null;
  const at = (p) => valid[Math.round(p * (valid.length - 1))];
  return Object.freeze({ low: at(0.02), high: at(0.98) });
}

/** True when `f0` is compatible with the enrolled range (always true without range or F0). */
export function f0Consistent(profile, f0) {
  const range = profile?.f0Range;
  if (!range || !(f0 > 0)) return true;
  return f0 <= range.high * F0_MARGIN_UP && f0 >= range.low / F0_MARGIN_DOWN;
}

function fitModel(vectors, maxPrototypes, iterations) {
  const dimension = vectors[0].length;
  const n = vectors.length;
  const mean = new Float64Array(dimension);
  for (const v of vectors) for (let j = 0; j < dimension; j++) mean[j] += v[j] / n;
  const spread = new Float64Array(dimension);
  for (const v of vectors) for (let j = 0; j < dimension; j++) spread[j] += (v[j] - mean[j]) ** 2 / n;
  spread.forEach((v, j) => (spread[j] = Math.sqrt(v)));
  const floor = Math.max(ABSOLUTE_SPREAD_FLOOR, (SPREAD_FLOOR_RATIO * spread.reduce((a, b) => a + b, 0)) / dimension);
  const scale = Float64Array.from(spread, (s) => Math.max(s, floor));
  const Z = vectors.map((v) => standardise(v, mean, scale));

  const k = Math.min(maxPrototypes, n);
  const origin = new Float64Array(dimension);
  let centroids = [Z[nearest(Z, origin).index]];
  while (centroids.length < k) {
    let farthest = 0;
    let largest = -1;
    Z.forEach((z, i) => {
      const { distance } = nearest(centroids, z);
      if (distance > largest) [farthest, largest] = [i, distance];
    });
    centroids.push(Z[farthest]);
  }

  let assignment = new Int32Array(n).fill(-1);
  for (let iter = 0; iter < iterations; iter++) {
    const next = Int32Array.from(Z, (z) => nearest(centroids, z).index);
    const sums = centroids.map(() => new Float64Array(dimension));
    const sizes = new Array(centroids.length).fill(0);
    next.forEach((c, i) => {
      sizes[c] += 1;
      Z[i].forEach((v, j) => (sums[c][j] += v));
    });
    centroids = sums.map((s, c) => (sizes[c] ? s.map((v) => v / sizes[c]) : centroids[c]));
    const converged = next.every((c, i) => c === assignment[i]);
    assignment = next;
    if (converged) break;
  }

  const kept = centroids
    .map((c, index) => ({ c, members: Z.filter((_, i) => assignment[i] === index) }))
    .filter(({ members }) => members.length > 0);
  return {
    dimension,
    mean,
    scale,
    prototypes: kept.map(({ c }) => c),
    variances: kept.map(({ c, members }) =>
      Float64Array.from(c, (cj, j) =>
        Math.max(CLUSTER_VARIANCE_FLOOR, members.reduce((s, z) => s + (z[j] - cj) ** 2, 0) / members.length),
      ),
    ),
    counts: kept.map(({ members }) => members.length),
  };
}

function modelDistance(model, vector) {
  const z = standardise(vector, model.mean, model.scale);
  let best = Infinity;
  model.prototypes.forEach((c, i) => {
    const v = model.variances[i];
    let sum = 0;
    for (let j = 0; j < z.length; j++) sum += (z[j] - c[j]) ** 2 / v[j];
    best = Math.min(best, sum);
  });
  return best / model.dimension;
}



/** Normalised Mahalanobis distance of a frame to the nearest profile cluster. */
export function speakerDistance(profile, vector) {
  if (vector.length !== profile.dimension) {
    throw new RangeError(`vector dimension ${vector.length} does not match profile ${profile.dimension}`);
  }
  return modelDistance(profile, vector);
}

/** Speaker score in (0, 1]: 1 at a cluster centre, about 0.8 for a typical own frame. */
export function speakerScore(profile, vector) {
  return Math.exp(-speakerDistance(profile, vector) / (SCORE_SCALE * profile.referenceDistance));
}

/**
 * Share of the held-out enrolment frames that the identity decision would attribute to
 * the speaker with `identityConfig` (each fold replayed from a fresh state): an estimate
 * of how much of her own voice the profile will count. null when enrolment was too short
 * to cross-validate.
 */
export function ownAcceptance(profile, identityConfig = {}, frameDuration = 0.04) {
  const folds = profile.heldOutDistances ?? [];
  let accepted = 0;
  let total = 0;
  for (const fold of folds) {
    let state = createIdentityState();
    for (const delta of fold) {
      state = updateIdentity(state, Math.exp(-delta / (SCORE_SCALE * profile.referenceDistance)), frameDuration, identityConfig);
      accepted += state.W;
      total += 1;
    }
  }
  return total ? accepted / total : null;
}

export function createIdentityState() {
  return { smoothedScore: null, W: 0, idleTime: 0 };
}

/**
 * Temporal smoothing of W_k: EMA of the score plus accept/reject hysteresis.
 * Pass `score = null` for frames without valid voice; the decision is held
 * and reset after `resetAfterSeconds` of such frames.
 * @returns {{ smoothedScore: number | null, W: 0 | 1, idleTime: number }}
 */
export function updateIdentity(state, score, dt, config = {}) {
  const cfg = { ...DEFAULT_IDENTITY_CONFIG, ...config };
  if (cfg.rejectThreshold > cfg.acceptThreshold) throw new RangeError('rejectThreshold must be <= acceptThreshold');
  if (score === null) {
    const idleTime = state.idleTime + dt;
    return idleTime >= cfg.resetAfterSeconds ? createIdentityState() : { ...state, idleTime };
  }
  const smoothedScore =
    state.smoothedScore === null ? score : cfg.smoothing * score + (1 - cfg.smoothing) * state.smoothedScore;
  let W = state.W;
  if (W === 0 && smoothedScore >= cfg.acceptThreshold) W = 1;
  else if (W === 1 && smoothedScore < cfg.rejectThreshold) W = 0;
  return { smoothedScore, W, idleTime: 0 };
}
