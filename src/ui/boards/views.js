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
import { OUTCOMES, outcomeCase, outcomeValue } from '../../stats/outcomes.js';
import { recoveryIndices } from '../../stats/recovery.js';
import { FIXED_H_REF, PARAM_RANGES, RECOMPUTED_MODELS, compareModels, recomputeWorkdays } from '../../stats/dose-recompute.js';
import { recoverySchedule } from '../../store/recovery.js';
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

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const RECOVERY_STATUS = { done: 'Registrado', open: 'Ahora', upcoming: 'Pendiente', missed: 'No registrado' };
const duration = (min) => (min < 60 ? `${fmt(min, 0)} min` : `${Math.floor(min / 60)} h${Math.round(min % 60) ? ` ${Math.round(min % 60)} min` : ''}`);
const reachTime = (t, censored, horizon) => (Number.isFinite(t) ? duration(t) : censored ? `&gt; ${duration(horizon)}` : '—');
const reachNote = (level, censored) => (censored ? `${level} % aún no alcanzado` : `${level} % recuperado`);

/** Fatigue after the workday at the fixed times, with R(t), T50, T90 and AUC_F (hito 10). */
function recoveryPanel(w, now, notificationPermission = 'unsupported') {
  const schedule = recoverySchedule(w, now);
  const r = recoveryIndices({ pre: w.fatigue.pre, post: w.fatigue.post, points: w.fatigue.recovery ?? [] });
  const editable = w.source === 'live' && w.checkpoint?.status !== 'in_progress';
  const open = editable ? schedule.find((s) => s.status === 'open') : null;
  const last = w.fatigue.recovery?.at(-1)?.value ?? w.fatigue.post ?? 50;
  const rOf = (p) => r.points.find((x) => x.minutes === p.minutes)?.r;
  const rows = schedule.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.targetMin === null ? `${dayLabel(localDay(s.dueAt))}, ${clock(s.dueAt.toISOString())}–${clock(s.closesAt.toISOString())}` : clock(s.dueAt.toISOString())}</td><td>${s.point ? fmt(s.point.value, 0) : '—'}</td><td>${s.point && Number.isFinite(rOf(s.point)) ? `${fmt(100 * rOf(s.point), 0)} %` : '—'}</td><td>${RECOVERY_STATUS[s.status]}</td></tr>`).join('');
  const form = open
    ? `<div class="recovery-form"><label>Fatiga ahora (${esc(open.label)}) <input type="range" min="0" max="100" step="1" value="${fmt(last, 0)}" data-recovery-value /> <output>${fmt(last, 0)}</output>/100</label> <button type="button" data-action="recovery-save" data-slot="${open.id}">Registrar</button></div>`
    : `<p class="hint">${editable ? 'No hay ningún momento abierto ahora. Cada uno se abre 5 min antes de su hora y se cierra cuando se abre el siguiente; el de la mañana siguiente va de 05:00 a 12:00.' : 'La recuperación solo se registra en jornadas medidas en este equipo.'}</p>`;
  const pending = editable && schedule.some((s) => s.status === 'upcoming' || s.status === 'open');
  const notifyState = {
    default: '<button type="button" class="btn" data-action="recovery-notify">Activar avisos del navegador</button>',
    granted: '<span class="hint">Avisos del navegador activados: llegan solo con la app abierta.</span>',
    denied: '<span class="hint">El navegador bloqueó los avisos: usá el calendario.</span>',
  }[notificationPermission] ?? '';
  const reminders = pending
    ? `<div class="recovery-form"><button type="button" class="btn" data-action="recovery-ics">Agregar los horarios al calendario (.ics)</button>${notifyState}</div>
    <p class="hint">El calendario del celular avisa en cada horario aunque la app esté cerrada.</p>`
    : '';
  const kpis = `<section class="kpis board-kpis">
      ${kpi('ΔF', fmt(r.deltaF, 0), 'post − pre (0-100)')}
      ${kpi('T₅₀', reachTime(r.t50Min, r.t50Censored, r.horizonMin), reachNote(50, r.t50Censored))}
      ${kpi('T₉₀', reachTime(r.t90Min, r.t90Censored, r.horizonMin), reachNote(90, r.t90Censored))}
      ${kpi('AUC_F', fmt(r.aucF, 1), r.horizonMin === null ? 'EVA·h' : `EVA·h, hasta ${duration(r.horizonMin)}`)}
    </section>`;
  return panel('Recuperación después de la jornada', `${form}
    ${reminders}
    <table class="board-table"><thead><tr><th>Momento</th><th>Hora prevista</th><th>Fatiga EVA</th><th>R(t)</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table>
    ${kpis}
    <p class="hint">R(t) es la parte del aumento de fatiga ya recuperada. Si la fatiga no subió durante la jornada, no hay nada que recuperar y T₅₀ y T₉₀ quedan vacíos.</p>`, 'span-2');
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
      ${recoveryPanel(w, (state.now ?? (() => new Date()))(), state.notificationPermission)}
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
  const outcomeKey = OUTCOMES[state.outcome] ? state.outcome : 'deltaF';
  const outcome = OUTCOMES[outcomeKey];
  const threshold = state[outcome.thresholdKey] ?? outcome.defaultThreshold;
  const changes = workdays.map((w) => outcomeValue(w, outcomeKey));
  const dDose = describe(doses);
  const dChange = describe(changes);
  const hDose = histogram(doses, { bins: 24 });
  const hChange = histogram(changes, { bins: 20 });
  const labels = workdays.map((w) => outcomeCase(w, outcomeKey, threshold));
  const withRecovery = workdays.filter((w) => w.fatigue?.recovery?.length).length;
  const censored = outcomeKey === 't90' ? workdays.filter((w) => w.fatigue?.recovery?.length && outcomeCase(w, 't90', 0) === 1 && Number.isNaN(outcomeValue(w, 't90'))).length : 0;
  const outcomeNote = outcomeKey === 'deltaF' ? '' : ` ${withRecovery} de ${workdays.length} jornadas tienen datos de recuperación.${outcomeKey === 'aucF' ? ' AUC_F se calcula de 0 a 4 h y necesita el registro de +4 h.' : ` ${censored} con T₉₀ censurado (90 % no alcanzado en el seguimiento) quedan fuera de la distribución y de la regresión; en la ROC cuentan como caso si se siguieron hasta el umbral.`}`;
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
      <label>Desenlace <select data-filter="outcome">${Object.entries(OUTCOMES).map(([k, o]) => `<option value="${k}"${k === outcomeKey ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
      <label>${esc(outcome.thresholdText)} <input data-filter="${outcome.thresholdKey}" type="number" min="${outcome.min}" max="${outcome.max}" step="1" value="${threshold}"> ${esc(outcome.thresholdUnit)}</label>
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
      ${panel(`Distribución de ${outcome.label}`, `<div class="with-stats">${histogramChart({ ...hChange, color: SERIES[1], xLabel: `${outcome.short} (${outcome.unit})`, marker: { x: threshold, label: `caso: ${outcome.caseText(threshold)}` } })}${statsTable(dChange, outcome.unit)}</div>${outcomeNote ? `<p class="hint">${esc(outcomeNote.trim())}</p>` : ''}`)}
      ${panel('Últimas jornadas recibidas', `<div class="table-scroll"><table class="board-table"><thead><tr><th>Sesión</th><th>Participante</th><th>Fecha</th><th>Escuela</th><th>Duración</th><th>${dose === 'distance' ? 'Dd' : 'Dosis'}</th><th>${esc(outcome.short)}</th><th>Calidad</th><th>Estado</th></tr></thead><tbody>${latest.map((w) => `<tr><td>${esc(w.id)}</td><td>${esc(w.participantId)}</td><td>${dayLabel(w.date)}</td><td>${esc(w.schoolId)}</td><td>${minutes(w.durationS)}</td><td class="num">${compact(w.doses[dose])}</td><td class="num">${fmt(outcomeValue(w, outcomeKey), 0)}</td><td class="num">${fmt(100 * w.validRatio, 1)} %</td><td>${w.validRatio >= 0.9 ? '<span class="zone zone-good">✓ Válida</span>' : '<span class="zone zone-warning">! Revisar</span>'}</td></tr>`).join('')}</tbody></table></div>`, 'span-2')}
      ${panel(`Curva dosis-respuesta (${outcome.short} vs dosis)`, scatterChart({ points: workdays.map((w) => [w.doses[dose], outcomeValue(w, outcomeKey)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)), fit, color: MODEL_COLORS[dose], xLabel: `${DOSE_LABELS[dose]} (${unit})`, yLabel: outcome.short }) + `<p class="hint">Regresión lineal (OLS) con banda de confianza al 95 % de la media · n = ${fit.n} · R² = ${fmt(fit.r2, 2)} · Spearman ρ = ${fmt(rho, 2)}. Modelos mixtos y splines quedan para el análisis definitivo.</p>`)}
      ${panel(`Curvas ROC (caso: ${outcome.caseText(threshold)})`, `<div class="with-stats">${rocChart({ curves: models.map((m) => ({ name: DOSE_LABELS[m], points: rocs[m].points, color: MODEL_COLORS[m] })) })}<table class="stats"><thead><tr><th>Modelo</th><th>AUC (IC 95 %)</th></tr></thead><tbody>${models.map((m) => `<tr><th scope="row"><span class="dot-swatch" style="background:${MODEL_COLORS[m]}"></span>${DOSE_LABELS[m].split(' ·')[0]}</th><td>${fmt(rocs[m].auc, 2)} <span class="ci">(${fmt(rocs[m].ci[0], 2)}–${fmt(rocs[m].ci[1], 2)})</span></td></tr>`).join('')}</tbody></table></div><p class="hint">${cases} casos · ${controls} controles. Validación agrupada por docente pendiente: estas AUC son aparentes, sobre la misma muestra.</p>`)}
      ${panel(`Desempeño de ${DOSE_LABELS[dose]} en el corte de Youden`, perf ? `<table class="stats"><thead><tr><th>Métrica</th><th>Valor (IC 95 %)</th></tr></thead><tbody>
        <tr><th scope="row">Corte</th><td>${compact(best.threshold)} ${unit}</td></tr>
        <tr><th scope="row">AUC</th><td>${fmt(rocs[dose].auc, 2)} <span class="ci">(${fmt(rocs[dose].ci[0], 2)}–${fmt(rocs[dose].ci[1], 2)})</span></td></tr>
        <tr><th scope="row">Sensibilidad</th><td>${ci(perf.sensitivity)}</td></tr><tr><th scope="row">Especificidad</th><td>${ci(perf.specificity)}</td></tr>
        <tr><th scope="row">VPP</th><td>${ci(perf.ppv)}</td></tr><tr><th scope="row">VPN</th><td>${ci(perf.npv)}</td></tr>
        <tr><th scope="row">Índice de Youden</th><td>${fmt(best.j, 2)}</td></tr></tbody></table>` : '<p class="board-empty">Hacen falta casos y controles con el desenlace elegido.</p>')}
      ${recomputePanel(workdays, state)}
      ${panel('Niveles de acción (provisionales)', levels.c1 !== null ? `<div class="levels"><div class="levels-bar"><span class="lv lv-good" style="width:${pos(levels.c1)}"></span><span class="lv lv-warning" style="width:calc(${pos(levels.c2 ?? levels.c1)} - ${pos(levels.c1)})"></span><span class="lv lv-critical" style="flex:1"></span></div>
        <p class="levels-cuts">C1 = ${compact(levels.c1)} ${unit} (Youden) · C2 = ${levels.c2 === null ? '—' : `${compact(levels.c2)} ${unit}`} (especificidad ≥ 0,90)</p>
        <ul class="levels-list"><li><span class="zone zone-good">▼ Baja</span> ${DOSE_LABELS[dose].split(' ·')[0]} &lt; C1</li><li><span class="zone zone-warning">● Media</span> C1 ≤ dosis &lt; C2: vigilancia y medidas preventivas</li><li><span class="zone zone-critical">▲ Alta</span> dosis ≥ C2</li></ul></div>
        <p class="hint">Derivados de los datos en pantalla; deben validarse en una cohorte externa antes de usarse.</p>` : '<p class="board-empty">Sin casos y controles suficientes.</p>')}
    </div>
    ${DISCLAIMER}`;
}

/** Adjustable parameters of the recomputation panel by model family, with their units. */
export const RECOMPUTE_GROUPS = Object.freeze([
  { title: 'Memoria', params: [['beta', 'β', 's⁻¹']] },
  { title: 'Lineal', params: [['alphaL', 'α_L', 's⁻¹']] },
  { title: 'Potencial', params: [['a', 'a', ''], ['p', 'p', '']], note: `H_ref = ${FIXED_H_REF} s, fijo` },
  { title: 'Exponencial', params: [['alphaE', 'α_E', 's⁻¹']] },
  { title: 'Saturante', params: [['A', 'A', ''], ['kH', 'K_H', 's']] },
]);
const paramKey = (name) => `recompute:${name}`;

/** Every adjustable parameter of the recomputation panel, inside its search range. */
export function recomputeState(state) {
  const values = {};
  for (const [name, r] of Object.entries(PARAM_RANGES)) {
    const v = Number(state[paramKey(name)]);
    values[name] = state[paramKey(name)] !== undefined && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.initial;
  }
  return values;
}

/** A parameter value as shown next to its slider: decimal comma, as many decimals as its step. */
export function paramText(name, v) {
  const step = String(PARAM_RANGES[name].step);
  const decimals = step.includes('.') ? step.split('.')[1].length : 0;
  return v.toFixed(decimals).replace('.', ',');
}

const slider = (name, label, unit, value) => {
  const r = PARAM_RANGES[name];
  return `<label class="recompute-param">${label} <input type="range" data-param="${paramKey(name)}" min="${r.min}" max="${r.max}" step="${r.step}" value="${value}" aria-label="${label}"> <output data-param-out="${name}">${paramText(name, value)}</output>${unit ? ` ${unit}` : ''}</label>`;
};

/** Panel of Analítica: models recomputed from the per-second series with adjustable parameters. */
function recomputePanel(workdays, state) {
  const values = recomputeState(state);
  const withSeries = workdays.filter((w) => w.perSecond?.phonation?.length);
  const groups = RECOMPUTE_GROUPS.map((g) => `<fieldset class="recompute-group"><legend>${g.title}</legend>${g.params.map(([name, label, unit]) => slider(name, label, unit, values[name])).join('')}${g.note ? `<span class="hint">${g.note}</span>` : ''}</fieldset>`).join('');
  const controls = withSeries.length
    ? `<div class="recompute-controls">${groups}</div>
      <div class="board-filters"><label>Modelo de la curva <select data-param="recomputeModel">${RECOMPUTED_MODELS.map((m) => `<option value="${m}"${m === curveModel(state) ? ' selected' : ''}>${DOSE_LABELS[m]}</option>`).join('')}</select></label>
      <label>Jornada <select data-param="recomputeWorkday">${withSeries.map((w) => `<option value="${esc(w.id)}"${w.id === state.recomputeWorkday ? ' selected' : ''}>${esc(w.participantId)} · ${dayLabel(w.date)} · ${clock(w.startedAt)}</option>`).join('')}</select></label>
      <button type="button" class="btn" data-action="recompute-reset">Volver a los valores iniciales</button></div>`
    : '';
  return panel('Recálculo desde la serie por segundo', `${controls}<div data-recompute-body>${recomputeBody(workdays, state)}</div>`, 'span-2');
}

/** Model drawn in the exploratory dose-response curve (linear by default). */
const curveModel = (state) => (RECOMPUTED_MODELS.includes(state.recomputeModel) ? state.recomputeModel : 'linear');

/** Body of the recomputation panel, re-rendered alone while a parameter moves. */
export function recomputeBody(workdays, state) {
  const values = recomputeState(state);
  const { entries, withoutSeries } = recomputeWorkdays(workdays, values);
  const old = withoutSeries.length
    ? `<p class="hint">${withoutSeries.length} de ${workdays.length} jornadas no tienen serie por segundo (grabadas antes de que existiera, importadas sin ella o de demostración): no admiten recálculo y quedan fuera de esta comparación.</p>`
    : '';
  if (!entries.length) {
    return `<p class="board-empty">Ninguna jornada tiene serie por segundo, así que no se puede recalcular. Las jornadas que se graben con esta versión la guardan y van a aparecer acá.</p>${old}`;
  }
  const outcomeKey = OUTCOMES[state.outcome] ? state.outcome : 'deltaF';
  const outcome = OUTCOMES[outcomeKey];
  const threshold = state[outcome.thresholdKey] ?? outcome.defaultThreshold;
  const c = compareModels(entries, outcomeKey, threshold);
  const name = (m) => `<span class="dot-swatch" style="background:${MODEL_COLORS[m]}"></span>${DOSE_LABELS[m].split(' ·')[0]}`;
  const signed = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v), 2)}` : '—');
  const table = `<table class="stats"><thead><tr><th>Modelo</th><th>ρ con ${esc(outcome.short)}</th><th>AUC (IC 95 %)</th><th>AUC − AUC de D0</th></tr></thead><tbody>${RECOMPUTED_MODELS.map((m) => {
    const r = c.models[m];
    return `<tr><th scope="row">${name(m)}</th><td class="num">${fmt(r.rho, 2)}</td><td>${fmt(r.auc, 2)} <span class="ci">(${fmt(r.ci[0], 2)}–${fmt(r.ci[1], 2)})</span></td><td class="num">${m === 'none' ? 'referencia' : signed(r.deltaAuc)}</td></tr>`;
  }).join('')}</tbody></table>`;
  const selected = entries.find((e) => e.workday.id === state.recomputeWorkday) ?? entries[0];
  const w = selected.workday;
  const d0 = selected.doses.none;
  const day = `<table class="stats"><thead><tr><th>Modelo</th><th>Dosis recalculada</th><th>× D0</th></tr></thead><tbody>${RECOMPUTED_MODELS.map((m) => `<tr><th scope="row">${name(m)}</th><td class="num">${compact(selected.doses[m])} u</td><td class="num">${d0 > 0 ? fmt(selected.doses[m] / d0, 2) : '—'}</td></tr>`).join('')}</tbody></table>
    <p class="hint">${esc(w.participantId)} · ${dayLabel(w.date)}: ΔF = ${fmt(outcomeValue(w, 'deltaF'), 0)} pts · AUC_F = ${fmt(outcomeValue(w, 'aucF'), 1)} EVA·h · T₉₀ = ${fmt(outcomeValue(w, 't90'), 0)} min.</p>`;
  const model = curveModel(state);
  const pairs = entries.map((e) => [e.doses[model], outcomeValue(e.workday, outcomeKey)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const fit = linearRegression(pairs.map(([a]) => a), pairs.map(([, b]) => b));
  const curves = `<div class="board-grid recompute-grid">
    <div><h3>Curva dosis-respuesta exploratoria (${esc(DOSE_LABELS[model])})</h3>${scatterChart({ points: pairs, fit, color: MODEL_COLORS[model], xLabel: `${DOSE_LABELS[model]} recalculada (u)`, yLabel: outcome.short, label: `Dosis recalculada contra ${outcome.short}` })}<p class="hint">Regresión lineal (OLS) con banda de confianza al 95 % · n = ${fit.n} · R² = ${fmt(fit.r2, 2)} · Spearman ρ = ${fmt(c.models[model].rho, 2)}.</p></div>
    <div><h3>Curvas ROC exploratorias (caso: ${esc(outcome.caseText(threshold))})</h3>${rocChart({ curves: RECOMPUTED_MODELS.map((m) => ({ name: DOSE_LABELS[m], points: c.models[m].points, color: MODEL_COLORS[m] })), label: 'Curvas ROC de las dosis recalculadas' })}</div>
  </div>
  <p class="hint">Exploratorias: solo jornadas con serie y dosis recalculadas con los valores de arriba. Mover los parámetros no cambia las curvas, el corte de Youden ni los niveles de acción de arriba, que usan las dosis guardadas. Ajustar mirando estas curvas da AUC optimistas: los valores elegidos se congelan y se validan en jornadas nuevas.</p>`;
  return `${curves}<div class="board-grid recompute-grid"><div><h3>${entries.length} jornadas con serie · ${esc(outcome.caseText(threshold))}</h3>${table}<p class="hint">${c.cases} casos · ${c.controls} controles. AUC aparentes, sobre la misma muestra. Un modelo con memoria solo aporta si supera a D0 de forma reproducible.</p></div><div><h3>Jornada elegida</h3>${day}</div></div>
    <p class="hint">β = ${fmt(values.beta, 3)} s⁻¹ (τ = ${fmt(1 / values.beta, 0)} s) · α_L = ${fmt(values.alphaL, 3)} s⁻¹ · a = ${fmt(values.a, 2)}, p = ${fmt(values.p, 2)}, H_ref = ${FIXED_H_REF} s (fijo) · α_E = ${fmt(values.alphaE, 3)} s⁻¹ · A = ${fmt(values.A, 2)}, K_H = ${fmt(values.kH, 0)} s. Cada parámetro de forma mueve solo su modelo, y β solo la memoria. Las dosis guardadas en cada jornada no cambian; a 1 Hz las dosis con memoria difieren del cálculo por trama en torno al 1 % con β = 0,03.</p>${old}`;
}

/** CSV of the workday summaries (one row per workday, no audio, codes only). */
export function summariesCsv(workdays) {
  const cols = ['id', 'participantId', 'schoolId', 'classroom', 'date', 'durationS', 'phonationS', 'validRatio',
    'd_0', 'd_l', 'd_p', 'd_e', 'd_s', 'd_d', 'd_t', 'd_c', 'hMax', 'f0_p50', 'level_p50', 'units', 'fatigue_pre', 'fatigue_post', 'source', 'algorithmVersion', 'own_voice_ref_dbfs',
    'recovery_points', 'recovery_t50_min', 'recovery_t90_min', 'recovery_auc_f', 'recovery_horizon_min',
    'effort_borg_pre', 'effort_borg_post', 'dryness_pre', 'dryness_post', 'discomfort_pre', 'discomfort_post'];
  const cell = (v) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  const rows = workdays.map((w) => [w, recoveryIndices({ pre: w.fatigue.pre, post: w.fatigue.post, points: w.fatigue.recovery ?? [] })]).map(([w, r]) => [w.id, w.participantId, w.schoolId, w.classroom, w.date, w.durationS, w.phonationS, w.validRatio,
    w.doses.none, w.doses.linear, w.doses.power, w.doses.exponential, w.doses.saturating, w.doses.distance, w.doses.time, w.doses.cycle,
    w.hMax, w.f0?.p50, w.level?.p50, w.units, w.fatigue.pre, w.fatigue.post, w.source, w.algorithmVersion, w.ownVoiceRefDbfs,
    (w.fatigue.recovery ?? []).length, r.t50Min, r.t90Min, r.aucF, r.horizonMin,
    w.assessment?.effortBorg?.pre, w.assessment?.effortBorg?.post, w.assessment?.vas?.dryness?.pre, w.assessment?.vas?.dryness?.post,
    w.assessment?.vas?.discomfort?.pre, w.assessment?.vas?.discomfort?.post].map(cell).join(','));
  return [cols.join(','), ...rows].join('\r\n') + '\r\n';
}
