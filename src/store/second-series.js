// Per-second series of a workday (`perSecond`): for each second of measured time, the
// phonated time Phi·dt (s, 0-1) and the mean F0·I over that phonated time (0 when there was
// none). phonation[k] * f0I[k] is the memory-free dose D0 of second k (to the stored rounding:
// 4 decimals and 6 significant digits, about 1e-6 relative), so the doses can be
// recomputed with other parameters without the audio or the frames.
//
// Seconds count measured time: paused intervals have no frames and add no seconds, as in the
// engine, where H does not evolve while the session is paused. Only two derived numbers per
// second are kept: at 1 Hz the series cannot hold audio.

/** A series covers at most one day. */
export const MAX_SERIES_SECONDS = 24 * 3600;

const PHONATION_DECIMALS = 1e4;
const F0I_DIGITS = 6;
/** Frames ending within this of a second boundary do not open a new second. */
const EPSILON = 1e-9;

export function createSecondSeries() {
  let phonated = [];
  let weighted = [];
  let elapsed = 0;

  const ensure = (k) => {
    while (phonated.length <= k) {
      phonated.push(0);
      weighted.push(0);
    }
  };

  return {
    /**
     * Adds one frame, split across second boundaries by its duration.
     * @param {{ dt: number, phi: 0 | 1, f0?: number, intensity?: number }} frame
     *   intensity is the engine's I_k (stepVocalLoad lastFrame.intensity)
     */
    push({ dt, phi, f0, intensity }) {
      if (!(dt > 0)) return;
      const f0I = phi === 1 ? f0 * intensity : 0;
      let t = elapsed;
      let remaining = dt;
      while (remaining > EPSILON) {
        const k = Math.floor(t + EPSILON);
        const part = Math.min(remaining, k + 1 - t);
        ensure(k);
        if (phi === 1) {
          phonated[k] += part;
          weighted[k] += f0I * part;
        }
        t += part;
        remaining -= part;
      }
      elapsed += dt;
    },
    reset() {
      phonated = [];
      weighted = [];
      elapsed = 0;
    },
    get length() {
      return phonated.length;
    },
    /** `{ phonation, f0I }` for the workday record, or null when no frame was measured. */
    toJSON() {
      if (phonated.length === 0) return null;
      return {
        phonation: phonated.map((p) => Math.min(1, Math.round(p * PHONATION_DECIMALS) / PHONATION_DECIMALS)),
        f0I: phonated.map((p, k) => (p > 0 ? Number((weighted[k] / p).toPrecision(F0I_DIGITS)) : 0)),
      };
    },
  };
}

/** Throws RangeError unless `s` is a well-formed per-second series. */
export function validateSecondSeries(s) {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new RangeError('perSecond must be an object');
  const unknown = Object.keys(s).find((k) => k !== 'phonation' && k !== 'f0I');
  if (unknown) throw new RangeError(`unknown field perSecond.${unknown}`);
  const { phonation, f0I } = s;
  if (!Array.isArray(phonation) || !Array.isArray(f0I) || phonation.length !== f0I.length) {
    throw new RangeError('perSecond.phonation and perSecond.f0I must be arrays of the same length');
  }
  if (phonation.length > MAX_SERIES_SECONDS) throw new RangeError(`perSecond covers at most ${MAX_SERIES_SECONDS} s`);
  for (let k = 0; k < phonation.length; k++) {
    const p = phonation[k];
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new RangeError(`perSecond.phonation[${k}] must be in 0-1, got ${p}`);
    const v = f0I[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RangeError(`perSecond.f0I[${k}] must be a finite number >= 0, got ${v}`);
  }
}
