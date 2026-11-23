import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAudioManager } from '../src/audio/audio-manager.js';
import { frameSizeFor } from '../src/audio/frame-accumulator.js';
import { MODES } from '../src/audio/session-controller.js';
import { hasUnsavedWork, interruptSession } from '../src/audio/session-lifecycle.js';
import { createWakeLock } from '../src/audio/wake-lock.js';
import { harmonic, whiteNoise } from './helpers/signals.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeWakeLockApi({ fail = false } = {}) {
  const sentinels = [];
  return {
    sentinels,
    async request(type) {
      if (fail) throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
      const sentinel = Object.assign(new EventTarget(), {
        type,
        released: false,
        async release() {
          if (this.released) return;
          this.released = true;
          this.dispatchEvent(new Event('release'));
        },
      });
      sentinels.push(sentinel);
      return sentinel;
    },
  };
}

describe('screen wake lock', () => {
  it('acquires a screen lock and releases it', async () => {
    const api = fakeWakeLockApi();
    const lock = createWakeLock({ wakeLock: api });
    assert.equal(lock.supported, true);
    assert.equal(await lock.acquire(), true);
    assert.equal(lock.active, true);
    assert.equal(api.sentinels[0].type, 'screen');
    await lock.release();
    assert.equal(lock.active, false);
    assert.equal(api.sentinels[0].released, true);
  });

  it('degrades silently when the API does not exist', async () => {
    const lock = createWakeLock({ wakeLock: undefined });
    assert.equal(lock.supported, false);
    assert.equal(await lock.acquire(), false);
    await lock.release();
    assert.equal(await lock.restore(), false);
  });

  it('reports a refused request without throwing', async () => {
    const errors = [];
    const lock = createWakeLock({ wakeLock: fakeWakeLockApi({ fail: true }), onError: (e) => errors.push(e.name) });
    assert.equal(await lock.acquire(), false);
    assert.equal(lock.active, false);
    assert.deepEqual(errors, ['NotAllowedError']);
  });

  it('notices a release by the browser and restores it only while wanted', async () => {
    const api = fakeWakeLockApi();
    const lock = createWakeLock({ wakeLock: api });
    await lock.acquire();
    await api.sentinels[0].release(); // the page was hidden
    assert.equal(lock.active, false);
    assert.equal(await lock.restore(), true);
    assert.equal(api.sentinels.length, 2);
    await lock.release();
    assert.equal(await lock.restore(), false);
    assert.equal(api.sentinels.length, 2);
  });

  it('does not keep a lock granted after release() was called', async () => {
    const api = fakeWakeLockApi();
    const lock = createWakeLock({ wakeLock: api });
    const pending = lock.acquire();
    await lock.release();
    assert.equal(await pending, false);
    assert.equal(lock.active, false);
    assert.equal(api.sentinels[0].released, true);
  });

  it('shares one request between concurrent acquisitions', async () => {
    const api = fakeWakeLockApi();
    const lock = createWakeLock({ wakeLock: api });
    await Promise.all([lock.acquire(), lock.acquire()]);
    assert.equal(api.sentinels.length, 1);
  });
});

describe('unsaved work guard', () => {
  const session = (mode, recordCount = 0) => ({ mode, recordCount });

  it('warns during an active or paused session', () => {
    assert.equal(hasUnsavedWork({ session: session(MODES.MEASURING, 5), workdaySaved: false }), true);
    assert.equal(hasUnsavedWork({ session: session(MODES.PAUSED, 5), workdaySaved: true }), true);
  });

  it('warns after a finished session whose workday was not saved', () => {
    assert.equal(hasUnsavedWork({ session: session(MODES.IDLE, 5), workdaySaved: false }), true);
  });

  it('does not warn without a session, without records or once saved', () => {
    assert.equal(hasUnsavedWork({ session: null, workdaySaved: false }), false);
    assert.equal(hasUnsavedWork({ session: session(MODES.IDLE, 0), workdaySaved: false }), false);
    assert.equal(hasUnsavedWork({ session: session(MODES.IDLE, 5), workdaySaved: true }), false);
    assert.equal(hasUnsavedWork({ session: session(MODES.CALIBRATING, 0), workdaySaved: false }), false);
  });
});

