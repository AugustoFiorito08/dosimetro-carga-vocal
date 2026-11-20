// Analyse-and-discard boundary: the page never keeps the take.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyseAndDiscard } from '../src/audio/assessment-runner.js';
import { sustainedVowel, withLeadIn } from './helpers/sustained-vowel.js';

const FS = 16000;
const take = () => withLeadIn(sustainedVowel({ sampleRate: FS, seconds: 3 }), 1, FS);

describe('assessment runner', () => {
  it('without workers: analyses inline and zeroes the samples', async () => {
    const samples = take();
    const result = await analyseAndDiscard(samples, FS, { task: 'VOWEL' }, { WorkerClass: null });
    assert.equal(result.quality.status, 'ok');
    assert.ok(samples.every((v) => v === 0));
  });

  it('without workers: zeroes the samples on an error too', async () => {
    const samples = take();
    await assert.rejects(analyseAndDiscard(samples, FS, { task: 'READING' }, { WorkerClass: null }), RangeError);
    assert.ok(samples.every((v) => v === 0));
  });

  it('with workers: transfers the buffer (the page copy is detached) and returns the measures', async () => {
    const posted = [];
    class FakeWorker {
      constructor(url, options) {
        assert.equal(options.type, 'module');
        assert.match(String(url), /assessment\.worker\.js$/);
        this.terminated = false;
      }
      postMessage(data, transfer) {
        posted.push({ data, transfer });
        structuredClone(data, { transfer }); // detaches like the real postMessage
        queueMicrotask(() => this.onmessage({ data: { result: { task: data.options.task, audioRetained: false } } }));
      }
      terminate() { this.terminated = true; }
    }
    const samples = take();
    const result = await analyseAndDiscard(samples, FS, { task: 'SPEECH' }, { WorkerClass: FakeWorker });
    assert.deepEqual(result, { task: 'SPEECH', audioRetained: false });
    assert.equal(posted[0].transfer[0], posted[0].data.samples.buffer);
    assert.equal(samples.length, 0, 'the page copy is detached');
  });

  it('with workers: rejects on a worker error', async () => {
    class FailingWorker {
      postMessage() { queueMicrotask(() => this.onmessage({ data: { error: 'boom' } })); }
      terminate() {}
    }
    await assert.rejects(analyseAndDiscard(take(), FS, { task: 'VOWEL' }, { WorkerClass: FailingWorker }), /boom/);
  });
});
