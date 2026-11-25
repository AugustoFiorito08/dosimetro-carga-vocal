import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createScoreSeries } from '../src/ui/score-series.js';
import { CHECKPOINT_STATUSES, EVENT_SOURCES, EVENT_TYPES, WORKDAY_SCHEMA, WORKDAY_SOURCES, buildWorkday, validateWorkday } from '../src/store/workday.js';
import { generateDemoWorkdays } from '../src/store/demo-data.js';
import { createMemoryRepository } from '../src/store/workday-repository.js';
import { EXPORT_FORMAT, importWorkdays } from '../src/store/workday-io.js';
import {
  SYNC_FIELDS,
  SYNC_FORMAT,
  WORKDAY_SYNC_JSON_SCHEMA,
  buildSyncPayload,
  isSyncable,
  syncKey,
  toSyncRecord,
  validateSyncPayload,
  validateSyncRecord,
} from '../src/store/workday-sync.js';

const startedAt = new Date(2026, 10, 12, 8, 0, 0);
const UUID = '3f6c2a1e-9b7d-4c3a-8e2f-1a2b3c4d5e6f';
const DEVICE = 'dev-7f3a9c2e41b8';

function workday(extra = {}) {
  const series = createScoreSeries();
  for (let i = 0; i < 180; i++) {
    series.push({ t: i, dt: 1, phi: i % 3 ? 1 : 0, f0: i % 3 ? 180 : null, level: i % 3 ? 75 : null, h: i / 10,
      doses: { none: i, linear: i, power: i, exponential: i, saturating: i }, distanceDose: null });
  }
  const load = {
    h: 17, units: 'normalized', ownVoiceReferenceDbfs: -31.2, params: { beta: 1 / 300 },
    doses: { none: 179, linear: 179, power: 179, exponential: 179, saturating: 179 },
    conventionalDoses: { time: 120, cycle: 21600 }, distanceDose: null,
    metrics: { totalTime: 180, phonationTime: 120, nonPhonationTime: 60, timeByCategory: { attributed: 120, uncertain: 3 } },
  };
  const meta = {
    participantId: 'P-0421', schoolId: 'E-25', classroom: '2B', fatiguePre: 10, fatiguePost: 40,
    events: [{ t: 30, type: 'otro', source: 'algoritmo', note: 'interrupcion:context_suspended', durationS: 4 }],
    assessment: {
      textId: 'viento-norte-sol-v1',
      vas: { effort: { pre: 10, post: 30 } },
      results: [{ timepoint: 'PRE', task: 'VOWEL', audioRetained: false, f0: { mean: 190 }, ltas: Array.from({ length: 24 }, (_, i) => -1 - i) }],
    },
  };
  return buildWorkday({ meta, load, series, startedAt, algorithmVersion: '0.8.0', source: 'live', ...extra });
}

describe('workday sync identity fields (optional, vd-des-workday/1)', () => {
  it('buildWorkday adds sessionUuid and deviceId only when given', () => {
    const plain = workday();
    assert.equal('sessionUuid' in plain, false);
    assert.equal('deviceId' in plain, false);
    const tagged = workday({ sessionUuid: UUID, deviceId: DEVICE });
    assert.equal(tagged.sessionUuid, UUID);
    assert.equal(tagged.deviceId, DEVICE);
    assert.equal(tagged.schema, WORKDAY_SCHEMA, 'still the same schema version');
  });

  it('validates their format', () => {
    const w = workday();
    assert.doesNotThrow(() => validateWorkday({ ...w, sessionUuid: UUID.toUpperCase(), deviceId: DEVICE }));
    assert.throws(() => validateWorkday({ ...w, sessionUuid: 'not-a-uuid' }), /sessionUuid/);
    assert.throws(() => validateWorkday({ ...w, deviceId: 'Ana López' }), /deviceId/);
    assert.throws(() => validateWorkday({ ...w, deviceId: 'abc' }), /deviceId/);
  });

  it('keeps every earlier record valid (demo 0.4.0, no units, no assessment, no identity)', () => {
    const legacy = generateDemoWorkdays({ schools: 1, classroomsPerSchool: 1, weeks: 1 });
    assert.ok(legacy.length > 0);
    for (const w of legacy) assert.equal(validateSyncRecord(w), w);
    const { units: _u, ownVoiceRefDbfs: _o, assessment: _a, events: _e, timeline: _t, ...minimal } = workday();
    assert.doesNotThrow(() => validateSyncRecord(minimal));
  });
});

