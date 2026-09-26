/**
 * The Verify-independently button, clicked.
 *
 * `verify.test.js` proves the projection is right; this proves the widget is
 * actually wired to it: a pinned day with a `txHash` shows a button, the button
 * fires a `/verify` request, the answer lands in the panel with the class the
 * projection chose, and moving the pin to a row that carries no hash clears the
 * panel rather than leaving yesterday's verdict next to today's numbers.
 *
 * One page per process (see `harness.js`) means one click and one fetch here. The
 * seven verdicts each rendering correctly on the DOM is the table next door's
 * problem — this file's job is that the state on screen *came from* the fetch and
 * nowhere else, which the `reqs.verify` count is the only way to check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('verify button', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

// Day 4 is the fixture's stamped row, and the deep link pins it at boot. The
// drawer has to be opened here too, because `#census` measures zero width while
// the card is shut and `drawCensusChart` returns early — a chart that never drew
// leaves the hover state null, and the pin-change assertion below needs a canvas
// the mouse can find.
test('the button fires a request, the answer paints, and moving the pin clears it', async (t) => {
  const page = await boot({ focusSearch: '?view=world&drawer=analytics&day=4' });
  t.after(() => page.close());
  const { document, window } = page;
  const ROW = census.rows.find((r) => r.day === 4);
  const OTHER = census.rows.find((r) => r.day === 0);
  // The fixture's two stamped rows must disagree; a test that cannot tell them
  // apart is a test that would pass on any hash at all.
  assert.notEqual(ROW.txHash, OTHER.txHash, 'the fixture is not distinct enough for this test to mean anything');

  // -- (1) The affordance exists and the panel starts silent. ------------------
  const pin = document.getElementById('census-pin');
  assert.equal(pin.hidden, false, 'the deep link did not pin day 4');
  const btn = pin.querySelector('button[data-verify]');
  assert.ok(btn, 'a stamped row without a way to verify it is what this button exists to fix');
  assert.equal(btn.getAttribute('data-verify'), ROW.txHash, 'the button carries this row\'s hash, not another day\'s');
  assert.equal(btn.textContent, 'Verify independently', 'and the label is translated in the page\'s language');

  const panel = document.getElementById('census-verify');
  assert.equal(panel.hidden, true, 'nobody has asked yet, and an untouched panel is not one of the seven verdicts');
  assert.equal(panel.className, '', 'including the class list — a residual `verify-ok` here would read as a check that was never run');
  assert.equal(page.reqs.verify, 0, 'the boot must not have fetched a verdict the reader did not ask for');

  // -- (2) Click. The panel acknowledges synchronously in `loading`. ----------
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(panel.hidden, false, 'the click did not acknowledge itself');
  assert.equal(panel.getAttribute('data-state'), 'loading');
  assert.ok(panel.className.includes('verify-pending'), `loading is amber-neutral, not green: ${panel.className}`);
  assert.equal(panel.textContent.trim(), 'Checking the chain…', 'and the loading line is exactly what the widget is doing');

  // Let the fetch finish. `harness.js` uses Node's real HTTP, so a fixed sleep is
  // enough for one round trip on loopback; a mutation that removes the resolve
  // path lands here as "still loading after the sleep", which is a distinct
  // failure the next assertion names.
  await page.sleep(400);

  assert.equal(page.reqs.verify, 1, 'the button issued exactly one request');
  assert.equal(panel.getAttribute('data-state'), 'verified');
  assert.ok(panel.className.includes('verify-ok'), `the projection's class should be on the panel: ${panel.className}`);
  assert.equal(panel.querySelector('.verify-head').textContent, 'Verified: the bytes on chain hash to what the day book says.');

  const tech = [...panel.querySelectorAll('.verify-tech')].map((el) => el.textContent);
  assert.ok(tech.some((l) => l.includes('block 22866530')), `the server's block height should be quoted: ${JSON.stringify(tech)}`);
  assert.ok(tech.some((l) => l.includes('chain 5042')), 'chain id too — the number a reader needs to check the node was on the right network');
  assert.ok(tech.some((l) => l.startsWith('pre-image: ')), 'the pre-image is here verbatim, so a reader can pipe it into sha256sum');

  // The panel is where the reader checks the site's arithmetic; the pin above it
  // still carries the chain's own view. Two sources, one day, and losing the
  // second one because we added the first is exactly what this batch would break.
  const explorer = pin.querySelector('a');
  assert.ok(explorer, 'the explorer link is still beside the button');
  assert.equal(explorer.href, `https://arc-exp.test/tx/${ROW.txHash}`, 'and it still points at the fixture host the server published');

  // -- (3) A new pin on a row that has no hash clears the panel. --------------
  // The canvas geometry here matches what `render.test.js` measured for a 300 px
  // wide canvas: padL 30, five day slots, so x = 163 is the middle of day 2 —
  // which the fixture leaves unstamped, and switching to it is the situation the
  // hash comparison in `renderVerify` exists for. A stale green chip below a day
  // that has never been on chain is the specific lie this batch exists to stop.
  const cv = document.getElementById('census');
  const send = (type, x) => cv.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 40 }));
  send('mousemove', 163);
  send('click', 163);
  assert.equal(pin.hidden, false, 'day 2 is now the pinned row');
  assert.equal(pin.querySelector('button[data-verify]'), null, 'and day 2 has no verify affordance, because it has no txHash');
  assert.equal(panel.hidden, true, 'yesterday\'s verdict was cleared rather than left to speak about the wrong day');
  assert.equal(panel.innerHTML, '', 'and every child is gone, not just hidden behind CSS');
});
