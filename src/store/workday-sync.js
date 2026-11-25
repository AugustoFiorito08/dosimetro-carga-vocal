// Sync contract (spec §14): what a workday summary may carry when it is sent to an
// analytical database. Provider-agnostic: no transport here, only the record, the
// envelope and their validation, usable on both ends (the browser builds, the backend
// checks). The envelope is the JSON export one (vd-des-workdays/1), so a manual export and
// a sync carry the same format and either can be loaded the same way.
import { MAX_DERIVED_VALUES } from './voice-assessment.js';
import {
  CHECKPOINT_STATUSES,
  DEVICE_ID_PATTERN,
  EVENT_SOURCES,
  EVENT_TYPES,
  SESSION_UUID_PATTERN,
  WORKDAY_SCHEMA,
  WORKDAY_SOURCES,
  validateWorkday,
} from './workday.js';
import { EXPORT_FORMAT } from './workday-io.js';

export const SYNC_FORMAT = EXPORT_FORMAT;

/**
 * Allow-list of the fields a synced workday may carry. Anything else (a speaker template,
 * samples, local-only state) is dropped when building and rejected when receiving.
 */
export const SYNC_FIELDS = Object.freeze([
  'schema', 'id', 'sessionUuid', 'deviceId',
  'participantId', 'schoolId', 'classroom',
  'date', 'startedAt', 'durationS', 'phonationS', 'validRatio',
  'doses', 'hMax', 'f0', 'level', 'units', 'ownVoiceRefDbfs', 'ownVoiceRef', 'capture',
  'timeline', 'events', 'fatigue', 'assessment',
  'algorithmVersion', 'source', 'checkpoint',
]);

/** A per-minute timeline covers at most one day. */
export const MAX_TIMELINE_MINUTES = 24 * 60;

const AUTO_EVENT_TYPES = ['fonacion_sostenida', 'nivel_elevado'];

/** Longest array holding numbers anywhere inside `value` (iterative, safe on huge arrays). */
function longestNumericArray(value) {
  let longest = 0;
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      let numeric = ArrayBuffer.isView(v);
      for (const item of v) {
        if (typeof item === 'number') numeric = true;
        else if (item && typeof item === 'object') stack.push(item);
      }
      if (numeric) longest = Math.max(longest, v.length);
    } else if (v && typeof v === 'object') {
      for (const item of Object.values(v)) if (item && typeof item === 'object') stack.push(item);
    }
  }
  return longest;
}

function validateTimeline(timeline) {
  if (timeline === undefined || timeline === null) return;
  const { minutes, doses = {} } = timeline;
  if (!Array.isArray(minutes) || minutes.length > MAX_TIMELINE_MINUTES) {
    throw new RangeError(`timeline.minutes must be an array of at most ${MAX_TIMELINE_MINUTES} minutes`);
  }
  for (const [dose, values] of Object.entries(doses)) {
    if (!Array.isArray(values) || values.length !== minutes.length) {
      throw new RangeError(`timeline.doses.${dose} must have one value per minute`);
    }
  }
}

/** Final records (no checkpoint) and recovered checkpoints can be sent; a session in progress cannot. */
export function isSyncable(workday) {
  return workday?.checkpoint?.status !== 'in_progress';
}

/** Idempotency key of a sent workday: the random session UUID when present, the workday id otherwise. */
export const syncKey = (workday) => workday.sessionUuid ?? workday.id;

/**
 * Receiving side: a valid workday (validateWorkday), syncable, with no field outside the
 * contract and nothing long enough to be audio outside the per-minute timeline.
 * @returns the record unchanged
 */
export function validateSyncRecord(record) {
  validateWorkday(record);
  const unknown = Object.keys(record).find((key) => !SYNC_FIELDS.includes(key));
  if (unknown !== undefined) throw new RangeError(`unknown field "${unknown}" in a synced workday`);
  if (!isSyncable(record)) throw new RangeError(`workday ${record.id} is still in progress; only saved or recovered workdays are sent`);
  validateTimeline(record.timeline);
  const { timeline: _timeline, ...rest } = record;
  if (longestNumericArray(rest) > MAX_DERIVED_VALUES) {
    throw new RangeError(`workday ${record.id} holds an array longer than ${MAX_DERIVED_VALUES} values: audio-like content is never sent`);
  }
  return record;
}

/** Sending side: a validated copy of the workday restricted to the contract fields. */
export function toSyncRecord(workday) {
  const record = {};
  for (const key of SYNC_FIELDS) if (workday[key] !== undefined) record[key] = structuredClone(workday[key]);
  return validateSyncRecord(record);
}

/** Envelope of one send: { format, exportedAt, workdays }. Throws on any invalid or duplicated record. */
export function buildSyncPayload(workdays, { now = new Date() } = {}) {
  return validateSyncPayload({ format: SYNC_FORMAT, exportedAt: now.toISOString(), workdays: workdays.map(toSyncRecord) });
}

