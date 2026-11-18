# Vocal-load score ("partitura dosimétrica vocal")

Objective: a new tab that shows the temporal evolution of voice use in one session as synchronized tracks, like a musical score.
Branch: `feat/partitura-vocal`, stacked on `feat/calibracion-acustica` (uses calibrated SPL and `D_d`) · Delivery: one PR based on that branch, one commit per task · Test runner: `npm test` (`node --test`).

## Specs

- **S1** "agregar un solapa para poder lograr algo similar a esto. Es una analogía que representa una partitura de carga vocal. Es la evolución temporal del uso de la voz." A tab bar in the main column switches between the live panel and a new "Partitura vocal" tab; the session keeps running in both.
- **S2** Six tracks sharing one time axis that covers the whole current or last session (start to now), as in the reference image:
  1. `Φ(t)`: phonation and pauses band;
  2. `F0` (Hz), only during accepted phonation;
  3. level `L_p`: dB SPL when calibrated, dBFS otherwise (labelled), only during accepted phonation;
  4. `H(t)`: modelled recent-load state;
  5. `ΔD/Δt`: accumulation rate of the selected dose, per minute;
  6. `D_k`: accumulated selected dose.
  Pauses of at least 2 s are shaded across all tracks; intervals where the session was paused are shown as breaks, never as data.
- **S3** Dose selector for tracks 5 and 6: `D_0`, `D_L`, `D_P`, `D_E`, `D_S`, and `D_d` when the session computes it. Units follow the dose (relative units or m).
- **S4** A short note per track, as in the image: phonation blocks and pauses; "only during voice, no values in pauses"; H is a mathematical state, not measured fatigue; rate peaks are accumulation, not a reversible change of `D_k`; `D_k` only grows or stays flat, with plateaus in pauses.
- **S5** Hover: a vertical crosshair across all tracks with a tooltip giving time and every track's value at that time.
- **S6** Disclaimers: "Modelo conceptual · validación pendiente"; "En la pausa: la dosis acumulada permanece; H puede disminuir."
- **S7** Musical analogy strip: Altura → F0, Duración → fonación, Dinámica → nivel vocal, Silencios → pausas, Secuencia → historia de exposición (H).
- **S8** Performance: data stored in growable typed arrays and reduced per pixel column before drawing, so a full workday (≥ 8 h at 42.7 ms frames, about 675 000 frames) stays responsive. Drawing only inside `requestAnimationFrame`, only when the tab is visible and data changed.
- **Out of scope** (needs multi-session storage that the app does not have): personal dashboard across days, weekly heat map by class, collective profiles.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S2, S3, S8 | inline | pending | |
| T2 | S2, S4, S5, S6 | inline | pending | |
| T3 | S1, S3, S7 | inline | pending | |
| T4 | docs | inline | pending | |

## Log

- **L1** (2026-11-18, user): "agregar un solapa para poder lograr algo similar a esto. Es una analogía que representa una partitura de carga vocal. Es la evolución temporal del uso de la voz." (with a reference image: VocalDose "Partitura dosimétrica vocal").
- **L2** Palette for the five line/bar tracks (dark surface `#151f29`): categorical slots 1-5 of the dataviz reference palette, `#3987e5, #d95926, #199e70, #c98500, #d55181`; the validator passes all checks. The `Φ` band reuses the app's phonation colour.
- **L3** Routing: all inline (one feature, dependent units).
