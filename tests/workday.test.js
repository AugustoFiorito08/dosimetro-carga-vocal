import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createScoreSeries } from '../src/ui/score-series.js';
import {
  EVENT_TYPES,
  WORKDAY_SCHEMA,
  buildWorkday,
  validateCode,
  validateWorkday,
  workdayId,
} from '../src/store/workday.js';
import { createMemoryRepository } from '../src/store/workday-repository.js';
import { EXPORT_FORMAT, exportWorkdays, importWorkdays } from '../src/store/workday-io.js';

const DT = 0.5;
function sessionFixture() {
  const series = createScoreSeries();
  let d = 0;
  for (let i = 0; i < 240; i++) { // 2 minutes, voiced 3 of every 4 frames
    const phi = i % 4 === 3 ? 0 : 1;
    d += phi * 2;
    series.push({ t: i * DT, dt: DT, phi, f0: phi ? 180 + (i % 10) : null, level: phi ? 80 + (i % 5) : null, h: i / 10,
      doses: { none: d, linear: 2 * d, power: d, exponential: 3 * d, saturating: d }, distanceDose: d / 100 });
  }
  const load = {
    h: 23.9, units: 'calibrated', referencePressure: 1, params: { beta: 1 / 300 },
    doses: { none: d, linear: 2 * d, power: d, exponential: 3 * d, saturating: d },
    conventionalDoses: { time: 90, cycle: 16500 }, distanceDose: d / 100,
    metrics: { totalTime: 120, phonationTime: 90, nonPhonationTime: 30,
      timeByCategory: { attributed: 90, unattributed_voice: 5, noise: 5, silence: 14, uncertain: 6 } },
  };
  return { series, load };
}
const meta = {
  participantId: 'P-0421', schoolId: 'E-25', classroom: '2B', fatiguePre: 12, fatiguePost: 46,
  events: [{ t: 30, type: 'llamado_atencion', source: 'docente' }],
};
const startedAt = new Date(2026, 10, 12, 8, 0, 0);

describe('workday codes and ids', () => {
  it('accepts pseudonymous codes and rejects names with spaces or empty values', () => {
    assert.equal(validateCode('participantId', 'P-0421'), 'P-0421');
    assert.equal(validateCode('classroom', '2.B'), '2.B');
    assert.throws(() => validateCode('participantId', 'Laura Cabrera'), RangeError);
    assert.throws(() => validateCode('schoolId', ''), RangeError);
  });

  it('ids are S-YYYYMMDD-HHMMSS-<participant>', () => {
    assert.equal(workdayId(startedAt, 'P-0421'), 'S-20261112-080000-P-0421');
  });

  it('lists the context event types', () => {
    assert.deepEqual(EVENT_TYPES, ['llamado_atencion', 'explicacion', 'actividad_grupal', 'recreo', 'otro']);
  });
});

describe('buildWorkday (summary only, never audio or frames)', () => {
  const { series, load } = sessionFixture();
  const w = buildWorkday({ meta, load, series, startedAt, algorithmVersion: '0.4.0', source: 'live' });

  it('keeps codes, date, durations, every dose and the fatigue VAS', () => {
    assert.equal(w.schema, WORKDAY_SCHEMA);
    assert.equal(w.id, 'S-20261112-080000-P-0421');
    assert.deepEqual([w.participantId, w.schoolId, w.classroom, w.date], ['P-0421', 'E-25', '2B', '2026-11-12']);
    assert.equal(w.durationS, 120);
    assert.equal(w.phonationS, 90);
    assert.deepEqual(w.doses, { ...load.doses, distance: load.distanceDose, time: 90, cycle: 16500 });
    assert.deepEqual(w.fatigue, { pre: 12, post: 46 });
    assert.equal(w.units, 'calibrated');
    assert.equal(w.ownVoiceRefDbfs, null, 'calibrated sessions have no own-voice reference');
    const normalized = buildWorkday({ meta, load: { ...load, units: 'normalized', ownVoiceReferenceDbfs: -31.2 }, series, startedAt, algorithmVersion: '0.7.0', source: 'live' });
    assert.equal(normalized.units, 'normalized');
    assert.equal(normalized.ownVoiceRefDbfs, -31.2);
    assert.equal(w.source, 'live');
  });

  it('summarizes F0 and level by percentiles and quality as the share of certain frames', () => {
    assert.equal(w.f0.p50, 184); // checked independently with Python's statistics.median
    assert.ok(w.level.p10 >= 80 && w.level.p90 <= 84);
    assert.equal(w.validRatio, 1 - 6 / 120);
    assert.equal(w.hMax, 23.9);
  });

  it('stores a per-minute cumulative timeline of every dose', () => {
    assert.deepEqual(w.timeline.minutes, [1, 2]);
    assert.equal(w.timeline.doses.exponential.length, 2);
    assert.equal(w.timeline.doses.none[1], load.doses.none);
  });

  it('passes validation, and validation rejects broken records', () => {
    assert.equal(validateWorkday(w), w);
    assert.throws(() => validateWorkday({ ...w, fatigue: { pre: 120, post: null } }), RangeError);
    assert.throws(() => validateWorkday({ ...w, participantId: 'Ana López' }), RangeError);
    assert.throws(() => validateWorkday({ ...w, schema: 'other' }), RangeError);
  });

  it('VAS values are optional (null) but must be 0-100 when given', () => {
    const noVas = buildWorkday({ meta: { ...meta, fatiguePre: null, fatiguePost: null }, load, series, startedAt, algorithmVersion: '0.4.0', source: 'live' });
    assert.deepEqual(noVas.fatigue, { pre: null, post: null });
  });
});

