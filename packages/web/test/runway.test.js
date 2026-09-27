import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runwayView, RUNWAY_STATES } from '../src/runway.js';

/** A `/health` `anchor` object; only the fields the view reads are needed. */
const anchor = (over = {}) => ({
  readAt: 1_790_506_411_592,
  ageSeconds: 2020,
  runway: { anchors: 32612, unknown: null, alarmBelow: 90, low: false, capped: false },
  ...over,
});

test('a cold start — no reading yet — says nothing about money', () => {
  // `neverRead` is not `unknown`: there is no number and no failed reading, only a
  // tank that has not confirmed a day yet. It must carry no reason and no age.
  const v = runwayView({ ...anchor(), readAt: 0, runway: { ...anchor().runway, anchors: null, unknown: 'balance not read' } });
  assert.equal(v.state, 'neverRead');
  assert.equal(v.anchors, null);
  assert.equal(v.reason, null, 'the server reason belongs to a state not reached yet');
  assert.equal(v.ageSeconds, null);
});

test('a missing anchor object is a cold start, not a crash', () => {
  for (const bad of [null, undefined, {}, 0, 'x']) {
    const v = runwayView(bad);
    assert.equal(v.state, 'neverRead');
    assert.equal(v.anchors, null);
  }
});

test('a real quotient with nothing wrong is `ok`', () => {
  const v = runwayView(anchor());
  assert.equal(v.state, 'ok');
  assert.equal(v.anchors, 32612);
  assert.equal(v.alarmBelow, 90);
  assert.equal(v.ageSeconds, 2020, 'the age of the reading rides beside the number');
  assert.equal(v.reason, null);
});

test('a quotient under the threshold is `low`, the one state that warns', () => {
  const v = runwayView(anchor({ runway: { anchors: 50, unknown: null, alarmBelow: 90, low: true, capped: false } }));
  assert.equal(v.state, 'low');
  assert.equal(v.anchors, 50);
  // The client reports the server's verdict rather than re-deriving the threshold:
  // a payload that says `low` while its number sits ABOVE `alarmBelow` is the server
  // telling us something a local `anchors < alarmBelow` would contradict, and it must
  // stand. Without this line, mutating the check to a recompute would keep every
  // other `low` fixture agreeing and the defect would hide.
  assert.equal(runwayView(anchor({ runway: { anchors: 5000, unknown: null, alarmBelow: 90, low: true, capped: false } })).state, 'low',
    'the `low` flag is trusted even where a re-derived comparison would say otherwise');
});

test('a ceiling-clamped quotient is `capped`, a lower bound not an exact count', () => {
  const v = runwayView(anchor({ runway: { anchors: Number.MAX_SAFE_INTEGER, unknown: null, alarmBelow: 90, low: false, capped: true } }));
  assert.equal(v.state, 'capped');
  assert.equal(v.anchors, Number.MAX_SAFE_INTEGER);
});

test('a reading that produced no quotient is `unknown`, and the reason is surfaced verbatim', () => {
  // The dishonesty this guards: colouring a failed reading as `ok` would keep the
  // reader sailing past an empty account. A reason must come through and it must
  // not be green.
  const v = runwayView(anchor({ runway: { anchors: null, unknown: 'no anchor cost measured yet', alarmBelow: 90, low: false, capped: false } }));
  assert.equal(v.state, 'unknown');
  assert.equal(v.anchors, null);
  assert.equal(v.reason, 'no anchor cost measured yet');
});

test('an unknown with no reason string still says so, without inventing a number', () => {
  const v = runwayView(anchor({ runway: { anchors: null, alarmBelow: 90 } }));
  assert.equal(v.state, 'unknown');
  assert.equal(v.anchors, null);
  assert.equal(v.reason, 'no runway published');
});

test('a runway field that is not a finite number is `unknown`, never `0`', () => {
  // A string quotient, a NaN, or an Infinity is "no trustworthy number" — reading
  // any of them as zero would report a run out of money that the chain did not say.
  for (const junk of ['1638', NaN, Infinity, -Infinity, undefined]) {
    const v = runwayView(anchor({ runway: { anchors: junk, unknown: 'not a number', alarmBelow: 90 } }));
    assert.equal(v.state, 'unknown', `${String(junk)} is not a finite quotient`);
    assert.equal(v.anchors, null);
  }
});

test('a missing runway sub-object on a read day is `unknown`, not a crash', () => {
  const v = runwayView({ readAt: 1, ageSeconds: 3 });
  assert.equal(v.state, 'unknown');
  assert.equal(v.anchors, null);
});

test('precedence: no number beats capped beats low', () => {
  // anchors null wins over low/capped flags; a capped reading wins over low (and the
  // two cannot co-occur in real payloads, but the code must not pick `low` first).
  assert.equal(runwayView(anchor({ runway: { anchors: null, low: true, capped: true, unknown: 'x', alarmBelow: 90 } })).state, 'unknown');
  assert.equal(runwayView(anchor({ runway: { anchors: 7, low: true, capped: true, alarmBelow: 90 } })).state, 'capped');
});

test('alarmBelow is carried when present and null when the payload omits it', () => {
  assert.equal(runwayView(anchor({ runway: { anchors: 5 } })).alarmBelow, null);
});

test('RUNWAY_STATES names the five states once, in rank order', () => {
  assert.deepEqual(RUNWAY_STATES, ['neverRead', 'unknown', 'capped', 'low', 'ok']);
  assert.equal(new Set(RUNWAY_STATES).size, RUNWAY_STATES.length);
});
