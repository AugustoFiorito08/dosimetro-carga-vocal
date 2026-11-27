# Role-based database (base por roles)

Objective: the database keeps only measured or declared data (frames, workday identification, self-reports, voice-test results); every board computes on read, and each role (teacher, director, analyst) reads only its scope.
Branch: `feat/base-por-roles` (from `main`) · Delivery: ask-on-risk, one PR per stage (design doc: https://claude.ai/artifact/DEinK4batZMbmp27nDCVrN) · Test runner: `npm test` (`node --test`).

## Specs

- **S1** Flow (user, 2026-11-27): "el celular el docente hace su dosimetría. Cuando la termina la envía a la base de datos (en este caso supabase porque ahora lo estamos haciendo asi). Luego si puede ver mi jornada y partitura pero tomando los datos desde esa base de datos, porque esto le permite ver todas sus jornadas y partituras que fue haciendo dosimetrías."
- **S2** Director (user): "La directora ve lo de Dirección, porque levanta los datos de la base de datos de todos los docentes todas las jornadas." Decision (2026-11-27, "Sí, las cuatro"): only aggregates of groups of 3 or more teachers, computed on the server.
- **S3** Analyst (user): "el tablero analitico solo yo lo veo (o a quien dispone la autorización), no lo ve el docente ni el director."
- **S4** Stored data (user): "en base de datos se tienen que guardar, no audio ni en ningun lado audio, las tramas con sus valores no se calcula nada Dk ni Ik, son los valores puros numericos" and "la base tiene que tener solo tramas y todo se calcula al leer." Exception agreed in the design: voice-test results (CPPS, HNR, F0, jitter, shimmer, spectrum) are stored because their audio is deleted.
- **S5** Workday data (user): "los datos del docente, la escuela, el aula, como esta Pre y Post de la voz [...] deberían estar en la base de datos, porque con ellos se cruzan para delta F, AUC y todas las estadísticos posibles de los que ya tenemos y a futuro quisieramos hacer."
- **S6** Access is enforced by the database (RLS), not by the screen. Login: email link without password (decision 2026-11-27). Accounts and roles are created by the study lead from the Supabase console (decision 2026-11-27).
- **S7** Analytics computes in the analyst's browser from the frames, with the parameters chosen (decision 2026-11-27).

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S2-S6 | inline | done (12 tests on PGlite, 4 mutations caught) | see L5 |
| T2 | S6 | inline | pending | |
| T3 | S1, S4, S5 | inline | pending | |
| T4 | S1 | inline | pending | |
| T5 | S2 | inline | pending | |
| T6 | S3, S7 | inline | pending | |
| T7 | S4-S6 | inline | pending | |

- T1 New schema (`supabase/schema.sql`): ten tables, roles, RLS, upload, recovery and consent functions, withdrawal; tests.
- T2 Login with email link and role-gated screens in the app.
- T3 New upload: workday and child tables without computed values, frames always (also recovered sessions), recovery written directly.
- T4 Mi jornada and Partitura read from the database.
- T5 Dirección: server function returning only aggregates of 3+ teachers.
- T6 Analítica reads from the database and recomputes from frames (A_0 and q included).
- T7 Consent v3, spec §12 and §14, drop `workday_sync`.

## Log

- **L1** (user, 2026-11-27) "la idea del proyecto es así: el celular el docente hace su dosimetría. Cuando la termina la envía a la base de datos (en este caso supabase porque ahora lo estamos haciendo asi). Luego si puede ver mi jornada y partitura pero tomando los datos desde esa base de datos, porque esto le permite ver todas sus jornadas y partituras que fue haciendo dosimetrías. La directora ve lo de Dirección, porque levanta los datos de la base de datos de todos los docentes todas las jornadas. Y el tablero analitico solo yo lo veo (o a quien dispone la autorización), no lo ve el docente ni el director. Entonces en base de datos se tienen que guardar, no audio ni en ningun lado audio, las tramas con sus valores no se calcula nada Dk ni Ik, son los valores puros numericos que luego sirven como datos para en analitica, o en jornada, o en dirección o en partitura cuando llame esos datos a la base de datos correspondiente a quien esté usando que tablero le corresponda pueda hacer, leer, o la acción que haga el tablero en particular para lo cual sirve. ¿se entiende?"
- **L2** (user, 2026-11-27) "la base tiene que tener solo tramas y todo se calcula al leer. Entiendo que cada trama guarda t, F, A y tita, ¿cierto?, y con eso en Base de Datos cada tablero se alimenta y calcula Dk y Hk. Pero ademas tenes los datos del docente, la escuela, el aula, como esta Pre y Post de la voz, ¿estos donde van a estar?, deberían estar en la base de datos, porque con ellos se cruzan para delta F, AUC y todas las estadísticos posibles de los que ya tenemos y a futuro quisieramos hacer. Podes explicarme y controlar que falta hacer?"
- **L3** (user, 2026-11-27) Design approved with its four recommendations: "Sí, las cuatro". Next: T1.
- **L4** (user, 2026-11-27) PGlite approved: "Sí, como devDependency (Recomendado)" (`@electric-sql/pglite` 0.6.1, exact).
- **L6** Independent verifier on a9e1693: S2, S5 pass; S4 partial (advisories); S6 blocker B1: after a withdrawal, `submit_frames` and the recovery-point policies still accepted writes. Fixed in one batch with `public.has_current_consent()` on every teacher write (RED: 3 new asserts failed; GREEN: 12/12). Also taken: voice-test results refuse text over 200 characters (no audio as base64, A1) and the workday upsert only updates the caller's row (A3). Open advisories for later tasks: free jsonb fields (`capture`, `ownVoiceRef`, frame `header`) accept any keys (A2); frame parts with different totals can coexist (A4, readers use the newest `parts`); a teacher's own withdrawal does not hide data until the study lead runs `withdraw_participant` (A5, confirm in T7); `accepted_at` is client-settable, `part: 1.5` gives 22P02, unknown top-level payload keys are ignored, `members.school_id` is not checked against the participant's school (A6).
- **L5** T1: `supabase/schema.sql` with new names (`workdays`, `frames`, `submit_workday`, `submit_frames`, `withdraw_participant`) so it runs beside the 0.9.0 objects until T7. Upload format `vd-des-upload/2`; uploads need consent `vd-consent-datos-v3` (T7 must ship that text). Tests run the SQL on PGlite with Supabase roles and auth.uid(); mutations (open read policy, ignore withdrawal, keep anon grants, keep stale frame tail) each fail the suite. Risk: item 2 (permissions/RLS) and item 1 (persisted format) -> independent verifier. Next: verifier, then T2.
