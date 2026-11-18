// Workday record (vd-des-workday/1): the summary of one measured session that the
// dashboards aggregate. It never holds audio or per-frame data, only codes, doses,
// percentiles, a per-minute dose timeline, context events and the fatigue VAS.
import { describe } from '../stats/descriptive.js';
import { SCORE_DOSES } from '../ui/score-series.js';

export const WORKDAY_SCHEMA = 'vd-des-workday/1';

export const EVENT_TYPES = Object.freeze(['llamado_atencion', 'explicacion', 'actividad_grupal', 'recreo', 'otro']);
export const EVENT_SOURCES = Object.freeze(['docente', 'algoritmo']);
export const WORKDAY_SOURCES = Object.freeze(['live', 'import', 'demo']);

/** Pseudonymous codes only: letters, digits, dot, dash and underscore, no spaces. */
const CODE = /^[A-Za-z0-9._-]{1,32}$/;

export function validateCode(name, value) {
  if (typeof value !== 'string' || !CODE.test(value)) {
    throw new RangeError(`${name} must be a code of 1-32 letters, digits, ".", "-" or "_" (no names or spaces), got "${value}"`);
  }
  return value;
}

function validateVas(name, value) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${name} must be null or a number in 0-100, got ${value}`);
  }
  return value;
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function workdayId(startedAt, participantId) {
  const d = startedAt;
  return `S-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${participantId}`;
}

const summary = (values) => {
  const s = describe(values);
  return { p10: s.p10, p50: s.p50, p90: s.p90 };
};

/** Cumulative value of every dose at the end of each elapsed minute. */
function minuteTimeline(series) {
  const from = series.startTime ?? 0;
  const end = series.endTime ?? 0;
  const minutes = Math.max(1, Math.ceil((end - from) / 60 - 1e-9));
  const doses = {};
  for (const dose of SCORE_DOSES) {
    const b = series.bucketize({ from, to: from + minutes * 60, buckets: minutes, dose });
    let last = 0;
    doses[dose] = Array.from(b.dose, (v) => (Number.isNaN(v) ? last : (last = v)));
  }
  return { minutes: Array.from({ length: minutes }, (_, i) => i + 1), doses };
}

/**
 * @param {object} args
 * @param {{ participantId: string, schoolId: string, classroom: string, fatiguePre: number | null,
 *   fatiguePost: number | null, events?: { t: number, type: string, source: string, note?: string }[] }} args.meta
 * @param {object} args.load final vocal-load state
 * @param {ReturnType<import('../ui/score-series.js').createScoreSeries>} args.series
 * @param {Date} args.startedAt
 */
export function buildWorkday({ meta, load, series, startedAt, algorithmVersion, source }) {
  const m = load.metrics;
  const workday = {
    schema: WORKDAY_SCHEMA,
    id: workdayId(startedAt, meta.participantId),
    participantId: meta.participantId,
    schoolId: meta.schoolId,
    classroom: meta.classroom,
    date: localDate(startedAt),
    startedAt: startedAt.toISOString(),
    durationS: m.totalTime,
    phonationS: m.phonationTime,
    validRatio: m.totalTime > 0 ? 1 - (m.timeByCategory.uncertain ?? 0) / m.totalTime : 0,
    doses: { ...load.doses, distance: load.distanceDose, time: load.conventionalDoses.time, cycle: load.conventionalDoses.cycle },
    hMax: load.h,
    f0: summary(series.voicedValues('f0')),
    level: summary(series.voicedValues('level')),
    units: load.units,
    timeline: minuteTimeline(series),
    events: (meta.events ?? []).map((e) => ({ ...e })),
    fatigue: { pre: meta.fatiguePre ?? null, post: meta.fatiguePost ?? null },
    algorithmVersion,
    source,
  };
  return validateWorkday(workday);
}

/** Throws RangeError on a malformed record; returns it unchanged otherwise. */
export function validateWorkday(w) {
  if (!w || w.schema !== WORKDAY_SCHEMA) throw new RangeError(`schema must be ${WORKDAY_SCHEMA}`);
  if (typeof w.id !== 'string' || !w.id) throw new RangeError('id is required');
  validateCode('participantId', w.participantId);
  validateCode('schoolId', w.schoolId);
  validateCode('classroom', w.classroom);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) throw new RangeError(`date must be YYYY-MM-DD, got ${w.date}`);
  if (!(w.durationS >= 0) || !(w.phonationS >= 0)) throw new RangeError('durations must be >= 0');
  validateVas('fatigue.pre', w.fatigue?.pre ?? null);
  validateVas('fatigue.post', w.fatigue?.post ?? null);
  if (!WORKDAY_SOURCES.includes(w.source)) throw new RangeError(`source must be one of ${WORKDAY_SOURCES.join(', ')}`);
  for (const e of w.events ?? []) {
    if (!EVENT_TYPES.includes(e.type) && e.type !== 'fonacion_sostenida' && e.type !== 'nivel_elevado') {
      throw new RangeError(`unknown event type ${e.type}`);
    }
    if (!EVENT_SOURCES.includes(e.source)) throw new RangeError(`unknown event source ${e.source}`);
  }
  return w;
}
