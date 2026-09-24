/**
 * Arc mainnet USDC flow feed, the observatory's data source.
 *
 * Reads native USDC (0x36...0000, 6 decimals) Transfer events from Arc
 * (Circle L1, chainId 5042, ~500ms blocks) via plain JSON-RPC:
 *
 *  - Every transfer becomes a `UsdcFlow` record; the ring buffer powers the
 *    /observe API (flow map, pulse chart, endpoint ranking).
 *  - Every transfer also becomes a food meteor (ChainTx) with provenance in
 *    `meta`, so clicking a meteor in the world view can show the real
 *    payment behind it.
 *  - Chain temperature: the empirical percentile of this poll's flow
 *    intensity (transfer count plus volume, both log-scaled) among the polls
 *    of the last few minutes. Order-statistics instead of a fitted curve, so
 *    there is no gain or baseline constant to retune when the chain's
 *    absolute level moves.
 *  - Market temperature (`market()`): the same percentile trick applied to
 *    the size of the volume swing between polls, i.e. how unusual the current
 *    turbulence is relative to recent turbulence.
 *  - Venue: which rail each movement travelled on, classified from the
 *    contract the transaction called and the method it called (see venue.ts).
 *    x402 is one venue among them — a call to the USDC token itself carrying
 *    EIP-3009 `transferWithAuthorization` — and the rest are swaps, ERC-4337
 *    bundles, plain transfers and uncatalogued contracts. Resolving the rail
 *    needs the full block, so it is attempted only on live ranges and only back
 *    to `MAX_VENUE_BLOCKS`. A flow carrying `venue: null` means unknown — not
 *    resolved — which is what backfill and an over-long catch-up produce.
 *
 *    This replaced a heuristic that read `tx.from != transfer.from` as x402.
 *    That condition is true of every internal leg of every DEX swap, so it
 *    reported a machine-payment share of roughly 85% on a chain whose USDC
 *    flow is overwhelmingly swap routing; the real EIP-3009 share measured
 *    about one percent of transactions. `UsdcFlow.x402` survives as a derived
 *    convenience (`venue === 'x402'`) so the pulse series, the stats window and
 *    the client's gold/cyan styling all keep working and simply become true.
 *
 * Polling is time-gated (default every 2s ≈ 4 blocks) and de-duplicated via
 * an in-flight promise, so being sampled twice per tick (chain + market
 * wiring) never double-polls. On startup it backfills a configurable block
 * range so the observatory is never empty. `consecutiveFailures` lets the
 * handler degrade to the synthetic feed.
 */
import { Rng } from '@abyssal/sim';
import type { ChainFeed, ChainSample, ChainTx, FeedState, MeterState, PulseRow } from './chain.js';
import type { Health } from './health.js';
import type { MarketSample } from './market.js';
import {
  classifyVenue,
  emptyTally,
  labelVenue,
  VENUE_KINDS,
  type VenueKind,
  type VenueTally,
} from './venue.js';

export const ARC_CHAIN_ID = 5042;
/** Native USDC on Arc mainnet. */
export const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
/**
 * Addresses that hold or eat USDC but never act: the burn sinks and the token
 * itself. Ranking them as whales would put the null address at the top of the
 * tank, since every burn-to-pay transfer ends there.
 */
