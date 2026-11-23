-- Reference schema for syncing workday summaries to Supabase (spec §14.1, phase F2).
-- Run it once in the project's SQL editor (or as a migration). It holds no secret.
--
-- Model
-- - Devices upload only through public.upsert_workdays(payload jsonb), called by
--   src/store/supabase-transport.js with the public anon key and an upload token in the
--   `x-upload-token` header. The function runs as its owner (security definer), checks the
--   token against its SHA-256 hash, and accepts only records of the token's school.
-- - anon and authenticated have no direct privilege on the tables: they cannot read, insert,
--   update or delete rows. Analysts (authenticated users listed in public.analysts) read
--   through RLS, limited to their school (or every school when school_id is null).
-- - Idempotency: one row per sync key (sessionUuid, or the workday id when absent). A retry
--   or a newer version of the same session replaces the row; it never duplicates it.
-- - Only summaries, by pseudonymous codes: no audio, frames or speaker template. The
--   function enforces the same field allow-list as the client contract (workday-sync.js).
--
-- Issuing an upload token (SQL editor, service role). Generate a long random value on a
-- trusted machine, give it to the device in F3, and store only its hash:
--   insert into public.upload_tokens (token_hash, school_id, label)
--   values (encode(extensions.digest('<the token>', 'sha256'), 'hex'), 'E-25', 'equipo aula 2B');
-- Revoking it: update public.upload_tokens set revoked_at = now() where label = 'equipo aula 2B';

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------

