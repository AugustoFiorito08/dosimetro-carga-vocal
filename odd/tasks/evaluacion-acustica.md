# PRE/POST acoustic assessment

Objective: a short, standardised PRE/POST voice assessment (sustained /a/ + standard text) analysed in the browser and discarded, giving ΔA alongside the fatigue VAS, separate from continuous dosimetry.
Branches: `feat/evaluacion-acustica-motor` → `feat/evaluacion-acustica-protocolo` → `feat/evaluacion-acustica-perturbacion` (chain, stacked on `feat/verificacion-hablante`, PR #8) · Delivery: one PR per branch, one commit per task · Test runner: `npm test` (`node --test`).

## Specs

- **S1** F0 of a recording: mean, median, SD (Hz and semitones), range (p5–p95, Hz and semitones), voiced seconds and pitch confidence (mean YIN periodicity of voiced frames). Pitch settings are recorded with every result.
- **S2** CPP and CPPS (Hillenbrand; parameters as close as practical to Praat's `PowerCepstrogram` / `Get CPPS` defaults and recorded): pre-emphasis from 50 Hz, analysis window for a 60 Hz pitch floor, 2 ms time step, peak search 60–330 Hz, tilt line fitted from 1 ms to the end of the cepstrum by least squares, CPPS smoothing 10 ms in time and 1 ms in quefrency. In connected speech, pauses are excluded by level. Values are this implementation's; they are not claimed to equal Praat's until validated against it.
- **S3** HNR (dB) of voiced frames by normalised cross-correlation at the local period.
- **S4** Stored derived spectra (user: "si guardar un espectro promedio a largo plazo (LTAS) o un cepstro promedio"): LTAS in 1/3-octave bands 100 Hz–8 kHz (dB relative to the total) and the average smoothed cepstrum 1–20 ms; nothing from which the voice or the words can be reconstructed.
- **S5** Quality control, immediate, so a bad take is repeated on the spot: 1 s silent lead-in; SNR = voiced level − lead-in level (rejected below 20 dB, warning below 30 dB); clipping (rejected above 0.1 % of samples at full scale); minimum voiced time (vowel 2 s, text 5 s). Status `ok` / `warning` / `rejected` with reasons.
- **S6** Analyse and discard (user: "analizar y borrar. El dosimetro no debe grabar voz, es confidencial."): the recording lives only in memory during analysis, is overwritten with zeros afterwards, and is never written to storage, the CSV, or the network. Every result carries `audioRetained: false`.
- **S7** Protocol UI: PRE block before the workday and POST block after it, each with the VAS fatigue (existing fields), effort, discomfort and dryness (0–100), and guided recordings of the sustained /a/ (5 s) and the standard text. The text (user: "elegi un texto vos") is the project's own wording of Aesop's fable "El viento norte y el sol", the passage used in phonetics (IPA illustrations). Results table PRE / POST / Δ, titled "Cambio acústico PRE–POST", never "fatiga"; no clinical cut-offs shown.
- **S8** Persistence and export: the workday record keeps the VAS and the acoustic results (no audio); a CSV export `VOICE_ACOUSTIC_ASSESSMENT` with one row per timepoint × task: timepoint PRE/POST, task VOWEL/SPEECH, F0, F0 SD, F0 range, CPP, CPPS, HNR, jitter, shimmer, signal quality, algorithm version, pitch settings, microphone, calibration, audio retained, plus LTAS and cepstrum.
- **S9** Jitter (local, %) and shimmer (local, %) on the sustained vowel only, marked exploratory; Praat's period (0.1–20 ms, factor 1.3) and amplitude (factor 1.6) limits.
- **S10** Specification and version: document the module in the spec; algorithm version 0.6.0.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1–S5 | inline | done | engine commit · RED: missing module; GREEN: 18 tests, suite 286/286; 20 s of speech analysed in ~2.5 s on desktop (Praat 2 ms step kept; UI must run it off the main thread) |
| T2 | S6–S8 | inline | done | protocol commit · tests: recording (3), runner (4), protocol/workday/CSV (9); suite 301/301 · browser: real module Worker transfers the take (page copy detached), 25 s at 48 kHz analysed in ~5 s without blocking the page; VAS, reload persistence, table and export guard checked at desktop and 375 px; live microphone takes not testable here · RED not observed first for these (written alongside) |
| T3 | S9 | inline | done | perturbation commit · RED: 5/5 failing; GREEN: 5 tests, suite 306/306; synthetic σ=1 % → 0.92 % (44.1 and 48 kHz), σ=5 % shimmer → 4.1 %, clean → 0.00 (each measured cycle mixes two synthetic ones, so about 20 % low) |
| T4 | S10 | inline | done | spec commit · spec §23 (§17 was taken; code references updated), §14 privacy, §22 version row; 0.6.0 in CSV, package and page; suite 306/306 |

## Log

- **L1** (2026-11-20, user): "si guardar un espectro promedio a largo plazo (LTAS) o un cepstro promedio. Con esto ya es posible que agregues esto a la aplicacion?" then "elegi un texto vos". Earlier: "analizar y borrar. El dosimetro no debe grabar voz, es confidencial." The full proposal (PRE/POST protocol, CPPS first, jitter/shimmer exploratory, "Cambio acústico PRE–POST" not "fatiga", VD-DES `VOICE_ACOUSTIC_ASSESSMENT`) was pasted earlier in the conversation.
- **L2** Agreed plan: three PRs (engine; protocol UI + export; jitter/shimmer). Forecast about 1,300 authored lines, so it is chained. Routing: every task inline (dependent units, no parallel writer reason).
- **L3** Spec section is §23 (the spec already had a §17). Main-column horizontal overflow at 375 px (`.controls`, `.tabs`, KPIs) predates this feature and is out of scope. Analysis time: about 5 s for a 25 s take at 48 kHz in a desktop Worker; on a phone expect several times more.
