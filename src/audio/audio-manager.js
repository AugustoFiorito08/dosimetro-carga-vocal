// Web Audio boundary (spec §4-§5): device selection, raw capture, AudioWorklet wiring.
// All browser APIs are injected (defaults: globals) so the rest of the app stays pure.
import { frameSizeFor } from './frame-accumulator.js';
import { createSessionController } from './session-controller.js';

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

/**
 * @param {{ mediaDevices?: MediaDevices, AudioContextClass?: typeof AudioContext, AudioWorkletNodeClass?: typeof AudioWorkletNode }} [env]
 */
export function createAudioManager({
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextClass = globalThis.AudioContext,
  AudioWorkletNodeClass = globalThis.AudioWorkletNode,
} = {}) {
  let context = null;
  let stream = null;
  let source = null;
  let node = null;
  let sink = null;
  let session = null;

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
    const [track] = stream.getAudioTracks();
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

    return { sampleRate: context.sampleRate, frameSize, trackSettings, session, deviceLabel: track?.label ?? '' };
  }

  async function close() {
    session?.stop();
    node?.port.postMessage({ type: 'stop' });
    node?.disconnect();
    source?.disconnect();
    sink?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    if (context && context.state !== 'closed') await context.close();
    context = stream = source = node = sink = session = null;
  }

  return {
    listInputDevices,
    requestPermission,
    open,
    close,
    get session() { return session; },
    get context() { return context; },
  };
}
