// Inferential statistics for the analytics tab (pure). Small, dependency-free versions of
// what the protocol plans: OLS dose-response, Spearman, ROC/AUC with Hanley-McNeil CI,
// Youden cut-off and diagnostic metrics with Wilson intervals. Not a replacement for the
// mixed models of the final analysis.

const Z975 = 1.959963984540054;

const pairs = (x, y) => {
  const out = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) out.push([x[i], y[i]]);
  }
  return out;
};

/** Equal-width bins over [min, max]; the last bin includes max. */
export function histogram(values, { bins = 20, min, max } = {}) {
  const xs = Array.from(values).filter(Number.isFinite);
  if (xs.length === 0) return { edges: [], counts: [] };
  const lo = min ?? Math.min(...xs);
  const hi = max ?? Math.max(...xs);
  const width = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of xs) {
    if (v < lo || v > hi) continue;
    counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++;
  }
  return { edges: Array.from({ length: bins + 1 }, (_, i) => lo + i * width), counts };
}

function logGamma(x) {
  // Lanczos approximation (g = 7, n = 9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized incomplete beta I_x(a, b) by its continued fraction (Numerical Recipes). */
function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d);
  let f = d;
  for (let m = 1; m <= 300; m++) {
    for (const even of [true, false]) {
      const num = even
        ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m))
        : (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
      d = 1 + num * d;
      d = 1 / (Math.abs(d) < 1e-300 ? 1e-300 : d);
      c = 1 + num / c;
      if (Math.abs(c) < 1e-300) c = 1e-300;
      f *= c * d;
    }
    if (Math.abs(c * d - 1) < 1e-14) break;
  }
  return (front * f) / a;
}

/** CDF of Student's t with `df` degrees of freedom. */
export function tCdf(t, df) {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** 97.5 % quantile of Student's t, by bisection on the exact CDF. */
export function tQuantile975(df) {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < 0.975) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Ordinary least squares y = intercept + slope x on the complete pairs, with the 95 %
 * confidence band of the mean response.
 */
export function linearRegression(x, y) {
  const p = pairs(x, y);
  const n = p.length;
  const empty = { n, slope: NaN, intercept: NaN, r2: NaN, band: () => ({ fit: NaN, lo: NaN, hi: NaN }) };
  if (n < 3) return empty;
  const mx = p.reduce((s, [a]) => s + a, 0) / n;
  const my = p.reduce((s, [, b]) => s + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [a, b] of p) {
    sxx += (a - mx) ** 2;
    sxy += (a - mx) * (b - my);
    syy += (b - my) ** 2;
  }
  if (sxx === 0) return empty;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const sse = p.reduce((s, [a, b]) => s + (b - intercept - slope * a) ** 2, 0);
  const s = Math.sqrt(sse / (n - 2));
  const t = tQuantile975(n - 2);
  return {
    n,
    slope,
    intercept,
    r2: syy === 0 ? NaN : 1 - sse / syy,
    band(x0) {
      const fit = intercept + slope * x0;
      const half = t * s * Math.sqrt(1 / n + (x0 - mx) ** 2 / sxx);
      return { fit, lo: fit - half, hi: fit + half };
    },
  };
}

function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

const pearson = (x, y) => {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
};

/** Spearman's rho on the complete pairs (average ranks for ties). */
export function spearman(x, y) {
  const p = pairs(x, y);
  if (p.length < 3) return NaN;
  return pearson(ranks(p.map(([a]) => a)), ranks(p.map(([, b]) => b)));
}

/**
 * ROC curve of `scores` for binary `labels` (1 = case); higher score means more likely a case.
 * Points run from (0, 0) to (1, 1) over the distinct thresholds, highest first. AUC by the
 * Mann-Whitney statistic (ties count 1/2) with the Hanley-McNeil (1982) standard error.
 */
export function rocCurve(scores, labels) {
  const p = [];
  for (let i = 0; i < scores.length; i++) {
    if (Number.isFinite(scores[i]) && (labels[i] === 0 || labels[i] === 1)) p.push([scores[i], labels[i]]);
  }
  const positives = p.filter(([, l]) => l === 1).length;
  const negatives = p.length - positives;
  if (positives === 0 || negatives === 0) return { points: [], auc: NaN, se: NaN, ci: [NaN, NaN], positives, negatives };
  p.sort((a, b) => b[0] - a[0]);
  const points = [{ fpr: 0, tpr: 0, threshold: Infinity }];
  let tp = 0;
  let fp = 0;
  for (let i = 0; i < p.length; ) {
    const threshold = p[i][0];
    while (i < p.length && p[i][0] === threshold) {
      if (p[i][1] === 1) tp++;
      else fp++;
      i++;
    }
    points.push({ fpr: fp / negatives, tpr: tp / positives, threshold });
  }
  const r = ranks(p.map(([s]) => s));
  const rankSum = p.reduce((s, [, l], i) => s + (l === 1 ? r[i] : 0), 0);
  const auc = (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const se = Math.sqrt((auc * (1 - auc) + (positives - 1) * (q1 - auc ** 2) + (negatives - 1) * (q2 - auc ** 2)) / (positives * negatives));
  return { points, auc, se, ci: [Math.max(0, auc - Z975 * se), Math.min(1, auc + Z975 * se)], positives, negatives };
}

/** Threshold maximising J = Se + Sp - 1; ties go to the higher sensitivity. */
export function youden(roc) {
  let best = null;
  for (const pt of roc.points) {
    if (!Number.isFinite(pt.threshold)) continue;
    const j = pt.tpr - pt.fpr;
    if (!best || j > best.j + 1e-12 || (Math.abs(j - best.j) <= 1e-12 && pt.tpr > best.sensitivity)) {
      best = { threshold: pt.threshold, j, sensitivity: pt.tpr, specificity: 1 - pt.fpr };
    }
  }
  return best;
}

/** Wilson score 95 % interval for k successes out of n. */
export function wilsonInterval(k, n) {
  if (!(n > 0)) return [NaN, NaN];
  const p = k / n;
  const z2 = Z975 ** 2;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z975 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Confusion counts with score >= threshold as positive, and Se, Sp, PPV, NPV with Wilson CI. */
export function confusionAt(scores, labels, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < scores.length; i++) {
    if (!Number.isFinite(scores[i]) || (labels[i] !== 0 && labels[i] !== 1)) continue;
    const predicted = scores[i] >= threshold;
    if (labels[i] === 1) predicted ? tp++ : fn++;
    else predicted ? fp++ : tn++;
  }
  const metric = (k, n) => ({ value: n > 0 ? k / n : NaN, ci: wilsonInterval(k, n) });
  return {
    tp, fp, tn, fn,
    sensitivity: metric(tp, tp + fn),
    specificity: metric(tn, tn + fp),
    ppv: metric(tp, tp + fp),
    npv: metric(tn, tn + fn),
  };
}

/** 1 when post - pre >= threshold, 0 when below, null when either VAS is missing. */
export function caseLabels(workdays, threshold) {
  return workdays.map(({ fatigue }) => {
    if (fatigue?.pre == null || fatigue?.post == null) return null;
    return fatigue.post - fatigue.pre >= threshold ? 1 : 0;
  });
}
