/**
 * The rails panel, painted.
 *
 * `test/observe.test.js` decides the coverage sentences; this checks that the panel
 * actually speaks them, because a module nothing imports is a module that passes.
 * The fixture payload carries both shortfalls at once — the ring held 150 of the
 * window's 900 transfers and resolved no destination for 50 of those — so either
 * sentence being dropped from the wiring shows up here rather than in a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('the rails panel', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

const page = await boot({ observeLive: true });

test('the rails panel says how much of the window it describes', (t) => {
  t.after(() => page.close());
  const el = page.document.getElementById('venues');
  // The table itself has to be there for the caveat to mean anything: a panel that
  // renders only its own disclaimer is a different bug wearing the same shirt.
  assert.equal(el.querySelectorAll('.ep').length, 2, 'the ranked rows went missing');

  const notes = [...el.querySelectorAll('.vcov')].map((n) => n.textContent);
  assert.deepEqual(notes, [
    'These rows cover 150 of the 900 transfers in this window',
    '50 transfers not attributed',
  ], `the coverage sentences are not the ones the payload entitles: ${JSON.stringify(notes)}`);
});
