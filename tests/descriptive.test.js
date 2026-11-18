import { describe as suite, it } from 'node:test';
import assert from 'node:assert/strict';

import { describe, quantile } from '../src/stats/descriptive.js';

suite('descriptive statistics', () => {
  it('quantile uses linear interpolation (type 7) and ignores non-finite values', () => {
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(quantile([10, 20, 30, 40, 50], 0.25), 20);
    assert.ok(Math.abs(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) - 9.1) < 1e-12); // numpy.percentile(..., 90) = 9.1
    assert.equal(quantile([NaN, 5, Infinity], 0.5), 5);
    assert.ok(Number.isNaN(quantile([], 0.5)));
  });

  it('describe gives n, mean, SD with n - 1 and percentiles', () => {
    const d = describe([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(d.n, 8);
    assert.equal(d.mean, 5);
    assert.ok(Math.abs(d.sd - Math.sqrt(32 / 7)) < 1e-12);
    assert.deepEqual([d.min, d.max, d.p50], [2, 9, 4.5]);
    assert.equal(describe([]).n, 0);
    assert.ok(Number.isNaN(describe([3]).sd));
  });
});
