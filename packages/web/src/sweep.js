/**
 * Tallying a whole-book verification pass, as a function of what came back.
 *
 * The per-row widget answers one day. This answers "I forwarded the day book —
 * are ALL of these days intact?" in one glance, and a naive answer is exactly as
 * dishonest as a naive per-row one: a `verified / total` fraction that quietly
 * drops the rows a node never answered, or that files `uncheckable` (a rule this
 * build never published) under "fine, move along", would tell the reader the
 * history is intact when what it means is "we could not tell you about a third of
 * it." So every row lands in exactly one of four tiers and the four always add up
 * to the number of stamped rows:
 *
 *   intact      `verified` — the bytes on chain hash to what the book says;
 *   problems    `mismatch`, `not-found`, `unreadable` — evidence something is wrong;
 *   cannotSay   `uncheckable`, `unknown`, `pending`, `client-error`, `shape-unknown`
 *               — not evidence either way; a fact about this build or this fetch;
 *   unchecked   a stamped row we have no answer for yet (still in flight, or the
 *               sweep was interrupted) — never silently merged into `cannotSay`,
 *               because "we haven't looked" and "we looked and could not tell"
 *               are different sentences a reader deserves to distinguish.
 *
 * The invariant `intact + problems + cannotSay + unchecked === stamped` is the
 * whole point and every mutant here is written to break it in a different way. A
 * row with no `txHash` is not a stamped row and is not counted in `stamped` — it
 * never went on chain, so there is nothing to check and no lie to tell about it.
 *
 * `stateByHash` maps a transaction hash to the state string the per-row widget
 * would show for it (the same vocabulary as `verify.js`), so this file never
 * re-reads a response body and cannot disagree with the widget about what a body
 * meant. A hash missing from the map is an `unchecked` row.
 */

/** The seven verdicts plus the two caller-added states, grouped by what they mean. */
const INTACT = new Set(['verified']);
const PROBLEMS = new Set(['mismatch', 'not-found', 'unreadable']);
const CANNOT_SAY = new Set(['uncheckable', 'unknown', 'pending', 'client-error', 'shape-unknown']);

/**
 * @param {object[]} rows the day book, oldest first — the array `/history/census` sent
 * @param {Map<string,string>|object} stateByHash txHash -> widget state string
 * @returns {{
 *   rows: number, stamped: number,
 *   intact: number, problems: number, cannotSay: number, unchecked: number,
 *   counts: Record<string, number>,
 *   done: boolean,
 * }}
 */
export function sweepTally(rows, stateByHash) {
  const get = (hash) => {
    if (!hash) return undefined;
    if (stateByHash instanceof Map) return stateByHash.get(hash);
    return Object.prototype.hasOwnProperty.call(stateByHash, hash) ? stateByHash[hash] : undefined;
  };

  const counts = {};
  let stamped = 0;
  let intact = 0;
  let problems = 0;
  let cannotSay = 0;
  let unchecked = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const hash = row && row.txHash;
    if (!hash) continue; // not on chain — not a candidate, not a gap
    stamped += 1;
    const state = get(hash);
    if (state === undefined) {
      unchecked += 1;
      continue;
    }
    counts[state] = (counts[state] ?? 0) + 1;
    if (INTACT.has(state)) intact += 1;
    else if (PROBLEMS.has(state)) problems += 1;
    else if (CANNOT_SAY.has(state)) cannotSay += 1;
    else unchecked += 1; // a state this file has no tier for is "not accounted for", not "fine"
  }

  return {
    rows: Array.isArray(rows) ? rows.length : 0,
    stamped,
    intact,
    problems,
    cannotSay,
    unchecked,
    counts,
    // `done` is the reader's cue that the sweep stopped asking, not that it was
    // clean — an interrupted pass is not a book with nothing wrong in it.
    done: unchecked === 0,
  };
}

/** The tiers, in the order the UI should print them, for the reverse-guard test. */
export const SWEEP_TIERS = ['intact', 'problems', 'cannotSay', 'unchecked'];
