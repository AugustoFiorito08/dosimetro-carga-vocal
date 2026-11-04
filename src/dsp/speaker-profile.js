// Spec §6 — enrolment (up to 8 phonetic prototypes), cosine scoring, W_k smoothing.

export const DEFAULT_ENROLLMENT_CONFIG = Object.freeze({
  maxPrototypes: 8,
  iterations: 25,
  minDuration: 10, // s, checked only when frameDuration is given
});

/** Provisional thresholds with hysteresis: validate experimentally (spec §6.4). */
export const DEFAULT_IDENTITY_CONFIG = Object.freeze({
  smoothing: 0.2, // EMA weight of the newest score: one outlier frame cannot cross the reject threshold
  acceptThreshold: 0.85,
  rejectThreshold: 0.75,
  resetAfterSeconds: 1, // forget the decision after this much time without valid voice
});

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new RangeError(`dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function normalize(vector) {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  return norm === 0 ? null : Float64Array.from(vector, (v) => v / norm);
}

function nearest(prototypes, unit) {
  let index = 0;
  let score = -Infinity;
  prototypes.forEach((p, i) => {
    const s = cosineSimilarity(p, unit);
    if (s > score) [index, score] = [i, s];
  });
  return { index, score };
}

/**
 * Builds a speaker profile with spherical k-means (cosine) over valid frames.
 * Deterministic: seeded with the frame closest to the mean direction, then
 * farthest-point initialisation. Empty clusters are dropped.
 * @param {ArrayLike<number>[]} vectors spectral feature vectors of valid voiced frames
 * @param {{ maxPrototypes?: number, iterations?: number, frameDuration?: number, minDuration?: number }} [options]
 * @returns {{ dimension: number, prototypes: Float64Array[], counts: number[] }}
 */
export function enrollProfile(vectors, options = {}) {
  const { maxPrototypes, iterations, frameDuration, minDuration } = { ...DEFAULT_ENROLLMENT_CONFIG, ...options };
  if (!Number.isInteger(maxPrototypes) || maxPrototypes < 1) throw new RangeError('maxPrototypes must be an integer >= 1');
  const units = vectors.map(normalize).filter(Boolean);
  if (units.length === 0) throw new RangeError('enrolment requires at least one non-zero feature vector');
  const dimension = units[0].length;
  if (units.some((u) => u.length !== dimension || u.some((v) => !Number.isFinite(v)))) {
    throw new RangeError('feature vectors must be finite and share one dimension');
  }
  if (frameDuration !== undefined && units.length * frameDuration < minDuration) {
    throw new RangeError(`enrolment needs >= ${minDuration} s of valid voice, got ${units.length * frameDuration} s`);
  }

  const mean = normalize(units.reduce((acc, u) => acc.map((v, i) => v + u[i]), new Float64Array(dimension)));
  const k = Math.min(maxPrototypes, units.length);
  let prototypes = [mean ? units[nearest(units, mean).index] : units[0]];
  while (prototypes.length < k) {
    let farthest = 0;
    let lowest = Infinity;
    units.forEach((u, i) => {
      const { score } = nearest(prototypes, u);
      if (score < lowest) [farthest, lowest] = [i, score];
    });
    prototypes.push(units[farthest]);
  }

  let assignment = new Int32Array(units.length).fill(-1);
  for (let iter = 0; iter < iterations; iter++) {
    const next = Int32Array.from(units, (u) => nearest(prototypes, u).index);
    const sums = prototypes.map(() => new Float64Array(dimension));
    next.forEach((c, i) => units[i].forEach((v, d) => (sums[c][d] += v)));
    prototypes = sums.map((s, c) => normalize(s) ?? prototypes[c]);
    const converged = next.every((c, i) => c === assignment[i]);
    assignment = next;
    if (converged) break;
  }

  const counts = prototypes.map((_, c) => assignment.filter((a) => a === c).length);
  const kept = prototypes.map((p, c) => ({ p, n: counts[c] })).filter(({ n }) => n > 0);
  return Object.freeze({
    dimension,
    prototypes: kept.map(({ p }) => p),
    counts: kept.map(({ n }) => n),
  });
}

/** Speaker score = max cosine similarity against the profile prototypes. */
export function speakerScore(profile, vector) {
  if (vector.length !== profile.dimension) {
    throw new RangeError(`vector dimension ${vector.length} does not match profile ${profile.dimension}`);
  }
  return Math.max(...profile.prototypes.map((p) => cosineSimilarity(p, vector)));
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
