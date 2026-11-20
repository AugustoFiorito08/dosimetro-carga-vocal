// In-memory PRE/POST assessment takes (spec §23).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MODES, createSessionController } from '../src/audio/session-controller.js';
import { harmonic } from './helpers/signals.js';

const SR = 16000;
const N = 640;

function feeder(session) {
  let sample = 0;
  return (samples, count = 1) => {
    for (let i = 0; i < count; i++) {
      session.handleMessage({ type: 'frame', samples, sequence: sample / N, startSample: sample });
      sample += N;
    }
  };
}

describe('session: assessment recording', () => {
  it('returns lead-in plus task samples and goes back to idle', async () => {
    const session = createSessionController({ sampleRate: SR });
    const send = feeder(session);
    const progress = [];
    session.subscribe((e) => e.type === 'progress' && progress.push(e));
    const take = session.recordSample({ seconds: 2, leadInSeconds: 1 });
    assert.equal(session.mode, MODES.RECORDING);
    send(harmonic(200, SR, N), Math.ceil((3 * SR) / N));
    const samples = await take;
    assert.equal(samples.length, 3 * SR);
    assert.ok(samples.some((v) => v !== 0));
    assert.equal(session.mode, MODES.IDLE);
    assert.equal(progress.at(-1).leadInSeconds, 1);
    assert.equal(progress.at(-1).target, 3);
  });

  it('is refused while measuring and rejected with bad durations', async () => {
    const session = createSessionController({ sampleRate: SR });
    await assert.rejects(session.recordSample({ seconds: 0 }), RangeError);
    session.recordSample({ seconds: 1 }).catch(() => {});
    assert.throws(() => session.recordSample({ seconds: 1 }), /cannot start recording while recording/);
  });

  it('a cancelled take is zeroed and rejected', async () => {
    const session = createSessionController({ sampleRate: SR });
    const send = feeder(session);
    let captured = null;
    const original = Float32Array.prototype.fill;
    const take = session.recordSample({ seconds: 5 });
    send(harmonic(200, SR, N), 10);
    Float32Array.prototype.fill = function fill(...args) {
      captured = this;
      return original.apply(this, args);
    };
    try {
      session.stop();
      await assert.rejects(take, /recording cancelled/);
    } finally {
      Float32Array.prototype.fill = original;
    }
    assert.ok(captured && captured.length === 6 * SR && captured.every((v) => v === 0));
    assert.equal(session.mode, MODES.IDLE);
  });
});
