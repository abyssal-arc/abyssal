/**
 * The rails panel's two coverage sentences.
 *
 * `test/observe-boot.test.js` proves the panel says them; this proves what entitles
 * it to. The case that matters most is the one that looks like nothing: a young
 * isolate whose ring holds no flows at all inside a window the pulse counted, where
 * the honest answer is "these rows cover none of it" and the tempting bug is a
 * falsy check that treats 0 as "nothing to report".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueCoverageNotes } from '../src/observe.js';

test('a window the rows only partly describe is described as partly covered', () => {
  // The first read of the six measured on the deployed feed at 03:48:33Z on
  // 2026-09-25: 453 ring flows inside a window of 2,098 transfers.
  assert.deepEqual(venueCoverageNotes({ windowFlows: 453, unattributed: 0 }, 2098), [
    { key: 'venueUnseen', args: { n: 453, total: 2098 } },
  ]);
});

test('a ring that holds nothing says so instead of staying quiet', () => {
  // 03:48:16Z on the same feed: 0 flows, 2,098 transfers. `held` being zero is the
  // shortest coverage possible, not an absence of information.
  assert.deepEqual(venueCoverageNotes({ windowFlows: 0, unattributed: 0 }, 2098), [
    { key: 'venueUnseen', args: { n: 0, total: 2098 } },
  ]);
});

test('the two shortfalls are two sentences, worst coverage first', () => {
  const notes = venueCoverageNotes({ windowFlows: 150, unattributed: 50 }, 900);
  assert.deepEqual(notes, [
    { key: 'venueUnseen', args: { n: 150, total: 900 } },
    { key: 'venueUnattributed', args: { n: 50 } },
  ]);
  // Flows the ring held but never resolved are the smaller claim, so a panel with
  // both says the big one first rather than letting a tidy `unattributed` number
  // stand in for a window nobody looked at.
  assert.equal(notes[0].key, 'venueUnseen');
});

test('a full ring and a read of every flow leave nothing to take back', () => {
  assert.deepEqual(venueCoverageNotes({ windowFlows: 900, unattributed: 0 }, 900), [], 'exact coverage');
  assert.deepEqual(venueCoverageNotes({ windowFlows: 0, unattributed: 0 }, 0), [], 'an empty window is covered');
});

test('a ring wider than the window is not reported as a negative shortfall', () => {
  // The two collections are summed in separate passes, so the ring can hold flows
  // the pulse total has not reached yet. Nothing is missing in that direction, and
  // "-47 transfers nobody saw" would be a number nobody could check.
  assert.deepEqual(venueCoverageNotes({ windowFlows: 900, unattributed: 0 }, 850), []);
});

test('unattributed counts on their own, when the coverage is complete', () => {
  assert.deepEqual(venueCoverageNotes({ windowFlows: 150, unattributed: 50 }, 150), [
    { key: 'venueUnattributed', args: { n: 50 } },
  ]);
  // Every flow the ring held unresolved is a different sentence from a window the
  // ring never held, and it still has to be said.
  assert.deepEqual(venueCoverageNotes({ windowFlows: 150, unattributed: 150 }, 150), [
    { key: 'venueUnattributed', args: { n: 150 } },
  ]);
});

test('a number the payload did not send is not answered with a claim', () => {
  const empty = [];
  assert.deepEqual(venueCoverageNotes(undefined, 900), empty, 'no coverage block at all');
  assert.deepEqual(venueCoverageNotes({}, 900), empty, 'a coverage block with neither number');
  assert.deepEqual(venueCoverageNotes({ windowFlows: 150, unattributed: 50 }, undefined), [
    { key: 'venueUnattributed', args: { n: 50 } },
  ], 'a missing heading takes away the comparison, not the other sentence as well');
  assert.deepEqual(venueCoverageNotes({ windowFlows: 150, unattributed: 0 }, null), [], 'and with no heading there is nothing to compare the ring against');
  // A value that is not a count is not a number with a different spelling here: the
  // sentence that needed it is dropped, and the one that did not is still said.
  assert.deepEqual(venueCoverageNotes({ windowFlows: '150', unattributed: 50 }, 900), [
    { key: 'venueUnattributed', args: { n: 50 } },
  ], 'a windowFlows that is not a number cannot be subtracted from anything');
  assert.deepEqual(venueCoverageNotes({ windowFlows: 150, unattributed: -3 }, 900), [
    { key: 'venueUnseen', args: { n: 150, total: 900 } },
  ], 'a negative count is not a shortfall of 3');
  assert.deepEqual(venueCoverageNotes({ windowFlows: NaN, unattributed: NaN }, NaN), empty);
});
