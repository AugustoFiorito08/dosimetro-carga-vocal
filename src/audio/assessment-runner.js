// Analyse-and-discard boundary of the PRE/POST assessment (spec §23). With Web Workers
// the take is transferred (the page's copy is detached) and analysed off the main thread;
// without them it is analysed inline. Either way the samples are zeroed afterwards and
// only the measures are returned.
import { analyseVoiceSample } from '../dsp/voice-assessment.js';

const WORKER_URL = new URL('./assessment.worker.js', import.meta.url);

/**
 * @param {Float32Array} samples consumed: detached or zeroed when the promise settles
 * @param {number} sampleRate
 * @param {{ task: string, pressureScale?: number | null }} options
 * @param {{ WorkerClass?: typeof Worker | null }} [env]
 */
export function analyseAndDiscard(samples, sampleRate, options, { WorkerClass = globalThis.Worker ?? null } = {}) {
  if (!WorkerClass) {
    try {
      return Promise.resolve(analyseVoiceSample(samples, sampleRate, options));
    } catch (error) {
      return Promise.reject(error);
    } finally {
      samples.fill(0);
    }
  }
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new WorkerClass(WORKER_URL, { type: 'module' });
    } catch (error) {
      samples.fill(0);
      reject(error);
      return;
    }
    const done = (fn, value) => {
      worker.terminate();
      fn(value);
    };
    worker.onmessage = ({ data }) => (data.error ? done(reject, new Error(data.error)) : done(resolve, data.result));
    worker.onerror = (event) => {
      event.preventDefault?.();
      done(reject, new Error(event.message || 'assessment worker failed'));
    };
    try {
      worker.postMessage({ samples, sampleRate, options }, [samples.buffer]);
    } catch (error) {
      if (samples.length) samples.fill(0); // not transferred: zero the page copy
      done(reject, error);
    }
  });
}
