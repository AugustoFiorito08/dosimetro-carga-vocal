// Pure models of the teacher view (odd/tasks/vista-docente-movil.md): the next screen of the
// guided flow, and today's load against the teacher's own history. There are no validated
// thresholds yet, so the load is never put in green / yellow / red zones (S2).
import { MODES } from '../../audio/session-controller.js';
import { describe } from '../../stats/descriptive.js';

/** Earlier workdays needed before comparing with the teacher's own history. */
export const MIN_HISTORY = 5;

/** A preparation task running keeps its own screen, even before it is done. */
const TASK_SCREEN = { [MODES.CALIBRATING]: 'ambient', [MODES.ENROLLING]: 'enrol', [MODES.REFERENCING]: 'reference', [MODES.RECORDING]: 'pre' };

/**
 * Screen the teacher should be on: the first missing preparation step, then the live panel,
 * POST (finished, not saved) and the summary (saved).
 * @param {{ codesOk: boolean, connected: boolean, ambientDone: boolean, enrolled: boolean,
 *   referenceDone: boolean, calibrated: boolean, preDone: boolean, mode: string | null,
 *   recordCount: number, saved: boolean }} s
 * @returns {'codes' | 'microphone' | 'ambient' | 'enrol' | 'reference' | 'pre' | 'ready' | 'live' | 'post' | 'summary'}
 */
export function nextTeacherStep(s) {
  if (s.mode === MODES.MEASURING || s.mode === MODES.PAUSED) return 'live';
  if (TASK_SCREEN[s.mode]) return TASK_SCREEN[s.mode];
  if (s.recordCount > 0) return s.saved ? 'summary' : 'post';
  if (!s.codesOk) return 'codes';
  if (!s.connected) return 'microphone';
  if (!s.ambientDone) return 'ambient';
  if (!s.enrolled) return 'enrol';
  if (!s.referenceDone && !s.calibrated) return 'reference';
  if (!s.preDone) return 'pre';
  return 'ready';
}

/**
 * Today's cumulative dose against the same teacher's earlier workdays (same units, since
 * normalized and calibrated doses are on different scales), each read at the same elapsed
 * minute; only workdays that lasted that long count.
 * @returns {{ status: 'insufficient' | 'usual' | 'above_median' | 'above', n: number,
 *   median?: number, p75?: number, ratio?: number }}
 */
export function personalComparison(workdays, { participantId, units, elapsedMin, dose, doseKey = 'none', excludeId = null }) {
  const minute = Math.max(1, Math.round(elapsedMin));
  const past = workdays
    .filter((w) => w.participantId === participantId && w.units === units && w.id !== excludeId)
    .map((w) => {
      const values = w.timeline?.doses?.[doseKey] ?? [];
      return values.length >= minute ? values[minute - 1] : NaN;
    })
    .filter(Number.isFinite);
  if (past.length < MIN_HISTORY) return { status: 'insufficient', n: past.length };
  const { p50: median, p75 } = describe(past);
  const status = dose > p75 ? 'above' : dose > median ? 'above_median' : 'usual';
  return { status, n: past.length, median, p75, ratio: median > 0 ? dose / median : NaN };
}

/**
 * The comparison in plain words for the teacher: during the workday (`now`, at the same
 * elapsed time) or for the whole workday (`day`).
 */
export function comparisonText(c, { scope = 'now' } = {}) {
  if (c.status === 'insufficient') {
    const missing = MIN_HISTORY - c.n;
    return `Con ${missing} ${missing === 1 ? 'jornada más' : 'jornadas más'} vas a poder comparar con tu jornada habitual.`;
  }
  const day = scope === 'day';
  if (c.status === 'above') return day ? 'Esta jornada estuvo por encima de tu jornada habitual.' : 'Hoy vas por encima de tu jornada habitual a esta hora.';
  if (c.status === 'above_median') {
    return day ? 'Esta jornada estuvo algo por encima de tu mediana, dentro de lo que te suele pasar.' : 'Hoy vas algo por encima de tu mediana, dentro de lo que te suele pasar.';
  }
  return day ? 'Esta jornada estuvo dentro de tu jornada habitual.' : 'Hoy vas dentro de tu jornada habitual a esta hora.';
}
