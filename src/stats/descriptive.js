// Descriptive statistics (pure). Quantiles use linear interpolation between order
// statistics (Hyndman-Fan type 7, the default of R and NumPy).

const finiteSorted = (values) => Array.from(values).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);

/** q-quantile (0 <= q <= 1) of the finite values; NaN when there are none. */
export function quantile(values, q, { sorted = false } = {}) {
  const xs = sorted ? values : finiteSorted(values);
  if (xs.length === 0) return NaN;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/** n, mean, SD (n - 1), min, max and P5, P10, P25, P50, P75, P90, P95 of the finite values. */
export function describe(values) {
  const xs = finiteSorted(values);
  const n = xs.length;
  if (n === 0) return { n: 0, mean: NaN, sd: NaN, min: NaN, max: NaN, p5: NaN, p10: NaN, p25: NaN, p50: NaN, p75: NaN, p90: NaN, p95: NaN };
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : NaN;
  const q = (p) => quantile(xs, p, { sorted: true });
  return { n, mean, sd, min: xs[0], max: xs[n - 1], p5: q(0.05), p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95) };
}
