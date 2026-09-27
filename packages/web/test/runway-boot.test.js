import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The runway's happy path, drawn from a real `/health` anchor. The numbers are the
// live ones read off `https://www.abyssal-arc.com/health` — 32,612 days of fees
// already paid for, an alarm below 90, a reading 2,020 seconds old — so this is a
// wiring test against the shape the route actually puts on the wire, not a made-up
// body. What it proves that the pure `runway.test.js` cannot: that `runwayView`'s
// output reaches the DOM as a visible, correctly-labelled line with the number
// grouped and the threshold beside it, and that getting there costs exactly one
// `/health` request at boot.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

const HEALTH = {
  anchor: {
    readAt: 1790506411592,
    ageSeconds: 2020,
    runway: { anchors: 32612, unknown: null, alarmBelow: 90, low: false, capped: false },
  },
};

test('a funded runway paints a grouped day count, its threshold, and its age', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', health: HEALTH });
  t.after(() => page.close());
  const { document } = page;

  const el = document.getElementById('day-runway');
  assert.ok(el, 'the analytics drawer has a runway slot beside the day digest');
  assert.equal(el.hidden, false, 'a health answer unhides it');
  assert.match(el.className, /\bdr-ok\b/, 'a comfortable runway carries the ok tone');

  const text = el.textContent;
  assert.match(text, /Anchor runway/, 'the line says what it is measuring');
  // The grouping lives in `app.js` (`group()`), not in the pure view, so this is the
  // only place the "32,612" vs "32612" claim can be checked.
  assert.match(text, /32,612/, 'the day count is grouped for reading');
  assert.doesNotMatch(text, /32612[^,]/, 'and not left as a raw run of digits');
  assert.match(text, /alarm below 90/, 'the threshold the server set is shown beside it');
  assert.match(text, /2020s/, 'and the age of the reading, so "funded" is not mistaken for live');

  // One pull at boot; the 60s interval cannot have fired inside the 1.2s the page
  // was up. A dropped fetch would read 0, and this is the request the whole panel
  // depends on.
  assert.equal(page.reqs.health, 1, 'boot reads /health exactly once for this');
});
