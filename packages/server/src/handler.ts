import {
  applyIntervention,
  idsInZone,
  createWorld,
  DEFAULT_CONFIG,
  fromJSON,
  dominantTax,
  genomeFingerprint,
  isHungry,
  tick as tickWorld,
  txLanding,
  WHALE_BOOM_SIZE,
  ARCHETYPE_LIST,
  type Archetype,
  type Intervention,
  type World,
} from '@abyssal/sim';
import { ArcUsdcFeed, ARC_USDC_ADDRESS, whalePosition } from './arc.js';
import { SyntheticFeed, type ChainFeed } from './chain.js';
import { SyntheticMarketFeed, type MarketFeed } from './market.js';
import {
  ABYS_PRICES,
  burnOffer,
  hydrateReceipts,
  recordBurnReceipt,
  CHAIN_ID,
  explorerTxUrl,
  NETWORK,
  tokenAddress,
  verifyBurnReceipt,
  type InterventionType,
} from './payments.js';

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

export interface WorldStore {
  load(): Promise<{ passes?: [string, number][]; burners?: [string, Partial<BurnerProfile>][] }>;
  save(s: { passes: [string, number][]; burners: [string, BurnerProfile][] }): void;
}

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

const INTERVENTION_TYPES: InterventionType[] = ['feed', 'poison', 'bloom', 'drought', 'pass'];

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
  }[] = [];

  async function advance(): Promise<void> {
    const useLive = arcFeed !== null;
    const [c, m] = await Promise.all([chainFeed.sample(), marketFeed.sample()]);
    const failures = arcFeed ? arcFeed.consecutiveFailures : 0;
    let sample = c;
    let txs;
    if (useLive && failures >= 5) {
      // RPC is down: degrade to the synthetic feed until it recovers.
      feedStatus = 'degraded';
      sample = await fallbackFeed.sample();
      txs = fallbackFeed.recentTxs();
    } else {
      feedStatus = useLive ? 'live' : 'synthetic';
      txs = chainFeed.recentTxs();
    }
    chainTemp = sample.temp;
    chainDelta = sample.delta;
    marketTemp = m.temp;
    blockNumber = sample.blockNumber;
    // A resident whale's own transfer rains at the whale instead of at its
    // hash coordinate, so the money it moves feeds the water it is swimming
    // through and the tank converges on it.
    if (arcFeed) {
      const whales = arcFeed.whaleIndex();
      if (whales.size > 0) {
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
    }
    tickWorld(world, { chain: sample.temp, market: m.temp }, txs);
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
    scoreReports();
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

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      },
    });
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
        .map((c) => ({ id: c.id, name: c.name, archetype: c.archetype, value: Math.round(key(c)) }));
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
        id: c.id, name: c.name, archetype: c.archetype, value: Math.round(c.energy),
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
      network: NETWORK,
      chainId: CHAIN_ID,
      instance: options.instance ?? instanceId,
      prices: ABYS_PRICES,
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
        strongest: strongest ? { id: strongest.id, name: strongest.name, kills: strongest.kills } : null,
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

  function worldPayload() {
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
        name: c.name,
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
      })),
      foods: world.foods.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) })),
    };
  }

  function buildIntervention(body: Record<string, unknown>): Intervention | null {
    const type = body.type as InterventionType;
    if (type === 'bloom' || type === 'drought') {
      return { type };
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
        return null;
      }
      return { type, x, y, radius };
    }
    return null;
  }

  function apiIndex() {
    return {
      name: 'abyssal-server',
      chain: { network: NETWORK, chainId: CHAIN_ID, asset: 'ABYSSAL' },
      endpoints: {
        'GET /': 'web frontend',
        'GET /api': 'this endpoint index',
        'GET /state': 'tick, day, population, chain + market temperature, harvest/judgment countdowns',
        'GET /world': 'render snapshot: creatures (with archetype), foods, world size',
        'GET /snapshot': 'combined world + state + events for single-request polling: ?since=<seq>, ?tail=<n> caps the event replay, ?tx=<hash> returns only newer meteors',
        'GET /history': 'recent per-tick stats (incl. per-archetype population) for charts: ?window=<n> sets the depth, ?slots=<n> decimates server-side',
        'GET /judgments': 'cull records (harvest + judgment), filter with ?type=harvest|judgment',
        'GET /events': 'positioned event stream for visualization, poll with ?since=<seq>',
        'GET /reports': 'battle reports for paid interventions, scored 400 ticks after the burn',
        'GET /who': 'one address in the tank: ?addr=<0x..> returns burns, badges, pass, rank and its battle reports',
        'POST /cheer': 'rally for a species: {addr, species}, free, one vote per known address',
        'GET /export': 'day-pass download of the observation window: ?pass=<address>&kind=csv|replay|digest',
        'GET /observe': 'Arc USDC flow observatory: stats, endpoint ranking, pulse, recent flows (available:false off-Arc)',
        'POST /intervene': 'intervention (feed/poison/bloom/drought) paid by burning ABYS on Arc; the burn receipt is the payment proof; 503 until ABYS_TOKEN_ADDRESS is set',
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
          'access-control-allow-methods': 'GET,POST,OPTIONS',
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

    if (req.method === 'GET' && path === '/state') return json(statePayload());
    if (req.method === 'GET' && path === '/world') return json(worldPayload());

    if (req.method === 'GET' && path === '/history') {
      // The charts draw CHART_SLOTS points and decimate whatever they receive,
      // so shipping the full window meant sending ~10x more JSON than any pixel
      // on screen could show. `?slots=` moves that decimation here.
      const window = Math.min(positiveInt(url.searchParams.get('window'), HISTORY_WINDOW_MAX), HISTORY_WINDOW_MAX);
      const slots = Math.min(positiveInt(url.searchParams.get('slots'), 0), window);
      const stats = world.statsLog.slice(-window);
      return json({ stats: slots > 0 ? decimate(stats, slots) : stats });
    }

    if (req.method === 'GET' && path === '/judgments') {
      const type = url.searchParams.get('type');
      const culls = type ? world.culls.filter((c) => c.type === type) : world.culls;
      return json({ judgments: culls });
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
      });
    }

    if (req.method === 'GET' && path === '/reports') {
      scoreReports();
      return json({ reports: reports.slice(-12).reverse() });
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
      if (!arcFeed) return json({ available: false });
      const addr = url.searchParams.get('addr');
      if (addr) return json({ available: true, ...arcFeed.addressPayload(addr) });
      return json({ available: true, ...arcFeed.observePayload() });
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
      const intervention = isPass ? null : buildIntervention(body);
      if (!isPass && !intervention) {
        return json({ error: 'invalid intervention params (need x, y, radius 10..300 inside the world)' }, 400);
      }
      const offer = await burnOffer(rpcUrl, type, options.token);
      if (!offer) {
        return json(
          { error: 'token not deployed', hint: 'set ABYS_TOKEN_ADDRESS to an ERC-20 that answers decimals()' },
          503,
        );
      }
      const txHash = String(req.headers.get('x-payment-tx') ?? body.tx ?? '');
      if (!txHash) {
        return json({ error: 'payment required', accepts: [offer] }, 402);
      }
      const verdict = await verifyBurnReceipt(rpcUrl, offer, txHash);
      if (!verdict.ok) {
        return json({ error: 'payment required', accepts: [offer], reason: verdict.reason }, 402);
      }
      // A pass changes no ecology: grant it and stop, so the burn can never
      // be spent on a simulation action by accident.
      if (type === 'pass') {
        recordBurnReceipt(txHash);
        noteBurn(verdict.payer, Number(ABYS_PRICES.pass), 'pass');
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
      const result = applyIntervention(world, intervention as NonNullable<typeof intervention>, {
        payer: verdict.payer,
        paid: `${ABYS_PRICES[type]} ABYS`,
        tx: txHash,
      });
      // Record only after the paid action succeeded: a burned receipt that
      // bought nothing must stay spendable.
      recordBurnReceipt(txHash);
      noteBurn(verdict.payer, Number(ABYS_PRICES[type]), type);
      if (intervention && 'x' in intervention) {
        const affectedIds = idsInZone(world, intervention.x, intervention.y, intervention.radius);
        reports.push({
          tx: txHash,
          type,
          payer: verdict.payer,
          paid: `${ABYS_PRICES[type]} ABYS`,
          atTick: world.tick,
          affectedIds,
          popAt: world.creatures.length,
        });
        if (reports.length > 40) reports.splice(0, reports.length - 40);
        const p = verdict.payer ? burners.get(verdict.payer) : undefined;
        if (p) p.maxAffected = Math.max(p.maxAffected, affectedIds.length);
      }
      saveStore();
      return json({
        ok: true,
        receipt: result.message,
        affected: result.affected,
        amount: result.amount,
        tick: world.tick,
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
    })();
    return hydrated;
  }
  function saveStore(): void {
    options.store?.save({
      passes: [...passes.entries()],
      burners: [...burners.entries()],
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
     */
    async catchUp(maxTicks = 240): Promise<number> {
      const elapsed = Math.min(maxTicks, Math.floor((Date.now() - lastAdvanceAt) / 250));
      if (elapsed <= 0) return 0;
      await advance();
      for (let i = 1; i < elapsed; i++) {
        tickWorld(world, { chain: chainTemp, market: marketTemp }, []);
      }
      return elapsed;
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
