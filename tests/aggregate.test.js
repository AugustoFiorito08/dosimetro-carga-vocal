import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_GROUP,
  actionLevels,
  classroomDayHeatmap,
  classroomSummary,
  dailyPercentiles,
  kpis,
  monthlyCounts,
  teachersWithHighPre,
  weekStart,
  workdaysOfWeek,
} from '../src/ui/boards/aggregate.js';

const day = (date, participantId, classroom, none, pre, post, extra = {}) => ({
  id: `${date}-${participantId}`, date, startedAt: `${date}T11:00:00.000Z`, participantId, schoolId: 'E-25', classroom,
  doses: { none }, fatigue: { pre, post }, validRatio: 0.97, ...extra,
});
// week of Mon 2026-11-09; classroom 1A has 3 teachers, 2B only 2
const days = [
  day('2026-11-09', 'P1', '1A', 100, 10, 30), day('2026-11-09', 'P2', '1A', 200, 20, 50), day('2026-11-09', 'P3', '1A', 300, 40, 70),
  day('2026-11-10', 'P1', '1A', 120, 12, 32), day('2026-11-10', 'P4', '2B', 500, 50, 90), day('2026-11-10', 'P5', '2B', 400, 35, 60),
  day('2026-11-16', 'P1', '1A', 999, 5, 5),
];

describe('week helpers', () => {
  it('weekStart is the Monday of the date', () => {
    assert.equal(weekStart('2026-11-12'), '2026-11-09');
    assert.equal(weekStart('2026-11-09'), '2026-11-09');
    assert.equal(weekStart('2026-11-15'), '2026-11-09');
  });

  it('workdaysOfWeek filters by school and week', () => {
    assert.equal(workdaysOfWeek(days, { schoolId: 'E-25', weekStart: '2026-11-09' }).length, 6);
    assert.equal(workdaysOfWeek(days, { schoolId: 'E-99', weekStart: '2026-11-09' }).length, 0);
  });
});

describe('privacy: minimum group size', () => {
  const week = workdaysOfWeek(days, { schoolId: 'E-25', weekStart: '2026-11-09' });

  it('is 3 teachers', () => assert.equal(MIN_GROUP, 3));

  it('heat map: mean dose per classroom and weekday; small classrooms are suppressed', () => {
    const h = classroomDayHeatmap(week, 'none', '2026-11-09');
    assert.deepEqual(h.days, ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
    assert.deepEqual(h.classrooms, ['1A']);
    assert.deepEqual(h.cells[0], [200, 120, null, null, null]);
    assert.deepEqual(h.suppressed, ['2B']);
  });

  it('classroom summary reports teachers, mean dose and post-VAS, suppressing small groups', () => {
    const rows = classroomSummary(week, 'none');
    assert.deepEqual(rows.map((r) => [r.classroom, r.teachers, r.suppressed]), [['1A', 3, false], ['2B', 2, true]]);
    assert.equal(rows[0].meanDose, (100 + 200 + 300 + 120) / 4);
    assert.equal(rows[0].meanPost, (30 + 50 + 70 + 32) / 4);
    assert.equal(rows[1].meanDose, null);
  });

  it('teachers with high pre-VAS are listed by code only when the school group is large enough', () => {
    const rows = teachersWithHighPre(week, 30);
    assert.deepEqual(rows.map((r) => r.participantId), ['P4', 'P3', 'P5']);
    assert.ok(rows.every((r) => !('name' in r)));
    assert.deepEqual(teachersWithHighPre(week.filter((w) => w.classroom === '2B'), 30), []);
  });
});

describe('time aggregates', () => {
  it('daily percentiles of a field', () => {
    const p = dailyPercentiles(days.slice(0, 6), (w) => w.fatigue.pre, ['2026-11-09', '2026-11-10']);
    assert.deepEqual(p.p50, [20, 35]);
  });

  it('monthly counts of received and valid workdays', () => {
    const m = monthlyCounts([...days, day('2026-10-20', 'P1', '1A', 1, 1, 1, { validRatio: 0.5 })]);
    assert.deepEqual(m, [{ month: '2026-10', received: 1, valid: 0 }, { month: '2026-11', received: 7, valid: 7 }]);
  });

  it('kpis', () => {
    const k = kpis(days);
    assert.deepEqual([k.participants, k.workdays, k.valid, k.schools], [5, 7, 7, 1]);
    assert.equal(k.lastReception, '2026-11-16T11:00:00.000Z');
    assert.ok(Math.abs(k.quality - 0.97) < 1e-12);
  });
});

describe('provisional action levels', () => {
  it('C1 is the Youden cut-off and C2 the lowest cut-off with specificity >= 0.90', () => {
    const scores = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const labels = [0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1];
    const levels = actionLevels(scores, labels);
    assert.equal(levels.c1, 5);
    assert.equal(levels.c2, 9);
    assert.equal(levels.provisional, true);
  });
});
