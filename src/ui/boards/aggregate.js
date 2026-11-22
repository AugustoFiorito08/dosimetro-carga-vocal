// Aggregations behind the dashboards (pure). Teachers appear only by code, and any group
// with fewer than MIN_GROUP teachers is suppressed so that nobody is singled out.
import { quantile } from '../../stats/descriptive.js';
import { rocCurve, youden } from '../../stats/inference.js';

export const MIN_GROUP = 3;

/** Dose units of a workday (spec §10.1); records saved before units existed are relative. */
export const UNIT_LABELS = Object.freeze({
  normalized: 'Normalizadas a la voz propia',
  calibrated: 'Calibradas (Pa)',
  relative: 'Relativas (sin calibrar)',
});
const unitsOf = (w) => w.units ?? 'relative';

/**
 * The workdays of one units value, so no board mixes dose scales. `selected` null (or
 * absent from the data) picks the units of the most recent workday.
 */
export function selectByUnits(workdays, selected) {
  if (!workdays.length) return { units: null, workdays: [], excluded: 0, available: [] };
  const counts = new Map();
  for (const w of workdays) counts.set(unitsOf(w), (counts.get(unitsOf(w)) ?? 0) + 1);
  const latest = workdays.reduce((a, b) => (String(b.startedAt) > String(a.startedAt) ? b : a));
  const units = counts.has(selected) ? selected : unitsOf(latest);
  const chosen = workdays.filter((w) => unitsOf(w) === units);
  return {
    units,
    workdays: chosen,
    excluded: workdays.length - chosen.length,
    available: [...counts].map(([u, count]) => ({ units: u, count })).sort((a, b) => b.count - a.count),
  };
}

const pad = (n) => String(n).padStart(2, '0');
const parse = (iso) => new Date(`${iso}T12:00:00`);
const format = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const finite = (xs) => xs.filter((v) => Number.isFinite(v));
const teachersIn = (ws) => new Set(ws.map((w) => w.participantId)).size;

/** Monday (YYYY-MM-DD) of the week that contains `iso`. */
export function weekStart(iso) {
  const d = parse(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return format(d);
}

/** Monday to Friday of the week starting on `monday`. */
export function weekDays(monday) {
  const d = parse(monday);
  return Array.from({ length: 5 }, (_, i) => {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    return format(x);
  });
}

export function workdaysOfWeek(workdays, { schoolId, weekStart: monday }) {
  const days = new Set(weekDays(monday));
  return workdays.filter((w) => w.schoolId === schoolId && days.has(w.date));
}

const byClassroom = (ws) => {
  const groups = new Map();
  for (const w of ws) groups.set(w.classroom, [...(groups.get(w.classroom) ?? []), w]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
};

/** Mean dose per classroom (rows) and weekday (columns); classrooms under MIN_GROUP are suppressed. */
export function classroomDayHeatmap(workdays, dose, monday) {
  const days = weekDays(monday);
  const classrooms = [];
  const cells = [];
  const suppressed = [];
  for (const [classroom, ws] of byClassroom(workdays)) {
    if (teachersIn(ws) < MIN_GROUP) {
      suppressed.push(classroom);
      continue;
    }
    classrooms.push(classroom);
    cells.push(days.map((d) => mean(finite(ws.filter((w) => w.date === d).map((w) => w.doses[dose])))));
  }
  return { days, classrooms, cells, suppressed };
}

/** Per classroom: teachers, mean dose and mean post-VAS (null when suppressed). */
export function classroomSummary(workdays, dose) {
  return byClassroom(workdays).map(([classroom, ws]) => {
    const teachers = teachersIn(ws);
    const suppressed = teachers < MIN_GROUP;
    return {
      classroom,
      teachers,
      suppressed,
      meanDose: suppressed ? null : mean(finite(ws.map((w) => w.doses[dose]))),
      meanPost: suppressed ? null : mean(finite(ws.map((w) => w.fatigue?.post))),
    };
  });
}

/** Teachers (by code) whose mean pre-VAS is >= threshold, highest first, with their last 5 values. */
export function teachersWithHighPre(workdays, threshold) {
  if (teachersIn(workdays) < MIN_GROUP) return [];
  const byTeacher = new Map();
  for (const w of [...workdays].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))) {
    byTeacher.set(w.participantId, [...(byTeacher.get(w.participantId) ?? []), w]);
  }
  return [...byTeacher.entries()]
    .map(([participantId, ws]) => {
      const pre = finite(ws.map((w) => w.fatigue?.pre));
      return { participantId, classroom: ws.at(-1).classroom, meanPre: mean(pre), trend: pre.slice(-5) };
    })
    .filter((r) => r.meanPre !== null && r.meanPre >= threshold)
    .sort((a, b) => b.meanPre - a.meanPre);
}

/** P10, P50 and P90 of `pick(workday)` for each date. */
export function dailyPercentiles(workdays, pick, dates) {
  const out = { dates, p10: [], p50: [], p90: [] };
  for (const d of dates) {
    const xs = finite(workdays.filter((w) => w.date === d).map(pick));
    out.p10.push(xs.length ? quantile(xs, 0.1) : null);
    out.p50.push(xs.length ? quantile(xs, 0.5) : null);
    out.p90.push(xs.length ? quantile(xs, 0.9) : null);
  }
  return out;
}

/** A workday is valid when at least 90 % of its time was classified with certainty. */
export const isValid = (w) => w.validRatio >= 0.9;

export function monthlyCounts(workdays) {
  const months = new Map();
  for (const w of workdays) {
    const m = w.date.slice(0, 7);
    const row = months.get(m) ?? { month: m, received: 0, valid: 0 };
    row.received++;
    if (isValid(w)) row.valid++;
    months.set(m, row);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function kpis(workdays) {
  const totalTime = workdays.reduce((s, w) => s + (w.durationS ?? 1), 0);
  return {
    participants: new Set(workdays.map((w) => w.participantId)).size,
    workdays: workdays.length,
    valid: workdays.filter(isValid).length,
    schools: new Set(workdays.map((w) => w.schoolId)).size,
    lastReception: workdays.reduce((m, w) => (m === null || w.startedAt > m ? w.startedAt : m), null),
    quality: workdays.length ? workdays.reduce((s, w) => s + w.validRatio * (w.durationS ?? 1), 0) / totalTime : NaN,
  };
}

/**
 * Provisional action levels on a dose: C1 = Youden cut-off, C2 = lowest cut-off with
 * specificity >= 0.90. Derived from the data in view; not validated thresholds.
 */
export function actionLevels(scores, labels) {
  const roc = rocCurve(scores, labels);
  const best = youden(roc);
  const strict = roc.points.filter((p) => Number.isFinite(p.threshold) && 1 - p.fpr >= 0.9).at(-1);
  return { c1: best?.threshold ?? null, c2: strict?.threshold ?? null, provisional: true };
}
