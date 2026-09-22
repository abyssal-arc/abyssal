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
