// Spec §5/§7 — F0 and periodicity via simplified YIN.

export const DEFAULT_PITCH_CONFIG = Object.freeze({
  minF0: 70, // Hz
  maxF0: 500, // Hz
  threshold: 0.15, // YIN absolute threshold on the CMND function
});

/**
 * Estimates F0 and periodicity of one frame.
 * periodicity = 1 - CMND(tau*) in [0, 1]; isPeriodic when CMND(tau*) < threshold.
 * @param {Float32Array | number[]} samples
 * @param {number} sampleRate Hz
 * @returns {{ f0: number | null, periodicity: number, isPeriodic: boolean }}
 */
export function estimatePitch(samples, sampleRate, config = {}) {
  const { minF0, maxF0, threshold } = { ...DEFAULT_PITCH_CONFIG, ...config };
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  if (!(minF0 > 0 && maxF0 > minF0)) throw new RangeError('require 0 < minF0 < maxF0');

  const tauMin = Math.max(2, Math.floor(sampleRate / maxF0));
  const tauMax = Math.ceil(sampleRate / minF0);
  const window = samples.length - tauMax;
  if (window < tauMax) {
    throw new RangeError(`frame of ${samples.length} samples too short for minF0=${minF0} Hz (need ${2 * tauMax})`);
  }

  // Difference function d(tau) and cumulative mean normalized difference.
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let j = 0; j < window; j++) {
      const diff = samples[j] - samples[j + tau];
      d += diff * diff;
    }
    runningSum += d;
    cmnd[tau] = runningSum === 0 ? 1 : (d * tau) / runningSum;
  }

  let best = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best === -1) {
    best = tauMin;
    for (let tau = tauMin + 1; tau < tauMax; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
  }

  const minimum = cmnd[best];
  const periodicity = Math.min(1, Math.max(0, 1 - minimum));
  const isPeriodic = minimum < threshold;
  return { f0: isPeriodic ? sampleRate / refineLag(cmnd, best) : null, periodicity, isPeriodic };
}

/** Parabolic interpolation around the selected lag for sub-sample accuracy. */
function refineLag(values, tau) {
  if (tau <= 0 || tau >= values.length - 1) return tau;
  const [a, b, c] = [values[tau - 1], values[tau], values[tau + 1]];
  const denom = a - 2 * b + c;
  return denom === 0 ? tau : tau + (a - c) / (2 * denom);
}
