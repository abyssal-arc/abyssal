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
 *  - x402 heuristic: EIP-3009 authorized transfers are submitted by a
 *    facilitator/relayer, so `tx.from != transfer.from` marks a relayed
 *    (x402-style, gasless-for-payer) settlement. Only resolvable for live
 *    polls (needs full blocks); backfilled flows carry `x402: null`.
 *
 * Polling is time-gated (default every 2s ≈ 4 blocks) and de-duplicated via
 * an in-flight promise, so being sampled twice per tick (chain + market
 * wiring) never double-polls. On startup it backfills a configurable block
 * range so the observatory is never empty. `consecutiveFailures` lets the
 * handler degrade to the synthetic feed.
 */
import { Rng } from '@abyssal/sim';
import type { ChainFeed, ChainSample, ChainTx } from './chain.js';
import type { MarketSample } from './market.js';

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
/** Arc produces a block roughly every 500ms. */
const BLOCK_MS = 500;
const LOG_CHUNK_BLOCKS = 400;
/** Pulse chart + window stats aggregate into fixed 15s time buckets. */
const PULSE_BUCKET_MS = 15_000;
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
  /** true = relayed settlement (x402-style), false = plain transfer, null = unknown (backfill). */
  x402: boolean | null;
}

interface PulseSample {
  t: number;
  count: number;
  volume: number;
  x402: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
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

interface RpcBlockTx {
  hash?: string;
  from?: string;
}

export interface ArcFeedOptions {
  pollEveryMs?: number;
  /** Blocks of history to load on the first poll (~30 min at 500ms blocks). */
  backfillBlocks?: number;
  maxFlows?: number;
  maxPulse?: number;
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

  private lastBlock = -1;
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
    this.maxPulse = opts.maxPulse ?? 2160;
  }

  /** Market-feed view: turbulence of the USDC flow (0..1). */
  market(): MarketSample {
    return { temp: this.marketTemp };
  }

  async sample(): Promise<ChainSample> {
    const now = Date.now();
    if (!this.inflight && now - this.lastPollAt >= this.pollEveryMs) {
      this.inflight = this.poll(now).finally(() => {
        this.inflight = null;
      });
    }
    // Never block the tick loop on the RPC: while a poll is in flight, serve
    // the last computed temperature (stale-while-revalidate). Awaiting here
    // bunches ticks into a burst the moment the poll resolves, which the
    // frontend reads as a stutter every poll interval.
    const temp = this.chainTemp;
    const delta = temp - this.prevTemp;
    this.prevTemp = temp;
    return { temp, delta, blockNumber: this.lastBlock >= 0 ? this.lastBlock : undefined };
  }

