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
- **S8** Distance dose `D_d`, "como lo expresa este documento" (Titze, Švec & Popolo, 2003, JSLHR 46:919-932), "como otra manera de ver la dosis":
  - eq. 22: `D_d = 4 ∫ k_v · A · F0 dt` (m);
  - eq. 14: `A = 0.05 · L0 · [(P_L − P_th) / P_th]^(1/2)` (m), `L0` = 16 mm (male) / 10 mm (female);
  - eq. 15: `P_th = 0.14 + 0.06 · (F0 / F0N)^2` (kPa), `F0N` = 120 Hz (male) / 190 Hz (female);
  - eq. 16: `P_L = P_th + 10^((SPL − 78.5) / 27.3)` (kPa), with SPL in dB at 0.5 m from the mouth.
  - `k_v` is `Phi_k`. Requires a calibrated session and a model profile (male/female). The SPL at the microphone is converted to 0.5 m with an offset `SPL_mic − SPL_0.5m` that is either measured (paper method: sustained vowel recorded by the head-mounted mic and a sound level meter at 50 cm) or approximated from the mouth-microphone distance by inverse-distance spreading (assumption, flagged as approximate). Without calibration or profile, `D_d` is not computed; requesting it on an uncalibrated session is an error, never silently ignored.
  - Export `d_d` (m) as a new last CSV column, record the profile and the offset in `parameters`, and show `D_d` in the panel.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S2 | inline | done | f655b06 · RED: missing module; GREEN: 7 tests, suite 153/153 |
| T2 | S3, S4, S5 | inline | done | 6859e89 · RED: 8/8 session tests; GREEN: suite 162/162; differential: uncalibrated CSV identical plus two empty cells |
| T3 | S6 | inline | done | bd76dc5 · browser check: renders, controls disabled without audio, no console errors, no horizontal overflow; live mic flow not testable here |
| T4 | S7 | inline | done | this commit · RED: version assertion; GREEN: suite 162/162 |
| T5 | S8 | inline | done | this commit · RED: missing module, CSV header, 2 session tests; GREEN: suite 176/176; differential: with D_d off, calibrated and uncalibrated CSV identical plus one empty cell; browser: panel renders at 355 px, no console errors |

## Log

- **L1** (2026-11-13, user): "ya lo fusione y continuar con la fase 3"
- **L2** Phase 3 scope as proposed earlier: reference tone pre/post, `C_mic`, drift `δC`, P in Pa and SPL in the engine and CSV, a defined `P_0`, and the distance dose after verifying its formula.
- **L3** The user did not answer whether a reference calibrator or sound level meter is available. Design: the user enters the known level `L_ref`, which covers both a calibrator (94/114 dB at 1 kHz) and a steady tone read with a sound level meter. Without either, the session stays relative.
- **L4** Drift tolerance: a Hong Kong technical memorandum accepts before/after agreement within 1.0 dB; a 0.5 dB rule attributed to ISO 9612 could not be confirmed. 0.5 dB is used as a provisional, configurable default.
- **L5** The `D_d` source (Montclair open copy) returned HTTP 403; T5 is blocked until the user provides the paper.
- **L6** Routing: every task inline (no writer trigger: dependent units, each about 100 lines or less).
- **L7** T1-T4 done; suite 162/162. Differential check: an uncalibrated session exports the same rows as before plus two empty cells. Browser check of the panel passed; the live microphone flow could not be exercised in the preview browser.
- **L8** Next step: T5 (distance dose) once the user supplies Titze, Švec & Popolo (2003); then push and open the PR.
- **L9** (2026-11-18, user): "este es el documento que faltaba para la dosis de distancia. Agrega esta mejora que me solicitabas. Es para que pongas una dosis de distancia como lo expresa este documento. Servirá como otra manera de ver la dosis."
- **L10** Equations 14-16 and 22 read from the PDF pages 6-8 (images). The paper's SPL is at 50 cm; their head-mounted mic (about 5 cm) was referred to 50 cm through a sustained vowel recorded simultaneously by a sound level meter at 50 cm, not by a distance law. Both routes are supported; the measured one is preferred. PR #3 is still open, so T5 joins it under version 0.4.0.
- **L11** T5 done: `src/math/distance-dose.js` (eqs. 14, 15, 16 and 22), engine `distanceDose`, session `setDistanceDoseOptions`, CSV `d_d`, panel controls and KPI, spec §11.8, §12, §13 and §22. The 520 m figure is documented as context only and not used as a threshold. The live microphone flow is still untested.
- **L12** (2026-11-18, user): "para la Dd tomar la frecuencia que esta en mi proyecto y la voz con el microfono como lo tenemos en mi proyecto. Dejar una aclaración al respecto en esta Dd."
- **L13** (2026-11-18, user): "utilizar el codigo que resta esa diferencia, medida o estimada por distancia. Porque en la prueba que hice no calculo Dd?"
- **L14** Diagnosis of the user's test (`dosimetro_2026-11-18T13-08-12.csv`): 25 columns (no `d_d`) although the D_d code existed since 12:58, so the browser ran cached modules (`python3 -m http.server` sends no Cache-Control); and `units=relative`, so the session had no acoustic calibration and D_d could not be computed anyway. Fixes: `scripts/dev-server.py` (`Cache-Control: no-store`, now `npm start`), a KPI note explaining why D_d is empty, and the F0/microphone clarification in §11.8 and in the panel. The SPL is still referred to 50 cm (measured or distance-estimated offset), as the user chose.
- **L15** (2026-11-18, user): "porque no funciona la aplicación, no inicia"
- **L16** Reproduced in the preview browser with a synthetic input (1 kHz tone, noise, 150 Hz harmonic voice) and a timer-driven render loop: connect → tone calibration (C = 14.175, matches theory) → ambient → enrol → male profile at 5 cm → start works, `D_d` accumulates, the CSV has 26 columns with `d_d` and the `dd*` parameters; no render errors. The only path where "Iniciar" does not start is a distance-dose profile without acoustic calibration, which showed an English message. Fix: typed error `distance_dose_needs_calibration` and an actionable Spanish message. If the user's case differs, the message shown in the panel is needed.
