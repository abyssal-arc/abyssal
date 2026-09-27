import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The reading exists but has never happened: `/health` returns an anchor block whose
// `readAt` is 0, meaning the signer's balance has not been looked at once since the
// worker started. That is NOT the same as zero days of runway — a tank two months old
// with no reading is a different fact than one the chain has emptied — so the panel
// says "no funding reading yet" rather than folding the unknown into a scary 0. This
// pins the branch that refuses to invent a number where there is none.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

const HEALTH = {
  anchor: {
    readAt: 0,
    ageSeconds: 0,
    runway: { anchors: 0, unknown: null, alarmBelow: 90, low: false, capped: false },
  },
};

test('an anchor block that has never been read says so without pretending the runway is zero', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', health: HEALTH });
  t.after(() => page.close());
  const { document } = page;

  const el = document.getElementById('day-runway');
  assert.equal(el.hidden, false, 'a never-read anchor is still worth telling the reader');
  assert.match(el.className, /\bdr-neverRead\b/, 'the cold-start state, distinct from a measured low');
  const text = el.textContent;
  assert.match(text, /no funding reading yet/, 'in words, not a number');
  assert.doesNotMatch(text, /days of commitment funded/, 'and not the funded sentence a real quotient earns');
});
