import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RANGES, SCORE_TRACKS, formatTick, niceCeil, timeStep, valueRange } from '../src/ui/score-chart.js';

describe('score chart helpers', () => {
  it('has the six tracks of the score, in order', () => {
    assert.deepEqual(SCORE_TRACKS, ['phi', 'f0', 'level', 'h', 'rate', 'dose']);
  });

  it('niceCeil rounds an axis top up to 1, 2 or 5 x 10^n', () => {
    assert.deepEqual([0.7, 1, 1.2, 3, 7, 12, 165, 0.013].map(niceCeil), [1, 1, 2, 5, 10, 20, 200, 0.02]);
    assert.equal(niceCeil(0), 1);
    assert.equal(niceCeil(NaN), 1);
  });

  it('timeStep keeps the tick count under the limit', () => {
    assert.equal(timeStep(60, 10), 10);
    assert.equal(timeStep(4 * 3600, 8), 1800);
    assert.equal(timeStep(30, 12), 5);
  });

  it('formatTick shows wall-clock time from the session start, or elapsed time', () => {
    const start = new Date(2026, 10, 18, 8, 0, 0);
    assert.equal(formatTick(75 * 60, start, false), '09:15');
    assert.equal(formatTick(90, start, true), '08:01:30');
    assert.equal(formatTick(125, null, true), '2:05');
    assert.equal(formatTick(3725, null, true), '1:02:05');
  });

  it('valueRange keeps fixed scales and widens them only for real data, ignoring outliers', () => {
    assert.deepEqual(DEFAULT_RANGES, { f0: [75, 350], 'dB SPL': [40, 110], dBFS: [-70, 0] });
    assert.deepEqual(valueRange('f0', new Float32Array([NaN, NaN])), [75, 350]);
    assert.deepEqual(valueRange('f0', Float32Array.from([180, 190, 200, 420])), [75, 420]);
    const voice = Array.from({ length: 99 }, () => 94);
    assert.deepEqual(valueRange('level', Float32Array.from([...voice, 12]), 'dB SPL'), [40, 110], 'one onset frame does not stretch it');
    assert.deepEqual(valueRange('level', Float32Array.from(Array.from({ length: 50 }, () => 118)), 'dB SPL'), [40, 120]);
    assert.deepEqual(valueRange('level', Float32Array.from([-30, -25]), 'dBFS'), [-70, 0]);
  });
});
