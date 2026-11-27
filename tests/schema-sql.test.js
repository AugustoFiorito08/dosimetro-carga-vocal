// Role-based schema (supabase/schema.sql; odd/tasks/base-por-roles.md, T1, S2-S6) run on a real
// Postgres (PGlite) with the pieces of Supabase it relies on: the anon, authenticated and
// service_role roles, auth.users and auth.uid() read from the request's JWT subject.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

const USERS = {
  t1: '00000000-0000-4000-8000-000000000001', // teacher P1, school E1
  t2: '00000000-0000-4000-8000-000000000002', // teacher P2, school E1
  t3: '00000000-0000-4000-8000-000000000003', // teacher P3, school E2
  dir: '00000000-0000-4000-8000-000000000004', // director of E1
  an1: '00000000-0000-4000-8000-000000000005', // analyst of E1
  anAll: '00000000-0000-4000-8000-000000000006', // analyst of every school
  stranger: '00000000-0000-4000-8000-000000000007', // signed in, no role
};

/** The Supabase pieces the schema expects, then the schema, then the study's people. */
async function createDatabase() {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema extensions; create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public, extensions to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    -- Supabase grants every privilege on new public tables by default; the schema must revoke them.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  await db.exec(SCHEMA);
  await db.exec(`
    insert into auth.users (id) select unnest(array[${Object.values(USERS).map((u) => `'${u}'::uuid`).join(',')}]);
    insert into public.schools (school_id) values ('E1'), ('E2');
    insert into public.participants (participant_id, school_id) values ('P1', 'E1'), ('P2', 'E1'), ('P3', 'E2');
    insert into public.members (user_id, role, school_id, participant_id) values
      ('${USERS.t1}', 'teacher', 'E1', 'P1'), ('${USERS.t2}', 'teacher', 'E1', 'P2'), ('${USERS.t3}', 'teacher', 'E2', 'P3'),
      ('${USERS.dir}', 'director', 'E1', null), ('${USERS.an1}', 'analyst', 'E1', null), ('${USERS.anAll}', 'analyst', null, null);
    insert into public.consents (participant_id, version) values ('P1', 'vd-consent-datos-v3'), ('P3', 'vd-consent-datos-v3');
  `);
  return db;
}

/** Runs fn as a signed-in user (or anon with user = null), in a transaction that is kept. */
async function as(db, user, fn) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${user ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user ?? '']);
    return fn(tx);
  });
}
const rows = async (tx, sql, params) => (await tx.query(sql, params)).rows;
const code = (expected) => (e) => (e.code === expected ? true : assert.fail(`expected ${expected}, got ${e.code}: ${e.message}`));

const workday = (key, participant, school, extra = {}) => ({
  format: 'vd-des-upload/2',
  workday: {
    syncKey: key, workdayId: `S-${key}`, participantId: participant, schoolId: school, classroom: '2B',
    date: '2026-11-27', startedAt: '2026-11-27T11:00:00Z', durationS: 14400, appVersion: '0.10.0', algorithmVersion: '0.10.0',
    ownVoiceRef: { method: 'reading', p50Dbfs: -32 }, capture: { autoGainControl: false }, ...extra,
  },
  selfReports: [
    { timepoint: 'pre', item: 'fatigue', scale: 'vas100', value: 10 },
    { timepoint: 'post', item: 'fatigue', scale: 'vas100', value: 45 },
    { timepoint: 'pre', item: 'effort', scale: 'borg_cr10', value: 0.5 },
  ],
  events: [{ tS: 600, type: 'recreo' }, { tS: 1200, type: 'explicacion', note: 'tema nuevo' }],
  voiceTests: [{ timepoint: 'pre', task: 'vowel', result: { audioRetained: false, cpps: 12.3, ltas: Array(64).fill(-40) } }],
});
const submit = (tx, payload) => tx.query('select public.submit_workday($1::jsonb) as n', [JSON.stringify(payload)]);
const part = (key, p, parts) => ({ format: 'vd-des-frames-part/1', syncKey: key, part: p, parts, header: { schema: 'vd-des-frames/1' }, data: 'AAAA' });
const submitFrames = (tx, payload) => tx.query('select public.submit_frames($1::jsonb) as n', [JSON.stringify(payload)]);

