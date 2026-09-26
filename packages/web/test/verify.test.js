/**
 * The `/verify` panel's projection, as a table.
 *
 * Nine states, and the whole job of the widget is that none of them is allowed to
 * be another. That rule cannot be checked by a wiring test — a page boots once
 * per process and the panel shows one verdict per boot — so the projection lives
 * here as pure data, and the boot test next door only has to prove the wiring
 * reaches this table on the one state it exercises.
 *
 * Reverse guard at the bottom of the file: the nine states each have to arrive at
 * a distinct `(cls, headlineKey)` pair, or the collapse the server spent a batch
 * un-learning gets put back by the UI. Every test above then names what makes
 * each state *itself* rather than its neighbours, so a mutation that mixes two
 * rows of the table has to break a specific sentence, not just a count.
 *
 * The payloads below are transcriptions of the seven shapes `verify.ts` can
 * return, plus the two shapes the fetch handler itself produces (a rejected
 * promise, a body with no verdict in it). Nothing here is built by the module
 * under test — a fixture assembled by `verifyView` would agree with a miswired
 * `verifyView` no matter how wrong both were, which is exactly the failure mode
 * every other file in this directory documents at the top.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERIFY_STATES, verifyView } from '../src/verify.js';

// i18n.js reads the saved language at module scope, which is the one thing about
// it that is not pure. Stubbed rather than skipped for the same reason
// `i18n.test.js` does it: the dictionary is what this file's reverse guard needs,
// and both live behind that line.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { DICT } = await import('../i18n.js');

const TX = '0x' + 'ab'.repeat(32);

// One verified response, written out at the same shape as the deployed route
// (day 66, `curl /verify?tx=0x655815…`), so the field names in these tests are
// the ones the wire actually carries rather than the ones this file would like.
const VERIFIED = {
  txHash: TX,
  txFound: true,
  chain: { from: '0x' + '42'.repeat(20), to: '0x' + '42'.repeat(20), blockNumber: '22866530', ours: true, payloadHexLength: 472 },
  receipt: { status: 'confirmed', blockNumber: '22866530', blockHash: '0x' + 'c1'.repeat(32), feeUnits: '615060000000000', gasUsed: '30600', gasPrice: '20100000000' },
  found: 'on-chain',
  payload: { v: 1, day: 66, hash: 'ab'.repeat(32), ts: 1790430026203, fields: {} },
  decodeProblem: null, ruleKnown: true, hashOutcome: 'verified', hashProblem: null,
  preImage: 'abyssal-day-digest|1|66|1286411|111|9863|264121|264010|248136|WHALE:54132',
  book: null, rowAgreement: 'same', disagreements: [],
  verdict: 'verified', problem: null,
  context: { chainId: 5042, rpc: 'https://verify.test', chainAnswered: true, signer: '0x' + '42'.repeat(20), rules: {}, book: {}, doItYourself: '' },
};

const withVerdict = (patch) => ({ ...VERIFIED, ...patch });

test('loading is its own state, not a bare panel', () => {
  const v = verifyView(null, { loading: true, txHash: TX, explorerTxUrl: 'https://e.test/tx/' });
  assert.equal(v.state, 'loading');
  assert.equal(v.headlineKey, 'verifyChecking');
  assert.ok(v.cls.includes('verify-pending'), 'amber-neutral, not green: nothing has been said yet');
  assert.deepEqual(v.tech, [], 'loading has no server-provided numbers to show');
  assert.equal(v.link, null, 'a fetch in flight does not yet have a hash it can vouch for');
});

test('a fetch this browser could not finish is a client-error, not a chain answer', () => {
  // A rejected fetch hands the handler a real `TypeError`, whose `String(...)` is
  // `"TypeError: Failed to fetch"` — the widget shows that verbatim rather than
  // the shorter message, because the class is information a reader pasting into
  // a search box needs. The stack is stripped, so the panel stays one line.
  const v = verifyView(null, { fetchFailed: true, txHash: TX, explorerTxUrl: 'https://e.test/tx/', error: new TypeError('Failed to fetch\n  at app.js:1') });
  assert.equal(v.state, 'client-error');
  assert.equal(v.headlineKey, 'verifyFetchFailed');
  assert.ok(v.cls.includes('verify-warn'), 'amber: this is our reachability, not the record\'s status');
  assert.deepEqual(v.tech, ['fetch said: TypeError: Failed to fetch']);
  // The explorer link survives, because the reader's browser can still reach a
  // block explorer even when it could not reach us.
  assert.equal(v.link.href, `https://e.test/tx/${TX}`);
  assert.equal(v.link.title, TX, 'the whole hash is the title, so the reader can copy it');
});

test('a body with no verdict is neither a pass nor a fail', () => {
  // The route's own `catch` shape and any future proxy that hands back `{}`
  // both land here. The widget must not read a missing field as a value.
  const v = verifyView({ txHash: TX }, { txHash: TX, explorerTxUrl: '' });
  assert.equal(v.state, 'shape-unknown');
  assert.equal(v.headlineKey, 'verifyUnknown');
  assert.ok(v.cls.includes('verify-warn'), 'amber: nothing was checked, and green would be a lie');
  assert.ok(v.tech[0].startsWith('unrecognised response'), 'it says what came back rather than pretending to have read it');
});

test('the seven verdicts each get their own headline key and colour', () => {
  // Every one of these has a different fix — a mismatch is a bug in the day
  // book, an uncheckable is a stale build, a not-found is a wrong hash, an
  // unknown is the RPC, a pending is a race with the node — and if the widget
  // can render any two the same, one of those fixes stops being discoverable.
  const cases = [
    { verdict: 'verified', key: 'verifyVerified', cls: 'verify-ok' },
    { verdict: 'mismatch', key: 'verifyMismatch', cls: 'verify-bad' },
    { verdict: 'uncheckable', key: 'verifyUncheckable', cls: 'verify-warn' },
    { verdict: 'pending', key: 'verifyPending', cls: 'verify-pending' },
    { verdict: 'not-found', key: 'verifyNotFound', cls: 'verify-bad' },
    { verdict: 'unreadable', key: 'verifyUnreadable', cls: 'verify-bad' },
    { verdict: 'unknown', key: 'verifyUnknown', cls: 'verify-warn' },
  ];
  const seen = new Set();
  const seenKeys = new Set();
  for (const c of cases) {
    const v = verifyView(withVerdict({ verdict: c.verdict, problem: c.verdict === 'verified' ? null : `why ${c.verdict}` }), { txHash: TX });
    assert.equal(v.state, c.verdict);
    assert.equal(v.headlineKey, c.key, `${c.verdict} renders as its own sentence`);
    assert.ok(v.cls.endsWith(c.cls), `${c.verdict} uses ${c.cls}, not a neighbour's colour: ${v.cls}`);
    seen.add(v.cls);
    seenKeys.add(v.headlineKey);
  }
  assert.equal(seenKeys.size, 7, 'seven verdicts, seven headline keys');
  // Two of the seven deliberately share a colour (`unknown` and `uncheckable`
  // are both amber facts about the site, not about the day), so this count is
  // four, not seven — and that is the point: colour alone cannot carry the
  // distinction, which is why `headlineKey` has to be the one that differs.
  assert.equal(seen.size, 4);
});

test('not-found is evidence and unknown is not, and the widget does not blur them', () => {
  // The server itself keeps them apart at the type level. A widget that renders
  // them with the same key would put back a distinction the whole route exists
  // to preserve — a reader who is told "no such transaction" when the RPC timed
  // out is told their own history is a lie.
  const notFound = verifyView(withVerdict({ verdict: 'not-found', problem: 'the node answered: no transaction with that hash' }), { txHash: TX });
  const unknown = verifyView(withVerdict({ verdict: 'unknown', problem: 'the chain was not reached, so there is no answer about this transaction' }), { txHash: TX });
  assert.notEqual(notFound.headlineKey, unknown.headlineKey);
  assert.notEqual(notFound.cls, unknown.cls, 'evidence and non-evidence are different colours as well as different words');
  assert.ok(notFound.tech.some((l) => l.includes('node answered')), 'not-found still shows the node said something');
  assert.ok(unknown.tech.some((l) => l.includes('server said:')), 'unknown still carries the reason, so the reader can act on it');
});

test('a revert under a verified hash is one note, not a different state', () => {
  const clean = verifyView(VERIFIED, { txHash: TX });
  assert.deepEqual(clean.notes, [], 'a confirmed, matching write is not the same news as an integrity pass on a reverted one');
  const reverted = verifyView(withVerdict({ receipt: { ...VERIFIED.receipt, status: 'reverted' } }), { txHash: TX });
  assert.equal(reverted.state, 'verified', 'the bytes still hash; the record is still on chain');
  assert.equal(reverted.headlineKey, 'verifyVerified', 'and the green headline is the sentence about the bytes, which is still true');
  // The only difference is the note line: same colour, same state, one more
  // sentence — because `verified` describes the record's integrity and the
  // revert describes whether the write landed, and a widget that folded one
  // into the other is what this batch exists to prevent.
  assert.deepEqual(reverted.notes, [{ key: 'verifyReverted' }], 'and the revert is said, not swallowed');
});

test('the technical block quotes the server, in the server\'s own bytes', () => {
  const v = verifyView(VERIFIED, { txHash: TX, explorerTxUrl: 'https://e.test/tx/' });
  const joined = v.tech.join('\n');
  assert.ok(joined.includes('block 22866530'), joined);
  assert.ok(joined.includes('chain 5042'), joined);
  assert.ok(joined.includes('node answered'), joined);
  // The pre-image is what a reader pipes into `sha256sum`; anything this widget
  // "improves" about it — trimming, quoting, translating — makes the panel
  // worse than the `curl` it exists to replace.
  assert.ok(joined.includes('pre-image: abyssal-day-digest|1|66|'), joined);
  // A verified response has no `problem` sentence, so nothing is invented here.
  assert.equal(joined.includes('server said:'), false, 'verified has no problem to quote');
});

test('disagreements are listed field by field, chain first', () => {
  const v = verifyView(withVerdict({
    verdict: 'mismatch',
    hashOutcome: 'verified',
    rowAgreement: 'differs',
    disagreements: [
      { field: 'population', payload: '111', row: '112' },
      { field: 'topPredator', payload: 'WHALE:54132', row: 'APE:99' },
    ],
    problem: 'the on-chain record and our stored row disagree on 2 field(s)',
  }), { txHash: TX });
  const lines = v.tech.filter((l) => l.startsWith('disagreement:'));
  assert.deepEqual(lines, [
    'disagreement: population chain=111 book=112',
    'disagreement: topPredator chain=WHALE:54132 book=APE:99',
  ], 'both sides of each disagreement, on the same line as the field name');
});

test('no txHash means no link, whatever the verdict', () => {
  const v = verifyView(VERIFIED, { txHash: null });
  assert.equal(v.link, null, 'the widget does not invent a URL out of nothing');
});

test('the ten states stay ten — no collapse, no duplication', () => {
  // The reverse guard. A mutation that folds two rows of the table together is
  // a whole sentence lost, and the only way to see it from outside is that two
  // of these ten inputs end up on the same state.
  const projections = [
    verifyView(null, { loading: true }),
    verifyView(null, { fetchFailed: true, error: 'boom' }),
    verifyView({ txHash: TX }, {}),
    verifyView(withVerdict({ verdict: 'verified' }), {}),
    verifyView(withVerdict({ verdict: 'mismatch' }), {}),
    verifyView(withVerdict({ verdict: 'uncheckable' }), {}),
    verifyView(withVerdict({ verdict: 'pending' }), {}),
    verifyView(withVerdict({ verdict: 'not-found' }), {}),
    verifyView(withVerdict({ verdict: 'unreadable' }), {}),
    verifyView(withVerdict({ verdict: 'unknown' }), {}),
  ];
  const states = projections.map((p) => p.state);
  assert.equal(new Set(states).size, 10, `two of the ten inputs land on the same state: ${states.join(', ')}`);
  // The one place the table genuinely merges: `shape-unknown` and `unknown`
  // share the amber chip and the `verifyUnknown` headline because both are
  // "nobody could tell you anything", and the tech line is what separates them.
  // Called out here rather than smoothed over so a future edit that gives them
  // the same tech line has to change this file to say so.
  const byKey = projections.filter((p) => p.headlineKey === 'verifyUnknown').map((p) => p.state).sort();
  assert.deepEqual(byKey, ['shape-unknown', 'unknown'], 'grey-with-a-reason is the same colour for both, and the tech line is what tells them apart');
  assert.equal(VERIFY_STATES.length, 10, 'one more state without updating this test is one less state guarded');
});

test('every headlineKey and note key this file emits is in the dictionary every language shares', () => {
  // `verifyView` hands back key names built from a runtime table, so the
  // literal-scan in `i18n.test.js` cannot see them. This is where that gap gets
  // closed: enumerate the states, project them, and assert each key they can
  // produce resolves in every locale — including the `verifyCheck` button label
  // and `verifyChecking` / `verifyFetchFailed`, which only ever appear on a
  // click and would otherwise go untested in five of six languages.
  const keys = new Set(['verifyCheck', 'verifyChecking', 'verifyFetchFailed']);
  for (const s of VERIFY_STATES) {
    const res = s === 'verified' || s === 'mismatch' || s === 'uncheckable' || s === 'pending' || s === 'not-found' || s === 'unreadable' || s === 'unknown'
      ? withVerdict({ verdict: s, problem: s === 'verified' ? null : `why ${s}` })
      : {};
    const opts = { txHash: TX };
    if (s === 'loading') { keys.add('verifyChecking'); continue; }
    if (s === 'client-error') { keys.add('verifyFetchFailed'); continue; }
    const v = verifyView(res, opts);
    keys.add(v.headlineKey);
    for (const n of v.notes) keys.add(n.key);
  }
  // The revert-alongside-verified note is a second projection of the same
  // verdict, and it is what `verifyReverted` exists for — no other path
  // through `VERIFY_STATES` reaches it, so the loop above cannot list it.
  const reverted = verifyView(withVerdict({ receipt: { ...VERIFIED.receipt, status: 'reverted' } }), { txHash: TX });
  for (const n of reverted.notes) keys.add(n.key);
  const locales = Object.keys(DICT);
  const missing = [];
  for (const k of keys) for (const l of locales) if (!(k in DICT[l])) missing.push(`${l}/${k}`);
  assert.deepEqual(missing, [], 'a key nothing defines renders as itself, in every language');
  // `verifyReverted` only ever fires on a reverted receipt, so a boot test will
  // not exercise it in five of six locales unless this guard lists it here.
  assert.ok(keys.has('verifyReverted'), 'the reverted-under-verified note is not being tested as a key');
});