describe('sync record (allow-list projection of a workday)', () => {
  it('keeps the summary fields and drops anything outside the contract', () => {
    const w = {
      ...workday({ sessionUuid: UUID, deviceId: DEVICE }),
      profile: { prototypes: [[0.1, 0.2]], referenceDistance: 1 }, // speaker template: never sent
      samples: [0.1, 0.2],
      localNote: 'x',
    };
    const record = toSyncRecord(w);
    assert.deepEqual(Object.keys(record).filter((k) => !SYNC_FIELDS.includes(k)), []);
    for (const key of ['profile', 'samples', 'localNote']) assert.equal(key in record, false, key);
    assert.equal(record.sessionUuid, UUID);
    assert.deepEqual(record.doses, w.doses);
    assert.deepEqual(record.assessment, w.assessment);
    assert.notEqual(record.doses, w.doses, 'a copy, not shared state');
  });

  it('rejects unknown fields on reception (the server side of the contract)', () => {
    assert.throws(() => validateSyncRecord({ ...workday(), profile: {} }), /unknown field "profile"/);
  });

  it('refuses audio-like content: long numeric arrays or an assessment that retains audio', () => {
    const w = workday();
    assert.throws(() => validateSyncRecord({ ...w, f0: { ...w.f0, raw: new Array(4800).fill(0.1) } }), /audio/);
    assert.throws(() => toSyncRecord({ ...w, assessment: { ...w.assessment, results: [{ timepoint: 'PRE', task: 'VOWEL', audioRetained: true }] } }), /audio/);
    const day = { minutes: Array.from({ length: 480 }, (_, i) => i + 1), doses: { none: new Array(480).fill(1) } };
    assert.doesNotThrow(() => validateSyncRecord({ ...w, timeline: day }), 'an 8 h per-minute timeline is not audio');
    assert.throws(() => validateSyncRecord({ ...w, timeline: { minutes: [1, 2], doses: { none: new Array(4800).fill(1) } } }), /timeline/);
  });

  it('only final or recovered workdays are syncable; in-progress checkpoints are not', () => {
    const w = workday();
    const savedAt = new Date().toISOString();
    assert.equal(isSyncable(w), true);
    assert.equal(isSyncable({ ...w, checkpoint: { status: 'recovered', savedAt } }), true);
    assert.equal(isSyncable({ ...w, checkpoint: { status: 'in_progress', savedAt } }), false);
    assert.throws(() => toSyncRecord({ ...w, checkpoint: { status: 'in_progress', savedAt } }), /in progress/);
    assert.equal(toSyncRecord({ ...w, checkpoint: { status: 'recovered', savedAt } }).checkpoint.status, 'recovered');
  });

  it('idempotency key: the session UUID when present, the workday id otherwise', () => {
    assert.equal(syncKey(workday({ sessionUuid: UUID })), UUID);
    assert.equal(syncKey(workday()), 'S-20261112-080000-P-0421');
  });
});

