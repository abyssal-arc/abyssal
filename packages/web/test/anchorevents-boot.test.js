import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, censusRow, census, RENDER_DEPS_MISSING } from './harness.js';

// One page per process, and this one boot spends itself on the three ways an
// extinction or an emergence can be anchored, told apart by which row carries a
// transaction:
//   - INSIDER is gone by day 1 and the day it was last counted (day 0) IS on
//     chain, so its loss earns a `verify` deep link to day 0 — not to day 1;
//   - CRAB first appears at day 2 and that day is on chain, so its gain links to
//     its own day 2;
//   - WHALE first appears at day 3, which is NOT stamped, so its gain says the
//     claim is not on chain yet rather than linking to nothing.
// The pure tier logic is `census.test.js`; this file is only about the wiring —
// that the anchors reach the DOM as links and notes, with the right day in the
// right one.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

const ROWS = [
  censusRow(0, { APE: 2, INSIDER: 1 }, `0x${'a'.repeat(64)}`),
  censusRow(1, { APE: 2 }, `0x${'b'.repeat(64)}`),
  censusRow(2, { APE: 2, CRAB: 1 }, `0x${'c'.repeat(64)}`),
  censusRow(3, { APE: 2, CRAB: 1, WHALE: 1 }),
];

const BOOK = {
  ...census,
  book: ROWS.length,
  coverage: { first: 0, last: 3, days: ROWS.length },
  rows: ROWS,
  changes: [
    { day: 1, lost: ['INSIDER'], gained: [] },
    { day: 2, lost: [], gained: ['CRAB'] },
    { day: 3, lost: [], gained: ['WHALE'] },
  ],
  today: (() => {
    const { hash: _hash, ts: _ts, v: _v, ...reading } = ROWS[ROWS.length - 1];
    return { ...reading, committed: false };
  })(),
};

test('an extinction links to the last on-chain reading, a gain to its own, and an unstamped gain says so', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', book: BOOK });
  t.after(() => page.close());
  const { document } = page;

  const events = document.getElementById('census-events');
  assert.ok(events, 'the census card has an events list');

  const rowFor = (species) => [...events.querySelectorAll('.census-row')].find((r) => r.textContent.includes(species));
  const linkFor = (species) => rowFor(species)?.querySelector('a.ce-anchor') ?? null;

  // The extinction anchors to the PREVIOUS stamped reading (day 0), and not to the
  // day it went extinct (day 1) — which is the whole claim of the feature.
  const insider = linkFor('INSIDER');
  assert.ok(insider, 'a loss whose last-counted day is on chain grows an anchor link');
  assert.match(insider.getAttribute('href'), /[?&]day=0(&|$)/, 'the link pins the day the species was last counted');
  assert.match(insider.getAttribute('href'), /[?&]verify=1(&|$)/, 'and asks the recipient to re-check it on arrival');
  assert.doesNotMatch(insider.getAttribute('href'), /day=1/, 'not the day it vanished — that reading has no creature to point at');
  assert.match(insider.textContent, /last counted day 0/, 'a loss names the day it was last counted, in words');

  // The emergence anchors to its OWN stamped day (day 2).
  const crab = linkFor('CRAB');
  assert.ok(crab, 'a first-counting on a stamped day is anchored to that day');
  assert.match(crab.getAttribute('href'), /[?&]day=2(&|$)/, 'a gain points at its own day, not the reading before it');
  assert.match(crab.textContent, /check it on chain/, 'a gain invites the reader to re-check its own day');

  // The unstamped emergence is stated as unanchored, with a note and no link — the
  // honest third case, neither a fake green link nor a silently dropped line.
  const whale = rowFor('WHALE');
  assert.ok(whale, 'the unstamped emergence is still listed');
  assert.equal(linkFor('WHALE'), null, 'a claim with no on-chain day gets no link');
  assert.ok(whale.querySelector('.ce-anchor-none'), 'and says it is not on chain yet in words');

  // Exactly the two stamped claims are links and exactly the one unstamped is a note.
  assert.equal(events.querySelectorAll('a.ce-anchor').length, 2, 'two stamped anchors, no more');
  assert.equal(events.querySelectorAll('.ce-anchor-none').length, 1, 'one unanchored claim');

  // The anchors are passive: nothing about rendering the book asks the chain. A
  // verify only happens when a reader opens one of these links.
  assert.equal(page.reqs.verify, 0, 'painting anchors fetches nothing — they are links, not checks');
});
