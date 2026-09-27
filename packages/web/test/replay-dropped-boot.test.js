import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// A partly-readable file is playable AND reports what it dropped. This is the state
// the pure test's `dropped` count is for, seen in the DOM: the timeline sweeps only
// the rows that had a timestamp, but the number of rows that did not is said out loud
// — otherwise a file with holes replays identically to a file that was always short,
// and "the feed never saw those" is the one fact a viewer cannot recover by eye.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a partly-readable file plays its good rows and reports the skipped ones', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=observe', observeLive: true });
  t.after(() => page.close());
  const { document } = page;

  const payload = {
    pulse: [
      { t: 1790144250000, count: 10, volume: 100, x402: 1, resolved: 10 },
      { count: 99 },                                  // no timestamp → dropped
      { t: 1790144260000, count: 5, volume: 50, x402: 0, resolved: 5 },
    ],
    flows: [
      { t: 1790144255000, amount: 4, from: '0xa', to: '0xb', venue: 'x402', x402: true },
    ],
  };
  const input = document.getElementById('replay-file');
  const file = new page.window.File([JSON.stringify(payload)], 'holes.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new page.window.Event('change'));
  await page.sleep(250);

  const box = document.getElementById('replay-player');
  assert.ok(!box.classList.contains('rp-empty'), 'three good rows is a playable file, not an empty one');
  const summary = document.getElementById('replay-summary');
  assert.match(summary.textContent, /3 events/, 'the timeline holds only the three dated events');
  assert.match(summary.textContent, /1 rows skipped|1 row skipped/, 'and says one row had no timestamp');
  assert.match(summary.textContent, /10s/, 'the span covers the good rows only');
  assert.equal(document.getElementById('replay-scrub').max, '2', 'the scrubber runs the three real frames');
  assert.ok(summary.querySelector('.rp-skip'), 'the skipped count is its own styled span, not blended into the headline');
});
