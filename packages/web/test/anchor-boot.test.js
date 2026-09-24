/**
 * The link a day earns: what a pinned day says once its commitment is on chain.
 *
 * `test/deeplink-boot.test.js` pins day 2, which the fixture leaves unstamped, so
 * it can only prove that no link appears. This boots the other half — a day whose
 * row carries the transaction that confirmed it — against a page whose explorer
 * base is *not* the one `app.js` starts with. Both halves matter: the assertion
 * below is about a specific URL, and a test that could not tell the server's base
 * from the client's default would pass while pointing every link in the tank at
 * the wrong host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('anchored-day link', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

// Day 4 is the fixture's stamped row, and its hash differs from day 0's on
// purpose: reading the pointer off the wrong row still produces a plausible link.
const ROW = census.rows.find((r) => r.day === 4);
const EXPECTED = `https://arc-exp.test/tx/${ROW.txHash}`;

const page = await boot({ focusSearch: '?view=world&drawer=analytics&day=4' });
const { document } = page;

test('a confirmed day carries the transaction that confirmed it', (t) => {
  t.after(() => page.close());

  const pin = document.getElementById('census-pin');
  assert.equal(pin.hidden, false, 'the day the link named is pinned');
  const links = [...pin.querySelectorAll('a')];
  assert.equal(links.length, 1, `exactly one way to the chain, found ${links.length}`);
  const [a] = links;

  assert.equal(a.href, EXPECTED, 'the row\'s own hash over the base the API published');
  assert.notEqual(a.href, `https://arc-exp.test/tx/${census.rows[0].txHash}`, 'not the other stamped day\'s');
  assert.notEqual(a.href.split('/tx/')[0], 'https://explorer.arc.io', 'and not the address the client defaults to');
  assert.equal(a.title, ROW.txHash, 'the whole hash is there to read, not only the tail of it');
  assert.equal(a.target, '_blank');
  assert.ok(a.relList.contains('noopener'), 'a link out to a block explorer is not an invitation to reach back');
  assert.equal(a.textContent, 'Verify on explorer →', 'and it is said in the language the page is in');

  // The link joins the sentence rather than replacing it: a reader comparing two
  // days needs the digest in words, and a day that loses its numbers whenever it
  // gains a link would be a worse answer than the one it replaces.
  assert.ok(
    pin.textContent.startsWith('pinned day 4 · 6 alive · committed abababababab'),
    `the day and its digest are still stated: ${pin.textContent}`,
  );
  assert.deepEqual(page.pageErrors.slice(0, 1), [], 'the page reported an error');
});
