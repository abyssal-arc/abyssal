/**
 * The same story, reached from a URL instead of a click.
 *
 * `test/worldsince-boot.test.js` opens the card by hand. A forwarded
 * `?drawer=analytics` opens it during boot, which puts the memory check on the
 * other side of the book's arrival: the drawer is already there when
 * `applyFocus()` runs, and the day book lands a moment later. That ordering is
 * where a block like this goes quiet — compare before the fetch, and there is
 * nothing to compare; compare inside it, and whoever wrote the link sees a
 * different page than the one they meant to send.
 *
 * This page also carries the two sentences the click page cannot: a span that ran
 * past the floor of the window, and a first-ever confirmation. Both need a
 * different book, and one process can only host one page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census, censusRow } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('the world while you were away, by link', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

/**
 * The visitor's memory: day 200, five APE, nothing on chain that they ever saw a
 * transaction for, and a window that began at day 190.
 */
const MEMORY = {
  v: 1,
  lastDay: 200,
  population: 5,
  byArchetype: { APE: 5 },
  anchoredThrough: null,
  coverageFirst: 190,
};

/** The book now: day 210 and 211, both confirmed, and ten days in between gone. */
const ROWS = [
  censusRow(210, { APE: 4, CRAB: 1 }, `0x${'aa'.repeat(32)}`),
  censusRow(211, { APE: 4, CRAB: 1 }, `0x${'bb'.repeat(32)}`),
];

const BOOK = {
  cap: census.cap,
  book: ROWS.length,
  coverage: { first: 210, last: 211, days: ROWS.length },
  hashed: census.hashed,
  rows: ROWS,
  // Nothing, and that is the true answer: the days the visitor missed are not in
  // the book any more, so no extinctions and no emergences can be derived for
  // them. The sentence below has to say the days are missing rather than quiet.
  changes: [],
  today: { ...ROWS[ROWS.length - 1], committed: true },
};

test('a shared link tells the visitor what closed since they last looked', async (t) => {
  const page = await boot({ focusSearch: '?drawer=analytics', worldSince: MEMORY, book: BOOK });
  t.after(() => page.close());

  // No click in this test: the link is the click.
  const el = page.document.getElementById('census-worldsince');
  assert.equal(page.document.getElementById('drawer-analytics').hidden, false, 'the link did not open the card');
  assert.equal(el.hidden, false, 'the card opened and the memory beside it stayed shut');
  assert.equal(el.querySelector('.ms-head').textContent, 'While the tank was unwatched · since day 200');
  assert.deepEqual([...el.querySelectorAll('.census-row')].map((r) => r.textContent.trim()), [
    '11 days closed · day 200 → day 211, 10 of them no longer in the book',
    'the book holds a confirming transaction · day 211',
    'headcounts moved · APE 5→4, CRAB 0→1',
  ]);
  // The card keeps stating what is true now, right above the sentences about the
  // gap: two days in the window, day 210 through day 211. A block that replaced
  // that line with "since day 200" would be reporting the memory rather than the
  // tank.
  assert.equal(
    page.document.getElementById('census-coverage').textContent,
    '2 days kept · day 210 to day 211',
    'the block replaced the book it sits under',
  );
  assert.equal(page.reqs.census, 1, 'the boot fetch and the opened drawer asked for the book twice');
  assert.equal(JSON.parse(page.window.localStorage.getItem('abyssal-worldsince')).coverageFirst, 210);
});
