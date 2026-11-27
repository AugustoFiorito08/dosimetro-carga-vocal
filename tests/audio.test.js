import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FrameAccumulator, frameSizeFor } from '../src/audio/frame-accumulator.js';
import { MODES, createSessionController } from '../src/audio/session-controller.js';
import { createAudioManager, rawAudioConstraints } from '../src/audio/audio-manager.js';
import { harmonic, whiteNoise } from './helpers/signals.js';

const SR = 16000;
const N = frameSizeFor(SR);

describe('frame size per sample rate', () => {
  it('16 kHz -> 1024, 44.1/48 kHz -> 2048, 96 kHz -> 4096', () => {
    assert.equal(frameSizeFor(16000), 1024);
    assert.equal(frameSizeFor(44100), 2048);
    assert.equal(frameSizeFor(48000), 2048);
    assert.equal(frameSizeFor(96000), 4096);
  });

  it('always holds two periods of 70 Hz', () => {
    for (const sr of [8000, 16000, 22050, 32000, 44100, 48000, 96000]) {
      assert.ok(frameSizeFor(sr) >= 2 * Math.ceil(sr / 70), `${sr}`);
    }
    assert.throws(() => frameSizeFor(0), RangeError);
  });
});

describe('FrameAccumulator', () => {
  const stream = Float32Array.from({ length: 128 * 100 }, (_, i) => i);
  const feed = (acc, blockSize, startAt = 0) => {
    const frames = [];
    for (let off = 0; off < stream.length; off += blockSize) {
      frames.push(...acc.push(stream.subarray(off, off + blockSize), startAt + off));
    }
    return frames;
  };

  it('packs 128-sample quanta into exact, contiguous, non-overlapping frames', () => {
    const frames = feed(new FrameAccumulator(2048), 128);
    assert.equal(frames.length, Math.floor(stream.length / 2048));
    frames.forEach((f, k) => {
      assert.equal(f.samples.length, 2048);
      assert.equal(f.sequence, k);
      assert.equal(f.startSample, k * 2048);
      assert.equal(f.samples[0], k * 2048);
      assert.equal(f.samples[2047], k * 2048 + 2047);
      assert.equal(f.discontinuity, false);
    });
  });

  it('handles block sizes that do not divide the frame size', () => {
    const frames = feed(new FrameAccumulator(1024), 300);
    const joined = frames.flatMap((f) => Array.from(f.samples));
    assert.deepEqual(joined, Array.from(stream.subarray(0, joined.length)));
  });

  it('emits a fresh buffer per frame (safe to transfer)', () => {
    const frames = feed(new FrameAccumulator(1024), 128);
    assert.notEqual(frames[0].samples.buffer, frames[1].samples.buffer);
  });

  it('discards the partial frame on a sample gap and flags the next frame', () => {
    const acc = new FrameAccumulator(256);
    acc.push(new Float32Array(128).fill(1), 0);
    const frames = acc.push(new Float32Array(256).fill(2), 1000); // gap: expected 128
    assert.equal(acc.discontinuities, 1);
    assert.equal(frames.length, 1);
    assert.ok(frames[0].samples.every((v) => v === 2), 'no splicing across the gap');
    assert.equal(frames[0].startSample, 1000);
    assert.equal(frames[0].discontinuity, true);
    assert.equal(acc.push(new Float32Array(256), 1256)[0].discontinuity, false);
  });
});

