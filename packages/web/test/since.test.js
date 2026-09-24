/**
 * The "while you were away" diff.
 *
 * Every test here is a sentence the drawer is allowed to say about somebody's
 * standing, so the interesting cases are the ones where it must say nothing: a
 * whale they un-adopted themselves, a report that aged out of the server's window,
 * a stored row from before this shape existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_ORDER,
  SINCE_MAX,
  STANDING_V,
  diffStanding,
  sinceDay,
  standingSeed,
  trimSince,
} from '../src/since.js';

const ADDR = '0xAbC0000000000000000000000000000000000123';

/** A `/who` answer, shaped like the route's. Only the fields the diff reads. */
const who = (over = {}) => ({
  address: ADDR,
  known: true,
  burned: 100,
  burns: 4,
  rank: 3,
  cheer: null,
  pass: { active: true, until: 38400 },
  adoptions: [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: true }],
  reports: [{ tx: '0xaa', type: 'poison', atTick: 900, affected: 3, score: 12 }],
  badges: ['firstBurn'],
  ...over,
});

const seen = { tick: 1000, day: 2 };
const seed = (over) => standingSeed(who(over), seen);

const kinds = (items) => items.map((i) => i.kind);

test('no memory is not the same as a quiet spell', () => {
  assert.equal(diffStanding(null, seed()), null, 'a first visit has no baseline');
  assert.equal(diffStanding(seed(), null), null, 'the server said nothing');
  // A row written under an older shape must not be read field by field: the
  // honest answer is "no memory", not a list of changes that are version skew.
  assert.equal(diffStanding({ ...seed(), v: STANDING_V - 1 }, seed()), null, 'an old row is not a baseline');
  assert.equal(diffStanding(seed(), { ...seed(), v: 99 }), null, 'a row from the future is not a baseline either');
  // Two addresses in one comparison is a bug upstream, and every item computed
  // from it would be a claim about the wrong person.
  assert.equal(diffStanding(seed(), seed({ address: '0x0000000000000000000000000000000000000009' })), null);
  assert.equal(diffStanding({ ...seed(), address: '' }, seed()), null, 'a row that does not say whose it is');
});

test('the same standing twice says nothing happened', () => {
  const a = seed();
  assert.deepEqual(diffStanding(a, JSON.parse(JSON.stringify(a))), [], 'an empty diff, not no diff');
});

test('a whale that died is a death, and a whale that left the shelf is not', () => {
  const prev = seed();
  // Still listed, no longer alive: the tank took it.
  const dead = diffStanding(prev, seed({ adoptions: [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: false }] }));
  assert.deepEqual(kinds(dead), ['lost']);
  assert.equal(dead[0].id, 7);
  assert.equal(dead[0].name, 'MOBY-7');
  // Off the list altogether: they un-adopted it, which is not news about the tank.
  assert.deepEqual(diffStanding(prev, seed({ adoptions: [] })), [], 'a removed adoption is not a death');
  // Already gone last time: still not news.
  const was = standingSeed(who({ adoptions: [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: false }] }), seen);
  assert.deepEqual(diffStanding(was, seed({ adoptions: [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: false }] })), []);
  // The ring can forget a name and leave only `#id`; the death is still true.
  const forgotten = diffStanding(prev, seed({ adoptions: [{ id: 7, name: '#7', archetype: '', alive: false }] }));
  assert.deepEqual(kinds(forgotten), ['lost'], 'a forgotten name is not a forgotten death');
  assert.equal(forgotten[0].name, '#7');
});