const NON_ACTORS = new Set([
  ARC_USDC_ADDRESS,
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/**
 * Arc produces a block roughly every 500ms.
 *
 * Re-measured rather than taken on trust: 13 consecutive blocks spanned 6s (mean
 * 0.5s, median 1s) on the configured endpoint and the same shape on the public
 * one, and the head moved 18 blocks in the ~12.5s between batched samples.
 */
const BLOCK_MS = 500;
/**
 * The block tag whose height is the edge of what this feed will count as fact.
 *
 * Asked in a single JSON-RPC batch, because asking between calls measures the
 * script instead of the chain: the first version of this probe read `latest`,
 * then ten seconds later read `finalized`, and reported finality as sitting 17
 * blocks *ahead* of the head on a chain that produces a block every 0.5s.
 * Batched, over six rounds:
 *
 *   latest=22509608  safe=22509608  finalized=22509608
 *   latest=22509612  safe=22509612  finalized=22509612
 *   …
 *   latest=22509626  safe=22509626  finalized=22509626
 *
 * Lag zero in every round, with `pending` answering null — the shape of a chain
 * with instant finality, where a node will not show you a block it has not
 * already agreed to. So indexing against `finalized` instead of `latest` changes
 * nothing observable today, and that is the point: it is the difference between a
 * feed that happens to read confirmed blocks and one that will not read anything
 * else. Should a node start lagging, the lag appears as `finalityLagBlocks` and
 * the head stops being counted with no code in between to reconsider.
 */
const FINALITY_TAG = 'finalized';
const LOG_CHUNK_BLOCKS = 400;
/**
 * Blocks per batch when resolving transaction venues. Keeps the per-request
 * concurrency the old 24-block gate allowed, and pays for a wider span in
 * round-trips rather than in simultaneous connections.
 */
const VENUE_BATCH = 24;
/**
 * How far back one poll resolves venues. A minute of Arc is ~120 blocks, so
 * this covers a poll that is recovering from a stall with room to spare; past
 * it the feed is replaying history nobody will inspect, and reporting those
 * flows as unattributed beats spending ten serial batches on them.
 *
 * The venue costs no extra RPC: it is read off the same full-block bodies the
 * relayer heuristic used to fetch, whose `to` and calldata were discarded after
 * the submitter was taken from them.
 */
const MAX_VENUE_BLOCKS = 240;
/**
 * Widest span a poll may treat as live rather than as history. A cron-spaced
 * poll is ~120 blocks, so this leaves room for a couple of late or missed beats
 * before the feed concludes it lost time. Past it, backfilling is the honest
 * move: a live poll stamps every log it reads with `now`, so resuming across a
 * long gap that way folds an hour of transfers into a single 15s pulse bucket
 * and into /observe's five-minute window, reporting a spike that never
 * happened. Backfill gives them their real per-block timestamps and leaves
 * their venue unresolved, which is what a gap that wide actually is.
 */
const MAX_LIVE_SPAN = 300;
/**
 * Per-call RPC ceiling. Without one, a hung `eth_getLogs` leaves `inflight` set
 * forever, and since `kick()` returns the promise already in flight instead of
 * starting a new one, the feed would never poll again for the life of the
 * object — a wedged feed that still reports its last temperature as current.
 */
const RPC_TIMEOUT_MS = 10_000;
/** Pulse chart + window stats aggregate into fixed 15s time buckets. */
const PULSE_BUCKET_MS = 15_000;
/**
 * How many buckets ride in the persisted ledger, which is a smaller number than
 * `maxPulse` on purpose. The ledger is rewritten whole on every save and a save
 * happens about once a minute, so the stored copy is capped at a day of
 * cron-spaced polls — the pace an unwatched feed actually runs at — rather than
 * at a day of 15s slots, which only a feed somebody is polling continuously
 * would ever fill. The in-memory series still runs to `maxPulse`, so a
 * long-lived object serves more history than a restored one; a restored one
 * serves a day instead of the single bar it used to.
 */
const PERSIST_PULSE = 1440;
/** Stats / endpoint ranking / address drawer all share this observation window. */
const STATS_WINDOW_MS = 5 * 60 * 1000;

export interface UsdcFlow {
  /** Wall-clock ms (live polls) or estimated from block distance (backfill). */
  t: number;
  block: number;
  tx: string;
  from: string;
  to: string;
  /** Whole USDC (float). */
  amount: number;
  /**
   * Which rail this movement travelled on; null when the transaction body was
   * never resolved (backfill, or a failed block batch), which is a different
   * claim from any venue.
   */
  venue: VenueKind | null;
  /**
   * The contract the transaction called — the venue's identity for the
   * leaderboard. Null exactly when `venue` is. Equal to the USDC address for
   * `x402` and `direct`, where the token itself is the venue.
   */
  venueAddr: string | null;
  /**
   * Derived, never observed on its own: `venue === 'x402'`, or null when the
   * venue is. Kept because the pulse series, the stats window, the sim's meteor
   * provenance and the client's gold styling all predate the venue model and
   * all mean this by it.
   */
  x402: boolean | null;
}

/** How much of the ring one paid answer may carry. */
export const FlowQueryLimits = { DEFAULT: 500, MAX: 2000 } as const;

export interface FlowQuery {
  /** Checked as an exact lowercased address; either side of a transfer matches. */
  addr?: string | null;
  /** `unknown` covers both readings of the name: never resolved, and resolved as unrecognised. */
  venue?: VenueKind | null;
  blockFrom?: number | null;
  blockTo?: number | null;
  /** Wall-clock ms, for a range a caller thinks in. */
  from?: number | null;
  to?: number | null;
  limit?: number;
}

export interface FlowQueryResult {
  available: true;
  /** Rows in the ring, matched or not — the ceiling on what this feed can say. */
  retained: number;
  oldest: { t: number; block: number } | null;
  newest: { t: number; block: number } | null;
  matched: number;
  truncated: boolean;
  query: { addr: string | null; venue: VenueKind | null; blockFrom: number | null; blockTo: number | null; limit: number };
  flows: {
    t: number; block: number; tx: string; from: string; to: string;
    /** Whole USDC to the token's own six decimals, and the exact integer below. */
    amount: number; amountUnits: number;
    venue: VenueKind | null; venueAddr: string | null; x402: boolean | null;
  }[];
}

interface PulseSample {
  t: number;
  count: number;
  volume: number;
  x402: number;
  /**
   * How many of `count` had their transaction body read, and so carry a venue
   * at all. Kept separately because the two are not interchangeable
   * denominators: `x402 / count` reads as "no transfer in this bucket was a
   * machine payment", which for an unresolved bucket is a claim the feed never
   * made. Resolving a venue needs the full block, which a backfill deliberately
   * skips, so every bucket rebuilt from history arrives with `resolved: 0` and
   * its share is unknown rather than zero. With a real x402 share near one
   * percent, an unresolved stretch of window does not merely blur the number —
   * it roughly halves it, since the numerator stays put while the denominator
   * grows.
   */
  resolved: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Turn persisted tuples back into buckets, dropping whatever cannot be trusted.
 * Defensive to the same degree the meters are, because these bytes come back out
 * of Durable Object storage: a truncated value should cost a short chart, not a
 * boot, and certainly not a chart that draws invented columns.
 *
 * Three rules do the work. A bucket older than the series can hold is dropped
 * rather than kept, so a ledger restored days later does not present stale
 * history as recent. A bucket dated in the future is dropped, for the same
 * reason in the other direction — the right-hand axis label is the last bucket's
 * timestamp, and one from tomorrow would put the whole chart in the future. And
 * a bucket that is not later than the one before it is dropped rather than
 * sorted into place, because the series is only ever appended to at its tail:
 * a row that belongs in the middle would be overwritten by the next poll's
 * merge-or-push, silently, and the chart would keep two accounts of one minute.
 */
function restorePulse(rows: unknown[], maxPulse: number): PulseSample[] {
  const now = Date.now();
  const floor = now - maxPulse * PULSE_BUCKET_MS;
  const out: PulseSample[] = [];
  let prev = -Infinity;
  for (const r of rows.slice(-maxPulse)) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const [ts, count, volume, x402, resolved] = r as unknown as number[];
    if (!Number.isFinite(ts) || !Number.isFinite(count) || !Number.isFinite(volume)) continue;
    const t = Math.round(ts) * 1000;
    if (t < floor || t <= prev || t > now + PULSE_BUCKET_MS) continue;
    out.push({
      t,
      count: Math.max(0, Math.round(count)),
      volume: Math.max(0, volume),
      x402: Number.isFinite(x402) ? Math.max(0, Math.round(x402)) : 0,
      resolved: Number.isFinite(resolved) ? Math.max(0, Math.round(resolved)) : 0,
    });
    prev = t;
  }
  return out;
}

/**
 * Self-calibration by rank. Arc's USDC flow has no stable absolute scale: one
 * poll carries $4 of dust, the next a $4M settlement, and the daily level
 * drifts as the machine-payment economy grows, so any fixed threshold would
 * pin the temperature at an extreme within days. Scoring each poll against
 * the polls we actually saw recently needs no such threshold: the reading is
 * the fraction of the window below the current score, bounded by
 * construction, and a single whale transfer cannot stretch the scale for
 * everybody else because ranks only care about order.
 */
export class FlowMeter {
  private window: number[] = [];
  private smooth: number | null = null;

  constructor(private maxWindow = 90, private ema = 0.3) {}

  /** Fold in one score and return the smoothed mid-rank percentile 0..1. */
  read(score: number): number {
    let below = 0;
    let equal = 0;
    for (const v of this.window) {
      if (v < score) below++;
      else if (v === score) equal++;
    }
    // Mid-rank so a perfectly flat window reads as middle, not as coldest.
    const rank = this.window.length === 0 ? 0.5 : (below + equal / 2) / this.window.length;
    this.window.push(score);
    if (this.window.length > this.maxWindow) this.window.shift();
    this.smooth = this.smooth === null ? rank : this.smooth + this.ema * (rank - this.smooth);
    return clamp01(this.smooth);
  }

  get value(): number {
    return this.smooth === null ? 0.5 : this.smooth;
  }

  /** Carry-over for a runtime that evicts the object between polls. */
  exportState(): MeterState {
    return { window: [...this.window], smooth: this.smooth };
  }

  /**
   * Resume from stored scores. Defensive because these bytes come back out of
   * Durable Object storage, where a truncated value should cost a cold scale
   * rather than a boot.
   */
  importState(s: MeterState): void {
    const w = s?.window;
    this.window = Array.isArray(w) ? w.filter((n) => Number.isFinite(n)).slice(-this.maxWindow) : [];
    const sm = s?.smooth;
    this.smooth = typeof sm === 'number' && Number.isFinite(sm) ? clamp01(sm) : null;
  }
}

function hex(n: number): string {
  return `0x${n.toString(16)}`;
}

/** micro-USDC (uint256 hex) -> whole USDC, clamped to a sane float. */
function amountOf(data: string): number {
  try {
    const v = BigInt(data);
    if (v <= 0n) return 0;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number(v / 10n ** 6n);
    return Number(v) / 1e6;
  } catch {
    return 0;
  }
}

/** $0.01 -> ~0.13, $10 -> ~0.21, $1k -> ~0.6, $100k -> 1.0 (meteor size). */
function sizeOf(amount: number): number {
  return clamp01(Math.log10(amount + 1) / 5);
}

/* ---------- chain whales: the tank as a live map of top on-chain actors ---------- */

/** FNV-1a → 32-bit seed. Must stay identical to the client's `hashSeed`. */
function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const TAU = Math.PI * 2;
/** Vertical bob period/amp; the client evaluator uses the same two numbers. */
const WHALE_BOB_MS = 23_000;
const WHALE_BOB_AMP = 0.05;

/**
 * Swim-lane parameters for one whale address: a pure function of the address,
 * so the server and every viewer place the leviathan at the same point in the
 * tank at the same wall-clock instant. The client receives these numbers and
 * only evaluates `whalePosition`'s closed form, it never re-derives them, so
 * the plankton a whale's own transfer drops always lands on the whale the
 * viewer is actually looking at.
 */
export interface WhaleLane {
  /** 0..1 vertical lane. */
  lane: number;
  /** ms for one horizontal traversal. */
  period: number;
  /** 0..1 phase along the traversal. */
  phaseU: number;
  /** Bob phase. */
  phaseY: number;
  /** Heading-wobble / breathing phase (client-side cosmetics). */
  phaseW: number;
  /** Client palette bucket seed. */
  seed: number;
}

export function whaleLaneOf(address: string): WhaleLane {
  const seed = hashSeed(address.toLowerCase());
  const rnd = new Rng(seed);
  return {
    lane: 0.16 + rnd.next() * 0.68,
    period: 210_000 + (seed % 90_000),
    phaseW: rnd.next() * TAU,
    phaseY: rnd.next() * TAU,
    phaseU: rnd.next(),
    seed,
  };
}

/**
 * World-space position at wall-clock `t`, or null while the whale crosses the
 * horizontal seam. It is faded out there, so dropping food would bloom
 * somewhere no whale is visible and the causality would read as noise.
 */
export function whalePosition(
  lane: WhaleLane,
  t: number,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const u = ((lane.phaseU + t / lane.period) % 1.2) - 0.1;
  if (u < 0.02 || u > 0.98) return null;
  return {
    x: u * width,
    y: lane.lane * height + Math.sin(t / WHALE_BOB_MS + lane.phaseY) * height * WHALE_BOB_AMP,
  };
}

export interface WhaleRow {
  address: string;
  volume: number;
  count: number;
  inVolume: number;
  outVolume: number;
  x402: number;
  /** Wall-clock ms of its last transfer; the client dims idle leviathans. */
  lastT: number;
  /** 1-based rank by window volume. */
  rank: number;
  lane: WhaleLane;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

/**
 * The slice of a full-block transaction we read. `input` is truncated to its
 * first four bytes at the point of use — a swap's calldata runs to kilobytes and
 * keeping it per transaction across a 240-block span would cost more memory
 * than the flow ring it annotates.
 *
 * There is deliberately no `from`: the submitter was only ever read to compare
 * it against the Transfer log's payer, and that comparison is the heuristic the
 * venue model replaced.
 */
interface RpcBlockTx {
  hash?: string;
  to?: string | null;
  input?: string;
}

export interface ArcFeedOptions {
  pollEveryMs?: number;
  /** Blocks of history to load on the first poll (~30 min at 500ms blocks). */
  backfillBlocks?: number;
  maxFlows?: number;
  maxPulse?: number;
  maxPending?: number;
  /**
   * Where to record that the node refused the finality tag. Optional because the
   * feed is also built in tests and against endpoints nobody is monitoring; a
   * feed with nowhere to report still refuses to index past what it was told is
   * final, which is the part that protects the reader.
   */
  health?: Health;
}

export class ArcUsdcFeed implements ChainFeed {
  readonly name = 'arc-usdc';
  consecutiveFailures = 0;

  private readonly rpcUrl: string;
  private readonly usdc: string;
  private readonly pollEveryMs: number;
  private readonly backfillBlocks: number;
  private readonly maxFlows: number;
  private readonly maxPulse: number;
  /**
   * Ceiling on undrained meteors. A 250ms tick loop drains 6 every tick and
   * never gets near this; a runtime that polls once a minute accumulates a
   * whole minute of Arc flow between drains and would silently drop most of it
   * at the old hard-coded 160.
   */
  private readonly maxPending: number;

  private lastBlock = -1;
  /**
   * The head as of the last completed poll, kept only to be subtracted from
   * `lastBlock`. -1 until a poll has run, which is reported as unknown.
   */
  private headBlock = -1;
  private readonly health: Health | null;
  private lastPollAt = 0;
  private inflight: Promise<void> | null = null;
  private flows: UsdcFlow[] = [];
  private pulse: PulseSample[] = [];
  private pendingTxs: ChainTx[] = [];
  private whaleCache: Map<string, WhaleRow> = new Map();
  private whaleCacheT = 0;

  private level = new FlowMeter();
  private turbulence = new FlowMeter();
  private chainTemp = 0.5;
  private prevVolume = 0;
  private prevTemp = 0.5;
  private marketTemp = 0.5;

  constructor(rpcUrl: string, usdcAddress: string = ARC_USDC_ADDRESS, opts: ArcFeedOptions = {}) {
    this.rpcUrl = rpcUrl;
    this.usdc = usdcAddress.toLowerCase();
    this.pollEveryMs = opts.pollEveryMs ?? 2000;
    this.backfillBlocks = opts.backfillBlocks ?? 3600;
    this.maxFlows = opts.maxFlows ?? 6000;
    this.maxPulse = opts.maxPulse ?? 5760; // 24h of 15s buckets, for /history/pulse
    this.maxPending = opts.maxPending ?? 2000;
    this.health = opts.health ?? null;
  }

  /** Market-feed view: turbulence of the USDC flow (0..1). */
  market(): MarketSample {
    return { temp: this.marketTemp };
  }

  async sample(): Promise<ChainSample> {
    this.kick(Date.now());
    // Never block the tick loop on the RPC: while a poll is in flight, serve
    // the last computed temperature (stale-while-revalidate). Awaiting here
    // bunches ticks into a burst the moment the poll resolves, which the
    // frontend reads as a stutter every poll interval.
    const temp = this.chainTemp;
    const delta = temp - this.prevTemp;
    this.prevTemp = temp;
    return { temp, delta, blockNumber: this.lastBlock >= 0 ? this.lastBlock : undefined };
  }

  /**
   * Wait for the poll in flight, starting one if none is due.
   *
   * `sample()` deliberately does not await, which is right for a tick loop that
   * runs every 250ms and wrong for a Worker isolate: there the response ends the
   * invocation, and a poll nobody is awaiting is cancelled mid-backfill, so the
   * feed is rebuilt from `lastBlock = -1` on the next request and never once
   * completes. The tank then runs forever on the initializer temperatures and
   * no transfer ever rains. This is the one place with nobody waiting on it —
   * the cron handler calls it once a minute and the poll finishes inside the
   * invocation instead of being cut off.
   */
  async settle(): Promise<void> {
    const p = this.kick(Date.now());
    if (p) await p;
  }

  /**
   * Carry-over for a runtime whose object does not outlive its invocation.
   * `lastBlock` is the part that matters most: without it every cold boot is a
   * 3600-block backfill, and a backfill resolves no venues (so every flow it
   * produces is unattributed) and pushes thousands of flows through the ring —
   * enough on a busy chain to evict the live readings a viewer actually came
   * for, every single minute. The meters ride along so the temperatures resume
   * as ranks against their own history instead of restarting at 0.5 and spending
   * ~90 polls earning a scale back.
   *
   * The pulse series rides along too, and it took a production chart to show
   * why: a bucket is one per 15 seconds of wall clock, so it does not refill
   * within a few polls — it refills at exactly the rate it records. Left in
   * memory alone, an object collected every minute or two served a chart of one
   * bar, and the 1h and 24h ranges each came back with a single nonzero column.
   * `flows` still does not ride along, and the reason it first went without is
   * not the reason it does now. The comment used to claim a ring "refills from
   * the next backfill" — which cannot happen, because `lastBlock` is precisely
   * what suppresses a backfill: `isBackfill` needs the cursor to be unset or
   * older than `MAX_LIVE_SPAN`, and a restored cursor is neither. Measured on
   * the deployed worker: two paid reads of the ring, 563 rows spanning 138
   * blocks and 162 rows spanning 46, against the 3600 blocks a real cold
   * backfill would cover. So the ring refills one live poll at a time, which
   * makes its depth a property of how long this isolate has been alive. That is
   * honest only if the answer says so, which is what `retained`, `oldest` and
   * `newest` are for — and it is cheap for a free display that shows 160 rows
   * anyway. For the paid route, where depth is the product being sold, it is an
   * open question, not a settled one.
   */
  exportState(): FeedState {
    return {
      lastBlock: this.lastBlock,
      headBlock: this.headBlock,
      level: this.level.exportState(),
      turbulence: this.turbulence.exportState(),
      chainTemp: this.chainTemp,
      marketTemp: this.marketTemp,
      prevVolume: this.prevVolume,
      prevTemp: this.prevTemp,
      pulse: this.pulse.slice(-PERSIST_PULSE).map((p) => [
        Math.round(p.t / 1000),
        p.count,
        Math.round(p.volume * 100) / 100,
        p.x402,
        p.resolved,
      ] as PulseRow),
    };
  }

  importState(s: FeedState): void {
    if (!s || typeof s !== 'object') return;
    // Anything but a real block number is worse than none: the next poll would
    // compute `from = lastBlock + 1` off garbage and read a range nobody chose.
    // Leaving it at -1 costs a backfill, which is the cold-start path anyway.
    if (Number.isInteger(s.lastBlock) && s.lastBlock >= 0) this.lastBlock = s.lastBlock;
    // The same test for the same reason: a height that is not one is worth less
    // than no height at all, which reports unknown instead of guessing.
    if (Number.isInteger(s.headBlock) && (s.headBlock as number) >= 0)
      this.headBlock = s.headBlock as number;
    // And a rule neither height can carry on its own. A poll records the two
    // together and the head is never below what it indexed to, so a stored head
    // behind the cursor means the halves did not come from one poll. It cannot be
    // clamped to a lag of zero — that is the reassuring reading of a ledger that
    // has stopped meaning anything — so the head goes and the gap reports unknown.
    if (this.headBlock < this.lastBlock) this.headBlock = -1;
    if (s.level) this.level.importState(s.level);
    if (s.turbulence) this.turbulence.importState(s.turbulence);
    if (Number.isFinite(s.chainTemp)) this.chainTemp = clamp01(s.chainTemp);
    if (Number.isFinite(s.marketTemp)) this.marketTemp = clamp01(s.marketTemp);
    if (Number.isFinite(s.prevVolume)) this.prevVolume = s.prevVolume;
    if (Number.isFinite(s.prevTemp)) this.prevTemp = clamp01(s.prevTemp);
    if (Array.isArray(s.pulse)) {
      // Only on a series that survived. Assigning unconditionally would let a
      // ledger written before the chart was durable — or one whose buckets all
      // failed validation — wipe a series this object had already accumulated.
      const restored = restorePulse(s.pulse, this.maxPulse);
      if (restored.length) this.pulse = restored;
    }
  }

  /** Start a poll if one is due; returns the promise in flight, or null. */
  private kick(now: number): Promise<void> | null {
    if (this.inflight) return this.inflight;
    if (now - this.lastPollAt < this.pollEveryMs) return null;
    this.inflight = this.poll(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Drain observed meteors. The default of 6 suits a 250ms tick loop, which
   * spreads a 2s poll's burst smoothly; `catchUp()` passes 6 per replayed tick
   * so a runtime that polls once a minute still rains the whole minute.
   */
  recentTxs(max = 6): ChainTx[] {
    if (this.pendingTxs.length <= max) {
      const txs = this.pendingTxs;
      this.pendingTxs = [];
      return txs;
    }
    return this.pendingTxs.splice(0, max);
  }

  /**
   * The paid read of the same ring `/observe` shows 160 of: every retained
   * transfer, filterable by address, venue and block or time range.
   *
   * `retained` is reported alongside the rows because it is the honest ceiling
   * on the answer. The ring is in-memory (see `exportState`, which deliberately
   * leaves `flows` out of what persists), so on a runtime that evicts its object
   * this is "everything this feed has seen since it woke", and a buyer is
   * entitled to see that number rather than to infer it from a short list.
   */
  queryFlows(q: FlowQuery = {}): FlowQueryResult {
    const addr = q.addr ? String(q.addr).toLowerCase() : null;
    const rows: UsdcFlow[] = [];
    let matched = 0;
    for (const f of this.flows) {
      if (addr && f.from !== addr && f.to !== addr) continue;
      if (q.venue && !(q.venue === 'unknown' ? f.venue === null || f.venue === 'unknown' : f.venue === q.venue)) continue;
      if (q.blockFrom !== null && q.blockFrom !== undefined && f.block < q.blockFrom) continue;
      if (q.blockTo !== null && q.blockTo !== undefined && f.block > q.blockTo) continue;
      if (q.from !== null && q.from !== undefined && f.t < q.from) continue;
      if (q.to !== null && q.to !== undefined && f.t > q.to) continue;
      matched++;
      rows.push(f);
    }
    const limit = q.limit && q.limit > 0 ? q.limit : FlowQueryLimits.DEFAULT;
    // Newest last, like the ring itself and the free stream: what a caller wants
    // when a filter matches more than one response can hold is the recent end.
    const page = matched > limit ? rows.slice(-limit) : rows;
    const row = (f: UsdcFlow) => ({
      t: f.t,
      block: f.block,
      tx: f.tx,
      from: f.from,
      to: f.to,
      // The free stream rounds to cents (`whalesPayload`, `/observe`) because a
      // display bar never needs more. A paid answer is a different thing: this
      // route sells for 0.001 USDC, and every one of those sales lands back in
      // this ring as a flow, so rounding it the same way would hand a buyer a
      // ledger where the purchases read as zero. `amount` goes out at the full
      // six decimals of the token and `amountUnits` is the exact integer the log
      // line carried — micro-USDC fits a double up to 9e9 of the thing.
      amount: Math.round(f.amount * 1e6) / 1e6,
      amountUnits: Math.round(f.amount * 1e6),
      venue: f.venue,
      venueAddr: f.venueAddr,
      x402: f.x402,
    });
    return {
      available: true,
      retained: this.flows.length,
      oldest: this.flows.length ? { t: this.flows[0].t, block: this.flows[0].block } : null,
      newest: this.flows.length
        ? { t: this.flows[this.flows.length - 1].t, block: this.flows[this.flows.length - 1].block }
        : null,
      matched,
      truncated: matched > page.length,
      query: { addr, venue: q.venue ?? null, blockFrom: q.blockFrom ?? null, blockTo: q.blockTo ?? null, limit },
      flows: page.map(row),
    };
  }

  /**
   * Re-bucket the in-memory 15s pulse series into coarser columns covering
   * `rangeMs`. Used by /history/pulse to serve 1h (60s buckets) and 24h
   * (15min buckets) without touching the live /observe payload. Returns
   * dense buckets (every slot in the window, empty ones zeroed) so the chart
   * draws a continuous timeline instead of skipping quiet minutes.
   */
  historyPulse(rangeMs: number, bucketMs: number): { t: number; volume: number; count: number; x402Volume: number; resolvedVolume: number }[] {
    const now = Date.now();
    // Anchor the right edge to a bucket boundary so refreshes don't jitter
    // the chart's rightmost column.
    const endBucket = Math.floor(now / bucketMs) * bucketMs;
    const startBucket = endBucket - rangeMs + bucketMs;
    const slots = Math.max(1, Math.round(rangeMs / bucketMs));
    const out: { t: number; volume: number; count: number; x402Volume: number; resolvedVolume: number }[] = [];
    for (let i = 0; i < slots; i++) {
      out.push({ t: startBucket + i * bucketMs, volume: 0, count: 0, x402Volume: 0, resolvedVolume: 0 });
    }
    // The flows ring carries per-transfer x402 flags but is capped far short
    // of 24h, so x402Volume falls back to a count-weighted estimate from the
    // pulse buckets when the flow is too old. Good enough for a gold-cap
    // overlay; the precise number lives in the live /observe stream.
    const flowByBucket = new Map<number, { vol: number; x402Vol: number; resVol: number }>();
    for (const f of this.flows) {
      if (f.t < startBucket) continue;
      const key = Math.floor(f.t / bucketMs) * bucketMs;
      let e = flowByBucket.get(key);
      if (!e) { e = { vol: 0, x402Vol: 0, resVol: 0 }; flowByBucket.set(key, e); }
      e.vol += f.amount;
      if (f.x402) e.x402Vol += f.amount;
      if (f.venue) e.resVol += f.amount;
    }
    for (const p of this.pulse) {
      if (p.t < startBucket) continue;
      const idx = Math.floor((p.t - startBucket) / bucketMs);
      if (idx < 0 || idx >= slots) continue;
      const b = out[idx];
      b.volume += p.volume;
      b.count += p.count;
      const fb = flowByBucket.get(Math.floor(p.t / bucketMs) * bucketMs);
      if (fb && fb.vol > 0) {
        // Prorate this 15s pulse's x402 share against the bucket's flow volume.
        b.x402Volume += p.count > 0 ? (p.volume * (fb.x402Vol / fb.vol)) : 0;
        b.resolvedVolume += p.volume * (fb.resVol / fb.vol);
      } else if (p.count > 0) {
        b.x402Volume += p.volume * (p.x402 / p.count);
        // Proportional rather than exact: past the ring's reach all that is
        // left of a bucket is its counts, so the resolved share of its volume
        // is estimated the same way its x402 share already was.
        b.resolvedVolume += p.volume * (p.resolved / p.count);
      }
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // `resolvedVolume` travels with `x402Volume` because the second is only
    // meaningful against the first: a bucket rebuilt by a backfill carries real
    // volume and no venues at all, and a chart dividing by `volume` there draws
    // a flat zero over history nobody inspected.
    return out.map((b) => ({
      t: b.t,
      volume: r2(b.volume),
      count: b.count,
      x402Volume: r2(b.x402Volume),
      resolvedVolume: r2(b.resolvedVolume),
    }));
  }

  /** Snapshot for the GET /observe endpoint. */
  observePayload() {
    // Stats cover a fixed 5-minute time window, aggregated from pulse buckets:
    // the flow ring saturates at maxFlows on a busy chain, which would freeze
    // the transfer count at the cap forever.
    const cutoff = Date.now() - STATS_WINDOW_MS;
    let x402Count = 0;
    let volume = 0;
    let transfers = 0;
    let resolved = 0;
    for (const p of this.pulse) {
      if (p.t < cutoff) continue;
      transfers += p.count;
      volume += p.volume;
      x402Count += p.x402;
      resolved += p.resolved;
    }
    const byTo = new Map<string, { address: string; volume: number; count: number; x402: number }>();
    // Venues aggregate from the flow ring rather than from the pulse buckets,
    // the same way `endpoints` below does: a pulse bucket carries one x402 count
    // and no room for a per-rail breakdown, and a venue table is a ranking over
    // the window rather than a time series. The ring holds 6000 flows against a
    // ~2100-flow window at current Arc traffic, so the window is fully covered;
    // a busier chain that saturates it is why `venueCoverage` reports the ring's
    // own window total next to the split, so a viewer can see these numbers are
    // counted over flows rather than over pulse buckets and are not expected to
    // equal `transfers` above.
    const venueTally = emptyTally();
    const venueVolume: VenueTally = emptyTally();
    const byVenue = new Map<string, { kind: VenueKind; address: string | null; volume: number; count: number }>();
    let windowFlows = 0;
    let attributed = 0;
    for (const f of this.flows) {
      if (f.t < cutoff) continue;
      windowFlows++;
      let e = byTo.get(f.to);
      if (!e) {
        e = { address: f.to, volume: 0, count: 0, x402: 0 };
        byTo.set(f.to, e);
      }
      e.volume += f.amount;
      e.count++;
      if (f.x402) e.x402++;
      // A flow with no venue is left out of the tally rather than folded into
      // `unknown`: `unknown` means a contract creation, which is a claim about
      // the transaction, whereas a null venue means we never resolved it. The
      // difference is exactly what `unattributed` below reports.
      if (!f.venue) continue;
      attributed++;
      venueTally[f.venue]++;
      venueVolume[f.venue] += f.amount;
      const key = `${f.venue}:${f.venueAddr ?? ''}`;
      let v = byVenue.get(key);
      if (!v) {
        v = { kind: f.venue, address: f.venueAddr, volume: 0, count: 0 };
        byVenue.set(key, v);
      }
      v.volume += f.amount;
      v.count++;
    }
    const endpoints = [...byTo.values()]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10)
      .map((e) => ({ ...e, volume: Math.round(e.volume * 100) / 100 }));
    // The rails themselves, busiest first — and busiest means most *used*, not
    // most *moved*. Sorting by volume lets a single transaction own the panel:
    // one atomic arbitrage once came through at $8.15M against a window total of
    // $8.17M, which ranked it above the Uniswap router, the ERC-4337 EntryPoint
    // and every aggregator combined, and left the other eleven rows with a
    // zero-width bar beside them. A rail's usage is how often the ecosystem
    // reaches for it; the money is still on the row, where a one-off that large
    // reads as the outlier it is instead of as the headline. `x402` and `direct`
    // share an address (the token) and so are keyed by kind as well; everything
    // else is one row per contract, labelled from the registry when it is in
    // there.
    const venueRows = [...byVenue.values()]
      .sort((a, b) => b.count - a.count || b.volume - a.volume)
      .slice(0, 12)
      .map((v) => ({
        kind: v.kind,
        label: labelVenue(this.usdc, v.kind, v.address),
        address: v.address,
        count: v.count,
        volume: Math.round(v.volume * 100) / 100,
      }));
    // Downsample the pulse series to at most ~420 points.
    const step = Math.max(1, Math.ceil(this.pulse.length / 420));
    const pulse = this.pulse.filter((_, i) => i % step === 0).map((p) => ({
      t: p.t,
      count: p.count,
      volume: Math.round(p.volume * 100) / 100,
      x402: p.x402,
      resolved: p.resolved,
    }));
    const windowSeconds = Math.round(STATS_WINDOW_MS / 1000);
    return {
      network: 'arc',
      chainId: ARC_CHAIN_ID,
      usdc: this.usdc,
      lastBlock: this.lastBlock,
      headBlock: this.headBlock,
      finalityLagBlocks: this.finalityLag,
      windowSeconds,
      stats: {
        transfers,
        volume: Math.round(volume * 100) / 100,
        x402Count,
        // Against the transfers whose rail was actually read, not against all of
        // them. Both numbers are exposed because they answer different
        // questions: `transfers` is how busy the chain was, `resolved` is how
        // much of that this feed can speak to, and a share computed over the
        // first would silently understate the second by however much history
        // sits in the window. Zero when nothing was resolved, which the client
        // renders as unknown rather than as 0%.
        resolved,
        x402Share: resolved > 0 ? Math.round((x402Count / resolved) * 1000) / 1000 : 0,
      },
      endpoints,
      venues: VENUE_KINDS.map((k) => ({
        kind: k,
        count: venueTally[k],
        volume: Math.round(venueVolume[k] * 100) / 100,
      })),
      venueRows,
      venueCoverage: { windowFlows, attributed, unattributed: windowFlows - attributed },
      pulse,
      flows: this.flows.slice(-160).map((f) => ({
        t: f.t,
        block: f.block,
        tx: f.tx,
        from: f.from,
        to: f.to,
        amount: Math.round(f.amount * 100) / 100,
        venue: f.venue,
        x402: f.x402,
      })),
    };
  }

  /**
   * Top addresses by two-way volume inside the observation window. These are
   * the chain's resident leviathans: the WORLD tank embodies each one as a
   * whale, and a transfer it sends or receives rains plankton at its own
   * position (see `whaleIndex` + the handler's tick), so the tank is a live map
   * of who is feeding the ecosystem right now. Separate from observePayload's
   * receiver-only endpoint ranking.
   */
  whalesPayload(limit = 6): WhaleRow[] {
    const cutoff = Date.now() - STATS_WINDOW_MS;
    type W = {
      address: string; volume: number; count: number;
      inVolume: number; outVolume: number; x402: number; lastT: number;
    };
    const byAddr = new Map<string, W>();
    const touch = (addr: string, amount: number, isIn: boolean, f: { t: number; x402: boolean | null }) => {
      let w = byAddr.get(addr);
      if (!w) {
        w = { address: addr, volume: 0, count: 0, inVolume: 0, outVolume: 0, x402: 0, lastT: 0 };
        byAddr.set(addr, w);
      }
      w.volume += amount;
      if (isIn) w.inVolume += amount; else w.outVolume += amount;
      w.count++;
      if (f.x402) w.x402++;
      if (f.t > w.lastT) w.lastT = f.t;
    };
    for (const f of this.flows) {
      if (f.t < cutoff) continue;
      if (!NON_ACTORS.has(f.to)) touch(f.to, f.amount, true, f);
      if (!NON_ACTORS.has(f.from)) touch(f.from, f.amount, false, f);
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return [...byAddr.values()]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, limit)
      .map((w, i): WhaleRow => ({
        address: w.address,
        volume: r2(w.volume),
        count: w.count,
        inVolume: r2(w.inVolume),
        outVolume: r2(w.outVolume),
        x402: w.x402,
        lastT: w.lastT,
        rank: i + 1,
        lane: whaleLaneOf(w.address),
      }));
  }

  /**
   * Address → resident whale for the tick loop. Rescanning the flow ring every
   * 250ms tick would cost more than the whole rest of the tick, and the window
   * ranking moves on the scale of minutes, so the list is cached for 2s.
   */
  whaleIndex(now = Date.now()): Map<string, WhaleRow> {
    if (now - this.whaleCacheT > 2000) {
      this.whaleCacheT = now;
      this.whaleCache = new Map(this.whalesPayload().map((w) => [w.address, w]));
    }
    return this.whaleCache;
  }

  /**
   * Window-scoped transfer history for one address. The drawer cannot reuse
   * `observePayload().flows` (last 160 only): on a busy chain that slice spans
   * seconds, so hot endpoints ranked over the full window appeared empty.
   */
  addressPayload(address: string) {
    const addr = address.toLowerCase();
    const cutoff = Date.now() - STATS_WINDOW_MS;
    const mine = this.flows.filter((f) => (f.from === addr || f.to === addr) && f.t >= cutoff);
    let inVolume = 0;
    let outVolume = 0;
    let x402 = 0;
    for (const f of mine) {
      if (f.to === addr) inVolume += f.amount;
      if (f.from === addr) outVolume += f.amount;
      if (f.x402) x402++;
    }
    return {
      address,
      windowSeconds: Math.round(STATS_WINDOW_MS / 1000),
      stats: {
        count: mine.length,
        inVolume: Math.round(inVolume * 100) / 100,
        outVolume: Math.round(outVolume * 100) / 100,
        x402,
      },
      flows: mine.slice(-60).map((f) => ({
        t: f.t,
        block: f.block,
        tx: f.tx,
        from: f.from,
        to: f.to,
        amount: Math.round(f.amount * 100) / 100,
        x402: f.x402,
      })),
    };
  }

  /* ---------- internals ---------- */

  private async poll(now: number): Promise<void> {
    // Always advance lastPollAt so a failing RPC can't turn into a hot loop.
    this.lastPollAt = now;
    try {
      const latest = parseInt((await this.rpc('eth_blockNumber', [])) as string, 16);
      if (!Number.isFinite(latest)) throw new Error('bad block number');
      // Everything below walks to `upTo` rather than to the head: the height the
      // node itself calls final, never more than the head it just reported (see
      // FINALITY_TAG). Today those are the same number on the deployed endpoint,
      // so this is not a behaviour change — it is the reason a future one would
      // not need to be.
      const finality = await this.finalizedBlock();
      const upTo = finality === null ? latest : Math.min(finality, latest);
      // A restored `lastBlock` can be arbitrarily old: the state outlives the
      // object, but the cron that kept it fresh may not have run for an hour.
      // See MAX_LIVE_SPAN for why that resumes as a backfill and not as one
      // very wide live poll. Judged against `upTo`, since `upTo` is the span this
      // poll is about to walk.
      const isBackfill = this.lastBlock < 0 || upTo - this.lastBlock > MAX_LIVE_SPAN;
      const from = isBackfill ? Math.max(0, upTo - this.backfillBlocks) : this.lastBlock + 1;
      if (from > upTo) {
        // Nothing new to read. Both heights still move, because "the head is 12
        // blocks past everything we have counted" is the sentence a lagging node
        // produces on a poll that indexes nothing.
        this.lastBlock = upTo;
        this.headBlock = latest;
        return;
      }

      // The venue needs each tx's destination and calldata, which only a full
      // block carries. This used to be skipped unless the poll spanned 24 blocks
      // or fewer — a ceiling sized for a 250ms tick loop, where a poll is four
      // blocks. On a runtime that polls once a minute the span is ~120 blocks
      // (Arc produces one every 500ms), so the gate never opened and every flow
      // came back unresolved: an observatory that bills itself as x402 reported
      // a machine-payment share of exactly zero, permanently, and only ever
      // showed a real one while a viewer happened to be polling fast enough to
      // squeeze under the gate. Batch the queries instead, which keeps the
      // concurrency that ceiling was protecting.
      const txVenue = new Map<string, { kind: VenueKind; addr: string | null }>();
      if (!isBackfill) {
        const venueFrom = Math.max(from, upTo - MAX_VENUE_BLOCKS + 1);
        for (let start = venueFrom; start <= upTo; start += VENUE_BATCH) {
          const numbers: number[] = [];
          for (let n = start; n <= Math.min(start + VENUE_BATCH - 1, upTo); n++) numbers.push(n);
          try {
            const blocks = (await Promise.all(
              numbers.map((n) => this.rpc('eth_getBlockByNumber', [hex(n), true])),
            )) as { transactions?: RpcBlockTx[] }[];
            for (const b of blocks) {
              for (const t of b?.transactions ?? []) {
                if (!t?.hash) continue;
                // The destination is null for a contract creation, and the
                // calldata may be absent or shorter than a selector; both are
                // passed through as-is because classifyVenue treats a missing
                // input as "no method recognized", not as "no transaction".
                const to = t.to ? t.to.toLowerCase() : null;
                const sel = typeof t.input === 'string' ? t.input.slice(0, 10).toLowerCase() : null;
                const info = classifyVenue(this.usdc, to, sel);
                txVenue.set(t.hash.toLowerCase(), { kind: info.kind, addr: to });
              }
            }
          } catch {
            // The venue is an enrichment, not the reading. A failed batch leaves
            // those flows `venue: null` — unknown, exactly as backfill does —
            // where letting it throw would discard the temperatures and the
            // whole interval of flow with them. Batching makes a failure more
            // likely, not less: five chances instead of one.
          }
        }
      }

      // The chunks go out together rather than one after another. A cold feed
      // has to backfill `backfillBlocks` of history before it can say anything
      // at all, and at 400 blocks a chunk, 30 minutes of Arc is nine sequential
      // round-trips — comfortably longer than the isolate that started them
      // stays alive, which is how a feed ends up never completing a single poll.
      const ranges: [number, number][] = [];
      for (let start = from; start <= upTo; start += LOG_CHUNK_BLOCKS) {
        ranges.push([start, Math.min(start + LOG_CHUNK_BLOCKS - 1, upTo)]);
      }
      const chunks = (await Promise.all(
        ranges.map(([s, e]) =>
          this.rpc('eth_getLogs', [
            {
              address: this.usdc,
              topics: [TRANSFER_TOPIC],
              fromBlock: hex(s),
              toBlock: hex(e),
            },
          ]),
        ),
      )) as RpcLog[][];
      // Promise.all preserves order, so the flows stay block-ascending.
      const logs: RpcLog[] = chunks.flat();
      this.consecutiveFailures = 0;
      // Paired deliberately: `headBlock` is recorded only where `lastBlock` is
      // committed, so the gap between them always describes a poll that finished.
      // Setting it at the top of this function would let a poll that threw report
      // a head it never indexed to, which inflates the one number meant to be
      // read as "how much of the chain we are declining to count".
      this.lastBlock = upTo;
      this.headBlock = latest;

      let count = 0;
      let volume = 0;
      let x402Count = 0;
      let resolvedCount = 0;
      for (const log of logs) {
        if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
        const amount = amountOf(log.data);
        if (amount <= 0) continue;
        const fromAddr = `0x${log.topics[1].slice(26).toLowerCase()}`;
        const toAddr = `0x${log.topics[2].slice(26).toLowerCase()}`;
        const block = parseInt(log.blockNumber, 16);
        const venue = txVenue.get(String(log.transactionHash).toLowerCase());
        const kind = venue ? venue.kind : null;
        const x402 = kind === null ? null : kind === 'x402';
        const t = isBackfill ? now - (latest - block) * BLOCK_MS : now;
        this.flows.push({
          t, block, tx: log.transactionHash, from: fromAddr, to: toAddr, amount,
          venue: kind, venueAddr: venue ? venue.addr : null, x402,
        });
        count++;
        volume += amount;
        if (x402) x402Count++;
        // Counted off the venue rather than off `!isBackfill`: a live poll wider
        // than MAX_VENUE_BLOCKS resolves only its newest stretch, and the rest of
        // it is as unknown as any backfilled flow.
        if (kind) resolvedCount++;
        if (!isBackfill && this.pendingTxs.length < this.maxPending) {
          this.pendingTxs.push({
            hash: log.transactionHash,
            size: sizeOf(amount),
            usd: amount,
            meta: { from: fromAddr, to: toAddr, amount, x402: x402 === true },
          });
        }
      }
      if (this.flows.length > this.maxFlows) this.flows.splice(0, this.flows.length - this.maxFlows);

      if (isBackfill) {
        // Rebuild the pulse history from the backfilled flows: fixed 15s
        // time buckets so backfill and live bars stay comparable.
        const rebuilt = new Map<number, PulseSample>();
        for (const f of this.flows) {
          const key = Math.floor(f.t / PULSE_BUCKET_MS) * PULSE_BUCKET_MS;
          let b = rebuilt.get(key);
          if (!b) {
            b = { t: key, count: 0, volume: 0, x402: 0, resolved: 0 };
            rebuilt.set(key, b);
          }
          b.count++;
          b.volume += f.amount;
          if (f.x402) b.x402++;
          if (f.venue) b.resolved++;
        }
        // Merged into the series already in hand rather than replacing it, and
        // the one already in hand wins every collision. A backfill re-reads
        // blocks the feed has counted before — that is what makes it a backfill
        // — so for any stretch a persisted series also covers, these buckets are
        // a second opinion, and a worse one on two counts: adding them would
        // count those transfers twice, and a backfill resolves no venues, so
        // every bucket it builds arrives with `resolved: 0` and would trade a
        // reading the feed actually took for one it did not. What the rebuild
        // contributes is the stretch nobody had polled yet, which is the gap
        // that made this a backfill in the first place.
        const buckets = new Map<number, PulseSample>(this.pulse.map((p) => [p.t, p]));
        for (const [k, v] of rebuilt) if (!buckets.has(k)) buckets.set(k, v);
        this.pulse = [...buckets.keys()]
          .sort((a, b) => a - b)
          .map((k) => buckets.get(k)!)
          .slice(-this.maxPulse);
        // Seed the meters from the newest bucket instead of skipping them. The
        // backfill as a whole is 30 minutes of chain in one score, and feeding
        // that in would pin the rank at the bottom of its own window for as long
        // as it stayed there — but a single 15s bucket is the same shape as a
        // live poll's, so it is comparable. Without this the feed needs two
        // completed polls before it can report anything but its initializer,
        // which on a runtime that affords one poll a minute is two minutes of
        // dead readings after every eviction.
        const seed = this.pulse[this.pulse.length - 1];
        if (seed) {
          this.chainTemp = this.level.read(Math.log1p(seed.count) + Math.log1p(seed.volume));
          this.prevVolume = seed.volume;
          // No previous volume to swing against, so turbulence starts at the
          // neutral rank; reading it still fills the window, which is what lets
          // the first live poll move it.
          this.marketTemp = this.turbulence.read(0);
        }
        return; // the meters rank live polls from here on
      }

      const bucketKey = Math.floor(now / PULSE_BUCKET_MS) * PULSE_BUCKET_MS;
      const lastBucket = this.pulse[this.pulse.length - 1];
      if (lastBucket && lastBucket.t === bucketKey) {
        lastBucket.count += count;
        lastBucket.volume += volume;
        lastBucket.x402 += x402Count;
        lastBucket.resolved += resolvedCount;
      } else {
        this.pulse.push({ t: bucketKey, count, volume, x402: x402Count, resolved: resolvedCount });
      }
      if (this.pulse.length > this.maxPulse) this.pulse.splice(0, this.pulse.length - this.maxPulse);

      // Both temperatures are percentiles of recent polls (FlowMeter), so a
      // chain whose absolute volume grows tenfold does not read as
      // permanently hot, and a quiet chain does not read as permanently cold.
      this.chainTemp = this.level.read(Math.log1p(count) + Math.log1p(volume));
      const swing = Math.abs(Math.log1p(volume) - Math.log1p(this.prevVolume));
      this.prevVolume = volume;
      this.marketTemp = this.turbulence.read(swing);
    } catch {
      this.consecutiveFailures++;
    } finally {
      // Throttle from completion, not from the request. A cold backfill can take
      // seconds, and a caller that awaited it — the cron heartbeat — would
      // otherwise find the interval already elapsed and immediately kick off a
      // second poll for data it is already holding, doubling the RPC load and
      // putting two pulse buckets on the same minute.
      this.lastPollAt = Date.now();
    }
  }

  /**
   * Head minus the edge we have indexed, or null while either height is unknown.
   *
   * "Unknown" and "caught up" are different answers and only one of them is
   * reassuring, so this refuses to resolve a missing reading to 0.
   */
  private get finalityLag(): number | null {
    return this.headBlock >= 0 && this.lastBlock >= 0 ? this.headBlock - this.lastBlock : null;
  }

  /**
   * How much of the chain this feed has counted, and how far that sits from what
   * it was offered. Kept apart from `observePayload()` because `/health` wants
   * those two heights and nothing else: the gap between them is a statement about
   * trust rather than a chart.
   */
  finalityStatus() {
    return {
      /** Highest block counted as fact. */
      indexedUpTo: this.lastBlock,
      /** Chain head as of the poll that last finished. */
      head: this.headBlock,
      lagBlocks: this.finalityLag,
      /**
       * Which tag bounds `indexedUpTo`. Constant today, and published anyway: a
       * reader can only tell "we refuse to index past finality" apart from "we
       * happen to be reading final blocks" if the rule is named in the answer.
       */
      tag: FINALITY_TAG,
    };
  }

  /**
   * The height this node calls final, or null when it will not say.
   *
   * Null is not worth throwing over. A node that has never heard of the tag would
   * otherwise stop the feed dead, and the choice is between "index the head" and
   * "index nothing at all", which is not close: on a chain with the measured
   * shape, the head *is* confirmed blocks. So the poll proceeds to the head and
   * records that it had to — the counter is the whole difference between a feed
   * that lost a guarantee and one that quietly never had it.
   */
  private async finalizedBlock(): Promise<number | null> {
    let answered: unknown;
    try {
      const b = (await this.rpc('eth_getBlockByNumber', [FINALITY_TAG, false])) as
        | { number?: unknown }
        | null;
      answered = b?.number;
    } catch (err) {
      this.health?.note('arc_finality_unavailable', err);
      return null;
    }
    // A quantity, not a word that happens to begin with one. `parseInt('finalized',
    // 16)` is **15** — the leading `f` is a hex digit — so an endpoint that echoed
    // the tag back instead of answering with a block would be believed as height
    // 15, and the feed would then refuse to index anything above it. The stub in
    // api.test.ts did precisely that on the first run of this code, which is
    // better evidence for checking the shape of an answer than any amount of
    // trusting the method name. The refused value is carried into the detail for
    // the same reason: "not a number" does not say what arrived.
    const height = typeof answered === 'string' && /^0x[0-9a-f]{1,16}$/i.test(answered)
      ? parseInt(answered, 16)
      : NaN;
    if (!Number.isFinite(height)) {
      this.health?.note('arc_finality_unavailable', `${FINALITY_TAG} answered ${JSON.stringify(answered)} as a block number`);
      return null;
    }
    return height;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? 'RPC error');
    return json.result;
  }
}