describe('memory repository', () => {
  it('saves, lists newest first, gets, replaces by id and removes', async () => {
    const repo = createMemoryRepository();
    const { series, load } = sessionFixture();
    const a = buildWorkday({ meta, load, series, startedAt, algorithmVersion: '0.4.0', source: 'live' });
    const b = { ...a, id: 'S-20261113-080000-P-0421', date: '2026-11-13', startedAt: '2026-11-13T11:00:00.000Z' };
    await repo.save(a);
    await repo.save(b);
    assert.deepEqual((await repo.list()).map((w) => w.id), [b.id, a.id]);
    await repo.save({ ...a, fatigue: { pre: 10, post: 40 } });
    assert.equal((await repo.list()).length, 2);
    assert.deepEqual((await repo.get(a.id)).fatigue, { pre: 10, post: 40 });
    await repo.remove(a.id);
    assert.deepEqual((await repo.list()).map((w) => w.id), [b.id]);
    await assert.rejects(repo.save({ ...a, participantId: '' }), RangeError);
  });
});

describe('JSON export / import', () => {
  it('round-trips, skips duplicates by id and reports invalid records', async () => {
    const { series, load } = sessionFixture();
    const a = buildWorkday({ meta, load, series, startedAt, algorithmVersion: '0.4.0', source: 'live' });
    const text = exportWorkdays([a]);
    assert.equal(JSON.parse(text).format, EXPORT_FORMAT);
    const repo = createMemoryRepository();
    assert.deepEqual(await importWorkdays(repo, text), { added: 1, skipped: 0, invalid: [] });
    assert.deepEqual(await importWorkdays(repo, text), { added: 0, skipped: 1, invalid: [] });
    const bad = JSON.stringify({ format: EXPORT_FORMAT, workdays: [{ ...a, id: 'S-x', fatigue: { pre: -1, post: 2 } }] });
    const result = await importWorkdays(repo, bad);
    assert.equal(result.added, 0);
    assert.equal(result.invalid.length, 1);
    const imported = await repo.get(a.id);
    assert.equal(imported.source, 'import');
    await assert.rejects(importWorkdays(repo, '{"format":"other"}'), /format/);
  });
});

describe('own-voice reference and capture settings in the workday (spec §10.1)', () => {
  const reference = {
    method: 'connected_speech', textId: 'viento-norte-sol-v1',
    p10Dbfs: -36.4, p50Dbfs: -31.2, p90Dbfs: -28.9, durationS: 30, validS: 17.6,
  };
  const capture = { autoGainControl: false, noiseSuppression: false, echoCancellation: null };
  const build = (load) => buildWorkday({ meta, load, series: sessionFixture().series, startedAt, algorithmVersion: '0.9.0', source: 'live' });

  it('keeps the reference statistics and the browser processing state of the session', () => {
    const { load } = sessionFixture();
    const w = build({ ...load, units: 'normalized', ownVoiceReferenceDbfs: -31.2, ownVoiceReference: reference, capture });
    assert.deepEqual(w.ownVoiceRef, reference);
    assert.deepEqual(w.capture, capture);
    assert.equal(w.ownVoiceRefDbfs, -31.2);
  });

  it('adds them only when the session has them, so earlier records keep their shape', () => {
    const w = build(sessionFixture().load);
    assert.equal('ownVoiceRef' in w, false);
    assert.equal('capture' in w, false);
  });

  it('rejects malformed values', () => {
    const { load } = sessionFixture();
    const base = { ...load, units: 'normalized', ownVoiceReferenceDbfs: -31.2 };
    assert.throws(() => build({ ...base, capture: { ...capture, autoGainControl: 'off' } }), /capture\.autoGainControl/);
    assert.throws(() => build({ ...base, ownVoiceReference: { ...reference, p10Dbfs: 'x' } }), /ownVoiceRef\.p10Dbfs/);
    assert.throws(() => build({ ...base, ownVoiceReference: { ...reference, extra: 1 } }), /ownVoiceRef\.extra/);
  });
});
