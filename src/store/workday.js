// Workday record (vd-des-workday/1): the summary of one measured session that the
// dashboards aggregate. It never holds audio or per-frame data, only codes, doses,
// percentiles, a per-minute dose timeline, optionally a per-second series of phonated time and
// F0·I (src/store/second-series.js), context events, the fatigue VAS (PRE, POST and the
// recovery points recorded afterwards, src/store/recovery.js) and, when done,
// the PRE/POST voice assessment (VAS and acoustic measures; spec §23).
import { describe } from '../stats/descriptive.js';
import { SCORE_DOSES } from '../ui/score-series.js';
import { TASKS, TIMEPOINTS, retainsAudio } from './voice-assessment.js';
import { RECOVERY_POINT_FIELDS, RECOVERY_SLOTS } from './recovery.js';
import { validateSecondSeries } from './second-series.js';

export const WORKDAY_SCHEMA = 'vd-des-workday/1';

export const EVENT_TYPES = Object.freeze(['llamado_atencion', 'explicacion', 'actividad_grupal', 'recreo', 'otro']);
export const EVENT_SOURCES = Object.freeze(['docente', 'algoritmo']);
export const WORKDAY_SOURCES = Object.freeze(['live', 'import', 'demo']);
/**
 * Optional `checkpoint` of an autosaved record (src/store/workday-autosave.js):
 * 'in_progress' while its session runs, 'recovered' when found after an unexpected close.
 * Records without it (manual saves and every earlier record) are final.
 */
export const CHECKPOINT_STATUSES = Object.freeze(['in_progress', 'recovered']);

/** Pseudonymous codes only: letters, digits, dot, dash and underscore, no spaces. */
const CODE = /^[A-Za-z0-9._-]{1,32}$/;
/** Optional sync identity (spec §14): a random session UUID and a random per-install device id. */
export const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Optional `ownVoiceRef` (spec §10.1): how A_0 was taken and how steady it was. */
export const OWN_VOICE_REF_FIELDS = Object.freeze(['method', 'textId', 'p10Dbfs', 'p50Dbfs', 'p90Dbfs', 'durationS', 'validS']);
/** Optional `capture`: browser processing of the microphone track, true / false or null when unknown. */
export const CAPTURE_FIELDS = Object.freeze(['autoGainControl', 'noiseSuppression', 'echoCancellation']);

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
 *   fatiguePost: number | null, events?: { t: number, type: string, source: string, note?: string }[],
 *   assessment?: ReturnType<import('./voice-assessment.js').workdayAssessment> | null }} args.meta
 * @param {object} args.load final vocal-load state
 * @param {ReturnType<import('../ui/score-series.js').createScoreSeries>} args.series
 * @param {Date} args.startedAt
 * @param {string} [args.sessionUuid] random UUID of the session, idempotency key of the sync (spec §14)
 * @param {string} [args.deviceId] random id of this installation (spec §14); never a hardware id
 * @param {ReturnType<import('./second-series.js').createSecondSeries>} [args.seconds] per-second series of the session
 */
export function buildWorkday({ meta, load, series, startedAt, algorithmVersion, source, sessionUuid, deviceId, seconds }) {
  const m = load.metrics;
  const perSecond = seconds?.toJSON() ?? null;
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
    ownVoiceRefDbfs: load.ownVoiceReferenceDbfs ?? null, // level of I = 1 when units are 'normalized' (spec §10.1)
    timeline: minuteTimeline(series),
    events: (meta.events ?? []).map((e) => ({ ...e })),
    fatigue: { pre: meta.fatiguePre ?? null, post: meta.fatiguePost ?? null },
    assessment: meta.assessment ?? null,
    algorithmVersion,
    source,
    // Optional, only when given, so records without them keep their exact shape.
    ...(sessionUuid === undefined ? {} : { sessionUuid }),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(load.ownVoiceReference ? { ownVoiceRef: { ...load.ownVoiceReference } } : {}),
    ...(load.capture ? { capture: { ...load.capture } } : {}),
    ...(perSecond ? { perSecond } : {}),
  };
  return validateWorkday(workday);
}

function validateAssessment(a) {
  for (const [item, { pre, post }] of Object.entries(a.vas ?? {})) {
    validateVas(`assessment.vas.${item}.pre`, pre ?? null);
    validateVas(`assessment.vas.${item}.post`, post ?? null);
  }
  for (const r of a.results ?? []) {
    if (!TIMEPOINTS.includes(r.timepoint) || !TASKS.includes(r.task)) throw new RangeError(`assessment result needs a PRE/POST timepoint and a VOWEL/SPEECH task`);
    if (retainsAudio(r)) throw new RangeError('assessment results must not retain audio');
  }
}

