// Web Audio boundary (spec §4-§5): device selection, raw capture, AudioWorklet wiring.
// All browser APIs are injected (defaults: globals) so the rest of the app stays pure.
import { frameSizeFor } from './frame-accumulator.js';
import { createSessionController } from './session-controller.js';
import { interruptSession } from './session-lifecycle.js';
import { createWakeLock } from './wake-lock.js';

const WORKLET_URL = new URL('./vocal-processor.worklet.js', import.meta.url);

/** Raw, unprocessed capture for scientific measurement (spec §4.2). */
export function rawAudioConstraints(deviceId) {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
    video: false,
  };
}

/** AudioContext states that stop the capture ('interrupted' is Safari's). */
const STOPPED_CONTEXT_STATES = new Set(['suspended', 'interrupted', 'closed']);

/**
 * Lifecycle events (onLifecycle):
 * - { type: 'interrupted', reason: 'track_ended' | 'context_suspended' | 'context_interrupted' | 'context_closed',
 *     action: 'paused' | 'cancelled' | 'none', timestamp: number | null, at: number }
 *   timestamp is the session time of the last measured frame (where the gap starts).
 * - { type: 'restored', reason, interruptedMs, at } the context runs again; the session stays paused.
 * - { type: 'hidden', capturing, at } / { type: 'visible', hiddenMs, capturing, at }
 * @param {{ mediaDevices?: MediaDevices, AudioContextClass?: typeof AudioContext, AudioWorkletNodeClass?: typeof AudioWorkletNode,
 *   document?: Document, wakeLock?: WakeLock, now?: () => number }} [env]
 */
export function createAudioManager({
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextClass = globalThis.AudioContext,
  AudioWorkletNodeClass = globalThis.AudioWorkletNode,
  document = globalThis.document,
  wakeLock,
  now = () => Date.now(),
} = {}) {
  let context = null;
  let stream = null;
  let track = null;
  let source = null;
  let node = null;
  let sink = null;
  let session = null;
  let interruption = null; // { reason, at } while capture is stopped by something other than close()
  let hiddenAt = null;
  let detach = null; // removes the lifecycle listeners of the open capture
  const listeners = new Set();
  const screenLock = createWakeLock(wakeLock === undefined ? {} : { wakeLock });

  const emit = (event) => listeners.forEach((fn) => fn(event));
  const capturing = () => context?.state === 'running' && track?.readyState !== 'ended' && interruption?.reason !== 'track_ended';

  function interrupt(reason) {
    if (interruption) return; // one event per interruption, until the context runs again
    interruption = { reason, at: now() };
    const timestamp = session?.latest?.timestamp ?? null;
    const action = interruptSession(session);
    screenLock.release();
    emit({ type: 'interrupted', reason, action, timestamp, at: interruption.at });
  }

  function onTrackEnded() {
    interruption = null; // a lost microphone outranks a suspended context
    interrupt('track_ended');
  }

  function onStateChange() {
    if (STOPPED_CONTEXT_STATES.has(context.state)) {
      interrupt(`context_${context.state}`);
    } else if (context.state === 'running' && interruption && interruption.reason !== 'track_ended') {
      const { reason, at } = interruption;
      interruption = null;
      emit({ type: 'restored', reason, interruptedMs: now() - at, at: now() });
    }
  }

  async function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      hiddenAt = now();
      emit({ type: 'hidden', capturing: capturing(), at: hiddenAt });
      return;
    }
    const hiddenMs = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (interruption) await resumeContext();
    await screenLock.restore();
    emit({ type: 'visible', hiddenMs, capturing: capturing(), at: now() });
  }

  function attachLifecycle() {
    const ctx = context;
    const t = track;
    t?.addEventListener?.('ended', onTrackEnded);
    ctx.addEventListener?.('statechange', onStateChange);
    document?.addEventListener?.('visibilitychange', onVisibilityChange);
    return () => {
      t?.removeEventListener?.('ended', onTrackEnded);
      ctx.removeEventListener?.('statechange', onStateChange);
      document?.removeEventListener?.('visibilitychange', onVisibilityChange);
    };
  }

  /**
   * Resumes a suspended context (not a lost microphone). Browsers may refuse it outside a
   * user gesture. @returns {Promise<boolean>} whether capture is running
   */
  async function resumeContext() {
    if (!context || interruption?.reason === 'track_ended') return false;
    try {
      if (context.state !== 'running') await context.resume();
    } catch {
      /* refused: needs a user gesture */
    }
    return capturing();
  }

  /** Audio inputs. Labels are empty until microphone permission has been granted once. */
  async function listInputDevices() {
    if (!mediaDevices?.enumerateDevices) throw new Error('enumerateDevices is not available in this browser');
    const devices = await mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}`, groupId: d.groupId }));
  }

  /** Asks for permission once so that enumerateDevices exposes real labels. */
  async function requestPermission() {
    const probe = await mediaDevices.getUserMedia(rawAudioConstraints());
    probe.getTracks().forEach((t) => t.stop());
  }

  /**
   * Opens the selected microphone and starts the worklet.
   * @param {{ deviceId?: string, sessionOptions?: object }} [options]
   * @returns {Promise<{ sampleRate: number, frameSize: number, trackSettings: MediaTrackSettings, session: object }>}
   */
  async function open({ deviceId, sessionOptions } = {}) {
    if (context) await close();
    if (!mediaDevices?.getUserMedia) throw new Error('getUserMedia requires a secure context (https or localhost)');
    stream = await mediaDevices.getUserMedia(rawAudioConstraints(deviceId));
    [track] = stream.getAudioTracks();
    const trackSettings = track?.getSettings?.() ?? {};

    context = new AudioContextClass({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule(WORKLET_URL);
    const frameSize = frameSizeFor(context.sampleRate);

    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNodeClass(context, 'vocal-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { frameSize },
    });
    // A muted path to the destination keeps the graph pulled on every browser.
    sink = context.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(context.destination);

    session = createSessionController({ sampleRate: context.sampleRate, ...sessionOptions });
    node.port.onmessage = ({ data }) => session.handleMessage(data);
    if (context.state === 'suspended') await context.resume();
    interruption = null;
    hiddenAt = null;
    detach = attachLifecycle(); // after start-up, so the initial suspended state is not an interruption

    return { sampleRate: context.sampleRate, frameSize, trackSettings, session, deviceLabel: track?.label ?? '' };
  }

  async function close() {
    detach?.();
    detach = null;
    await screenLock.release();
    session?.stop();
    node?.port.postMessage({ type: 'stop' });
    node?.disconnect();
    source?.disconnect();
    sink?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    if (context && context.state !== 'closed') await context.close();
    context = stream = track = source = node = sink = session = interruption = null;
  }

  return {
    listInputDevices,
    requestPermission,
    open,
    close,
    resumeContext,
    /** Keeps the screen on (true) during active capture; degrades silently without the API. */
    keepAwake(on) {
      return on && capturing() ? screenLock.acquire() : screenLock.release().then(() => false);
    },
    onLifecycle(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get screenAwake() { return screenLock.active; },
    get interruption() { return interruption; },
    get session() { return session; },
    get context() { return context; },
  };
}