/** Receiving side of the envelope. @returns the payload unchanged */
export function validateSyncPayload(payload) {
  if (payload?.format !== SYNC_FORMAT) throw new RangeError(`format must be ${SYNC_FORMAT}`);
  if (!Array.isArray(payload.workdays)) throw new RangeError('workdays must be an array');
  if (typeof payload.exportedAt !== 'string' || Number.isNaN(Date.parse(payload.exportedAt))) {
    throw new RangeError('exportedAt must be an ISO date');
  }
  const keys = new Set();
  for (const record of payload.workdays) {
    validateSyncRecord(record);
    const key = syncKey(record);
    if (keys.has(key)) throw new RangeError(`duplicated workday ${key} in one payload`);
    keys.add(key);
  }
  return payload;
}

const numberOrNull = { type: ['number', 'null'] };
const percentiles = { type: 'object', properties: { p10: numberOrNull, p50: numberOrNull, p90: numberOrNull } };
const code = { type: 'string', pattern: '^[A-Za-z0-9._-]{1,32}$' };
const vas = { type: ['number', 'null'], minimum: 0, maximum: 100 };
const isoDateTime = { type: 'string', format: 'date-time' };

/**
 * JSON Schema (2020-12) of one synced workday, for the backend. validateSyncRecord() is the
 * reference: the schema mirrors it, except the audio guard (no array of numbers longer
 * than MAX_DERIVED_VALUES outside the timeline), which JSON Schema cannot express in general.
 */
export const WORKDAY_SYNC_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'vd-des-workday-sync/1',
  title: 'Synced workday summary (vd-des-workday/1)',
  $comment: `No audio, frames or speaker template. Arrays of numbers outside "timeline" hold at most ${MAX_DERIVED_VALUES} values.`,
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'id', 'participantId', 'schoolId', 'classroom', 'date', 'durationS', 'phonationS', 'source'],
  properties: {
    schema: { const: WORKDAY_SCHEMA },
    id: { type: 'string', minLength: 1 },
    sessionUuid: { type: 'string', pattern: SESSION_UUID_PATTERN.source },
    deviceId: { type: 'string', pattern: DEVICE_ID_PATTERN.source },
    participantId: code,
    schoolId: code,
    classroom: code,
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    startedAt: isoDateTime,
    durationS: { type: 'number', minimum: 0 },
    phonationS: { type: 'number', minimum: 0 },
    validRatio: numberOrNull,
    doses: { type: 'object', additionalProperties: numberOrNull },
    hMax: numberOrNull,
    f0: percentiles,
    level: percentiles,
    units: { enum: ['calibrated', 'normalized', 'relative'] },
    ownVoiceRefDbfs: numberOrNull,
    ownVoiceRef: {
      type: 'object',
      additionalProperties: false,
      properties: {
        method: { type: ['string', 'null'], maxLength: 64 },
        textId: { type: ['string', 'null'], maxLength: 64 },
        p10Dbfs: numberOrNull,
        p50Dbfs: numberOrNull,
        p90Dbfs: numberOrNull,
        durationS: numberOrNull,
        validS: numberOrNull,
      },
    },
    capture: {
      type: 'object',
      additionalProperties: false,
      properties: {
        autoGainControl: { type: ['boolean', 'null'] },
        noiseSuppression: { type: ['boolean', 'null'] },
        echoCancellation: { type: ['boolean', 'null'] },
      },
    },
    timeline: {
      type: 'object',
      properties: {
        minutes: { type: 'array', items: { type: 'integer' }, maxItems: MAX_TIMELINE_MINUTES },
        doses: { type: 'object', additionalProperties: { type: 'array', items: numberOrNull, maxItems: MAX_TIMELINE_MINUTES } },
      },
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['t', 'type', 'source'],
        properties: {
          t: { type: 'number' },
          type: { enum: [...EVENT_TYPES, ...AUTO_EVENT_TYPES] },
          source: { enum: [...EVENT_SOURCES] },
          note: { type: 'string' },
          durationS: { type: 'number', minimum: 0 },
        },
      },
    },
    fatigue: { type: 'object', properties: { pre: vas, post: vas } },
    assessment: {
      type: ['object', 'null'],
      properties: {
        textId: { type: 'string' },
        vas: { type: 'object', additionalProperties: { type: 'object', properties: { pre: vas, post: vas } } },
        results: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            required: ['timepoint', 'task', 'audioRetained'],
            properties: { timepoint: { enum: ['PRE', 'POST'] }, task: { enum: ['VOWEL', 'SPEECH'] }, audioRetained: { const: false } },
          },
        },
      },
    },
    algorithmVersion: { type: 'string' },
    source: { enum: [...WORKDAY_SOURCES] },
    checkpoint: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'savedAt'],
      properties: { status: { enum: CHECKPOINT_STATUSES.filter((s) => s !== 'in_progress') }, savedAt: isoDateTime },
    },
  },
});