describe('sync payload (the vd-des-workdays/1 envelope)', () => {
  const now = new Date('2026-11-23T12:00:00.000Z');

  it('reuses the export envelope, so a manual export and a sync carry the same format', () => {
    assert.equal(SYNC_FORMAT, EXPORT_FORMAT);
    const payload = buildSyncPayload([workday({ sessionUuid: UUID })], { now });
    assert.deepEqual(Object.keys(payload), ['format', 'exportedAt', 'workdays']);
    assert.equal(payload.exportedAt, '2026-11-23T12:00:00.000Z');
    assert.equal(validateSyncPayload(JSON.parse(JSON.stringify(payload))).workdays.length, 1);
  });

  it('is importable by the existing JSON import', async () => {
    const repo = createMemoryRepository();
    const result = await importWorkdays(repo, JSON.stringify(buildSyncPayload([workday()], { now })));
    assert.equal(result.added, 1);
  });

  it('rejects a wrong envelope, duplicated keys or a non-syncable record', () => {
    assert.throws(() => validateSyncPayload({ format: 'other', workdays: [] }), /format/);
    assert.throws(() => validateSyncPayload({ format: SYNC_FORMAT, exportedAt: now.toISOString() }), /workdays/);
    const w = workday();
    assert.throws(() => validateSyncPayload({ format: SYNC_FORMAT, exportedAt: now.toISOString(), workdays: [w, w] }), /duplicated/);
    const inProgress = { ...w, checkpoint: { status: 'in_progress', savedAt: now.toISOString() } };
    assert.throws(() => validateSyncPayload({ format: SYNC_FORMAT, exportedAt: now.toISOString(), workdays: [inProgress] }), /in progress/);
    assert.throws(() => buildSyncPayload([inProgress], { now }), /in progress/);
  });

  it('survives a JSON round trip unchanged', () => {
    const payload = buildSyncPayload([workday({ sessionUuid: UUID, deviceId: DEVICE })], { now });
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  });
});

describe('JSON Schema of the sync record (for the backend)', () => {
  const s = WORKDAY_SYNC_JSON_SCHEMA;

  it('lists exactly the contract fields and forbids any other', () => {
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(Object.keys(s.properties).sort(), [...SYNC_FIELDS].sort());
    assert.equal(s.additionalProperties, false);
  });

  it('every required field is enforced by the validator', () => {
    const w = workday();
    for (const field of s.required) {
      const { [field]: _removed, ...rest } = w;
      assert.throws(() => validateSyncRecord(rest), undefined, field);
    }
  });

  it('enums match the validator constants', () => {
    assert.deepEqual(s.properties.schema.const, WORKDAY_SCHEMA);
    assert.deepEqual(s.properties.source.enum, [...WORKDAY_SOURCES]);
    assert.deepEqual(s.properties.checkpoint.properties.status.enum, CHECKPOINT_STATUSES.filter((c) => c !== 'in_progress'));
    assert.deepEqual(s.properties.events.items.properties.source.enum, [...EVENT_SOURCES]);
    assert.deepEqual(s.properties.events.items.properties.type.enum, [...EVENT_TYPES, 'fonacion_sostenida', 'nivel_elevado']);
  });

  it('is plain JSON', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  });
});

describe('own-voice reference and capture settings in the sync contract', () => {
  const reference = {
    method: 'connected_speech', textId: 'viento-norte-sol-v1',
    p10Dbfs: -36.4, p50Dbfs: -31.2, p90Dbfs: -28.9, durationS: 30, validS: 17.6,
  };
  const capture = { autoGainControl: false, noiseSuppression: null, echoCancellation: false };

  it('are part of the allow-list and the JSON schema', () => {
    assert.ok(SYNC_FIELDS.includes('ownVoiceRef'));
    assert.ok(SYNC_FIELDS.includes('capture'));
    assert.ok(WORKDAY_SYNC_JSON_SCHEMA.properties.ownVoiceRef);
    assert.ok(WORKDAY_SYNC_JSON_SCHEMA.properties.capture);
  });

  it('travel unchanged in a synced record', () => {
    const record = toSyncRecord({ ...workday(), ownVoiceRef: reference, capture });
    assert.deepEqual(record.ownVoiceRef, reference);
    assert.deepEqual(record.capture, capture);
  });
});
