// Input conditioning: removes DC offset and sub-vocal rumble before any analysis.
// Many built-in microphones/ADCs add a constant offset; left in place it inflates
// RMS (calibrated floor, level, SNR) and pushes power below the vocal band, so
// voiced frames are rejected as out-of-band noise.

export const DEFAULT_HIGH_PASS_HZ = 50; // below the 70 Hz pitch floor, ~1 dB loss at 70 Hz

/**
 * Stateful 2nd-order Butterworth high-pass (RBJ biquad, direct form I).
 * State carries across calls, so consecutive frames are filtered as one stream.
 * @param {number} sampleRate Hz
 * @param {number} [cutoffHz]
 */
export function createHighPassFilter(sampleRate, cutoffHz = DEFAULT_HIGH_PASS_HZ) {
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  if (!(cutoffHz > 0 && cutoffHz < sampleRate / 2)) throw new RangeError(`invalid cutoff ${cutoffHz} Hz`);

  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2); // Q = 1/sqrt(2)
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let primed = false;

  return {
    /** @param {Float32Array} samples @returns {Float32Array} new filtered array (input untouched) */
    process(samples) {
      if (!primed && samples.length > 0) {
        // Start from the steady state of the first sample to avoid a step transient.
        x1 = x2 = samples[0];
        primed = true;
      }
      const out = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = y;
      }
      return out;
    },
    reset() {
      x1 = x2 = y1 = y2 = 0;
      primed = false;
    },
  };
}
