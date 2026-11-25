// Analytics outcomes: ΔF (post − pre), AUC_F up to +4 h and T90, each with its case rule.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recoveryIndices } from '../src/stats/recovery.js';
import { OUTCOMES, outcomeCase, outcomeValue } from '../src/stats/outcomes.js';
import { generateDemoWorkdays } from '../src/store/demo-data.js';
import { renderAnalytics } from '../src/ui/boards/views.js';

const w = (pre, post, points = []) => ({ fatigue: { pre, post, recovery: points.map(([minutes, value], i) => ({ slot: ['R30', 'R60', 'R120', 'R240', 'NEXT'][i], at: '2026-11-12T12:00:00.000Z', minutes, value })) } });
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

describe('standard AUC_F (0 to +4 h)', () => {
  it('integrates up to 240 min, so workdays with different last points compare', () => {
    const r = recoveryIndices({ pre: 10, post: 50, points: [{ minutes: 120, value: 30 }, { minutes: 240, value: 10 }, { minutes: 1200, value: 10 }] });
    near(r.aucF4h, ((40 + 20) / 2) * 2 + ((20 + 0) / 2) * 2, 1e-9, 'AUC_F 0-4 h');
  });

  it('accepts the +4 h point recorded up to 5 min early, holding its value to 240 min', () => {
    const r = recoveryIndices({ pre: 10, post: 50, points: [{ minutes: 236, value: 10 }] });
    near(r.aucF4h, ((40 + 0) / 2) * (236 / 60), 1e-9, 'AUC_F');
  });

  it('is null without a point near +4 h', () => {
    assert.equal(recoveryIndices({ pre: 10, post: 50, points: [{ minutes: 120, value: 30 }] }).aucF4h, null);
  });
});

describe('outcome values and cases', () => {
  it('ΔF keeps the existing case rule (post − pre ≥ threshold)', () => {
    assert.equal(outcomeValue(w(10, 40), 'deltaF'), 30);
    assert.equal(outcomeCase(w(10, 40), 'deltaF', 20), 1);
    assert.equal(outcomeCase(w(10, 20), 'deltaF', 20), 0);
    assert.equal(outcomeCase(w(null, 20), 'deltaF', 20), null);
  });

  it('AUC_F: the standard 0-4 h area; case when it reaches the threshold', () => {
    const day = w(10, 50, [[60, 40], [240, 30]]);
    assert.ok(Number.isFinite(outcomeValue(day, 'aucF')));
    assert.equal(outcomeCase(day, 'aucF', 20), outcomeValue(day, 'aucF') >= 20 ? 1 : 0);
    assert.ok(Number.isNaN(outcomeValue(w(10, 50, [[60, 40]]), 'aucF')));
    assert.equal(outcomeCase(w(10, 50, [[60, 40]]), 'aucF', 20), null);
  });

  it('T90: case when 90 % is not recovered by the threshold, censored times included when observed long enough', () => {
    const quick = w(10, 50, [[30, 30], [60, 12]]); // T90 between 30 and 60 min
    assert.ok(outcomeValue(quick, 't90') < 60);
    assert.equal(outcomeCase(quick, 't90', 240), 0);
    const slow = w(10, 50, [[30, 45], [60, 40], [120, 35], [240, 30]]); // not reached by +4 h
    assert.ok(Number.isNaN(outcomeValue(slow, 't90')), 'a censored time is not a value');
    assert.equal(outcomeCase(slow, 't90', 240), 1, 'still not recovered at 240 min: a case');
    assert.equal(outcomeCase(w(10, 50, [[30, 45]]), 't90', 240), null, 'observed too briefly: unknown');
    assert.equal(outcomeCase(w(30, 20, [[30, 20]]), 't90', 240), 0, 'no fatigue increase: nothing left to recover');
  });

  it('each outcome names its threshold, unit and default', () => {
    assert.deepEqual(Object.keys(OUTCOMES), ['deltaF', 'aucF', 't90']);
    for (const o of Object.values(OUTCOMES)) assert.ok(o.label && o.unit && o.thresholdKey && Number.isFinite(o.defaultThreshold));
  });
});

describe('Analítica by outcome', () => {
  const days = generateDemoWorkdays({ seed: 3 });
  const render = (state) => { const root = { innerHTML: '' }; renderAnalytics(root, days, { dose: 'none', caseThreshold: 20, ...state }); return root.innerHTML; };

  it('the demo has recovery points', () => {
    assert.ok(days.filter((d) => d.fatigue.recovery?.length).length > days.length / 2);
  });

  it('offers the three outcomes and uses the chosen one in distribution, dose-response and ROC', () => {
    const html = render({ outcome: 'aucF' });
    assert.match(html, /data-filter="outcome"/);
    for (const label of ['ΔF', 'AUC_F', 'T₉₀']) assert.ok(html.includes(label), label);
    assert.match(html, /Curva dosis-respuesta \(AUC_F vs dosis\)/);
    assert.match(html, /caso: AUC_F ≥ 20 EVA·h/);
    assert.ok(!html.includes('NaN'));
  });

  it('T90 explains the censored times and uses its own threshold', () => {
    const html = render({ outcome: 't90', t90Threshold: 180 });
    assert.match(html, /caso: T₉₀ &gt; 180 min/);
    assert.match(html, /censurad/);
    assert.ok(!html.includes('NaN'));
  });

  it('ΔF stays the default', () => {
    assert.match(render({}), /Curva dosis-respuesta \(ΔEVA vs dosis\)/);
  });
});
