import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateDemoWorkdays } from '../src/store/demo-data.js';
import { RECOMPUTE_GROUPS, paramText, recomputeBody, recomputeState, renderAnalytics, renderDirector, renderTeacher, summariesCsv } from '../src/ui/boards/views.js';

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
    const html = recomputeBody(days, { 'recompute:beta': '0.02', 'recompute:alphaL': '0.08', 'recompute:kH': '60', outcome: 'deltaF' });
    assert.match(html, /8 jornadas con serie/);
    assert.match(html, /4 de 12 jornadas no tienen serie por segundo/);
    assert.match(html, /AUC − AUC de D0/);
    assert.match(html, /β = 0,02 s⁻¹/);
    assert.match(html, /α_L = 0,08 s⁻¹/);
    assert.match(html, /K_H = 60 s/);
    assert.match(html, /H_ref = 20 s \(fijo\)/);
    assert.deepEqual(days, before);
  });

  it('draws exploratory dose-response and ROC curves from the recomputed doses, apart from the main ones', () => {
    const days = demo.map((w, i) => (i < 8 ? { ...w, perSecond: series(10 + 20 * i) } : w));
    const html = recomputeBody(days, { outcome: 'deltaF', recomputeModel: 'saturating' });
    assert.match(html, /Curva dosis-respuesta exploratoria \(DS · saturante\)/);
    assert.match(html, /Curvas ROC exploratorias/);
    assert.match(html, /n = \d+ · R² = /);
    assert.equal((html.match(/<svg/g) ?? []).length, 2);
    assert.match(html, /no cambia las curvas, el corte de Youden ni los niveles de acción de arriba/);
    assert.match(recomputeBody(days, { outcome: 'deltaF' }), /exploratoria \(DL · lineal\)/, 'the linear model by default');
  });

  it('leaves the main curves on the stored doses whatever the sliders say', () => {
    const days = demo.map((w, i) => (i < 8 ? { ...w, perSecond: series(10 + 20 * i) } : w));
    const root = (state) => {
      const node = { innerHTML: '' };
      renderAnalytics(node, days, { dose: 'linear', outcome: 'deltaF', caseThreshold: 20, ...state });
      return node.innerHTML.replace(/<section class="panel board-panel span-2"><h2>Recálculo desde la serie por segundo[\s\S]*?<\/section>/, '');
    };
    assert.equal(root({}), root({ 'recompute:beta': '0.1', 'recompute:alphaL': '0.1' }));
  });

  it('keeps every parameter inside its range, with the initial values by default', () => {
    assert.deepEqual(recomputeState({}), { beta: 0.03, alphaL: 0.05, a: 1, p: 2, alphaE: 0.025, A: 3, kH: 40 });
    const clamped = recomputeState({ 'recompute:beta': '9', 'recompute:alphaL': '-1', 'recompute:kH': '500', 'recompute:a': 'x' });
    assert.deepEqual([clamped.beta, clamped.alphaL, clamped.kH, clamped.a], [0.1, 0.005, 120, 1]);
  });

  it('shows each value with its step precision and a decimal comma', () => {
    assert.equal(paramText('beta', 0.03), '0,030');
    assert.equal(paramText('alphaE', 0.025), '0,025');
    assert.equal(paramText('A', 3), '3,00');
    assert.equal(paramText('kH', 40), '40');
  });

  it('groups one slider per parameter by model family, with H_ref fixed', () => {
    const names = RECOMPUTE_GROUPS.flatMap((g) => g.params.map(([n]) => n));
    assert.deepEqual(names, ['beta', 'alphaL', 'a', 'p', 'alphaE', 'A', 'kH']);
    assert.match(RECOMPUTE_GROUPS.find((g) => g.title === 'Potencial').note, /H_ref = 20 s, fijo/);
  });
});
