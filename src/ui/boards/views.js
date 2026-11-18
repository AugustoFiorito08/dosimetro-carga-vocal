// The three dashboard tabs (Mi jornada, Dirección, Analítica) rendered from workday records.
// Rendering only: aggregation lives in aggregate.js, statistics in src/stats.
import { describe } from '../../stats/descriptive.js';
import { caseLabels, confusionAt, histogram, linearRegression, rocCurve, spearman, youden } from '../../stats/inference.js';
import {
  MIN_GROUP,
  actionLevels,
  classroomDayHeatmap,
  classroomSummary,
  dailyPercentiles,
  kpis,
  monthlyCounts,
  teachersWithHighPre,
  weekDays,
  weekStart,
  workdaysOfWeek,
} from './aggregate.js';
import { SERIES, barChart, compact, heatmapTable, histogramChart, lineChart, rocChart, scatterChart, timelineChart } from './charts.js';

export const DOSE_LABELS = Object.freeze({
  none: 'D0 · sin memoria',
  linear: 'DL · lineal',
  power: 'DP · potencial',
  exponential: 'DE · exponencial',
  saturating: 'DS · saturante',
  distance: 'Dd · distancia (m)',
});
const MODEL_COLORS = { none: SERIES[0], linear: SERIES[1], power: SERIES[2], exponential: SERIES[3], saturating: SERIES[4], distance: SERIES[5] };
export const EVENT_LABELS = Object.freeze({
  llamado_atencion: 'Llamado de atención',
  explicacion: 'Explicación',
  actividad_grupal: 'Actividad grupal',
  recreo: 'Recreo',
  otro: 'Otro',
  fonacion_sostenida: 'Fonación sostenida',
  nivel_elevado: 'Nivel elevado',
});
const EVENT_COLORS = {
  llamado_atencion: 'var(--status-critical)', explicacion: 'var(--status-serious)', actividad_grupal: 'var(--status-warning)',
  recreo: 'var(--status-good)', otro: 'var(--muted)', fonacion_sostenida: 'var(--score-dose)', nivel_elevado: 'var(--score-level)',
};
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie'];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString('es-AR', { maximumFractionDigits: d }) : '—');
const unitOf = (dose) => (dose === 'distance' ? 'm' : 'u');
const clock = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
const minutes = (s) => `${fmt(s / 60, 0)} min`;
const kpi = (label, value, sub = '') => `<article class="kpi"><h3>${esc(label)}</h3><p class="value">${value}</p>${sub ? `<p class="sub">${sub}</p>` : ''}</article>`;
const panel = (title, body, extra = '') => `<section class="panel board-panel ${extra}"><h2>${esc(title)}</h2>${body}</section>`;
const statsTable = (d, unit) => `<table class="stats"><tbody>${[
  ['n', fmt(d.n, 0)], ['Media', compact(d.mean)], ['Mediana', compact(d.p50)], ['DE', compact(d.sd)],
  ['P25', compact(d.p25)], ['P75', compact(d.p75)], ['P95', compact(d.p95)],
].map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}${k === 'n' ? '' : ` ${unit}`}</td></tr>`).join('')}</tbody></table>`;
const change = (w) => (w.fatigue?.pre == null || w.fatigue?.post == null ? NaN : w.fatigue.post - w.fatigue.pre);
const doseOptions = (selected, workdays) => Object.entries(DOSE_LABELS)
  .filter(([k]) => k !== 'distance' || workdays.some((w) => Number.isFinite(w.doses.distance)))
  .map(([k, v]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${v}</option>`).join('');

const DISCLAIMER = '<p class="board-disclaimer">Valores provisionales · sin umbrales sanitarios validados. La carga acústica no identifica por sí sola la actividad ni diagnostica fatiga.</p>';

