// Local store of the primary frames of each workday (vd-des-frames/1, src/store/frame-record.js;
// odd/tasks/tramas-primarias.md, S6): one entry per workday, { workdayId, header, bytes }, in the
// `frames` store of the app database (schema v3). Port: { put, get, remove, clear, keys }.
import { DB_NAME, STORES, lazyDatabase, runInStore } from './workday-repository.js';

function checkEntry(e) {
  if (typeof e?.workdayId !== 'string' || !e.workdayId) throw new RangeError('frames need the workday id');
  if (!e.header || typeof e.header !== 'object') throw new RangeError('frames need their header');
  if (!(e.bytes instanceof Uint8Array)) throw new RangeError('frames bytes must be a Uint8Array');
}

const copy = (e) => ({ workdayId: e.workdayId, header: structuredClone(e.header), bytes: e.bytes.slice() });

export function createMemoryFrameStore() {
  const byId = new Map();
  return {
    async put(entry) { checkEntry(entry); byId.set(entry.workdayId, copy(entry)); },
    async get(workdayId) { return byId.has(workdayId) ? copy(byId.get(workdayId)) : null; },
    async remove(workdayId) { byId.delete(workdayId); },
    async clear() { byId.clear(); },
    async keys() { return [...byId.keys()]; },
  };
}

/** IndexedDB adapter (browser only): the `frames` store of the app database. */
export function createIndexedDbFrameStore({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  const open = lazyDatabase({ indexedDB, name });
  const run = (mode, fn) => runInStore(open, STORES.frames, mode, fn);
  return {
    async put(entry) { checkEntry(entry); await run('readwrite', (s) => s.put(copy(entry))); },
    async get(workdayId) { return (await run('readonly', (s) => s.get(workdayId))) ?? null; },
    async remove(workdayId) { await run('readwrite', (s) => s.delete(workdayId)); },
    async clear() { await run('readwrite', (s) => s.clear()); },
    async keys() { return (await run('readonly', (s) => s.getAllKeys())) ?? []; },
  };
}

/**
 * Deleting a workday (remove) or all of them (clear) also deletes their frames. The sync purge
 * goes through removeIf and leaves them: frames are deleted after their own upload.
 */
export function withFrameDeletion(repository, frames) {
  return {
    ...repository,
    async remove(id) {
      await repository.remove(id);
      await frames.remove(id);
    },
    async clear() {
      await repository.clear();
      await frames.clear();
    },
  };
}
