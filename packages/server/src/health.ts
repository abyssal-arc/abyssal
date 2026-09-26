/**
 * Self-observation for the paths that have no other witness.
 *
 * Every guard in this build announces itself with `console.error`, and that
 * announcement is the only place a failed storage write exists. Whether anyone
 * can read it is not a small question: the five `wrangler tail` captures on disk
 * hold 268 records across four worker versions, and in every one of them the
 * `logs` array was empty — while `exceptions` did arrive (19 records carrying
 * "Exceeded allowed volume of requests in Durable Objects free tier"). So the
 * channel demonstrably carries events. What has never been demonstrated, in any
 * of those captures, is that it carries console output — and because all eleven
 * `console.*` sites in the deployed code (five in `handler.ts`, six in
 * `worker.ts`, none on a path that says "I am alive") sit on failure paths, an
 * empty `logs` array reads exactly the same whether nothing went wrong or
 * nothing arrived.
 *
 * That ambiguity is the thing this module removes. A counter readable with
 * `GET /health` needs no log transport, no retention window and nobody
 * watching: it is either zero or it is not. The console lines stay, because a
 * human at a terminal wants them; they simply stop being the only answer.
 *
 * Two properties are deliberate:
 *
 *   - Counts are per world instance, not per module load. One process can host
 *     a durable world and a local mirror; merging their tallies would let the
 *     mirror's failures hide the world's. It also keeps the test suite honest —
 *     every case builds its own instance and reads only its own numbers.
 *   - Merging with a persisted view never lowers a count and never moves an
 *     event backwards. It runs once, during boot, while this isolate has yet to
 *     observe anything — and taking the max rather than assigning is what makes
 *     the ordering irrelevant, so a failure that lands before the merge is read
 *     back is still standing afterwards. What the rule cannot do is add two
 *     totals that describe overlapping history, which is why the view is written
 *     through on every signal rather than on a schedule.
 */

import { SNAPSHOT_BUDGET } from '@abyssal/sim';

/**
 * Everything worth counting, named after the consequence rather than the
 * function that noticed. `*_past_budget` entries are warnings: the write still
 * worked, and the point of counting them is the day it stops working. Whether a
 * warning reddens the light is decided by `ADVISORY_KINDS` below, not by this
 * list — counting and alarming are two questions and only one of them is "is
 * this a fault".
 */
