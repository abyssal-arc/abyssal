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
import { toJSON, SNAPSHOT_BUDGET, DO_VALUE_LIMIT } from '@abyssal/sim';

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

/**
 * Whether a snapshot has just crossed the budget line, and whether that is news.
 *
 * Extracted and exported because no world built by legal means can reach it: the
 * sim's caps, every one of them full, come to about 1.15 MiB, and the line is at
 * 1.5 MiB on purpose — a budget that worst case already violates would warn on
 * every save and then be ignored. So the only honest way to test this state
 * machine is to hand it the numbers directly. Crossing up announces once,
 * staying over does not repeat, and dropping back re-arms it.
 */
export function budgetCrossed(
  bytes: number,
  wasOver: boolean,
  budget: number = SNAPSHOT_BUDGET,
): { over: boolean; announce: boolean } {
  const over = bytes > budget;
  return { over, announce: over && !wasOver };
}
/** Internal path the cron handler pokes; never linked, never served to a viewer. */
const CRON_PATH = '/__cron';

export class AbyssalWorld {
  private app: ReturnType<typeof createApp> | null = null;
  private lastSave = 0;
  // Edge-trigger for the budget warning, so a world sitting just over the line
  // says so once rather than every 30 seconds.
  private overBudget = false;

  private receipts: string[] | null = null;
  private ledgerState: LedgerLoad | null = null;

  // Durable Objects receive their bindings through the constructor, not fetch.
  constructor(private ctx: DoCtx, private env: Env) {
    // Receipts and passes live in this object's storage, so an isolate restart
    // cannot replay a burn or drop a day pass.
    setBurnLedger({
      load: async () => (await this.state0()).receipts,
      add: (hash: string) => {
        void this.state0()
          .then((s) => {
            s.receipts.push(hash);
            return this.ctx.storage.put('receipts', s.receipts);
          })
          .catch((err: unknown) => {
            // Of the two writes this file fires without awaiting, this is the one
            // that deserves a shout. The receipt is already in the in-memory set,
            // so the duplicate is refused for as long as this isolate lives and
            // accepted again the moment it does not: a failure nobody sees here
            // is a burn that has quietly become spendable a second time, and the
            // evidence for that is a single line in a log nobody reads.
            console.error('burn receipt not stored: this burn can be replayed after an eviction', err);
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
        // `save` is synchronous in the world's interface — the sim calls it and
        // moves on — so this write cannot be awaited without redesigning that
        // boundary. Unawaited is not the same as unanswerable: a `void` promise
        // that rejects becomes an unhandled rejection inside the object, which
        // surfaces as a platform error naming no file, line or value. Caught
        // here so the log says which write broke and what was riding on it.
        //
        // No byte count is reported, deliberately. The snapshot next door is
        // stored as a string, so its encoded size is comparable against the
        // per-value limit; this one goes in as an object and Cloudflare sizes it
        // with a serializer we cannot invoke. Printing `JSON.stringify(s).length`
        // and calling it the stored size would be a number that is neither the
        // bytes on the wire nor a bound on them.
        void this.ctx.storage.put('ledger', s).catch((err: unknown) => {
          // What an eviction now loses: the feed cursor (so blocks already
          // counted get re-read), the day passes, and who burned what.
          console.error('world ledger not stored: passes, burners and the feed cursor are memory-only', err);
        });
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
    const snapshot = toJSON(app.world);
    // Sized on every save, before the write, because the number is worth
    // nothing if it can only be read after the damage.
    //
    // Encoded rather than taking `snapshot.length`, since the limit this gets
    // compared against is in bytes and a string length is in UTF-16 code units.
    // Nearly all of a snapshot is hex and digits, where the two agree — but
    // creature names are bought by users, and the sanitizer caps them at 24
    // characters without restricting them to ASCII, so an emoji is four bytes
    // under a length of two. Everything downstream of here reports against a
    // 2 MB byte ceiling, so this measures in bytes. The cost is one pass over a
    // string `toJSON` has already built, once every 30 seconds.
    const bytes = new TextEncoder().encode(snapshot).byteLength;
    const { over, announce } = budgetCrossed(bytes, this.overBudget);
    this.overBudget = over;
    if (announce) {
      // The alarm line is the budget the sim's caps are sized against, so
      // crossing it means a collection outgrew its intended ceiling while the
      // save still works — which is the moment this is worth saying something.
      // Being straight about the lead time: this buys roughly half a megabyte
      // of warning, and an unbounded map can cross that between two saves. It
      // is not a guarantee of advance notice. What it does guarantee is that
      // the first signal of the next growth bug is a line that says a budget
      // was exceeded, instead of an HTTP 500 that says nothing.
      console.warn(
        `world snapshot past budget: ${bytes} of ${DO_VALUE_LIMIT} bytes `
        + `(${Math.round((bytes / DO_VALUE_LIMIT) * 100)}% of one storage value)`,
      );
    }
    try {
      await this.ctx.storage.put(SNAP_KEY, snapshot);
    } catch (err) {
      // A failed save must not take the response down with it. The caller asked
      // to look at the tank, not to write it, and this is awaited on the request
      // path — so an oversized snapshot turned every save into an HTTP 500 and
      // the cron into an exception, once a minute, for as long as the value
      // stayed too big. Logged rather than swallowed: the quiet version of this
      // failure is a tank that stops being saved altogether, comes back from
      // whatever its last successful write happened to hold, and says so
      // nowhere.
      console.error(`world snapshot not saved: ${bytes} bytes`, err);
    }
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
