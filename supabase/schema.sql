-- Role-based schema (odd/tasks/base-por-roles.md, T1; design: Diseño de la base de datos VocalDose).
-- Run it once in the project's SQL editor (or as a migration). It holds no secret and is idempotent.
--
-- Model
-- - The database keeps only what is measured or declared in a workday: identification, the
--   primary frames, self-reports, recovery points, marked activities and the results of the
--   voice tests (their audio is deleted on the phone, so they cannot be recomputed). It never
--   keeps audio, the speaker template, I_k, H_k, doses or any other load computed from frames:
--   every board computes them on read.
-- - Every person signs in with Supabase Auth (email link) and has a role in public.members:
--   teacher (one participant code), director (one school) or analyst (one school, or every
--   school when school_id is null). Row Level Security enforces what each role reads:
--     teacher  -> her own workdays and everything under them;
--     director -> no rows (Dirección gets aggregates of 3+ teachers from a server function, T5);
--     analyst  -> every workday of her schools.
-- - Teachers write through public.submit_workday and public.submit_frames (security definer,
--   validated, idempotent by sync key), and directly into recovery_points and consents (RLS).
-- - Accounts, roles, schools and participant codes are created by the study lead from the
--   Supabase console (service role). Nobody else can create or change them.
-- - New names (workdays, frames, submit_*) do not clash with the 0.9.0 objects
--   (workday_sync, workday_frames, upsert_workdays, upload_workday_frames, analysts,
--   upload_tokens), so both run side by side until the app switches (T7 drops the old ones).
--
-- Setting up a teacher (SQL editor, service role), after inviting her email from
-- Authentication > Users:
--   insert into public.schools (school_id, label) values ('E-25', 'Escuela 25');
--   insert into public.participants (participant_id, school_id) values ('P-0421', 'E-25');
--   insert into public.members (user_id, role, school_id, participant_id)
--   values ((select id from auth.users where email = '<her email>'), 'teacher', 'E-25', 'P-0421');
-- A director: role 'director', her school, no participant. An analyst: role 'analyst',
-- school_id null for every school.

create extension if not exists pgcrypto with schema extensions;

-- ---------- people and permissions ----------

create table if not exists public.schools (
  school_id  text primary key check (school_id ~ '^[A-Za-z0-9._-]{1,32}$'),
  label      text check (char_length(label) <= 120),
  created_at timestamptz not null default now()
);

-- A participant code is unique in the whole study, so a withdrawal deletes exactly one person.
create table if not exists public.participants (
  participant_id text primary key check (participant_id ~ '^[A-Za-z0-9._-]{1,32}$'),
  school_id      text not null references public.schools (school_id),
  created_at     timestamptz not null default now()
);

create table if not exists public.members (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  role           text not null check (role in ('teacher', 'director', 'analyst')),
  school_id      text references public.schools (school_id),
  participant_id text references public.participants (participant_id),
  created_at     timestamptz not null default now(),
  constraint members_role_scope check (
    (role = 'teacher' and participant_id is not null and school_id is not null)
    or (role = 'director' and participant_id is null and school_id is not null)
    or (role = 'analyst' and participant_id is null)
  )
);
create unique index if not exists members_one_teacher_per_user on public.members (user_id) where role = 'teacher';
create unique index if not exists members_unique_role on public.members (user_id, role, coalesce(school_id, '*'));

create table if not exists public.consents (
  id             bigint generated always as identity primary key,
  participant_id text not null references public.participants (participant_id) on delete cascade,
  version        text not null check (version ~ '^vd-consent-datos-v[0-9]+$'),
  accepted_at    timestamptz not null default now(),
  withdrawn_at   timestamptz,
  unique (participant_id, version)
);

-- ---------- workdays and what hangs from them ----------

