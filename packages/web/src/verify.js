/**
 * Projecting a `/verify` response onto the widget, as a function of the record.
 *
 * The route answers in seven verdicts and this file is the reason they stay seven
 * on screen: a widget that reads `verdict` into a green/red boolean would put back
 * the collapse the server just spent a batch un-learning. Three of the seven are
 * "nobody could tell you", and each of those points at a different layer —
 *
 *   - `client-error`: *this browser* could not fetch `/verify`. The site may be
 *     fine, the chain may be fine, and the last time this codebase confused that
 *     with `not-found` the fix was in a fetch handler, not in the chain;
 *   - `unknown`: the site asked the node and the node did not answer. Nothing was
 *     checked; a grey chip is the honest face of that sentence;
 *   - `not-found`: the node answered, and what it said is that no transaction with
 *     that hash exists. That is evidence, not the absence of evidence.
 *
 * Two more pairs that are not the same news either: `verified` alongside a reverted
 * receipt is byte-integrity without landing, and `uncheckable` is a fact about this
 * build, not about the day. Rendering either in the other's colour is how the day
 * book starts lying about its own history.
 *
 * A pure module rather than an `if`/`else` chain inside `renderVerify` because the
 * page can only be booted once per test process: nine states on the widget means
 * eight of them go unexercised by any single wiring test, and the boot test that
 * stands beside this one only has to prove the wiring reaches this table.
 *
 * What the widget may not say: any number the server did not hand it. The
 * technical context — block height, chain id, pre-image, disagreements — is the
 * server's own words and stays untranslated on purpose: a reader who is here to
 * check arithmetic wants the same bytes the server hashed, not a localised
 * rendering of them.
 */

/** The seven verdicts `/verify` may return, plus the two states the caller adds. */
const VERDICTS = {
  verified: { cls: 'verify-ok', key: 'verifyVerified' },
  mismatch: { cls: 'verify-bad', key: 'verifyMismatch' },
  uncheckable: { cls: 'verify-warn', key: 'verifyUncheckable' },
  pending: { cls: 'verify-pending', key: 'verifyPending' },
  'not-found': { cls: 'verify-bad', key: 'verifyNotFound' },
  unreadable: { cls: 'verify-bad', key: 'verifyUnreadable' },
  unknown: { cls: 'verify-warn', key: 'verifyUnknown' },
};

/**
 * @param {object|null} res the parsed `/verify` response, or null with a flag saying why
 * @param {object} [opts]
 * @param {boolean} [opts.loading] the fetch is in flight; nothing has been said yet
 * @param {boolean} [opts.fetchFailed] this browser could not reach `/verify` at all
 * @param {string|null} [opts.txHash] the transaction the reader clicked, for the explorer link
 * @param {string} [opts.explorerTxUrl] the base the server told this page to use
 * @param {unknown} [opts.error] what the fetch threw, kept raw — the same reason the pre-image is kept raw
 * @returns {{
 *   state: string, cls: string, headlineKey: string,
 *   notes: { key: string }[], tech: string[],
 *   link: { label: string, href: string, title: string } | null,
 * }}
 */
export function verifyView(res, opts = {}) {
  const { loading = false, fetchFailed = false, txHash = null, explorerTxUrl = '', error = null } = opts;

  // An explorer link is offered whenever we have a hash to point at, whatever the
  // site's own verdict was. Hiding the evidence because our route could not read
  // it is the mistake `anchor.js` documents at the top of this file.
  const link = txHash
    ? { href: `${explorerTxUrl}${txHash}`, label: 'explorer', title: txHash }
    : null;

  if (loading) {
    return { state: 'loading', cls: 'verify verify-pending', headlineKey: 'verifyChecking', notes: [], tech: [], link: null };
  }
  if (fetchFailed) {
    // The one place `error` reaches the wire: shown raw, and only the first line
    // of it, because a browser stack trace is a wall of text and this row has to
    // stay legible next to the day it is about.
    const first = String(error ?? '').split('\n')[0].slice(0, 240);
    return {
      state: 'client-error',
      cls: 'verify verify-warn',
      headlineKey: 'verifyFetchFailed',
      notes: [],
      tech: first ? [`fetch said: ${first}`] : [],
      link,
    };
  }
  const known = res && typeof res.verdict === 'string' ? VERDICTS[res.verdict] : null;
  if (!known) {
    // A response without a verdict is neither a pass nor a fail; it is this build
    // meeting a shape it has no row for. Grey and honest about what arrived —
    // pretending to have read the payload here is how the widget starts certifying
    // commitments the server refused to.
    const shape = res ? `keys: ${Object.keys(res).slice(0, 8).join(', ')}` : 'no body';
    return { state: 'shape-unknown', cls: 'verify verify-warn', headlineKey: 'verifyUnknown', notes: [], tech: [`unrecognised response (${shape})`], link };
  }

  const v = VERDICTS[res.verdict];
  const notes = [];
  // A revert alongside a verified hash is not a pass and not a fail: the bytes we
  // claim were sent are the bytes the chain holds, and the write did not land. The
  // headline stays green for the first sentence; this row is the second one.
  if (res.verdict === 'verified' && res.receipt && res.receipt.status === 'reverted') notes.push({ key: 'verifyReverted' });

  const tech = [];
  const chainParts = [];
  if (res.chain && typeof res.chain.blockNumber === 'string') chainParts.push(`block ${res.chain.blockNumber}`);
  if (res.context && typeof res.context.chainId === 'number') chainParts.push(`chain ${res.context.chainId}`);
  if (res.context && typeof res.context.chainAnswered === 'boolean') {
    chainParts.push(res.context.chainAnswered ? 'node answered' : 'node did not answer');
  }
  if (chainParts.length) tech.push(chainParts.join(' · '));
  if (typeof res.preImage === 'string' && res.preImage) tech.push(`pre-image: ${res.preImage}`);
  if (Array.isArray(res.disagreements)) {
    for (const d of res.disagreements) {
      tech.push(`disagreement: ${String(d?.field ?? '?')} chain=${String(d?.payload ?? '?')} book=${String(d?.row ?? '?')}`);
    }
  }
  // The server's one-sentence "why" is a technical artefact, not a label: keeping
  // it verbatim means a reader comparing our UI to `curl /verify` sees the same
  // bytes on both sides, which is the whole point of this panel existing.
  if (typeof res.problem === 'string' && res.problem) tech.push(`server said: ${res.problem}`);

  return { state: res.verdict, cls: `verify ${v.cls}`, headlineKey: v.key, notes, tech, link };
}

/** The nine states this file can return, for the reverse-guard test. */
export const VERIFY_STATES = ['loading', 'client-error', 'shape-unknown', ...Object.keys(VERDICTS)];
