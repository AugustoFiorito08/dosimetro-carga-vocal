// Workday storage port: { save, list, get, remove, clear }, all async. The browser uses
// IndexedDB; tests use the in-memory adapter. Both validate on save and replace by id.
import { validateWorkday } from './workday.js';

const newestFirst = (a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0);
const copy = (w) => structuredClone(w);

export function createMemoryRepository(initial = []) {
  const byId = new Map(initial.map((w) => [w.id, copy(w)]));
  return {
    async save(w) { validateWorkday(w); byId.set(w.id, copy(w)); return w.id; },
    async list() { return [...byId.values()].map(copy).sort(newestFirst); },
    async get(id) { return byId.has(id) ? copy(byId.get(id)) : null; },
    async remove(id) { byId.delete(id); },
    async clear() { byId.clear(); },
  };
}

const DB_NAME = 'dosimetro-vocal';
const STORE = 'workdays';

/** IndexedDB adapter (browser only). Data stay on this device and browser profile. */
export function createIndexedDbRepository({ indexedDB = globalThis.indexedDB } = {}) {
  let dbPromise = null;
  const open = () =>
    (dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    async save(w) { validateWorkday(w); await run('readwrite', (s) => s.put(w)); return w.id; },
    async list() { return ((await run('readonly', (s) => s.getAll())) ?? []).sort(newestFirst); },
    async get(id) { return (await run('readonly', (s) => s.get(id))) ?? null; },
    async remove(id) { await run('readwrite', (s) => s.delete(id)); },
    async clear() { await run('readwrite', (s) => s.clear()); },
  };
}
