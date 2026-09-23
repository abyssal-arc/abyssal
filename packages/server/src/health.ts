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

/**
 * Everything worth counting, named after the consequence rather than the
 * function that noticed. `*_past_budget` entries are warnings: the write still
 * worked, and the point of counting them is the day it stops working.
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
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

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
 * Whether there is anything to read. Deliberately blunt: a monitoring caller
 * should not have to reproduce the rules for which kinds count.
 */
export function healthProblem(v: HealthView | null | undefined): string | null {
  if (!v || typeof v.counts !== 'object' || v.counts === null) return 'no health view';
  const flagged = Object.entries(v.counts).filter(([, n]) => typeof n === 'number' && n > 0);
  if (!flagged.length) return null;
  return flagged
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
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
