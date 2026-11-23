// Screen Wake Lock with safe degradation: a missing API, a refused request or a lock the
// browser drops when the page is hidden never throws; acquire() just resolves false.

/**
 * @param {{ wakeLock?: { request(type: 'screen'): Promise<object> }, onError?: (error: Error) => void }} [env]
 */
export function createWakeLock({ wakeLock = globalThis.navigator?.wakeLock, onError } = {}) {
  const supported = typeof wakeLock?.request === 'function';
  let sentinel = null;
  let wanted = false;
  let pending = null;

  async function releaseQuietly(s) {
    try {
      await s.release();
    } catch {
      /* already released */
    }
  }

  function request() {
    if (!supported || !wanted) return Promise.resolve(false);
    if (sentinel) return Promise.resolve(true);
    pending ??= (async () => {
      try {
        const s = await wakeLock.request('screen');
        if (!wanted) {
          await releaseQuietly(s); // release() ran while the request was pending
          return false;
        }
        sentinel = s;
        // The browser releases it on its own when the page is hidden.
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null;
        });
        return true;
      } catch (error) {
        onError?.(error);
        return false;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    supported,
    get active() { return sentinel !== null; },
    get wanted() { return wanted; },
    /** Keeps the screen on while wanted. @returns {Promise<boolean>} whether the lock is held */
    acquire() {
      wanted = true;
      return request();
    },
    /** Re-requests a lock the browser dropped (page hidden), only while still wanted. */
    restore() {
      return request();
    },
    async release() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      if (s) await releaseQuietly(s);
    },
  };
}
