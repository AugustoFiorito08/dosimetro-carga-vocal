// Spec §6.3/§7 — per-frame decision: V_k, W_k, Q_k, Phi_k, category and rejection reason.
import { DEFAULT_PITCH_CONFIG, estimatePitch } from './pitch.js';
import { extractSpectralFeatures } from './spectral.js';
import {
  DEFAULT_QUALITY_CONFIG,
  assessQuality,
  crestFactor,
  frameRms,
  snrDb,
  toDb,
  updateNoiseFloor,
} from './signal-quality.js';
import { DEFAULT_IDENTITY_CONFIG, createIdentityState, speakerScore, updateIdentity } from './speaker-profile.js';

/** The five mutually exclusive categories of spec §7. */
export const CATEGORIES = Object.freeze({
  ATTRIBUTED: 'fonacion_atribuida',
  UNATTRIBUTED_VOICE: 'voz_no_atribuida',
  NOISE: 'ruido_descartado',
  SILENCE: 'silencio',
  UNCERTAIN: 'senal_incierta',
});

/** Mapping onto the category names used by the vocal-load engine (src/vocal-load.js). */
export const ENGINE_CATEGORY = Object.freeze({
  [CATEGORIES.ATTRIBUTED]: 'attributed',
  [CATEGORIES.UNATTRIBUTED_VOICE]: 'unattributed_voice',
  [CATEGORIES.NOISE]: 'noise',
  [CATEGORIES.SILENCE]: 'silence',
  [CATEGORIES.UNCERTAIN]: 'uncertain',
});

export const DEFAULT_CLASSIFIER_CONFIG = Object.freeze({
  pitch: DEFAULT_PITCH_CONFIG,
  quality: DEFAULT_QUALITY_CONFIG,
  identity: DEFAULT_IDENTITY_CONFIG,
  noisePeriodicityMax: 0.5, // non-periodic frames under this are noise, above it uncertain
  minVocalBandRatio: 0.6, // share of power inside the vocal band required for V_k
  initialNoiseFloorRms: 1e-3, // replace with calibrateNoiseFloor() output when available
  pressureScale: 1, // Pa per digital unit when calibrated; 1 = relative magnitude
});

function resolveConfig(config = {}) {
  return {
    ...DEFAULT_CLASSIFIER_CONFIG,
    ...config,
    pitch: { ...DEFAULT_PITCH_CONFIG, ...config.pitch },
    quality: { ...DEFAULT_QUALITY_CONFIG, ...config.quality },
    identity: { ...DEFAULT_IDENTITY_CONFIG, ...config.identity },
  };
}

/**
 * Pure decision table. Order defines exclusivity:
 * silence (gate) -> impulsive noise -> aperiodic / out-of-band noise ->
 * uncertain (weak periodicity, low SNR) -> unattributed voice -> attributed.
 * @returns {{ category: string, reason: string | null }}
 */
export function decideCategory({ V, W, Q, qualityReason, periodicity, inVocalBand, hasProfile }, config = {}) {
  const { noisePeriodicityMax } = { ...DEFAULT_CLASSIFIER_CONFIG, ...config };
  if (qualityReason === 'below_gate') return { category: CATEGORIES.SILENCE, reason: 'below_gate' };
  if (qualityReason === 'impulsive') return { category: CATEGORIES.NOISE, reason: 'impulsive' };
  if (V === 0) {
    if (!inVocalBand) return { category: CATEGORIES.NOISE, reason: 'out_of_band' };
    if (periodicity < noisePeriodicityMax) return { category: CATEGORIES.NOISE, reason: 'aperiodic' };
    return { category: CATEGORIES.UNCERTAIN, reason: 'weak_periodicity' };
  }
  if (Q === 0) return { category: CATEGORIES.UNCERTAIN, reason: qualityReason ?? 'low_quality' };
  if (W === 0) return { category: CATEGORIES.UNATTRIBUTED_VOICE, reason: hasProfile ? 'speaker_mismatch' : 'no_profile' };
  return { category: CATEGORIES.ATTRIBUTED, reason: null };
}

/**
 * @param {{ profile?: object | null, config?: object, noiseFloorRms?: number }} [options]
 */
export function createFrameClassifier({ profile = null, config, noiseFloorRms } = {}) {
  const resolved = resolveConfig(config);
  return {
    config: resolved,
    profile,
    noiseFloorRms: noiseFloorRms ?? resolved.initialNoiseFloorRms,
    identity: createIdentityState(),
    time: 0,
  };
}

/**
 * Classifies one audio frame. Pure: returns the next classifier state, the
 * full analysis (for CSV export, spec §13) and a frame ready for
 * stepVocalLoad(state, frame).
 * @param {ReturnType<typeof createFrameClassifier>} state
 * @param {Float32Array} samples
 * @param {number} sampleRate Hz
 */
export function classifyFrame(state, samples, sampleRate) {
  const { config, profile } = state;
  const dt = samples.length / sampleRate;
  const rms = frameRms(samples);
  const crest = crestFactor(samples);
  const snr = snrDb(rms, state.noiseFloorRms);
  const quality = assessQuality({ rms, crest, snr }, config.quality);
  const pitch = estimatePitch(samples, sampleRate, config.pitch);
  const spectral = extractSpectralFeatures(samples, sampleRate);

  const inVocalBand = spectral.vocalBandRatio >= config.minVocalBandRatio;
  const V = pitch.isPeriodic && inVocalBand && quality.reason !== 'below_gate' ? 1 : 0;
  const Q = quality.Q;
  const score = V === 1 && Q === 1 && profile ? speakerScore(profile, spectral.vector) : null;
  const identity = updateIdentity(state.identity, score, dt, config.identity);
  const W = score === null ? 0 : identity.W;
  const phi = V * W * Q;
  const { category, reason } = decideCategory(
    { V, W, Q, qualityReason: quality.reason, periodicity: pitch.periodicity, inVocalBand, hasProfile: profile !== null },
    config,
  );

  const analysis = {
    timestamp: state.time,
    dt,
    f0: pitch.f0,
    periodicity: pitch.periodicity,
    rms,
    pressure: rms * config.pressureScale, // Pa when the session is calibrated, relative magnitude otherwise
    levelDb: toDb(rms),
    noiseFloorRms: state.noiseFloorRms,
    snrDb: snr,
    crestFactor: crest,
    vocalBandRatio: spectral.vocalBandRatio,
    centroidHz: spectral.centroidHz,
    features: spectral.vector,
    speakerScore: score,
    smoothedScore: identity.smoothedScore,
    V,
    W,
    Q,
    phi,
    category,
    rejectionReason: phi === 1 ? null : reason,
  };

  return {
    state: {
      ...state,
      noiseFloorRms: updateNoiseFloor(state.noiseFloorRms, rms, { dt, voicePresent: V === 1 }, config.quality),
      identity,
      time: state.time + dt,
    },
    analysis,
    frame: toVocalLoadFrame(analysis, config.pressureScale),
  };
}

/** Builds the input expected by stepVocalLoad() from an analysis record. */
export function toVocalLoadFrame(analysis, pressureScale = 1) {
  return {
    dt: analysis.dt,
    voiced: analysis.V === 1,
    identityMatch: analysis.W === 1,
    qualityOk: analysis.Q === 1,
    f0: analysis.f0 ?? undefined,
    pressure: analysis.pressure ?? analysis.rms * pressureScale,
    category: ENGINE_CATEGORY[analysis.category],
  };
}