describe('interruptSession', () => {
  const fake = (mode) => ({
    mode,
    calls: [],
    pause() { this.calls.push('pause'); this.mode = MODES.PAUSED; },
    stop() { this.calls.push('stop'); this.mode = MODES.IDLE; },
  });

  it('pauses a running measurement, keeping its records', () => {
    const s = fake(MODES.MEASURING);
    assert.equal(interruptSession(s), 'paused');
    assert.deepEqual(s.calls, ['pause']);
  });

  it('cancels a calibration, enrolment or sample take', () => {
    for (const mode of [MODES.CALIBRATING, MODES.ACOUSTIC_CALIBRATING, MODES.ENROLLING, MODES.RECORDING]) {
      const s = fake(mode);
      assert.equal(interruptSession(s), 'cancelled', mode);
      assert.deepEqual(s.calls, ['stop']);
    }
  });

  it('leaves idle or already paused sessions alone', () => {
    for (const mode of [MODES.IDLE, MODES.PAUSED]) {
      const s = fake(mode);
      assert.equal(interruptSession(s), 'none');
      assert.deepEqual(s.calls, []);
    }
    assert.equal(interruptSession(null), 'none');
  });
});

describe('audio manager lifecycle (injected browser fakes)', () => {
  function lifecycleEnvironment({ sampleRate = 16000, resumeWorks = true } = {}) {
    const track = Object.assign(new EventTarget(), {
      label: 'Headset',
      readyState: 'live',
      stop() { this.readyState = 'ended'; }, // stop() does not fire "ended" (Media Capture spec)
      getSettings: () => ({}),
    });
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    const connectable = (name) => ({ name, connect(target) { return target; }, disconnect() {} });
    const contexts = [];
    class FakeContext extends EventTarget {
      constructor() {
        super();
        this.sampleRate = sampleRate;
        this.state = 'running';
        this.destination = { name: 'destination' };
        this.resumeCalls = 0;
        contexts.push(this);
      }
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return connectable('source'); }
      createGain() { return { ...connectable('sink'), gain: { value: 1 } }; }
      setState(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
      async close() { this.setState('closed'); }
      async resume() {
        this.resumeCalls++;
        if (!resumeWorks) throw new Error('needs a user gesture');
        if (this.state !== 'running') this.setState('running');
      }
    }
    const nodes = [];
    class FakeWorkletNode {
      constructor() {
        Object.assign(this, connectable('worklet'));
        this.port = { postMessage() {}, onmessage: null };
        nodes.push(this);
      }
    }
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const setVisibility = (state) => { doc.visibilityState = state; doc.dispatchEvent(new Event('visibilitychange')); };
    let clock = 1000;
    const wakeLock = fakeWakeLockApi();
    const env = {
      mediaDevices: { getUserMedia: async () => stream },
      AudioContextClass: FakeContext,
      AudioWorkletNodeClass: FakeWorkletNode,
      document: doc,
      wakeLock,
      now: () => clock,
    };
    return {
      env, track, contexts, nodes, wakeLock, setVisibility,
      advance: (ms) => { clock += ms; },
    };
  }

  async function openWithEvents(fx) {
    const manager = createAudioManager(fx.env);
    const events = [];
    manager.onLifecycle((e) => events.push(e));
    const info = await manager.open();
    return { manager, events, info };
  }

  /** Drives calibrate -> enrol -> start through the worklet port, then measures some voice. */
  async function measuring(fx, info) {
    const N = frameSizeFor(16000);
    let sequence = 0;
    const send = (samples, count) => {
      for (let i = 0; i < count; i++) fx.nodes[0].port.onmessage({ data: { type: 'frame', samples, sequence: sequence++, startSample: sequence * N } });
    };
    const framesFor = (s) => Math.ceil((s * 16000) / N);
    const cal = info.session.calibrate();
    send(whiteNoise(N, 0.0005, 1), framesFor(5));
    await cal;
    const enrol = info.session.enroll();
    send(harmonic(150, 16000, N), framesFor(15));
    await enrol;
    info.session.start();
    send(harmonic(150, 16000, N), 10);
  }

  it('pauses the measurement and reports track_ended when the microphone goes away', async () => {
    const fx = lifecycleEnvironment();
    const { manager, events, info } = await openWithEvents(fx);
    await measuring(fx, info);
    await manager.keepAwake(true);
    assert.equal(manager.screenAwake, true);

    fx.track.readyState = 'ended';
    fx.track.dispatchEvent(new Event('ended'));
    await flush();

    assert.equal(info.session.mode, MODES.PAUSED);
    assert.ok(info.session.recordCount > 0, 'records are kept for export and save');
    assert.equal(events.length, 1);
    const [e] = events;
    assert.equal(e.type, 'interrupted');
    assert.equal(e.reason, 'track_ended');
    assert.equal(e.action, 'paused');
    assert.ok(e.timestamp > 0, 'gap is placed on the session timeline');
    assert.equal(e.at, 1000);
    assert.equal(manager.screenAwake, false, 'wake lock released on interruption');
    assert.equal(manager.interruption.reason, 'track_ended');
  });

  it('cancels a running calibration when the microphone goes away', async () => {
    const fx = lifecycleEnvironment();
    const { events, info } = await openWithEvents(fx);
    const cal = info.session.calibrate();
    fx.track.dispatchEvent(new Event('ended'));
    await assert.rejects(cal, /cancelled/);
    assert.equal(events[0].action, 'cancelled');
    assert.equal(info.session.mode, MODES.IDLE);
  });

  it('pauses on a suspended or interrupted context and reports the restoration without resuming the session', async () => {
    for (const state of ['suspended', 'interrupted']) {
      const fx = lifecycleEnvironment();
      const { events, info } = await openWithEvents(fx);
      await measuring(fx, info);

      fx.contexts[0].setState(state);
      assert.equal(info.session.mode, MODES.PAUSED, state);
      assert.equal(events[0].reason, `context_${state}`);
      assert.equal(events[0].action, 'paused');

      fx.contexts[0].setState('closed');
      assert.equal(events.length, 1, 'one interruption until the context runs again');

      fx.advance(4000);
      fx.contexts[0].setState('running');
      assert.equal(events[1].type, 'restored');
      assert.equal(events[1].reason, `context_${state}`);
      assert.equal(events[1].interruptedMs, 4000);
      assert.equal(info.session.mode, MODES.PAUSED, 'the user resumes explicitly');
    }
  });

  it('ignores the state changes caused by its own close()', async () => {
    const fx = lifecycleEnvironment();
    const { manager, events } = await openWithEvents(fx);
    await manager.keepAwake(true);
    await manager.close();
    fx.track.dispatchEvent(new Event('ended'));
    fx.setVisibility('hidden');
    assert.deepEqual(events, []);
    assert.equal(manager.screenAwake, false);
  });

  it('keeps measuring while hidden if capture goes on, and restores the wake lock on return', async () => {
    const fx = lifecycleEnvironment();
    const { manager, events, info } = await openWithEvents(fx);
    await measuring(fx, info);
    await manager.keepAwake(true);

    fx.setVisibility('hidden');
    await fx.wakeLock.sentinels[0].release(); // the browser drops the lock on hidden pages
    assert.equal(info.session.mode, MODES.MEASURING);
    assert.deepEqual(events[0], { type: 'hidden', capturing: true, at: 1000 });

    fx.advance(30000);
    fx.setVisibility('visible');
    await flush();
    assert.deepEqual(events[1], { type: 'visible', hiddenMs: 30000, capturing: true, at: 31000 });
    assert.equal(manager.screenAwake, true);
    assert.equal(fx.wakeLock.sentinels.length, 2);
  });

  it('tries to resume a context suspended while hidden when the page comes back', async () => {
    const fx = lifecycleEnvironment();
    const { events, info } = await openWithEvents(fx);
    await measuring(fx, info);

    fx.setVisibility('hidden');
    fx.contexts[0].setState('suspended');
    assert.equal(info.session.mode, MODES.PAUSED);
    fx.setVisibility('visible');
    await flush();

    assert.equal(fx.contexts[0].resumeCalls, 1);
    assert.deepEqual(events.map((e) => e.type), ['hidden', 'interrupted', 'restored', 'visible']);
    assert.equal(events[3].capturing, true);
    assert.equal(info.session.mode, MODES.PAUSED, 'still paused until the user continues');
  });

  it('does not resume the context on return after a track_ended', async () => {
    const fx = lifecycleEnvironment();
    const { manager } = await openWithEvents(fx);
    fx.track.readyState = 'ended';
    fx.track.dispatchEvent(new Event('ended'));
    fx.contexts[0].setState('suspended');
    assert.equal(await manager.resumeContext(), false);
    assert.equal(fx.contexts[0].resumeCalls, 0);
  });

  it('resumeContext reports whether capture is running again', async () => {
    const ok = lifecycleEnvironment();
    const a = await openWithEvents(ok);
    ok.contexts[0].setState('suspended');
    assert.equal(await a.manager.resumeContext(), true);

    const blocked = lifecycleEnvironment({ resumeWorks: false });
    const b = await openWithEvents(blocked);
    blocked.contexts[0].setState('suspended');
    assert.equal(await b.manager.resumeContext(), false);
    assert.equal(b.manager.interruption.reason, 'context_suspended');
  });

  it('lets a lifecycle listener be removed', async () => {
    const fx = lifecycleEnvironment();
    const manager = createAudioManager(fx.env);
    const events = [];
    const off = manager.onLifecycle((e) => events.push(e));
    await manager.open();
    off();
    fx.contexts[0].setState('suspended');
    assert.deepEqual(events, []);
  });
});
