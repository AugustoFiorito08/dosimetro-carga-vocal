import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHighPassFilter } from '../src/dsp/high-pass.js';
import { frameRms } from '../src/dsp/signal-quality.js';
import { sine } from './helpers/signals.js';

const SR = 48000;
const N = 2048;
const shift = (samples, offset) => Float32Array.from(samples, (v) => v + offset);
const tail = (samples) => samples.subarray(samples.length >> 1);

describe('high-pass filter (DC / rumble removal)', () => {
  it('removes a DC offset', () => {
    const filter = createHighPassFilter(SR);
    const input = new Float32Array(N).fill(0.03);
    let out;
    for (let i = 0; i < 20; i++) out = filter.process(input);
    assert.ok(frameRms(out) < 1e-4, `residual=${frameRms(out)}`);
  });

  it('passes voice frequencies with less than 1 dB loss', () => {
    const filter = createHighPassFilter(SR);
    const input = sine(150, SR, SR);
    const out = filter.process(input);
    const lossDb = 20 * Math.log10(frameRms(tail(out)) / frameRms(tail(input)));
    assert.ok(lossDb > -1, `loss=${lossDb.toFixed(2)} dB`);
  });

  it('keeps its state across frames and does not mutate the input', () => {
    const input = shift(sine(150, SR, 2 * N), 0.02);
    const copy = Float32Array.from(input);
    const whole = createHighPassFilter(SR).process(input);
    const split = createHighPassFilter(SR);
    const joined = [...split.process(input.subarray(0, N)), ...split.process(input.subarray(N))];
    assert.deepEqual(input, copy);
    joined.forEach((v, i) => assert.ok(Math.abs(v - whole[i]) < 1e-6, `sample ${i}`));
  });
});