create table if not exists public.workday_sync (
  sync_key          text primary key,                 -- sessionUuid ?? id (idempotency key)
  workday_id        text not null,
  school_id         text not null,
  participant_id    text not null,
  classroom         text not null,
  work_date         date not null,
  started_at        timestamptz,
  units             text not null default 'relative',
  algorithm_version text,
  source            text not null,
  checkpoint_status text,                              -- null (saved) or 'recovered'
  device_id         text,
  record            jsonb not null,                    -- the full vd-des-workday/1 summary
  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists workday_sync_school_date on public.workday_sync (school_id, work_date);
create index if not exists workday_sync_participant on public.workday_sync (participant_id, work_date);
create index if not exists workday_sync_date on public.workday_sync (work_date);

create table if not exists public.upload_tokens (
  token_hash text primary key,                         -- hex SHA-256 of the token, never the token
  school_id  text not null,
  label      text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.analysts (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users (id) on delete cascade,
  school_id text,                                      -- null = every school
  unique nulls not distinct (user_id, school_id)       -- Postgres 15+ (Supabase default)
);

-- ---------- privileges and RLS ----------
-- Supabase grants anon/authenticated on new public tables by default: take it back.

alter table public.workday_sync enable row level security;
alter table public.upload_tokens enable row level security;
alter table public.analysts enable row level security;

revoke all on public.workday_sync from anon, authenticated;
revoke all on public.upload_tokens from anon, authenticated;
revoke all on public.analysts from anon, authenticated;

grant select on public.workday_sync to authenticated;
grant select on public.analysts to authenticated;

drop policy if exists analysts_read_own on public.analysts;
create policy analysts_read_own on public.analysts for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists analysts_read_workdays on public.workday_sync;
create policy analysts_read_workdays on public.workday_sync for select to authenticated
  using (exists (
    select 1 from public.analysts a
    where a.user_id = (select auth.uid())
      and (a.school_id is null or a.school_id = workday_sync.school_id)
  ));
-- upload_tokens has no policy: only the service role and the function below can read it.

-- ---------- upload function ----------
-- Errors map to HTTP statuses through PostgREST: PT401 -> 401, PT403 -> 403, PT409 -> 409,
-- PT413 -> 413, 22023 -> 400. supabase-transport.js marks all of them as permanent.

create or replace function public.upsert_workdays(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  allowed constant text[] := array[
    'schema', 'id', 'sessionUuid', 'deviceId',
    'participantId', 'schoolId', 'classroom',
    'date', 'startedAt', 'durationS', 'phonationS', 'validRatio',
    'doses', 'hMax', 'f0', 'level', 'units', 'ownVoiceRefDbfs',
    'timeline', 'events', 'fatigue', 'assessment',
    'algorithmVersion', 'source', 'checkpoint'
  ];
  code_pattern constant text := '^[A-Za-z0-9._-]{1,32}$';
  token text := nullif(current_setting('request.headers', true)::jsonb ->> 'x-upload-token', '');
  token_school text;
  rec jsonb;
  bad_key text;
  written integer;
  total integer := 0;
begin
  if token is null then
    raise exception 'missing upload token' using errcode = 'PT401';
  end if;
  select t.school_id into token_school
    from public.upload_tokens t
   where t.token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
     and t.revoked_at is null;
  if token_school is null then
    raise exception 'invalid or revoked upload token' using errcode = 'PT401';
  end if;

  if payload ->> 'format' is distinct from 'vd-des-workdays/1' or jsonb_typeof(payload -> 'workdays') is distinct from 'array' then
    raise exception 'payload must be a vd-des-workdays/1 envelope' using errcode = '22023';
  end if;
  if jsonb_array_length(payload -> 'workdays') > 50 or octet_length(payload::text) > 2 * 1024 * 1024 then
    raise exception 'payload too large' using errcode = 'PT413';
  end if;

  for rec in select value from jsonb_array_elements(payload -> 'workdays') loop
    if jsonb_typeof(rec) is distinct from 'object' or rec ->> 'schema' is distinct from 'vd-des-workday/1' then
      raise exception 'each workday must be a vd-des-workday/1 record' using errcode = '22023';
    end if;
    select k into bad_key from jsonb_object_keys(rec) as k where k <> all (allowed) limit 1;
    if bad_key is not null then
      raise exception 'unknown field "%" in a synced workday', bad_key using errcode = '22023';
    end if;
    if rec #>> '{checkpoint,status}' = 'in_progress' then
      raise exception 'workday % is still in progress', rec ->> 'id' using errcode = '22023';
    end if;
    if coalesce(rec ->> 'id', '') = ''
       or coalesce(rec ->> 'participantId', '') !~ code_pattern
       or coalesce(rec ->> 'schoolId', '') !~ code_pattern
       or coalesce(rec ->> 'classroom', '') !~ code_pattern
       or coalesce(rec ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or jsonb_typeof(rec -> 'durationS') is distinct from 'number'
       or jsonb_typeof(rec -> 'phonationS') is distinct from 'number'
       or coalesce(rec ->> 'source', '') not in ('live', 'import', 'demo')
       or (rec ? 'sessionUuid' and coalesce(rec ->> 'sessionUuid', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'workday % does not match the vd-des-workday/1 contract', coalesce(rec ->> 'id', '?') using errcode = '22023';
    end if;
    if rec ->> 'schoolId' <> token_school then
      raise exception 'the upload token cannot write workdays of school %', rec ->> 'schoolId' using errcode = 'PT403';
    end if;

    insert into public.workday_sync as w (
      sync_key, workday_id, school_id, participant_id, classroom, work_date, started_at,
      units, algorithm_version, source, checkpoint_status, device_id, record
    ) values (
      coalesce(rec ->> 'sessionUuid', rec ->> 'id'), rec ->> 'id', rec ->> 'schoolId', rec ->> 'participantId',
      rec ->> 'classroom', (rec ->> 'date')::date, (rec ->> 'startedAt')::timestamptz,
      coalesce(rec ->> 'units', 'relative'), rec ->> 'algorithmVersion', rec ->> 'source',
      rec #>> '{checkpoint,status}', rec ->> 'deviceId', rec
    )
    on conflict (sync_key) do update set
      workday_id = excluded.workday_id,
      participant_id = excluded.participant_id,
      classroom = excluded.classroom,
      work_date = excluded.work_date,
      started_at = excluded.started_at,
      units = excluded.units,
      algorithm_version = excluded.algorithm_version,
      source = excluded.source,
      checkpoint_status = excluded.checkpoint_status,
      device_id = excluded.device_id,
      record = excluded.record,
      updated_at = now()
    where w.school_id = excluded.school_id;            -- never overwrite another school's row

    get diagnostics written = row_count;
    if written = 0 then
      raise exception 'sync key of workday % belongs to another school', rec ->> 'id' using errcode = 'PT409';
    end if;
    total := total + 1;
  end loop;
  return total;
end;
$$;

revoke all on function public.upsert_workdays(jsonb) from public;
grant execute on function public.upsert_workdays(jsonb) to anon, authenticated;

-- ---------- withdrawal of consent (spec §14.1) ----------
-- Deletes every synced workday of a participant code. Service role only.

create or replace function public.delete_participant_workdays(participant text)
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (delete from public.workday_sync where participant_id = participant returning 1)
  select count(*)::integer from gone;
$$;

revoke all on function public.delete_participant_workdays(text) from public, anon, authenticated;
grant execute on function public.delete_participant_workdays(text) to service_role;