describe('session controller (calibrate -> enrol -> measure)', () => {
  const voice = harmonic(150, SR, N);
  const ambient = whiteNoise(N, 0.0005, 1);
  let sequence = 0;
  const send = (session, samples, count = 1) => {
    for (let i = 0; i < count; i++) session.handleMessage({ type: 'frame', samples, sequence: sequence++ });
  };
  const framesFor = (seconds) => Math.ceil((seconds * SR) / N);

  it('runs the full §16 flow and attributes the enrolled voice', async () => {
    const session = createSessionController({ sampleRate: SR });
    const calibrated = session.calibrate();
    assert.equal(session.mode, MODES.CALIBRATING);
    send(session, ambient, framesFor(5));
    const floor = await calibrated;
    assert.ok(Math.abs(floor - 0.0005 / Math.sqrt(3)) < 1e-4, `floor=${floor}`);
    assert.equal(session.mode, MODES.IDLE);

    const enrolled = session.enroll();
    send(session, voice, framesFor(15));
    const profile = await enrolled;
    assert.ok(profile.prototypes.length >= 1 && profile.prototypes.length <= 8);
    assert.throws(() => session.start(), (e) => e.code === 'voice_reference_required');
    const reference = session.captureVoiceReference();
    send(session, voice, framesFor(30));
    await reference;

    session.start();
    send(session, voice, 10);
    send(session, ambient, 5);
    send(session, whiteNoise(N, 0.3, 9), 5);
    const { load, latest } = session;
    assert.equal(load.metrics.episodes.count, 1);
    assert.ok(Math.abs(load.metrics.phonationTime - (10 * N) / SR) < 1e-9);
    assert.ok(load.doses.none > 0 && load.h > 0);
    assert.equal(latest.analysis.category, 'ruido_descartado');
    assert.ok(load.metrics.timeByCategory.silence > 0);
  });

  it('rejects an enrolment without enough valid voice', async () => {
    const session = createSessionController({ sampleRate: SR, config: { enrollMaxWallSeconds: 12 } });
    const c = session.calibrate();
    send(session, ambient, framesFor(5));
    await c;
    const e = session.enroll();
    send(session, voice, framesFor(5));
    send(session, ambient, framesFor(8));
    await assert.rejects(e, /valid voice/);
    assert.equal(session.profile, null);
    assert.equal(session.mode, MODES.IDLE);
  });

  it('enforces the order calibrate -> enrol -> start', async () => {
    const session = createSessionController({ sampleRate: SR });
    await assert.rejects(session.enroll(), /calibrate/);
    assert.throws(() => session.start(), /enrol/);
    session.calibrate();
    assert.throws(() => session.calibrate(), /while calibrating/);
  });

  it('stop cancels a running calibration', async () => {
    const session = createSessionController({ sampleRate: SR });
    const c = session.calibrate();
    send(session, ambient, 3);
    session.stop();
    await assert.rejects(c, /cancelled/);
    assert.equal(session.noiseFloorRms, null);
  });

  it('counts received/processed frames, sequence drops and worklet discontinuities', () => {
    const session = createSessionController({ sampleRate: SR });
    const samples = new Float32Array(N);
    session.handleMessage({ type: 'frame', samples, sequence: 0 });
    session.calibrate();
    session.handleMessage({ type: 'frame', samples, sequence: 1 });
    session.handleMessage({ type: 'frame', samples, sequence: 4, discontinuities: 2 });
    session.handleMessage({ type: 'ready' });
    const { stats } = session;
    assert.equal(stats.framesReceived, 3);
    assert.equal(stats.framesProcessed, 2, 'idle frames are not processed');
    assert.equal(stats.droppedFrames, 2);
    assert.equal(stats.discontinuities, 2);
  });
});

