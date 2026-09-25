/**
 * What the day-anchor widget may say, as a function of the record.
 *
 * The widget is the only place anybody ever looks at the anchor, and it has to
 * hold three different news items without confusing them: a commitment that
 * disagrees with its own numbers (*corrupt*, and a claim about the record), a
 * commitment this build cannot read at all (*unchecked*, and a claim about the
 * build), and a record that is merely in flight. The first two arrived as one
 * boolean until the verifier gained a third answer, and a widget that renders a
 * `null` as either of the two colours it already knows would be reporting a
 * verdict the server explicitly refused to give.
 *
 * A pure module rather than an `if`/`else` chain inside `refreshState` because
 * the table is nine distinct chips produced from eleven records, and the page can
 * be booted once per test process: a wiring test can put exactly one payload on
 * the wire, so the rest of the table would go unexercised. The boot test that
 * stands beside this one proves the widget is driven by these rows.
 *
 * Only `verifies === true` earns a confident label. `false` is corrupt, and
 * anything else — `null`, or a response from a build that has never heard of the
 * field — is "nobody checked", which is a third thing and gets third words.
 */

/** `0x1234…5678` — short enough for a header chip, unique enough to click. */
const shorten = (hash) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

/**
 * @param {object|null} dc the `/state` `digestChain`, or null for "no record"
 * @param {string} explorerTxUrl the base the server told this page to use
 * @returns {{cls: string, text: string, link: {label: string, href: string, title: string}|null}}
 *   the class to put on the chip, the plain words in it, and the link beside them
 *   (`null` when there is nothing on chain to point at)
 */
export function anchorLabel(dc, explorerTxUrl = '') {
  if (!dc) return { cls: 'digest-status', text: '', link: null };

  // Only a record that names a transaction may link to one. `pending` and
  // `confirmed` are the statuses that carry a hash; a `pending` without one is
  // the specific lie this widget was rewritten to stop rendering as hope.
  const href = dc.txHash ? `${explorerTxUrl}${dc.txHash}` : null;
  const inFlight = dc.status === 'pending' || dc.status === 'confirmed';

  if (dc.verifies === false || (inFlight && !dc.txHash)) {
    // The payload disagrees with its own hash, or a status claims a transaction
    // that is not there. Either way the anchor is worthless, and there is no
    // link worth offering.
    return { cls: 'digest-status failed', text: 'Anchor corrupt', link: null };
  }

  if (dc.verifies !== true) {
    // `null` is the server saying "this build has no rule for the version the
    // record names", which says nothing about whether the day is on chain. So
    // the transaction is still shown when there is one — hiding the evidence
    // would be its own lie — and the words decline to certify it. Grey, not
    // amber: nothing is being spent on this, and nothing is being asserted.
    //
    // `!== true` rather than `=== null`, because a response that never carried
    // this field is the same news: nobody checked. Rendering an absent verdict as
    // the confident one would have the page certify a commitment the server
    // refused to certify, which is the one thing this chip exists not to do.
    return {
      cls: 'digest-status unconfigured',
      text: 'Anchor unchecked',
      link: href ? { label: shorten(dc.txHash), href, title: 'On chain, but this build has no rule for the version this record names' } : null,
    };
  }

  if (dc.status === 'confirmed') {
    return { cls: 'digest-status confirmed', text: '', link: { label: `✓ ${shorten(dc.txHash)}`, href, title: 'View on explorer' } };
  }

  if (dc.status === 'pending') {
    return { cls: 'digest-status pending', text: '', link: { label: `Committing… ${shorten(dc.txHash)}`, href, title: 'Broadcast, waiting for a block' } };
  }

  if (dc.status === 'queued' || dc.status === 'submitting') {
    // Due, or attempted and not yet answered. Amber because something is being
    // spent on it, unlinked because there is nothing on chain to link to.
    return { cls: 'digest-status pending', text: 'Anchoring…', link: null };
  }

  if (dc.status === 'failed') {
    const spent = dc.attempts >= dc.maxAttempts;
    return {
      cls: 'digest-status failed',
      text: spent ? `Anchor dropped (${dc.attempts} tries)` : `Retry ${dc.attempts}/${dc.maxAttempts}`,
      link: null,
    };
  }

  return { cls: 'digest-status unconfigured', text: 'Off-chain', link: null };
}
