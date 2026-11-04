// Session flow (spec §16): calibrate -> enrol -> measure. Browser-free: it consumes
// frame messages, so it runs identically behind the AudioWorklet port or in Node tests.
import { classifyFrame, createFrameClassifier } from '../dsp/frame-classifier.js';
import { calibrateNoiseFloor, frameRms } from '../dsp/signal-quality.js';
import { enrollProfile } from '../dsp/speaker-profile.js';
import { createVocalLoadState, stepVocalLoad } from '../vocal-load.js';

export const MODES = Object.freeze({
  IDLE: 'idle',
  CALIBRATING: 'calibrating',
  ENROLLING: 'enrolling',
  MEASURING: 'measuring',
});

export const DEFAULT_SESSION_CONFIG = Object.freeze({
  calibrationSeconds: 5, // spec §16: at least 5 s of quiet ambient
  enrollTargetSeconds: 15, // spec §6.1: 10-20 s of valid voice
  enrollMinSeconds: 10,
  enrollMaxWallSeconds: 45, // give up if not enough valid voice within this audio time
  maxPrototypes: 8,
});

const now = () => globalThis.performance?.now() ?? Date.now();

/**
 * @param {{ sampleRate: number, config?: object, classifierConfig?: object, loadOptions?: object }} options
 */
export function createSessionController({ sampleRate, config, classifierConfig, loadOptions } = {}) {
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  const cfg = { ...DEFAULT_SESSION_CONFIG, ...config };
  const listeners = new Set();

  let mode = MODES.IDLE;
  let noiseFloorRms = null;
  let profile = null;
  let task = null; // { resolve, reject, onFrame } of the running calibration / enrolment
  let classifier = null;
  let load = null;
  let latest = null;
  const stats = {
    framesReceived: 0,
    framesProcessed: 0,
    droppedFrames: 0, // sequence gaps between worklet and main thread
    discontinuities: 0, // render-quantum gaps reported by the worklet
    overruns: 0, // frames whose processing took longer than their duration
    maxProcessingMs: 0,
    lastSequence: null,
  };

  const emit = (event) => listeners.forEach((fn) => fn(event));

  function beginTask(nextMode, onFrame) {
    if (mode !== MODES.IDLE) throw new Error(`cannot start ${nextMode} while ${mode}`);
    mode = nextMode;
    return new Promise((resolve, reject) => {
      task = {
        onFrame,
        resolve: (value) => { task = null; mode = MODES.IDLE; resolve(value); },
        reject: (error) => { task = null; mode = MODES.IDLE; reject(error); },
      };
    });
  }

  function calibrate() {
    const levels = [];
    let elapsed = 0;
    return beginTask(MODES.CALIBRATING, (samples, dt) => {
      levels.push(frameRms(samples));
      elapsed += dt;
      emit({ type: 'progress', mode, elapsed, target: cfg.calibrationSeconds });
      if (elapsed >= cfg.calibrationSeconds) {
        noiseFloorRms = calibrateNoiseFloor(levels, classifierConfig?.quality);
        profile = null; // a new acoustic baseline invalidates the previous enrolment
        task.resolve(noiseFloorRms);
      }
    });
  }

  function enroll() {
    if (noiseFloorRms === null) return Promise.reject(new Error('calibrate the ambient noise before enrolling'));
    let state = createFrameClassifier({ config: classifierConfig, noiseFloorRms });
    const vectors = [];
    let validTime = 0;
    let elapsed = 0;
    let frameDuration = 0;
    const finish = () => {
      try {
        profile = enrollProfile(vectors, {
          maxPrototypes: cfg.maxPrototypes,
          frameDuration,
          minDuration: cfg.enrollMinSeconds,
        });
        task.resolve(profile);
      } catch (error) {
        task.reject(error);
      }
    };
    return beginTask(MODES.ENROLLING, (samples, dt) => {
      const result = classifyFrame(state, samples, sampleRate);
      state = result.state;
      elapsed += dt;
      frameDuration = dt;
      if (result.analysis.V === 1 && result.analysis.Q === 1) {
        vectors.push(result.analysis.features);
        validTime += dt;
      }
      latest = { analysis: result.analysis, load: null };
      emit({ type: 'progress', mode, elapsed, validTime, target: cfg.enrollTargetSeconds });
      if (validTime >= cfg.enrollTargetSeconds) finish();
      else if (elapsed >= cfg.enrollMaxWallSeconds) {
        if (validTime >= cfg.enrollMinSeconds) finish();
        else task.reject(new Error(`only ${validTime.toFixed(1)} s of valid voice in ${elapsed.toFixed(1)} s; need ${cfg.enrollMinSeconds} s`));
      }
    });
  }

  function start() {
    if (mode !== MODES.IDLE) throw new Error(`cannot start measuring while ${mode}`);
    if (profile === null) throw new Error('enrol the speaker before starting a session');
    classifier = createFrameClassifier({ profile, config: classifierConfig, noiseFloorRms });
    load = createVocalLoadState(loadOptions);
    mode = MODES.MEASURING;
    return load;
  }

  /** Stops measuring or cancels a running calibration / enrolment. */
  function stop() {
    if (task) task.reject(new Error(`${mode} cancelled`));
    mode = MODES.IDLE;
    return load;
  }

  function measure(samples) {
    const result = classifyFrame(classifier, samples, sampleRate);
    classifier = result.state;
    load = stepVocalLoad(load, result.frame);
    latest = { analysis: result.analysis, load };
    emit({ type: 'frame', analysis: result.analysis, load });
  }

  /** Entry point for worklet messages: { type: 'frame', samples, sequence, discontinuities }. */
  function handleMessage(message) {
    if (message?.type !== 'frame') return;
    stats.framesReceived++;
    if (stats.lastSequence !== null && message.sequence > stats.lastSequence + 1) {
      stats.droppedFrames += message.sequence - stats.lastSequence - 1;
    }
    stats.lastSequence = message.sequence;
    stats.discontinuities = message.discontinuities ?? stats.discontinuities;
    if (mode === MODES.IDLE) return;

    const dt = message.samples.length / sampleRate;
    const t0 = now();
    if (mode === MODES.MEASURING) measure(message.samples);
    else task.onFrame(message.samples, dt);
    const elapsedMs = now() - t0;
    stats.framesProcessed++;
    stats.maxProcessingMs = Math.max(stats.maxProcessingMs, elapsedMs);
    if (elapsedMs > dt * 1000) stats.overruns++;
  }

  return {
    handleMessage,
    calibrate,
    enroll,
    start,
    stop,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get mode() { return mode; },
    get noiseFloorRms() { return noiseFloorRms; },
    get profile() { return profile; },
    get load() { return load; },
    get latest() { return latest; },
    get stats() { return { ...stats }; },
    sampleRate,
  };
}
