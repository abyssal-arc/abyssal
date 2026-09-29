import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, HISTORY_QUOTE } from './harness.js';

// The single most important claim the card makes is that the price it prints is
// the one the *service* answered, not one baked into the page. A test that only
// ever served the real `0.001` / `1000` could never tell those apart — a mutant
// that hardcoded the number would still pass. So this file serves a deliberately
// different offer and insists the card follow the wire.
const skip = RENDER_DEPS_MISSING ? { skip: 'jsdom not installed' } : {};

const probeOffer = {
  ...HISTORY_QUOTE,
  accepts: [{ ...HISTORY_QUOTE.accepts[0], amount: '2500', network: 'eip155:9999' }],
};

test('the card tracks the served amount and network, not a number it was written with', skip, async (t) => {
  if (RENDER_DEPS_MISSING) return;
  const page = await boot({ focusSearch: '?view=world&drawer=analytics', dataQuote: probeOffer });
  t.after(() => page.close());
  const { document } = page;

  document.querySelector('#census-data button[data-quote]').click();
  await page.sleep(1500);

  const price = document.querySelector('#census-data .cd-price')?.textContent ?? '';
  assert.match(price, /2500/, 'the amount on screen is the served 2500, not a baked 1000');
  assert.match(price, /0\.0025/, 'and the USDC reading is that amount divided by six decimals');
  assert.match(price, /eip155:9999/, 'the network is the served one, not the real mainnet id');
  assert.doesNotMatch(price, /eip155:5042/, 'the offer that was never sent does not appear');
});
