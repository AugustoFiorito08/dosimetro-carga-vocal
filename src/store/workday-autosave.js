// Periodic checkpoints of the workday in course, so a closed tab or a killed app loses at
// most one interval. A checkpoint is an ordinary workday record (same id, replaced in
// place) carrying `checkpoint: { status: 'in_progress', savedAt }`; the manual save
// writes the final record without that field. All writes go through one queue, so
// they never overlap and the final save is always the last one.
import { CHECKPOINT_STATUSES } from './workday.js';

export { CHECKPOINT_STATUSES };

export const DEFAULT_AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * @param {object} deps
 * @param {{ save(w: object): Promise<string>, remove(id: string): Promise<void> }} deps.repository
 * @param {() => object} deps.snapshot builds the current workday (buildWorkday); may throw when the codes are missing
 * @param {number} [deps.intervalMs]
 * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [deps.timers]
 * @param {() => Date} [deps.now]
 * @param {(error: Error) => void} [deps.onError] invalid snapshot or failed write; autosaving goes on
 */
export function createWorkdayAutosaver({
  repository,
  snapshot,
  intervalMs = DEFAULT_AUTOSAVE_INTERVAL_MS,
  timers = globalThis,
  now = () => new Date(),
  onError,
}) {
  if (!(intervalMs > 0)) throw new RangeError(`intervalMs must be > 0, got ${intervalMs}`);
  let timer = null;
  let closed = false; // after finalize() or discard(): no more checkpoints
  let savedId = null; // id of the checkpoint this session wrote
  let lastSavedAt = null;
  let chain = Promise.resolve();
  let queued = null; // checkpoint waiting for the write in flight, shared by later requests

  function enqueue(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  /** Writes `record` and drops this session's previous record when its id changed (new participant code). */
  async function write(record) {
    await repository.save(record);
    if (savedId !== null && savedId !== record.id) await repository.remove(savedId);
  }

  function stopTimer() {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  }

  /** @returns {Promise<{ saved: boolean, id?: string, reason?: 'closed' | 'invalid' | 'error', error?: Error }>} */
  function checkpoint() {
    if (closed) return Promise.resolve({ saved: false, reason: 'closed' });
    if (queued) return queued;
    const run = enqueue(async () => {
      queued = null; // from here on, a new request queues a fresher snapshot
      if (closed) return { saved: false, reason: 'closed' };
      let workday;
      try {
        workday = snapshot();
      } catch (error) {
        onError?.(error);
        return { saved: false, reason: 'invalid', error };
      }
      const at = now();
      const record = { ...workday, checkpoint: { status: 'in_progress', savedAt: at.toISOString() } };
      try {
        await write(record);
      } catch (error) {
        onError?.(error);
        return { saved: false, reason: 'error', error };
      }
      savedId = record.id;
      lastSavedAt = at;
      return { saved: true, id: record.id };
    });
    queued = run;
    return run;
  }

  return {
    intervalMs,
    /** Starts the periodic checkpoints (idempotent). */
    start() {
      if (closed || timer !== null) return;
      timer = timers.setInterval(() => { checkpoint(); }, intervalMs);
    },
    checkpoint,
    /** Halts the timer; the last checkpoint stays until finalize() or discard(). */
    stop: stopTimer,
    /** Final save: waits for any checkpoint in flight, then writes the clean record. Throws on failure. */
    finalize(workday) {
      closed = true;
      stopTimer();
      const { checkpoint: _ignored, ...clean } = workday;
      return enqueue(async () => {
        await write(clean);
        savedId = null;
        return clean.id;
      });
    },
    /** Drops this session's checkpoint (the user discarded the session). */
    discard() {
      closed = true;
      stopTimer();
      return enqueue(async () => {
        if (savedId !== null) await repository.remove(savedId);
        savedId = null;
      });
    },
    get running() { return timer !== null; },
    get closed() { return closed; },
    get savedId() { return savedId; },
    get lastSavedAt() { return lastSavedAt; },
  };
}

/**
 * Start-up: checkpoints still `in_progress` belong to sessions that ended without a
 * manual save (closed tab, killed app). They are kept, marked `recovered`, and returned
 * once so the user can be told.
 */
export async function recoverCheckpoints(repository) {
  const lost = (await repository.list()).filter((w) => w.checkpoint?.status === 'in_progress');
  for (const w of lost) await repository.save({ ...w, checkpoint: { ...w.checkpoint, status: 'recovered' } });
  return lost;
}

/** Lifecycle events after which the page may be frozen or killed (src/audio/audio-manager.js). */
const RISKY_LIFECYCLE_EVENTS = new Set(['interrupted', 'hidden']);

/**
 * Checkpoints the current session when capture is interrupted, the page is hidden or it
 * is being unloaded (pagehide). The pagehide write is best effort: the browser may end
 * the page before IndexedDB commits it, which is why the hidden event checkpoints too.
 * @param {{ onLifecycle: (fn: (event: object) => void) => () => void, page: EventTarget,
 *   getAutosave: () => { checkpoint(): Promise<object> } | null }} deps
 * @returns {() => void} unbind
 */
export function bindAutosaveTriggers({ onLifecycle, page, getAutosave }) {
  const save = () => { getAutosave()?.checkpoint(); };
  const offLifecycle = onLifecycle((event) => {
    if (RISKY_LIFECYCLE_EVENTS.has(event.type)) save();
  });
  page.addEventListener('pagehide', save);
  return () => {
    offLifecycle();
    page.removeEventListener('pagehide', save);
  };
}
