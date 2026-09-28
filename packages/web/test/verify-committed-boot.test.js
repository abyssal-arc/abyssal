/**
 * The committed economics reach the DOM.
 *
 * `verify.test.js` proves `verifyView` turns a rule-2 payload's `fields.sales` into a
 * note key with the two figures as params; it cannot prove `renderVerify` then hands
 * those params to `t()` — a wiring bug there (the note text left untranslated, or the
 * figures dropped because only the key was passed) lives in the render path, not the
 * projection, and would leave every pure assertion green while the panel shows
 * `{sales}` literally, or nothing. This file boots the one page where money is on the
 * wire and reads the note back off the DOM.
 *
 * The response below is a full literal, not a call into `harness.js`'s
 * `verifiedResponse`. That is deliberate: this file's subject is the two rule-2 fields,
 * and a fixture built by deriving from the rule-1 default would be one expression away
 * from agreeing with a `verifiedResponse` that never learned to carry money. Written
 * out, the `sales` and `revenueUnits` are visible here no matter what the helper does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, RENDER_DEPS_MISSING, census } from './harness.js';

if (RENDER_DEPS_MISSING) {
  test('verify committed boot', { skip: 'jsdom / @napi-rs/canvas not installed' }, () => {});
  process.exit(0);
}

const TX = '0x' + 'dd'.repeat(32);

// A rule-2 `/verify` answer for the stamped day: the same verified record the default
// fixture paints, with the day's settled economics decoded into `payload.fields`. The
// money is a rule-2 fact and the served day-book row does not restate it, so this panel
// is the only place a reader learns what the chain was promised.
const committedRuleTwo = () => ({
  txHash: TX,
  txFound: true,
  chain: { from: '0x42e60b67b525dd029d5d5c4e747fe27595023c15', to: '0x42e60b67b525dd029d5d5c4e747fe27595023c15', blockNumber: '22866530', ours: true, payloadHexLength: 500 },
  receipt: { status: 'confirmed', blockNumber: '22866530', blockHash: '0x' + 'c1'.repeat(32), feeUnits: '615060000000000', gasUsed: '30600', gasPrice: '20100000000' },
  found: 'on-chain',
  payload: { v: 2, day: 4, hash: 'ab'.repeat(32), ts: 1700000344000, fields: { v: 2, day: 4, sales: 3, revenueUnits: '21000' } },
  decodeProblem: null, ruleKnown: true, hashOutcome: 'verified', hashProblem: null,
  preImage: 'abyssal-day-digest|2|4|76800|6|340|128|60|24|APE:7|3|21000',
  book: null, rowAgreement: 'same', disagreements: [],
  verdict: 'verified', problem: null,
  context: { chainId: 5042, rpc: 'https://verify.test', chainAnswered: true, signer: '0x42E60B67b525DD029D5d5c4E747fE27595023C15', rules: { 1: ['v'], 2: ['v', 'day', 'tick', 'population', 'totalEnergy', 'born', 'died', 'predations', 'topPredator', 'sales', 'revenueUnits'] }, book: { cap: 349, days: 4, coverage: { first: 0, last: 4 } }, doItYourself: 'GET /history/census …' },
});

test('a pinned stamped day under rule 2 paints the committed economics in a note the reader can read', async (t) => {
  const page = await boot({ focusSearch: '?view=world&drawer=analytics&day=4&verify=1', verify: committedRuleTwo() });
  t.after(() => page.close());
  const { document } = page;
  const ROW = census.rows.find((r) => r.day === 4);
  assert.ok(ROW?.txHash, 'the fixture must pin a row that carries a transaction, or this proves nothing');

  assert.equal(page.reqs.verify, 1, 'the deep link fetched exactly once');

  const panel = document.getElementById('census-verify');
  assert.equal(panel.hidden, false, 'the verdict painted itself on arrival');
  assert.equal(panel.getAttribute('data-state'), 'verified', 'the money rides under the verdict, it does not replace it');
  assert.equal(panel.querySelector('.verify-head').textContent, 'Verified: the bytes on chain hash to what the day book says.');

  const notes = [...panel.querySelectorAll('.verify-note')].map((el) => el.textContent);
  assert.deepEqual(
    notes,
    ['Committed on chain: 3 data windows sold · 21000 USDC units.'],
    'the note is a real localised sentence with the server\'s figures in it, not an unresolved {sales} template and not a technical line',
  );
  // The two numbers the feature exists to surface, present as themselves rather than
  // as an interpolation that silently dropped its params.
  assert.ok(notes[0].includes('3'), 'the sales count is quoted');
  assert.ok(notes[0].includes('21000'), 'and the revenue units are quoted');
  // The note is its own tier: a heading above it, the server's raw bytes below it. A
  // committed figure pushed into `.verify-tech` would localise the label but bury it
  // among pre-images, and one pushed into the headline would make a rule-2 day read as
  // a different verdict than a rule-1 day.
  const tech = [...panel.querySelectorAll('.verify-tech')].map((el) => el.textContent);
  assert.ok(!tech.some((l) => l.includes('Committed on chain')), 'the committed line is not folded into the technical block');
});
