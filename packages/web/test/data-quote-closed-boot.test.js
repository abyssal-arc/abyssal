import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

// A `503` is the tier saying "not for sale right now" — no seller key, or nothing to
// sell. The card must report that honestly and must NOT fall through to a fabricated
// price: a download that is closed is not free, and inventing a figure here is the
// specific dishonesty this whole data tier refuses.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('a closed tier is stated as closed, with no price invented', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', dataQuote: 'closed' });
  t.after(() => page.close());
  const { document } = page;

  document.querySelector('#census-data button[data-quote]').click();
  await page.sleep(1500);

  assert.equal(page.reqs.history, 1, 'the click reached the route that answered 503');
  const panel = document.getElementById('census-data');
  assert.ok(panel.querySelector('.cd-closed'), 'the closed state is what is shown');
  assert.ok(!panel.querySelector('.cd-price'), 'and there is no price block at all');
  // Neither the real quote nor a hardcoded figure leaks in — the page says nothing
  // about cost because the service said nothing about cost.
  assert.doesNotMatch(panel.textContent, /1000|0\.001/, 'no price is claimed for a tier that gave none');
});
