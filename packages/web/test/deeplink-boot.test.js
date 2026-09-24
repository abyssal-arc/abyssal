/**
 * Deep-link boot: what does *opening a link* do?
 *
 * `test/deeplink.test.js` checks the rules in isolation and `render.test.js`
 * clicks a bare page. Neither answers the promise a shared link actually makes —
 * that the visitor who opens it lands on the screen the sender was looking at —
 * because that answer is decided at import time, by `applyFocus()`, before any
 * test gets a cursor. So this file boots the app a second way: with a full link
 * in the address bar and the Arc feed live.
 *
 * The live feed is the point, not decoration. Without it the boot probe finds
 * nothing to switch to and "the link's view survived" is indistinguishable from
 * "nothing ever tried to move us" — an assertion that passes whether or not the
 * guard does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, FLOW_ADDR } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('deep-link boot', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

// Written the way a wallet shouts it — checksummed case — because that is what a
// person pastes, and the tank keys everything lowercase.
const SHOUTED = '0x' + FLOW_ADDR.slice(2).toUpperCase();
// Every key at once: a sender looking at the tank with a drawer open, a day
// pinned, one animal's card up and one endpoint's card up beside it.
const LINK = `?view=world&drawer=analytics&day=2&creature=101&addr=${SHOUTED}`;
const page = await boot({ focusSearch: LINK, observeLive: true });
const { window, document } = page;

test('a link that names a view keeps it, even with the feed live', (t) => {
  t.after(() => page.close());

  // First: the feed really did go live, or the assertion below proves nothing.
  assert.ok(page.reqs.observe >= 1, 'the boot probe never asked /observe');
  assert.equal(
    document.getElementById('observe-empty').hidden,
    true,
    'the probe reported no live feed — the guard below would pass by accident',
  );
  // Then: and still the visitor is looking at the tank the link asked for.
  assert.ok(window.location.search.startsWith('?view=world'), `the link was overruled: ${window.location.search}`);
  assert.ok(document.body.classList.contains('view-world'), 'the body says otherwise');
  assert.equal(document.getElementById('observe-view').hidden, true, 'the observatory is on screen');
  assert.deepEqual(page.pageErrors.slice(0, 1), [], 'the page reported an error');
});

test('every key the link named is the screen it names', () => {
  // Same keys, canonical order: the bar is rewritten by the serializer rather than
  // left as it arrived, which is what makes a copied link and a pasted link one
  // and the same string. The address comes back lowercase, because the string in
  // the bar is the string the tank queries with.
  assert.equal(window.location.search, `?view=world&creature=101&addr=${FLOW_ADDR}&day=2&drawer=analytics`);

  const drawer = document.getElementById('drawer-analytics');
  assert.equal(drawer.hidden, false, 'the drawer the link named is open');
  assert.ok(document.getElementById('dock-analytics').classList.contains('open'), 'and the dock knows it');

  // The day the link pinned is stated in words, from the row the server published.
  const pin = document.getElementById('census-pin');
  assert.equal(pin.hidden, false, 'a linked day is pinned, not just hovered');
  assert.equal(pin.textContent, 'pinned day 2 · 6 alive · committed abababababab');
  // Day 2 is the fixture's unstamped row, so this exact string is also the
  // negative half of `test/anchor-boot.test.js`: a day with no confirming
  // transaction shows the digest it has and grows no link to a chain it never
  // reached.
  assert.equal(pin.querySelector('a'), null, 'an unanchored day must not offer a transaction');

  const card = document.getElementById('creature-card');
  assert.equal(card.hidden, false, 'the creature the link named has its card open');
  assert.ok(card.textContent.includes('MOBY-101'), `the card is about something else: ${card.textContent.slice(0, 60)}`);

  // The address card is a different panel, and a link can name both at once.
  const addrCard = document.getElementById('addr-card');
  assert.equal(addrCard.hidden, false, 'the endpoint the link named has its card open');
  assert.equal(addrCard.querySelector('.addr-h').title, FLOW_ADDR, 'the card is about a different address');
});
