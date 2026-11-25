import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateDemoWorkdays } from '../src/store/demo-data.js';
import { recomputeBody, recomputeState, renderAnalytics, renderDirector, renderTeacher, summariesCsv } from '../src/ui/boards/views.js';

const days = generateDemoWorkdays({ seed: 3 });
const render = (fn, data, state) => { const root = { innerHTML: '' }; fn(root, data, state); return root.innerHTML; };
const clean = (html) => {
  for (const bad of ['NaN', 'undefined', '[object']) assert.ok(!html.includes(bad), `found "${bad}"`);
};

describe('dashboard views', () => {
  it('Mi jornada shows KPIs, timeline, rate and events of the selected teacher', () => {
    const state = { dose: 'none' };
    const html = render(renderTeacher, days, state);
    for (const text of ['Fonación', 'Tiempo observado', 'Dosis acumulada', 'Tasa de acumulación', 'Eventos de la jornada', 'Valores provisionales']) assert.ok(html.includes(text), text);
    assert.ok(state.participant && state.workdayId);
    clean(html);
  });

  it('Dirección shows codes only, the heat map, classroom table and the privacy badge', () => {
    const state = { dose: 'exponential', caseThreshold: 20 };
    const html = render(renderDirector, days, state);
    for (const text of ['Mapa de carga por aula', 'Carga vocal por aula', 'Distribución de fatiga', 'Evolución semanal', 'docentes por código']) assert.ok(html.includes(text), text);
    assert.match(html, /P-\d{4}/);
    clean(html);
  });

  it('Dirección withholds aggregates when fewer than 3 teachers are in view', () => {
    const one = days.filter((w) => w.participantId === days[0].participantId);
    const html = render(renderDirector, one, { dose: 'none', caseThreshold: 20 });
    assert.match(html, /por privacidad no se muestran agregados/);
    assert.ok(!html.includes('Mapa de carga por aula'));
  });

  it('Analítica shows KPIs, distributions, dose-response, ROC with AUC table, Youden metrics and action levels', () => {
    const html = render(renderAnalytics, days, { dose: 'none', caseThreshold: 20 });
    for (const text of ['Participantes (N)', 'Distribución de', 'Curva dosis-respuesta', 'Curvas ROC', 'AUC (IC 95 %)', 'corte de Youden', 'Niveles de acción', 'Sensibilidad']) assert.ok(html.includes(text), text);
    clean(html);
  });

  it('empty datasets explain what to do', () => {
    assert.match(render(renderTeacher, [], { dose: 'none' }), /Guardar jornada/);
    assert.match(render(renderAnalytics, [], { dose: 'none', caseThreshold: 20 }), /Sin jornadas/);
  });

  it('summary CSV has one row per workday and no audio', () => {
    const csv = summariesCsv(days.slice(0, 5)).trimEnd().split('\r\n');
    assert.equal(csv.length, 6);
    assert.match(csv[0], /^id,participantId,schoolId,classroom,date/);
    assert.match(csv[0], /,units,.*,own_voice_ref_dbfs(,|$)/, 'units and the own-voice reference travel with each workday');
    const [row] = summariesCsv([{ ...days[0], units: 'normalized', ownVoiceRefDbfs: -31.5 }]).trimEnd().split('\r\n').slice(1);
    assert.match(row, /,normalized,.*,-31\.5(,|$)/);
  });
});

describe('recomputation from the per-second series (Analítica)', () => {
  const demo = generateDemoWorkdays({ seed: 7 }).slice(0, 12);
  const series = (block) => {
    const phonation = Array.from({ length: 600 }, (_, k) => (k % (2 * block) < block ? 1 : 0));
    return { phonation, f0I: phonation.map((p) => (p ? 220 : 0)) };
  };

  it('workdays without a series get a clear message instead of a table', () => {
    const html = recomputeBody(demo, {});
    assert.match(html, /Ninguna jornada tiene serie por segundo/);
    assert.match(html, /12 de 12 jornadas no tienen serie por segundo/);
    assert.doesNotMatch(html, /<table/);
  });

  it('recomputes the workdays with a series, compares each model with D0 and keeps the records', () => {
    const days = demo.map((w, i) => (i < 8 ? { ...w, perSecond: series(10 + 20 * i) } : w));
    const before = structuredClone(days);
    const html = recomputeBody(days, { recomputeBeta: '0.02', recomputeAlphaL: '0.08', outcome: 'deltaF' });
    assert.match(html, /8 jornadas con serie/);
    assert.match(html, /4 de 12 jornadas no tienen serie por segundo/);
    assert.match(html, /AUC − AUC de D0/);
    assert.match(html, /β = 0,02 s⁻¹/);
    assert.match(html, /α_L = 0,08 s⁻¹/);
    assert.deepEqual(days, before);
  });

  it('keeps β and α_L inside their ranges, with the initial values by default', () => {
    assert.deepEqual(recomputeState({}), { beta: 0.03, alphaL: 0.05 });
    assert.deepEqual(recomputeState({ recomputeBeta: '9', recomputeAlphaL: '-1' }), { beta: 0.1, alphaL: 0.005 });
  });
});
