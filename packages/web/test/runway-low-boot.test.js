import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The alarm path, and the reason the client trusts the server's `low` flag rather
// than recomputing a threshold: a number rendered in the watch colour is the whole
// point of making the runway public, and it has to flip on the flag the alarm is
// actually raised on. Here the account can still pay for 61 days but the server
// said `low` (the reading is under its 90-day line), so the panel must read as a
// warning while still telling the truth about the 61 that remain.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

const HEALTH = {
  anchor: {
    readAt: 1790506411592,
    ageSeconds: 15,
    runway: { anchors: 61, unknown: null, alarmBelow: 90, low: true, capped: false },
  },
};

test('a low runway flips to the watch tone but keeps naming the days left', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', health: HEALTH });
  t.after(() => page.close());
  const { document } = page;

  const el = document.getElementById('day-runway');
  assert.equal(el.hidden, false, 'a low reading is shown, not hidden away');
  assert.match(el.className, /\bdr-low\b/, 'the server flag, not a client threshold, picks the warning tone');
  assert.doesNotMatch(el.className, /\bdr-ok\b/, 'and it is no longer the comfortable tone');

  const text = el.textContent;
  assert.match(text, /61/, 'a warning still states how many days are funded');
  assert.match(text, /alarm below 90/, 'and the line the alarm sits on');
});
