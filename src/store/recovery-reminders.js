// Reminders of the recovery times (src/store/recovery.js). A web page cannot wake a phone,
// so there are two channels: a calendar file (.ics) with a display alarm per pending time,
// which the phone's calendar shows even with the app closed, and a notifier that shows a
// browser notification while the app is open (and catches up when the page wakes again).
import { recoverySchedule } from './recovery.js';

const PENDING = new Set(['upcoming', 'open']);
const canRemind = (w) => w.source === 'live' && w.checkpoint?.status !== 'in_progress';

/**
 * Recovery times not yet recorded nor missed, at their planned time, oldest first.
 * @returns {{ workdayId: string, slot: string, label: string, at: Date, closesAt: Date }[]}
 */
export function upcomingReminders(workdays, now = new Date()) {
  return workdays
    .filter(canRemind)
    .flatMap((w) => recoverySchedule(w, now)
      .filter((s) => PENDING.has(s.status))
      .map((s) => ({ workdayId: w.id, slot: s.id, label: s.label, at: s.dueAt, closesAt: s.closesAt })))
    .sort((a, b) => a.at - b.at);
}

// ------------------------------------------------------------------ calendar (RFC 5545)
const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const text = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const hhmm = (d) => d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** FNV-1a, 32 bit, as hex: a stable event id that does not reveal the workday id. */
function hash(value) {
  let h = 0x811c9dc5;
  for (const c of value) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Lines of at most 75 octets: continuation lines start with a space (RFC 5545 §3.1). */
function fold(line) {
  const bytes = (c) => new TextEncoder().encode(c).length;
  const out = [];
  let current = '';
  let size = 0;
  for (const c of line) {
    const limit = out.length ? 74 : 75; // a continuation line starts with one space
    if (size + bytes(c) > limit) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += c;
    size += bytes(c);
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * Calendar with one event per pending recovery time and a display alarm at its start.
 * It carries no teacher code: only the times and what to do.
 */
export function recoveryCalendar(workday, { now = new Date() } = {}) {
  const reminders = upcomingReminders([workday], now);
  if (!reminders.length) throw new RangeError('no pending recovery times for this workday');
  const uidBase = workday.sessionUuid ?? hash(workday.id); // the workday id holds the teacher code
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VocalDose//Recuperacion//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const r of reminders) {
    const summary = `Registrar fatiga vocal (${r.label})`;
    const description = `Abrí VocalDose, pestaña Mi jornada, y registrá tu fatiga de 0 a 100. Se puede registrar hasta las ${hhmm(r.closesAt)}.`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.slot}-${uidBase}@vocaldose`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${utc(r.at)}`,
      `DTEND:${utc(r.closesAt)}`,
      `SUMMARY:${text(summary)}`,
      `DESCRIPTION:${text(description)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${text(summary)}`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ in-app notifier
const HORIZON_MS = 48 * 3600 * 1000;

/**
 * Calls notify(reminder) once per recovery time when it arrives. refresh() re-reads the
 * workdays and reschedules: call it on load, after a save and when the page becomes visible
 * again, since a sleeping page may have skipped its timers (a time still open is notified then).
 * @param {{ list: () => Promise<object[]>, notify: (reminder: object) => void, now?: () => Date,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} deps
 */
export function createRecoveryNotifier({ list, notify, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const notified = new Set();
  let timers = [];
  const key = (r) => `${r.workdayId}:${r.slot}`;
  const fire = (r) => {
    if (notified.has(key(r))) return;
    notified.add(key(r));
    notify(r);
  };
  const stop = () => {
    for (const t of timers) clearTimer(t);
    timers = [];
  };
  return {
    async refresh() {
      const reminders = upcomingReminders(await list(), now());
      stop();
      const t0 = now().getTime();
      for (const r of reminders) {
        if (notified.has(key(r))) continue;
        const wait = r.at.getTime() - t0;
        if (wait <= 0) fire(r);
        else if (wait <= HORIZON_MS) timers.push(setTimer(() => fire(r), wait));
      }
    },
    stop,
  };
}
