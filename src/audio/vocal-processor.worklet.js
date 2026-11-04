// AudioWorkletProcessor: packs mono input into DSP frames and posts them to the main thread.
// Runs in AudioWorkletGlobalScope (`sampleRate`, `currentFrame`, `registerProcessor` are globals).
import { FrameAccumulator, frameSizeFor } from './frame-accumulator.js';

class VocalProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameSize = options?.processorOptions?.frameSize ?? frameSizeFor(sampleRate);
    this.accumulator = new FrameAccumulator(frameSize);
    this.running = true;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'stop') this.running = false;
    };
    this.port.postMessage({ type: 'ready', sampleRate, frameSize });
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input connected yet (or source ended): keep the node alive, nothing to pack.
    if (channel && channel.length > 0) {
      for (const frame of this.accumulator.push(channel, currentFrame)) {
        this.port.postMessage(
          {
            type: 'frame',
            samples: frame.samples,
            sequence: frame.sequence,
            startSample: frame.startSample,
            discontinuity: frame.discontinuity,
            discontinuities: this.accumulator.discontinuities,
          },
          [frame.samples.buffer],
        );
      }
    }
    return this.running;
  }
}

registerProcessor('vocal-processor', VocalProcessor);
