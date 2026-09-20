/**
 * Cloudflare Worker entry: the whole observatory lives in one Durable Object
 * so the ecosystem keeps a single world across isolates, and a cron alarm
 * keeps time flowing while nobody is watching. Static files are served by
 * Workers Static Assets; every other path is API and routes to the object.
 */
import { createApp } from './handler.js';
import { toJSON } from '@abyssal/sim';

interface DoStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface DoBinding {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

interface Env {
  WORLD: DoBinding;
  ABYS_TOKEN_ADDRESS?: string;
}

const SNAP_KEY = 'world';
const INSTANCE_KEY = 'instance';
const SAVE_EVERY_MS = 30_000;

export class AbyssalWorld {
  private app: ReturnType<typeof createApp> | null = null;
  private lastSave = 0;

  // Durable Objects receive their bindings through the constructor, not fetch.
  constructor(private ctx: { storage: DoStorage }, private env: Env) {}

  private async boot(): Promise<ReturnType<typeof createApp>> {
    if (!this.app) {
      const snapshot = await this.ctx.storage.get<string>(SNAP_KEY);
      let instance = await this.ctx.storage.get<string>(INSTANCE_KEY);
      if (!instance) {
        instance = crypto.randomUUID();
        await this.ctx.storage.put(INSTANCE_KEY, instance);
      }
      this.app = createApp({ snapshot: snapshot ?? undefined, instance, token: this.env.ABYS_TOKEN_ADDRESS });
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
    await app.catchUp();
    const response = await app.fetch(request);
    await this.persist(app);
    return response;
  }

  /** One cron per minute keeps the ecosystem alive with no viewers. */
  async alarm(): Promise<void> {
    const app = await this.boot();
    await app.catchUp(240);
    this.lastSave = 0;
    await this.persist(app);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.WORLD.idFromName('abyssal');
    return env.WORLD.get(id).fetch(request);
  },
};
