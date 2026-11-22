// Dashboards never mix dose units (spec §10.1): calibrated Pa, own-voice normalised and
// uncalibrated relative doses are on different scales.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UNIT_LABELS, selectByUnits } from '../src/ui/boards/aggregate.js';

const day = (id, units, startedAt) => ({ id, units, startedAt });
const days = [
  day('a', 'relative', '2026-11-18T09:00:00.000Z'),
  day('b', 'relative', '2026-11-19T09:00:00.000Z'),
  day('c', 'normalized', '2026-11-22T09:00:00.000Z'),
  day('d', 'normalized', '2026-11-21T09:00:00.000Z'),
  day('e', 'normalized', '2026-11-20T09:00:00.000Z'),
];

describe('selectByUnits', () => {
  it('defaults to the units of the most recent workday and reports what it left out', () => {
    const s = selectByUnits(days, null);
    assert.equal(s.units, 'normalized');
    assert.deepEqual(s.workdays.map((w) => w.id), ['c', 'd', 'e']);
    assert.equal(s.excluded, 2);
    assert.deepEqual(s.available, [{ units: 'normalized', count: 3 }, { units: 'relative', count: 2 }]);
  });

  it('honours an explicit choice and falls back when it is not present', () => {
    assert.deepEqual(selectByUnits(days, 'relative').workdays.map((w) => w.id), ['a', 'b']);
    assert.equal(selectByUnits(days, 'calibrated').units, 'normalized');
  });

  it('treats a record without units as relative and handles no data', () => {
    assert.equal(selectByUnits([{ id: 'x', startedAt: '2026-01-01T00:00:00Z' }], null).units, 'relative');
    assert.deepEqual(selectByUnits([], null), { units: null, workdays: [], excluded: 0, available: [] });
  });

  it('labels every units value', () => {
    assert.deepEqual(Object.keys(UNIT_LABELS).sort(), ['calibrated', 'normalized', 'relative']);
  });
});
