import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTO_EVENT_RULES, detectEvents } from '../src/store/auto-events.js';
import { createScoreSeries } from '../src/ui/score-series.js';

const DT = 0.5;
function series(spec) { // spec: [[seconds, phi, level]]
  const s = createScoreSeries();
  let t = 0;
  for (const [seconds, phi, level] of spec) {
    for (let k = 0; k < seconds / DT; k++, t += DT) {
      s.push({ t, dt: DT, phi, f0: phi ? 200 : null, level: phi ? level : null, h: 0, doses: {}, distanceDose: null });
    }
  }
  return s;
}

describe('automatic events (provisional rules)', () => {
  it('documents its rules', () => {
    assert.deepEqual(AUTO_EVENT_RULES, { sustainedWindowS: 120, sustainedMinFraction: 0.6, raisedLevelDb: 6, raisedMinS: 3 });
  });

  it('flags sustained phonation once per continuous stretch', () => {
    const s = series([[60, 0, 0], [240, 1, 80], [60, 0, 0]]);
    const events = detectEvents(s).filter((e) => e.type === 'fonacion_sostenida');
    assert.equal(events.length, 1);
    assert.equal(events[0].t, 60);
    assert.equal(events[0].source, 'algoritmo');
    assert.ok(events[0].durationS >= 240 - 1);
  });

  it('does not flag phonation spread with enough pauses', () => {
    const spec = [];
    for (let i = 0; i < 10; i++) spec.push([20, 1, 80], [20, 0, 0]);
    assert.equal(detectEvents(series(spec)).filter((e) => e.type === 'fonacion_sostenida').length, 0);
  });

  it('flags raised level relative to the workday median, only when it lasts', () => {
    const s = series([[60, 1, 80], [5, 1, 90], [60, 1, 80], [1, 1, 95], [60, 1, 80]]);
    const raised = detectEvents(s).filter((e) => e.type === 'nivel_elevado');
    assert.equal(raised.length, 1, JSON.stringify(raised));
    assert.equal(raised[0].t, 60);
    assert.equal(raised[0].durationS, 5);
    assert.equal(raised[0].detail, '+10 dB');
  });

  it('returns nothing for an empty session', () => {
    assert.deepEqual(detectEvents(createScoreSeries()), []);
  });
});
