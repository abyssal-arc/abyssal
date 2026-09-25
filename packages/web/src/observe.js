/**
 * What the rails panel is allowed to say about its own coverage.
 *
 * The panel ranks the contracts USDC moved through, and the ranking is counted over
 * the flow ring while the number printed above it is counted over the pulse series.
 * Those are two different collections: the ring is trimmed to its newest 6,000
 * flows, and because the block cursor survives an isolate eviction the ring refills
 * one live poll at a time while the pulse resumes from the ledger. So a restored
 * feed serves a full window of history above an almost empty ring.
 *
 * Measured on the deployed feed at 03:48:16Z–03:49:37Z on 2026-09-25, six reads
 * about 16 seconds apart reported 0, 453, 612, 722, 845 and 1,138 ring flows inside
 * windows the pulse was counting at 2,098 to 2,682 transfers — 0% to 44.5% — with
 * `unattributed` at 0 the whole time. Nothing was lying; the sentence was just
 * missing, and a reader had no way to know whether four rows meant four rails in a
 * quiet market or four rails out of forty.
 *
 * Two shortfalls, two sentences, because they mean different things:
 *
 *  1. *Unseen* — transfers in the window the ring never held. Nothing below
 *     describes them, and no rail can be blamed for their absence.
 *  2. *Unattributed* — flows the ring held whose transaction was never read. They
 *     belong to the tables and are missing from them.
 *
 * The first is computed here from the two numbers the panel prints rather than read
 * from the feed's own `unseen`, so it cannot disagree with the figures above it and
 * so a payload from before that field existed is answered the same way as one after
 * it. `unseen` is published for consumers reading the JSON without this panel, and
 * the server's test suite pins the two subtractions to each other.
 */

/** A number the panel may put in a sentence. Anything else is unknown, not zero. */
const count = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The sentences, worst coverage first: how much of the window these rows describe,
 * then what is left over inside the part they do describe.
 *
 * @param {{ windowFlows?: number, unattributed?: number } | null | undefined} cov
 *   the payload's `venueCoverage`, or nothing at all
 * @param {number | null | undefined} transfers
 *   `stats.transfers`, the heading number the rows sit under
 * @returns {{ key: string, args: Record<string, number> }[]} empty when the panel
 *   has nothing to take back
 */
export function venueCoverageNotes(cov, transfers) {
  const notes = [];
  const held = count(cov?.windowFlows);
  const total = count(transfers);
  if (held !== null && total !== null && total > held) {
    notes.push({ key: 'venueUnseen', args: { n: held, total } });
  }
  const unattributed = count(cov?.unattributed);
  if (unattributed !== null && unattributed > 0) {
    notes.push({ key: 'venueUnattributed', args: { n: unattributed } });
  }
  return notes;
}
