/**
 * A `verify=1` on a day that never went on chain is a wish, not a command.
 *
 * The other boot file shows the flag fetching for a stamped day. This shows it
 * staying silent when the pinned row carries no `txHash` (day 1 of the fixture):
 * no request is issued — there is no hash to ask about — the panel stays hidden
 * rather than showing a grey "checked" chip that was never earned, and the address
 * bar drops the flag so a link copied from here does not promise a verdict this
 * page has no way to produce.
 *
 * Its own process because a page boots once per process (see `harness.js`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('verify deep link, unstamped', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

test('a verify flag on an unstamped day fetches nothing and is dropped from the bar', async (t) => {
  const page = await boot({ focusSearch: '?view=world&drawer=analytics&day=1&verify=1' });
  t.after(() => page.close());
  const { document, window } = page;
  const ROW = census.rows.find((r) => r.day === 1);
  assert.ok(ROW && ROW.txHash === undefined, 'the fixture must pin a row with no transaction, or this proves nothing');

  assert.equal(page.reqs.verify, 0, 'no hash means no request — the flag cannot invent a transaction to check');

  const pin = document.getElementById('census-pin');
  assert.equal(pin.hidden, false, 'day 1 is still pinned; asking to verify does not unpin it');
  assert.equal(pin.querySelector('button[data-verify]'), null, 'and an unstamped day grows no verify button');

  const panel = document.getElementById('census-verify');
  assert.equal(panel.hidden, true, 'the panel stays silent — an empty verdict would read as a check that never ran');
  assert.equal(panel.innerHTML, '');

  // The bar lets the flag go: whatever the link asked for, this page cannot honour
  // it, so forwarding the bar would hand on an impossible request.
  assert.ok(!/[?&]verify=1(&|$)/.test(window.location.search), `the bar dropped a verify it cannot answer: ${window.location.search}`);
});