describe('role-based schema on Postgres (supabase/schema.sql)', () => {
  let db;
  before(async () => {
    db = await createDatabase();
    await as(db, USERS.t1, (tx) => submit(tx, workday('K1', 'P1', 'E1')));
    await as(db, USERS.t3, (tx) => submit(tx, workday('K3', 'P3', 'E2')));
  });

  it('keeps only measured or declared data: no column for doses, H, I or per-second series', async () => {
    const cols = await rows(db, `select table_name, column_name from information_schema.columns where table_schema = 'public'`);
    const names = cols.map((c) => c.column_name);
    for (const banned of ['doses', 'dose', 'h_max', 'hmax', 'intensity', 'per_second', 'timeline', 'record', 'audio']) {
      assert.ok(!names.includes(banned), `no column ${banned}`);
    }
    assert.deepEqual([...new Set(cols.map((c) => c.table_name))].sort(), [
      'consents', 'frames', 'members', 'participants', 'recovery_points', 'schools', 'self_reports', 'voice_tests', 'workday_events', 'workdays',
    ]);
  });

  it('a teacher with the current consent uploads her workday with its self-reports, activities and voice tests', async () => {
    const got = await as(db, USERS.t1, async (tx) => ({
      w: await rows(tx, 'select participant_id, school_id, classroom, duration_s from public.workdays'),
      s: await rows(tx, 'select timepoint, item, scale, value from public.self_reports order by timepoint, item'),
      e: await rows(tx, 'select seq, t_s, type, note from public.workday_events order by seq'),
      v: await rows(tx, 'select timepoint, task from public.voice_tests'),
    }));
    assert.deepEqual(got.w, [{ participant_id: 'P1', school_id: 'E1', classroom: '2B', duration_s: 14400 }]);
    assert.equal(got.s.length, 3);
    assert.deepEqual(got.e.map((r) => [r.seq, r.type, r.note]), [[0, 'recreo', null], [1, 'explicacion', 'tema nuevo']]);
    assert.deepEqual(got.v, [{ timepoint: 'pre', task: 'vowel' }]);
  });

  it('a re-sent workday replaces its rows and keeps the recovery points', async () => {
    await as(db, USERS.t1, async (tx) => {
      await submit(tx, workday('KR', 'P1', 'E1'));
      await tx.query(`insert into public.recovery_points values ('KR', 'R30', now(), 31, 30)`);
      const again = workday('KR', 'P1', 'E1', { classroom: '3A' });
      again.selfReports = again.selfReports.slice(0, 1);
      await submit(tx, again);
      assert.deepEqual(await rows(tx, `select classroom from public.workdays where sync_key = 'KR'`), [{ classroom: '3A' }]);
      assert.equal((await rows(tx, `select 1 from public.self_reports where sync_key = 'KR'`)).length, 1);
      assert.equal((await rows(tx, `select 1 from public.recovery_points where sync_key = 'KR'`)).length, 1);
    });
  });

  it('refuses uploads without sign-in, without consent, for another code or school, or from another role', async () => {
    await assert.rejects(as(db, USERS.stranger, (tx) => submit(tx, workday('X', 'P1', 'E1'))), code('PT403'));
    await assert.rejects(as(db, USERS.t2, (tx) => submit(tx, workday('X2', 'P2', 'E1'))), code('PT403'), 'no consent');
    await assert.rejects(as(db, USERS.t1, (tx) => submit(tx, workday('X3', 'P2', 'E1'))), code('PT403'), 'another code');
    await assert.rejects(as(db, USERS.t1, (tx) => submit(tx, workday('X4', 'P1', 'E2'))), code('PT403'), 'another school');
    await assert.rejects(as(db, USERS.t3, (tx) => submit(tx, workday('K1', 'P3', 'E2'))), code('PT403'), 'another teacher\'s sync key');
    await assert.rejects(as(db, USERS.dir, (tx) => submit(tx, workday('X5', 'P1', 'E1'))), code('PT403'), 'a director');
    await assert.rejects(as(db, USERS.an1, (tx) => submit(tx, workday('X6', 'P1', 'E1'))), code('PT403'), 'an analyst');
    await assert.rejects(as(db, null, (tx) => submit(tx, workday('X7', 'P1', 'E1'))), code('42501'), 'anon cannot call it');
  });

  it('refuses computed or malformed data: unknown fields, values off their scale, audio in a voice test', async () => {
    const t1 = (payload) => as(db, USERS.t1, (tx) => submit(tx, payload));
    await assert.rejects(t1(workday('Y1', 'P1', 'E1', { doses: { none: 1 } })), code('22023'));
    const borg = workday('Y2', 'P1', 'E1');
    borg.selfReports = [{ timepoint: 'pre', item: 'effort', scale: 'borg_cr10', value: 1.5 }];
    await assert.rejects(t1(borg), code('23514'));
    const vas = workday('Y3', 'P1', 'E1');
    vas.selfReports = [{ timepoint: 'post', item: 'fatigue', scale: 'borg_cr10', value: 3 }];
    await assert.rejects(t1(vas), code('23514'), 'fatigue is a VAS');
    const longArray = workday('Y4', 'P1', 'E1');
    longArray.voiceTests = [{ timepoint: 'pre', task: 'vowel', result: { audioRetained: false, samples: Array(101).fill(0) } }];
    await assert.rejects(t1(longArray), code('22023'));
    const audio = workday('Y5', 'P1', 'E1');
    audio.voiceTests = [{ timepoint: 'pre', task: 'vowel', result: { audioRetained: true } }];
    await assert.rejects(t1(audio), code('23514'));
    await assert.rejects(t1({ ...workday('Y6', 'P1', 'E1'), format: 'vd-des-workdays/1' }), code('22023'));
    assert.deepEqual(await rows(db, `select sync_key from public.workdays where sync_key like 'Y%'`), [], 'nothing half-written');
  });

  it('frames go after their workday, only to the teacher who uploaded it, without a stale tail', async () => {
    await assert.rejects(as(db, USERS.t1, (tx) => submitFrames(tx, part('NOPE', 0, 1))), code('PT425'));
    await assert.rejects(as(db, USERS.t3, (tx) => submitFrames(tx, part('K1', 0, 1))), code('PT403'));
    await as(db, USERS.t1, async (tx) => {
      for (let p = 0; p < 3; p++) await submitFrames(tx, part('K1', p, 3));
      await submitFrames(tx, part('K1', 0, 2));
      assert.deepEqual((await rows(tx, `select part from public.frames where sync_key = 'K1' order by part`)).map((r) => r.part), [0, 1]);
    });
    await assert.rejects(as(db, USERS.t1, (tx) => submitFrames(tx, { ...part('K1', 0, 1), data: 'no base64!' })), code('22023'));
  });

  it('each role reads only its scope: own workdays, none for the director, the schools of each analyst', async () => {
    await as(db, USERS.t3, (tx) => submitFrames(tx, part('K3', 0, 1)));
    const keys = (user, table = 'workdays') => as(db, user, async (tx) => (await rows(tx, `select distinct sync_key from public.${table} order by sync_key`)).map((r) => r.sync_key));
    assert.deepEqual(await keys(USERS.t1), ['K1', 'KR']);
    assert.deepEqual(await keys(USERS.t2), []);
    assert.deepEqual(await keys(USERS.t3), ['K3']);
    assert.deepEqual(await keys(USERS.dir), [], 'the director gets aggregates from a server function, never rows');
    assert.deepEqual(await keys(USERS.an1), ['K1', 'KR']);
    assert.deepEqual(await keys(USERS.anAll), ['K1', 'K3', 'KR']);
    assert.deepEqual(await keys(USERS.stranger), []);
    for (const table of ['frames', 'self_reports', 'workday_events', 'voice_tests']) {
      assert.ok(!(await keys(USERS.t1, table)).includes('K3'), `t1 does not read ${table} of K3`);
      assert.deepEqual(await keys(USERS.dir, table), [], `director reads no ${table}`);
      assert.ok((await keys(USERS.anAll, table)).includes('K3'), `the analyst of every school reads ${table} of K3`);
      assert.ok(!(await keys(USERS.an1, table)).includes('K3'), `the analyst of E1 does not read ${table} of K3`);
    }
    await assert.rejects(as(db, null, (tx) => tx.query('select * from public.workdays')), code('42501'), 'anon reads nothing');
  });

  it('a teacher records and corrects her recovery, also later, and only on her own workdays', async () => {
    await as(db, USERS.t1, async (tx) => {
      await tx.query(`insert into public.recovery_points values ('K1', 'NEXT', now(), 1200, 15)`);
      await tx.query(`update public.recovery_points set fatigue = 12 where sync_key = 'K1' and slot = 'NEXT'`);
      assert.deepEqual(await rows(tx, `select fatigue from public.recovery_points where sync_key = 'K1'`), [{ fatigue: 12 }]);
    });
    await assert.rejects(as(db, USERS.t3, (tx) => tx.query(`insert into public.recovery_points values ('K1', 'R60', now(), 60, 20)`)), code('42501'));
    await assert.rejects(as(db, USERS.an1, (tx) => tx.query(`insert into public.recovery_points values ('K1', 'R60', now(), 60, 20)`)), code('42501'));
    await assert.rejects(as(db, USERS.t1, (tx) => tx.query(`insert into public.recovery_points values ('K1', 'R60', now(), 60, 101)`)), code('23514'));
  });

  it('a teacher accepts and withdraws only her own consent; she cannot undo a withdrawal', async () => {
    await as(db, USERS.t2, (tx) => tx.query(`insert into public.consents (participant_id, version) values ('P2', 'vd-consent-datos-v3')`));
    await as(db, USERS.t2, (tx) => submit(tx, workday('K2', 'P2', 'E1')));
    await assert.rejects(as(db, USERS.t2, (tx) => tx.query(`insert into public.consents (participant_id, version) values ('P1', 'vd-consent-datos-v4')`)), code('42501'));
    await as(db, USERS.t2, (tx) => tx.query(`update public.consents set withdrawn_at = now() where participant_id = 'P2'`));
    await assert.rejects(as(db, USERS.t2, (tx) => submit(tx, workday('K2b', 'P2', 'E1'))), code('PT403'), 'no uploads after withdrawing');
    await assert.rejects(as(db, USERS.t2, (tx) => tx.query(`update public.consents set withdrawn_at = null where participant_id = 'P2'`)), code('42501'));
    await assert.rejects(as(db, USERS.t2, (tx) => tx.query(`update public.consents set version = 'vd-consent-datos-v9' where participant_id = 'P2'`)), code('42501'));
  });

  it('nobody but the study lead changes schools, codes or roles; each person reads only her own role', async () => {
    for (const user of [USERS.t1, USERS.dir, USERS.anAll]) {
      await assert.rejects(as(db, user, (tx) => tx.query(`insert into public.members (user_id, role, school_id) values ('${user}', 'analyst', null)`)), code('42501'));
      await assert.rejects(as(db, user, (tx) => tx.query(`insert into public.participants values ('P9', 'E1')`)), code('42501'));
    }
    const roles = await as(db, USERS.t1, (tx) => rows(tx, 'select role, participant_id from public.members'));
    assert.deepEqual(roles, [{ role: 'teacher', participant_id: 'P1' }]);
  });

  it('withdrawal deletes everything of one code, and only the service role can run it', async () => {
    await assert.rejects(as(db, USERS.anAll, (tx) => tx.query(`select public.withdraw_participant('P3')`)), code('42501'));
    const removed = await db.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      return (await rows(tx, `select public.withdraw_participant('P3') as n`))[0].n;
    });
    assert.equal(removed, 1);
    for (const table of ['workdays', 'frames', 'self_reports', 'workday_events', 'voice_tests', 'recovery_points']) {
      assert.deepEqual(await rows(db, `select 1 from public.${table} where sync_key = 'K3'`), [], `${table} of K3 deleted`);
    }
    assert.ok((await rows(db, `select withdrawn_at from public.consents where participant_id = 'P3'`))[0].withdrawn_at);
    assert.equal((await rows(db, `select 1 from public.workdays where participant_id = 'P1'`)).length, 2, 'other codes untouched');
  });

  it('can be run again over itself (idempotent)', async () => {
    await db.exec(SCHEMA);
    assert.equal((await rows(db, 'select count(*)::int as n from public.workdays'))[0].n, 3);
  });
});
