/**
 * The day digest: what we pin on chain, and what decides the next move.
 *
 * Pulled out of `handler.ts`, where these responsibilities sat across ~80 lines
 * that no test had ever executed. Six defects are closed here rather than
 * patched in place, because they share two roots — a hash whose rule nobody
 * outside the function could reproduce, and a status field that could claim
 * more than had happened.
 *
 * The hash is SHA-256, not the FNV-1a this used to carry. FNV-1a returns 32
 * bits, so the birthday cost of finding a second input with the same digest is
 * about 2^16 — tens of thousands of candidate worlds, an afternoon on a laptop.
 * A number that cheap to collide is not a commitment, and the entire purpose of
 * broadcasting this to a blockchain is to make the value expensive to deny.
 * Nothing had been anchored when this changed (the signing key has never been
 * configured in any environment), so version 1 of the rule is the only rule
 * there is and no previously published digest is invalidated by it.
 *
 * Every field in the hash pre-image also ships in the payload, and the field
 * list is published as `DIGEST_HASH_FIELDS`. The old code hashed `world.tick`
 * without putting it in the payload, and put `topPredator` in the payload
 * without hashing it — so an outsider could neither recompute the hash nor be
 * sure the hash covered everything it was shown. A digest you cannot recompute
 * is a number to trust, not a proof, and this module exists to produce proofs.
 */

/** Calldata tag: ASCII "ABYS", so a reader of the chain can spot our records. */
export const DIGEST_MAGIC = '0x41425953';

/** Which hashing rule produced this payload. Bumping it means a new rule, not a tweak. */
export const DIGEST_V = 1;

/**
 * The fields that go into the hash, in the order they are joined. Exported
 * because a verifier needs it and should not have to read our source to learn
 * it; the payload is self-describing given this list and `v`.
 */
export const DIGEST_HASH_FIELDS = [
  'v', 'day', 'tick', 'population', 'totalEnergy', 'born', 'died', 'predations', 'topPredator',
] as const;

/** Domain separator, so this pre-image cannot be made to read as anyone else's. */
const PRE_IMAGE_PREFIX = 'abyssal-day-digest';

/** The day's world state, entirely as a function of the world. */
export interface DigestStats {
  /** Day being anchored. */
  day: number;
  /** The tick the snapshot was taken at — published, because "as of when" is part of the claim. */
  tick: number;
  population: number;
  totalEnergy: number;
  born: number;
  died: number;
  predations: number;
  /** `archetype:kills`, or null in an empty world. */
  topPredator: string | null;
}

export interface DigestPayload extends DigestStats {
  v: number;
  /** Hex SHA-256 of the pre-image described by `DIGEST_HASH_FIELDS`. */
  hash: string;
  /** Wall clock of the commit attempt. Deliberately outside the hash: when we broadcast is not a world fact. */
  ts: number;
}

/**
 * The slice of the world a digest is taken from. Structural rather than the
 * sim's `World` so this module has no dependency on the simulation and the
 * preview and the anchor can be *the same call* — see `digestStats`.
 */
export interface DigestWorldView {
  tick: number;
  creatures: { archetype: string; kills: number; energy: number }[];
  totalBorn: number;
  totalDied: number;
  totalPredations: number;
}

/**
 * The day's numbers, read off the world.
 *
 * Both the live preview in `/state` and the value that gets anchored call this
 * and then `digestHash`. They used to be two separate expressions over two
 * separate field lists, which meant the number shown to viewers all day under
 * the words "commits on-chain at day end" was never the number that went on
 * chain. A shared function is the only fix that keeps them from drifting again.
 *
 * The top-predator tie-break is by archetype name, not array order. `killsBy`
 * is built by iterating the population, so an ordering tie would otherwise be
 * settled by who spawned first — a fact about our array, not about the day, and
 * not something a verifier holding only the payload could reproduce.
 */