describe('audio manager (with injected browser fakes)', () => {
  function fakeEnvironment({ sampleRate = 48000 } = {}) {
    const calls = { constraints: [], modules: [], nodes: [], connections: [] };
    const track = { label: 'USB Headset', stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }) };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    const connectable = (name) => ({
      name,
      connect(target) { calls.connections.push(`${name}->${target.name}`); return target; },
      disconnect() {},
    });
    class FakeContext {
      constructor() { this.sampleRate = sampleRate; this.state = 'running'; this.destination = { name: 'destination' }; }
      audioWorklet = { addModule: async (url) => calls.modules.push(String(url)) };
      createMediaStreamSource() { return connectable('source'); }
      createGain() { return { ...connectable('sink'), gain: { value: 1 } }; }
      async close() { this.state = 'closed'; }
      async resume() {}
    }
    class FakeWorkletNode {
      constructor(context, name, options) {
        Object.assign(this, connectable('worklet'));
        this.port = { posted: [], postMessage(m) { this.posted.push(m); }, onmessage: null };
        calls.nodes.push({ name, options, node: this });
      }
    }
    const mediaDevices = {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'a', label: '', groupId: 'g' },
        { kind: 'audiooutput', deviceId: 'o', label: 'Speakers', groupId: 'g' },
        { kind: 'audioinput', deviceId: 'b', label: 'Lavalier', groupId: 'h' },
      ],
      getUserMedia: async (c) => { calls.constraints.push(c); return stream; },
    };
    return { calls, track, env: { mediaDevices, AudioContextClass: FakeContext, AudioWorkletNodeClass: FakeWorkletNode } };
  }

  it('requests raw capture with all browser processing disabled', () => {
    const { audio } = rawAudioConstraints('mic-1');
    assert.deepEqual(audio, {
      deviceId: { exact: 'mic-1' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    });
    assert.equal('deviceId' in rawAudioConstraints().audio, false);
  });

  it('lists only audio inputs, with fallback labels', async () => {
    const { env } = fakeEnvironment();
    const devices = await createAudioManager(env).listInputDevices();
    assert.deepEqual(devices.map((d) => [d.deviceId, d.label]), [['a', 'Microphone 1'], ['b', 'Lavalier']]);
  });

  it('opens the selected device, loads the worklet and routes frames to the session', async () => {
    const { env, calls, track } = fakeEnvironment();
    const manager = createAudioManager(env);
    const info = await manager.open({ deviceId: 'b' });
    assert.equal(calls.constraints[0].audio.deviceId.exact, 'b');
    assert.match(calls.modules[0], /vocal-processor\.worklet\.js$/);
    assert.equal(info.sampleRate, 48000);
    assert.equal(info.frameSize, 2048);
    assert.equal(calls.nodes[0].name, 'vocal-processor');
    assert.equal(calls.nodes[0].options.processorOptions.frameSize, 2048);
    assert.deepEqual(calls.connections, ['source->worklet', 'worklet->sink', 'sink->destination']);

    calls.nodes[0].node.port.onmessage({ data: { type: 'frame', samples: new Float32Array(2048), sequence: 0 } });
    assert.equal(info.session.stats.framesReceived, 1);

    await manager.close();
    assert.equal(track.stopped, true);
    assert.deepEqual(calls.nodes[0].node.port.posted, [{ type: 'stop' }]);
    assert.equal(manager.session, null);
  });

  it('fails clearly without getUserMedia (insecure context)', async () => {
    const manager = createAudioManager({ mediaDevices: {}, AudioContextClass: class {}, AudioWorkletNodeClass: class {} });
    await assert.rejects(manager.open(), /secure context/);
  });
});

describe('session controller with a DC offset on the input', () => {
  it('calibrates on the noise, not the offset, and still detects voice', async () => {
    const sr = 48000;
    const n = frameSizeFor(sr);
    const offset = (samples) => Float32Array.from(samples, (v) => v + 0.03);
    const ambient = offset(whiteNoise(n, 0.0005, 3));
    const voice = offset(harmonic(150, sr, n, 0.05));
    const frames = (seconds) => Math.ceil((seconds * sr) / n);
    let sequence = 0;
    const send = (session, samples, count) => {
      for (let i = 0; i < count; i++) session.handleMessage({ type: 'frame', samples, sequence: sequence++ });
    };

    const session = createSessionController({ sampleRate: sr });
    const calibrated = session.calibrate();
    send(session, ambient, frames(5));
    const floor = await calibrated;
    assert.ok(floor < 0.001, `floor=${floor} should ignore the 0.03 offset`);

    const enrolled = session.enroll();
    send(session, voice, frames(15));
    await enrolled;
    const reference = session.captureVoiceReference();
    send(session, voice, frames(30));
    await reference;
    session.start();
    send(session, voice, 10);
    assert.equal(session.latest.analysis.category, 'fonacion_atribuida');
  });
});
