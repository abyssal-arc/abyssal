import {
  applyIntervention,
  createWorld,
  DEFAULT_CONFIG,
  fromJSON,
  genomeFingerprint,
  tick as tickWorld,
  txLanding,
  WHALE_BOOM_SIZE,
  type Intervention,
  type World,
} from '@abyssal/sim';
import { ArcUsdcFeed, ARC_USDC_ADDRESS, whalePosition } from './arc.js';
import { SyntheticFeed, type ChainFeed } from './chain.js';
import { SyntheticMarketFeed, type MarketFeed } from './market.js';
import {
  acceptsFor,
  ABYS_PRICES,
  CHAIN_ID,
  explorerTxUrl,
  NETWORK,
  PRICES_USDC,
  SimulatedVerifier,
  type InterventionType,
  type PaymentVerifier,
} from './payments.js';
import {
  exactRequirement,
  facilitatorConfig,
  settleFromRequest,
  type Settlement,
} from './facilitator.js';
import { serveStatic } from './static.js';

export interface AppOptions {
  seed?: number;
  webRoot?: string;
  /** Serialized world snapshot (sim `toJSON`) to resume instead of seeding a fresh world. */
  snapshot?: string;
  chainFeed?: ChainFeed;
  marketFeed?: MarketFeed;
  verifier?: PaymentVerifier;
}

const INTERVENTION_TYPES: InterventionType[] = ['feed', 'poison', 'bloom', 'drought'];

function defaultChainFeedFromEnv(): ChainFeed {
  // Arc is the product; the offline rain is an explicit opt-out for working
  // without network (and for hermetic tests), not the default.
  if (process.env.CHAIN_FEED === 'synthetic') return new SyntheticFeed();
  const url = process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io';
  return new ArcUsdcFeed(url, process.env.ARC_USDC_ADDRESS ?? ARC_USDC_ADDRESS);
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
  const chainFeed: ChainFeed = options.chainFeed ?? defaultChainFeedFromEnv();
  /** Non-null when running against Arc: powers /observe and the market feed. */
  const arcFeed = chainFeed instanceof ArcUsdcFeed ? chainFeed : null;
  const marketFeed: MarketFeed =
    options.marketFeed ??
    (arcFeed
      ? { name: 'arc-usdc-flow', sample: async () => arcFeed.market() }
      : new SyntheticMarketFeed());
  const verifier: PaymentVerifier = options.verifier ?? new SimulatedVerifier();
  // Real x402 settlement (Circle Facilitator Service) on Arc when a seller
  // key is configured; null keeps the demo verifier path.
  const fac = facilitatorConfig();
  let timer: ReturnType<typeof setInterval> | null = null;
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
      })),
      totals: { born: world.totalBorn, died: world.totalDied, predations: world.totalPredations },
      network: NETWORK,
      chainId: CHAIN_ID,
      prices: ABYS_PRICES,
      pricesUsdc: PRICES_USDC,
      paymentAsset: 'ABYSSAL',
      // How POST /intervene is paid right now: real x402 settlement through
      // Circle's Facilitator Service when a seller key is configured, demo
      // header otherwise. The UI badges the intervention panel with this.
      payment: fac
        ? { mode: 'x402', network: fac.network, payTo: fac.payTo, trial: fac.chainId !== 5042 }
        : { mode: 'demo', network: null, payTo: null, trial: false },
    };
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
        'GET /observe': 'Arc USDC flow observatory: stats, endpoint ranking, pulse, recent flows (available:false off-Arc)',
        'POST /intervene': 'x402-gated intervention (feed/poison/bloom/drought): live USDC on Arc via Circle Facilitator Service when configured, demo header otherwise',
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
          'access-control-allow-headers': 'content-type,x-payment-demo,x-payment,x-payment-tx',
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
      if (options.webRoot) {
        const res = await serveStatic(options.webRoot, '/index.html', req.headers);
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
      const events = world.eventLog.filter((e) => e.seq > since);
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

    if (req.method === 'GET' && path === '/observe') {
      if (!arcFeed) return json({ available: false });
      const addr = url.searchParams.get('addr');
      if (addr) return json({ available: true, ...arcFeed.addressPayload(addr) });
      return json({ available: true, ...arcFeed.observePayload() });
    }

    if (req.method === 'POST' && path === '/tick') {
      await advance();
      return json({ ok: true, tick: world.tick });
    }

    if (req.method === 'POST' && path === '/intervene') {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const type = body?.type as InterventionType;
      if (!INTERVENTION_TYPES.includes(type)) {
        return json({ error: 'unknown intervention type', types: INTERVENTION_TYPES }, 400);
      }
      // Live mode advertises the x402-spec USDC offer settled by Circle;
      // demo mode keeps the legacy ABYSSAL/USDC accept list.
      const exactOffer = fac ? exactRequirement(fac, PRICES_USDC[type]) : null;
      const accepts = exactOffer ? [exactOffer] : acceptsFor(type);
      let settlement: Settlement | null = null;
      const paid = fac && exactOffer
        ? (settlement = await settleFromRequest(req, fac, exactOffer)).ok
        : await verifier.verify(req, acceptsFor(type)[0]);
      if (!paid) {
        return json({
          error: 'payment required',
          accepts,
          demo: !fac,
          reason: settlement?.reason,
        }, 402);
      }
      const intervention = buildIntervention(body);
      if (!intervention) {
        return json({ error: 'invalid intervention params (need x, y, radius 10..300 inside the world)' }, 400);
      }
      const result = applyIntervention(world, intervention);
      return json({
        ok: true,
        receipt: result.message,
        affected: result.affected,
        amount: result.amount,
        tick: world.tick,
        settlement: settlement
          ? { tx: settlement.tx, payer: settlement.payer, network: fac?.network }
          : null,
      });
    }

    if (req.method === 'GET' && options.webRoot) {
      const res = await serveStatic(options.webRoot, path, req.headers);
      if (res) return res;
    }

    return json({ error: 'not found' }, 404);
  }

  return {
    fetch,
    world,
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
