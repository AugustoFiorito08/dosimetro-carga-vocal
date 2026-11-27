# Teacher mobile view (vista docente)

Objective: a guided phone flow for the teacher — preparation, live panel, vocal score and "Mi jornada" — understandable while doing the dosimetry, sharing the measuring session with the existing technical view.
Branch: `feat/vista-docente-movil` (from `feat/f3-supabase-vercel`) · Delivery: ask-on-risk, one commit per task · Test runner: `npm test` (`node --test`).

## Specs

- **S1** Scope, as requested: "mejorar la app que va en el celular. Sería la parte de preparación, panel en vivo, partitura vocal y mi jornada. Porque debe ser algo entendible para el docente cuando hace su dosimetría." The attached phone mockups (three images, 2026-11-25) give the sequence and look: start, microphone check, PRE VAS, live monitoring, "¿Qué está haciendo?", POST VAS, recovery follow-up, data sent, workday history, results.
- **S2** Load is shown "Contra su propia historia": "«Hoy vas por encima de tu jornada habitual», comparando con su mediana y P75 personales cuando tenga al menos 5 jornadas. ... Sin zonas verde, amarilla o roja." No percentage of a daily limit, no C1/C2 gauge and no "¡ALTA CARGA VOCAL!" alert (they need validated thresholds; hitos document, principle C1/C2 only from validated human data).
- **S3** Activity is marked by the teacher ("¿Qué está haciendo?"), never shown as automatically detected; automatic events describe the acoustic pattern only (hitos document).
- **S4** Data sending states what really happens (HTTPS to the analytic base, summary without audio); no claim of a separate payload encryption.
- **S5** Assumption: the current page stays as the "vista técnica" (PC, acoustic calibration, distance dose, Dirección and Analítica); the teacher view is the default on narrow screens and both can be switched. The measuring logic is shared, not duplicated.
- **S6** Preparation as a guided sequence, one screen at a time: codes (once, remembered) → microphone → ambient (5 s silence) → speaker enrolment (15 s) → habitual-voice reference (30 s, text visible) → PRE VAS with sliders (fatigue, effort, discomfort, dryness; acoustic PRE optional) → start.
- **S7** Live panel for the teacher: elapsed time, signal chips (microphone, signal, voice recognised), phonation time and %, F0, level, current pause, the personal comparison of S2, "Marcar actividad", pause/continue and finish.
- **S8** Teacher vocal score: a simplified partitura in plain language (phonation and pauses, level, accumulated dose with the marked activities).
- **S9** End and "Mi jornada": POST VAS with sliders → save; workday summary (time, phonation, personal comparison, ΔF, activities); recovery follow-up with the open time, calendar and notifications; history of workdays with their sending state.
- **S10** Update the specification and verify on a phone-sized viewport.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S2, S5 | inline | done (RED→GREEN, 11 tests) | 5c5d467 |
| T2 | S5 | inline | done (refactor, behaviour unchanged) | a1a0217 |
| T3 | S1, S5 | inline | done (phone + desktop checked in the pane) | 1cbc161 |
| T4 | S6 | inline | done (full flow with a synthetic microphone) | 1cbc161 |
| T5 | S3, S7 | inline | done (F0 180 Hz, +3 dB at 1.4× the reference) | 1cbc161 |
| T6 | S8 | inline | done (partitura drew after the width fix) | 913e231, 1cbc161 |
| T7 | S4, S9 | inline | done (POST, save, summary, Mi jornada, history) | 1cbc161 |
| T8 | S10 | inline | done (spec §12.6, §16) | docs commit |

- T1 Pure models: teacher flow step from the session state; personal comparison (median, P75, n ≥ 5, cumulative dose at the same elapsed minute).
- T2 Extract the session actions of `dashboard.js` into named functions both views call (no behaviour change).
- T3 Teacher shell: view switch, light phone layout, bottom navigation, screen container.
- T4 Preparation screens (S6). T5 Live panel and activity sheet (S7). T6 Teacher partitura (S8). T7 POST, summary, recovery, history and sending (S9). T8 Spec and phone verification.

Route evidence: no writer trigger (units depend on T2/T3 and share `dashboard.js`/`index.html`), so the parent works inline.

## Log

- **L1** (2026-11-25, user): "ahora necesito mejorar la app que va en el celular. Sería la parte de preparación, panel en vivo, partitura vocal y mi jornada. Porque debe ser algo entendible para el docente cuando hace su dosimetría. Adjunto ejemplos de pantalla de celulares con su secuencia. ¿podrás hacerla?"
- **L2** (2026-11-25, user, on how to show load without validated thresholds): "Contra su propia historia (Recomendado)".
- **L3** Analysis: the mockups' yellow zone, C1/C2 gauge, "38 % carga del día", "¡ALTA CARGA VOCAL!", automatic "Actividad detectada" and "Cifrado" contradict the hitos document or the implementation; S2-S4 replace them. Next: T1.
- **L4** (2026-11-25) T1-T8 done on `feat/vista-docente-movil`; 523 tests pass. Verified in the browser pane at 375×812 with a synthetic microphone (the pane blocks the real one): codes → microphone → silence → enrolment → reference → PRE → live → activity → finish → POST → save → summary → partitura → Mi jornada; the technical view keeps working and the views switch both ways. Found and fixed while verifying: the partitura took its width from the F0 track, hidden in the teacher view (913e231); the partitura was redrawn before its screen was visible; technical toasts (dBFS, P10-P90) replaced by plain messages during teacher actions; a weak enrolment now offers «Repetir» or «Seguir de todos modos» in place. Not verified: a real phone and microphone, and system notifications. Test data removed from the pane.
