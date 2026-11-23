// Sync outbox: workday summaries waiting to be sent to the analytical database (spec §14.1).
// Port: { put, get, list, remove, removeIfRev, updateIfRev }, all async; list() is ordered by
// next attempt. The *IfRev methods check the revision and write in one step (one IndexedDB
// transaction), so a newer save of the same session is never removed or overwritten. Items:
// { key, workdayId, record, rev, state: 'pending' | 'rejected', attempts, nextAttemptAt,
//   enqueuedAt, lastError }. `record` is the F0 sync record, never audio or a template.
import { DB_NAME, STORES, lazyDatabase, runInStore, updateInStore } from './workday-repository.js';

const byNextAttempt = (a, b) => a.nextAttemptAt - b.nextAttemptAt;
const copy = (item) => structuredClone(item);

export function createMemoryOutbox(initial = []) {
  const byKey = new Map(initial.map((item) => [item.key, copy(item)]));
  return {
    async put(item) { byKey.set(item.key, copy(item)); },
    async get(key) { return byKey.has(key) ? copy(byKey.get(key)) : null; },
    async list() { return [...byKey.values()].map(copy).sort(byNextAttempt); },
    async remove(key) { byKey.delete(key); },
    async removeIfRev(key, rev) {
      if (byKey.get(key)?.rev !== rev) return false;
      byKey.delete(key);
      return true;
    },
    async updateIfRev(key, rev, update) {
      const current = byKey.get(key);
      if (current?.rev !== rev) return false;
      byKey.set(key, copy(update(copy(current))));
      return true;
    },
  };
}

/** IndexedDB adapter: the `outbox` store of the app database (schema v2). */
export function createIndexedDbOutbox({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  const open = lazyDatabase({ indexedDB, name });
  const run = (mode, fn) => runInStore(open, STORES.outbox, mode, fn);
  return {
    async put(item) { await run('readwrite', (s) => s.put(item)); },
    async get(key) { return (await run('readonly', (s) => s.get(key))) ?? null; },
    async list() { return ((await run('readonly', (s) => s.getAll())) ?? []).sort(byNextAttempt); },
    async remove(key) { await run('readwrite', (s) => s.delete(key)); },
    removeIfRev(key, rev) { return updateInStore(open, STORES.outbox, key, (current) => (current?.rev === rev ? { remove: true } : null)); },
    updateIfRev(key, rev, update) {
      return updateInStore(open, STORES.outbox, key, (current) => (current?.rev === rev ? { put: update(current) } : null));
    },
  };
}