  /** Drain up to 6 meteors per tick so a 2s poll burst rains smoothly. */
  recentTxs(): ChainTx[] {
    if (this.pendingTxs.length <= 6) {
      const txs = this.pendingTxs;
      this.pendingTxs = [];
      return txs;
    }
    return this.pendingTxs.splice(0, 6);
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
    for (const p of this.pulse) {
      if (p.t < cutoff) continue;
      transfers += p.count;
      volume += p.volume;
      x402Count += p.x402;
    }
    const byTo = new Map<string, { address: string; volume: number; count: number; x402: number }>();
    for (const f of this.flows) {
      if (f.t < cutoff) continue;
      let e = byTo.get(f.to);
      if (!e) {
        e = { address: f.to, volume: 0, count: 0, x402: 0 };
        byTo.set(f.to, e);
      }
      e.volume += f.amount;
      e.count++;
      if (f.x402) e.x402++;
    }
    const endpoints = [...byTo.values()]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10)
      .map((e) => ({ ...e, volume: Math.round(e.volume * 100) / 100 }));
    // Downsample the pulse series to at most ~420 points.
    const step = Math.max(1, Math.ceil(this.pulse.length / 420));
    const pulse = this.pulse.filter((_, i) => i % step === 0).map((p) => ({
      t: p.t,
      count: p.count,
      volume: Math.round(p.volume * 100) / 100,
      x402: p.x402,
    }));
    const windowSeconds = Math.round(STATS_WINDOW_MS / 1000);
    return {
      network: 'arc',
      chainId: ARC_CHAIN_ID,
      usdc: this.usdc,
      lastBlock: this.lastBlock,
      windowSeconds,
      stats: {
        transfers,
        volume: Math.round(volume * 100) / 100,
        x402Count,
        x402Share: transfers > 0 ? Math.round((x402Count / transfers) * 1000) / 1000 : 0,
      },
      endpoints,
      pulse,
      flows: this.flows.slice(-160).map((f) => ({
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
      const isBackfill = this.lastBlock < 0;
      const from = isBackfill ? Math.max(0, latest - this.backfillBlocks) : this.lastBlock + 1;
      if (from > latest) {
        this.lastBlock = latest;
        return;
      }

      // Relayer detection needs tx senders; only affordable for live ranges.
      const txSenders = new Map<string, string>();
      const span = latest - from + 1;
      if (!isBackfill && span <= 24) {
        const numbers: number[] = [];
        for (let n = from; n <= latest; n++) numbers.push(n);
        const blocks = (await Promise.all(
          numbers.map((n) => this.rpc('eth_getBlockByNumber', [hex(n), true])),
        )) as { transactions?: RpcBlockTx[] }[];
        for (const b of blocks) {
          for (const t of b?.transactions ?? []) {
            if (t?.hash && t?.from) txSenders.set(t.hash.toLowerCase(), t.from.toLowerCase());
          }
        }
      }

      const logs: RpcLog[] = [];
      for (let start = from; start <= latest; start += LOG_CHUNK_BLOCKS) {
        const end = Math.min(start + LOG_CHUNK_BLOCKS - 1, latest);
        const chunk = (await this.rpc('eth_getLogs', [
          {
            address: this.usdc,
            topics: [TRANSFER_TOPIC],
            fromBlock: hex(start),
            toBlock: hex(end),
          },
        ])) as RpcLog[];
        logs.push(...chunk);
      }
      this.consecutiveFailures = 0;
      this.lastBlock = latest;

      let count = 0;
      let volume = 0;
      let x402Count = 0;
      for (const log of logs) {
        if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
        const amount = amountOf(log.data);
        if (amount <= 0) continue;
        const fromAddr = `0x${log.topics[1].slice(26).toLowerCase()}`;
        const toAddr = `0x${log.topics[2].slice(26).toLowerCase()}`;
        const block = parseInt(log.blockNumber, 16);
        const sender = txSenders.get(String(log.transactionHash).toLowerCase());
        const x402 = sender ? sender !== fromAddr : null;
        const t = isBackfill ? now - (latest - block) * BLOCK_MS : now;
        this.flows.push({ t, block, tx: log.transactionHash, from: fromAddr, to: toAddr, amount, x402 });
        count++;
        volume += amount;
        if (x402) x402Count++;
        if (!isBackfill && this.pendingTxs.length < 160) {
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
        const buckets = new Map<number, PulseSample>();
        for (const f of this.flows) {
          const key = Math.floor(f.t / PULSE_BUCKET_MS) * PULSE_BUCKET_MS;
          let b = buckets.get(key);
          if (!b) {
            b = { t: key, count: 0, volume: 0, x402: 0 };
            buckets.set(key, b);
          }
          b.count++;
          b.volume += f.amount;
          if (f.x402) b.x402++;
        }
        this.pulse = [...buckets.keys()]
          .sort((a, b) => a - b)
          .map((k) => buckets.get(k)!)
          .slice(-this.maxPulse);
        return; // the meters start ranking from the first live polls
      }

      const bucketKey = Math.floor(now / PULSE_BUCKET_MS) * PULSE_BUCKET_MS;
      const lastBucket = this.pulse[this.pulse.length - 1];
      if (lastBucket && lastBucket.t === bucketKey) {
        lastBucket.count += count;
        lastBucket.volume += volume;
        lastBucket.x402 += x402Count;
      } else {
        this.pulse.push({ t: bucketKey, count, volume, x402: x402Count });
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
    }
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? 'RPC error');
    return json.result;
  }
}
