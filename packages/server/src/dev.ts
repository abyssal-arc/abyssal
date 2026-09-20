/**
 * Minimal node:http adapter for local development. It adapts the Fetch API
 * style handler (which is what a Cloudflare Worker would run) onto node:http.
 *
 * It also owns world persistence: the single shared world is snapshotted to
 * disk so a server restart resumes the same ecosystem instead of reseeding.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJSON } from '@abyssal/sim';
import { compressible, encodeBody } from './compress.js';
import { createApp } from './handler.js';

const PORT = Number(process.env.PORT ?? 8787);
const TICK_MS = Number(process.env.TICK_MS ?? 250);
const SAVE_MS = Number(process.env.SAVE_MS ?? 15_000);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const webRoot = join(repoRoot, 'packages', 'web');
const stateFile = process.env.WORLD_STATE ?? join(repoRoot, '.data', 'world.json');

function loadSnapshot(): string | undefined {
  try {
    return readFileSync(stateFile, 'utf8');
  } catch {
    return undefined;
  }
}

const snapshot = process.env.FRESH_WORLD ? undefined : loadSnapshot();
const app = createApp({
  webRoot,
  seed: Number(process.env.SEED ?? 1337),
  snapshot,
});

/** Atomic snapshot write: a crash mid-save can only lose the temp file. */
function saveWorld(): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, toJSON(app.world));
    renameSync(tmp, stateFile);
  } catch (err) {
    console.warn('[abyssal] world save failed:', err);
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const reqHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') reqHeaders.set(k, v);
    }
    const hasBody = chunks.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
      method: req.method,
      headers: reqHeaders,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await app.fetch(request);
    const headers = new Headers(response.headers);
    let body: Buffer = Buffer.from(await response.arrayBuffer());
    const type = headers.get('content-type') ?? '';
    if (compressible(type)) {
      // One URL can answer br, gzip or identity depending on who is asking.
      headers.append('vary', 'accept-encoding');
      if (body.length > 0 && !headers.has('content-encoding')) {
        const encoded = await encodeBody(body, String(req.headers['accept-encoding'] ?? ''), type);
        if (encoded.encoding) {
          body = encoded.body;
          headers.set('content-encoding', encoded.encoding);
        }
      }
    }
    if (response.status !== 204 && response.status !== 304) {
      headers.set('content-length', String(body.length));
    }
    res.writeHead(response.status, Object.fromEntries(headers.entries()));
    res.end(body);
  })().catch((err) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err));
  });
});

server.listen(PORT, () => {
  app.start(TICK_MS);
  const saveTimer = setInterval(saveWorld, SAVE_MS);
  saveTimer.unref();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      saveWorld();
      app.stop();
      process.exit(0);
    });
  }
  const w = app.world;
  console.log(
    snapshot
      ? `[abyssal] resumed world: tick ${w.tick}, ${w.creatures.length} creatures`
      : '[abyssal] seeded a fresh world',
  );
  console.log(`[abyssal] listening on http://localhost:${PORT} (tick: ${TICK_MS}ms)`);
});