create table if not exists public.workdays (
  sync_key          text primary key check (char_length(sync_key) between 1 and 128),
  workday_id        text not null check (char_length(workday_id) between 1 and 128),
  participant_id    text not null references public.participants (participant_id) on delete cascade,
  school_id         text not null references public.schools (school_id),
  classroom         text not null check (classroom ~ '^[A-Za-z0-9._-]{1,32}$'),
  work_date         date not null,
  started_at        timestamptz not null,
  duration_s        double precision not null check (duration_s >= 0 and duration_s <= 86400),
  device_id         text check (device_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  app_version       text not null check (char_length(app_version) between 1 and 32),
  algorithm_version text not null check (char_length(algorithm_version) between 1 and 32),
  checkpoint_status text check (checkpoint_status in ('recovered')),
  own_voice_ref     jsonb check (own_voice_ref is null or jsonb_typeof(own_voice_ref) = 'object'),
  capture           jsonb check (capture is null or jsonb_typeof(capture) = 'object'),
  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists workdays_participant on public.workdays (participant_id, work_date);
create index if not exists workdays_school on public.workdays (school_id, work_date);

-- Primary frames (vd-des-frames/1): level, F0, V/W/Q/Φ, category and SNR of every frame, gzipped
-- and split in base64 parts under 2 MB. The header holds dt, the pauses and the pressure scale.
create table if not exists public.frames (
  sync_key    text not null references public.workdays (sync_key) on delete cascade,
  part        integer not null check (part >= 0),
  parts       integer not null check (parts between 1 and 64),
  header      jsonb not null,
  data        text not null,
  received_at timestamptz not null default now(),
  primary key (sync_key, part)
);

create table if not exists public.self_reports (
  sync_key  text not null references public.workdays (sync_key) on delete cascade,
  timepoint text not null check (timepoint in ('pre', 'post')),
  item      text not null check (item in ('fatigue', 'dryness', 'discomfort', 'effort')),
  scale     text not null check (scale in ('vas100', 'borg_cr10')),
  value     double precision not null,
  primary key (sync_key, timepoint, item),
  constraint self_reports_scale_of_item check ((item = 'effort') = (scale = 'borg_cr10')),
  constraint self_reports_value_in_scale check (
    (scale = 'vas100' and value between 0 and 100)
    or (scale = 'borg_cr10' and value in (0, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
  )
);

create table if not exists public.recovery_points (
  sync_key          text not null references public.workdays (sync_key) on delete cascade,
  slot              text not null check (slot in ('R30', 'R60', 'R120', 'R240', 'NEXT')),
  recorded_at       timestamptz not null,
  minutes_after_end double precision not null check (minutes_after_end >= 0 and minutes_after_end <= 2880),
  fatigue           double precision not null check (fatigue between 0 and 100),
  primary key (sync_key, slot)
);

-- Activities marked by the teacher; the automatic ones are recomputed from the frames.
create table if not exists public.workday_events (
  sync_key text not null references public.workdays (sync_key) on delete cascade,
  seq      integer not null check (seq >= 0),
  t_s      double precision not null check (t_s >= 0 and t_s <= 86400),
  type     text not null check (type in ('llamado_atencion', 'explicacion', 'actividad_grupal', 'recreo', 'otro')),
  note     text check (char_length(note) <= 200),
  primary key (sync_key, seq)
);

-- Results of the PRE/POST voice tests: computed on the phone because their audio is deleted
-- there. No array longer than 100 values (spectra are averaged), never audio.
create table if not exists public.voice_tests (
  sync_key  text not null references public.workdays (sync_key) on delete cascade,
  timepoint text not null check (timepoint in ('pre', 'post')),
  task      text not null check (task in ('vowel', 'speech')),
  result    jsonb not null check (jsonb_typeof(result) = 'object' and result ->> 'audioRetained' = 'false'),
  primary key (sync_key, timepoint, task)
);

-- ---------- who is calling ----------
-- Security definer helpers read public.members without recursing into its own policies.

create or replace function public.my_participant()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.participant_id from public.members m
   where m.user_id = (select auth.uid()) and m.role = 'teacher'
   limit 1;
$$;

create or replace function public.analyst_reads(school text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
     where m.user_id = (select auth.uid()) and m.role = 'analyst'
       and (m.school_id is null or m.school_id = school)
  );
$$;

create or replace function public.can_read_workday(key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workdays w
     where w.sync_key = key
       and (w.participant_id = public.my_participant() or public.analyst_reads(w.school_id))
  );
$$;

create or replace function public.owns_workday(key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workdays w where w.sync_key = key and w.participant_id = public.my_participant()
  );
$$;

revoke all on function public.my_participant(), public.analyst_reads(text), public.can_read_workday(text), public.owns_workday(text) from public, anon;
grant execute on function public.my_participant(), public.analyst_reads(text), public.can_read_workday(text), public.owns_workday(text) to authenticated;

-- ---------- privileges and row level security ----------

alter table public.schools enable row level security;
alter table public.participants enable row level security;
alter table public.members enable row level security;
alter table public.consents enable row level security;
alter table public.workdays enable row level security;
alter table public.frames enable row level security;
alter table public.self_reports enable row level security;
alter table public.recovery_points enable row level security;
alter table public.workday_events enable row level security;
alter table public.voice_tests enable row level security;

revoke all on public.schools, public.participants, public.members, public.consents, public.workdays,
  public.frames, public.self_reports, public.recovery_points, public.workday_events, public.voice_tests
  from anon, authenticated;
grant select on public.schools, public.participants, public.members, public.consents, public.workdays,
  public.frames, public.self_reports, public.recovery_points, public.workday_events, public.voice_tests
  to authenticated;
grant insert, update on public.recovery_points to authenticated;
grant insert on public.consents to authenticated;
grant update (withdrawn_at) on public.consents to authenticated;

-- Each person sees her own role rows (the app reads them to know which screens to show).
drop policy if exists members_read_own on public.members;
create policy members_read_own on public.members for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists schools_read on public.schools;
create policy schools_read on public.schools for select to authenticated
  using (
    public.analyst_reads(school_id)
    or exists (select 1 from public.members m where m.user_id = (select auth.uid()) and m.school_id = schools.school_id)
  );

drop policy if exists participants_read on public.participants;
create policy participants_read on public.participants for select to authenticated
  using (participant_id = public.my_participant() or public.analyst_reads(school_id));

drop policy if exists consents_read on public.consents;
create policy consents_read on public.consents for select to authenticated
  using (
    participant_id = public.my_participant()
    or exists (select 1 from public.participants p where p.participant_id = consents.participant_id and public.analyst_reads(p.school_id))
  );
drop policy if exists consents_accept_own on public.consents;
create policy consents_accept_own on public.consents for insert to authenticated
  with check (participant_id = public.my_participant() and withdrawn_at is null);
drop policy if exists consents_withdraw_own on public.consents;
create policy consents_withdraw_own on public.consents for update to authenticated
  using (participant_id = public.my_participant())
  with check (participant_id = public.my_participant() and withdrawn_at is not null);

drop policy if exists workdays_read on public.workdays;
create policy workdays_read on public.workdays for select to authenticated
  using (participant_id = public.my_participant() or public.analyst_reads(school_id));

drop policy if exists frames_read on public.frames;
create policy frames_read on public.frames for select to authenticated
  using (public.can_read_workday(sync_key));
drop policy if exists self_reports_read on public.self_reports;
create policy self_reports_read on public.self_reports for select to authenticated
  using (public.can_read_workday(sync_key));
drop policy if exists workday_events_read on public.workday_events;
create policy workday_events_read on public.workday_events for select to authenticated
  using (public.can_read_workday(sync_key));
drop policy if exists voice_tests_read on public.voice_tests;
create policy voice_tests_read on public.voice_tests for select to authenticated
  using (public.can_read_workday(sync_key));

drop policy if exists recovery_read on public.recovery_points;
create policy recovery_read on public.recovery_points for select to authenticated
  using (public.can_read_workday(sync_key));
-- The teacher records her recovery directly, also days after the workday was sent.
drop policy if exists recovery_write_own on public.recovery_points;
create policy recovery_write_own on public.recovery_points for insert to authenticated
  with check (public.owns_workday(sync_key));
drop policy if exists recovery_update_own on public.recovery_points;
create policy recovery_update_own on public.recovery_points for update to authenticated
  using (public.owns_workday(sync_key))
  with check (public.owns_workday(sync_key));

-- ---------- uploads ----------

-- Consent that enables uploads; the app shows this version's text (src/store/sync-settings.js).
create or replace function public.current_consent_version()
returns text
language sql
immutable
set search_path = ''
as $$ select 'vd-consent-datos-v3'::text $$;

-- Payload (vd-des-upload/2):
--   { format, workday: { syncKey, workdayId, participantId, schoolId, classroom, date, startedAt,
--     durationS, deviceId?, appVersion, algorithmVersion, checkpointStatus?, ownVoiceRef?, capture? },
--     selfReports: [{ timepoint, item, scale, value }], events: [{ tS, type, note? }],
--     voiceTests: [{ timepoint, task, result }] }
-- Errors: PT401 not signed in; PT403 not this teacher's code or school, or no current consent;
-- 22023 malformed; PT413 over 512 KB. A re-sent workday replaces its rows (idempotent by sync
-- key) except the recovery points, which the teacher keeps adding directly.
create or replace function public.submit_workday(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  me text := public.my_participant();
  w jsonb := payload -> 'workday';
  key text := payload #>> '{workday,syncKey}';
  my_school text;
  owner text;
  allowed constant text[] := array['syncKey', 'workdayId', 'participantId', 'schoolId', 'classroom', 'date',
    'startedAt', 'durationS', 'deviceId', 'appVersion', 'algorithmVersion', 'checkpointStatus', 'ownVoiceRef', 'capture'];
  bad_key text;
  el jsonb;
  n integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'sign in to upload' using errcode = 'PT401';
  end if;
  if me is null then
    raise exception 'only a teacher uploads workdays' using errcode = 'PT403';
  end if;
  if octet_length(payload::text) > 512 * 1024 then
    raise exception 'workday payload too large' using errcode = 'PT413';
  end if;
  if payload ->> 'format' is distinct from 'vd-des-upload/2'
     or jsonb_typeof(w) is distinct from 'object'
     or jsonb_typeof(payload -> 'selfReports') is distinct from 'array'
     or jsonb_typeof(payload -> 'events') is distinct from 'array'
     or jsonb_typeof(payload -> 'voiceTests') is distinct from 'array' then
    raise exception 'payload must be a vd-des-upload/2 workday' using errcode = '22023';
  end if;
  select k into bad_key from jsonb_object_keys(w) as k where k <> all (allowed) limit 1;
  if bad_key is not null then
    raise exception 'unknown workday field %', bad_key using errcode = '22023';
  end if;
  if jsonb_typeof(w -> 'durationS') is distinct from 'number'
     or coalesce(w ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or coalesce(key, '') = '' then
    raise exception 'workday needs syncKey, date and durationS' using errcode = '22023';
  end if;

  select p.school_id into my_school from public.participants p where p.participant_id = me;
  if w ->> 'participantId' is distinct from me or w ->> 'schoolId' is distinct from my_school then
    raise exception 'a teacher uploads only her own workdays' using errcode = 'PT403';
  end if;
  if not exists (
    select 1 from public.consents c
     where c.participant_id = me and c.version = public.current_consent_version() and c.withdrawn_at is null
  ) then
    raise exception 'no current consent for uploads' using errcode = 'PT403';
  end if;
  select x.participant_id into owner from public.workdays x where x.sync_key = key;
  if owner is not null and owner <> me then
    raise exception 'this sync key belongs to another teacher' using errcode = 'PT403';
  end if;

  insert into public.workdays as x (
    sync_key, workday_id, participant_id, school_id, classroom, work_date, started_at, duration_s,
    device_id, app_version, algorithm_version, checkpoint_status, own_voice_ref, capture
  ) values (
    key, w ->> 'workdayId', me, my_school, w ->> 'classroom', (w ->> 'date')::date,
    (w ->> 'startedAt')::timestamptz, (w ->> 'durationS')::double precision, w ->> 'deviceId',
    w ->> 'appVersion', w ->> 'algorithmVersion', w ->> 'checkpointStatus', w -> 'ownVoiceRef', w -> 'capture'
  )
  on conflict (sync_key) do update set
    workday_id = excluded.workday_id,
    classroom = excluded.classroom,
    work_date = excluded.work_date,
    started_at = excluded.started_at,
    duration_s = excluded.duration_s,
    device_id = excluded.device_id,
    app_version = excluded.app_version,
    algorithm_version = excluded.algorithm_version,
    checkpoint_status = excluded.checkpoint_status,
    own_voice_ref = excluded.own_voice_ref,
    capture = excluded.capture,
    updated_at = now();

  delete from public.self_reports where sync_key = key;
  delete from public.workday_events where sync_key = key;
  delete from public.voice_tests where sync_key = key;

  for el in select e.value from jsonb_array_elements(payload -> 'selfReports') as e(value) loop
    insert into public.self_reports (sync_key, timepoint, item, scale, value)
    values (key, el ->> 'timepoint', el ->> 'item', el ->> 'scale', (el ->> 'value')::double precision);
  end loop;
  for el in select e.value from jsonb_array_elements(payload -> 'events') with ordinality as e(value, i) order by e.i loop
    insert into public.workday_events (sync_key, seq, t_s, type, note)
    values (key, n, (el ->> 'tS')::double precision, el ->> 'type', el ->> 'note');
    n := n + 1;
  end loop;
  for el in select e.value from jsonb_array_elements(payload -> 'voiceTests') as e(value) loop
    if jsonb_path_exists(el -> 'result', 'strict $.** ? (@.type() == "array" && @.size() > 100)') then
      raise exception 'voice test results hold no array over 100 values (no audio)' using errcode = '22023';
    end if;
    insert into public.voice_tests (sync_key, timepoint, task, result)
    values (key, el ->> 'timepoint', el ->> 'task', el -> 'result');
  end loop;
  return 1;
end;
$$;

-- Frame parts (vd-des-frames-part/1) of a workday the caller uploaded. PT425 (retried by the
-- device) while the workday has not arrived; PT403 for another teacher's workday.
create or replace function public.submit_frames(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  key text := payload ->> 'syncKey';
  part_no integer;
  total integer;
  owner text;
begin
  if (select auth.uid()) is null then
    raise exception 'sign in to upload' using errcode = 'PT401';
  end if;
  if octet_length(payload::text) > 2 * 1024 * 1024 then
    raise exception 'frame part too large' using errcode = 'PT413';
  end if;
  if payload ->> 'format' is distinct from 'vd-des-frames-part/1'
     or coalesce(key, '') = ''
     or jsonb_typeof(payload -> 'part') is distinct from 'number'
     or jsonb_typeof(payload -> 'parts') is distinct from 'number'
     or jsonb_typeof(payload -> 'header') is distinct from 'object'
     or jsonb_typeof(payload -> 'data') is distinct from 'string'
     or payload #>> '{header,schema}' is distinct from 'vd-des-frames/1' then
    raise exception 'payload must be a vd-des-frames-part/1 part' using errcode = '22023';
  end if;
  part_no := (payload ->> 'part')::integer;
  total := (payload ->> 'parts')::integer;
  if total < 1 or total > 64 or part_no < 0 or part_no >= total
     or (payload ->> 'data') !~ '^[A-Za-z0-9+/]+=*$' then
    raise exception 'frame part % of % is not valid', part_no, total using errcode = '22023';
  end if;

  select w.participant_id into owner from public.workdays w where w.sync_key = key;
  if owner is null then
    raise exception 'workday % has not been received yet', key using errcode = 'PT425';
  end if;
  if owner is distinct from public.my_participant() then
    raise exception 'a teacher uploads only frames of her own workdays' using errcode = 'PT403';
  end if;

  insert into public.frames as f (sync_key, part, parts, header, data)
  values (key, part_no, total, payload -> 'header', payload ->> 'data')
  on conflict (sync_key, part) do update set
    parts = excluded.parts, header = excluded.header, data = excluded.data, received_at = now();
  -- A record re-sent in fewer parts leaves no stale tail.
  delete from public.frames f where f.sync_key = key and f.part >= total;
  return 1;
end;
$$;

revoke all on function public.current_consent_version(), public.submit_workday(jsonb), public.submit_frames(jsonb) from public, anon;
grant execute on function public.current_consent_version(), public.submit_workday(jsonb), public.submit_frames(jsonb) to authenticated;

-- ---------- withdrawal of consent ----------
-- Deletes every workday of a participant code, with its frames, self-reports, recovery points,
-- activities and voice tests (cascade), and marks her consents withdrawn. Service role only.

create or replace function public.withdraw_participant(participant text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  with gone as (delete from public.workdays where participant_id = participant returning 1)
  select count(*)::integer into removed from gone;
  update public.consents set withdrawn_at = coalesce(withdrawn_at, now()) where participant_id = participant;
  return removed;
end;
$$;

revoke all on function public.withdraw_participant(text) from public, anon, authenticated;
grant execute on function public.withdraw_participant(text) to service_role;