test('a new adoption is news exactly once', () => {
  const prev = seed();
  const next = seed({
    adoptions: [
      { id: 7, name: 'MOBY-7', archetype: 'APE', alive: true },
      { id: 8, name: 'MOBY-8', archetype: 'WHALE', alive: true },
    ],
  });
  assert.deepEqual(kinds(diffStanding(prev, next)), ['added']);
  assert.deepEqual(kinds(diffStanding(next, next)), [], 'and it is not news a second time');
  // Born and dead between two looks: the shelf says it is not alive, and the
  // visitor never saw it living. One item, and it is not a `lost`.
  const blink = diffStanding(prev, seed({ adoptions: [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: true }, { id: 8, name: 'MOBY-8', archetype: 'WHALE', alive: false }] }));
  assert.deepEqual(kinds(blink), ['added'], 'a life nobody saw is not reported as a death');
});

test('a report is news when its tx is new, and an old one ageing out is not a loss', () => {
  const prev = standingSeed(who({
    reports: [
      { tx: '0xbb', type: 'feed', atTick: 800, affected: 2, score: 5 },
      { tx: '0xaa', type: 'poison', atTick: 900, affected: 3, score: 12 },
    ],
  }), seen);
  // The route shows the newest eight; the ninth older one simply stops arriving.
  const next = standingSeed(who({
    reports: [
      { tx: '0xcc', type: 'bloom', atTick: 1000, affected: 9, score: -4 },
      { tx: '0xbb', type: 'feed', atTick: 800, affected: 2, score: 5 },
      { tx: '0xaa', type: 'poison', atTick: 900, affected: 3, score: 12 },
    ],
  }), seen);
  const items = diffStanding(prev, next);
  assert.deepEqual(kinds(items), ['report']);
  assert.equal(items[0].tx, '0xcc');
  assert.equal(items[0].score, -4, 'a bad report is still a report');
  assert.deepEqual(diffStanding(next, prev), [], 'a report that aged out of the window is not a loss');
});

test('burn counts add up and never go negative', () => {
  const prev = seed();
  const up = diffStanding(prev, seed({ burns: 6, burned: 160 }));
  assert.deepEqual(kinds(up), ['burn']);
  assert.deepEqual({ n: up[0].n, amount: up[0].amount }, { n: 2, amount: 60 });
  assert.deepEqual(kinds(diffStanding(prev, seed({ burns: 4, burned: 100 }))), [], 'the same count is not news');
  assert.deepEqual(kinds(diffStanding(prev, seed({ burns: 3 }))), [], 'a count that went down is not negative news');
  // A row written before burns were counted can show spending with no new count.
  assert.deepEqual(diffStanding(prev, seed({ burns: 5, burned: 40 })), [{ kind: 'burn', n: 1, amount: 0 }]);
});

test('the pass is granted, extended or over — and unchanged is not a change', () => {
  const prev = seed();
  assert.deepEqual(kinds(diffStanding(prev, seed({ pass: { active: true, until: 57600 } }))), ['passTo']);
  assert.deepEqual(kinds(diffStanding(prev, seed({ pass: { active: true, until: 38400 } }))), []);
  assert.deepEqual(kinds(diffStanding(prev, seed({ pass: { active: false, until: null } }))), ['passGone']);
  const had = standingSeed(who({ pass: { active: false, until: null } }), seen);
  assert.deepEqual(kinds(diffStanding(had, seed())), ['passTo'], 'a renewal after an expiry is a grant');
  assert.deepEqual(kinds(diffStanding(had, had)), [], 'still expired is still nothing');
});

test('rank and cheer move in both directions, including from nowhere', () => {
  assert.deepEqual(kinds(diffStanding(seed(), seed({ rank: 2 }))), ['rank']);
  assert.deepEqual(kinds(diffStanding(seed(), seed({ rank: null }))), ['rank'], 'falling off the board is a change');
  assert.deepEqual(kinds(diffStanding(seed({ rank: null }), seed())), ['rank'], 'and arriving is one too');
  const down = diffStanding(seed(), seed({ rank: 12 }))[0];
  assert.deepEqual({ from: down.from, to: down.to }, { from: 3, to: 12 });
  assert.deepEqual(kinds(diffStanding(seed(), seed({ cheer: 'APE' }))), ['cheer']);
  assert.deepEqual(kinds(diffStanding(seed({ cheer: 'APE' }), seed({ cheer: 'WHALE' }))), ['cheer']);
  assert.deepEqual(kinds(diffStanding(seed({ cheer: 'APE' }), seed({ cheer: 'APE' }))), []);
});

