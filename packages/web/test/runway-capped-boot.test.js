import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The capped branch: a balance so large relative to the last measured cost that the
// server clamps the quotient instead of returning a number it knows is meaningless.
// The honest rendering is "funding is not the limit" — not a giant figure that reads
// like a precise promise, not the ordinary funded sentence with a made-up number in
// it. This pins that the client trusts the `capped` flag over the raw `anchors` value
// sitting next to it.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

const HEALTH = {
  anchor: {
    readAt: 1790506411592,
    ageSeconds: 30,
    runway: { anchors: 812345, unknown: null, alarmBelow: 90, low: false, capped: true },
  },
};

test('a capped runway refuses to print a number and says funding is not the limit', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', health: HEALTH });
  t.after(() => page.close());
  const { document } = page;

  const el = document.getElementById('day-runway');
  assert.equal(el.hidden, false, 'a capped reading is still informative, not hidden');
  assert.match(el.className, /\bdr-capped\b/, 'the capped tone, above low and ok in precedence');
  const text = el.textContent;
  assert.match(text, /funding is not the limit/, 'in words');
  assert.doesNotMatch(text, /812,345/, 'the clamped quotient is never shown as if it were a real count');
  assert.doesNotMatch(text, /days of commitment funded/, 'and not dressed in the ordinary funded sentence');
});
