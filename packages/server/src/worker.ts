/**
 * Cloudflare Worker entry: the whole observatory lives in one Durable Object
 * so the ecosystem keeps a single world across isolates. Static files are
 * served by Workers Static Assets; every other path is API and routes to the
 * object.
 *
 * Time only moves when something calls into the object, so the Cron Trigger
 * declared in wrangler.toml is what keeps the tank alive with zero viewers.
 * Cron Triggers invoke `scheduled`, not `fetch` — without the handler below
 * the schedule fires every minute into nothing and the world advances only
 * while somebody happens to be watching.
 *
 * The same is true of the chain feed, and for a second reason: `sample()` starts
 * its RPC poll without awaiting it, and an invocation ends when its response is
 * sent, so an un-awaited poll is cancelled before it can finish. The cron is the
 * one caller with nobody waiting on it, which makes it the feed's heartbeat.
 */
import { createApp, type WorldStore, type LedgerLoad } from './handler.js';
import { setBurnLedger } from './payments.js';
import { toJSON } from '@abyssal/sim';

interface DoStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface DoCtx {
  storage: DoStorage;
  /** Keeps a promise alive past the response, instead of it being cancelled. */
  waitUntil(promise: Promise<unknown>): void;
}

interface DoBinding {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface Env {
  WORLD: DoBinding;
  ABYS_TOKEN_ADDRESS?: string;
  /** Set with `wrangler secret put ARC_RPC_URL`, so it never enters the repo. */
  ARC_RPC_URL?: string;
}

const SNAP_KEY = 'world';
const INSTANCE_KEY = 'instance';
const SAVE_EVERY_MS = 30_000;
/** Internal path the cron handler pokes; never linked, never served to a viewer. */
const CRON_PATH = '/__cron';

export class AbyssalWorld {
  private app: ReturnType<typeof createApp> | null = null;
  private lastSave = 0;

  private receipts: string[] | null = null;
  private ledgerState: LedgerLoad | null = null;

  // Durable Objects receive their bindings through the constructor, not fetch.
  constructor(private ctx: DoCtx, private env: Env) {
    // Receipts and passes live in this object's storage, so an isolate restart
    // cannot replay a burn or drop a day pass.
    setBurnLedger({
      load: async () => (await this.state0()).receipts,
      add: (hash: string) => {
        void this.state0().then((s) => {
          s.receipts.push(hash);
          return this.ctx.storage.put('receipts', s.receipts);
        });
      },
    });
  }

  private async state0() {
    if (this.receipts === null) {
      this.receipts = (await this.ctx.storage.get<string[]>('receipts')) ?? [];
      this.ledgerState =
        (await this.ctx.storage.get<LedgerLoad>('ledger')) ??
        { passes: [], burners: [] };
    }
    return { receipts: this.receipts, ledger: this.ledgerState! };
  }

  private store(): WorldStore {
    return {
      load: async () => (await this.state0()).ledger,
      save: (s) => {
        this.ledgerState = s;
        void this.ctx.storage.put('ledger', s);
      },
    };
  }

  private async boot(): Promise<ReturnType<typeof createApp>> {
    if (!this.app) {
      const snapshot = await this.ctx.storage.get<string>(SNAP_KEY);
      let instance = await this.ctx.storage.get<string>(INSTANCE_KEY);
      if (!instance) {
        instance = crypto.randomUUID();
        await this.ctx.storage.put(INSTANCE_KEY, instance);
      }
      this.app = createApp({
        snapshot: snapshot ?? undefined,
        instance,
        token: this.env.ABYS_TOKEN_ADDRESS,
        rpc: this.env.ARC_RPC_URL,
        store: this.store(),
      });
    }
    return this.app;
  }

  private async persist(app: ReturnType<typeof createApp>): Promise<void> {
    const now = Date.now();
    if (now - this.lastSave < SAVE_EVERY_MS) return;
    this.lastSave = now;
    await this.ctx.storage.put(SNAP_KEY, toJSON(app.world));
  }

  async fetch(request: Request): Promise<Response> {
    const app = await this.boot();
    const isCron = new URL(request.url).pathname === CRON_PATH;
    if (isCron) {
      // Block until the chain poll completes. This is the one caller with nobody
      // waiting on it, and it is the difference between a feed that warms up and
      // one that is cancelled mid-backfill on every single request and therefore
      // reports its initializer temperatures forever.
      await app.warmFeed();
    } else {
      // A viewer must not wait on the RPC, but the poll its request kicked off
      // must not be cancelled along with the response either.
      this.ctx.waitUntil(app.warmFeed());
    }
    const advanced = await app.catchUp();
    // The cron poke. Saving unconditionally matters here: this may be the only
    // call the object gets all minute, and an unvisited tank that does not
    // persist is a tank that rewinds to wherever its last viewer left it.
    // The guard is what keeps that from becoming a write amplifier — the path
    // is reachable from outside, and a caller hammering it faster than the tick
    // advances would otherwise turn every hit into a storage put. The real cron
    // arrives once a minute with ~240 ticks owed, so it always passes.
    if (isCron) {
      if (advanced > 0) {
        this.lastSave = 0;
        await this.persist(app);
      }
      return new Response(
        JSON.stringify({ ok: true, advanced, tick: app.world.tick }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    const response = await app.fetch(request);
    await this.persist(app);
    return response;
  }
}

interface ScheduledCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.WORLD.idFromName('abyssal');
    return env.WORLD.get(id).fetch(request);
  },

  /**
   * One cron per minute keeps the ecosystem alive with no viewers. A Durable
   * Object stub exposes nothing but `fetch`, so the poke is an internal
   * request rather than a method call, and `waitUntil` keeps that subrequest
   * alive past this handler's return instead of racing the invocation teardown.
   */
  async scheduled(_event: unknown, env: Env, ctx: ScheduledCtx): Promise<void> {
    const id = env.WORLD.idFromName('abyssal');
    ctx.waitUntil(
      env.WORLD.get(id).fetch(new Request(`https://abyssal.internal${CRON_PATH}`)),
    );
  },
};
