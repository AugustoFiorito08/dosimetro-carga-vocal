// Post-workday recovery (hito 10): the teacher records the fatigue VAS at fixed times after
// the end of the workday. Each point is kept raw in `fatigue.recovery` of the workday
// ({ slot, at, minutes, value }); the indices are computed from them (src/stats/recovery.js).
// A timed slot opens 5 min before its time and closes when the next one opens (+4 h closes at
// +6 h); the next-morning slot is the first 05:00-12:00 local window still open at +8 h,
// never before +8 h and at least 4 h long. Every workday gets comparable points; the real time is kept as well.

/** Fixed recovery times, in minutes after the end of the workday. */
export const RECOVERY_SLOTS = Object.freeze([
  { id: 'R30', targetMin: 30, label: '+30 min' },
  { id: 'R60', targetMin: 60, label: '+1 h' },
  { id: 'R120', targetMin: 120, label: '+2 h' },
  { id: 'R240', targetMin: 240, label: '+4 h' },
  { id: 'NEXT', targetMin: null, label: 'Mañana siguiente' }, // first 05:00-12:00 window after +8 h
].map((s) => Object.freeze(s)));
export const RECOVERY_POINT_FIELDS = Object.freeze(['slot', 'at', 'minutes', 'value']);

const EARLY_MIN = 5;
const LAST_TIMED_CLOSE_MIN = 360;
const MORNING = { fromHour: 5, toHour: 12, minAfterMin: 480 };

/** End of the workday: the origin (t = 0) of the recovery times. */
export const recoveryEnd = (workday) => new Date(Date.parse(workday.startedAt) + workday.durationS * 1000);

const minutesSinceEnd = (workday, at) => (at.getTime() - recoveryEnd(workday).getTime()) / 60000;

/** Opening and closing of a slot, in minutes after the end of the workday. */
function windowOf(workday, index) {
  const slot = RECOVERY_SLOTS[index];
  if (slot.targetMin === null) {
    // The first 05:00-12:00 window still open at +8 h: the next day after a day shift, the
    // same day after a night shift ending at 02:00.
    const end = recoveryEnd(workday);
    const dayAt = (offset, hour) => minutesSinceEnd(workday, new Date(end.getFullYear(), end.getMonth(), end.getDate() + offset, hour));
    let offset = 0;
    while (dayAt(offset, MORNING.toHour) <= MORNING.minAfterMin) offset++;
    const opensMin = Math.max(dayAt(offset, MORNING.fromHour), MORNING.minAfterMin);
    const closesMin = Math.max(dayAt(offset, MORNING.toHour), opensMin + 240);
    return { opensMin, closesMin, dueMin: opensMin };
  }
  const next = RECOVERY_SLOTS[index + 1];
  const closesMin = next.targetMin === null ? LAST_TIMED_CLOSE_MIN : next.targetMin - EARLY_MIN;
  return { opensMin: slot.targetMin - EARLY_MIN, closesMin, dueMin: slot.targetMin };
}

/**
 * Status of every slot at `now`: 'done' (recorded), 'open', 'upcoming' or 'missed'.
 * `dueAt` is the planned time (the opening, for the next morning); `closesAt` the last moment.
 * @returns {{ id: string, label: string, targetMin: number | null, dueAt: Date, closesAt: Date, status: string, point: object | null }[]}
 */
export function recoverySchedule(workday, now = new Date()) {
  const elapsed = minutesSinceEnd(workday, now);
  const recorded = workday.fatigue?.recovery ?? [];
  return RECOVERY_SLOTS.map((slot, i) => {
    const { opensMin, closesMin, dueMin } = windowOf(workday, i);
    const point = recorded.find((p) => p.slot === slot.id) ?? null;
    const status = point ? 'done' : elapsed < opensMin ? 'upcoming' : elapsed < closesMin ? 'open' : 'missed';
    const at = (min) => new Date(recoveryEnd(workday).getTime() + min * 60000);
    return { ...slot, dueAt: at(dueMin), closesAt: at(closesMin), status, point };
  });
}

/** A copy of the workday with one more recovery point; throws if it cannot be recorded now. */
export function addRecoveryPoint(workday, { slot, value, at = new Date() }) {
  if (workday.source !== 'live') throw new RangeError('recovery can only be recorded on a live workday measured on this device');
  if (workday.checkpoint?.status === 'in_progress') throw new RangeError('the workday is still in progress');
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`the recovery VAS must be a number in 0-100, got ${value}`);
  }
  const entry = recoverySchedule(workday, at).find((s) => s.id === slot);
  if (!entry) throw new RangeError(`unknown recovery slot ${slot}`);
  if (entry.status === 'done') throw new RangeError(`recovery ${slot} is already recorded`);
  if (entry.status !== 'open') throw new RangeError(`recovery ${slot} is not open now (${entry.status})`);
  const point = { slot, at: at.toISOString(), minutes: Math.round(minutesSinceEnd(workday, at) * 10) / 10, value };
  const recovery = [...(workday.fatigue?.recovery ?? []), point].sort((a, b) => a.minutes - b.minutes);
  return { ...workday, fatigue: { ...workday.fatigue, recovery } };
}

/**
 * Repository decorator: a save of a workday that carries no recovery points (a rebuilt
 * record, e.g. «Guardar jornada» pressed again) keeps the points already stored for it.
 */
export function preserveRecovery(repository) {
  return {
    ...repository,
    async save(workday) {
      if (!workday.fatigue?.recovery?.length) {
        const stored = await repository.get(workday.id);
        const kept = stored?.fatigue?.recovery;
        if (kept?.length) return repository.save({ ...workday, fatigue: { ...workday.fatigue, recovery: kept } });
      }
      return repository.save(workday);
    },
  };
}