test('the order is the one chosen, whatever arrived first', () => {
  const next = seed({
    burns: 9,
    burned: 900,
    rank: 1,
    cheer: 'APE',
    pass: { active: false, until: null },
    adoptions: [
      { id: 7, name: 'MOBY-7', archetype: 'APE', alive: false },
      { id: 8, name: 'MOBY-8', archetype: 'WHALE', alive: true },
    ],
    reports: [
      { tx: '0xcc', type: 'bloom', atTick: 1000, affected: 9, score: 1 },
      { tx: '0xaa', type: 'poison', atTick: 900, affected: 3, score: 12 },
    ],
  });
  const items = diffStanding(seed(), next);
  assert.deepEqual(kinds(items), ['lost', 'added', 'report', 'burn', 'passGone', 'rank', 'cheer']);
  // The claim the list rests on: every kind the diff can emit is in the order, and
  // the death is first because it is the one the visitor cannot undo.
  assert.deepEqual(kinds(items).filter((k) => !KIND_ORDER.includes(k)), []);
  assert.equal(KIND_ORDER.indexOf('lost'), 0);
});

test('the list is capped and says honestly how many fell off', () => {
  const items = diffStanding(seed(), seed({
    burns: 9,
    burned: 900,
    rank: 1,
    cheer: 'APE',
    pass: { active: false, until: null },
    adoptions: [
      { id: 7, name: 'MOBY-7', archetype: 'APE', alive: false },
      { id: 8, name: 'MOBY-8', archetype: 'WHALE', alive: true },
    ],
    reports: [
      { tx: '0xcc', type: 'bloom', atTick: 1000, affected: 9, score: 1 },
      { tx: '0xdd', type: 'feed', atTick: 1100, affected: 1, score: 0 },
    ],
  }));
  assert.equal(items.length, SINCE_MAX + 3, `the fixture needs ${SINCE_MAX + 3} changes to test the cap`);
  const t = trimSince(items);
  assert.equal(t.shown.length, SINCE_MAX);
  assert.equal(t.more, 3, 'the count of what is hidden is not a guess');
  assert.deepEqual(trimSince([]), { shown: [], more: 0 });
  assert.equal(trimSince(items.slice(0, 2)).more, 0, 'a short list hides nothing');
  assert.equal(trimSince(null).shown.length, 0, 'no diff at all is not a crash');
});

test('the seed reads the route answer, and an empty one', () => {
  const s = standingSeed(who(), seen);
  assert.equal(s.v, STANDING_V);
  assert.equal(s.address, ADDR.toLowerCase(), 'the address is stored the way the tank keys it');
  assert.equal(s.seenTick, 1000);
  assert.equal(s.seenDay, 2);
  assert.deepEqual(s.adopted, [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: true }]);
  assert.equal(s.reports.length, 1);
  // A route answer about an address nobody has ever paid: every field absent.
  const blank = standingSeed({ address: '0x09' }, {});
  assert.equal(blank.burned, 0);
  assert.equal(blank.passUntil, 0);
  assert.equal(blank.seenTick, null, 'no snapshot yet is not tick 0');
  assert.deepEqual(blank.adopted, []);
  assert.deepEqual(diffStanding(blank, blank), [], 'and two such rows differ in nothing');
  assert.doesNotThrow(() => standingSeed(undefined, undefined));
});

test('a pass is spoken of in days, or not at all', () => {
  assert.equal(sinceDay(38400, 19200), 2);
  assert.equal(sinceDay(38500, 19200), 2, 'part of a day is not a whole one');
  assert.equal(sinceDay(null, 19200), null);
  assert.equal(sinceDay(38400, 0), null, 'a day length of zero is not a divisor');
});
