# Acoustic calibration (phase 3)

Objective: convert digital amplitude to calibrated pressure (Pa) and SPL with a reference tone, check drift after the session, and export the calibrated values.
Branch: `feat/calibracion-acustica` · Delivery: single PR, one commit per task · Test runner: `npm test` (`node --test`).

## Specs

- **S1** Calibration math (pure). From the frames of a reference tone of known level `L_ref` (dB SPL, default 94), compute `A_digital` (energy-mean RMS), `C_mic = P_ref / A_digital` with `P_ref = 20 µPa · 10^(L_ref/20)`, and reject the capture with a typed reason when it clips, is unstable (provisional limit: frame-level standard deviation > 0.5 dB) or is too short. Source: protocol §10.1, `P_RMS = C_mic · A_digital`.
- **S2** Drift. From the pre and post coefficients, compute `δC = 100 · (C_post − C_pre) / C_pre` (%) and the same in dB, and flag whether it is within a configurable tolerance (provisional default 0.5 dB; to be preregistered after bench validation, protocol §10.1).
- **S3** Session flow. `calibrateAcoustic({ referenceDbSpl, phase })`: `pre` before measuring sets `C_mic` for the next `start()` (pressure in Pa, units `calibrated`); `post` after a measured session computes the drift. Without a `pre` calibration everything stays relative, as today.
- **S4** Reference pressure. With calibration, `P_0` defaults to 1 Pa (94 dB SPL), configurable, and recorded in the exported parameters. (Assumption: a modelling convention, not a physiological value.)
- **S5** Export. Append `pressure_pa` and `spl_db` (empty when uncalibrated). The `parameters` column records `calRefDbSpl` and `calCoefficient`, plus `calPostCoefficient`, `calDriftPct`, `calDriftDb` and `calWithinTolerance` once the post calibration is done, so they also reach rows recorded before it.
- **S6** UI. Reference level input and buttons for the pre calibration and the post check; show `C_mic`, the drift and a warning when it is out of tolerance; the level KPI shows dB SPL when calibrated.
- **S7** Specification and version: document §5, §10, §13 and §16; algorithm version 0.4.0.
- **S8** Distance dose `D_d`. Requires the empirical vibration-amplitude formula of Titze, Švec & Popolo (2003). **Blocked**: the source could not be retrieved (HTTP 403) and the formula will not be written from memory.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S2 | inline | done | f655b06 · RED: missing module; GREEN: 7 tests, suite 153/153 |
| T2 | S3, S4, S5 | inline | done | 6859e89 · RED: 8/8 session tests; GREEN: suite 162/162; differential: uncalibrated CSV identical plus two empty cells |
| T3 | S6 | inline | done | bd76dc5 · browser check: renders, controls disabled without audio, no console errors, no horizontal overflow; live mic flow not testable here |
| T4 | S7 | inline | done | this commit · RED: version assertion; GREEN: suite 162/162 |
| T5 | S8 | — | blocked (source) | |

## Log

- **L1** (2026-11-13, user): "ya lo fusione y continuar con la fase 3"
- **L2** Phase 3 scope as proposed earlier: reference tone pre/post, `C_mic`, drift `δC`, P in Pa and SPL in the engine and CSV, a defined `P_0`, and the distance dose after verifying its formula.
- **L3** The user did not answer whether a reference calibrator or sound level meter is available. Design: the user enters the known level `L_ref`, which covers both a calibrator (94/114 dB at 1 kHz) and a steady tone read with a sound level meter. Without either, the session stays relative.
- **L4** Drift tolerance: a Hong Kong technical memorandum accepts before/after agreement within 1.0 dB; a 0.5 dB rule attributed to ISO 9612 could not be confirmed. 0.5 dB is used as a provisional, configurable default.
- **L5** The `D_d` source (Montclair open copy) returned HTTP 403; T5 is blocked until the user provides the paper.
- **L6** Routing: every task inline (no writer trigger: dependent units, each about 100 lines or less).
- **L7** T1-T4 done; suite 162/162. Differential check: an uncalibrated session exports the same rows as before plus two empty cells. Browser check of the panel passed; the live microphone flow could not be exercised in the preview browser.
- **L8** Next step: T5 (distance dose) once the user supplies Titze, Švec & Popolo (2003); then push and open the PR.
