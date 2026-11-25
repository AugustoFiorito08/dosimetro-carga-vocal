// Reminders of the recovery times: a calendar file with an alarm per time, which the phone
// shows even with the app closed, and a browser notification while the app is open.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addRecoveryPoint } from '../src/store/recovery.js';
import { createRecoveryNotifier, recoveryCalendar, upcomingReminders } from '../src/store/recovery-reminders.js';

const STARTED = new Date(2026, 10, 12, 8, 0).toISOString();
const END = Date.parse(STARTED) + 4 * 3600 * 1000;
const after = (min) => new Date(END + min * 60000);

const workday = (extra = {}) => ({
  id: 'S-20261112-080000-P-0421', participantId: 'P-0421', startedAt: STARTED, durationS: 4 * 3600,
  fatigue: { pre: 10, post: 50 }, source: 'live', ...extra,
});

describe('upcoming reminders', () => {
  it('lists every time not yet recorded nor missed, at its planned time', () => {
    const r = upcomingReminders([workday()], after(0));
    assert.deepEqual(r.map((x) => x.slot), ['R30', 'R60', 'R120', 'R240', 'NEXT']);
    assert.equal(r[0].at.getTime(), after(30).getTime());
    assert.equal(r[0].workdayId, 'S-20261112-080000-P-0421');
    assert.equal(r[0].label, '+30 min');
  });

  it('skips recorded and missed times, demo or imported workdays and workdays in progress', () => {
    const w = addRecoveryPoint(workday(), { slot: 'R30', value: 40, at: after(30) });
    assert.deepEqual(upcomingReminders([w], after(70)).map((x) => x.slot), ['R60', 'R120', 'R240', 'NEXT']);
    assert.deepEqual(upcomingReminders([workday()], after(70)).map((x) => x.slot), ['R60', 'R120', 'R240', 'NEXT'], 'R30 missed');
    assert.deepEqual(upcomingReminders([workday({ source: 'demo' }), workday({ source: 'import' })], after(0)), []);
    assert.deepEqual(upcomingReminders([workday({ checkpoint: { status: 'in_progress', savedAt: STARTED } })], after(0)), []);
  });
});

describe('calendar file (.ics)', () => {
  it('has one event per pending time, with a display alarm at its start and no personal data', () => {
    const ics = recoveryCalendar(workday(), { now: after(0) });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.equal(ics.match(/BEGIN:VEVENT/g).length, 5);
    assert.equal(ics.match(/BEGIN:VALARM/g).length, 5);
    assert.match(ics, /TRIGGER:PT0M/);
    assert.match(ics, /SUMMARY:Registrar fatiga vocal \(\+30 min\)/);
    const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    assert.ok(ics.includes(`DTSTART:${utc(after(30))}`));
    assert.ok(!ics.includes('P-0421'), 'the teacher code stays out of the calendar');
    for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `folded line: ${line}`);
    assert.match(ics.replace(/\r\n /g, ''), /DESCRIPTION:Abrí VocalDose\\, pestaña Mi jornada/, 'unfolds back to the text');
  });

  it('refuses when nothing is pending', () => {
    assert.throws(() => recoveryCalendar(workday(), { now: after(3000) }), /no pending/);
  });
});

describe('in-app notifier', () => {
  function fakeClock(start) {
    let now = start.getTime();
    const timers = [];
    return {
      now: () => new Date(now),
      setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length - 1; },
      clearTimer: (i) => { if (timers[i]) timers[i].fn = null; },
      advance(min) {
        now += min * 60000;
        for (const t of timers) if (t.fn && t.at <= now) { const fn = t.fn; t.fn = null; fn(); }
      },
    };
  }

  it('notifies each time once when it arrives', async () => {
    const clock = fakeClock(after(0));
    const seen = [];
    const notifier = createRecoveryNotifier({ list: async () => [workday()], notify: (r) => seen.push(r.slot), ...clock });
    await notifier.refresh();
    clock.advance(29);
    assert.deepEqual(seen, []);
    clock.advance(1);
    assert.deepEqual(seen, ['R30']);
    await notifier.refresh();
    clock.advance(30);
    assert.deepEqual(seen, ['R30', 'R60']);
  });

  it('on refresh, notifies a time that arrived while the page was asleep and is still open', async () => {
    const clock = fakeClock(after(33));
    const seen = [];
    const notifier = createRecoveryNotifier({ list: async () => [workday()], notify: (r) => seen.push(r.slot), ...clock });
    await notifier.refresh();
    await notifier.refresh();
    assert.deepEqual(seen, ['R30']);
  });

  it('a recorded time is not notified', async () => {
    const clock = fakeClock(after(0));
    const seen = [];
    const done = addRecoveryPoint(workday(), { slot: 'R30', value: 40, at: after(26) });
    let current = workday();
    const notifier = createRecoveryNotifier({ list: async () => [current], notify: (r) => seen.push(r.slot), ...clock });
    await notifier.refresh();
    clock.advance(26);
    current = done;
    await notifier.refresh();
    clock.advance(10);
    assert.deepEqual(seen, []);
  });
});

describe('reminder buttons in Mi jornada', () => {
  const full = (extra = {}) => ({
    schema: 'vd-des-workday/1', ...workday(), schoolId: 'E-25', classroom: '2B', date: '2026-11-12', phonationS: 3600, validRatio: 0.9,
    doses: { none: 10, linear: 10, power: 10, exponential: 10, saturating: 10, distance: null, time: 3600, cycle: 1 },
    hMax: 1, f0: { p10: 150, p50: 180, p90: 220 }, level: { p10: 60, p50: 70, p90: 80 }, units: 'normalized',
    timeline: { minutes: [1], doses: { none: [1], linear: [1], power: [1], exponential: [1], saturating: [1] } },
    events: [], assessment: null, algorithmVersion: '0.9.0', ...extra,
  });
  const html = async (w, permission) => {
    const { renderTeacher } = await import('../src/ui/boards/views.js');
    const root = { innerHTML: '' };
    renderTeacher(root, [w], { dose: 'none', now: () => after(10), notificationPermission: permission });
    return root.innerHTML;
  };

  it('offers the calendar and, while undecided, the browser notifications', async () => {
    const page = await html(full(), 'default');
    assert.match(page, /data-action="recovery-ics"/);
    assert.match(page, /data-action="recovery-notify"/);
    assert.doesNotMatch(await html(full(), 'granted'), /data-action="recovery-notify"/);
    assert.match(await html(full(), 'denied'), /bloqueó los avisos/);
  });

  it('nothing to remind on a demo workday', async () => {
    assert.doesNotMatch(await html(full({ source: 'demo' }), 'default'), /recovery-ics/);
  });
});
