# Control dashboards and epidemiological analytics

Objective: store measured workdays with coded metadata and fatigue self-reports, and add three tabs (Mi jornada, Dirección, Analítica) that summarize them; a labelled simulated dataset shows the screens before real data exist.
Branch: `feat/tableros-analiticos`, stacked on `feat/partitura-vocal` · Delivery: chained PRs of about 400 lines when possible · Test runner: `npm test` (`node --test`).

## Specs

- **S1** "agregar tres nuevas solapas a la aplicacion. Son nuevas pantallas para utilizar como tableros de control y para estudios estadísticos epidemiologicos por el tablero analitico." Reference images: "VocalDose Analytics" (epidemiological platform), "Detectar cuándo aumenta la carga para actuar mejor" (teacher view and school management) and "Tablero de Control – Dirección Escolar".
- **S2** Data source, chosen by the user: "Datos reales + demo" — store each session in the browser with teacher, school and classroom codes and pre/post fatigue (VAS 0-100), allow importing workdays from other devices, and a labelled simulated dataset to show the screens now.
- **S3** Workday record (summary, never audio or frames): pseudonymous codes (participant, school, classroom), date, start, duration, phonation time, every dose (D_0, D_L, D_P, D_E, D_S, D_d when computed, D_t, D_c), max H, F0 and level percentiles, valid-frame ratio, units and calibration, a per-minute dose timeline, context events, pre/post fatigue VAS (protocol §16.1), algorithm version, source (`live`, `import` or `demo`).
- **S4** Storage port with an IndexedDB adapter (browser) and an in-memory adapter (tests); export and import of workdays as JSON (`vd-des-workdays/v1`).
- **S5** Simulated dataset: seeded and reproducible, several schools, classrooms, teachers and weeks; always shown with a "DATOS SIMULADOS" banner and never mixed with real records.
- **S6** Statistics (pure): descriptive (n, mean, median, SD, P5-P95), histogram, OLS dose-response with 95% CI of the mean, Spearman correlation, ROC with AUC (Mann-Whitney) and Hanley-McNeil 95% CI per dose model, Youden cut-off with sensitivity, specificity, PPV, NPV and Wilson 95% CI. Case definition: fatigue change (post − pre) ≥ a configurable threshold, provisional default 20 points, shown on screen.
- **S7** Session form: codes and pre-VAS before starting; context events during measurement (llamado de atención, explicación, actividad grupal, recreo, otro); post-VAS and "Guardar jornada" after finishing.
- **S8** Tab "Mi jornada" (teacher): KPIs of the selected workday, dose and dose-rate timeline with events, event list, VAS pre/post; automatic events with provisional rules (sustained phonation, raised level relative to the teacher's own workday).
- **S9** Tab "Dirección" (school): school and week filters, KPIs, heat map classroom × day of mean dose, load by classroom, fatigue distribution pre/post, weekly percentiles, one teacher's workday with events. Teachers appear only by code; groups with fewer than 3 teachers are not shown (minimum group size).
- **S10** Tab "Analítica" (research): KPI tiles, participation by month, dose distribution with descriptive table, latest workdays table, dose-response scatter with OLS line and band, ROC curves of the five models with AUC table, performance at the Youden cut-off, provisional action levels derived from the data, and CSV export of the summaries.
- **S11** Every screen says "Valores provisionales · sin umbrales sanitarios validados"; with demo data also "DATOS SIMULADOS".
- **Out of scope**: mixed models and splines (only OLS is implemented), server-side storage and authentication, CAPE-V, VFI and acoustic parameters such as CPP.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S3, S4 | inline | pending | |
| T2 | S5 | inline | pending | |
| T3 | S6 | inline | pending | |
| T4 | S7 | inline | pending | |
| T5 | S8 | inline | pending | |
| T6 | S9 | inline | pending | |
| T7 | S10, S11 | inline | pending | |
| T8 | docs | inline | pending | |

## Log

- **L1** (2026-11-18, user): "agregar tres nuevas solapas a la aplicacion. Son nuevas pantallas para utilizar como tableros de control y para estudios estadísticos epidemiologicos por el tablero analitico." (three reference images).
- **L2** (2026-11-18, user choice): "Datos reales + demo (Recommended)".
- **L3** Protocol check: the primary outcome is perceived fatigue/effort on a 0-100 VAS (§16.1); ROC/AUC per model are planned when a dichotomous outcome exists, and the minimum relevant change must be fixed before analysing D_k. Hence the configurable, provisional case threshold. The reference images name teachers; the protocol uses codes (ID_DOC) and data minimization, so the app shows codes only.
- **L4** Routing: inline (the session rules forbid spawning agents unless the user asks).
