import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// One page per process, and this file spends its one boot on the honest success
// path: the book has two stamped days with two distinct hashes, every `/verify`
// answers `verified`, so a completed sweep is two intact and zero everywhere else.
// The all-failure path is its own file (`sweep-fail-boot.test.js`), and the pure
// tier arithmetic is `sweep.test.js` — this file is only about the *wiring*: that a
// click reaches the wire, asks once per distinct hash, and paints the tally.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('the whole-book sweep asks the route once per stamped day and tallies them intact', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics' });
  t.after(() => page.close());
  const { document } = page;

  const panel = document.getElementById('census-sweep');
  assert.ok(panel, 'the census card has a whole-book sweep container');
  // Two stamped rows (day 0 and day 4) in the fixture book, so there is something
  // to ask about: the panel is visible and offers the button, and nothing has been
  // requested yet — an idle book is not a checked book.
  assert.equal(panel.hidden, false, 'a book with a stamped day shows the sweep affordance');
  assert.ok(panel.className.includes('sweep-idle'), 'and it starts idle');
  assert.equal(page.reqs.verify, 0, 'idle has asked the route zero times');
  const btn = panel.querySelector('button[data-sweep]');
  assert.ok(btn, 'the idle panel offers a button, not a tally');

  btn.click();
  await page.sleep(1500);

  // Two distinct hashes means exactly two requests: the dedup in `stampedHashes`
  // asked each once, and a mutation that drops the fetch (or short-circuits to a
  // local "verified") fails here rather than painting a green with no wire behind
  // it.
  assert.equal(page.reqs.verify, 2, 'asked the route once per distinct stamped hash');
  assert.ok(panel.className.includes('sweep-done'), 'the pass settled into done');

  const num = (sel) => panel.querySelector(sel)?.textContent ?? '';
  assert.match(num('.sw-intact'), /2/, 'both stamped days came back intact');
  assert.match(num('.sw-problems'), /0/, 'nothing was wrong');
  assert.match(num('.sw-cannotSay'), /0/, 'and nothing was unanswerable');
  assert.match(num('.sw-unchecked'), /0/, 'nothing was left unchecked — the pass drained');
  assert.ok(panel.querySelector('button[data-sweep]'), 'a finished sweep offers to run again');
});
