// Session lifecycle policy, browser-free: what to do with the session when capture is
// interrupted, and when leaving the page would lose data.
import { MODES } from './session-controller.js';

const TASK_MODES = new Set([MODES.CALIBRATING, MODES.ACOUSTIC_CALIBRATING, MODES.ENROLLING, MODES.RECORDING]);

/**
 * A measurement is paused (its records stay available for export and save); a
 * calibration, enrolment or sample take is cancelled, since its result would be built
 * on a capture with a hole in it.
 * @returns {'paused' | 'cancelled' | 'none'}
 */
export function interruptSession(session) {
  if (!session) return 'none';
  if (session.mode === MODES.MEASURING) {
    session.pause();
    return 'paused';
  }
  if (TASK_MODES.has(session.mode)) {
    session.stop();
    return 'cancelled';
  }
  return 'none';
}

/**
 * True while a session is measuring or paused, or after it finished with frames whose
 * workday was not saved yet.
 * @param {{ session: { mode: string, recordCount: number } | null, workdaySaved: boolean }} state
 */
export function hasUnsavedWork({ session, workdaySaved }) {
  if (!session) return false;
  if (session.mode === MODES.MEASURING || session.mode === MODES.PAUSED) return true;
  return session.mode === MODES.IDLE && session.recordCount > 0 && !workdaySaved;
}
