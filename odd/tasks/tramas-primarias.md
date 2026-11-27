# Primary frame data (tramas primarias)

Objective: keep the primary per-frame data of every workday (time, F0, level, V/W/Q/Φ, category) on the phone and in Supabase, so doses can be recomputed exactly with any parameter, A_0 or q, without measuring again.
Branch: `feat/tramas-primarias` (from `feat/vista-docente-movil`) · Delivery: ask-on-risk, one commit per task · Test runner: `npm test` (`node --test`).

## Specs

- **S1** Request, from document "05 - Recalibración de los parámetros": "Si conservás, para cada trama, al menos: t_k, F_0,k, A_k, Φ_k más identificación de sesión, calidad de señal y baseline individual (A_{0,i}), VocalDose Analytics puede volver a calcular posteriormente: I_k = (A_k/A_0,i)^2 y reconstruir (H_k) y todos los (D_k) utilizando distintos parámetros." Fields listed: "timestamp, F0, amplitude, Phi, speaker_valid, signal_quality junto con: A0_ref, dt, microphone_id, algorithm_version". Rule: "Nunca conservar solamente el resultado final de una ecuación cuando pueda conservarse la información primaria necesaria para reconstruirla."
- **S2** Where (user, 2026-11-27): "Celular + Supabase (Recomendado)": stored with the workday on the phone and sent compressed to Supabase; consent text updated ("se envían F0 y nivel por trama, sin audio").
- **S3** How (user, 2026-11-27): "Tabla en partes (Recomendado)": a new SQL function like upsert_workdays, same upload token, stores the workday in parts under 2 MB; installed by running the SQL file again.
- **S4** Frame record `vd-des-frames/1`: per frame the level (20·log10 rms, 0.01 dB), F0 (0.1 Hz, 0 = none), V, W, Q, Φ, category and SNR; per session dt, sample rate, frame size, pause gaps, pressure scale (calibration coefficient or own-voice A_0 rms), P_0, units, algorithm version. Assumption: the microphone is recorded by kind only, never its device label (labels can hold personal names).
- **S5** Exact recomputation from the frames: replaying the engine reproduces the stored doses; A_0 and q can be changed.
- **S6** Local storage: frames saved with the workday, deleted with it and with "Borrar jornadas"; earlier workdays without frames keep working.
- **S7** Sync: frames go after their workday is accepted, idempotent by sync key and part; deleting a participant deletes their frames; RLS like workday_sync; the spec (§14.1) states that frames are sent.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S4 | inline | done (RED→GREEN, 6 tests) | 7daf9ec |
| T2 | S5 | inline | done (RED→GREEN, 5 tests) | T2 commit |
| T3 | S2, S6 | inline | pending | |
| T4 | S3, S7 | inline | pending | |
| T5 | S2, S7 | inline | pending | |

- T1 Frame codec: encode/decode `vd-des-frames/1` (typed columns, gzip, base64 parts under 2 MB).
- T2 Exact recomputation from decoded frames (engine replay; A_0 and q adjustable).
- T3 Capture during the session and local storage (IndexedDB store `frames`, schema v3) saved and deleted with the workday.
- T4 Sync: outbox item for frames, transport RPC, server table and function, deletion cascade.
- T5 Spec and consent text; browser check.

Route evidence: no writer trigger (units depend on T1 and share sync files), so the parent works inline. RDD is off (global), so no native review.

## Log

- **L1** (2026-11-27, user): "Datos por trama primero" (after the audit of "05 - Recalibración de los parámetros", gap 1: primary per-frame data are only exported by hand).
- **L2** (2026-11-27, user): "Celular + Supabase (Recomendado)".
- **L3** (2026-11-27, user): "Tabla en partes (Recomendado)". Storage was dropped because its policies cannot check the device upload token without an Edge Function.
- **L4** Analysis: ~23 frames/s (2048 samples at 48 kHz), ~675 000 frames per 8 h; 6 bytes per frame before gzip (~4 MB), sent as base64 parts. Next: T1.
- **L5** (2026-11-27) T1 done: codec vd-des-frames/1; 6 bytes/frame; worst case 8 h (random values) 4.05 MB raw, 3.27 MB base64 in 3 parts. Next: T2.
- **L6** (2026-11-27) T2 done: frame replay matches the engine within ~1e-6 relative with varied levels; the bound is the level rounding (0.005 dB steps, at most 5.8e-4 in I per frame), reached when few levels repeat (test data: 6e-5). Per-second series: ~1 % at β = 0.03. A_0 and q adjustable. Next: T3.