export function digestStats(day: number, w: DigestWorldView): DigestStats {
  const killsBy: Record<string, number> = {};
  for (const c of w.creatures) killsBy[c.archetype] = (killsBy[c.archetype] ?? 0) + c.kills;
  const winner = Object.entries(killsBy).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return {
    day,
    tick: w.tick,
    population: w.creatures.length,
    totalEnergy: Math.round(w.creatures.reduce((s, c) => s + c.energy, 0)),
    born: w.totalBorn,
    died: w.totalDied,
    predations: w.totalPredations,
    topPredator: winner ? `${winner[0]}:${winner[1]}` : null,
  };
}

/**
 * The hash pre-image: the fields, in order, joined by `|`.
 *
 * `null` becomes `~` rather than the empty string. An empty field against a
 * delimiter-joined fixed-width list is not ambiguous here, but `~` makes the
 * rendered pre-image legible and keeps "no creatures" visibly distinct from an
 * archetype that somehow got named the empty string.
 */
export function digestPreImage(p: Pick<DigestPayload, (typeof DIGEST_HASH_FIELDS)[number]>): string {
  const field = (v: string | number | null): string => (v === null ? '~' : String(v));
  return [PRE_IMAGE_PREFIX, ...DIGEST_HASH_FIELDS.map((k) => field(p[k]))].join('|');
}