/** Status of a dose against the provisional action levels, always with icon and label. */
function zone(value, levels) {
  if (!Number.isFinite(value) || levels.c1 === null) return '<span class="zone">—</span>';
  if (levels.c2 !== null && value >= levels.c2) return '<span class="zone zone-critical">▲ Alta</span>';
  if (value >= levels.c1) return '<span class="zone zone-warning">● Media</span>';
  return '<span class="zone zone-good">▼ Baja</span>';
}

function eventMarks(events) {
  return events.map((e) => ({ t: e.t, label: `${EVENT_LABELS[e.type] ?? e.type}${e.detail ? ` (${e.detail})` : ''}`, color: EVENT_COLORS[e.type] ?? 'var(--muted)' }));
}

function rateBars(w, dose) {
  const values = w.timeline.doses[dose] ?? [];
  const rates = values.map((v, i) => v - (i ? values[i - 1] : 0));
  const step = Math.max(1, Math.ceil(rates.length / 48));
  const labels = [];
  const grouped = [];
  for (let i = 0; i < rates.length; i += step) {
    labels.push(i % (step * 8) === 0 ? clock(new Date(new Date(w.startedAt).getTime() + i * 60000).toISOString()) : '');
    grouped.push(rates.slice(i, i + step).reduce((a, b) => a + b, 0) / step);
  }
  return barChart({ labels, series: [{ name: `ΔD/Δt (${unitOf(dose)}/min)`, values: grouped, color: 'var(--score-rate)' }], height: 170, yLabel: `${unitOf(dose)}/min`, label: 'Tasa de dosis por minuto' });
}

