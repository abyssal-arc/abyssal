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
import { createHealth, budgetCrossed, receiptsValueBytes, type HealthView } from './health.js';
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
  /**
   * The day-anchor signer, set with `wrangler secret put ARC_DIGEST_KEY`.
   *
   * It has to travel as a binding rather than be read off `process.env`, which
   * is what the handler used to do: this Worker asks for no `nodejs_compat`
   * flag, and a runtime that is not told to provide node globals may provide no
   * `process` at all (measured locally — see `readEnv` in handler.ts). A secret
   * that silently reads as absent is the worst failure shape available here,
   * because the digest then reports `unconfigured` forever and looks like a
   * choice rather than a typo in a dashboard.
   */
  ARC_DIGEST_KEY?: string;
  /**
   * The data tier's USDC seller key, set with `wrangler secret put
   * SELLER_PRIVATE_KEY`. Until it is set, `GET /data/flows` answers 503 rather
   * than quoting a price nothing can settle — the same arrangement as the anchor
   * key above, and for the reason written there.
   */
  SELLER_PRIVATE_KEY?: string;
  /** `1` settles the data tier on the keyless Arc testnet trial. */
  X402_TESTNET?: string;
  /** Where data-tier USDC goes; defaults to the seller key's own address. */
  SELLER_PAY_TO?: string;
  /** Facilitator override, so a staging deploy can point at a stub. */
  FACILITATOR_URL?: string;
}

const SNAP_KEY = 'world';
const INSTANCE_KEY = 'instance';
/**
 * The signal counters, in their own value.
 *
 * They cannot ride along inside the ledger or the snapshot, which is where the
 * intuition points: those are exactly the two writes this record exists to
 * report failing. A counter that lives in the thing it is watching goes silent
 * at the moment it has something to say.
 */
const HEALTH_KEY = 'health';
const SAVE_EVERY_MS = 30_000;

/** Internal path the cron handler pokes; never linked, never served to a viewer. */
const CRON_PATH = '/__cron';

export class AbyssalWorld {
  private app: ReturnType<typeof createApp> | null = null;
  private lastSave = 0;
  // Edge-trigger for the budget warning, so a world sitting just over the line
  // says so once rather than every 30 seconds.
  private overBudget = false;
  // The receipts array has its own copy of that edge state, because it has its
  // own ceiling: one storage value, grown by one entry per burn, and until now
  // watched by nothing.
  private receiptsOver = false;

  // Written after every attempted save, including the one that throws, so the
  // number that matters is the one that survives the failure it describes.
  private lastSnapshotBytes: number | null = null;

  private health = createHealth(Date.now(), (v) => this.saveHealth(v));

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
            // The receipts array is one storage value like the snapshot is, and
            // it is append-only by design: dropping an entry to make room is
            // dropping a replay guard. So its ceiling is reached monotonically,
            // one burn at a time, at roughly 30k entries — and nothing watched.
            // This is that watch, on the same edge trigger the snapshot uses.
            const receiptsBytes = receiptsValueBytes(s.receipts.length);
            const receiptsCrossed = budgetCrossed(receiptsBytes, this.receiptsOver);
            this.receiptsOver = receiptsCrossed.over;
            if (receiptsCrossed.announce) {
              this.health.note('receipts_past_budget');
              console.warn(
                `burn receipts past budget: ${s.receipts.length} receipts, ~${receiptsBytes} of `
                + `${DO_VALUE_LIMIT} bytes in one value; the next burn may not be stored at all`,
              );
            }
            return this.ctx.storage.put('receipts', s.receipts);
          })
          .catch((err: unknown) => {
            // Of the two writes this file fires without awaiting, this is the one
            // that deserves a shout. The receipt is already in the in-memory set,
            // so the duplicate is refused for as long as this isolate lives and
            // accepted again the moment it does not: a failure nobody sees here
            // is a burn that has quietly become spendable a second time, and the
            // evidence for that is a single line in a log nobody reads.
            this.health.note('receipt_not_stored', err);
            console.error('burn receipt not stored: this burn can be replayed after an eviction', err);
          });
      },
    });
  }

  /**
   * Persist the counters. Fired from `note`, so it runs when something has gone
   * wrong and at no other time.
   *
   * Its own failure is printed and not counted: the ledger has no kind to file
   * "the thing that counts failures failed" under without recursing, and a
   * counter that cannot be stored is already, by construction, a counter whose
   * last known value is the one still on disk.
   */
  private saveHealth(view: HealthView): void {
    this.ctx.waitUntil(
      this.ctx.storage.put(HEALTH_KEY, view).catch((err: unknown) => {
        console.error('health counters not stored: /health will report a stale history after an eviction', err);
      }),
    );
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
        // bytes on the wire nor a bound on them. The day book inside this object
        // is sized anyway, one field at a time, in `measureDayBook` — which is the
        // measurement `census_past_budget` is raised from, and the reason that alarm
        // speaks of a share of the budget rather than of the value's encoded size.
        void this.ctx.storage.put('ledger', s).catch((err: unknown) => {
          // What an eviction now loses: the feed cursor (so blocks already
          // counted get re-read), the day passes, and who burned what.
          this.health.note('ledger_not_stored', err);
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
      // Counters outlive the isolate that recorded them, but only if they are
      // read back: an isolate that starts at zero is an isolate that reports a
      // clean bill of health over a tank whose receipts have been memory-only
      // for a week. `merge` takes the max of each count, so the order of this
      // call relative to any early `note` does not matter.
      this.health.merge(await this.ctx.storage.get<HealthView>(HEALTH_KEY));
      this.app = createApp({
        snapshot: snapshot ?? undefined,
        instance,
        token: this.env.ABYS_TOKEN_ADDRESS,
        rpc: this.env.ARC_RPC_URL,
        digestKey: this.env.ARC_DIGEST_KEY,
        sellerKey: this.env.SELLER_PRIVATE_KEY,
        x402Testnet: this.env.X402_TESTNET,
        sellerPayTo: this.env.SELLER_PAY_TO,
        facilitatorUrl: this.env.FACILITATOR_URL,
        store: this.store(),
        health: this.health,
        metrics: () => ({
          snapshotBytes: this.lastSnapshotBytes,
          overBudget: this.overBudget,
          receipts: this.receipts?.length ?? null,
          receiptsBytes: this.receipts === null ? null : receiptsValueBytes(this.receipts.length),
          receiptsOver: this.receiptsOver,
          budget: SNAPSHOT_BUDGET,
          limit: DO_VALUE_LIMIT,
        }),
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
    this.lastSnapshotBytes = bytes;
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
      this.health.note('snapshot_past_budget');
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
      this.health.note('snapshot_not_saved', err);
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
