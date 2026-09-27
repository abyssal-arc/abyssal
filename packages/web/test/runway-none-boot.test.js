import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The default, and the reason the panel is `hidden` in the markup rather than an
// empty box: on every boot that never gets an anchor block from `/health` — which is
// every other test in this directory — the runway must say nothing at all. Not a
// zero, not a placeholder, not a stale "funded" from a request that returned no
// money fields. Silence is the correct rendering of "we have not read the chain's
// finances", and it is the one state that must survive the fetch existing but
// answering empty.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a boot with no anchor economics leaves the runway hidden and empty', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  // No `health` option: `/health` answers `{}`, exactly as it does for every other
  // boot in this folder.
  const page = await boot({ focusSearch: '?view=world&drawer=analytics' });
  t.after(() => page.close());
  const { document } = page;

  const el = document.getElementById('day-runway');
  assert.ok(el, 'the slot exists in the markup');
  assert.equal(page.reqs.health, 1, 'the poll still fired — it just had nothing to show');
  assert.equal(el.hidden, true, 'an empty answer keeps it hidden, not filled with a zero');
  assert.equal(el.innerHTML, '', 'and empty, not carrying placeholder text');
});
