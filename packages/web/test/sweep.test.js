import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepTally, SWEEP_TIERS } from '../src/sweep.js';
import { VERIFY_STATES } from '../src/verify.js';

/** One row; `txHash` present only when the day actually went on chain. */
const row = (day, txHash) => (txHash ? { day, txHash } : { day });
/** The four tiers plus the two scalars the invariant is read from. */
const pick = (t) => ({
  rows: t.rows, stamped: t.stamped,
  intact: t.intact, problems: t.problems, cannotSay: t.cannotSay, unchecked: t.unchecked,
  done: t.done,
});

test('an empty book tallies to every zero, and counts itself done', () => {
  const t = sweepTally([], new Map());
  assert.deepEqual(pick(t), {
    rows: 0, stamped: 0, intact: 0, problems: 0, cannotSay: 0, unchecked: 0, done: true,
  });
});

test('a row with no txHash is not a stamped row — it is not counted anywhere', () => {
  // Two uncommitted days and one committed, verified. `rows` sees all three; only
  // the one that went on chain is a candidate for anything.
  const t = sweepTally([row(0), row(1, '0xa1'), row(2)], new Map([['0xa1', 'verified']]));
  assert.equal(t.rows, 3, 'the book had three rows');
  assert.equal(t.stamped, 1, 'only the one with a hash could have been checked');
  assert.equal(t.intact, 1);
  assert.equal(t.problems + t.cannotSay + t.unchecked, 0);
});

test('the four tiers always add up to the stamped count', () => {
  // Every state at once, across rows that also include unhashed and unchecked ones,
  // so the sum is exercised against a non-trivial stamped total.
  const rows = [
    row(0, '0x00'), // not in the map -> unchecked
    row(1), // no hash -> not stamped
    row(2, '0x02'), row(3, '0x03'), row(4, '0x04'), row(5, '0x05'),
    row(6, '0x06'), row(7, '0x07'), row(8, '0x08'), row(9, '0x09'),
    row(10, '0x0a'), row(11, '0x0b'),
  ];
  const states = new Map([
    ['0x02', 'verified'],
    ['0x03', 'mismatch'], ['0x04', 'not-found'], ['0x05', 'unreadable'],
    ['0x06', 'uncheckable'], ['0x07', 'unknown'], ['0x08', 'pending'],
    ['0x09', 'client-error'], ['0x0a', 'shape-unknown'], ['0x0b', 'loading'],
  ]);
  const t = sweepTally(rows, states);
  assert.equal(t.stamped, 11, 'ten mapped hashes plus the one unmapped (0x00), and the unhashed row excluded');
  assert.equal(t.intact, 1);
  assert.equal(t.problems, 3);
  assert.equal(t.cannotSay, 5);
  // 0x00 is genuinely unmapped, 0x0b (`loading`) has no tier and is refused as
  // "not accounted for" — both land in `unchecked`, never silently promoted.
  assert.equal(t.unchecked, 2);
  assert.equal(t.intact + t.problems + t.cannotSay + t.unchecked, t.stamped);
  assert.equal(t.done, false, 'an unchecked row means the sweep has not finished asking');
});

test('the whole verdict vocabulary lands in exactly one tier each', () => {
  // VERIFY_STATES is the reverse-guard list from verify.js; anything that ever
  // reaches the per-row widget can reach the sweep, so each must be filed. This
  // test enumerates them against the source of truth so a new verdict added to
  // `verify.js` without a tier here fails loudly rather than defaulting to green.
  const expect = {
    verified: 'intact',
    mismatch: 'problems', 'not-found': 'problems', unreadable: 'problems',
    uncheckable: 'cannotSay', unknown: 'cannotSay', pending: 'cannotSay',
    'client-error': 'cannotSay', 'shape-unknown': 'cannotSay',
    loading: 'unchecked', // in flight is "we have not looked yet", not "we could not tell"
  };
  for (const state of VERIFY_STATES) {
    assert.ok(state in expect, `${state} is in VERIFY_STATES but this test has no expectation for it`);
    const t = sweepTally([row(0, '0xhh')], new Map([['0xhh', state]]));
    const tier = expect[state];
    assert.equal(t[tier], 1, `${state} must file under ${tier}`);
    for (const other of SWEEP_TIERS) {
      if (other === tier) continue;
      assert.equal(t[other], 0, `${state} must not also count under ${other}`);
    }
    assert.equal(t.intact + t.problems + t.cannotSay + t.unchecked, t.stamped);
  }
});

