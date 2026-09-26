/**
 * A forwarded stamped day verifies itself on arrival.
 *
 * `verify-boot.test.js` proves the button, once pressed, fetches and paints. This
 * proves the deep link replaces the press: `?…&day=4&verify=1` — the string that
 * the `Copy link` on a checked row now carries — must boot straight into the
 * verdict with nobody clicking, issue exactly one `/verify` request, and leave the
 * address bar naming that verdict so the recipient can forward it in turn.
 *
 * The negative half (a `verify=1` pinned to a day that never went on chain asks
 * for nothing) is a separate page, and so a separate file: one page per process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('verify deep link', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

test('a link that pins a stamped day and asks for verify paints the verdict without a click', async (t) => {
  const page = await boot({ focusSearch: '?view=world&drawer=analytics&day=4&verify=1' });
  t.after(() => page.close());
  const { document, window } = page;
  const ROW = census.rows.find((r) => r.day === 4);
  assert.ok(ROW?.txHash, 'the fixture must pin a row that carries a transaction, or this proves nothing');

  // The boot sleep (1200 ms) already covers the loopback fetch, so by here the
  // one-shot request has fired and settled without any dispatchEvent in this test.
  assert.equal(page.reqs.verify, 1, 'the link fetched exactly once — no click, and not twice');

  const pin = document.getElementById('census-pin');
  assert.equal(pin.hidden, false, 'day 4 was pinned by the link');

  const panel = document.getElementById('census-verify');
  assert.equal(panel.hidden, false, 'the verdict painted itself; a reader who forwarded the link sees it, not a button');
  assert.equal(panel.getAttribute('data-state'), 'verified');
  assert.ok(panel.className.includes('verify-ok'), `the projection's class is on the panel: ${panel.className}`);
  assert.equal(panel.querySelector('.verify-head').textContent, 'Verified: the bytes on chain hash to what the day book says.');

  // The bar now names the verdict, which is what makes the link worth copying
  // forward. `parseFocus` would read this very string back to `{…, verify: 1}`.
  assert.ok(/[?&]verify=1(&|$)/.test(window.location.search), `the address bar kept the verify flag: ${window.location.search}`);
  assert.ok(/[?&]day=4(&|$)/.test(window.location.search), 'and still pins the same day');
});
