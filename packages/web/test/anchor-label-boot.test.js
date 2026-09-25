/**
 * The page drawing the third label, from a record the server could not check.
 *
 * `test/anchor.test.js` holds the whole table; this proves the table is what the
 * chip is made of, with the one state no page has ever shown: `verifies: null`,
 * a payload naming a rule this build does not publish. That is what a rollback to
 * an older build leaves behind — the newer build's rule is gone, its records are
 * still in the ledger, and neither of them is wrong. So what matters here is not
 * that a word appears but that two words do not: not *corrupt*, about a day that
 * is honestly on chain, and not the green tick, which would be the page
 * certifying what the server refused to.
 *
 * One payload per process is the harness's rule, so the rest of the table stays in
 * the pure file and this boots the row that could only be wrong in a real page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('anchor chip unchecked label', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

const TX = `0x${'ee'.repeat(32)}`;

const page = await boot({
  digestChain: {
    day: 4,
    status: 'confirmed',
    txHash: TX,
    confirmedAt: 1700000000000,
    attempts: 1,
    maxAttempts: 5,
    hash: 'ab'.repeat(32),
    payload: { v: 2, day: 4, hash: 'ab'.repeat(32) },
    // The verdict the server hands out when it has no rule: not `true`, not `false`.
    verifies: null,
  },
});
const { document } = page;

test('a record nobody could check is called unchecked, and is neither of the two words it could be confused with', (t) => {
  t.after(() => page.close());

  const el = document.getElementById('digest-status');
  assert.ok(el.textContent.includes('Anchor unchecked'), `the chip says it declined to certify: ${el.textContent}`);
  assert.ok(!el.textContent.includes('corrupt'), 'a day that is honestly on chain is not called corrupt by this build');
  assert.ok(!el.textContent.includes('✓'), 'and the tick is a certification this record did not earn');
  assert.ok(el.classList.contains('unconfigured'), `grey, not amber or green: ${el.className}`);
  assert.ok(!el.classList.contains('confirmed') && !el.classList.contains('failed'), `the two colours it is not: ${el.className}`);

  // The transaction is still evidence, and still shown: what is withheld is the
  // claim about the numbers, not the record that they went on chain.
  const [a] = [...el.querySelectorAll('a')];
  assert.ok(a, 'the link to the chain survives the inability to check');
  assert.equal(a.href, `https://arc-exp.test/tx/${TX}`, 'over the base the API published');
  assert.match(a.title, /no rule for the version/);

  assert.deepEqual(page.pageErrors.slice(0, 1), [], 'the page reported an error');
});