function validateOwnVoiceRef(r) {
  if (typeof r !== 'object' || r === null) throw new RangeError('ownVoiceRef must be an object');
  for (const [key, value] of Object.entries(r)) {
    if (!OWN_VOICE_REF_FIELDS.includes(key)) throw new RangeError(`unknown field ownVoiceRef.${key}`);
    const text = key === 'method' || key === 'textId';
    const ok = value === null || (text ? typeof value === 'string' && value.length <= 64 : Number.isFinite(value));
    if (!ok) throw new RangeError(`ownVoiceRef.${key} must be ${text ? 'a short string' : 'a finite number'} or null, got ${value}`);
  }
}

function validateCapture(c) {
  if (typeof c !== 'object' || c === null) throw new RangeError('capture must be an object');
  for (const [key, value] of Object.entries(c)) {
    if (!CAPTURE_FIELDS.includes(key)) throw new RangeError(`unknown field capture.${key}`);
    if (value !== null && typeof value !== 'boolean') throw new RangeError(`capture.${key} must be true, false or null, got ${value}`);
  }
}

/** Optional `fatigue.recovery` (hito 10): fatigue VAS points recorded after the workday. */
function validateRecovery(points) {
  if (!Array.isArray(points)) throw new RangeError('fatigue.recovery must be an array');
  const seen = new Set();
  for (const p of points) {
    if (typeof p !== 'object' || p === null) throw new RangeError('fatigue.recovery items must be objects');
    const unknown = Object.keys(p).find((k) => !RECOVERY_POINT_FIELDS.includes(k));
    if (unknown) throw new RangeError(`unknown field fatigue.recovery.${unknown}`);
    if (!RECOVERY_SLOTS.some((s) => s.id === p.slot)) throw new RangeError(`unknown fatigue.recovery slot ${p.slot}`);
    if (seen.has(p.slot)) throw new RangeError(`fatigue.recovery slot ${p.slot} is repeated`);
    seen.add(p.slot);
    if (typeof p.at !== 'string' || Number.isNaN(Date.parse(p.at))) throw new RangeError('fatigue.recovery.at must be an ISO date');
    if (typeof p.minutes !== 'number' || !Number.isFinite(p.minutes) || p.minutes < 0) throw new RangeError('fatigue.recovery.minutes must be a number >= 0');
    validateVas('fatigue.recovery.value', p.value ?? NaN);
  }
}

function validateCheckpoint(c) {
  if (!CHECKPOINT_STATUSES.includes(c.status)) throw new RangeError(`checkpoint.status must be one of ${CHECKPOINT_STATUSES.join(', ')}`);
  if (typeof c.savedAt !== 'string' || Number.isNaN(Date.parse(c.savedAt))) throw new RangeError('checkpoint.savedAt must be an ISO date');
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
  if (w.fatigue?.recovery !== undefined) validateRecovery(w.fatigue.recovery);
  if (w.assessment) validateAssessment(w.assessment);
  if (!WORKDAY_SOURCES.includes(w.source)) throw new RangeError(`source must be one of ${WORKDAY_SOURCES.join(', ')}`);
  if (w.checkpoint !== undefined && w.checkpoint !== null) validateCheckpoint(w.checkpoint);
  if (w.ownVoiceRef !== undefined) validateOwnVoiceRef(w.ownVoiceRef);
  if (w.capture !== undefined) validateCapture(w.capture);
  if (w.perSecond !== undefined) validateSecondSeries(w.perSecond);
  if (w.sessionUuid !== undefined && !(typeof w.sessionUuid === 'string' && SESSION_UUID_PATTERN.test(w.sessionUuid))) {
    throw new RangeError(`sessionUuid must be a UUID, got "${w.sessionUuid}"`);
  }
  if (w.deviceId !== undefined && !(typeof w.deviceId === 'string' && DEVICE_ID_PATTERN.test(w.deviceId))) {
    throw new RangeError(`deviceId must be 8-64 letters, digits, "-" or "_", got "${w.deviceId}"`);
  }
  for (const e of w.events ?? []) {
    if (!EVENT_TYPES.includes(e.type) && e.type !== 'fonacion_sostenida' && e.type !== 'nivel_elevado') {
      throw new RangeError(`unknown event type ${e.type}`);
    }
    if (!EVENT_SOURCES.includes(e.source)) throw new RangeError(`unknown event source ${e.source}`);
  }
  return w;
}
