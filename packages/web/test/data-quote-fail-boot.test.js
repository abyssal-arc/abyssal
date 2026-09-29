import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// The third way there is no quote: the browser could not reach the route at all.
// `dataQuote: 'fail'` destroys the socket so the fetch rejects, and the card has to
// say "could not read a quote" — not a price, and not a silent blank that a reader
// might take for "free" or "checked".
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a quote the browser could not fetch is named as such, with no price shown', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', dataQuote: 'fail' });
  t.after(() => page.close());
  const { document } = page;

  document.querySelector('#census-data button[data-quote]').click();
  await page.sleep(1500);

  const panel = document.getElementById('census-data');
  assert.ok(panel.querySelector('.cd-error'), 'the unreadable state is what is shown');
  assert.ok(!panel.querySelector('.cd-price'), 'no price is rendered when the fetch itself failed');
  assert.doesNotMatch(panel.textContent, /1000|0\.001/, 'a failed fetch does not become an invented quote');
});
