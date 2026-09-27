import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplay, revealThrough } from '../src/replay.js';

/** One pulse bucket, shaped like the `pulse` array in `abyssal-replay.json`. */
const p = (t, over = {}) => ({ t, count: 10, volume: 100, x402: 1, resolved: 10, ...over });
/** One USDC flow, shaped like the `flows` array in the same file. */
const f = (t, over = {}) => ({ t, amount: 5, from: '0xa', to: '0xb', venue: 'x402', x402: true, ...over });

test('a well-formed payload becomes one time-ordered timeline', () => {
  const r = buildReplay({
    pulse: [p(1000, { count: 3, volume: 40 }), p(3000, { count: 2, volume: 10 })],
    flows: [f(2000, { amount: 7 })],
  });
  assert.equal(r.empty, false);
  assert.equal(r.count, 3);
  assert.deepEqual(r.frames.map((x) => x.t), [1000, 2000, 3000], 'the merge is sorted by time');
  assert.deepEqual(r.frames.map((x) => x.kind), ['pulse', 'flow', 'pulse']);
  assert.equal(r.start, 1000);
  assert.equal(r.end, 3000);
  assert.equal(r.spanMs, 2000, 'the span is the last event minus the first');
});

test('two already-ordered arrays merge deterministically, pulse first on a tie', () => {
  // `pulse` and `flows` each arrive sorted but their interleaving does not; and on
  // an identical timestamp the tie must break the same way every run, or "the same
  // file replays the same" is not true.
  const r = buildReplay({ pulse: [p(500), p(500)], flows: [f(500), f(500)] });
  assert.deepEqual(r.frames.map((x) => x.kind), ['pulse', 'pulse', 'flow', 'flow']);
  assert.ok(r.frames.every((x) => x.t === 500));
});

test('a row with no usable timestamp is dropped and counted, never pinned to t=0', () => {
  // The lie this refuses: `Number('')` is 0, so coercing an undated row would place
  // an invented event at the very start of the window. Dropping to zero is exactly
  // what a careless merge does; counting it is what lets the player say "skipped".
  const r = buildReplay({
    pulse: [p(1000), { count: 5 }, p(2000)],   // the middle row has no `t`
    flows: [f(''), { t: null, amount: 3 }, f(1500)],
  });
  assert.equal(r.count, 3, 'only the three dated rows survive');
  assert.equal(r.dropped, 3, 'three undated rows are counted as skipped');
  assert.ok(r.frames.every((x) => Number.isFinite(x.t) && x.t > 0), 'nothing sits at an invented zero');
  assert.deepEqual(r.frames.map((x) => x.t), [1000, 1500, 2000]);
});

test('an empty timeline is its own state, not a zero-span busy window', () => {
  // A file with no events is not a file where a quiet market happened; `empty` is
  // the flag that keeps the two apart. The `NaN` rows leave nothing behind.
  const r = buildReplay({ pulse: [{ count: 1 }, { count: 2 }], flows: [] });
  assert.equal(r.empty, true);
  assert.equal(r.count, 0);
  assert.equal(r.start, null);
  assert.equal(r.end, null);
  assert.equal(r.dropped, 2, 'the rows that were thrown are still reported');
});

test('a missing or malformed payload is an empty timeline, not a crash', () => {
  for (const bad of [null, undefined, {}, 0, 'x', [], { pulse: 'nope', flows: 5 }]) {
    const r = buildReplay(bad);
    assert.equal(r.empty, true, `${JSON.stringify(bad)} cannot produce events`);
    assert.equal(r.count, 0);
    assert.equal(r.dropped, 0, 'a missing array is zero rows, not some malformed ones');
  }
});

test('totals fold the pulse transfers and volume, and count flows separately', () => {
  const r = buildReplay({
    pulse: [p(1000, { count: 120, volume: 9000.129 }), p(2000, { count: 80, volume: 99.871 })],
    flows: [f(1500), f(1600), f(1700)],
  });
  assert.equal(r.totals.pulses, 2);
  assert.equal(r.totals.flows, 3);
  assert.equal(r.totals.transfers, 200, 'transfers sum the pulse counts');
  assert.equal(r.totals.volume, 9100, 'volume is rounded to cents so float noise cannot show');
});

test('a single event has no span, and 0 there means none rather than an instant', () => {
  const r = buildReplay({ pulse: [p(1000)], flows: [] });
  assert.equal(r.count, 1);
  assert.equal(r.spanMs, 0);
  assert.equal(r.start, 1000);
  assert.equal(r.end, 1000);
});

test('flow fields keep their tri-state: an unresolved x402 is null, not false', () => {
  const r = buildReplay({ pulse: [], flows: [{ t: 100, amount: 1, from: '0xa', to: '0xb', venue: null, x402: null }] });
  const fr = r.frames[0];
  assert.equal(fr.kind, 'flow');
  assert.equal(fr.x402, null, 'a rail the feed never read is not the same as "read, not x402"');
  assert.equal(fr.venue, null);
});

test('revealThrough walks the timeline and reports what has run so far', () => {
  const r = buildReplay({
    pulse: [p(1000, { count: 100, volume: 5000 }), p(3000, { count: 50, volume: 1000 })],
    flows: [f(2000, { amount: 7 })],
  });
  const mid = revealThrough(r, 1);
  assert.equal(mid.index, 1);
  assert.equal(mid.t, 2000);
  assert.equal(mid.shown, 2, 'frames 0 and 1 are on screen');
  assert.equal(mid.pulses, 1, 'the 3000 bucket has not happened yet');
  assert.equal(mid.flows, 1);
  assert.equal(mid.transfers, 100);
  const last = revealThrough(r, 2);
  assert.equal(last.pulses, 2);
  assert.equal(last.transfers, 150);
});

test('revealThrough clamps a runaway cursor instead of reading off the end', () => {
  const r = buildReplay({ pulse: [p(1000), p(2000)], flows: [] });
  assert.equal(revealThrough(r, 999).index, 1, 'past the end lands on the last frame');
  assert.equal(revealThrough(r, -5).index, 0, 'before the start lands on the first');
  assert.equal(revealThrough(r, NaN).index, 0, 'an empty range input reads as NaN');
  assert.equal(revealThrough(r, 1.7).index, 1, 'a fractional cursor is truncated');
});

test('revealThrough on an empty timeline returns null, not a phantom frame 0', () => {
  assert.equal(revealThrough(buildReplay({ pulse: [], flows: [] }), 0), null);
  assert.equal(revealThrough(null, 0), null);
});
