import {
  applyIntervention,
  idsInZone,
  createWorld,
  DEFAULT_CONFIG,
  fromJSON,
  dominantTax,
  displayName,
  findCreature,
  genomeFingerprint,
  GENE_TRAITS,
  isHungry,
  isLegendary,
  LEGENDARY_GENERATION,
  LEGENDARY_KILLS,
  personaOf,
  tick as tickWorld,
  txLanding,
  WHALE_BOOM_SIZE,
  WISH_METEOR_SIZE,
  ARCHETYPE_LIST,
  type Archetype,
  type Creature,
  type GeneTrait,
  type Intervention,
  type World,
} from '@abyssal/sim';
import { ArcUsdcFeed, ARC_USDC_ADDRESS, whalePosition } from './arc.js';
import { SyntheticFeed, type ChainFeed, type ChainTx, type FeedState } from './chain.js';
import { SyntheticMarketFeed, type MarketFeed } from './market.js';
import {
  ABYS_PRICES,
  ABYS_PRICE_LEGENDARY_NAME,
  burnOffer,
  hydrateReceipts,
  priceWhole,
  recordBurnReceipt,
  CHAIN_ID,
  explorerTxUrl,
  NETWORK,
  tokenAddress,
  verifyBurnReceipt,
  type InterventionType,
} from './payments.js';
import { createWalletClient, http, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * What the tank remembers about one address. Persisted through the store so a
 * restart cannot wipe anybody's standing; rows written before this shape carry
 * only {total,last} and are filled in on load.
 */
export interface BurnerProfile {
  /** ABYS burned in whole units, day pass included. */
  total: number;
  /** Epoch ms of the last burn. */
  last: number;
  /** How many paid actions this address has taken. */
  burns: number;
  /** Paid actions per intervention type. */
  byType: Record<string, number>;
  /** Best scored battle report per intervention type. */
  bestByType: Record<string, number>;
  /** Widest single intervention, in creatures caught. */
  maxAffected: number;
  /** Species this address rallies for, and when it last changed. */
  cheer?: string;
  cheerAt?: number;
}

export function normalizeProfile(p?: Partial<BurnerProfile> | null): BurnerProfile {
  return {
    total: p?.total ?? 0,
    last: p?.last ?? 0,
    // Rows written before actions were counted still prove at least one burn.
    burns: p?.burns ?? ((p?.total ?? 0) > 0 ? 1 : 0),
    byType: p?.byType ?? {},
    bestByType: p?.bestByType ?? {},
    maxAffected: p?.maxAffected ?? 0,
    cheer: p?.cheer,
    cheerAt: p?.cheerAt,
  };
}

/**
 * Badges are derived, never stored: they follow from the record, so a rule
 * change re-grades everybody at once and no stale award survives it.
 */
export const BADGES = [
  'firstBurn',
  'weathermaker',
  'executioner',
  'benefactor',
  'whalefall',
  'patron',
  'passHolder',
] as const;

export function badgesFor(p: BurnerProfile, passActive: boolean): string[] {
  const out: string[] = [];
  if (p.burns >= 1) out.push('firstBurn');
  if ((p.byType.bloom ?? 0) + (p.byType.drought ?? 0) >= 1) out.push('weathermaker');
  if ((p.bestByType.poison ?? 0) >= 10) out.push('executioner');
  if ((p.bestByType.feed ?? 0) >= 10) out.push('benefactor');
  if (p.maxAffected >= 50) out.push('whalefall');
  if (p.total >= 1_000_000) out.push('patron');
  if (passActive) out.push('passHolder');
  return out;
}

/**
 * The same badges as a bitmask in BADGES order: the poll carries the board
 * every 400ms, and eight rows of spelled-out award names are pure overhead
 * when one integer says the same thing.
 */
export function badgeBits(p: BurnerProfile, passActive: boolean): number {
  let bits = 0;
  for (const id of badgesFor(p, passActive)) bits |= 1 << BADGES.indexOf(id as (typeof BADGES)[number]);
  return bits;
}

/** One vote per address, and not twice inside this window. */
const CHEER_COOLDOWN_MS = 60_000;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** A paid signal flare pinned to the tank for a while, then it burns out. */
export interface Flare {
  addr: string;
  x: number;
  y: number;
  label: string;
  /** Optional hex accent (#rgb or #rrggbb); the tank picks a default without it. */
  color?: string;
  /** Tick the flare was lit. */
  atTick: number;
  /** Tick at which the flare burns out (atTick + FLARE_LIFE_TICKS). */
  expires: number;
}

/** One permanent all-time record on the fossil wall. */
export interface Fossil {
  id: number;
  name: string;
  archetype: Archetype;
  /** The category's headline number (kills, lifespan, offspring, USD, generation). */
  value: number;
  generation: number;
  alive: boolean;
  titles: string[];
  diedTick?: number;
}

/** The five shelves of the hall of fame, each capped at five fossils. */
export type FossilBoard = Record<FossilCategory, Fossil[]>;
export type FossilCategory = 'predators' | 'survivors' | 'dynasties' | 'feasts' | 'elders';

/** Everything the tank remembers about addresses, persisted through the store. */
export interface LedgerSnapshot {
  passes: [string, number][];
  burners: [string, BurnerProfile][];
  adoptions: [string, number[]][];
  flares: Flare[];
  fossils: FossilBoard;
  /**
   * Wall-clock ms the world was last advanced against. This has to be durable:
   * `catchUp()` measures the owed ticks against it, and an isolate that boots
   * without it starts from `Date.now()`, finds nothing elapsed, and silently
   * forgives the entire idle gap.
   */
  lastAdvanceAt: number;
  /**
   * Where the chain feed got to, and the numbers its temperatures rank
   * themselves against. Absent when the feed has nothing worth resuming — the
   * offline one is a sinusoid and a PRNG. Without it a cold object rebuilds the
   * feed from `lastBlock = -1` on every eviction, which means a 3600-block
   * backfill a minute: no senders resolved, so no x402 signal; a pulse history
   * rebuilt from scratch each time; and enough backfilled flows through the ring
   * to push out the live ones a viewer asked for.
   */
  feedState?: FeedState;
}

/**
 * What a store may hand back on load: every field optional (older ledgers predate
 * the social shelves), and a burner row may still be the pre-profile {total,last}
 * shape, which `normalizeProfile` fills in.
 */
export interface LedgerLoad {
  passes?: [string, number][];
  burners?: [string, Partial<BurnerProfile>][];
  adoptions?: [string, number[]][];
  flares?: Flare[];
  fossils?: Partial<FossilBoard>;
  /** Absent in ledgers written before the wall clock was persisted. */
  lastAdvanceAt?: number;
  /** Absent in ledgers written before the feed was resumable. */
  feedState?: FeedState;
}

export interface WorldStore {
  load(): Promise<LedgerLoad>;
  save(s: LedgerSnapshot): void;
}

/** How long a flare burns, in ticks (~4 minutes at 250ms/tick). */
const FLARE_LIFE_TICKS = 1000;
/** Flares fade over their last this-many ticks before burning out. */
const FLARE_FADE_TICKS = 100;
/** Hard ceiling on simultaneously lit flares, so the tank cannot be carpeted. */
const FLARES_MAX = 20;
/** One address may hold this many adoptions at once. */
const ADOPTIONS_MAX = 3;
/** Whole ABYS a flare costs when the lighter has no day pass. */
const FLARE_PRICE_WHOLE = '1000';
const FLARE_LABEL_MAX = 30;
const FOSSILS_PER_CATEGORY = 5;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export interface AppOptions {
  seed?: number;
  /**
   * Stable identity of this world instance. The node adapter leaves it random
   * per boot (a local mirror); the Worker passes one persisted in the Durable
   * Object so every isolate reports the same tank.
   */
  instance?: string;
  /** Payment token contract; defaults to the ABYS_TOKEN_ADDRESS env var. */
  token?: string;
  /**
   * Arc JSON-RPC endpoint. Workers pass the ARC_RPC_URL binding (a secret, so
   * a rate-limited provider URL never lands in the repo); the node adapter
   * falls back to .env and then to the public RPC.
   */
  rpc?: string;
  /**
   * Durable home for day passes and burner totals. Memory alone loses them on
   * an isolate restart; the node adapter uses a json file, the Worker uses the
   * Durable Object's storage.
   */
  store?: WorldStore;
  /**
   * Serves static files when provided (the node adapter passes one backed by
   * node:fs). Keeping it injected keeps this module free of node builtins, so
   * the same handler runs inside a Cloudflare Worker where static assets come
   * from the runtime instead.
   */
  static?: (pathname: string, headers: Headers) => Promise<Response | null>;
  /** Serialized world snapshot (sim `toJSON`) to resume instead of seeding a fresh world. */
  snapshot?: string;
  chainFeed?: ChainFeed;
  marketFeed?: MarketFeed;
}

const INTERVENTION_TYPES: InterventionType[] = [
  'feed', 'poison', 'bloom', 'drought', 'pass',
  'name', 'wish', 'mutate', 'ark',
];

/** Types that need a living creature picked out of the tank before they pay. */
const TARGETED_TYPES: InterventionType[] = ['name', 'mutate', 'ark'];
/** True for the union members that carry a creatureId. */
function isTargeted(iv: Intervention): iv is Extract<Intervention, { creatureId: number }> {
  return TARGETED_TYPES.includes(iv.type as InterventionType);
}

const NAME_MAX = 24;
const WISH_MAX = 60;

/**
 * User text becomes part of the world: it is rendered on the tank, echoed into
 * receipts and stored in the snapshot. Markup and control characters are
 * stripped rather than escaped so the same string is safe in innerHTML, in a
 * canvas fillText and in a CSV export alike; anything that survives the strip
 * is plain text.
 */
function sanitizeText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw
    .replace(/<[^>]*>?/g, '')
    .replace(/[<>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0 || clean.length > max) return null;
  return clean;
}

/** A creature id from a request body: a positive integer, or null. */
function creatureIdOf(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const PUBLIC_ARC_RPC = 'https://rpc.mainnet.arc.io';

function defaultChainFeedFromEnv(rpc?: string): ChainFeed {
  // Arc is the product; the offline rain is an explicit opt-out for working
  // without network (and for hermetic tests), not the default.
  if (process.env.CHAIN_FEED === 'synthetic') return new SyntheticFeed();
  return new ArcUsdcFeed(rpc ?? PUBLIC_ARC_RPC, process.env.ARC_USDC_ADDRESS ?? ARC_USDC_ADDRESS);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Deepest /history window we will serve; matches the pre-`?window=` behaviour. */
const HISTORY_WINDOW_MAX = 2000;

/**
 * Stride-downsample to at most `slots` rows, mirroring the chart's own
 * `computePoints` exactly: `step = ceil(len / slots)`, take every step-th row.
 * The pass is idempotent (its output is always ≤ slots, so a second pass has
 * step 1), which is what lets the server do the decimation and the client draw
 * the identical line from ~10x less JSON.
 */
function decimate<T>(rows: T[], slots: number): T[] {
  if (rows.length <= slots) return rows;
  const step = Math.ceil(rows.length / slots);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
  return out;
}

function positiveInt(raw: string | null, fallback: number): number {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resume a world from a snapshot. The live config replaces the stored one so
 * tuning edits apply to resumed worlds (positions wrap on the next tick).
 */
function resumeWorld(snapshot: string): World {
  const world = fromJSON(snapshot);
  world.config = DEFAULT_CONFIG;
  return world;
}

export function createApp(options: AppOptions = {}) {
  const world: World = options.snapshot
    ? resumeWorld(options.snapshot)
    : createWorld(options.seed ?? 1337);
  const chainFeed: ChainFeed = options.chainFeed ?? defaultChainFeedFromEnv(options.rpc ?? process.env.ARC_RPC_URL);
  /** Non-null when running against Arc: powers /observe and the market feed. */
  const arcFeed = chainFeed instanceof ArcUsdcFeed ? chainFeed : null;
  const marketFeed: MarketFeed =
    options.marketFeed ??
    (arcFeed
      ? { name: 'arc-usdc-flow', sample: async () => arcFeed.market() }
      : new SyntheticMarketFeed());
  // Interventions are paid by burning ABYS: no seller key, no facilitator,
  // the receipt is the proof. Until the token address is configured there is
  // nothing to burn and /intervene answers 503. There is no demo path.
  const rpcUrl = options.rpc ?? process.env.ARC_RPC_URL ?? PUBLIC_ARC_RPC;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastAdvanceAt = Date.now();
  const instanceId = crypto.randomUUID();
  let chainTemp = 0.5;
  let chainDelta = 0;
  let marketTemp = 0.5;
  /** 'live' (real RPC) | 'synthetic' (default) | 'degraded' (RPC failing, fallback active). */
  let feedStatus: 'live' | 'synthetic' | 'degraded' = 'synthetic';
  let blockNumber: number | undefined;
  const fallbackFeed = new SyntheticFeed();
  /** Recent transaction meteors with their deterministic landing sites. */
  let txRain: {
    hash: string;
    size: number;
    x: number;
    y: number;
    simulated?: boolean;
    meta?: { from: string; to: string; amount: number; x402: boolean };
    whale?: { address: string; rank: number; volume: number };
    /**
     * True when the transfer was big enough for the sim to treat the landing as
     * a whale boom, a local pull that turns nearby creatures toward the money.
     * Evaluated here against the sim's own threshold so the viewer flashes on
     * exactly the transfers the ecosystem reacts to, and stays quiet on the
     * dust that only makes a streak.
     */
    boom?: boolean;
    /**
     * A paid wishing meteor: the words it carried and the address that sent
     * them, so the tank can render the message alongside the fall.
     */
    wish?: { message: string; addr: string };
  }[] = [];

  /**
   * Reroute a resident whale's own transfer to the whale instead of to its hash
   * coordinate, so the money it moves feeds the water it is swimming through and
   * the tank converges on it. Mutates the batch and must run before `tickWorld`,
   * which reads `tx.at` as the landing site.
   */
  function markWhales(txs: ChainTx[]): void {
    if (!arcFeed) return;
    const whales = arcFeed.whaleIndex();
    if (whales.size === 0) return;
    const now = Date.now();
    for (const tx of txs) {
      if (!tx.meta) continue;
      const w = whales.get(tx.meta.to) ?? whales.get(tx.meta.from);
      if (!w) continue;
      const at = whalePosition(w.lane, now, world.config.width, world.config.height);
      if (!at) continue;
      tx.at = at;
      tx.whale = { address: w.address, rank: w.rank, volume: w.volume };
    }
  }

  /**
   * Record a tick's meteors for the viewer (the render buffer keeps the newest
   * 12) and for the daily report (the day's biggest fall). Runs after
   * `tickWorld`, which is what settles where a whale transfer actually landed.
   */
  function noteMeteors(txs: ChainTx[]): void {
    for (const tx of txs) {
      const { x, y } = tx.at ?? txLanding(tx.hash, world.config.width, world.config.height);
      txRain.push({
        hash: tx.hash,
        size: tx.size,
        x,
        y,
        simulated: tx.simulated,
        meta: tx.meta,
        whale: tx.whale,
        boom: tx.at !== undefined && tx.size >= WHALE_BOOM_SIZE,
      });
    }
    if (txRain.length > 12) txRain = txRain.slice(-12);
    // The day's biggest fall, for the daily report; a new day starts over.
    const day = Math.floor(world.tick / world.config.ticksPerDay);
    if (dayMaxFall.day !== day) dayMaxFall = { day, size: 0, hash: '' };
    for (const t of txs) {
      if (t.size > dayMaxFall.size) dayMaxFall = { day, size: t.size, hash: t.hash };
    }
  }

  async function advance(): Promise<void> {
    const useLive = arcFeed !== null;
    const [c, m] = await Promise.all([chainFeed.sample(), marketFeed.sample()]);
    const failures = arcFeed ? arcFeed.consecutiveFailures : 0;
    let sample = c;
    let txs: ChainTx[];
    if (useLive && failures >= 5) {
      // RPC is down: degrade to the synthetic feed until it recovers.
      feedStatus = 'degraded';
      sample = await fallbackFeed.sample();
      txs = fallbackFeed.recentTxs();
    } else {
      txs = chainFeed.recentTxs();
      // 'live' means a poll has actually landed, not merely that Arc is
      // configured. `sample()` never blocks, so a feed whose first backfill has
      // not finished hands back its initializers and no block number — and
      // calling that 'live' is exactly what let a tank permanently pinned at 0.5
      // look healthy from the outside. Until a poll completes, the temperatures
      // being fed to the sim *are* the synthetic ones, so that is what it says.
      feedStatus = useLive && sample.blockNumber !== undefined ? 'live' : 'synthetic';
    }
    chainTemp = sample.temp;
    chainDelta = sample.delta;
    marketTemp = m.temp;
    blockNumber = sample.blockNumber;
    markWhales(txs);
    tickWorld(world, { chain: sample.temp, market: m.temp }, txs);
    noteMeteors(txs);
    scoreReports();

    // Social shelves advance with the world: burnt-out flares drop off and the
    // fossil wall folds in every record before the 24-entry obituary ring can
    // forget it (a feast's USD lives only on the living creature).
    pruneFlares();
    updateFossils();

    // Day Digest on-chain commit: detect day boundary and submit.
    const day = Math.floor(world.tick / world.config.ticksPerDay);
    if (day > 0 && day !== lastCommittedDay) {
      // A new day started — commit the *previous* day's digest.
      const prevDay = day - 1;
      if (prevDay !== lastCommittedDay) {
        lastCommittedDay = prevDay;
        const prevHash = fnv1a(
          [prevDay, world.tick, world.creatures.length, Math.round(world.creatures.reduce((s, c) => s + c.energy, 0)), world.totalBorn, world.totalDied, world.totalPredations].join('|'),
        );
        void commitDayDigest(prevDay, prevHash);
      }
    }
    // Check pending digest confirmation or retry failed commits.
    void checkDigestConfirmation();
    void retryDigestCommit();

    lastAdvanceAt = Date.now();
  }

  /**
   * Meteors newer than the client's cursor, which is the hash of the last one
   * it received. The window is re-sent in full whenever that hash has aged out
   * (or the server restarted and the counter state is gone), safe because the
   * client keys its seen-set by hash, and far better than going silent.
   *
   * This is the single biggest redundancy in the poll: the same 12 entries,
   * ~4 KB of addresses and hashes, used to ride along every 400ms only for the
   * client to discard all but the one or two that were actually new.
   */
  function rainAfter(cursor: string | null): typeof txRain {
    if (!cursor) return txRain;
    const at = txRain.findIndex((t) => t.hash === cursor);
    return at === -1 ? txRain : txRain.slice(at + 1);
  }

  /**
   * Reads are a public data API (CORS *); writes are not. Browsers send Origin
   * on same-origin POSTs too, so this only turns away foreign pages.
   */
  function foreignOrigin(req: Request): boolean {
    const origin = req.headers.get('origin');
    if (!origin) return false;
    const allowlist = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
    return origin !== new URL(req.url).origin && !allowlist.includes(origin);
  }

  /**
   * `cacheSec` lets the edge absorb the poll storm: every viewer of one tank
   * asks the same question every second or two, and each of those requests
   * lands on the Durable Object, whose free allowance is tiny. A few seconds of
   * shared edge freshness costs nothing visually (the client interpolates) and
   * cuts origin load by the number of concurrent viewers.
   */
  function json(data: unknown, status = 200, cacheSec = 0): Response {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    };
    if (cacheSec > 0) {
      headers['cache-control'] = 'public, s-maxage=' + cacheSec + ', stale-while-revalidate=' + cacheSec * 3;
    }
    return new Response(JSON.stringify(data), { status, headers });
  }

  function countdown(intervalTicks: number, cullRatio: number) {
    return {
      intervalTicks,
      intervalHours: intervalTicks / (world.config.ticksPerDay / 24),
      ticksRemaining: intervalTicks - (world.tick % intervalTicks),
      cullRatio,
    };
  }

  // Pure-TS FNV-1a (no node:crypto) so the digest also runs on CF Workers.
  function fnv1a(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  let richestIds = new Set<number>();

  function statePayload() {
    const cfg = world.config;
    const day = Math.floor(world.tick / cfg.ticksPerDay);
    const top = (
      key: (c: (typeof world.creatures)[number]) => number,
      filterZero = false,
    ) =>
      [...world.creatures]
        .filter((c) => !filterZero || key(c) > 0)
        // Deterministic tie-break: equal values must not reshuffle with array
        // order, or the board's membership rotates every tick and the UI flickers.
        .sort((a, b) => key(b) - key(a) || a.id - b.id)
        .slice(0, 5)
        .map((c) => ({ id: c.id, name: displayName(c), archetype: c.archetype, value: Math.round(key(c)) }));
    // 5% incumbency hysteresis: raw energies oscillate around the cap every
    // tick, so a plain top-5 reshuffles its membership every poll and the UI
    // flickers. An outsider must lead a sitting member by 5% to unseat it.
    const topRichest = () => {
      const rows = [...world.creatures]
        .map((c) => ({ c, v: c.energy * (richestIds.has(c.id) ? 1.05 : 1) }))
        .sort((a, b) => b.v - a.v || a.c.id - b.c.id)
        .slice(0, 5);
      richestIds = new Set(rows.map((r) => r.c.id));
      return rows.map(({ c }) => ({
        id: c.id, name: displayName(c), archetype: c.archetype, value: Math.round(c.energy),
      }));
    };
    return {
      tick: world.tick,
      day,
      ticksPerDay: cfg.ticksPerDay,
      dayAnchor: {
        day,
        digest: fnv1a(
          [
            day,
            world.tick,
            world.creatures.length,
            Math.round(world.creatures.reduce((s, c) => s + c.energy, 0)),
            world.totalBorn,
            world.totalDied,
            world.totalPredations,
          ].join('|'),
        ),
      },
      population: world.creatures.length,
      totalEnergy: round1(world.creatures.reduce((s, c) => s + c.energy, 0)),
      foodCount: world.foods.length,
      chainTemp: Math.round(chainTemp * 1000) / 1000,
      chainDelta: Math.round(chainDelta * 1000) / 1000,
      marketTemp: Math.round(marketTemp * 1000) / 1000,
      chainFeed: chainFeed.name,
      marketFeed: marketFeed.name,
      feedStatus,
      blockNumber,
      explorerTxUrl: explorerTxUrl(),
      leaderboards: {
        predators: top((c) => c.kills, true),
        richest: topRichest(),
        elders: top((c) => world.tick - c.bornTick),
      },
      harvest: countdown(cfg.harvestInterval, cfg.harvestCullRatio),
      judgment: countdown(cfg.judgmentInterval, cfg.judgmentCullRatio),
      activeEffects: world.effects.map((e) => ({
        kind: e.kind,
        x: e.x,
        y: e.y,
        radius: e.radius,
        ticksRemaining: e.expiresTick - world.tick,
        life: e.life,
        affected: e.affected,
        tx: e.tx,
        payer: e.payer,
        paid: e.paid,
      })),
      totals: { born: world.totalBorn, died: world.totalDied, predations: world.totalPredations },
      digestChain: digestChain ? {
        day: digestChain.day,
        hash: digestChain.hash,
        status: digestChain.status,
        txHash: digestChain.txHash,
        confirmedAt: digestChain.confirmedAt,
      } : null,
      network: NETWORK,
      chainId: CHAIN_ID,
      instance: options.instance ?? instanceId,
      prices: ABYS_PRICES,
      /** What naming a legend costs, so the card can warn before the wallet opens. */
      legendaryNamePrice: ABYS_PRICE_LEGENDARY_NAME,
      // The sim's own thresholds, handed down rather than restated: the card
      // warns by these and the 402 charges by isLegendary, so a copy here would
      // be a second answer to the same question.
      legendary: { generation: LEGENDARY_GENERATION, kills: LEGENDARY_KILLS },
      geneTraits: GENE_TRAITS,
      paymentAsset: 'ABYSSAL',
      // How POST /intervene is paid: the visitor burns ABYS and presents the
      // burn receipt, or 'unconfigured' until ABYS_TOKEN_ADDRESS is set. The UI
      // badges the intervention panel with this.
      payment: tokenAddress()
        ? { mode: 'burn', network: `eip155:${CHAIN_ID}`, token: tokenAddress() }
        : { mode: 'unconfigured', network: null, token: null },
    };
  }

  // Three daily propositions resolved from the world itself at day roll: no
  // oracle and no market, just standings anybody can recompute from /history.
  let dayStartDay = -1;
  let dayStartPredations = 0;
  let prevDayPredations = 0;
  let prevDayResults: { id: string; ok: boolean }[] = [];
  let lastStandings: { id: string; ok: boolean; value: number }[] = [];
  function propositions() {
    const cfg = world.config;
    const day = Math.floor(world.tick / cfg.ticksPerDay);
    if (day !== dayStartDay) {
      prevDayResults = lastStandings.map((x) => ({ id: x.id, ok: x.ok }));
      prevDayPredations = world.totalPredations - dayStartPredations;
      dayStartDay = day;
      dayStartPredations = world.totalPredations;
    }
    const killsOf = (a: string) =>
      world.creatures.filter((c) => c.archetype === a).reduce((sum, c) => sum + c.kills, 0);
    const counts: Record<string, number> = { APE: 0, WHALE: 0, ALGO: 0, INSIDER: 0 };
    for (const c of world.creatures) counts[c.archetype]++;
    const pop = Math.max(1, world.creatures.length);
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
    const algo = killsOf('ALGO');
    const share = Math.round((top[1] / pop) * 100);
    const predToday = world.totalPredations - dayStartPredations;
    lastStandings = [
      { id: 'algo-top', ok: algo > 0 && algo >= Math.max(killsOf('APE'), killsOf('WHALE'), killsOf('INSIDER')), value: algo },
      { id: 'mono', ok: share > 50, value: share },
      { id: 'pred', ok: predToday > prevDayPredations, value: predToday },
    ];
    return { day, standings: lastStandings, yesterday: prevDayResults };
  }

  // Who has burned for the tank, and day-pass holders (export gate).
  const burners = new Map<string, BurnerProfile>();
  // Intervention battle reports, scored 400 ticks after the burn.
  const reports: {
    tx: string; type: string; payer?: string; paid?: string; atTick: number;
    affectedIds: number[]; popAt: number;
    score?: number; survivors?: number;
  }[] = [];
  let dayMaxFall = { day: -1, size: 0, hash: '' };

  /* ---------- Day Digest on-chain commit ---------- */

  interface DigestChainState {
    day: number;
    hash: string;
    status: 'unconfigured' | 'pending' | 'confirmed' | 'failed';
    txHash: string | null;
    confirmedAt: number | null;
    retries: number;
    /** Stats snapshot at commit time. */
    stats: {
      born: number;
      died: number;
      predations: number;
      population: number;
      topPredator: string | null;
      totalEnergy: number;
    } | null;
  }

  let digestChain: DigestChainState | null = null;
  let lastCommittedDay = -1;
  let digestCommitInFlight = false;

  function digestKey(): `0x${string}` | null {
    const pk = process.env.ARC_DIGEST_KEY;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
    return pk as `0x${string}`;
  }

  function buildDigestPayload(day: number): DigestChainState['stats'] {
    const killsBy: Record<string, number> = {};
    for (const c of world.creatures) killsBy[c.archetype] = (killsBy[c.archetype] ?? 0) + c.kills;
    const winner = Object.entries(killsBy).sort((a, b) => b[1] - a[1])[0];
    return {
      born: world.totalBorn,
      died: world.totalDied,
      predations: world.totalPredations,
      population: world.creatures.length,
      topPredator: winner ? `${winner[0]}:${winner[1]}` : null,
      totalEnergy: Math.round(world.creatures.reduce((s, c) => s + c.energy, 0)),
    };
  }

  async function commitDayDigest(day: number, hash: string): Promise<void> {
    if (digestCommitInFlight) return;
    const pk = digestKey();
    const rpc = options.rpc ?? process.env.ARC_RPC_URL;
    if (!pk || !rpc) {
      digestChain = { day, hash, status: 'unconfigured', txHash: null, confirmedAt: null, retries: 0, stats: buildDigestPayload(day) };
      return;
    }
    digestCommitInFlight = true;
    try {
      const account = privateKeyToAccount(pk);
      const client = createWalletClient({ account, transport: http(rpc) });
      // Encode digest as calldata: magic "ABYS" + day(u32) + hash + JSON stats
      const stats = buildDigestPayload(day);
      const payload = JSON.stringify({ day, hash, ts: Date.now(), ...stats });
      const data = ('0x41425953' + toHex(payload).slice(2)) as `0x${string}`;
      const txHash = await client.sendTransaction({
        to: account.address,
        value: 0n,
        data,
        chain: { id: CHAIN_ID, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 }, rpcUrls: { default: { http: [rpc] } } } as any,
      });
      digestChain = { day, hash, status: 'pending', txHash, confirmedAt: null, retries: 0, stats };
    } catch {
      const retries = (digestChain?.day === day ? digestChain.retries : 0) + 1;
      digestChain = { day, hash, status: retries >= 3 ? 'failed' : 'pending', txHash: null, confirmedAt: null, retries, stats: buildDigestPayload(day) };
      if (retries >= 3) digestChain.status = 'failed';
    } finally {
      digestCommitInFlight = false;
    }
  }

  async function checkDigestConfirmation(): Promise<void> {
    if (!digestChain || digestChain.status !== 'pending' || !digestChain.txHash) return;
    const rpc = options.rpc ?? process.env.ARC_RPC_URL;
    if (!rpc) return;
    try {
      const res = await globalThis.fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [digestChain.txHash] }),
      });
      const json = (await res.json()) as { result?: { status?: string } | null };
      if (json.result && json.result.status === '0x1') {
        digestChain.status = 'confirmed';
        digestChain.confirmedAt = Date.now();
      } else if (json.result && json.result.status === '0x0') {
        digestChain.status = 'failed';
      }
    } catch { /* will retry next tick */ }
  }

  /** Retry a failed digest commit (up to 3 total attempts). */
  async function retryDigestCommit(): Promise<void> {
    if (!digestChain || digestChain.status !== 'failed' || digestChain.retries >= 3) return;
    await commitDayDigest(digestChain.day, digestChain.hash);
  }

  function scoreReports() {
    for (const r of reports) {
      if (r.score !== undefined || world.tick < r.atTick + 400) continue;
      const alive = new Set(world.creatures.map((c) => c.id));
      const survivors = r.affectedIds.filter((id) => alive.has(id)).length;
      r.survivors = survivors;
      r.score =
        r.type === 'poison'
          ? r.affectedIds.length - survivors
          : r.type === 'feed'
            ? survivors
            : world.creatures.length - r.popAt;
      // An address is graded on its best shot, not its last one.
      const p = r.payer ? burners.get(r.payer) : undefined;
      if (p && r.score > (p.bestByType[r.type] ?? Number.NEGATIVE_INFINITY)) {
        p.bestByType[r.type] = r.score;
      }
    }
  }

  function dailyReport() {
    const cfg = world.config;
    const day = Math.floor(world.tick / cfg.ticksPerDay);
    const killsBy: Record<string, number> = {};
    for (const c of world.creatures) killsBy[c.archetype] = (killsBy[c.archetype] ?? 0) + c.kills;
    const winner = Object.entries(killsBy).sort((a, b) => b[1] - a[1])[0];
    const deathsToday = world.obituaries.filter((o) => Math.floor(o.diedTick / cfg.ticksPerDay) === day);
    const byCause: Record<string, number> = {};
    for (const o of deathsToday) byCause[o.cause] = (byCause[o.cause] ?? 0) + 1;
    const bySpecies: Record<string, number> = {};
    for (const o of deathsToday) bySpecies[o.archetype] = (bySpecies[o.archetype] ?? 0) + 1;
    const saddest = Object.entries(bySpecies).sort((a, b) => b[1] - a[1])[0];
    const strongest = [...world.creatures].sort((a, b) => b.kills - a.kills)[0];
    const topBurner = [...burners.entries()].sort((a, b) => b[1].total - a[1].total)[0];
    const biggest = reports
      .filter((r) => Math.floor(r.atTick / cfg.ticksPerDay) === day)
      .sort((a, b) => b.affectedIds.length - a.affectedIds.length)[0];
    return {
      day,
      // Null until something actually fell today, so the line does not read $0.00.
      maxFall: dayMaxFall.day === day && dayMaxFall.hash ? dayMaxFall : null,
      winner: winner ? { species: winner[0], kills: winner[1] } : null,
      biggestIntervention: biggest
        ? { tx: biggest.tx, type: biggest.type, affected: biggest.affectedIds.length }
        : null,
      deaths: byCause,
      mvp: {
        strongest: strongest ? { id: strongest.id, name: displayName(strongest), kills: strongest.kills } : null,
        burner: topBurner ? { address: topBurner[0], total: topBurner[1].total } : null,
        saddest: saddest ? { species: saddest[0], deaths: saddest[1] } : null,
      },
    };
  }
  const passes = new Map<string, number>();
  function passActive(addr: string): boolean {
    return world.tick < (passes.get(addr) ?? 0);
  }
  function noteBurn(payer: string | undefined, whole: number, type: string) {
    if (!payer) return;
    const b = burners.get(payer) ?? normalizeProfile(null);
    b.total += whole;
    b.last = Date.now();
    b.burns += 1;
    b.byType[type] = (b.byType[type] ?? 0) + 1;
    burners.set(payer, b);
  }
  /** How many addresses rally for each species. */
  function cheers(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of burners.values()) if (p.cheer) out[p.cheer] = (out[p.cheer] ?? 0) + 1;
    return out;
  }

  /* ---------- social shelves: adoptions, flares, fossils ---------- */

  /** address -> the creature ids it has adopted (max ADOPTIONS_MAX each). */
  const adoptions = new Map<string, number[]>();
  /** Lit signal flares, newest last; pruned against world.tick every advance. */
  let flares: Flare[] = [];
  const emptyFossils = (): FossilBoard => ({
    predators: [], survivors: [], dynasties: [], feasts: [], elders: [],
  });
  /** Permanent all-time top-5 per category, surviving the 24-entry obituary ring. */
  let fossils: FossilBoard = emptyFossils();

  /** Reverse index (creatureId -> adopter); adoptions are few, so rebuild per call. */
  function adoptedByMap(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [addr, ids] of adoptions) for (const id of ids) out.set(id, addr);
    return out;
  }

  /** The same gate /cheer uses: the tank, a day pass, or the chain has seen this address. */
  function knownAddress(addr: string): boolean {
    if (burners.has(addr) || passActive(addr)) return true;
    return arcFeed ? arcFeed.addressPayload(addr).stats.count > 0 : false;
  }

  /** Drop burnt-out flares; called every advance so the ceiling and payload stay honest. */
  function pruneFlares(): void {
    if (flares.length > 0) flares = flares.filter((f) => f.expires > world.tick);
  }

  interface FossilCandidate {
    id: number; name: string; archetype: Archetype; generation: number;
    kills: number; offspring: number; lifespan: number; maxMealUsd: number;
    titles: string[]; diedTick?: number;
  }

  function fossilValue(cat: FossilCategory, c: FossilCandidate): number {
    switch (cat) {
      case 'predators': return c.kills;
      case 'survivors': return c.lifespan;
      case 'dynasties': return c.offspring;
      case 'feasts': return c.maxMealUsd;
      case 'elders': return c.generation;
    }
  }

  /**
   * Fold the living tank and the fresh obituaries into the permanent shelves.
   * A record only ever grows (an alive creature's kills climb; a dead one is
   * frozen at what it reached), so a life that has aged out of the 24-entry
   * obituary ring still holds its place on the wall. Runs every advance, before
   * the ring can silently drop a record-holder. Feasts are the reason: only a
   * living creature carries maxMealUsd, so the number must be captured before
   * it dies and the obituary forgets it.
   */
  function updateFossils(): void {
    const cands: FossilCandidate[] = [];
    for (const c of world.creatures) {
      cands.push({
        id: c.id, name: displayName(c), archetype: c.archetype, generation: c.generation,
        kills: c.kills, offspring: c.offspring, lifespan: Math.max(0, world.tick - c.bornTick),
        maxMealUsd: c.maxMealUsd ?? 0, titles: [],
      });
    }
    for (const o of world.obituaries) {
      cands.push({
        id: o.id, name: o.name, archetype: o.archetype, generation: o.generation,
        kills: o.kills, offspring: o.offspring, lifespan: Math.max(0, o.diedTick - o.bornTick),
        maxMealUsd: 0, titles: o.titles ?? [], diedTick: o.diedTick,
      });
    }
    const aliveIds = new Set(world.creatures.map((c) => c.id));
    for (const cat of Object.keys(fossils) as FossilCategory[]) {
      const byId = new Map<number, Fossil>(fossils[cat].map((f) => [f.id, { ...f }]));
      for (const cd of cands) {
        const val = fossilValue(cat, cd);
        const ex = byId.get(cd.id);
        if (ex) {
          ex.name = cd.name;
          ex.archetype = cd.archetype;
          ex.generation = cd.generation;
          if (cd.titles.length) ex.titles = cd.titles;
          if (cd.diedTick !== undefined) ex.diedTick = cd.diedTick;
          ex.value = Math.max(ex.value, val);
        } else if (val > 0) {
          byId.set(cd.id, {
            id: cd.id, name: cd.name, archetype: cd.archetype, value: val,
            generation: cd.generation, alive: true, titles: cd.titles,
            ...(cd.diedTick !== undefined ? { diedTick: cd.diedTick } : {}),
          });
        }
      }
      fossils[cat] = [...byId.values()]
        .map((f) => ({ ...f, alive: aliveIds.has(f.id) }))
        .sort((a, b) => b.value - a.value || a.id - b.id)
        .slice(0, FOSSILS_PER_CATEGORY);
    }
  }

  /** One lineage row, resolved from the tank (alive) or the obituary ring (dead). */
  interface LineageNode {
    id: number; name: string; archetype: Archetype; generation: number;
    alive: boolean; parentId: number | null; kills: number; offspring: number;
  }

  function lineageLookup(id: number): { node: LineageNode; parentId: number | null } | null {
    const live = findCreature(world, id);
    if (live) {
      return {
        node: {
          id: live.id, name: displayName(live), archetype: live.archetype,
          generation: live.generation, alive: true, parentId: live.parentId,
          kills: live.kills, offspring: live.offspring,
        },
        parentId: live.parentId,
      };
    }
    const ob = world.obituaries.find((o) => o.id === id);
    if (ob) {
      // An obituary carries no parentId, so a dead life is an upward dead end.
      return {
        node: {
          id: ob.id, name: ob.name, archetype: ob.archetype, generation: ob.generation,
          alive: false, parentId: null, kills: ob.kills, offspring: ob.offspring,
        },
        parentId: null,
      };
    }
    return null;
  }

  /** Walk up via parentId for at most `depth` generations (dead links end the climb). */
  function ancestorsOf(startParent: number | null, depth: number): LineageNode[] {
    const out: LineageNode[] = [];
    let pid = startParent;
    for (let d = 0; d < depth && pid != null; d++) {
      const found = lineageLookup(pid);
      if (!found) break;
      out.push(found.node);
      pid = found.parentId;
    }
    return out;
  }

  /** Breadth-first down the family tree; only living creatures carry a parentId. */
  function descendantsOf(rootId: number, depth: number): LineageNode[] {
    const out: LineageNode[] = [];
    let frontier = [rootId];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const parents = new Set(frontier);
      const next: number[] = [];
      for (const c of world.creatures) {
        if (c.parentId != null && parents.has(c.parentId)) {
          out.push({
            id: c.id, name: displayName(c), archetype: c.archetype, generation: c.generation,
            alive: true, parentId: c.parentId, kills: c.kills, offspring: c.offspring,
          });
          next.push(c.id);
        }
      }
      frontier = next;
    }
    return out;
  }

  /** The address's adoptions as card rows, resolving each id against tank or ring. */
  function adoptionRows(addr: string): { id: number; name: string; archetype: string; alive: boolean }[] {
    return (adoptions.get(addr) ?? []).map((id) => {
      const found = lineageLookup(id);
      return found
        ? { id, name: found.node.name, archetype: found.node.archetype, alive: found.node.alive }
        : { id, name: `#${id}`, archetype: '', alive: false };
    });
  }

  function worldPayload() {
    const adopted = adoptedByMap();
    return {
      tick: world.tick,
      // Server wall clock at payload build time: clients anchor their
      // interpolation timeline to this so every viewer renders the same sim
      // moment, regardless of when their own poll happens to fire.
      t: Date.now(),
      width: world.config.width,
      height: world.config.height,
      // Live top addresses by two-way volume; the tank embodies them as whales.
      whales: arcFeed ? arcFeed.whalesPayload() : [],
      // Who ate each meteor's plankton, so a meteor is a character with a trail.
      eaters: Object.fromEntries(
        txRain.map((t) => [t.hash, (world.eaters[t.hash] ?? []).slice(0, 8)]),
      ),
      obituaries: world.obituaries.slice(0, 12),
      // The two hidden rules, surfaced so the tank is never a black box.
      tax: dominantTax(world),
      propositions: propositions(),
      daily: dailyReport(),
      // The contribution board: what each address burned and what it earned.
      burners: [...burners.entries()]
        .sort((x, y) => y[1].total - x[1].total)
        .slice(0, 8)
        .map(([address, b]) => ({
          address,
          total: b.total,
          last: b.last,
          burns: b.burns,
          cheer: b.cheer ?? null,
          badges: badgeBits(b, passActive(address)),
        })),
      // How many addresses rally for each species.
      cheers: cheers(),
      chainTemp,
      marketTemp,
      creatures: world.creatures.map((c) => ({
        id: c.id,
        // A paid name replaces the species codename everywhere the tank speaks.
        name: displayName(c),
        x: round1(c.x),
        y: round1(c.y),
        energy: round1(c.energy),
        hue: Math.round(c.genome.color[0] * 1000) / 1000,
        sat: Math.round(c.genome.color[1] * 1000) / 1000,
        light: Math.round(c.genome.color[2] * 1000) / 1000,
        archetype: c.archetype,
        radius: round1(c.radius),
        kills: c.kills,
        devouredTotal: round1(c.devouredTotal),
        generation: c.generation,
        bornTick: c.bornTick,
        genes: genomeFingerprint(c.genome),
        hungry: isHungry(world, c),
        offspring: c.offspring,
        maxMeal: Math.round(c.maxMeal * 10) / 10,
        persona: personaOf(c.genome),
        // Only creatures whose record meal fell from a chain transfer carry
        // the provenance; the rest stay a few bytes cheaper.
        ...(c.maxMealTx ? { mealTx: c.maxMealTx, mealUsd: c.maxMealUsd } : {}),
        // Paid extras: the codename under a custom name, and who holds the
        // ark ticket. Both are sparse, so an unmodified tank costs nothing.
        ...(c.customName ? { baseName: c.name } : {}),
        ...(c.arkProtected ? { ark: true, arkBy: c.arkBy ?? null } : {}),
        ...(isLegendary(c) ? { legendary: true } : {}),
        ...(adopted.has(c.id) ? { adoptedBy: adopted.get(c.id) } : {}),
      })),
      foods: world.foods.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) })),
      // Lit signal flares, with how long each has left so a client can fade it
      // out over the last FLARE_FADE_TICKS without a second request.
      flares: flares
        .filter((f) => f.expires > world.tick)
        .map((f) => ({
          addr: f.addr,
          x: round1(f.x),
          y: round1(f.y),
          label: f.label,
          ...(f.color ? { color: f.color } : {}),
          atTick: f.atTick,
          expires: f.expires,
          life: Math.max(0, f.expires - world.tick),
        })),
    };
  }

  /**
   * Resolve the creature a targeted intervention is aiming at, or the sentence
   * explaining why it cannot be aimed. The sim is the only authority on who is
   * still alive, so this runs before any money moves.
   */
  function targetOf(body: Record<string, unknown>): Creature | string {
    const id = creatureIdOf(body.creatureId);
    if (id === null) return 'creatureId must be a positive integer';
    return findCreature(world, id) ?? `creature #${id} is not in the tank any more`;
  }

  /**
   * Turn a request body into a sim intervention, or return the reason it cannot
   * be one. Everything is validated here, before the payment: a typo in x/y,
   * a name that is too long or a dead target must cost nothing, so the burn
   * receipt is only consumed once we know the action can actually be applied.
   */
  function buildIntervention(
    body: Record<string, unknown>,
  ): { ok: Intervention } | { fail: string } {
    const type = body.type as InterventionType;
    if (type === 'bloom' || type === 'drought') {
      return { ok: { type } };
    }
    if (type === 'feed' || type === 'poison') {
      const x = Number(body.x);
      const y = Number(body.y);
      const radius = Number(body.radius ?? 80);
      if (
        !Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || x > world.config.width ||
        y < 0 || y > world.config.height ||
        !Number.isFinite(radius) || radius < 10 || radius > 300
      ) {
        return { fail: 'invalid intervention params (need x, y, radius 10..300 inside the world)' };
      }
      return { ok: { type, x, y, radius } };
    }
    if (type === 'name') {
      const c = targetOf(body);
      if (typeof c === 'string') return { fail: c };
      const name = sanitizeText(body.name, NAME_MAX);
      if (!name) return { fail: `name must be a string of 1..${NAME_MAX} characters` };
      return { ok: { type, creatureId: c.id, name } };
    }
    if (type === 'wish') {
      const message = sanitizeText(body.message, WISH_MAX);
      if (!message) return { fail: `wish message must be a string of 1..${WISH_MAX} characters` };
      // Aim is optional: an unaimed wish falls wherever the sim throws the
      // dice, which is part of what is being bought.
      if (body.x === undefined && body.y === undefined) return { ok: { type, message } };
      const x = Number(body.x);
      const y = Number(body.y);
      if (
        !Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || x > world.config.width ||
        y < 0 || y > world.config.height
      ) {
        return { fail: 'wish coordinates must be finite numbers inside the world' };
      }
      return { ok: { type, message, x, y } };
    }
    if (type === 'mutate') {
      const c = targetOf(body);
      if (typeof c === 'string') return { fail: c };
      const trait = body.trait as GeneTrait;
      if (!GENE_TRAITS.includes(trait)) {
        return { fail: `trait must be one of ${GENE_TRAITS.join(', ')}` };
      }
      const direction = body.direction as 'boost' | 'suppress';
      if (direction !== 'boost' && direction !== 'suppress') {
        return { fail: 'direction must be boost or suppress' };
      }
      return { ok: { type, creatureId: c.id, trait, direction } };
    }
    if (type === 'ark') {
      const c = targetOf(body);
      if (typeof c === 'string') return { fail: c };
      if (c.arkProtected === true) return { fail: 'that creature already holds an ark ticket' };
      return { ok: { type, creatureId: c.id } };
    }
    return { fail: 'unknown intervention type' };
  }

  function apiIndex() {
    return {
      name: 'abyssal-server',
      chain: { network: NETWORK, chainId: CHAIN_ID, asset: 'ABYSSAL' },
      endpoints: {
        'GET /': 'web frontend',
        'GET /api': 'this endpoint index',
        'GET /state': 'tick, day, population, chain + market temperature, harvest/judgment countdowns, price list, legendary thresholds, editable traits',
        'GET /world': 'render snapshot: creatures (with archetype, plus paid identity where any exists), foods, world size',
        'GET /snapshot': 'combined world + state + events for single-request polling: ?since=<seq>, ?tail=<n> caps the event replay, ?tx=<hash> returns only newer meteors',
        'GET /history': 'recent per-tick stats (incl. per-archetype population) for charts: ?window=<n> sets the depth, ?slots=<n> decimates server-side',
        'GET /history/pulse': 'time-travel for the OBSERVE pulse: ?range=1h|24h returns re-bucketed USDC volume columns',
        'GET /judgments': 'cull records (harvest + judgment), filter with ?type=harvest|judgment',
        'GET /events': 'positioned event stream for visualization, poll with ?since=<seq>',
        'GET /reports': 'battle reports for paid interventions, scored 400 ticks after the burn',
        'GET /who': 'one address in the tank: ?addr=<0x..> returns burns, badges, pass, rank and its battle reports',
        'POST /cheer': 'rally for a species: {addr, species}, free, one vote per known address',
        'GET /lineage': 'family tree of one creature: ?id=<n>&depth=<n> returns ancestors + descendants',
        'GET /hall-of-fame': 'the fossil wall: all-time top 5 per category (predators/survivors/dynasties/feasts/elders)',
        'POST /adopt': 'adopt a living creature: {addr, creatureId}, free, 3 per known address',
        'DELETE /adopt': 'release an adoption: {addr, creatureId}',
        'POST /flare': 'pin a signal flare: {addr, x, y, label, color?}; free with a day pass, else burn 1,000 ABYS',
        'DELETE /flare': 'remove one of your own flares: {addr, index}',
        'GET /export': 'day-pass download of the observation window: ?pass=<address>&kind=csv|replay|digest',
        'GET /observe': 'Arc USDC flow observatory: stats, endpoint ranking, pulse, recent flows (available:false off-Arc)',
        'POST /intervene': 'intervention (feed/poison/bloom/drought/pass/name/wish/mutate/ark) paid by burning ABYS on Arc; the burn receipt is the payment proof; 503 until ABYS_TOKEN_ADDRESS is set',
        'POST /tick': 'debug: advance one tick manually',
        'GET /ui': 'redirects to /',
      },
    };
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,x-payment-tx',
        },
      });
    }

    if (req.method === 'GET' && path === '/api') {
      return json(apiIndex());
    }

    if (req.method === 'GET' && path === '/ui') {
      return new Response(null, { status: 302, headers: { location: '/' } });
    }

    if (req.method === 'GET' && path === '/') {
      // The web frontend lives at the root; without a webRoot (embedded API
      // use) fall back to the endpoint index JSON.
      if (options.static) {
        const res = await options.static('/index.html', req.headers);
        if (res) return res;
      }
      return json(apiIndex());
    }

    if (req.method === 'GET' && path === '/state') return json(statePayload(), 200, 3);
    if (req.method === 'GET' && path === '/world') return json(worldPayload(), 200, 3);

    if (req.method === 'GET' && path === '/history') {
      // The charts draw CHART_SLOTS points and decimate whatever they receive,
      // so shipping the full window meant sending ~10x more JSON than any pixel
      // on screen could show. `?slots=` moves that decimation here.
      const window = Math.min(positiveInt(url.searchParams.get('window'), HISTORY_WINDOW_MAX), HISTORY_WINDOW_MAX);
      const slots = Math.min(positiveInt(url.searchParams.get('slots'), 0), window);
      const stats = world.statsLog.slice(-window);
      return json({ stats: slots > 0 ? decimate(stats, slots) : stats }, 200, 3);
    }

    if (req.method === 'GET' && path === '/history/pulse') {
      // Time-travel for the OBSERVE pulse chart: re-buckets the chain feed's
      // in-memory 15s series into 1h@60s or 24h@900s columns. Off-Arc the
      // observatory is silent and so is this; the client falls back to live.
      if (!arcFeed) return json({ available: false, range: 'none', bucketMs: 0, buckets: [] }, 200, 3);
      const range = url.searchParams.get('range') ?? '1h';
      const cfg = range === '24h'
        ? { rangeMs: 24 * 60 * 60 * 1000, bucketMs: 15 * 60 * 1000 }
        : range === '1h'
          ? { rangeMs: 60 * 60 * 1000, bucketMs: 60 * 1000 }
          : null;
      if (!cfg) return json({ error: 'unknown range', accepts: ['1h', '24h'] }, 400);
      try {
        return json({
          available: true,
          range,
          bucketMs: cfg.bucketMs,
          buckets: arcFeed.historyPulse(cfg.rangeMs, cfg.bucketMs),
        }, 200, 10);
      } catch {
        return json({ error: 'history unavailable' }, 503);
      }
    }

    if (req.method === 'GET' && path === '/judgments') {
      const type = url.searchParams.get('type');
      const culls = type ? world.culls.filter((c) => c.type === type) : world.culls;
      return json({ judgments: culls }, 200, 3);
    }

    if (req.method === 'GET' && path === '/events') {
      const since = Number(url.searchParams.get('since') ?? 0);
      // Hard ceiling per response: the ring is 200 deep today, and this keeps
      // that guarantee explicit if the ring ever grows.
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 500);
      const events = world.eventLog.filter((e) => e.seq > since).slice(-limit);
      return json({ tick: world.tick, events });
    }

    if (req.method === 'GET' && path === '/snapshot') {
      // Combined poll: one request carries world, state, events and tx rain.
      const since = Number(url.searchParams.get('since') ?? 0);
      let events = world.eventLog.filter((e) => e.seq > since);
      // A booting (or resuming) client feeds only the last handful of events to
      // its ticker and suppresses every effect, so replaying the whole 200-entry
      // log to it is bytes nothing on screen will ever use. `?tail=` caps it.
      const tail = positiveInt(url.searchParams.get('tail'), 0);
      if (tail > 0 && events.length > tail) events = events.slice(-tail);
      return json({
        world: worldPayload(),
        state: statePayload(),
        events,
        txRain: rainAfter(url.searchParams.get('tx')),
      }, 200, 3);
    }

    if (req.method === 'GET' && path === '/reports') {
      scoreReports();
      return json({ reports: reports.slice(-12).reverse() }, 200, 3);
    }

    // One address's standing in the tank: what it burned, what it earned, and
    // how its interventions turned out.
    if (req.method === 'GET' && path === '/who') {
      const addr = (url.searchParams.get('addr') ?? '').toLowerCase();
      if (!ADDRESS_RE.test(addr)) return json({ error: 'address required' }, 400);
      const p = burners.get(addr) ?? normalizeProfile(null);
      const active = passActive(addr);
      const rank = [...burners.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .findIndex(([a]) => a === addr);
      return json({
        address: addr,
        known: burners.has(addr),
        burned: p.total,
        burns: p.burns,
        byType: p.byType,
        maxAffected: p.maxAffected,
        pass: { active, until: active ? passes.get(addr) ?? null : null },
        badges: badgesFor(p, active),
        cheer: p.cheer ?? null,
        adoptions: adoptionRows(addr),
        rank: rank === -1 ? null : rank + 1,
        reports: reports
          .filter((r) => r.payer === addr)
          .slice(-8)
          .reverse()
          .map((r) => ({
            tx: r.tx,
            type: r.type,
            atTick: r.atTick,
            affected: r.affectedIds.length,
            score: r.score,
          })),
      });
    }

    // A creature's family tree: ancestors up the parentId chain, descendants by
    // scanning the tank for children. Dead lives are an upward dead end (the
    // obituary ring carries no parentId), but their names still resolve.
    if (req.method === 'GET' && path === '/lineage') {
      const id = creatureIdOf(url.searchParams.get('id'));
      if (id === null) return json({ error: 'id must be a positive integer' }, 400);
      const depth = Math.min(6, Math.max(1, positiveInt(url.searchParams.get('depth'), 3)));
      const found = lineageLookup(id);
      if (!found) return json({ error: `creature #${id} not found` }, 404);
      return json({
        root: found.node,
        ancestors: ancestorsOf(found.parentId, depth),
        descendants: descendantsOf(id, depth),
        depth,
      }, 200, 3);
    }

    // The fossil wall: permanent all-time top 5 per category, folded in on every
    // advance so records outlive the 24-entry obituary ring.
    if (req.method === 'GET' && path === '/hall-of-fame') {
      return json({ categories: fossils }, 200, 3);
    }

    if (req.method === 'GET' && path === '/export') {
      const payer = (url.searchParams.get('pass') ?? '').toLowerCase();
      const until = passes.get(payer) ?? 0;
      if (!payer || world.tick >= until) {
        return json({ error: 'day pass required', accepts: [await burnOffer(rpcUrl, 'pass', options.token)] }, 402);
      }
      const obs = arcFeed?.observePayload();
      const kind = url.searchParams.get('kind') ?? 'csv';
      if (kind === 'digest') {
        const cfg = world.config;
        const day = Math.floor(world.tick / cfg.ticksPerDay);
        const digest = {
          day,
          instance: options.instance ?? 'local',
          population: world.creatures.length,
          births: world.totalBorn,
          deaths: world.totalDied,
          predations: world.totalPredations,
          species: world.creatures.reduce<Record<string, number>>((acc, c) => {
            acc[c.archetype] = (acc[c.archetype] ?? 0) + 1;
            return acc;
          }, {}),
          propositions: propositions(),
        };
        return new Response(JSON.stringify(digest, null, 2), {
          headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="abyssal-day-${day}.json"` },
        });
      }
      if (kind === 'replay') {
        return new Response(JSON.stringify({ pulse: obs?.pulse ?? [], flows: obs?.flows ?? [] }), {
          headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="abyssal-replay.json"' },
        });
      }
      const rows = ['t,volume,count,x402'];
      for (const p of obs?.pulse ?? []) rows.push(`${p.t},${p.volume},${p.count},${p.x402}`);
      rows.push('t,from,to,amount,x402');
      for (const f of obs?.flows ?? []) rows.push(`${f.t},${f.from},${f.to},${f.amount},${f.x402 === true ? 1 : 0}`);
      return new Response(rows.join('\n'), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="abyssal-window.csv"' },
      });
    }

    if (req.method === 'GET' && path === '/observe') {
      if (!arcFeed) return json({ available: false }, 200, 3);
      const addr = url.searchParams.get('addr');
      if (addr) return json({ available: true, ...arcFeed.addressPayload(addr) }, 200, 3);
      return json({ available: true, ...arcFeed.observePayload() }, 200, 3);
    }

    if (req.method === 'POST' && path === '/tick') {
      // Debug-only: anyone could fast-forward a public tank otherwise.
      if (process.env.ALLOW_DEBUG_TICK !== '1') {
        return json({ error: 'debug route disabled', hint: 'set ALLOW_DEBUG_TICK=1' }, 404);
      }
      await advance();
      return json({ ok: true, tick: world.tick });
    }

    // Rally for a species. Free, one vote per address, and only for an address
    // the tank or the chain has actually seen, so the tally cannot be stuffed
    // with inventions.
    if (req.method === 'POST' && path === '/cheer') {
      if (foreignOrigin(req)) {
        return json({ error: 'cross-origin cheers are not allowed' }, 403);
      }
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const addr = String(body.addr ?? '').toLowerCase();
      const species = String(body.species ?? '').toUpperCase();
      if (!ADDRESS_RE.test(addr)) return json({ error: 'address required' }, 400);
      if (!ARCHETYPE_LIST.includes(species as Archetype)) {
        return json({ error: 'unknown species', species: ARCHETYPE_LIST }, 400);
      }
      const onChain = arcFeed ? arcFeed.addressPayload(addr).stats.count : 0;
      if (!burners.has(addr) && !passActive(addr) && onChain === 0) {
        return json(
          { error: 'unknown address', hint: 'burn ABYS, hold a day pass, or move USDC on Arc first' },
          403,
        );
      }
      const p = burners.get(addr) ?? normalizeProfile(null);
      if (p.cheer !== species) {
        const wait = CHEER_COOLDOWN_MS - (Date.now() - (p.cheerAt ?? 0));
        if (p.cheerAt && wait > 0) return json({ error: 'too soon', retryInMs: wait }, 429);
        p.cheer = species;
        p.cheerAt = Date.now();
        burners.set(addr, p);
        saveStore();
      }
      return json({ ok: true, cheer: p.cheer ?? null, cheers: cheers() });
    }

    // Adopt a living creature. Free, capped at ADOPTIONS_MAX per address, and
    // only for an address the tank or the chain has seen (the /cheer gate), so
    // the shelf cannot be stuffed with inventions. A creature belongs to at most
    // one adopter at a time.
    if (req.method === 'POST' && path === '/adopt') {
      if (foreignOrigin(req)) return json({ error: 'cross-origin adoptions are not allowed' }, 403);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const addr = String(body.addr ?? '').toLowerCase();
      const id = creatureIdOf(body.creatureId);
      if (!ADDRESS_RE.test(addr)) return json({ error: 'address required' }, 400);
      if (id === null) return json({ error: 'creatureId must be a positive integer' }, 400);
      if (!knownAddress(addr)) {
        return json(
          { error: 'unknown address', hint: 'burn ABYS, hold a day pass, or move USDC on Arc first' },
          403,
        );
      }
      if (!findCreature(world, id)) return json({ error: `creature #${id} is not in the tank` }, 404);
      const owner = adoptedByMap().get(id);
      if (owner !== undefined && owner !== addr) {
        return json({ error: 'already adopted', by: owner }, 409);
      }
      const mine = adoptions.get(addr) ?? [];
      if (!mine.includes(id)) {
        if (mine.length >= ADOPTIONS_MAX) {
          return json({ error: 'adoption shelf full', max: ADOPTIONS_MAX }, 409);
        }
        mine.push(id);
        adoptions.set(addr, mine);
        saveStore();
      }
      return json({ ok: true, adoptions: adoptions.get(addr) ?? [] });
    }

    // Release an adoption. Idempotent: releasing something you never held is a
    // no-op that still reports the current shelf.
    if (req.method === 'DELETE' && path === '/adopt') {
      if (foreignOrigin(req)) return json({ error: 'cross-origin adoptions are not allowed' }, 403);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const addr = String(body.addr ?? '').toLowerCase();
      const id = creatureIdOf(body.creatureId);
      if (!ADDRESS_RE.test(addr)) return json({ error: 'address required' }, 400);
      if (id === null) return json({ error: 'creatureId must be a positive integer' }, 400);
      const mine = adoptions.get(addr);
      if (mine) {
        const at = mine.indexOf(id);
        if (at !== -1) mine.splice(at, 1);
        if (mine.length === 0) adoptions.delete(addr);
        saveStore();
      }
      return json({ ok: true, adoptions: adoptions.get(addr) ?? [] });
    }

    // Pin a signal flare to the tank. Free with a day pass, otherwise it costs a
    // FLARE_PRICE_WHOLE ABYS burn (the same receipt flow as /intervene). Fully
    // validated before any money moves, and refused before payment when the
    // global ceiling is already reached.
    if (req.method === 'POST' && path === '/flare') {
      if (foreignOrigin(req)) return json({ error: 'cross-origin flares are not allowed' }, 403);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const addr = String(body.addr ?? '').toLowerCase();
      if (!ADDRESS_RE.test(addr)) return json({ error: 'address required' }, 400);
      const x = Number(body.x);
      const y = Number(body.y);
      if (
        !Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || x > world.config.width || y < 0 || y > world.config.height
      ) {
        return json({ error: 'flare needs x, y inside the world' }, 400);
      }
      const label = sanitizeText(body.label, FLARE_LABEL_MAX);
      if (!label) return json({ error: `label must be 1..${FLARE_LABEL_MAX} characters` }, 400);
      let color: string | undefined;
      if (body.color !== undefined && body.color !== null) {
        const raw = String(body.color);
        if (!HEX_COLOR_RE.test(raw)) return json({ error: 'color must be a hex like #rgb or #rrggbb' }, 400);
        color = raw.toLowerCase();
      }
      const live = flares.filter((f) => f.expires > world.tick);
      if (live.length >= FLARES_MAX) {
        return json({ error: 'the tank is full of flares', max: FLARES_MAX }, 429);
      }
      const free = passActive(addr);
      if (!free) {
        const offer = await burnOffer(rpcUrl, 'pass', options.token, FLARE_PRICE_WHOLE);
        if (!offer) {
          return json(
            { error: 'token not deployed', hint: 'set ABYS_TOKEN_ADDRESS to an ERC-20 that answers decimals()' },
            503,
          );
        }
        const txHash = String(req.headers.get('x-payment-tx') ?? body.tx ?? '');
        if (!txHash) {
          return json({ error: 'payment required', accepts: [offer], price: `${FLARE_PRICE_WHOLE} ABYS` }, 402);
        }
        const verdict = await verifyBurnReceipt(rpcUrl, offer, txHash);
        if (!verdict.ok) {
          return json({ error: 'payment required', accepts: [offer], reason: verdict.reason }, 402);
        }
        recordBurnReceipt(txHash);
        noteBurn(verdict.payer, Number(FLARE_PRICE_WHOLE), 'flare');
      }
      const flare: Flare = {
        addr, x, y, label,
        ...(color ? { color } : {}),
        atTick: world.tick,
        expires: world.tick + FLARE_LIFE_TICKS,
      };
      flares = [...live, flare];
      saveStore();
      return json({ ok: true, free, flare, index: flares.length - 1 });
    }

    // Remove one of your own flares by its current index in the live list.
    if (req.method === 'DELETE' && path === '/flare') {
      if (foreignOrigin(req)) return json({ error: 'cross-origin flares are not allowed' }, 403);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const addr = String(body.addr ?? '').toLowerCase();
      const index = Number(body.index);
      if (!ADDRESS_RE.test(addr)) return json({ error: 'address required' }, 400);
      if (!Number.isInteger(index) || index < 0) return json({ error: 'index must be a non-negative integer' }, 400);
      if (flares[index] && flares[index].addr === addr) {
        flares = flares.filter((_, i) => i !== index);
        saveStore();
        return json({ ok: true });
      }
      return json({ error: 'no such flare of yours' }, 404);
    }

    if (req.method === 'POST' && path === '/intervene') {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      // Reads are a public data API (CORS *); writes are not.
      if (foreignOrigin(req)) {
        return json({ error: 'cross-origin interventions are not allowed' }, 403);
      }
      const type = body?.type as InterventionType;
      if (!INTERVENTION_TYPES.includes(type)) {
        return json({ error: 'unknown intervention type', types: INTERVENTION_TYPES }, 400);
      }
      // Validate the request fully before touching the payment: a typo in
      // x/y/radius must cost nothing, so the burn receipt is only consumed
      // once we know the intervention can actually be applied.
      // A pass carries no coordinates and never reaches the simulation.
      const isPass = type === 'pass';
      let intervention: Intervention | null = null;
      if (!isPass) {
        const built = buildIntervention(body);
        if ('fail' in built) return json({ error: built.fail }, 400);
        intervention = built.ok;
      }
      // Naming a legend costs ten times the base price, and the sim decides who
      // counts as one. The 402 quotes exactly what will be charged, so the
      // wallet never opens on a number the server is about to disagree with.
      const aimedAt = intervention !== null && 'creatureId' in intervention
        ? findCreature(world, intervention.creatureId)
        : null;
      const legendary = type === 'name' && aimedAt !== null && isLegendary(aimedAt);
      const whole = priceWhole(type, legendary);
      const offer = await burnOffer(rpcUrl, type, options.token, whole);
      if (!offer) {
        return json(
          { error: 'token not deployed', hint: 'set ABYS_TOKEN_ADDRESS to an ERC-20 that answers decimals()' },
          503,
        );
      }
      const txHash = String(req.headers.get('x-payment-tx') ?? body.tx ?? '');
      if (!txHash) {
        return json({ error: 'payment required', accepts: [offer], price: `${whole} ABYS`, legendary }, 402);
      }
      const verdict = await verifyBurnReceipt(rpcUrl, offer, txHash);
      if (!verdict.ok) {
        return json({ error: 'payment required', accepts: [offer], reason: verdict.reason }, 402);
      }
      // The tank kept ticking while that receipt was being verified. A targeted
      // intervention whose subject died in the window must not silently buy
      // nothing: refuse the sale and leave the receipt spendable, so the payer
      // can aim it at somebody still swimming.
      if (intervention !== null && isTargeted(intervention)) {
        const alive = findCreature(world, intervention.creatureId);
        if (alive === null) {
          return json(
            {
              error: 'creature is gone',
              hint: 'the tank moved on while your burn was verified; this receipt was not spent, send it again against a living creature',
              tx: txHash,
              refunded: true,
            },
            409,
          );
        }
        if (type === 'ark' && alive.arkProtected === true) {
          return json(
            {
              error: 'that creature already holds an ark ticket',
              tx: txHash,
              refunded: true,
            },
            409,
          );
        }
      }
      // A pass changes no ecology: grant it and stop, so the burn can never
      // be spent on a simulation action by accident.
      if (type === 'pass') {
        recordBurnReceipt(txHash);
        noteBurn(verdict.payer, Number(whole), 'pass');
        if (verdict.payer) {
          passes.set(verdict.payer, (Math.floor(world.tick / world.config.ticksPerDay) + 1) * world.config.ticksPerDay);
        }
        saveStore();
        return json({
          ok: true,
          receipt: 'pass: day pass active until the day rolls',
          until: verdict.payer ? passes.get(verdict.payer) : null,
        });
      }
      // Non-null here: the pass branch returned above, and every other type
      // passed buildIntervention's validation.
      const applied = applyIntervention(world, intervention as Intervention, {
        payer: verdict.payer,
        paid: `${whole} ABYS`,
        tx: txHash,
      });
      // Record only after the paid action succeeded: a burned receipt that
      // bought nothing must stay spendable.
      recordBurnReceipt(txHash);
      noteBurn(verdict.payer, Number(whole), type);
      if (intervention !== null && (intervention.type === 'feed' || intervention.type === 'poison')) {
        const affectedIds = idsInZone(world, intervention.x, intervention.y, intervention.radius);
        reports.push({
          tx: txHash,
          type,
          payer: verdict.payer,
          paid: `${whole} ABYS`,
          atTick: world.tick,
          affectedIds,
          popAt: world.creatures.length,
        });
        if (reports.length > 40) reports.splice(0, reports.length - 40);
        const p = verdict.payer ? burners.get(verdict.payer) : undefined;
        if (p) p.maxAffected = Math.max(p.maxAffected, affectedIds.length);
      }
      // A wish is the only paid action that falls out of the sky, so it joins
      // the meteor rain every viewer is already rendering — carrying the words
      // and the address that paid for them.
      if (intervention !== null && intervention.type === 'wish' && applied.at) {
        txRain.push({
          hash: applied.hash ?? txHash,
          size: WISH_METEOR_SIZE,
          x: applied.at.x,
          y: applied.at.y,
          wish: { message: intervention.message, addr: verdict.payer ?? '' },
        });
        if (txRain.length > 12) txRain = txRain.slice(-12);
      }
      saveStore();
      return json({
        ok: true,
        receipt: applied.message,
        affected: applied.affected,
        amount: applied.amount,
        tick: world.tick,
        price: `${whole} ABYS`,
        legendary,
        at: applied.at ?? null,
        settlement: { tx: txHash, payer: verdict.payer, burned: offer.amount, network: offer.network },
      });
    }

    if (req.method === 'GET' && options.static) {
      const res = await options.static(path, req.headers);
      if (res) return res;
    }

    return json({ error: 'not found' }, 404);
  }

  let hydrated: Promise<void> | null = null;
  function hydrate(): Promise<void> {
    hydrated ??= (async () => {
      await hydrateReceipts();
      if (!options.store) return;
      const s = await options.store.load();
      for (const [addr, until] of s.passes ?? []) passes.set(addr, until);
      for (const [addr, b] of s.burners ?? []) burners.set(addr, normalizeProfile(b));
      for (const [addr, ids] of s.adoptions ?? []) adoptions.set(addr, ids.filter((n) => Number.isInteger(n)));
      if (Array.isArray(s.flares)) flares = s.flares.filter((f) => f && typeof f.expires === 'number');
      if (s.fossils) {
        for (const cat of Object.keys(fossils) as FossilCategory[]) {
          const rows = s.fossils[cat];
          if (Array.isArray(rows)) fossils[cat] = rows.slice(0, FOSSILS_PER_CATEGORY);
        }
      }
      // Take the stored clock only when it is older than this isolate's own.
      // On a cold boot the local value is `Date.now()`, so the stored one wins
      // and the idle gap becomes owed ticks; on a warm isolate the local value
      // is more recent and must not be dragged backwards, and a clock from an
      // isolate whose wall time ran ahead is ignored for the same reason.
      if (typeof s.lastAdvanceAt === 'number' && s.lastAdvanceAt < lastAdvanceAt) {
        lastAdvanceAt = s.lastAdvanceAt;
      }
      // Restore the feed here rather than at first use. On the cron path this
      // runs from inside `warmFeed()`, and that ordering is load-bearing:
      // `settle()` starts a poll on a cold feed, and a poll that runs before the
      // stored block is back in place is a poll that backfills from -1 — the
      // exact work the persisted state exists to skip.
      if (s.feedState) chainFeed.importState?.(s.feedState);
    })();
    return hydrated;
  }
  function saveStore(): void {
    options.store?.save({
      passes: [...passes.entries()],
      burners: [...burners.entries()],
      adoptions: [...adoptions.entries()],
      flares,
      fossils,
      lastAdvanceAt,
      feedState: chainFeed.exportState?.(),
    });
  }

  return {
    hydrate,
    fetch: async (req: Request) => {
      await hydrate();
      return fetch(req);
    },
    world,
    /**
     * Advance the world to wall-clock now for runtimes that cannot hold a
     * 250ms interval (a Worker isolate sleeps between requests). The chain is
     * sampled once and the elapsed ticks are replayed with it, capped so a
     * long idle gap cannot stall a request.
     *
     * Hydration comes first and is not optional: the owed ticks are measured
     * against the persisted `lastAdvanceAt`, and this runs before `fetch()` —
     * which is where hydration used to happen — so a cold isolate would
     * otherwise always find zero elapsed and never move the world at all.
     */
    async catchUp(maxTicks = 240): Promise<number> {
      await hydrate();
      const elapsed = Math.min(maxTicks, Math.floor((Date.now() - lastAdvanceAt) / 250));
      if (elapsed <= 0) return 0;
      await advance();
      // `advance()` sampled the chain once and drained a single tick's worth of
      // meteors, but the replay below covers a whole interval of real chain
      // time. Replaying it with nothing falling would starve the one food source
      // that carries provenance, and dumping the interval's entire fall into the
      // first tick would blow straight past the 260-pellet ceiling and waste
      // most of it. So drain the interval's budget here — 6 a tick, the density
      // the 250ms loop produces — and deal it out across the replay, which is
      // the spread that loop would have made in real time.
      const backlog = chainFeed.recentTxs(6 * (elapsed - 1));
      markWhales(backlog);
      for (let i = 1, at = 0; i < elapsed; i++, at += 6) {
        const chunk = at < backlog.length ? backlog.slice(at, at + 6) : [];
        tickWorld(world, { chain: chainTemp, market: marketTemp }, chunk);
        if (chunk.length > 0) noteMeteors(chunk);
      }
      // Persist the clock alongside the world. This write lands before the
      // caller's world snapshot, so a crash in between leaves the tank short a
      // few ticks rather than replaying ones it already lived — the safe
      // direction, since a replay would run culls and predations twice.
      saveStore();
      return elapsed;
    },
    /**
     * Let the chain feed finish the poll `advance()` started but deliberately
     * did not await. Meaningful only on a runtime that tears the isolate down
     * between requests: there an un-awaited backfill is cancelled before it
     * completes, the feed is rebuilt cold on the next request, and the tank runs
     * forever on initializer temperatures with no transfer ever raining. The
     * cron handler calls this because it has nobody waiting on it, which makes
     * it the feed's heartbeat.
     *
     * Hydration is first and not optional, for the same reason it is in
     * `catchUp()`: this is the cron's opening move, `settle()` starts a poll on
     * a feed that has never landed one, and a poll that runs before the stored
     * block is restored backfills 3600 blocks from -1. The persisted feed state
     * would then be written back having bought nothing.
     */
    async warmFeed(): Promise<void> {
      await hydrate();
      await chainFeed.settle?.();
    },
    start(ms = 250): void {
      if (timer) return;
      timer = setInterval(() => {
        void advance().catch(() => undefined);
      }, ms);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
