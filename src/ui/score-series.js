// Vocal-load score data: every measured frame of a session in growable typed arrays,
// reduced to one bucket per pixel column before drawing (a workday is ~675 000 frames).
// Pure and DOM-free, so it is tested in Node.

/** Doses selectable for the rate and accumulated tracks; `distance` is D_d (m). */
export const SCORE_DOSES = Object.freeze(['none', 'linear', 'power', 'exponential', 'saturating', 'distance']);

/** Minimum non-phonation run shaded as a pause in the score, s. */
export const DEFAULT_PAUSE_SECONDS = 2;

const MODEL_DOSES = SCORE_DOSES.slice(0, 5);

/** A frame starting later than the previous one ended (plus this fraction of dt) opens a gap. */
const GAP_TOLERANCE = 0.5;

export function createScoreSeries({ initialCapacity = 4096 } = {}) {
  let capacity = Math.max(1, initialCapacity);
  let size = 0;
  let cols = allocate(capacity);

  function allocate(n) {
    return {
      t: new Float64Array(n),
      dt: new Float64Array(n),
      phi: new Uint8Array(n),
      f0: new Float64Array(n),
      level: new Float64Array(n),
      h: new Float64Array(n),
      dose: Object.fromEntries(SCORE_DOSES.map((d) => [d, new Float64Array(n)])),
    };
  }

  function grow() {
    const next = allocate(capacity * 2);
    for (const key of ['t', 'dt', 'phi', 'f0', 'level', 'h']) next[key].set(cols[key]);
    for (const d of SCORE_DOSES) next.dose[d].set(cols.dose[d]);
    cols = next;
    capacity *= 2;
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

  /**
   * @param {{ t: number, dt: number, phi: 0 | 1, f0: number | null, level: number | null, h: number,
   *   doses: object, distanceDose: number | null }} frame values after the frame (doses are cumulative)
   */
  function push(frame) {
    if (size === capacity) grow();
    const i = size++;
    cols.t[i] = frame.t;
    cols.dt[i] = frame.dt;
    cols.phi[i] = frame.phi === 1 ? 1 : 0;
    cols.f0[i] = num(frame.f0);
    cols.level[i] = num(frame.level);
    cols.h[i] = num(frame.h);
    for (const d of MODEL_DOSES) cols.dose[d][i] = num(frame.doses?.[d]);
    cols.dose.distance[i] = num(frame.distanceDose);
  }

  function reset() {
    size = 0;
  }

  /** Index of the last frame with t <= time, or -1. */
  function indexAtOrBefore(time) {
    let lo = 0;
    let hi = size - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cols.t[mid] <= time) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  const sample = (i) => ({
    t: cols.t[i],
    dt: cols.dt[i],
    phi: cols.phi[i],
    f0: cols.f0[i],
    level: cols.level[i],
    h: cols.h[i],
    doses: Object.fromEntries(SCORE_DOSES.map((d) => [d, cols.dose[d][i]])),
  });

  /** The frame covering `time`, or null before the start, inside a gap or after the end. */
  function sampleAt(time) {
    const i = indexAtOrBefore(time);
    if (i < 0 || time >= cols.t[i] + cols.dt[i]) return null;
    return sample(i);
  }

  const isGapBefore = (i) => i > 0 && cols.t[i] > cols.t[i - 1] + cols.dt[i - 1] * (1 + GAP_TOLERANCE);

  /** Intervals with no frames because the session was paused. */
  function gaps() {
    const out = [];
    for (let i = 1; i < size; i++) {
      if (isGapBefore(i)) out.push({ from: cols.t[i - 1] + cols.dt[i - 1], to: cols.t[i] });
    }
    return out;
  }

  /** Non-phonation runs (not crossing a gap) lasting at least `minSeconds`. */
  function pauses(minSeconds = DEFAULT_PAUSE_SECONDS) {
    const out = [];
    let start = -1;
    const close = (end) => {
      const from = cols.t[start];
      const to = cols.t[end] + cols.dt[end];
      if (to - from >= minSeconds - 1e-9) out.push({ from, to });
      start = -1;
    };
    for (let i = 0; i < size; i++) {
      if (start >= 0 && isGapBefore(i)) close(i - 1);
      if (cols.phi[i] === 0) {
        if (start < 0) start = i;
      } else if (start >= 0) close(i - 1);
    }
    if (start >= 0) close(size - 1);
    return out;
  }

  /**
   * One value per bucket over [from, to): phonation fraction; mean F0 and level over voiced
   * frames; last H and accumulated dose; dose rate per minute (dose gained in the bucket over
   * the frame time it covers). Empty buckets are NaN.
   */
  function bucketize({ from, to, buckets, dose }) {
    if (!SCORE_DOSES.includes(dose)) throw new RangeError(`unknown dose "${dose}"`);
    const n = Math.max(1, Math.floor(buckets));
    const width = (to - from) / n;
    const out = {
      width,
      phi: new Float32Array(n).fill(NaN),
      f0: new Float32Array(n).fill(NaN),
      level: new Float32Array(n).fill(NaN),
      h: new Float32Array(n).fill(NaN),
      dose: new Float64Array(n).fill(NaN),
      rate: new Float64Array(n).fill(NaN),
    };
    const frames = new Uint32Array(n);
    const voiced = new Uint32Array(n);
    const f0Count = new Uint32Array(n);
    const levelCount = new Uint32Array(n);
    const f0Sum = new Float64Array(n);
    const levelSum = new Float64Array(n);
    const gained = new Float64Array(n);
    const covered = new Float64Array(n);
    const values = cols.dose[dose];
    const first = Math.max(0, indexAtOrBefore(from));
    for (let i = first; i < size; i++) {
      const t = cols.t[i];
      if (t < from) continue;
      if (t >= to) break;
      const b = Math.min(n - 1, Math.floor((t - from) / width));
      frames[b]++;
      covered[b] += cols.dt[i];
      if (cols.phi[i] === 1) {
        voiced[b]++;
        if (!Number.isNaN(cols.f0[i])) { f0Sum[b] += cols.f0[i]; f0Count[b]++; }
        if (!Number.isNaN(cols.level[i])) { levelSum[b] += cols.level[i]; levelCount[b]++; }
      }
      out.h[b] = cols.h[i];
      out.dose[b] = values[i];
      gained[b] += values[i] - (i > 0 ? values[i - 1] : 0);
    }
    for (let b = 0; b < n; b++) {
      if (frames[b] === 0) continue;
      out.phi[b] = voiced[b] / frames[b];
      if (f0Count[b]) out.f0[b] = f0Sum[b] / f0Count[b];
      if (levelCount[b]) out.level[b] = levelSum[b] / levelCount[b];
      out.rate[b] = Number.isNaN(gained[b]) ? NaN : (gained[b] / covered[b]) * 60;
    }
    return out;
  }

  /** Finite F0 or level values of accepted-phonation frames, in time order. */
  function voicedValues(key) {
    if (key !== 'f0' && key !== 'level') throw new RangeError(`voicedValues supports "f0" and "level", got ${key}`);
    const out = [];
    for (let i = 0; i < size; i++) if (cols.phi[i] === 1 && !Number.isNaN(cols[key][i])) out.push(cols[key][i]);
    return Float64Array.from(out);
  }

  return {
    push,
    reset,
    sampleAt,
    voicedValues,
    gaps,
    pauses,
    bucketize,
    get length() { return size; },
    get startTime() { return size ? cols.t[0] : null; },
    get endTime() { return size ? cols.t[size - 1] + cols.dt[size - 1] : null; },
  };
}
