// Primary frame record vd-des-frames/1 (odd/tasks/tramas-primarias.md, T1, S4): what each frame
// keeps, the binary columns, gzip and the base64 parts for the upload.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES } from '../src/dsp/frame-classifier.js';
import {
  BYTES_PER_FRAME, FRAMES_SCHEMA, FRAME_CATEGORIES, MAX_PART_CHARS, createFrameLog, decodeFrames, framesFromParts, framesToParts, validateFramesHeader,
} from '../src/store/frame-record.js';

const DT = 2048 / 48000;
const session = { sampleRate: 48000, frameSize: 2048, pressureScale: { mode: 'own_voice', a0Rms: 0.05 }, referencePressure: 1, units: 'normalized', algorithmVersion: '0.9.0' };
const analysis = (i, over = {}) => ({
  dt: DT, rms: 0.01 + (i % 17) / 1000, f0: i % 5 === 4 ? null : 150 + (i % 40) + 0.04, snrDb: 25 + (i % 9),
  V: i % 5 === 4 ? 0 : 1, W: i % 3 ? 1 : 0, Q: 1, phi: i % 5 !== 4 && i % 3 ? 1 : 0,
  category: i % 5 === 4 ? CATEGORIES.SILENCE : i % 3 ? CATEGORIES.ATTRIBUTED : CATEGORIES.UNATTRIBUTED_VOICE,
  ...over,
});

function fill(n, { pauseAt = null, pauseSeconds = 0 } = {}) {
  const log = createFrameLog(session);
  let t = 0;
  for (let i = 0; i < n; i++) {
    if (i === pauseAt) t += pauseSeconds;
    log.push(analysis(i), t);
    t += DT;
  }
  return log;
}

describe('primary frame record (vd-des-frames/1)', () => {
  it('keeps per frame the level, F0, V, W, Q, Φ, category and SNR, and per session what rebuilds P_k', () => {
    const { header, bytes } = fill(60).encode();
    assert.equal(header.schema, FRAMES_SCHEMA);
    assert.equal(header.frameCount, 60);
    assert.equal(bytes.length, 60 * BYTES_PER_FRAME);
    assert.deepEqual(header.pressureScale, { mode: 'own_voice', a0Rms: 0.05 });
    assert.equal(header.dt, DT);
    const f = decodeFrames(header, bytes);
    for (let i = 0; i < 60; i++) {
      const a = analysis(i);
      assert.ok(Math.abs(f.levelDb[i] - 20 * Math.log10(a.rms)) <= 0.0026, `level ${i}`);
      if (a.f0 === null) assert.equal(f.f0[i], null);
      else assert.ok(Math.abs(f.f0[i] - a.f0) <= 0.05, `f0 ${i}`);
      assert.deepEqual([f.V[i], f.W[i], f.Q[i], f.phi[i]], [a.V, a.W, a.Q, a.phi]);
      assert.equal(f.category[i], a.category);
      assert.equal(f.snrDb[i], Math.round(a.snrDb));
    }
    assert.deepEqual(FRAME_CATEGORIES, Object.values(CATEGORIES));
  });

  it('records the pauses of the session as gaps, so each frame keeps its time', () => {
    const { header, bytes } = fill(40, { pauseAt: 25, pauseSeconds: 12.5 }).encode();
    assert.deepEqual(header.gaps, [[25, 12.5]]);
    const f = decodeFrames(header, bytes);
    assert.ok(Math.abs(f.timestamps[24] - 24 * DT) < 1e-9);
    assert.ok(Math.abs(f.timestamps[25] - (25 * DT + 12.5)) < 1e-9);
  });

  it('a frame without voice, a silent frame or an unknown SNR still encode', () => {
    const log = createFrameLog(session);
    log.push(analysis(0, { rms: 0, f0: Number.NaN, snrDb: Number.NEGATIVE_INFINITY }), 0);
    log.push(analysis(1, { snrDb: 400 }), DT);
    const f = decodeFrames(...Object.values(log.encode()));
    assert.equal(f.levelDb[0], Number.NEGATIVE_INFINITY);
    assert.equal(f.f0[0], null);
    assert.equal(f.snrDb[0], null);
    assert.equal(f.snrDb[1], 127);
  });

  it('is compressed and split in base64 parts under the upload limit, and comes back identical', async () => {
    const log = fill(30000);
    const { header, bytes } = log.encode();
    const parts = await framesToParts(bytes, { maxChars: 400 });
    assert.ok(parts.length > 1);
    for (const p of parts) assert.ok(p.length <= 400 && /^[A-Za-z0-9+/=]+$/.test(p));
    assert.deepEqual(await framesFromParts(parts), bytes);
    assert.ok(MAX_PART_CHARS < 2 * 1024 * 1024);
    assert.ok(header.frameCount === 30000);
  });

  it('validates the header', () => {
    const { header } = fill(10).encode();
    assert.doesNotThrow(() => validateFramesHeader(header));
    assert.throws(() => validateFramesHeader({ ...header, schema: 'x' }), RangeError);
    assert.throws(() => validateFramesHeader({ ...header, frameCount: -1 }), RangeError);
    assert.throws(() => validateFramesHeader({ ...header, pressureScale: { mode: 'own_voice' } }), RangeError);
    assert.throws(() => validateFramesHeader({ ...header, gaps: [[3]] }), RangeError);
    assert.throws(() => validateFramesHeader({ ...header, microphone: 'AirPods de Ana' }), RangeError, 'no device label');
    assert.throws(() => decodeFrames(header, new Uint8Array(5)), RangeError, 'bytes must match the frame count');
  });

  it('an empty log encodes nothing', () => {
    assert.equal(createFrameLog(session).encode(), null);
  });
});
