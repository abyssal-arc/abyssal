/**
 * The anchor chip's words, one row of the table at a time.
 *
 * The chip is the only place a visitor learns whether the tank's day is on chain
 * and whether anybody checked the numbers beside it. Three answers come back from
 * the verifier now — verified, mismatch, and "this build cannot say" — and the
 * failure mode of a widget written against two is that the third is silently read
 * as one of them: a record nobody checked rendered green is a claim of safety the
 * server explicitly refused to make.
 *
 * So this is the whole table, written as data the page is not needed for. The
 * matching boot test proves the page is driven by it; a boot cannot prove the
 * rows nobody put on the wire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anchorLabel } from '../src/anchor.js';

const TX = `0x${'a1'.repeat(32)}`;
const BASE = 'https://arc-exp.test/tx/';

/** A record with nothing wrong in it, which each case then breaks one way. */
const record = (over = {}) => ({
  day: 4,
  status: 'confirmed',
  txHash: TX,
  confirmedAt: 1700000000000,
  attempts: 1,
  maxAttempts: 5,
  hash: 'ab'.repeat(32),
  payload: { v: 1, day: 4, hash: 'ab'.repeat(32) },
  verifies: true,
  ...over,
});

test('no record is an empty chip, not a hopeful one', () => {
  assert.deepEqual(anchorLabel(null, BASE), { cls: 'digest-status', text: '', link: null });
  assert.deepEqual(anchorLabel(undefined, BASE), { cls: 'digest-status', text: '', link: null });
});

test('a confirmed day is green, linked, and links where the API said', () => {
  const a = anchorLabel(record(), BASE);
  assert.equal(a.cls, 'digest-status confirmed');
  assert.equal(a.text, '');
  assert.equal(a.link.href, `${BASE}${TX}`, 'the base the server published, not the one the client defaults to');
  // Six characters counting the `0x`, then the last four: the shape the chip has
  // always shown, pinned here so the extraction to a module cannot quietly widen
  // or narrow it — a label nobody can compare to the hash in the digest next to it
  // is a decoration.
  assert.equal(a.link.label, `✓ 0x${'a1'.repeat(2)}…${'a1'.repeat(2)}`, 'short enough for a chip, unique enough to click');
  assert.equal(a.link.title, 'View on explorer');
});

test('a broadcast that has not mined says so, still linked', () => {
  const a = anchorLabel(record({ status: 'pending', confirmedAt: null }), BASE);
  assert.equal(a.cls, 'digest-status pending');
  assert.equal(a.link.href, `${BASE}${TX}`);
  assert.match(a.link.label, /^Committing… 0x/);
  assert.equal(a.link.title, 'Broadcast, waiting for a block');
});

test('a `pending` with no transaction is corrupt, and links to nothing', () => {
  // The specific lie this chip was rewritten to stop rendering as hope: the
  // send-failure path used to leave a `pending` with no hash, and "Committing…"
  // described a transaction no chain had ever been asked about.
  const a = anchorLabel(record({ status: 'pending', txHash: null, confirmedAt: null }), BASE);
  assert.equal(a.cls, 'digest-status failed');
  assert.equal(a.text, 'Anchor corrupt');
  assert.equal(a.link, null, 'there is no transaction to offer a link to');
});

test('a `confirmed` with no transaction is corrupt too', () => {
  assert.equal(anchorLabel(record({ txHash: null }), BASE).text, 'Anchor corrupt');
});

test('a mismatch is called corrupt and its transaction is not offered', () => {
  const a = anchorLabel(record({ verifies: false }), BASE);
  assert.equal(a.cls, 'digest-status failed');
  assert.equal(a.text, 'Anchor corrupt');
  assert.equal(a.link, null, 'a link beside a record that disagrees with itself would invite the reader to trust it');
});

