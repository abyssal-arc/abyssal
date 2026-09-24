/**
 * Render smoke test: boots the real app.js in jsdom with a node-canvas bridge
 * (both live in `test/harness.js`, which the link-boot test shares), feeds it a
 * fixture snapshot from an in-process server, pumps a few animation frames and
 * fails if the render loop throws or paints an empty tank.
 *
 * This boots the boring way: no query string, no Arc feed. The interesting
 * opening — what does a link do? — is `test/deeplink-boot.test.js`.
 *
 * This is the guard for the class of bug a hidden tab cannot show: a missing
 * constant or a bad draw call blanks the whole tank while every endpoint stays
 * healthy. Skips itself when the optional render deps are not installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('render smoke', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

const page = await boot();
const { window, document } = page;
const canvasFor = page.canvasFor;

test('the render loop paints a living tank without throwing', (t) => {
  // Clear the app's polling timers and the fixture server even when an assertion
  // fails, or the test process never exits.
  t.after(() => page.close());

  let frames = 0;
  let clock = 1000;
  for (let i = 0; i < 8; i++) {
    const cbs = page.rafQ.splice(0, page.rafQ.length);
    if (!cbs.length) break;
    clock += 16;
    for (const cb of cbs) {
      try {
        cb(clock);
        frames++;
      } catch (err) {
        page.renderThrows.push(String(err.stack ?? err));
      }
    }
  }
  assert.ok(frames >= 4, `expected several frames, got ${frames}`);
  assert.deepEqual(page.renderThrows.slice(0, 1), [], 'the render loop threw');
  assert.deepEqual(page.pageErrors.slice(0, 1), [], 'the page reported an error');

  const world = document.getElementById('world');
  const px = canvasFor(world).getContext('2d').getImageData(0, 0, 1200, 700).data;
  let lit = 0;
  for (let p = 0; p < px.length; p += 4) {
    if (px[p + 3] > 8 && px[p] + px[p + 1] + px[p + 2] > 60) lit++;
  }
  // Water alone lights most of the frame; a blank canvas lights none.
  assert.ok(lit > 100_000, `the tank painted almost nothing (${lit} lit pixels)`);
});

test('the day book is drawn, spoken, and asked for once', () => {
  // One wire request for the whole boot: the book is fetched at boot and the
  // first aux poll then finds the day unchanged, so it must not ask again. An
  // unpolled guard here would show up as 2+ requests, not as a wrong pixel.
  assert.equal(page.reqs.census, 1, `the day book was fetched ${page.reqs.census} times`);

  const cov = document.getElementById('census-coverage');
  const trends = document.getElementById('census-trends');
  const events = document.getElementById('census-events');
  assert.equal(cov.textContent, '4 days kept · day 0 to day 4');
  assert.equal(trends.querySelectorAll('.census-row').length, 4, 'one line per species');
  // APE 2→2 over four days is steady, WHALE 1→2 expands, INSIDER 1→0 is a
  // different sentence from "shrinking" and the text layer is where it is said.
  assert.equal(trends.querySelectorAll('.cr-steady').length, 2, 'APE and ALGO hold');
  assert.equal(trends.querySelectorAll('.cr-expanding').length, 1, 'WHALE grew');
  assert.equal(trends.querySelectorAll('.cr-gone').length, 1, 'INSIDER went extinct');
  assert.ok(!trends.textContent.includes('unknown'), 'a four-day book knows its trends');

  assert.ok(
    events.textContent.includes('INSIDER: no survivors as of day 2'),
    `the extinction is not in the text: ${events.textContent}`,
  );
  assert.ok(events.textContent.includes('no reading between day 2 and day 4'), 'the gap is admitted');
  assert.ok(!events.textContent.includes('reading the day book'), 'stuck on the loading line');

  // The chart itself: bars, the population line and the grey unlisted band. Text
  // can render while the canvas stays empty, which is the exact failure this
  // file exists for.
  const px = canvasFor(document.getElementById('census')).getContext('2d').getImageData(0, 0, 300, 300).data;
  let lit = 0;
  for (let p = 0; p < px.length; p += 4) {
    if (px[p + 3] > 8 && px[p] + px[p + 1] + px[p + 2] > 60) lit++;
  }
  assert.ok(lit > 500, `the census chart painted almost nothing (${lit} lit pixels)`);
});

test('the address bar learns what the visitor is looking at', () => {
  // Boot names the view even though nothing chose it, because a link with no view
  // in it means "the site decides", and with the Arc feed live the site decides
  // OBSERVE — which would quietly contradict the tab the link was copied from.
  assert.equal(window.location.search, '?view=world');

  document.getElementById('dock-analytics').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.location.search, '?view=world&drawer=analytics', 'the drawer is part of the screen');

  // Geometry the app agrees with: a 300px canvas, padL 30, five day slots, so the
  // middle of day 2 sits at x = 30 + 2.5 * (266 / 5).
  const cv = document.getElementById('census');
  const send = (type, x) => cv.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 40 }));
  const pin = document.getElementById('census-pin');
  send('mousemove', 163);
  assert.equal(pin.hidden, true, 'hovering alone pins nothing');
  assert.equal(window.location.search, '?view=world&drawer=analytics', 'and a hover is not a state worth a link');

  send('click', 163);
  assert.equal(window.location.search, '?view=world&day=2&drawer=analytics', 'clicking is');
  assert.equal(pin.hidden, false);
  // The pinned day in words, from the row the server published: population and
  // the commitment made for it, so a forwarded link says what it points at.
  assert.equal(pin.textContent, 'pinned day 2 · 6 alive · committed abababababab');

  send('click', 163);
  assert.equal(window.location.search, '?view=world&drawer=analytics', 'the same click takes it back');
  assert.equal(pin.hidden, true);

  // None of the writes above was a navigation: every one replaced the entry the
  // page was opened with, so Back still means "leave the site" rather than
  // "unwind the last click".
  assert.equal(window.history.length, 1, 'a write to the bar was pushed onto the history stack');
});

test('an open card names its creature in the link, and offers the link', async () => {
  const list = document.getElementById('following');
  const row = list.querySelector('[data-follow]');
  assert.ok(row, 'the watched fixture should have given the following list a row');
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const card = document.getElementById('creature-card');
  assert.equal(card.hidden, false, 'picking a followed animal opens its card');
  const id = Number(row.dataset.follow);
  assert.ok(
    window.location.search.includes(`&creature=${id}`),
    `the link does not name the card that is open: ${window.location.search}`,
  );
  // The copy button is part of the card, so a shared link is one click from the
  // thing on screen rather than a trip to the address bar on a phone.
  const link = card.querySelector('#link-btn');
  assert.ok(link, 'the card offers a copy button');
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await page.sleep(10);
  // The one promise the button makes: the string on the clipboard is the string in
  // the bar, character for character, and not a tidier summary of it.
  assert.equal(page.copied.length, 1, 'the button put nothing on the clipboard');
  assert.equal(page.copied[0], window.location.href, 'the copied link is not the address link');
  assert.ok(
    page.copied[0].includes(`creature=${id}`) && page.copied[0].includes('drawer=analytics'),
    `the copied link lost what was on screen: ${page.copied[0]}`,
  );
});
