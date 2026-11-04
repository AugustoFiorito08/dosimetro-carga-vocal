// Pure frame packing shared by the AudioWorklet and Node tests (no Web Audio here).

const CANDIDATE_FRAME_SIZES = [1024, 2048, 4096, 8192];
const MIN_F0 = 70; // Hz, lower bound of the pitch search (src/dsp/pitch.js)

/**
 * Smallest power-of-two frame able to hold two periods of MIN_F0, as YIN needs:
 * 16 kHz -> 1024, 44.1/48 kHz -> 2048, 96 kHz -> 4096.
 */
export function frameSizeFor(sampleRate) {
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate must be > 0, got ${sampleRate}`);
  const required = 2 * Math.ceil(sampleRate / MIN_F0);
  const size = CANDIDATE_FRAME_SIZES.find((n) => n >= required);
  if (size === undefined) throw new RangeError(`unsupported sampleRate ${sampleRate}`);
  return size;
}

/**
 * Packs arbitrary-length blocks (128 samples per render quantum) into
 * contiguous, non-overlapping frames of exactly `frameSize` samples.
 * If a block does not start where the previous one ended (render glitch), the
 * partial frame is discarded instead of splicing across the gap, and the next
 * emitted frame carries `discontinuity: true`.
 */
export class FrameAccumulator {
  constructor(frameSize) {
    if (!Number.isInteger(frameSize) || frameSize < 1) throw new RangeError('frameSize must be a positive integer');
    this.frameSize = frameSize;
    this.buffer = new Float32Array(frameSize);
    this.fill = 0;
    this.sequence = 0;
    this.frameStart = null;
    this.expectedSample = null;
    this.discontinuities = 0;
    this.pendingDiscontinuity = false;
  }

  /**
   * @param {Float32Array} block
   * @param {number} startSample absolute sample index of block[0]
   * @returns {{ samples: Float32Array, sequence: number, startSample: number, discontinuity: boolean }[]}
   */
  push(block, startSample) {
    if (this.expectedSample !== null && startSample !== this.expectedSample) {
      this.discontinuities++;
      this.pendingDiscontinuity = true;
      this.fill = 0;
    }
    this.expectedSample = startSample + block.length;

    const frames = [];
    let offset = 0;
    while (offset < block.length) {
      if (this.fill === 0) this.frameStart = startSample + offset;
      const count = Math.min(this.frameSize - this.fill, block.length - offset);
      this.buffer.set(block.subarray(offset, offset + count), this.fill);
      this.fill += count;
      offset += count;
      if (this.fill === this.frameSize) {
        frames.push({
          samples: this.buffer,
          sequence: this.sequence++,
          startSample: this.frameStart,
          discontinuity: this.pendingDiscontinuity,
        });
        this.pendingDiscontinuity = false;
        this.buffer = new Float32Array(this.frameSize); // emitted buffer is handed off (transferable)
        this.fill = 0;
      }
    }
    return frames;
  }
}
