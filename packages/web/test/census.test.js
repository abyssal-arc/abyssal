import { test } from 'node:test';
import assert from 'node:assert/strict';
import { censusEvents, censusGaps, censusSeries, censusTrend, TREND_EPSILON_PER_DAY } from '../src/census.js';

/** A day-book row, shaped like the server's. Only the fields the maths reads. */
const row = (day, population, byArchetype = {}) => ({ day, population, byArchetype });

test('a gap in the book is reported as a gap, not as a straight line', () => {
  assert.deepEqual(censusGaps([row(0, 1), row(1, 1), row(2, 1)]), [], 'three consecutive readings');
  assert.deepEqual(censusGaps([row(0, 1), row(5, 1)]), [{ after: 0, before: 5 }], 'four days nobody measured');
  assert.deepEqual(censusGaps([row(3, 1)]), [], 'one reading cannot be a hole in the record');
  assert.deepEqual(censusGaps([]), [], 'no readings, no claims');
});

test('the bands stack in the order asked and add up to the published population', () => {
  const rows = [row(0, 10, { APE: 3, WHALE: 4 }), row(1, 12, { APE: 5, WHALE: 6 })];
  const s = censusSeries(rows, ['APE', 'WHALE']);
  assert.deepEqual(s.days, [0, 1]);
  assert.deepEqual(s.stacks.map((b) => b.archetype), ['APE', 'WHALE']);
  assert.deepEqual(s.stacks[0].lo, [0, 0], 'the first band sits on the axis');
  assert.deepEqual(s.stacks[0].hi, [3, 5]);
  assert.deepEqual(s.stacks[1].lo, [3, 5], 'the second starts where the first ended');
  assert.deepEqual(s.stacks[1].hi, [7, 11]);
  assert.deepEqual(s.totals, [7, 11]);
  assert.deepEqual(s.unlisted, [3, 1], 'what the known species do not account for is carried, not dropped');
  // The invariant the drawing depends on: every band top plus the unlisted part
  // reaches the number printed above the chart. If it did not, the stack and the
  // population line would disagree in front of a viewer.
  rows.forEach((r, i) => assert.equal(s.totals[i] + s.unlisted[i], r.population));
});

test('the series survives an empty book and a row that counts more than it has', () => {
  const s = censusSeries([], ['APE']);
  assert.deepEqual(s.days, []);
  assert.deepEqual(s.stacks, [{ archetype: 'APE', lo: [], hi: [], values: [] }]);
  assert.deepEqual(s.unlisted, []);
  // A row written under a rule where one creature carried two archetypes would
  // add up to more than its population. `unlisted` floors at zero rather than
  // reporting a negative band, and the mismatch stays visible in `totals`.
  const over = censusSeries([row(0, 4, { APE: 9 })], ['APE']);
  assert.deepEqual(over.unlisted, [0]);
  assert.deepEqual(over.totals, [9]);
});

test('extinctions and emergences become markers without re-deciding anything', () => {
  const events = censusEvents([
    { day: 2, lost: ['INSIDER'], gained: [] },
    { day: 1, lost: [], gained: ['ALGO'] },
    { day: 3, lost: ['APE'], gained: ['WHALE'] },
  ]);
  assert.deepEqual(events, [
    { day: 1, archetype: 'ALGO', kind: 'gained' },
    { day: 2, archetype: 'INSIDER', kind: 'lost' },
    { day: 3, archetype: 'APE', kind: 'lost' },
    { day: 3, archetype: 'WHALE', kind: 'gained' },
  ], 'oldest first, and `lost` before `gained` on one day');
  assert.deepEqual(censusEvents([]), []);
  assert.deepEqual(censusEvents(undefined), [], 'a server that sent no changes is not a crash');
  assert.deepEqual(censusEvents([{ day: 4 }]), [], 'a change with neither list is a quiet day');
});

test('one word for where a species is going, and `unknown` when nothing can be said', () => {
  assert.equal(censusTrend([], 'APE').state, 'unknown');
  assert.equal(censusTrend([row(0, 3, { APE: 3 })], 'APE').state, 'unknown', 'one reading has no slope');
  assert.deepEqual(censusTrend([row(0, 3, { APE: 3 })], 'APE'), { state: 'unknown', perDay: null, from: null, to: null });

  const growing = [row(0, 10, { APE: 10 }), row(1, 12, { APE: 12 }), row(2, 14, { APE: 14 })];
  assert.equal(censusTrend(growing, 'APE').state, 'expanding');
  assert.equal(censusTrend(growing, 'APE').perDay, 2);
  assert.equal(censusTrend(growing.map((r) => row(r.day, 10, { APE: 10 })), 'APE').state, 'steady');
  assert.equal(censusTrend([row(0, 10, { APE: 10 }), row(1, 8, { APE: 8 })], 'APE').state, 'shrinking');
  assert.equal(
    censusTrend([row(0, 10, { APE: 10 }), row(1, 0, {})], 'APE').state,
    'gone',
    'reaching zero is its own sentence, not the extreme of shrinking',
  );
  assert.equal(censusTrend([row(0, 10, {}), row(1, 0, {})], 'APE').state, 'steady', 'never present is not going extinct');

  // A species the front end does not know about reads as absent rather than as a
  // crash, and `from`/`to` stay available for the tooltip.
  assert.deepEqual(censusTrend(growing, 'GHOST'), { state: 'steady', perDay: 0, from: 0, to: 0 });

  // The window is the last `span` readings, measured over the days they cover.
  const long = Array.from({ length: 30 }, (_, d) => row(d, 10 + d, { APE: 10 + d }));
  assert.equal(censusTrend(long, 'APE', 7).perDay, 1);
  assert.equal(censusTrend(long, 'APE', 7).from, 30 - 7 + 10, 'it starts seven readings back');

  // Two rows for the same day cannot have a rate; the epsilon is only ever
  // compared against a real one.
  assert.equal(censusTrend([row(4, 9, { APE: 9 }), row(4, 3, { APE: 3 })], 'APE').state, 'unknown');
  assert.ok(TREND_EPSILON_PER_DAY > 0 && TREND_EPSILON_PER_DAY < 1, 'the dead band is under one creature per day');
});