test('an unchecked record gets third words, and keeps the evidence', () => {
  // `null` is a fact about the build — it has no rule for the version the record
  // names — and not about the day. The transaction is still on chain, so it is
  // still shown; what is withheld is the certification.
  const a = anchorLabel(record({ verifies: null }), BASE);
  assert.equal(a.cls, 'digest-status unconfigured');
  assert.equal(a.text, 'Anchor unchecked');
  assert.equal(a.link.href, `${BASE}${TX}`);
  assert.match(a.link.title, /no rule for the version/);
  assert.ok(!a.text.includes('corrupt'), 'an honest on-chain day is not called corrupt by a build that cannot read it');
});

test('a response that never carried a verdict is treated as nobody checked', () => {
  // The other way to fail to say: an older build, or a hand-rolled reader, with no
  // `verifies` key at all. Absent is not `true`, and the green chip is a claim.
  const noVerdict = { ...record() };
  delete noVerdict.verifies;
  assert.equal(anchorLabel(noVerdict, BASE).text, 'Anchor unchecked');
  assert.equal(anchorLabel(record({ verifies: undefined }), BASE).text, 'Anchor unchecked');
});

test('the lie outranks the doubt, and an in-flight record with a hash keeps the doubt', () => {
  // Both readings are real: a `pending` with no hash is a status claiming a
  // transaction that does not exist, which is worse than being unable to check
  // one; a `pending` that does have one is only unchecked.
  assert.equal(anchorLabel(record({ status: 'pending', txHash: null, confirmedAt: null, verifies: null }), BASE).text, 'Anchor corrupt');

  const b = anchorLabel(record({ status: 'pending', confirmedAt: null, verifies: null }), BASE);
  assert.equal(b.cls, 'digest-status unconfigured');
  assert.equal(b.text, 'Anchor unchecked');
});

test('a due or retrying record says anchoring, without a link', () => {
  for (const status of ['queued', 'submitting']) {
    const a = anchorLabel(record({ status, txHash: null, confirmedAt: null, attempts: status === 'queued' ? 0 : 1 }), BASE);
    assert.equal(a.cls, 'digest-status pending', `${status} is work in progress`);
    assert.equal(a.text, 'Anchoring…');
    assert.equal(a.link, null, `${status} has broadcast nothing anybody could look at`);
  }
});

test('a failed record counts its tries, and says when they are spent', () => {
  const retrying = anchorLabel(record({ status: 'failed', txHash: null, attempts: 2 }), BASE);
  assert.equal(retrying.cls, 'digest-status failed');
  assert.equal(retrying.text, 'Retry 2/5', 'the budget is shown, not just the failure');

  const spent = anchorLabel(record({ status: 'failed', txHash: null, attempts: 5 }), BASE);
  assert.equal(spent.text, 'Anchor dropped (5 tries)', 'and it stops being a retry the moment it is not one');
});

test('no key means off-chain, and says nothing about verification', () => {
  const a = anchorLabel(record({ status: 'unconfigured', txHash: null, confirmedAt: null, attempts: 0 }), BASE);
  assert.equal(a.cls, 'digest-status unconfigured');
  assert.equal(a.text, 'Off-chain');
  assert.equal(a.link, null);
});

test('every class the chip can produce is one the stylesheet actually styles', () => {
  // A class nobody styled is an unstyled chip on screen, and the only witness
  // would be a visitor. The stylesheet is read as text because the browser that
  // would resolve the cascade is not here.
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const states = [
    null,
    record(),
    record({ status: 'pending' }),
    record({ status: 'pending', txHash: null }),
    record({ verifies: false }),
    record({ verifies: null }),
    record({ status: 'queued', txHash: null }),
    record({ status: 'submitting', txHash: null }),
    record({ status: 'failed', txHash: null, attempts: 1 }),
    record({ status: 'unconfigured', txHash: null }),
  ];
  const classes = new Set();
  for (const dc of states) for (const cls of anchorLabel(dc, BASE).cls.split(/\s+/)) classes.add(cls);
  assert.ok(classes.size >= 4, `${classes.size} distinct chips, which says the walk above lost its states`);
  for (const cls of classes) {
    assert.ok(css.includes(`.${cls}`), `${cls} is a class the chip uses and the stylesheet never styles`);
  }
});