test('nothing unverifiable is folded into the intact count', () => {
  // The specific lie: `verified / total` that quietly buries the rows a node never
  // answered. Every "cannot say" state must leave `intact` at zero even though a
  // naive fraction would call them "checked, move along".
  for (const state of ['uncheckable', 'unknown', 'pending', 'client-error', 'shape-unknown']) {
    const t = sweepTally([row(0, '0xhh')], new Map([['0xhh', state]]));
    assert.equal(t.intact, 0, `${state} is not evidence the bytes are intact`);
    assert.equal(t.cannotSay, 1, `${state} is its own honest tier`);
    assert.equal(t.problems, 0, `${state} is not evidence something is wrong either`);
  }
});

test('a done sweep is one with nothing left unchecked', () => {
  const all = new Map([['0xa', 'verified'], ['0xb', 'mismatch'], ['0xc', 'unknown']]);
  assert.equal(sweepTally([row(0, '0xa'), row(1, '0xb'), row(2, '0xc')], all).done, true);
  // Even one stamped row without an answer flips it — an interrupted pass is not a
  // book with nothing wrong in it.
  assert.equal(sweepTally([row(0, '0xa'), row(1, '0xunmapped')], all).done, false);
});

test('the counts breakdown is per-state, not just per-tier', () => {
  // `counts` is what lets the UI say "3 mismatch, 1 not-found" instead of a bare
  // "4 problems"; a mismatch must not be counted as a not-found.
  const t = sweepTally(
    [row(0, '0xa'), row(1, '0xb'), row(2, '0xc'), row(3, '0xd')],
    new Map([['0xa', 'verified'], ['0xb', 'verified'], ['0xc', 'mismatch'], ['0xd', 'not-found']]),
  );
  assert.deepEqual(t.counts, { verified: 2, mismatch: 1, 'not-found': 1 });
});

test('a plain object is accepted where a Map is, and vice versa', () => {
  // `stateByHash` may be a Map (built during a live sweep) or a plain object (a
  // fixture); both lookups must be identical so no tier silently empties.
  const rows = [row(0, '0xa'), row(1, '0xb')];
  const viaMap = sweepTally(rows, new Map([['0xa', 'verified'], ['0xb', 'mismatch']]));
  const viaObj = sweepTally(rows, { '0xa': 'verified', '0xb': 'mismatch' });
  assert.deepEqual(viaMap.counts, viaObj.counts);
  assert.equal(viaMap.intact, 1);
  assert.equal(viaObj.intact, 1);
  assert.equal(viaMap.problems, 1);
  assert.equal(viaObj.problems, 1);
});

test('a hash that is only an own key counts — inherited keys do not leak in', () => {
  // `hasOwnProperty` rather than `in`: a key that only resolves through the
  // prototype chain (`toString` lives on `Object.prototype`) must not be read as an
  // answer and file a genuinely-unchecked row under a tier.
  const t = sweepTally([row(0, '0xa'), row(1, 'toString')], { '0xa': 'verified' });
  assert.equal(t.stamped, 2);
  assert.equal(t.intact, 1, "'0xa' is an own key and is read");
  // 'toString' resolves through the prototype to a function if read with `in`; with
  // an own-key check it is undefined and stays unchecked.
  assert.equal(t.unchecked, 1, 'an inherited key must not be mistaken for an answer');
});

test('a non-array rows argument is treated as an empty book, not a crash', () => {
  for (const bad of [null, undefined, {}, 'nope', 42]) {
    const t = sweepTally(bad, new Map());
    assert.equal(t.rows, 0);
    assert.equal(t.stamped, 0);
    assert.equal(t.done, true);
  }
});

test('SWEEP_TIERS names the four tiers exactly once', () => {
  assert.deepEqual(SWEEP_TIERS, ['intact', 'problems', 'cannotSay', 'unchecked']);
  assert.equal(new Set(SWEEP_TIERS).size, SWEEP_TIERS.length);
});
