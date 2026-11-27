// Local store of the primary frames (odd/tasks/tramas-primarias.md, T3, S6): saved with the
// workday, deleted with it and with "Borrar jornadas"; the sync purge does not delete them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryFrameStore, withFrameDeletion } from '../src/store/frame-store.js';
import { createMemoryRepository } from '../src/store/workday-repository.js';

const entry = (workdayId) => ({ workdayId, header: { schema: 'vd-des-frames/1', frameCount: 1 }, bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) });

describe('frame store', () => {
  it('keeps one record per workday, replaced on a new save, and returns copies', async () => {
    const frames = createMemoryFrameStore();
    await frames.put(entry('W1'));
    await frames.put({ ...entry('W1'), bytes: new Uint8Array([9, 9, 9, 9, 9, 9]) });
    const got = await frames.get('W1');
    assert.deepEqual([...got.bytes], [9, 9, 9, 9, 9, 9]);
    got.bytes[0] = 0;
    assert.equal((await frames.get('W1')).bytes[0], 9);
    assert.equal(await frames.get('W2'), null);
    assert.deepEqual(await frames.keys(), ['W1']);
  });

  it('refuses an entry without workday id, header or bytes', async () => {
    const frames = createMemoryFrameStore();
    await assert.rejects(frames.put({ header: {}, bytes: new Uint8Array(6) }), RangeError);
    await assert.rejects(frames.put({ workdayId: 'W', bytes: new Uint8Array(6) }), RangeError);
    await assert.rejects(frames.put({ workdayId: 'W', header: {}, bytes: [1] }), RangeError);
  });

  it('deleting a workday or all of them deletes their frames; the sync purge (removeIf) does not', async () => {
    const frames = createMemoryFrameStore();
    const workdays = createMemoryRepository([{ id: 'W1' }, { id: 'W2' }, { id: 'W3' }]);
    const repo = withFrameDeletion(workdays, frames);
    for (const id of ['W1', 'W2', 'W3']) await frames.put(entry(id));
    await repo.remove('W1');
    assert.equal(await frames.get('W1'), null);
    if (repo.removeIf) await repo.removeIf('W2', () => true);
    assert.notEqual(await frames.get('W2'), null, 'frames wait for their own upload');
    await repo.clear();
    assert.deepEqual(await frames.keys(), []);
    assert.equal(typeof repo.list, 'function');
  });
});
