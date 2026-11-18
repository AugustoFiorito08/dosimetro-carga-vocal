// Vocal-load engine: pure, DOM- and Web Audio-independent.
// Combines spec §6.3 (acceptance), §8 (metrics), §9 (H_k), §10 (I_k), §11 (doses).
import { acceptedPhonation } from './math/acceptance.js';
import { conventionalDoseIncrements, createConventionalDoses } from './math/conventional-doses.js';
import { acousticLoadUnits, normalizedAcousticLoad } from './math/acoustic-load.js';
import { DOSE_MODELS, doseIncrements, resolveModelParams } from './math/dose-models.js';
import { distanceDoseIncrement, resolveDistanceDoseOptions, splAtMicrophone } from './math/distance-dose.js';
import { halfLife, timeConstant, updateLoadState } from './math/load-state.js';
import { createUsageMetrics, updateUsageMetrics } from './math/usage-metrics.js';
import { assertFiniteNonNegative, assertFinitePositive } from './math/validation.js';

export * from './math/acceptance.js';
export * from './math/acoustic-load.js';
export * from './math/conventional-doses.js';
export * from './math/dose-models.js';
export * from './math/distance-dose.js';
export * from './math/load-state.js';
export * from './math/usage-metrics.js';

/**
 * @param {object} [options]
 * @param {object} [options.params] dose-model parameter overrides (see DEFAULT_MODEL_PARAMS)
 * @param {number} [options.referencePressure=1] P_0
 * @param {boolean} [options.calibrated=false] whether P_k is calibrated pressure (Pa)
 * @param {object} [options.distanceDose] distance-dose options (see resolveDistanceDoseOptions); needs calibration
 */
export function createVocalLoadState({ params, referencePressure = 1, calibrated = false, distanceDose } = {}) {
  assertFinitePositive('P_0', referencePressure);
  const resolved = resolveModelParams(params);
  if (distanceDose !== undefined && distanceDose !== null && calibrated !== true) {
    throw new RangeError('the distance dose needs a calibrated session (SPL in dB)');
  }
  const distanceDoseOptions = distanceDose ? resolveDistanceDoseOptions(distanceDose) : null;
  return {
    params: resolved,
    referencePressure,
    units: acousticLoadUnits(calibrated),
    tau: timeConstant(resolved.beta),
    halfLife: halfLife(resolved.beta),
    frameIndex: 0,
    h: 0,
    doses: Object.fromEntries(DOSE_MODELS.map((m) => [m, 0])),
    conventionalDoses: createConventionalDoses(),
    distanceDoseOptions,
    distanceDose: distanceDoseOptions ? 0 : null,
    metrics: createUsageMetrics(),
  };
}

/**
 * Advances the engine by one frame and returns a new state (input untouched).
 * @param {ReturnType<typeof createVocalLoadState>} state
 * @param {object} frame
 * @param {number} frame.dt Delta_t in seconds
 * @param {boolean} frame.voiced V_k
 * @param {boolean} frame.identityMatch W_k
 * @param {boolean} frame.qualityOk Q_k
 * @param {number} [frame.f0] F0_k in Hz (required only when Phi_k = 1)
 * @param {number} [frame.pressure] P_k (required only when Phi_k = 1)
 * @param {string} [frame.category] non-phonation category (see FRAME_CATEGORIES)
 */
export function stepVocalLoad(state, frame) {
  const { dt } = frame;
  assertFiniteNonNegative('Delta_t', dt);
  const phi = acceptedPhonation(frame.voiced, frame.identityMatch, frame.qualityOk);
  const h = updateLoadState(state.h, phi, dt, state.params.beta);
  const intensity = phi === 1 ? normalizedAcousticLoad(frame.pressure, state.referencePressure) : 0;
  const increments = doseIncrements({ f0: frame.f0, intensity, phi, h, dt }, state.params);
  const doses = Object.fromEntries(DOSE_MODELS.map((m) => [m, state.doses[m] + increments[m]]));
  const conventional = conventionalDoseIncrements({ f0: frame.f0, phi, dt });
  const conventionalDoses = {
    time: state.conventionalDoses.time + conventional.time,
    cycle: state.conventionalDoses.cycle + conventional.cycle,
  };
  const distanceDose =
    state.distanceDoseOptions === null
      ? null
      : state.distanceDose +
        distanceDoseIncrement(
          { f0: frame.f0, splMic: phi === 1 ? splAtMicrophone(frame.pressure) : -Infinity, phi, dt },
          state.distanceDoseOptions,
        );
  return {
    ...state,
    frameIndex: state.frameIndex + 1,
    h,
    doses,
    conventionalDoses,
    distanceDose,
    metrics: updateUsageMetrics(state.metrics, { phi, dt, category: frame.category }),
    lastFrame: { phi, intensity, increments },
  };
}
