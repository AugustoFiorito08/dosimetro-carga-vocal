import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MODES, createSessionController } from '../src/audio/session-controller.js';
import { frameSizeFor } from '../src/audio/frame-accumulator.js';
import { CSV_COLUMNS } from '../src/export/csv-exporter.js';
import { PROVISIONAL_ZONES, axisTop, steadyStateLoad, zoneFor } from '../src/ui/load-chart.js';
import { harmonic, whiteNoise } from './helpers/signals.js';

const SR = 16000;
const N = frameSizeFor(SR);
const voice = harmonic(150, SR, N);
const ambient = whiteNoise(N, 0.0005, 1);
const framesFor = (seconds) => Math.ceil((seconds * SR) / N);

async function readySession(options) {
  const session = createSessionController({ sampleRate: SR, ...options });
  let sample = 0;
  const send = (samples, count = 1) => {
    for (let i = 0; i < count; i++) {
      session.handleMessage({ type: 'frame', samples, sequence: sample / N, startSample: sample });
      sample += N;
    }
  };
  const c = session.calibrate();
  send(ambient, framesFor(5));
  await c;
  const e = session.enroll();
  send(voice, framesFor(15));
  await e;
  return { session, send };
}

describe('pause / resume / finish', () => {
  it('pause ignores frames, resume continues, finish keeps the records', async () => {
    const { session, send } = await readySession();
    assert.equal(session.exportCsv(), null);
    session.start();
    send(voice, 5);
    session.pause();
    assert.equal(session.mode, MODES.PAUSED);
    const hPaused = session.load.h;
    send(voice, 10);
    assert.equal(session.load.h, hPaused, 'H is frozen while paused');
    assert.equal(session.recordCount, 5);
    session.resume();
    send(ambient, 3);
    assert.equal(session.recordCount, 8);
    session.stop();
    assert.equal(session.mode, MODES.IDLE);
    assert.equal(session.recordCount, 8, 'records survive finishing');
  });

  it('rejects pause/resume in the wrong mode', async () => {
    const { session } = await readySession();
    assert.throws(() => session.pause(), /cannot pause/);
    assert.throws(() => session.resume(), /cannot resume/);
  });
});

describe('session CSV', () => {
  it('exports one 21-column row per measured frame with audio-clock timestamps', async () => {
    const { session, send } = await readySession();
    session.start();
    send(voice, 2);
    session.pause();
    send(voice, 3); // 3 frames of paused audio -> gap in timestamps
    session.resume();
    send(ambient, 1);
    session.stop();

    const lines = session.exportCsv().trimEnd().split('\r\n');
    assert.equal(lines[0], CSV_COLUMNS.join(','));
    assert.equal(lines.length, 4);
    const rows = lines.slice(1).map((l) => l.split(','));
    assert.ok(rows.every((r) => r.length === 21), 'parameters column has no commas');
    const dt = N / SR;
    assert.deepEqual(rows.map((r) => Number(r[0])), [0, dt, 5 * dt]);
    assert.deepEqual(rows.map((r) => r[11]), ['fonacion_atribuida', 'fonacion_atribuida', 'silencio']);
    assert.equal(rows[0][19], '0.3');
    assert.match(rows[0][20], /^sampleRate=16000;beta=.*acceptThreshold=0\.85;rejectThreshold=0\.75;/);
  });

  it('a new start clears the previous session records', async () => {
    const { session, send } = await readySession();
    session.start();
    send(voice, 4);
    session.stop();
    session.start();
    send(voice, 1);
    assert.equal(session.recordCount, 1);
  });

  it('similarity threshold is applied at start and recorded in parameters', async () => {
    const { session, send } = await readySession();
    session.setSimilarityThreshold(0.9);
    session.start();
    send(voice, 1);
    const row = session.exportCsv().split('\r\n')[1];
    assert.match(row, /acceptThreshold=0\.9;rejectThreshold=0\.8;/);
    assert.throws(() => session.setSimilarityThreshold(0), RangeError);
    assert.throws(() => session.setSimilarityThreshold(1.5), RangeError);
  });
});

describe('provisional load zones', () => {
  it('splits H_inf = 1/beta in thirds', () => {
    assert.equal(steadyStateLoad(0.01), 100);
    assert.equal(steadyStateLoad(0), Infinity);
    assert.equal(zoneFor(10, 0.01).id, 'low');
    assert.equal(zoneFor(50, 0.01).id, 'moderate');
    assert.equal(zoneFor(80, 0.01).id, 'high');
    assert.equal(zoneFor(1000, 0.01).id, 'high');
    assert.deepEqual(PROVISIONAL_ZONES.map((z) => z.id), ['low', 'moderate', 'high']);
  });

  it('axis top has a minimum, headroom, and is capped at H_inf', () => {
    assert.equal(axisTop(0, 0.01), 10);
    assert.ok(Math.abs(axisTop(20, 0.01) - 23) < 1e-12);
    assert.equal(axisTop(99, 0.01), 100);
  });
});
