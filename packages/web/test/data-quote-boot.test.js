import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, HISTORY_QUOTE } from './harness.js';

// The card that puts the paid, self-verifiable day book in front of a visitor.
// This file is the *positive* half: the book has rows, so the card is offered, and
// the price it prints is the one the route answered — not a figure this page typed.
// The negatives live in the sibling files, because the lie worth guarding against is
// the card inventing a quote when the service gave none.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

test('the day-book card is offered beside real rows, and prints the served quote', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics' });
  t.after(() => page.close());
  const { document } = page;

  const panel = document.getElementById('census-data');
  assert.ok(panel, 'the card is in the page');
  assert.equal(panel.hidden, false, 'a book with rows offers the download beside them');
  assert.equal(page.reqs.history, 0, 'booting the page does not ask the paid route — only a click does');

  // Idle: an invitation, not a price. The reader has not asked and the service has
  // not answered, so nothing here may read as "this is what it costs".
  const btn = panel.querySelector('button[data-quote]');
  assert.ok(btn, 'the idle card shows the button, not a figure');
  assert.ok(!panel.querySelector('.cd-price'), 'no price is rendered before the route is asked');

  btn.click();
  await page.sleep(1500);

  assert.equal(page.reqs.history, 1, 'the click reached the served route — a fetch the card short-circuits locally would leave this 0');
  const price = panel.querySelector('.cd-price')?.textContent ?? '';
  assert.match(price, new RegExp(HISTORY_QUOTE.accepts[0].amount), 'the base-unit amount shown is the one the route answered');
  assert.match(price, /0\.001/, 'and its USDC reading follows from that amount');
  assert.match(price, new RegExp(HISTORY_QUOTE.accepts[0].network), 'the network printed is the one the offer named');
});
