import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateDemoWorkdays } from '../src/store/demo-data.js';
import { renderAnalytics, renderDirector, renderTeacher, summariesCsv } from '../src/ui/boards/views.js';

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
    assert.match(csv[0], /,units,.*,own_voice_ref_dbfs$/, 'units and the own-voice reference travel with each workday');
    const [row] = summariesCsv([{ ...days[0], units: 'normalized', ownVoiceRefDbfs: -31.5 }]).trimEnd().split('\r\n').slice(1);
    assert.match(row, /,normalized,.*,-31\.5$/);
  });
});
