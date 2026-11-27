// Sync of workday summaries to an analytical database (spec §14.1), provider-agnostic:
// - createSyncingRepository() wraps the workday repository and queues every final live
//   workday in the outbox when it is saved (a manual save or autosave.finalize());
// - createSyncService() drains the outbox through an injected transport, with exponential
//   backoff and jitter, and only after a confirmed send removes the item and, optionally,
//   the local summary. Nothing here knows about HTTP, a backend or the UI;
// - enqueueFrames() queues the primary frames of a saved workday (vd-des-frames/1); they go
//   after their workday, part by part, and a failed part is retried from that part.
import { MAX_PART_CHARS } from './frame-record.js';
import { buildFrameParts } from './frame-sync.js';
import { SYNC_FORMAT, isSyncable, syncKey, toSyncRecord, validateSyncPayload } from './workday-sync.js';

/** Only workdays measured on this device are sent; imported or demo ones belong to another source. */
export const shouldEnqueue = (workday) => workday?.source === 'live' && isSyncable(workday);

const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Unique per save, also across tabs saving in the same millisecond. */
const newRev = (at) => `${at}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

/**
 * Queues the upload of a workday's primary frames (stored in the frame store). The item is
 * `{ key: 'frames:<syncKey>', kind: 'frames', workdayId, syncKey, nextPart, ... }`; deleting the
 * workday through the syncing repository also removes it (same workdayId).
 */
export async function enqueueFrames(outbox, { workdayId, syncKey: key, now = () => new Date() }) {
  const at = now();
  await outbox.put({
    key: `frames:${key}`, kind: 'frames', workdayId, syncKey: key, nextPart: 0, rev: newRev(at.getTime()),
    state: 'pending', attempts: 0, nextAttemptAt: at.getTime(), enqueuedAt: at.toISOString(), lastError: null,
  });
}

/** Calls an injected callback; a bug in it is never allowed to break the sync. */
function safely(fn, ...args) {
  try {
    return fn?.(...args);
  } catch {
    return undefined;
  }
}

/**
 * Same port as the wrapped repository. save() writes locally first; queueing never fails
 * the save (an invalid record or a full outbox is reported through onError). remove() and
 * clear() also cancel the pending sends of what they delete: deleted data is not uploaded.
 * @param {{ save, list, get, remove, clear }} repository
 * @param {{ put, get, list, remove }} outbox
 * @param {{ now?: () => Date, onError?: (error: Error) => void, onEnqueued?: (item: object) => void }} [options]
 */
export function createSyncingRepository(repository, outbox, { now = () => new Date(), onError, onEnqueued } = {}) {
  async function enqueue(workday) {
    const record = toSyncRecord(workday);
    const at = now().getTime();
    const item = {
      key: syncKey(record),
      workdayId: record.id,
      record,
      rev: newRev(at), // a newer save of the same session gets a new revision
      state: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      enqueuedAt: at,
      lastError: null,
    };
    await outbox.put(item);
    safely(onEnqueued, item);
  }
  return {
    ...repository,
    async save(workday) {
      const id = await repository.save(workday);
      if (shouldEnqueue(workday)) {
        try {
          await enqueue(workday);
        } catch (error) {
          safely(onError, error);
        }
      }
      return id;
    },
    async remove(id) {
      await repository.remove(id);
      for (const item of await outbox.list()) if (item.workdayId === id) await outbox.remove(item.key);
    },
    async clear() {
      await repository.clear();
      for (const item of await outbox.list()) await outbox.remove(item.key);
    },
  };
}

/**
 * Delay before retry number `attempts` (1-based): base * 2^(attempts - 1), capped at max,
 * then "equal jitter" between half and the full delay so devices do not retry in step.
 */
export function backoffDelay(attempts, { baseDelayMs, maxDelayMs, random = Math.random }) {
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(delay * (0.5 + 0.5 * random()));
}

/**
 * @param {object} deps
 * @param {{ send(payload: object): Promise<unknown> }} deps.transport resolves when the
 *   backend confirmed the workday; rejects otherwise (`error.permanent = true` for a record
 *   the backend will never accept, e.g. a validation error, so it is not retried)
 * @param {{ list, removeIfRev, updateIfRev }} deps.outbox
 * @param {{ removeIf }} deps.repository the plain local repository (not the syncing one)
 * @param {() => boolean} [deps.online] navigator.onLine or equivalent
 * @param {boolean} [deps.purgeAfterSync=true] remove the local summary (and frames) once the send is confirmed
 * @param {{ get(id: string): Promise<object | null>, remove(id: string): Promise<void> } | null} [deps.frames]
 *   frame store read by the frames items; the transport then needs sendFrames(part)
 * @param {number} [deps.framePartChars] base64 characters per frame part
 */
export function createSyncService({
  transport,
  outbox,
  repository,
  now = () => new Date(),
  timers = globalThis,
  online = () => globalThis.navigator?.onLine !== false,
  random = Math.random,
  baseDelayMs = 30 * 1000,
  maxDelayMs = 60 * 60 * 1000,
  pollMs = 60 * 1000,
  purgeAfterSync = true,
  frames = null,
  framePartChars = MAX_PART_CHARS,
  onEvent,
  onError,
}) {
  let running = null;
  let timer = null;

  const report = (error) => safely(onError, error);
  const emit = (event) => safely(onEvent, event);
  const isOnline = () => {
    try {
      return online() !== false;
    } catch (error) {
      report(error);
      return false;
    }
  };

  /** True only for the local summary that is still exactly the confirmed record. */
  function isConfirmedCopy(local, record) {
    try {
      return local !== null && shouldEnqueue(local) && sameRecord(toSyncRecord(local), record);
    } catch {
      return false; // an invalid local record is never deleted
    }
  }

  /**
   * Records a failed attempt on this revision only: a newer version of the same session,
   * queued meanwhile, keeps its own fresh schedule.
   */
  async function markFailed(item, error, permanent) {
    const attempts = item.attempts + 1;
    const nextAttemptAt = now().getTime() + backoffDelay(attempts, { baseDelayMs, maxDelayMs, random });
    const lastError = String(error?.message ?? error);
    await outbox.updateIfRev(item.key, item.rev, (current) => ({ ...current, attempts, state: permanent ? 'rejected' : 'pending', nextAttemptAt, lastError }));
    emit({ type: permanent ? 'rejected' : 'retry', key: item.key, attempts, nextAttemptAt, error });
  }

  /**
   * Sends the frames of one workday part by part: true when all were confirmed, false on a
   * failure (retried later from the failed part), null when it has to wait for its workday.
   */
  async function sendFramesItem(item) {
    if (await outbox.get(item.syncKey)) return null; // the workday goes first (pending or rejected)
    const entry = frames ? await frames.get(item.workdayId) : null;
    if (!entry) {
      await outbox.removeIfRev(item.key, item.rev); // nothing left to send (deleted or never kept)
      emit({ type: 'frames_missing', key: item.key, workdayId: item.workdayId });
      return null;
    }
    let parts;
    try {
      parts = await buildFrameParts(entry, item.syncKey, { maxChars: framePartChars });
    } catch (error) {
      await markFailed(item, error, true);
      return false;
    }
    const from = (item.nextPart ?? 0) < parts.length ? item.nextPart ?? 0 : 0;
    for (let part = from; part < parts.length; part++) {
      try {
        await transport.sendFrames(parts[part]);
      } catch (error) {
        await markFailed(item, error, error?.permanent === true);
        return false;
      }
      await outbox.updateIfRev(item.key, item.rev, (current) => ({ ...current, nextPart: part + 1 }));
    }
    await outbox.removeIfRev(item.key, item.rev);
    let purged = false;
    if (purgeAfterSync) {
      try {
        await frames.remove(item.workdayId);
        purged = true;
      } catch (error) {
        report(error); // the frames stay locally; they were sent, so nothing is lost
      }
    }
    emit({ type: 'sent', kind: 'frames', key: item.key, workdayId: item.workdayId, purged });
    return true;
  }

  async function sendItem(item) {
    if (item.kind === 'frames') return sendFramesItem(item);
    let payload;
    try {
      payload = validateSyncPayload({ format: SYNC_FORMAT, exportedAt: now().toISOString(), workdays: [item.record] });
    } catch (error) {
      await markFailed(item, error, true); // a stored record that no longer validates is never sendable
      return false;
    }
    try {
      await transport.send(payload);
    } catch (error) {
      await markFailed(item, error, error?.permanent === true);
      return false;
    }
    // Confirmed. Each check and its write happen in one step, so a save of the same session
    // landing now is neither dropped from the queue nor deleted locally.
    await outbox.removeIfRev(item.key, item.rev);
    let purged = false;
    if (purgeAfterSync) {
      try {
        purged = await repository.removeIf(item.record.id, (local) => isConfirmedCopy(local, item.record));
      } catch (error) {
        report(error); // the summary stays; it was sent, so nothing is lost
      }
    }
    emit({ type: 'sent', key: item.key, workdayId: item.workdayId, purged });
    return true;
  }

  async function run() {
    if (!isOnline()) return { sent: 0, failed: 0, skipped: 'offline' };
    const result = { sent: 0, failed: 0, skipped: null };
    let due;
    try {
      // Workdays first, so the frames of a workday sent in this run can follow it.
      due = (await outbox.list()).filter((i) => i.state === 'pending' && i.nextAttemptAt <= now().getTime())
        .sort((a, b) => (a.kind === 'frames') - (b.kind === 'frames'));
    } catch (error) {
      report(error);
      return { ...result, skipped: 'error' };
    }
    for (const item of due) {
      if (!isOnline()) break;
      try {
        const outcome = await sendItem(item);
        if (outcome === true) result.sent++;
        else if (outcome === false) result.failed++;
      } catch (error) {
        report(error); // an outbox write failed: this item is retried on the next run
        result.failed++;
      }
    }
    return result;
  }

  let again = false;
  /**
   * Sends every due item once. Concurrent calls share the run in course; a call during a run
   * makes it look at the outbox once more when it ends, so an item queued meanwhile (the frames
   * of the workday being sent) does not wait for the next poll. Never rejects.
   */
  function flush() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result;
      do {
        again = false;
        result = await run();
      } while (again);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  return {
    flush,
    /** Polls the outbox every pollMs (idempotent). Also call flush() on 'online' or after a save. */
    start() {
      if (timer === null) timer = timers.setInterval(() => { flush(); }, pollMs);
    },
    stop() {
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
    },
    /** Queue size by state, for a status indicator. */
    async pending() {
      const items = await outbox.list();
      return { pending: items.filter((i) => i.state === 'pending').length, rejected: items.filter((i) => i.state === 'rejected').length };
    },
  };
}
