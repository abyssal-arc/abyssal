import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// A file that is not JSON at all, and a file name carrying markup. Both have to be
// answered with a sentence, not a crash and not a live element: the visitor picked
// the wrong file, and the panel's job is to say so in words a mutation cannot delete
// and markup the name cannot inject.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a file that is not JSON is called bad, and its name cannot inject markup', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=observe', observeLive: true });
  t.after(() => page.close());
  const { document } = page;

  const input = document.getElementById('replay-file');
  const file = new page.window.File(['this is not json {{{'], '<img src=x onerror=alert(1)>.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new page.window.Event('change'));
  await page.sleep(250);

  const box = document.getElementById('replay-player');
  assert.equal(box.hidden, false, 'the panel opens to report the problem');
  assert.ok(box.classList.contains('rp-bad'), 'and marks it as the corrupt-file state');
  assert.match(document.getElementById('replay-summary').textContent, /not a replay/, 'in words');
  // The name is never echoed in the bad branch, and even if a future change did echo
  // it, no element may come of it.
  assert.equal(document.querySelectorAll('#replay-player img').length, 0, 'the file name never becomes an element');
  assert.equal(document.getElementById('replay-scrub').disabled, true, 'a corrupt file is not scrubable');
});