// ---------------------------------------------------------------- Mi jornada
export function renderTeacher(root, workdays, state) {
  const teachers = [...new Set(workdays.map((w) => w.participantId))].sort();
  const participant = teachers.includes(state.participant) ? state.participant : teachers[0];
  const own = workdays.filter((w) => w.participantId === participant);
  const w = own.find((x) => x.id === state.workdayId) ?? own[0];
  if (!w) {
    root.innerHTML = panel('Mi jornada', '<p class="board-empty">Todavía no hay jornadas guardadas. Medí una sesión y usá «Guardar jornada», o elegí «Datos simulados».</p>');
    return;
  }
  state.participant = participant;
  state.workdayId = w.id;
  const dose = state.dose;
  const reference = describe(own.map((x) => x.doses[dose]));
  const events = [...w.events].sort((a, b) => a.t - b.t);
  root.innerHTML = `
    <div class="board-filters">
      <label>Docente <select data-filter="participant">${teachers.map((t) => `<option${t === participant ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label>Jornada <select data-filter="workdayId">${own.map((x) => `<option value="${esc(x.id)}"${x.id === w.id ? ' selected' : ''}>${dayLabel(x.date)} · ${clock(x.startedAt)}</option>`).join('')}</select></label>
      <label>Dosis <select data-filter="dose">${doseOptions(dose, own)}</select></label>
    </div>
    <section class="kpis board-kpis">
      ${kpi('Fonación', minutes(w.phonationS))}
      ${kpi('Tiempo observado', minutes(w.durationS))}
      ${kpi('Fonación', `${fmt((100 * w.phonationS) / w.durationS, 0)} %`)}
      ${kpi('Dosis de la jornada', `${compact(w.doses[dose])} <small>${unitOf(dose)}</small>`, `Tu mediana: ${compact(reference.p50)} ${unitOf(dose)}`)}
      ${kpi('Fatiga EVA', `${fmt(w.fatigue.pre, 0)} → ${fmt(w.fatigue.post, 0)}`, 'pre → post (0-100)')}
    </section>
    <div class="board-grid">
      ${panel(`Dosis acumulada ${DOSE_LABELS[dose]}`, timelineChart({ minutes: w.timeline.minutes, values: w.timeline.doses[dose] ?? [], events: eventMarks(events), color: 'var(--score-dose)', startDate: new Date(w.startedAt), yLabel: unitOf(dose) }) + '<p class="hint">Los picos de la tasa no hacen bajar la dosis acumulada: en las pausas se mantiene.</p>')}
      ${panel('Tasa de acumulación (ΔD/Δt)', rateBars(w, dose))}
      ${panel('Eventos de la jornada', events.length ? `<table class="board-table"><thead><tr><th>Hora</th><th>Evento</th><th>Duración</th><th>Origen</th></tr></thead><tbody>${events.map((e) => `<tr><td>${clock(new Date(new Date(w.startedAt).getTime() + e.t * 1000).toISOString())}</td><td><span class="dot-swatch" style="background:${EVENT_COLORS[e.type]}"></span>${esc(EVENT_LABELS[e.type] ?? e.type)}${e.detail ? ` · ${esc(e.detail)}` : ''}</td><td>${e.durationS ? `${fmt(e.durationS, 0)} s` : '—'}</td><td>${e.source === 'docente' ? 'Docente' : 'Algoritmo'}</td></tr>`).join('')}</tbody></table>` : '<p class="board-empty">Sin eventos registrados.</p>')}
    </div>
    ${DISCLAIMER}`;
}

// ---------------------------------------------------------------- Dirección
export function renderDirector(root, workdays, state) {
  const schools = [...new Set(workdays.map((w) => w.schoolId))].sort();
  if (!schools.length) {
    root.innerHTML = panel('Tablero de Dirección', '<p class="board-empty">Sin jornadas para mostrar.</p>');
    return;
  }
  const school = schools.includes(state.school) ? state.school : schools[0];
  const weeks = [...new Set(workdays.filter((w) => w.schoolId === school).map((w) => weekStart(w.date)))].sort().reverse();
  const monday = weeks.includes(state.week) ? state.week : weeks[0];
  Object.assign(state, { school, week: monday });
  const dose = state.dose;
  const unit = unitOf(dose);
  const week = workdaysOfWeek(workdays, { schoolId: school, weekStart: monday });
  const prev = workdaysOfWeek(workdays, { schoolId: school, weekStart: weeks[weeks.indexOf(monday) + 1] ?? '0000-01-01' });
  const days = weekDays(monday);
  const meanOf = (ws, pick) => describe(ws.map(pick)).mean;
  const delta = (now, before) => (Number.isFinite(now) && Number.isFinite(before) && before !== 0 ? `${now >= before ? '▲' : '▼'} ${fmt(Math.abs((100 * (now - before)) / before), 0)} % vs. semana anterior` : '');
  const doseNow = meanOf(week, (w) => w.doses[dose]);
  const postNow = meanOf(week, (w) => w.fatigue.post);
  const levels = actionLevels(workdays.map((w) => w.doses[dose]), caseLabels(workdays, state.caseThreshold));
  const high = teachersWithHighPre(week, 30);
  const heat = classroomDayHeatmap(week, dose, monday);
  const rows = classroomSummary(week, dose);
  const teachers = [...new Set(week.map((w) => w.participantId))].sort();
  const focus = teachers.includes(state.focus) ? state.focus : teachers[0];
  state.focus = focus;
  const focusDay = week.filter((w) => w.participantId === focus).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  const p = dailyPercentiles(week, (w) => w.fatigue.pre, days);
  const histPre = histogram(week.map((w) => w.fatigue.pre), { bins: 10, min: 0, max: 100 });
  const histPost = histogram(week.map((w) => w.fatigue.post), { bins: 10, min: 0, max: 100 });
  const enough = new Set(week.map((w) => w.participantId)).size >= MIN_GROUP;
  root.innerHTML = `
    <div class="board-filters">
      <label>Escuela <select data-filter="school">${schools.map((s) => `<option${s === school ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label>Semana <select data-filter="week">${weeks.map((m) => `<option value="${m}"${m === monday ? ' selected' : ''}>${dayLabel(m)} – ${dayLabel(weekDays(m)[4])}</option>`).join('')}</select></label>
      <label>Dosis <select data-filter="dose">${doseOptions(dose, workdays)}</select></label>
      <span class="board-badge">Vista preventiva · acceso restringido · docentes por código</span>
    </div>
    <section class="kpis board-kpis">
      ${kpi('Docentes con jornadas', fmt(teachers.length, 0))}
      ${kpi('Jornadas registradas', fmt(week.length, 0), 'esta semana')}
      ${kpi('Carga vocal promedio', `${compact(doseNow)} <small>${unit}</small>`, delta(doseNow, meanOf(prev, (w) => w.doses[dose])))}
      ${kpi('Fatiga post promedio', `${fmt(postNow, 0)} <small>/100</small>`, delta(postNow, meanOf(prev, (w) => w.fatigue.post)))}
      ${kpi('Docentes con EVA pre ≥ 30', fmt(high.length, 0), enough ? '' : `grupo menor a ${MIN_GROUP}: no se muestra`)}
    </section>
    ${enough ? `<div class="board-grid">
      ${panel(`Mapa de carga por aula y día · ${DOSE_LABELS[dose]}`, (heat.classrooms.length ? heatmapTable({ rows: heat.classrooms, cols: days.map((d, i) => `${WEEKDAYS[i]} ${dayLabel(d)}`), cells: heat.cells, caption: `Promedio de la jornada completa (${unit})` }) : '<p class="board-empty">Ningún aula alcanza el mínimo de docentes.</p>') + (heat.suppressed.length ? `<p class="hint">Aulas con menos de ${MIN_GROUP} docentes no se muestran: ${heat.suppressed.map(esc).join(', ')}.</p>` : ''), 'span-2')}
      ${panel('Docentes con fatiga prejornada elevada', high.length ? `<table class="board-table"><thead><tr><th>Docente</th><th>Aula</th><th>EVA pre media</th><th>Últimos valores</th></tr></thead><tbody>${high.map((r) => `<tr><td>${esc(r.participantId)}</td><td>${esc(r.classroom)}</td><td class="num">${fmt(r.meanPre, 0)}</td><td>${r.trend.map((v) => `<span class="spark" style="height:${4 + v / 5}px" title="${v}"></span>`).join('')}</td></tr>`).join('')}</tbody></table><p class="hint">Sugiere revisar organización y tiempos de recuperación; no es un diagnóstico.</p>` : '<p class="board-empty">Ningún docente con EVA pre media ≥ 30.</p>')}
      ${panel('Carga vocal por aula', `<table class="board-table"><thead><tr><th>Aula</th><th>Docentes</th><th>${dose === 'distance' ? 'Dd' : 'Dosis'} prom.</th><th>Fatiga post</th><th>Estado</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.classroom)}</td><td class="num">${r.teachers}</td><td class="num">${r.suppressed ? 'oculto' : compact(r.meanDose)}</td><td class="num">${r.suppressed ? '—' : fmt(r.meanPost, 0)}</td><td>${r.suppressed ? '<span class="zone">grupo &lt; 3</span>' : zone(r.meanDose, levels)}</td></tr>`).join('')}</tbody></table>`)}
      ${panel('Distribución de fatiga (EVA 0-100)', barChart({ labels: histPre.edges.slice(0, -1).map((e) => `${e}`), series: [{ name: 'Prejornada', values: histPre.counts, color: SERIES[0] }, { name: 'Postjornada', values: histPost.counts, color: SERIES[1] }], height: 190, yLabel: 'Jornadas', label: 'Distribución de fatiga pre y post' }) + '<p class="legend-inline"><span class="dot-swatch" style="background:var(--score-f0)"></span>Prejornada <span class="dot-swatch" style="background:var(--score-level)"></span>Postjornada</p>')}
      ${panel('Evolución semanal · fatiga prejornada', lineChart({ xs: days.map((d, i) => `${WEEKDAYS[i]} ${dayLabel(d)}`), series: [{ name: 'P90', values: p.p90, color: SERIES[1] }, { name: 'Mediana', values: p.p50, color: SERIES[3] }, { name: 'P10', values: p.p10, color: SERIES[2] }], yLabel: 'EVA', label: 'Percentiles de fatiga prejornada por día' }) + '<p class="legend-inline"><span class="dot-swatch" style="background:var(--score-level)"></span>P90 <span class="dot-swatch" style="background:var(--score-rate)"></span>Mediana <span class="dot-swatch" style="background:var(--score-h)"></span>P10</p>')}
      ${panel('Jornada de un docente', `<label class="inline">Docente <select data-filter="focus">${teachers.map((t) => `<option${t === focus ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>${focusDay ? timelineChart({ minutes: focusDay.timeline.minutes, values: focusDay.timeline.doses[dose] ?? [], events: eventMarks(focusDay.events), color: 'var(--score-dose)', startDate: new Date(focusDay.startedAt), yLabel: unit }) + `<p class="hint">${dayLabel(focusDay.date)} · ${DOSE_LABELS[dose]} final ${compact(focusDay.doses[dose])} ${unit}. Detalle individual sujeto a autorización del docente.</p>` : ''}`, 'span-2')}
    </div>` : `<p class="board-empty">Esta semana hay menos de ${MIN_GROUP} docentes con jornadas: por privacidad no se muestran agregados.</p>`}
    ${DISCLAIMER}`;
}

// ---------------------------------------------------------------- Analítica
export function renderAnalytics(root, workdays, state) {
  if (!workdays.length) {
    root.innerHTML = panel('Analítica', '<p class="board-empty">Sin jornadas para analizar.</p>');
    return;
  }
  const dose = state.dose;
  const unit = unitOf(dose);
  const k = kpis(workdays);
  const months = monthlyCounts(workdays).slice(-12);
  const doses = workdays.map((w) => w.doses[dose]);
  const changes = workdays.map(change);
  const dDose = describe(doses);
  const dChange = describe(changes);
  const hDose = histogram(doses, { bins: 24 });
  const hChange = histogram(changes, { bins: 20 });
  const labels = caseLabels(workdays, state.caseThreshold);
  const fit = linearRegression(doses, changes);
  const rho = spearman(doses, changes);
  const models = Object.keys(DOSE_LABELS).filter((m) => m !== 'distance' || workdays.some((w) => Number.isFinite(w.doses.distance)));
  const rocs = Object.fromEntries(models.map((m) => [m, rocCurve(workdays.map((w) => w.doses[m]), labels)]));
  const best = youden(rocs[dose]);
  const perf = best ? confusionAt(doses, labels, best.threshold) : null;
  const levels = actionLevels(doses, labels);
  const cases = labels.filter((l) => l === 1).length;
  const controls = labels.filter((l) => l === 0).length;
  const ci = (m) => `${fmt(m.value, 2)} <span class="ci">(${fmt(m.ci[0], 2)}–${fmt(m.ci[1], 2)})</span>`;
  const latest = [...workdays].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 10);
  const scaleMax = Math.max(dDose.p95 * 1.2, levels.c2 ?? 0);
  const pos = (v) => `${Math.min(100, (100 * v) / scaleMax)}%`;
  root.innerHTML = `
    <div class="board-filters">
      <label>Dosis <select data-filter="dose">${doseOptions(dose, workdays)}</select></label>
      <label>Caso: aumento de EVA ≥ <input data-filter="caseThreshold" type="number" min="1" max="100" step="1" value="${state.caseThreshold}"> puntos</label>
      <button type="button" class="btn" data-action="export-csv">Exportar resúmenes (CSV)</button>
    </div>
    <section class="kpis board-kpis">
      ${kpi('Participantes (N)', fmt(k.participants, 0))}
      ${kpi('Jornadas recibidas', fmt(k.workdays, 0), `válidas: ${fmt(k.valid, 0)}`)}
      ${kpi('Escuelas', fmt(k.schools, 0))}
      ${kpi('Última recepción', k.lastReception ? new Date(k.lastReception).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—')}
      ${kpi('Calidad global', `${fmt(100 * k.quality, 1)} %`, 'tiempo con clasificación cierta')}
    </section>
    <div class="board-grid">
      ${panel('Evolución de la participación', barChart({ labels: months.map((m) => new Date(`${m.month}-15T12:00:00`).toLocaleDateString('es-AR', { month: 'short' })), series: [{ name: 'Recibidas', values: months.map((m) => m.received), color: SERIES[0] }, { name: 'Válidas', values: months.map((m) => m.valid), color: SERIES[2] }], yLabel: 'Jornadas', label: 'Jornadas recibidas y válidas por mes' }) + '<p class="legend-inline"><span class="dot-swatch" style="background:var(--score-f0)"></span>Recibidas <span class="dot-swatch" style="background:var(--score-h)"></span>Válidas</p>')}
      ${panel(`Distribución de ${DOSE_LABELS[dose]}`, `<div class="with-stats">${histogramChart({ ...hDose, color: MODEL_COLORS[dose], xLabel: `${DOSE_LABELS[dose]} (${unit})`, marker: { x: dDose.p95, label: `P95 = ${compact(dDose.p95)}` } })}${statsTable(dDose, unit)}</div>`)}
      ${panel('Distribución del cambio de fatiga (EVA post − pre)', `<div class="with-stats">${histogramChart({ ...hChange, color: SERIES[1], xLabel: 'Cambio de EVA (puntos)', marker: { x: state.caseThreshold, label: `caso ≥ ${state.caseThreshold}` } })}${statsTable(dChange, 'pts')}</div>`)}
      ${panel('Últimas jornadas recibidas', `<div class="table-scroll"><table class="board-table"><thead><tr><th>Sesión</th><th>Participante</th><th>Fecha</th><th>Escuela</th><th>Duración</th><th>${dose === 'distance' ? 'Dd' : 'Dosis'}</th><th>ΔEVA</th><th>Calidad</th><th>Estado</th></tr></thead><tbody>${latest.map((w) => `<tr><td>${esc(w.id)}</td><td>${esc(w.participantId)}</td><td>${dayLabel(w.date)}</td><td>${esc(w.schoolId)}</td><td>${minutes(w.durationS)}</td><td class="num">${compact(w.doses[dose])}</td><td class="num">${fmt(change(w), 0)}</td><td class="num">${fmt(100 * w.validRatio, 1)} %</td><td>${w.validRatio >= 0.9 ? '<span class="zone zone-good">✓ Válida</span>' : '<span class="zone zone-warning">! Revisar</span>'}</td></tr>`).join('')}</tbody></table></div>`, 'span-2')}
      ${panel('Curva dosis-respuesta (ΔEVA vs dosis)', scatterChart({ points: workdays.map((w) => [w.doses[dose], change(w)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)), fit, color: MODEL_COLORS[dose], xLabel: `${DOSE_LABELS[dose]} (${unit})`, yLabel: 'ΔEVA' }) + `<p class="hint">Regresión lineal (OLS) con banda de confianza al 95 % de la media · n = ${fit.n} · R² = ${fmt(fit.r2, 2)} · Spearman ρ = ${fmt(rho, 2)}. Modelos mixtos y splines quedan para el análisis definitivo.</p>`)}
      ${panel(`Curvas ROC para fatiga relevante (caso: ΔEVA ≥ ${state.caseThreshold})`, `<div class="with-stats">${rocChart({ curves: models.map((m) => ({ name: DOSE_LABELS[m], points: rocs[m].points, color: MODEL_COLORS[m] })) })}<table class="stats"><thead><tr><th>Modelo</th><th>AUC (IC 95 %)</th></tr></thead><tbody>${models.map((m) => `<tr><th scope="row"><span class="dot-swatch" style="background:${MODEL_COLORS[m]}"></span>${DOSE_LABELS[m].split(' ·')[0]}</th><td>${fmt(rocs[m].auc, 2)} <span class="ci">(${fmt(rocs[m].ci[0], 2)}–${fmt(rocs[m].ci[1], 2)})</span></td></tr>`).join('')}</tbody></table></div><p class="hint">${cases} casos · ${controls} controles. Validación agrupada por docente pendiente: estas AUC son aparentes, sobre la misma muestra.</p>`)}
      ${panel(`Desempeño de ${DOSE_LABELS[dose]} en el corte de Youden`, perf ? `<table class="stats"><thead><tr><th>Métrica</th><th>Valor (IC 95 %)</th></tr></thead><tbody>
        <tr><th scope="row">Corte</th><td>${compact(best.threshold)} ${unit}</td></tr>
        <tr><th scope="row">AUC</th><td>${fmt(rocs[dose].auc, 2)} <span class="ci">(${fmt(rocs[dose].ci[0], 2)}–${fmt(rocs[dose].ci[1], 2)})</span></td></tr>
        <tr><th scope="row">Sensibilidad</th><td>${ci(perf.sensitivity)}</td></tr><tr><th scope="row">Especificidad</th><td>${ci(perf.specificity)}</td></tr>
        <tr><th scope="row">VPP</th><td>${ci(perf.ppv)}</td></tr><tr><th scope="row">VPN</th><td>${ci(perf.npv)}</td></tr>
        <tr><th scope="row">Índice de Youden</th><td>${fmt(best.j, 2)}</td></tr></tbody></table>` : '<p class="board-empty">Hace falta EVA pre y post en casos y controles.</p>')}
      ${panel('Niveles de acción (provisionales)', levels.c1 !== null ? `<div class="levels"><div class="levels-bar"><span class="lv lv-good" style="width:${pos(levels.c1)}"></span><span class="lv lv-warning" style="width:calc(${pos(levels.c2 ?? levels.c1)} - ${pos(levels.c1)})"></span><span class="lv lv-critical" style="flex:1"></span></div>
        <p class="levels-cuts">C1 = ${compact(levels.c1)} ${unit} (Youden) · C2 = ${levels.c2 === null ? '—' : `${compact(levels.c2)} ${unit}`} (especificidad ≥ 0,90)</p>
        <ul class="levels-list"><li><span class="zone zone-good">▼ Baja</span> ${DOSE_LABELS[dose].split(' ·')[0]} &lt; C1</li><li><span class="zone zone-warning">● Media</span> C1 ≤ dosis &lt; C2: vigilancia y medidas preventivas</li><li><span class="zone zone-critical">▲ Alta</span> dosis ≥ C2</li></ul></div>
        <p class="hint">Derivados de los datos en pantalla; deben validarse en una cohorte externa antes de usarse.</p>` : '<p class="board-empty">Sin casos y controles suficientes.</p>')}
    </div>
    ${DISCLAIMER}`;
}

/** CSV of the workday summaries (one row per workday, no audio, codes only). */
export function summariesCsv(workdays) {
  const cols = ['id', 'participantId', 'schoolId', 'classroom', 'date', 'durationS', 'phonationS', 'validRatio',
    'd_0', 'd_l', 'd_p', 'd_e', 'd_s', 'd_d', 'd_t', 'd_c', 'hMax', 'f0_p50', 'level_p50', 'units', 'fatigue_pre', 'fatigue_post', 'source', 'algorithmVersion'];
  const cell = (v) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  const rows = workdays.map((w) => [w.id, w.participantId, w.schoolId, w.classroom, w.date, w.durationS, w.phonationS, w.validRatio,
    w.doses.none, w.doses.linear, w.doses.power, w.doses.exponential, w.doses.saturating, w.doses.distance, w.doses.time, w.doses.cycle,
    w.hMax, w.f0?.p50, w.level?.p50, w.units, w.fatigue.pre, w.fatigue.post, w.source, w.algorithmVersion].map(cell).join(','));
  return [cols.join(','), ...rows].join('\r\n') + '\r\n';
}
