/**
 * The anchor's funding runway, as one honest state plus the number behind it.
 *
 * `/health` already does the arithmetic: it divides the signing account's balance
 * by what the last confirmed day cost, and publishes the quotient as
 * `anchor.runway.anchors` — how many more days of commitment the site can still
 * pay for. The server refuses to invent a zero for a number it could not read, and
 * this file refuses the two ways a *display* undoes that honesty:
 *
 *   - colouring "unknown" like "fine" — a reader who is told the tank has no
 *     problem when what happened is that the balance could not be read will keep
 *     sailing past a real empty account; and
 *   - folding "not read yet" into "read, and it says nothing" — the first is a
 *     cold start before any confirmation was polled, the second is a live reading
 *     that failed, and the action they call for is different (wait, versus look at
 *     the reason).
 *
 * So exactly one state wins for any payload, in this precedence:
 *
 *   neverRead  no reading has been taken yet (`readAt` is 0/absent) — say nothing
 *              about money, because there is no money figure to speak of;
 *   unknown    a reading exists but produced no quotient (`anchors: null`) — show
 *              `runway.unknown` as the reason, never a number and never green;
 *   capped     a quotient so large it hit the safe-integer ceiling — it is a lower
 *              bound ("at least this many"), and reporting it as exact would be a
 *              false precision nobody asked for;
 *   low        a real quotient below `alarmBelow` (the durable alarm threshold) —
 *              the one state that is a warning colour and worth guarding on;
 *   ok         any other real quotient.
 *
 * `capped` and `low` cannot both hold: a capped reading is enormous by definition,
 * and the server's own `low` flag is only ever true for a finite number under the
 * threshold. This module reports what the payload says rather than re-deriving the
 * comparison, so it can never disagree with the server that computed it — the same
 * rule `sweep.js` follows by trusting the widget's state instead of re-reading a
 * response body.
 *
 * @param {object|null|undefined} anchor the `anchor` object from a `/health` body
 * @returns {{
 *   state: 'neverRead'|'unknown'|'capped'|'low'|'ok',
 *   anchors: number|null,
 *   alarmBelow: number|null,
 *   ageSeconds: number|null,
 *   reason: string|null,
 * }}
 */
export function runwayView(anchor) {
  const readAt = anchor && typeof anchor.readAt === 'number' ? anchor.readAt : 0;
  const ageSeconds = anchor && typeof anchor.ageSeconds === 'number' ? anchor.ageSeconds : null;
  const runway = anchor && anchor.runway ? anchor.runway : null;
  const alarmBelow = runway && typeof runway.alarmBelow === 'number' ? runway.alarmBelow : null;

  // A number only counts when it is actually a finite number; a null, a NaN or a
  // field a future payload moved to a string is "no quotient", not "zero".
  const anchors = runway && Number.isFinite(runway.anchors) ? runway.anchors : null;

  // Cold start outranks everything: before the first confirmation is polled there
  // is no reading to interpret, and the reason the server gives (`balance not
  // read`) belongs to a state the reader has not reached yet.
  if (!readAt) {
    return { state: 'neverRead', anchors: null, alarmBelow, ageSeconds: null, reason: null };
  }

  // A reading that produced no quotient is `unknown`, and `runway.unknown` is the
  // sentence that says why — surfaced verbatim rather than swallowed.
  if (anchors === null) {
    const reason = runway && typeof runway.unknown === 'string' && runway.unknown
      ? runway.unknown
      : 'no runway published';
    return { state: 'unknown', anchors: null, alarmBelow, ageSeconds, reason };
  }

  if (runway.capped === true) {
    return { state: 'capped', anchors, alarmBelow, ageSeconds, reason: null };
  }

  // Trust the server's `low` flag rather than recomputing `anchors < alarmBelow`:
  // the two would agree today, but the threshold lives on the server and re-deriving
  // it here is a second copy of a number that can drift from the first.
  if (runway.low === true) {
    return { state: 'low', anchors, alarmBelow, ageSeconds, reason: null };
  }

  return { state: 'ok', anchors, alarmBelow, ageSeconds, reason: null };
}

/** The states, in the order the UI can rank them, for the reverse-guard test. */
export const RUNWAY_STATES = ['neverRead', 'unknown', 'capped', 'low', 'ok'];
