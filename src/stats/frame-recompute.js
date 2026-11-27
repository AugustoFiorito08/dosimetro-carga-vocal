// Exact recomputation from the primary frames of a workday (vd-des-frames/1, src/store/frame-record.js;
// odd/tasks/tramas-primarias.md, S5): the engine replayed frame by frame with the same rules
// (src/math/load-state.js, src/math/dose-models.js), so with the recording parameters it gives
// the stored doses, and with others it gives what the engine would have given. Besides the dose
// parameters, the pressure reference and the intensity exponent can change:
//   P_k = rms_k · scale     scale = calibration coefficient, or 1/A_0 for the own-voice reference
//   I_k = (P_k / P_0)^q     q = 2 in the engine
// Paused intervals have no frames, so H does not evolve there, as in the engine.
import { DOSE_MODELS, doseIncrements, resolveModelParams } from '../math/dose-models.js';
import { updateLoadState } from '../math/load-state.js';
import { validateFramesHeader } from '../store/frame-record.js';

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Digital-to-pressure scale of a record, with an optional other A_0 for an own-voice record. */
function pressureScale(header, a0Rms) {
  const p = header.pressureScale;
  if (a0Rms !== undefined) {
    if (p.mode !== 'own_voice') throw new RangeError('another A_0 only applies to a record normalized to the own voice');
    if (!positive(a0Rms)) throw new RangeError(`A_0 must be positive, got ${a0Rms}`);
    return 1 / a0Rms;
  }
  if (p.mode === 'calibrated') return p.coefficient;
  if (p.mode === 'own_voice') return 1 / p.a0Rms;
  return 1;
}

/**
 * @param {object} header vd-des-frames/1 header
 * @param {ReturnType<import('../store/frame-record.js').decodeFrames>} frames
 * @param {{ params?: object, q?: number, a0Rms?: number }} options params as in resolveModelParams
 * @returns {{ doses: Record<string, number>, hFinal: number, hMax: number, phonationS: number, q: number, params: object }}
 */
export function recomputeFromFrames(header, frames, { params = {}, q = 2, a0Rms } = {}) {
  validateFramesHeader(header);
  if (!positive(q)) throw new RangeError(`q must be positive, got ${q}`);
  const resolved = resolveModelParams(params);
  const scale = pressureScale(header, a0Rms);
  const p0 = header.referencePressure;
  const dt = header.dt;
  const doses = Object.fromEntries(DOSE_MODELS.map((m) => [m, 0]));
  let h = 0;
  let hMax = 0;
  let phonationS = 0;
  for (let i = 0; i < frames.phi.length; i++) {
    const phi = frames.phi[i];
    h = updateLoadState(h, phi, dt, resolved.beta);
    if (h > hMax) hMax = h;
    if (phi !== 1) continue;
    phonationS += dt;
    const rms = 10 ** (frames.levelDb[i] / 20);
    const intensity = ((rms * scale) / p0) ** q;
    const increments = doseIncrements({ f0: frames.f0[i] ?? 0, intensity, phi, h, dt }, resolved);
    for (const m of DOSE_MODELS) doses[m] += increments[m];
  }
  return { doses, hFinal: h, hMax, phonationS, q, params: resolved };
}
