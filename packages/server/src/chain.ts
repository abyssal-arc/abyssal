/**
 * Chain-temperature feeds. The simulation's food spawn rate is driven by a
 * 0..1 "chain temperature" sampled from one of these sources.
 */

export interface ChainSample {
  /** 0..1, higher = more on-chain activity = more food. */
  temp: number;
  /** Change since the previous sample. */
  delta: number;
  blockNumber?: number;
}

/** One transaction to drop into the world as a food meteor. */
export interface ChainTx {
  hash: string;
  /** 0..1 normalized magnitude (bigger tx = bigger meteor). */
  size: number;
  /** True for fake transactions from the synthetic feed. */
  simulated?: boolean;
  /** Provenance for payment-flow feeds (Arc USDC): who paid whom, how much. */
  meta?: { from: string; to: string; amount: number; x402: boolean };
  /** Whole USDC of the transfer, carried into the sim so a meal can name it. */
  usd?: number;
  /** Landing site override, set when the transfer belongs to a chain whale. */
  at?: { x: number; y: number };
  /** The resident whale this transfer fed; drives the client's visuals/ticker. */
  whale?: { address: string; rank: number; volume: number };
}

/**
 * A rank meter's carry-over. The window is the whole point of it: a reading is
 * the fraction of recent scores below the current one, so a meter that lost its
 * window is not a meter with a stale reading but one with no scale at all.
 */
export interface MeterState {
  window: number[];
  smooth: number | null;
}

/**
 * One persisted 15s pulse bucket, as a tuple rather than an object: `[t, count,
 * volume, x402, resolved]`, with `t` in *seconds*. The ledger is rewritten whole
 * on every save and the series runs into the thousands of buckets, so the field
 * names would cost more than the numbers do.
 */
export type PulseRow = [t: number, count: number, volume: number, x402: number, resolved: number];

/**
 * What a feed needs to survive an eviction. The block it reached, the numbers
 * its temperatures are computed from, and the pulse series behind the volume
 * chart.
 *
 * The pulse used to be left out on the reasoning that it refills within a few
 * polls, and that reasoning was wrong in a way production made visible. A bucket
 * is one per 15 seconds of *wall clock*, so refilling takes as long as it
 * records: the object was collected every minute or two, and every eviction
 * restarted the chart at one bar. The 1h and 24h ranges — 60 and 96 columns —
 * each came back with a single nonzero column in them. `flows` still stays in
 * memory, because a flow ring really does refill from the next backfill and a
 * stale copy of it would be indistinguishable from a live one; a pulse bucket
 * carries its own timestamp, so an old one is old in a way the chart can show.
 */
export interface FeedState {
  /** Highest block already accounted for; `-1` means the feed has never landed one. */
  lastBlock: number;
  level: MeterState;
  turbulence: MeterState;
  chainTemp: number;
  marketTemp: number;
  prevVolume: number;
  prevTemp: number;
  /** Oldest first. Absent in ledgers written before the chart was durable. */
  pulse?: PulseRow[];
}

export interface ChainFeed {
  readonly name: string;
  sample(): Promise<ChainSample>;
  /**
   * Transactions observed since the last call. `max` bounds the drain; the
   * default suits a tick loop that calls once per tick, and a runtime that can
   * only afford one call a minute passes a larger one so a whole interval's
   * worth of meteors comes back instead of the first tick's.
   */
  recentTxs(max?: number): ChainTx[];
  /**
   * Wait for the poll `sample()` started but deliberately did not await. Only
   * runtimes that tear the isolate down between requests need this — see
   * `ArcUsdcFeed.settle`.
   */
  settle?(): Promise<void>;
  /**
   * Carry-over for a runtime whose object does not outlive its invocation.
   * Optional because a feed with nothing worth resuming — the offline one,
   * whose state is a sinusoid and a PRNG — should not have to invent any.
   *
   * `importState` must land before the first poll, not merely before the first
   * response: a poll that runs first is a poll that backfills from `-1`, which
   * is exactly the work the restored state exists to skip.
   */
  exportState?(): FeedState;
  importState?(s: FeedState): void;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Offline feed for local development: a slow daily sinusoid plus noise,
 * and a synthetic transaction rain (5-20 fake txs per sample, hashes from a
 * local PRNG, marked `simulated: true`).
 * Zero network, zero dependencies.
 */
export class SyntheticFeed implements ChainFeed {
  readonly name = 'synthetic';
  private counter = 0;
  private prevTemp = 0.5;
  private rngState = 0x5eed;
  private pendingTxs: ChainTx[] = [];

  constructor(private periodSamples = 1800) {}

  private next(): number {
    // Local mulberry32 so fake hashes are stable per process run.
    this.rngState = (this.rngState + 0x6d2b79f5) | 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  async sample(): Promise<ChainSample> {
    this.counter++;
    const wave = 0.5 + 0.35 * Math.sin((this.counter / this.periodSamples) * Math.PI * 2);
    const noise = (Math.random() - 0.5) * 0.12;
    const temp = clamp01(wave + noise);
    const delta = temp - this.prevTemp;
    this.prevTemp = temp;
    // Transfer count per tick is calibrated to a live Arc poll (~13 USDC
    // transfers/s at 4 ticks/s): the sim's food economy is the same in both
    // modes, so a synthetic rain that is 4x busier would flood the tank.
    const count = 2 + Math.floor(this.next() * 4);
    for (let i = 0; i < count; i++) {
      let hash = '0x';
      for (let j = 0; j < 8; j++) {
        hash += Math.floor(this.next() * 0xffffffff).toString(16).padStart(8, '0');
      }
      // Skewed like real stablecoin flow: mostly dust, occasionally a whale.
      const size = clamp01(this.next() ** 5 * 1.4);
      this.pendingTxs.push({ hash, size, simulated: true });
    }
    return { temp, delta };
  }

  recentTxs(max = 6): ChainTx[] {
    // The cap never binds under a 250ms loop (each sample queues 2-5), so this
    // only matters to a caller that polls once a minute and asks for the whole
    // interval at once — it keeps `recentTxs(n)` meaning the same thing for both
    // feeds instead of silently draining everything here.
    if (this.pendingTxs.length <= max) {
      const txs = this.pendingTxs;
      this.pendingTxs = [];
      return txs;
    }
    return this.pendingTxs.splice(0, max);
  }
}
