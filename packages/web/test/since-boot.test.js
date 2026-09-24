/**
 * "While you were away", end to end.
 *
 * `test/since.test.js` proves the diff; this proves the wiring, which is where the
 * feature could still be a lie: the memory has to be read from this browser before
 * it is overwritten, the numbers on screen have to come from the comparison of two
 * answers rather than from one, and the second look must not repeat the news.
 *
 * The baseline below is written out by hand rather than produced by
 * `standingSeed`, for the same reason the day book's `changes` are: a fixture built
 * by the code under test agrees with it no matter how wrong they both are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, ME_ADDR, whoFixture } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('while you were away', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

/** What this browser last saw, at tick 3000 — day 0 of the same tank. */
const MEMORY = {
  v: 1, // the row shape `src/since.js` writes; any other version is refused, not read
  address: ME_ADDR,
  seenTick: 3000,
  seenDay: 0,
  burned: 100,
  burns: 4,
  rank: 3,
  cheer: null,
  passActive: true,
  passUntil: 38400,
  adopted: [{ id: 7, name: 'MOBY-7', archetype: 'APE', alive: true }],
  reports: [{ tx: '0xaa', type: 'poison', affected: 3, score: 12 }],
};

/** The answer the server gives now: everything about that standing has moved. */
const NOW = whoFixture({
  burned: 160,
  burns: 6,
  rank: 5,
  cheer: 'APE',
  pass: { active: true, until: 76800 },
  adoptions: [
    { id: 7, name: 'MOBY-7', archetype: 'APE', alive: false },
    { id: 12, name: 'MOBY-12', archetype: 'WHALE', alive: true },
  ],
  reports: [
    { tx: '0xbb', type: 'bloom', atTick: 3900, affected: 4, score: -2 },
    { tx: '0xaa', type: 'poison', atTick: 900, affected: 3, score: 12 },
  ],
});

const page = await boot({ wallet: ME_ADDR, standing: MEMORY, who: NOW });
const { document } = page;
const drawer = () => document.getElementById('dock-you').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));

test('a returning visitor is told what changed', async () => {
  drawer();
  await page.sleep(80);

  const el = document.getElementById('me-since');
  assert.equal(el.hidden, false, 'the standing arrived but the memory of it did not');
  assert.equal(el.querySelector('.ms-head').textContent, 'While you were away · since day 0');

  const rows = [...el.querySelectorAll('.prop')].map((r) => r.textContent.trim());
  // Worst news first, and in the order `src/since.js` chose — five of seven, with
  // the remainder counted rather than dropped.
  assert.deepEqual(rows, [
    'APE MOBY-7 died',
    'you adopted WHALE MOBY-12',
    'bloom report: -2 over 4',
    '2 more burns · 60 ABYS',
    'day pass now runs to D4',
  ]);
  assert.equal(el.querySelector('.ms-more').textContent, '+2 more');
  // The card above it is the current standing, not the memory: six paid actions and
  // rank five, so the two halves of the drawer agree about what is true now.
  assert.ok(document.getElementById('me-card').textContent.includes('6'), 'the standing itself went missing');
});

test('the memory is updated, and the same answer is not news twice', async (t) => {
  // The stage outlives every assertion in this file, because the second look needs
  // the server and the timers the first one is still using.
  t.after(() => page.close());
  const after = JSON.parse(page.window.localStorage.getItem(`abyssal-standing:${ME_ADDR}`));
  assert.equal(after.burns, 6, 'the new answer was never written down');
  assert.equal(after.seenTick, 4000, 'the memory is not stamped with the snapshot in hand');
  assert.equal(after.seenDay, 4);
  assert.deepEqual(after.adopted.map((a) => [a.id, a.alive]), [[7, false], [12, true]]);

  drawer(); // close
  await page.sleep(20);
  drawer(); // open, and fetch again against the same server answer
  await page.sleep(80);

  const el = document.getElementById('me-since');
  assert.equal(el.hidden, false);
  assert.equal(el.querySelector('.ms-head').textContent, 'While you were away · since day 4');
  assert.deepEqual([...el.querySelectorAll('.prop')].map((r) => r.textContent.trim()), [
    'Nothing in your standing changed since your last look.',
  ]);
  assert.equal(el.querySelector('.ms-more'), null, 'a quiet spell has nothing left over');
});
