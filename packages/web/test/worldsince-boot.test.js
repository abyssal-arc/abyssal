/**
 * The world's "while you were away", end to end.
 *
 * `test/worldsince.test.js` proves the arithmetic. This proves the three things a
 * diff cannot get wrong on its own: that the browser's memory is read *before* it
 * is overwritten, that it is not spent on a card nobody opened, and that the story
 * is not told twice. (`test/worldsince-link.test.js` is the same stage reached from
 * a URL instead of a click, with the other half of the sentences — one process can
 * only host one page, which `harness.js` now refuses to pretend otherwise about.)
 *
 * The book below is written out by hand rather than produced by `worldSeed`, for
 * the same reason the standing test does it: a fixture built by the code under test
 * agrees with it no matter how wrong they both are. `censusRow` is used for the
 * row shape only — the population of each row is its headcount summed, which is
 * how the server publishes it, and the `changes` list is that derivation written
 * out rather than recomputed here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census, censusRow } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('the world while you were away', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

/**
 * What this browser last saw: day 1, eight heads across four species, and that
 * day's commitment on chain. Day 1 is also the floor of the window served below,
 * which is the point — a memory that still has a row under it is not a trimmed
 * one, and the sentence has to know the difference.
 */
const MEMORY = {
  v: 1,
  lastDay: 1,
  population: 8,
  byArchetype: { APE: 4, WHALE: 1, ALGO: 2, INSIDER: 1 },
  anchoredThrough: 1,
  coverageFirst: 1,
};

/** The four days the server answers with now: an APE lost, INSIDER gone, CRAB in. */
const ROWS = [
  censusRow(1, { APE: 4, WHALE: 1, ALGO: 2, INSIDER: 1 }, `0x${'cc'.repeat(32)}`),
  censusRow(2, { APE: 3, WHALE: 1, ALGO: 2, INSIDER: 1 }),
  censusRow(3, { APE: 3, WHALE: 2, ALGO: 1 }),
  censusRow(4, { APE: 2, WHALE: 2, ALGO: 1, CRAB: 1 }, `0x${'dd'.repeat(32)}`),
];

const BOOK = {
  cap: census.cap,
  book: ROWS.length,
  coverage: { first: 1, last: 4, days: ROWS.length },
  hashed: census.hashed,
  rows: ROWS,
  // The server's derivation from the rows above, by hand: a species is `lost` the
  // day its count reaches nothing and `gained` the day it first appears, so the
  // APE shrinking from 4 to 3 is neither and must not show up here.
  changes: [
    { day: 2, tick: 38400, population: 7, populationDelta: -1, born: 7, died: 8, predations: 3, lost: [], gained: [] },
    { day: 3, tick: 57600, population: 6, populationDelta: -1, born: 6, died: 7, predations: 4, lost: ['INSIDER'], gained: [] },
    { day: 4, tick: 76800, population: 6, populationDelta: 0, born: 14, died: 10, predations: 6, lost: [], gained: ['CRAB'] },
  ],
  today: census.today,
};

/** The six sentences that book is worth against that memory, worst news first. */
const NEWS = [
  'INSIDER went extinct',
  '3 days closed · day 1 → day 4',
  'population 8 → 6',
  'CRAB first counted',
  'newest day confirmed on chain 1 → 4',
  // Three of five species are named — the biggest move first, then the alphabet —
  // and the remainder is counted, because a line that quietly dropped two of them
  // would be a shorter lie rather than no lie.
  'headcounts moved · APE 4→2, ALGO 2→1, CRAB 0→1 · +2 more species',
];

const KEY = 'abyssal-worldsince';
const click = (page) => page.document.getElementById('dock-analytics')
  .dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
const lines = (el) => [...el.querySelectorAll('.census-row')].map((r) => r.textContent.trim());
const remember = (page) => JSON.parse(page.window.localStorage.getItem(KEY));

test('opening the card compares the book with the memory of the last one', async (t) => {
  const page = await boot({ worldSince: MEMORY, book: BOOK });
  t.after(() => page.close());
  const { document } = page;

  // Boot fetches the book with the card shut, and a baseline written down then
  // would leave nothing to answer the question when the visitor finally asks it.
  assert.deepEqual(remember(page), MEMORY, 'the memory was spent on a fetch nobody saw');

  click(page);
  const el = document.getElementById('census-worldsince');
  assert.equal(el.hidden, false, 'the book arrived but the memory of it did not');
  assert.equal(el.querySelector('.ms-head').textContent, 'While the tank was unwatched · since day 1');
  assert.deepEqual(lines(el), NEWS);
  // The card keeps stating what is true now, underneath: three of the five species
  // the memory named are still there, and the block did not replace the window.
  assert.equal(document.getElementById('census-coverage').textContent, '4 days kept · day 1 to day 4');

  const after = remember(page);
  assert.equal(after.lastDay, 4, 'the new answer was never written down');
  assert.equal(after.anchoredThrough, 4);
  assert.deepEqual(after.byArchetype, { APE: 2, WHALE: 2, ALGO: 1, CRAB: 1 });
  assert.equal(after.coverageFirst, 1, 'the window floor is not the oldest row in memory');

  // Closing and reopening asks the same question of a book that has not moved.
  click(page);
  click(page);
  assert.equal(el.hidden, false);
  assert.equal(el.querySelector('.ms-head').textContent, 'While the tank was unwatched · since day 4');
  assert.deepEqual(lines(el), ['No day has closed since your last look.']);
  assert.equal(page.reqs.census, 1, 'reopening the card went back to the server for a book that cannot have changed');

  // A visitor with no memory is not a visitor in a quiet tank. Emptying the shelf
  // is the only way to reach that state on a second look — the app has to be told
  // the browser is new, because from its side it is.
  page.window.localStorage.removeItem(KEY);
  click(page);
  click(page);
  assert.equal(el.hidden, true, 'the block spoke without a memory to speak from');
  assert.equal(el.innerHTML, '');
  // And the visit still leaves a baseline behind, or the next one is a first visit too.
  assert.equal(remember(page).lastDay, 4, 'a first visit left nothing for the next one to compare with');
});
