// Workday storage port: { save, list, get, remove, clear, removeIf }, all async. The browser
// uses IndexedDB; tests use the in-memory adapter. Both validate on save and replace by id.
// removeIf(id, predicate) reads and deletes in one step (one IndexedDB transaction), so no
// save can land between the check and the delete.
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
    async removeIf(id, predicate) {
      const current = byId.has(id) ? copy(byId.get(id)) : null;
      if (!predicate(current)) return false;
      byId.delete(id);
      return true;
    },
  };
}

export const DB_NAME = 'dosimetro-vocal';
/** v1: workdays. v2: adds the sync outbox (src/store/outbox.js). */
export const DB_VERSION = 2;
export const STORES = Object.freeze({ workdays: 'workdays', outbox: 'outbox' });
const STORE = STORES.workdays;

/**
 * Schema upgrade, step by step from `oldVersion`. It only creates stores that are missing
 * and never deletes or recreates one, so the workdays saved under v1 are kept as they are.
 */
export function upgradeDatabase(db, oldVersion) {
  if (oldVersion < 1 && !db.objectStoreNames.contains(STORES.workdays)) db.createObjectStore(STORES.workdays, { keyPath: 'id' });
  if (oldVersion < 2 && !db.objectStoreNames.contains(STORES.outbox)) db.createObjectStore(STORES.outbox, { keyPath: 'key' });
}

/**
 * Opens (and upgrades) the app database. A tab still holding an older version is asked to
 * close it (versionchange); while it does not, the open fails with a clear error.
 */
export function openDatabase({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    let blocked = false;
    req.onupgradeneeded = (event) => upgradeDatabase(req.result, event.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      if (blocked) {
        db.close(); // the caller already got the error; the next call opens again
        return;
      }
      db.onversionchange = () => db.close(); // let a newer tab upgrade
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      blocked = true;
      reject(new Error('the local database is open in another tab with an older version; close it and reload'));
    };
  });
}

/**
 * Lazily opened, shared connection. A failed open, or a connection closed because another
 * tab upgrades the database, is opened again on the next call.
 */
export function lazyDatabase(options) {
  let dbPromise = null;
  return () => (dbPromise ??= openDatabase(options).then(
    (db) => {
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; };
      return db;
    },
    (error) => {
      dbPromise = null;
      throw error;
    },
  ));
}

/** Runs one request in a transaction of `store` and resolves with its result when the transaction completes. */
export function runInStore(dbPromise, store, mode, fn) {
  return dbPromise().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  }));
}

/**
 * Reads `key` and, in the same readwrite transaction, applies what `decide(current)` returns:
 * { put: value }, { remove: true } or nothing. Resolves true when it wrote.
 */
export function updateInStore(dbPromise, store, key, decide) {
  return dbPromise().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    let wrote = false;
    const req = objectStore.get(key);
    req.onsuccess = () => {
      const action = decide(req.result ?? null); // a throw here aborts the transaction
      if (action?.put !== undefined) { objectStore.put(action.put); wrote = true; }
      else if (action?.remove) { objectStore.delete(key); wrote = true; }
    };
    tx.oncomplete = () => resolve(wrote);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  }));
}

/** IndexedDB adapter (browser only). Data stay on this device and browser profile. */
export function createIndexedDbRepository({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  const open = lazyDatabase({ indexedDB, name });
  const run = (mode, fn) => runInStore(open, STORE, mode, fn);
  return {
    async save(w) { validateWorkday(w); await run('readwrite', (s) => s.put(w)); return w.id; },
    async list() { return ((await run('readonly', (s) => s.getAll())) ?? []).sort(newestFirst); },
    async get(id) { return (await run('readonly', (s) => s.get(id))) ?? null; },
    async remove(id) { await run('readwrite', (s) => s.delete(id)); },
    async clear() { await run('readwrite', (s) => s.clear()); },
    removeIf(id, predicate) { return updateInStore(open, STORE, id, (current) => (predicate(current) ? { remove: true } : null)); },
  };
}