export const SIGNAL_KINDS = [
  'receipt_not_stored',
  'ledger_not_stored',
  'snapshot_not_saved',
  'snapshot_past_budget',
  'receipts_past_budget',
  'digest_pump_failed',
  'digest_verify_refused',
  'digest_not_broadcast',
  'digest_reverted',
  'digest_record_rejected',
  /**
   * A day's transaction confirmed on chain and the day book could not be told
   * which one — the row for that day was gone (trimmed, or refused on load) or
   * publishes a different hash than the payload that was broadcast. Counted
   * because the failure is invisible from the outside: the day still shows its
   * numbers and its digest, and only the absent explorer link says that the
   * claim "this census is checkable against the chain" stopped holding for it.
   */
  'digest_anchor_unstamped',
  /**
   * The day closed, the transaction confirmed, and the chain would not say what
   * it cost or what the account holds. Nothing about the anchor breaks when this
   * happens — the day still commits, the census still grows — so without a count
   * the site would keep publishing a funding figure it can no longer support.
   * Counted because the honest answer to "how long is this funded for" is
   * "unknown, and here is when it stopped being known".
   */
  'anchor_econ_unreadable',
  /**
   * `eth_getBalance` and the USDC `balanceOf` of the signing address no longer
   * truncate into each other at the ratio every quantity in `econ.ts` converts
   * between. Dust under the six-decimal boundary is expected and is not this
   * signal — the deployed account carries it — so what fires it is the quotient
   * itself moving, which means the chain's fee model changed. At that point the
   * runway is not slightly wrong but meaningless, and the number that would
   * quietly be wrong is the one a top-up gets decided from.
   */
  'arc_unit_scale_unexpected',
  /**
   * Fewer days of commitment are funded than `RUNWAY_ALARM_ANCHORS`. Edge
   * triggered like the budget watermarks: a low balance that stays low is one
   * event, not a counter that doubles every poll until it buries the two numbers
   * that were the reason for looking.
   */
  'anchor_runway_low',
  /**
   * A stored economics object no longer means what it claims, so it was refused on
   * load and the funding figures start over from nothing. Counted on the same
   * argument as `digest_record_rejected`: the row came out of storage, whatever
   * wrote it is already gone, and without a number the only evidence is a console
   * line that is never delivered. Its `detail` carries which field failed.
   */
  'anchor_econ_rejected',
  /**
   * The `finalized` block tag was refused or answered with something that is not
   * a number, so that poll indexed the chain's head instead. Measured against the
   * configured endpoint, `latest`, `safe` and `finalized` name the same block in
   * every round of an atomic batch (`FINALITY_TAG` in arc.ts carries the sample),
   * so falling back costs nothing today. It is counted because that equivalence is
   * a property of the node's answer rather than of the code, and the day the node
   * starts lagging is the day the feed would otherwise be reporting blocks that
   * can still move — the kind of change a projection never notices from inside.
   */
  'arc_finality_unavailable',
  /**
   * A stored day-book row no longer means what it claims — usually a headcount
   * that does not add up to the population beside it. Counted for the same reason
   * as the digest record above: the row was read out of storage, so whatever wrote
   * it is already gone, and without a number the only evidence that the tank's
   * history is being discarded on every cold start is a console line that is never
   * delivered. Its `detail` carries the reason for the same reason.
   */
  'census_row_rejected',
  /**
   * A day that just closed could not be filed because its own numbers disagree.
   * This is `census_row_rejected` caught at the source: the row never reaches
   * storage, so the book stops growing rather than silently shrinking on the next
   * cold start. Counted because both halves are quiet — the anchor goes on working
   * and `/health` stays green while `census.days` simply stops advancing.
   */
  'census_row_unsound',
  /**
   * The day book reached its cap and a day fell out of the front of it. A warning
   * in the `*_past_budget` sense: nothing failed, the write worked, and the point
   * of counting it is that history silently stops being complete from here on.
   * The cap is what just over 20 days of a busy tank measures out (see `CENSUS_CAP`),
   * so a growing count is a world that has been running a while and a signal to
   * go publish the part about to be forgotten. The byte watermark beside it is
   * alarming rather than advisory because it says the ceiling has been crossed,
   * not that it is nearly.
   */
  'census_days_dropped',
  /**
   * The day book measures bigger than the slice of the ledger value it was given,
   * counted on the rows it actually holds rather than on the row width the cap was
   * derived from. Alarming where `census_days_dropped` is a warning, because the
   * two fail differently: a row count at the cap says the book is full, while a
   * *wider* row over-spends the same budget with the count nowhere near it — and
   * that is not hypothetical, it is the arithmetic this build's own comment got
   * wrong (345 bytes claimed against 374 measured, a cap of 379 rows that would
   * have cost 142,126 bytes of a 131,072 share). Nothing breaks at the crossing:
   * the write still goes in, and the platform's own ceiling is far above. What
   * breaks is the claim that the book fits its budget, which is the claim the cap
   * exists to keep.
   */
  'census_past_budget',
  /**
   * A stored day-book row arrived with no `v` — written before a row carried the
   * rule its own hash was made under — and the loader named that rule for it. A
   * warning in the `*_past_budget` sense: nothing failed, no history was lost, and
   * the count exists because the repair is a *claim* (see `LEGACY_RULE_VERSION` on
   * why the answer is 1 rather than a guess) being applied to real records. The
   * `detail` says how many rows and which version. It is the only member of
   * `ADVISORY_KINDS` — counted, published, and deliberately not an alarm, because
   * serving a record that predates a field is what the loader is for. It fires once
   * per legacy snapshot: the label is saved back with the row, so the next cold
   * start finds a book that already names its rule (measured by the
   * `a row named at load is saved named` test). A count that starts growing again
   * therefore means a snapshot arrived from a build older than the one reading it.
   */
  'census_rule_backfilled',
  /**
   * A payer did the wallet work and the money could not be taken. Counted
   * because nothing else can see it: the buyer gets a 402 back and moves on, and
   * the only record of a lost sale would be a log line nobody tails.
   *
   * Two refusals on the same route are deliberately not on this list, for one
   * reason: a refused replay and a precheck rejection (`signer_mismatch`, an
   * expired authorization, a wrong `payTo`) are both reachable by anyone with a
   * keyboard and no money, while everything counted here either cost a real
   * payment or is a fact about our own infrastructure. An ordinary wallet retry
   * after a timeout also looks like the first case from here. A counter that
   * turns the health light red over what an anonymous caller chose to send is a
   * counter that gets ignored the next time it matters.
   */
  'data_settle_failed',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * Kinds that are counted and published but never redden the light.
 *
 * The list has to exist because `healthProblem` answers one question — has this
 * happened inside the window — while not every counted fact is a fault. The member
 * below is a repair applied to records that predate the field it fills in: correct
 * on every read that finds such a record, and not a failure on any of them.
 *
 * What it costs to keep it alarming is measured, not argued. The field went out in
 * a build deployed on 2026-09-26 and the first cold start after it reported
 * `33 row(s) of 33 arrived with no v; named 1`, timestamped 04:53:30Z. `/health` at
 * 07:14:39Z still reads exactly `1` — and the isolate that answered had itself just
 * started, its `isolateStartedAt` equal to the `serverTime` of the same response, so
 * this is a cold start that found the label already stored rather than a tank that
 * never woke up. A red light for a day over a book that loaded correctly is still a
 * red light nobody can act on, and it would sit on top of whatever else happened in
 * those 24 hours.
 *
 * The window this signal can re-open is the age of the snapshot, not of the book: a
 * ledger imported from a build older than the field would fire again, and the
 * book's own rows stay servable for 349 filed days — 20.2 days at the mean of the
 * 34 gaps the 07:15Z book measures (1 h 19 m 59 s to 1 h 30 m 04 s).
 *
 * Advisory kinds stay in `counts`, stay in `last` with their detail, and are
 * named by `advisorySignals`, so the exemption costs no information — the same
 * bargain `staleSignals` makes about the freshness window.
 */
export const ADVISORY_KINDS = ['census_rule_backfilled'] as const satisfies readonly SignalKind[];

export type AdvisoryKind = (typeof ADVISORY_KINDS)[number];

const ADVISORY: ReadonlySet<string> = new Set<string>(ADVISORY_KINDS);

/** Whether this kind is counted without ever holding the light red. */
export const isAdvisoryKind = (kind: string): boolean => ADVISORY.has(kind);

export interface SignalEvent {
  at: number;
  detail: string;
  /** The running total for this kind at the moment the event was recorded. */
  count: number;
}

/** What a health ledger knows: JSON-safe, and exactly what storage will hold. */
export interface HealthView {
  /** When this ledger was created, so `startedAt` older than any event means the process has not been restarted since. */
  startedAt: number;
  counts: Record<string, number>;
  last: Record<string, SignalEvent>;
}

export interface Health {
  note(kind: SignalKind, err?: unknown): void;
  view(): HealthView;
  merge(stored: unknown): void;
}

const isKind = (k: unknown): k is SignalKind => (SIGNAL_KINDS as readonly string[]).includes(String(k));

/** Kept short so a whole view fits comfortably in one small storage value. */
const DETAIL_MAX = 400;

/**
 * The whole message when it fits; the first and last halves when it does not.
 *
 * Truncating from the front turns out to keep the part that says the least.
 * The error this code actually meets in production is viem's
 * `TransactionExecutionError`, whose first line explains the fee model, whose
 * middle reproduces the request — including a `data:` line of raw calldata
 * several hundred characters long — and whose last real line is
 * `Details: insufficient funds for gas * price + value`, the endpoint's own
 * answer. Measured on that message, the headline is under 100 characters and
 * the `Details:`/`Version:` pair is under 80, so a clip that keeps both ends
 * keeps everything worth keeping and drops the calldata that is already
 * reproducible from the digest record.
 */
function clip(message: string): string {
  if (message.length <= DETAIL_MAX) return message;
  const tail = Math.floor((DETAIL_MAX - 3) / 2);
  return `${message.slice(0, DETAIL_MAX - 3 - tail)} \u2026 ${message.slice(-tail)}`;
}

function describe(err: unknown): string {
  if (err === undefined || err === null) return '';
  return clip(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

/**
 * A ledger for one world instance. `onChange` fires after every note, which is
 * the Durable Object's cue to write the view somewhere that outlives it; it is
 * called at most once per signal, and signals are meant to be impossible.
 */
export function createHealth(startedAt: number = Date.now(), onChange?: (v: HealthView) => void): Health {
  const counts = new Map<string, number>();
  const last = new Map<string, SignalEvent>();

  const view = (): HealthView => ({
    startedAt,
    counts: Object.fromEntries(counts),
    last: Object.fromEntries(last),
  });

  return {
    note(kind, err) {
      // An unknown kind is a programming mistake at the call site, not state to
      // record: silently filing it under a name nobody declared is how a
      // counter becomes a place to lose things.
      if (!isKind(kind)) throw new TypeError(`unknown health signal: ${String(kind)}`);
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      last.set(kind, { at: Date.now(), detail: describe(err), count: next });
      try {
        onChange?.(view());
      } catch {
        // Losing the durability of a counter must not cost the request that
        // just proved the counter was needed. The console line at the call site
        // is still printed, and the in-memory count still stands.
      }
    },
    view,
    merge(stored) {
      if (!stored || typeof stored !== 'object') return;
      const s = stored as Partial<HealthView>;
      for (const [kind, value] of Object.entries(s.counts ?? {})) {
        // A count is only worth merging when it is a positive whole number:
        // zero carries no information and a negative one means the stored view
        // is corrupt, which is not a state to file under a real kind.
        if (!isKind(kind) || typeof value !== 'number' || !Number.isFinite(value) || value < 1) continue;
        counts.set(kind, Math.max(counts.get(kind) ?? 0, Math.floor(value)));
      }
      for (const [kind, event] of Object.entries(s.last ?? {})) {
        if (!isKind(kind) || !event || typeof event.at !== 'number') continue;
        const mine = last.get(kind);
        if (!mine || event.at > mine.at) last.set(kind, { ...event, count: Math.max(event.count ?? 0, mine?.count ?? 0) });
      }
    },
  };
}

/**
 * Whether there is anything to read, and whether it is still happening.
 *
 * A signal counts here only if its last event is inside `PROBLEM_WINDOW_MS`. That
 * is the whole difference between a number and an alarm: counts are cumulative and
 * outlive every deploy, so a rule that reddens on `count > 0` reports a defect that
 * was fixed last week as a present-tense failure forever — and an alarm that can
 * never go off again is not read the next time it matters. Nothing is hidden by
 * this: the totals stay in `counts`, and `staleSignals` names the kinds that are
 * out of window so a reader can tell "clean for a day" from "clean, ever".
 *
 * Deliberately blunt in every other respect: a monitoring caller should not have
 * to reproduce the rules for which kinds count, so there is one window and it
 * applies to all of them. The one exception is `ADVISORY_KINDS`, which is exempt
 * for the reason argued there — and stays published through `advisorySignals`.
 */
export function healthProblem(v: HealthView | null | undefined, now: number = Date.now()): string | null {
  if (!v || typeof v.counts !== 'object' || v.counts === null) return 'no health view';
  const flagged = Object.entries(v.counts).filter(([kind, n]) => (typeof n === 'number' && n > 0) && !isAdvisoryKind(kind) && isFresh(v, kind, now));
  if (!flagged.length) return null;
  return flagged
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
}

/**
 * How long a signal holds the health light red after it last fired.
 *
 * One day of wall clock, which is not a generous number for this system: the
 * longest interval between any two events the anchor machinery can produce is one
 * world day (about 81 minutes measured), so a full day of silence covers every
 * daily path here more than eighteen times over. Anything that fired once, a day
 * ago, and has not repeated is history rather than a fault.
 */
export const PROBLEM_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Whether the last event of this kind is inside the window. */
function isFresh(v: HealthView, kind: string, now: number): boolean {
  const event = v.last?.[kind];
  // No event to date the count by is treated as fresh, not as stale. A count that
  // arrived from storage without a timestamp is a corrupt or an ancient ledger,
  // and guessing "ancient" is how the one case that should be looked at gets the
  // benefit of the doubt.
  if (!event || typeof event.at !== 'number') return true;
  return now - event.at <= PROBLEM_WINDOW_MS;
}

/**
 * Kinds that have fired, are not advisory, and are now out of window, as
 * `kind=count` strings.
 *
 * Published next to `problem` so the recency rule costs no information: a reader
 * sees what is wrong now and what was wrong lately, in the same response, without
 * having to know that the two are produced by different rules. Advisory kinds are
 * left out because they are reported by `advisorySignals` whatever their age, so
 * filing them here too would put one number in two lists that a reader takes to
 * mean different things — with those two functions, every counted kind appears in
 * exactly one of `problem`, `stale` and `advisory`.
 */
export function staleSignals(v: HealthView | null | undefined, now: number = Date.now()): string[] {
  if (!v || typeof v.counts !== 'object' || v.counts === null) return [];
  return Object.entries(v.counts)
    .filter(([kind, n]) => typeof n === 'number' && n > 0 && !isAdvisoryKind(kind) && !isFresh(v, kind, now))
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`);
}

/**
 * Kinds that have fired and are exempt from alarming, as `kind=count` strings.
 *
 * No `now` and no window, because the claim is different in kind: `stale` says
 * "this happened, and it is no longer happening", while an advisory says "this is
 * a standing fact about the records on disk". The totals are what a reader wants
 * from it, and the timestamps are already beside them in `signals.last`.
 */
export function advisorySignals(v: HealthView | null | undefined): string[] {
  if (!v || typeof v.counts !== 'object' || v.counts === null) return [];
  return Object.entries(v.counts)
    .filter(([kind, n]) => typeof n === 'number' && n > 0 && isAdvisoryKind(kind))
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`);
}

/**
 * The size of the stored receipts array, exactly, for `n` normalized entries.
 *
 * The receipts set is one storage value (an array of 66-character hex strings),
 * so it has the same per-value ceiling as the snapshot and — until this existed
 * — no budget check of its own. Every entry is produced by `receiptKey`, which
 * lowercases and whose input has already been validated against
 * `/^0x[0-9a-fA-F]{64}$/`, so the length is a pure function of the count:
 * two brackets, 68 bytes per quoted entry, one comma between neighbours.
 *
 * `JSON.stringify` is never called on the real array to find this out, because
 * the array only becomes large enough to matter at the same moment that doing
 * so per burn would start costing CPU on the payment path.
 */
export function receiptsValueBytes(n: number): number {
  return n <= 0 ? 2 : 69 * n + 1;
}

/**
 * Whether a stored collection has just crossed its budget, and whether that is news.
 *
 * The state machine behind both snapshot watermarks in `worker.ts` and the day book's
 * in `handler.ts`, so it lives with the counters it feeds rather than with one of the
 * three callers. Extracted and exported because no world built by legal means can
 * reach the snapshot's line: the sim's caps, every one of them full, come to about
 * 1.15 MiB against a budget of 1.5 MiB on purpose — a budget that worst case already
 * violates would warn on every save and then be ignored. The day book's line is
 * reachable by legal means (its rows are free-form numbers) but sits 196 bytes under
 * its budget at the cap, so the same rule is tested by handing it numbers here.
 * Crossing up announces once, staying over does not repeat, and dropping back re-arms
 * it.
 */
export function budgetCrossed(
  bytes: number,
  wasOver: boolean,
  budget: number = SNAPSHOT_BUDGET,
): { over: boolean; announce: boolean } {
  const over = bytes > budget;
  return { over, announce: over && !wasOver };
}
