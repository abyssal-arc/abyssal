import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The honest negative, and a security boundary in one. When the runway cannot be
// computed the server sends back a `reason` sentence — text the browser does not
// write and cannot vouch for. The panel shows it (so "balance not read" and "no
// cost measured yet" stay distinguishable) but must show it as text: a reason that
// happened to carry markup has to arrive escaped, never live in the DOM. This boots
// a reason that is an actual XSS probe, and asserts the probe is inert.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

const HEALTH = {
  anchor: {
    readAt: 1790506411592,
    ageSeconds: 10,
    runway: {
      anchors: null,
      unknown: '<img src=x onerror=alert(1)>',
      alarmBelow: 90,
      low: false,
      capped: false,
    },
  },
};

test('an uncomputable runway says so and renders the server reason as text, never as markup', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', health: HEALTH });
  t.after(() => page.close());
  const { document } = page;

  const el = document.getElementById('day-runway');
  assert.equal(el.hidden, false, 'the refusal to give a number is itself shown');
  assert.match(el.className, /\bdr-unknown\b/, 'the unknown state carries its own tone');
  assert.doesNotMatch(el.className, /\bdr-ok\b/, 'and is never coloured as fine');

  // The probe must be data, not a live node.
  assert.equal(el.querySelector('img'), null, 'the server reason cannot inject an element');
  assert.match(el.textContent, /<img src=x onerror/, 'the probe is shown verbatim as text so a reader sees what the server actually said');
  assert.match(el.textContent, /runway unknown/, 'beside a plain statement that there is no number');
});
