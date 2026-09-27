import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// A file that has no playable events is shown as itself, not as a scrubber parked at
// zero. This is the misreading the loader exists to prevent: an empty timeline drawn
// as a quiet window is a lie about the chain, so the player must say "no events" and
// must NOT present a runnable range.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a file with no usable events reads as empty, not as a quiet window', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=observe', observeLive: true });
  t.after(() => page.close());
  const { document } = page;

  // Every row is missing a timestamp, so `buildReplay` drops them all and reports two.
  const payload = { pulse: [{ count: 5 }, { count: 2 }], flows: [{ amount: 3 }] };
  const input = document.getElementById('replay-file');
  const file = new page.window.File([JSON.stringify(payload)], 'blank.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new page.window.Event('change'));
  await page.sleep(250);

  const box = document.getElementById('replay-player');
  assert.equal(box.hidden, false, 'the panel still opens — the file was chosen');
  assert.ok(box.classList.contains('rp-empty'), 'and it is in the empty state, not the playable one');
  assert.ok(!box.classList.contains('rp-bad'), 'a valid JSON file with nothing in it is empty, not corrupt');
  const summary = document.getElementById('replay-summary').textContent;
  assert.match(summary, /No events/, 'the panel says there is nothing to play');
  assert.match(summary, /skipped/, 'and says three rows were unreadable, not absent');
  const scrub = document.getElementById('replay-scrub');
  assert.equal(scrub.disabled, true, 'an empty timeline is not scrubable');
  assert.equal(scrub.max, '0', 'and never a range a visitor could drag to a made-up frame');
});