// Node has exposed webcrypto globally since v19 and Workers always have it; the
// dynamic import only runs on a runtime that has neither, so it never executes
// where `node:crypto` is absent. Same arrangement as `facilitator.ts`, which
// also names the slice it needs instead of reaching for a DOM lib type.
interface DigestSubtle {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

async function subtle(): Promise<DigestSubtle> {
  const c = globalThis.crypto ?? (await import('node:crypto')).webcrypto;
  return c.subtle;
}

/** Lowercase hex SHA-256, so a verifier's `sha256sum` output compares directly. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await (await subtle()).digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function digestHash(stats: DigestStats): Promise<string> {
  return sha256Hex(digestPreImage({ v: DIGEST_V, ...stats }));
}

/** Build the payload that goes on chain: the stats, the rule version, and their hash. */
export async function buildPayload(stats: DigestStats, ts: number): Promise<DigestPayload> {
  const base = { v: DIGEST_V, ...stats };
  return { ...base, ts, hash: await digestHash(base) };
}

/**
 * Recompute the hash from a payload alone.
 *
 * This is the whole point of the shape: anyone with the calldata, the field
 * list and a SHA-256 implementation can confirm the numbers say what the
 * commitment claims they say, without trusting this repository to agree.
 */
export async function verifyPayload(p: DigestPayload): Promise<boolean> {
  const { hash, ts, ...rest } = p;
  void ts; // Not hashed. Excluded explicitly so adding a field cannot silently join the pre-image.
  return (await digestHash(rest)) === hash;
}

/** The payload as calldata: the magic tag, then the JSON hex-encoded. */
export function encodeDigest(p: DigestPayload): `0x${string}` {
  const json = JSON.stringify(p);
  let hex = '';
  for (const ch of new TextEncoder().encode(json)) hex += ch.toString(16).padStart(2, '0');
  return `0x${DIGEST_MAGIC.slice(2)}${hex}` as `0x${string}`;
}

/* ------------------------------------------------------------------ the day book */

/**
 * One day of the tank as observed, alongside the commitment made for it.
 *
 * The digest answers "what did we pin"; this answers "what was alive". Both are
 * built from the same `DigestStats` and the same world view at the same instant,
 * which is the whole design: a census whose population came from a different
 * reading than the anchored one is a second number to explain, and the two used
 * to be computed in two places that had never been made to agree.
 *
 * `byArchetype` is deliberately *outside* the hash. `DIGEST_HASH_FIELDS` is rule
 * v1 and days are already anchored under it on chain, so widening the commitment
 * is a version bump with its own decision — not something a row can sneak in.
 * A reader can verify the hashed fields against the transaction and should read
 * the headcounts as our report of the same tick, which is exactly what they are.
 */
export interface CensusDay extends DigestStats {
  /** The commitment made for this day: `digestHash({ v: DIGEST_V, ...stats })`. */
  hash: string;
  /** Headcount per archetype, counted off the world the stats came from. */
  byArchetype: Record<string, number>;
  /** Wall clock of the reading. Outside the hash, like the payload's `ts`. */
  ts: number;
}

/**
 * Heads per archetype, counted off the world a reading was taken from.
 *
 * One rule, exported, used both by the day book (`censusRow`) and by the live
 * answer in `/history/census` — so the bar a viewer watches grow today is made of
 * the same count as the bars for the days behind it. Two expressions for one
 * number is how the tank ended up with a preview that did not match its anchor.
 */
export function headcountByArchetype(w: DigestWorldView): Record<string, number> {
  const byArchetype: Record<string, number> = {};
  for (const c of w.creatures) byArchetype[c.archetype] = (byArchetype[c.archetype] ?? 0) + 1;
  return byArchetype;
}

/**
 * The row for a day, from the numbers that were anchored with it.
 *
 * Takes the stats rather than recomputing them on purpose: the alternative is a
 * second expression over the world, and a second expression is how two honest
 * functions end up disagreeing about one population.
 */
export function censusRow(stats: DigestStats, w: DigestWorldView, hash: string, ts: number): CensusDay {
  return { ...stats, byArchetype: headcountByArchetype(w), hash, ts };
}

/**
 * Name a way this row claims more than was observed, or return null.
 *
 * Same posture as `coherenceProblem`: the builder cannot produce these, so a row
 * that does have one arrived from a stored ledger that was edited, truncated, or
 * written by a future version that no longer means the same thing by these
 * fields. Rows are checked on the way in and a bad one is dropped rather than
 * served as history.
 */
export function censusProblem(row: CensusDay): string | null {
  const heads = Object.values(row.byArchetype ?? {}).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
  if (heads !== row.population) {
    return `archetype headcount ${heads} is not the population ${row.population} it was taken with`;
  }
  // Bare lowercase hex, the exact output of `digestHash`: a *transaction* hash
  // carries the `0x`, our digest does not, and demanding the prefix here would
  // reject every row the pump honestly writes — quietly emptying the book on the
  // next cold start. Shape only, not re-hashing: `verifyPayload` is the place a
  // hash is checked against its numbers, and it is run on the payload.
  if (!/^[0-9a-f]{64}$/.test(row.hash ?? '')) return 'hash is not a SHA-256 hex digest';
  if (!Number.isInteger(row.day) || row.day < 0) return `day ${String(row.day)} is not a day number`;
  if (row.population < 0 || row.totalEnergy < 0) return 'negative population or energy';
  // Cumulative counters only run one way in one world. A decrease means the
  // counters belonged to a different world than this row claims, which is the
  // reseed case, and `censusChanges` is where that gets said out loud.
  if (row.born < 0 || row.died < 0 || row.predations < 0) return 'negative cumulative counter';
  return null;
}

/** How one day differed from the one before it. */
export interface CensusChange {
  /** The day being described: the later of the two rows. */
  day: number;
  tick: number;
  population: number;
  populationDelta: number;
  /** Null when the cumulative counters cannot be differenced — a reseed, or a
   * gap in the book. Zero would be a claim about a day nobody measured. */
  born: number | null;
  died: number | null;
  predations: number | null;
  /** Species with members in the earlier row and none in this one. */
  lost: string[];
  /** Species absent from the earlier row and present in this one. */
  gained: string[];
}

/**
 * Extinctions, emergences and per-day activity, derived rather than stored.
 *
 * Nothing here is a field on a row. Storing `lost` would mean the row that
 * *reports* an extinction also decides what counts as one, and the rule changes
 * whenever the reader's does. Derived from consecutive rows, one rule, in one
 * place: anybody who disagrees can run this function over the published book.
 *
 * The first row produces no change, because its predecessor is not in the book:
 * `coverage.first` on the route is where that gap is admitted instead of being
 * papered over with a delta against nothing.
 */
export function censusChanges(rows: readonly CensusDay[]): CensusChange[] {
  const out: CensusChange[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const row = rows[i];
    const delta = (after: number, before: number): number | null => (after >= before ? after - before : null);
    out.push({
      day: row.day,
      tick: row.tick,
      population: row.population,
      populationDelta: row.population - prev.population,
      born: delta(row.born, prev.born),
      died: delta(row.died, prev.died),
      predations: delta(row.predations, prev.predations),
      lost: Object.keys(prev.byArchetype).filter((a) => prev.byArchetype[a] > 0 && !(row.byArchetype[a] > 0)),
      gained: Object.keys(row.byArchetype).filter((a) => row.byArchetype[a] > 0 && !(prev.byArchetype[a] > 0)),
    });
  }
  return out;
}

/**
 * Days kept in the book. Sized against what a row costs rather than against
 * optimism: a row measured 263 bytes of JSON — a real one, written by the pump,
 * four archetypes, a 64-character hash, thirteen digits of wall clock; the
 * `a day book row is as small as its comment claims` test re-measures it — so
 * the whole cap is ~103 KiB. 400 days is more history than any chart asks for
 * and more than a year of tank.
 *
 * There is no byte alarm on this array, on purpose: the ledger is stored as an
 * object, so its encoded size is not a number this code can produce honestly —
 * see the note in `worker.ts` about why the ledger reports no byte count. The cap
 * and the `census_days_dropped` counter are what stand in for one.
 */
export const CENSUS_CAP = 400;

/**
 * What a "reset" between two rows means for the counters: the cumulative fields
 * went backwards, so the world was reseeded and the two rows are not the same
 * tank. Exported because the route has to say this about a pair of rows without
 * recomputing the rule.
 */
export function censusReset(prev: CensusDay, row: CensusDay): boolean {
  return row.born < prev.born || row.died < prev.died || row.predations < prev.predations;
}

/* ------------------------------------------------------------------ state machine */

/**
 * `pending` is the only status that may carry a txHash, and `coherenceProblem`
 * is what enforces it. That single rule is the bug this machine exists to kill:
 * the previous code wrote `pending` from the send failure path with `txHash:
 * null`, so the public UI rendered "Committing…" forever over a transaction
 * that had never been broadcast, and the retry that should have rescued it
 * required a status that only the retry could produce.
 */
export type DigestStatus =
  /** No signing key or no RPC: nothing will be attempted. */
  | 'unconfigured'
  /** A record exists for this day; no attempt has been made yet. */
  | 'queued'
  /** An attempt is in flight, or one died without leaving a txHash. */
  | 'submitting'
  /** A transaction was broadcast and we are waiting for its receipt. */
  | 'pending'
  | 'confirmed'
  /** An attempt ended badly. A retry follows unless the budget is spent. */
  | 'failed';

export interface DigestRecord {
  day: number;
  /**
   * The exact bytes committed. A retry resends this rather than re-reading the
   * world: the alternative is a hash pinned to one moment travelling with
   * numbers sampled later, which is a mismatch nobody would notice until
   * somebody tried to verify it.
   */
  payload: DigestPayload;
  status: DigestStatus;
  txHash: string | null;
  attempts: number;
  /** When the last attempt started. Doubles as the lock and the backoff clock. */
  lastAttemptAt: number;
  confirmedAt: number | null;
}

/** Enough for a transient RPC or balance problem, few enough to be finite. */
export const DIGEST_MAX_ATTEMPTS = 5;
/** Resend spacing. `advance()` can run four times a second, so a retry needs a clock. */
export const DIGEST_RETRY_MS = 5 * 60 * 1000;
/** Receipt polling spacing, while a transaction is outstanding. */
export const DIGEST_POLL_MS = 20 * 1000;

export type DigestAction = 'submit' | 'poll' | 'none';

export function newDigestRecord(day: number, payload: DigestPayload): DigestRecord {
  return {
    day, payload, status: 'queued', txHash: null, attempts: 0,
    // Zero, not a timestamp: a fresh record is due immediately rather than after
    // one backoff interval, which is what lets the first attempt of a day land
    // in the same tick the day rolled over.
    lastAttemptAt: 0,
    confirmedAt: null,
  };
}

/** An attempt has started. Called before the await, so the record is the lock. */
export function markSubmitted(r: DigestRecord, now: number): DigestRecord {
  return { ...r, status: 'submitting', txHash: null, attempts: r.attempts + 1, lastAttemptAt: now };
}

export function markPending(r: DigestRecord, txHash: string, now: number): DigestRecord {
  return { ...r, status: 'pending', txHash, lastAttemptAt: now };
}

/**
 * The broadcast failed. `txHash` survives only when the chain actually gave one
 * back — a reverted transaction is evidence worth keeping, a send that threw is
 * not a transaction, and holding onto a hash in that case is how a `failed`
 * record ends up linking a block explorer to nothing.
 */
export function markFailed(r: DigestRecord, now: number, txHash: string | null = null): DigestRecord {
  return { ...r, status: 'failed', txHash, lastAttemptAt: now };
}

export function markConfirmed(r: DigestRecord, now: number): DigestRecord {
  return { ...r, status: 'confirmed', confirmedAt: now };
}

/** No key or no endpoint. Terminal for this record; the next day starts fresh. */
export function markUnconfigured(r: DigestRecord, now: number): DigestRecord {
  return { ...r, status: 'unconfigured', txHash: null, lastAttemptAt: now };
}

/**
 * What to do about a digest record now, given the wall clock.
 *
 * Pure and exported because the alternative is a rule that can only be observed
 * by waiting a day against a funded chain. The previous code had no such
 * function, which is how both a poll and a retry ended up gated on a status the
 * other one was responsible for setting.
 */
export function nextDigestAction(r: DigestRecord, now: number): DigestAction {
  switch (r.status) {
    case 'confirmed':
    case 'unconfigured':
      return 'none';
    case 'pending':
      // A transaction exists, so the only question left is whether it mined.
      // Bounded by a clock rather than by an in-flight flag, because the flag
      // dies with the isolate and the transaction does not.
      return now - r.lastAttemptAt >= DIGEST_POLL_MS ? 'poll' : 'none';
    case 'queued':
      return 'submit';
    case 'submitting':
      // Reachable only by an isolate that died between the attempt and its
      // result. Recovered on the same clock as a failure, since from here they
      // look identical: an attempt with no transaction to show for it.
    case 'failed':
      if (r.attempts >= DIGEST_MAX_ATTEMPTS) return 'none';
      return now - r.lastAttemptAt >= DIGEST_RETRY_MS ? 'submit' : 'none';
  }
}

/** Whether this day is finished with, so the next day's record may take its place. */
export function isSettled(r: DigestRecord): boolean {
  return r.status === 'confirmed' || r.status === 'unconfigured' || r.attempts >= DIGEST_MAX_ATTEMPTS;
}

/**
 * Name a way this record claims more than has happened, or return null.
 *
 * The transitions above cannot produce these states, which is the point of
 * having them; this is the check that says so out loud, run after every
 * transition and asserted directly by the tests. A `pending` with no `txHash`
 * is the specific lie this whole module was written to make unrepresentable.
 */
export function coherenceProblem(r: DigestRecord): string | null {
  if (r.status === 'pending' && !r.txHash) {
    return 'pending without a txHash: the UI would report a commitment that was never broadcast';
  }
  if (r.status === 'confirmed' && !r.txHash) return 'confirmed without a txHash to point at';
  if (r.status === 'confirmed' && r.confirmedAt === null) return 'confirmed without a confirmation time';
  if (r.status === 'queued' && r.attempts !== 0) return 'a fresh record cannot have attempted anything';
  if (r.attempts < 0) return 'negative attempt count';
  if (r.txHash && !/^0x[0-9a-fA-F]{64}$/.test(r.txHash)) return 'txHash is not a tx hash';
  return null;
}
