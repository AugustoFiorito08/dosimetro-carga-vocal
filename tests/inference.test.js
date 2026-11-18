import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  caseLabels,
  confusionAt,
  histogram,
  linearRegression,
  rocCurve,
  spearman,
  tQuantile975,
  wilsonInterval,
  youden,
} from '../src/stats/inference.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

describe('histogram', () => {
  it('counts values into equal-width bins, the last bin closed', () => {
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bins: 5 });
    assert.deepEqual(h.edges, [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(h.counts, [2, 2, 2, 2, 3]);
    assert.deepEqual(histogram([NaN], { bins: 3 }).counts, []);
  });
});

describe('Student t 97.5 % quantile', () => {
  it('matches published tables', () => {
    close(tQuantile975(1), 12.706, 0.001, 'df 1');
    close(tQuantile975(3), 3.182, 0.001, 'df 3');
    close(tQuantile975(10), 2.228, 0.001, 'df 10');
    close(tQuantile975(30), 2.042, 0.001, 'df 30');
    close(tQuantile975(1000), 1.962, 0.001, 'df 1000');
  });
});

describe('OLS dose-response', () => {
  it('fits the textbook example y = 2.2 + 0.6 x with R² = 0.6', () => {
    const fit = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
    close(fit.slope, 0.6, 1e-12);
    close(fit.intercept, 2.2, 1e-12);
    close(fit.r2, 0.6, 1e-12);
    assert.equal(fit.n, 5);
  });

  it('the 95 % band of the mean is narrowest at the mean of x and contains the fit', () => {
    const x = Array.from({ length: 40 }, (_, i) => i);
    const y = x.map((v, i) => 3 + 0.5 * v + ((i * 7) % 5) - 2);
    const fit = linearRegression(x, y);
    const [atMean, atEdge] = [fit.band(19.5), fit.band(0)];
    assert.ok(atMean.hi - atMean.lo < atEdge.hi - atEdge.lo);
    assert.ok(atMean.lo < atMean.fit && atMean.fit < atMean.hi);
  });

  it('ignores pairs with a missing value and needs 3 points', () => {
    assert.equal(linearRegression([1, 2, NaN, 4], [1, 2, 3, NaN]).n, 2);
    assert.ok(Number.isNaN(linearRegression([1, 2], [1, 2]).slope));
  });
});

describe('Spearman correlation', () => {
  it('uses average ranks for ties', () => {
    close(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]), 0.8207826816681233, 1e-12); // checked in Python
    close(spearman([1, 2, 3], [3, 2, 1]), -1, 1e-12);
  });
});

describe('ROC and AUC', () => {
  it('AUC is 1 for perfect separation, 0 for reversed and 0.5 for ties', () => {
    assert.equal(rocCurve([1, 2, 3, 4], [0, 0, 1, 1]).auc, 1);
    assert.equal(rocCurve([4, 3, 2, 1], [0, 0, 1, 1]).auc, 0);
    assert.equal(rocCurve([5, 5, 5, 5], [0, 1, 0, 1]).auc, 0.5);
  });

  it('Mann-Whitney AUC equals the trapezoidal area of the ROC points', () => {
    const scores = [0.1, 0.4, 0.35, 0.8, 0.7, 0.2, 0.9, 0.55, 0.6, 0.3, 0.65, 0.45];
    const labels = [0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0, 1];
    const roc = rocCurve(scores, labels);
    let area = 0;
    for (let i = 1; i < roc.points.length; i++) {
      const [a, b] = [roc.points[i - 1], roc.points[i]];
      area += (b.fpr - a.fpr) * (a.tpr + b.tpr) / 2;
    }
    close(roc.auc, area, 1e-12);
    assert.deepEqual(roc.points[0], { fpr: 0, tpr: 0, threshold: Infinity });
    assert.deepEqual([roc.points.at(-1).fpr, roc.points.at(-1).tpr], [1, 1]);
    assert.ok(roc.ci[0] < roc.auc && roc.auc < roc.ci[1] && roc.ci[0] >= 0 && roc.ci[1] <= 1);
    assert.deepEqual([roc.positives, roc.negatives], [6, 6]);
  });

  it('Hanley-McNeil SE shrinks with more cases', () => {
    const make = (n) => rocCurve(Array.from({ length: 2 * n }, (_, i) => (i % 2) * 0.3 + ((i * 37) % 11) / 10), Array.from({ length: 2 * n }, (_, i) => i % 2));
    assert.ok(make(20).auc > 0.5 && make(20).auc < 1, 'overlapping groups');
    assert.ok(make(200).se < make(20).se);
  });
});

describe('Youden cut-off and confusion metrics', () => {
  it('picks the threshold maximising sensitivity + specificity - 1; ties go to the higher sensitivity', () => {
    const scores = [1, 2, 3, 4, 5, 6, 7, 8];
    const labels = [0, 0, 0, 1, 0, 1, 1, 1];
    // threshold 4: Se 1, Sp 0.75; threshold 6: Se 0.75, Sp 1 -> both J = 0.75
    const best = youden(rocCurve(scores, labels));
    assert.equal(best.threshold, 4);
    close(best.j, 0.75, 1e-12);
    close(best.sensitivity, 1, 1e-12);
    close(best.specificity, 0.75, 1e-12);
  });

  it('confusionAt counts score >= threshold as positive and reports Wilson intervals', () => {
    const c = confusionAt([1, 2, 3, 4, 5, 6, 7, 8], [0, 0, 0, 1, 0, 1, 1, 1], 4);
    assert.deepEqual([c.tp, c.fp, c.tn, c.fn], [4, 1, 3, 0]);
    assert.equal(c.sensitivity.value, 1);
    assert.equal(c.specificity.value, 0.75);
    assert.equal(c.ppv.value, 0.8);
    assert.equal(c.npv.value, 1);
    assert.ok(c.sensitivity.ci[1] === 1 && c.sensitivity.ci[0] < 1);
  });

  it('Wilson interval for 8/10 matches the closed form', () => {
    const [lo, hi] = wilsonInterval(8, 10);
    close(lo, 0.4901624714648082, 1e-9);
    close(hi, 0.9433178485609942, 1e-9);
    assert.deepEqual(wilsonInterval(0, 0), [NaN, NaN]);
  });
});

describe('case definition', () => {
  it('a case is a fatigue change (post - pre) at or above the threshold; missing VAS is excluded', () => {
    const days = [
      { fatigue: { pre: 10, post: 35 } }, { fatigue: { pre: 10, post: 29 } },
      { fatigue: { pre: null, post: 50 } }, { fatigue: { pre: 20, post: 40 } },
    ];
    assert.deepEqual(caseLabels(days, 20), [1, 0, null, 1]);
  });
});
