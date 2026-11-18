import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SEQUENTIAL, barChart, compact, heatmapTable, histogramChart, rocChart, scatterChart, ticks } from '../src/ui/boards/charts.js';
import { linearRegression } from '../src/stats/inference.js';

describe('chart helpers', () => {
  it('ticks are round numbers covering the range', () => {
    assert.deepEqual(ticks(0, 100), [0, 25, 50, 75, 100]);
    assert.deepEqual(ticks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('compact formats with Argentine decimals and k / M suffixes', () => {
    assert.equal(compact(3_200_000), '3,2 M');
    assert.equal(compact(12_400), '12,4 k');
    assert.equal(compact(950), '950');
    assert.equal(compact(NaN), '—');
  });

  it('every bar carries a tooltip and labels are escaped', () => {
    const svg = barChart({ labels: ['Oct', '<b>'], series: [{ name: 'Jornadas', values: [3, 5], color: 'red' }] });
    assert.equal((svg.match(/<title>/g) ?? []).length, 2);
    assert.ok(svg.includes('&lt;b&gt;') && !svg.includes('<b>'));
  });

  it('empty histogram says so instead of drawing nothing', () => {
    assert.match(histogramChart({ edges: [], counts: [], color: 'red' }), /Sin datos/);
  });

  it('scatter draws the OLS band when a fit is given; ROC draws the chance line', () => {
    const fit = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]);
    assert.match(scatterChart({ points: [[1, 2], [2, 4]], fit, color: 'red' }), /class="band"/);
    assert.match(rocChart({ curves: [{ name: 'D0', points: [{ fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }], color: 'red' }] }), /class="chance"/);
  });

  it('heat map shows the value in each cell, a dash for empty ones, on a one-hue ramp', () => {
    const html = heatmapTable({ rows: ['1A'], cols: ['Lun', 'Mar'], cells: [[100, null]], caption: 'Carga' });
    assert.match(html, />100</);
    assert.match(html, /class="empty">—/);
    assert.equal(SEQUENTIAL.length, 11);
  });
});
