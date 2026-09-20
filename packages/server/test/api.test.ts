import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIntervention, tick, toJSON } from '@abyssal/sim';
import { createApp } from '../src/handler.js';
import { serveStatic } from '../src/static.js';
import {
  ARC_USDC,
  exactRequirement,
  settleFromRequest,
  type FacilitatorConfig,
} from '../src/facilitator.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { BURN_SINK, TRANSFER_TOPIC } from '../src/payments.js';

// The handler feeds from the live Arc RPC by default; the suite must never
// depend on the network, so pin the offline rain before any app is created.
process.env.CHAIN_FEED ??= 'synthetic';
// A dummy ABYS address so createApp builds the burn-payment gate. Nothing here
// touches a chain: verification runs against a local stub RPC, and the
// facilitator test below builds its own config and stubs Circle.
process.env.ABYS_TOKEN_ADDRESS ??= '0x' + '11'.repeat(20);
process.env.ALLOW_DEBUG_TICK ??= '1';

// One receipt stub for the /intervene tests: any hash settles a valid burn of
// the feed price, so the route logic (not the verifier) is what is under test.
const receiptStub = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    jsonrpc: '2.0', id: 1,
    result: {
      status: '0x1',
      logs: [{
        address: process.env.ABYS_TOKEN_ADDRESS,
        topics: [
          TRANSFER_TOPIC,
          `0x${'ab'.repeat(20).padStart(64, '0')}`,
          BURN_SINK,
        ],
        data: '0x' + (100_000_000_000).toString(16),
      }],
    },
  }));
});
await new Promise<void>((r) => receiptStub.listen(0, '127.0.0.1', () => r()));
process.env.ARC_RPC_URL = `http://127.0.0.1:${(receiptStub.address() as AddressInfo).port}`;
after(() => receiptStub.close());

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('402 advertises the ABYS burn offer on Arc mainnet', async () => {
  const app = createApp({ seed: 1 });
  const res = await app.fetch(post('/intervene', { type: 'feed', x: 100, y: 100 }));
  assert.equal(res.status, 402);
  const body = (await res.json()) as {
    error: string;
    accepts: {
      scheme: string;
      settle: string;
      network: string;
      asset: string;
      amount: string;
    }[];
  };
  assert.equal(body.error, 'payment required');
  assert.equal(body.accepts.length, 1, 'one burn offer, no unpaid alternative');
  const req = body.accepts[0];
  assert.equal(req.scheme, 'exact');
  assert.equal(req.settle, 'burn');
  assert.equal(req.network, 'eip155:5042');
  assert.equal(req.asset, process.env.ABYS_TOKEN_ADDRESS);
  assert.equal(req.amount, '100000000000'); // 100,000 ABYS in base units
});

test('402 amounts follow the ABYS price list in base units', async () => {
  const app = createApp({ seed: 1 });
  for (const [type, base] of [
    ['feed', '100000000000'],
    ['poison', '150000000000'],
    ['bloom', '200000000000'],
    ['drought', '200000000000'],
  ] as const) {
    const res = await app.fetch(post('/intervene', { type, x: 10, y: 10 }));
    assert.equal(res.status, 402);
    const body = (await res.json()) as { accepts: { amount: string }[] };
    assert.equal(body.accepts[0].amount, base, `${type} should cost ${base} base units`);
  }
});

test('/intervene answers 503 until the token is deployed', async () => {
  const tok = process.env.ABYS_TOKEN_ADDRESS;
  delete process.env.ABYS_TOKEN_ADDRESS;
  try {
    const app = createApp({ seed: 1 });
    const res = await app.fetch(post('/intervene', { type: 'feed', x: 100, y: 100 }));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'token not deployed');
  } finally {
    if (tok) process.env.ABYS_TOKEN_ADDRESS = tok;
  }
});

test('a burn receipt pays: Transfer to zero for at least the asked amount', async () => {
  const { verifyBurnReceipt, burnOffer, TRANSFER_TOPIC, BURN_SINK } = await import('../src/payments.js');
  const token = process.env.ABYS_TOKEN_ADDRESS as string;
  const payer = '0x' + 'ab'.repeat(20);
  const PRICE = 100_000_000_000n; // 100,000 ABYS in base units
  const stub = (receipt: unknown) =>
    createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: receipt }));
    });
  const burnLog = (to: string, value: bigint, addr = token) => ({
    address: addr,
    topics: [TRANSFER_TOPIC, `0x${payer.slice(2).padStart(64, '0')}`, to],
    data: `0x${value.toString(16)}`,
  });
  const offer = burnOffer('feed');
  const run = async (receipt: unknown, hash: string) => {
    const srv = stub(receipt);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      return await verifyBurnReceipt(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, offer, hash);
    } finally {
      srv.close();
    }
  };

  const v = await run({ status: '0x1', logs: [burnLog(BURN_SINK, PRICE)] }, '0x' + 'a1'.repeat(32));
  assert.equal(v.ok, true);
  assert.equal(v.payer, payer);

  const v2 = await run({ status: '0x1', logs: [burnLog(payer, PRICE)] }, '0x' + 'a2'.repeat(32));
  assert.equal(v2.ok, false, 'a transfer to a person is not a burn');

  const v3 = await run({ status: '0x1', logs: [burnLog(BURN_SINK, PRICE - 1n)] }, '0x' + 'a3'.repeat(32));
  assert.equal(v3.ok, false, 'underpaying must not settle');

  const v4 = await run({ status: '0x0', logs: [burnLog(BURN_SINK, PRICE)] }, '0x' + 'a4'.repeat(32));
  assert.equal(v4.ok, false);
  assert.equal(v4.reason, 'transaction reverted');

  const hash = '0x' + 'a5'.repeat(32);
  const first = await run({ status: '0x1', logs: [burnLog(BURN_SINK, PRICE)] }, hash);
  const second = await run({ status: '0x1', logs: [burnLog(BURN_SINK, PRICE)] }, hash);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'one burn buys one intervention');
  assert.equal(second.reason, 'receipt already used');
});

test('/state exposes marketTemp plus harvest and judgment countdowns', async () => {
  const app = createApp({ seed: 1 });
  const res = await app.fetch(new Request('http://localhost/state'));
  assert.equal(res.status, 200);
  const state = (await res.json()) as {
    marketTemp: number;
    chainTemp: number;
    harvest: { intervalTicks: number; ticksRemaining: number; cullRatio: number };
    judgment: { intervalTicks: number; ticksRemaining: number; cullRatio: number };
  };
  assert.equal(typeof state.marketTemp, 'number');
  assert.ok(state.marketTemp >= 0 && state.marketTemp <= 1);
  assert.equal(state.harvest.intervalTicks, 800);
  assert.equal(state.harvest.cullRatio, 0.02);
  assert.equal(state.judgment.intervalTicks, 19200);
  assert.equal(state.judgment.cullRatio, 0.1);
  assert.ok(state.harvest.ticksRemaining > 0 && state.harvest.ticksRemaining <= 800);
  assert.ok(state.judgment.ticksRemaining > 0 && state.judgment.ticksRemaining <= 19200);
});

test('/judgments carries typed cull records and supports ?type= filter', async () => {
  const app = createApp({ seed: 1 });
  const res = await app.fetch(new Request('http://localhost/judgments?type=harvest'));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { judgments: { type: string }[] };
  assert.ok(Array.isArray(body.judgments));
  for (const j of body.judgments) assert.equal(j.type, 'harvest');
});

test('/world creatures carry archetype and radius', async () => {
  const app = createApp({ seed: 1 });
  const res = await app.fetch(new Request('http://localhost/world'));
  const body = (await res.json()) as {
    marketTemp: number;
    creatures: { archetype: string; radius: number }[];
  };
  assert.equal(typeof body.marketTemp, 'number');
  assert.ok(body.creatures.length > 0);
  for (const c of body.creatures) {
    assert.ok(['APE', 'WHALE', 'ALGO', 'INSIDER'].includes(c.archetype));
    assert.ok(c.radius > 0);
  }
});

test('GET / serves the web frontend, GET /api serves the endpoint index', async () => {
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web');
  const app = createApp({ seed: 1, static: (p, h) => serveStatic(webRoot, p, h) });

  const root = await app.fetch(new Request('http://localhost/'));
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await root.text(), /ABYSSAL/);

  const api = await app.fetch(new Request('http://localhost/api'));
  assert.equal(api.status, 200);
  const index = (await api.json()) as {
    chain: { network: string; chainId: number; asset: string };
    endpoints: Record<string, string>;
  };
  assert.equal(index.chain.network, 'arc');
  assert.equal(index.chain.chainId, 5042);
  assert.equal(index.chain.asset, 'ABYSSAL');
  assert.ok('GET /state' in index.endpoints);

  const ui = await app.fetch(new Request('http://localhost/ui'));
  assert.equal(ui.status, 302);
  assert.equal(ui.headers.get('location'), '/');
});

test('GET / falls back to the endpoint index when no webRoot is configured', async () => {
  const app = createApp({ seed: 1 });
  const res = await app.fetch(new Request('http://localhost/'));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { name: string };
  assert.equal(body.name, 'abyssal-server');
});

test('/events streams positioned events and honors ?since=', async () => {
  const app = createApp({ seed: 1 });
  applyIntervention(app.world, { type: 'feed', x: 100, y: 100, radius: 80 });
  const res = await app.fetch(new Request('http://localhost/events?since=0'));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    events: { seq: number; type: string; kind?: string; x?: number; y?: number }[];
  };
  const ev = body.events.find((e) => e.type === 'intervention');
  assert.ok(ev, 'intervention should produce a positioned event');
  assert.equal(ev.kind, 'feed');
  assert.equal(ev.x, 100);
  assert.equal(ev.y, 100);
  const res2 = await app.fetch(new Request(`http://localhost/events?since=${ev.seq}`));
  const body2 = (await res2.json()) as { events: { seq: number }[] };
  assert.ok(!body2.events.some((e) => e.seq <= ev.seq), 'since filter excludes seen events');
});

test('/snapshot returns world + state + events in one request', async () => {
  const app = createApp({ seed: 1 });
  applyIntervention(app.world, { type: 'bloom' });
  const res = await app.fetch(new Request('http://localhost/snapshot?since=0'));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    world: { creatures: unknown[]; width: number };
    state: { marketTemp: number; harvest: unknown };
    events: { kind?: string }[];
  };
  assert.ok(body.world.creatures.length > 0);
  assert.equal(typeof body.state.marketTemp, 'number');
  assert.ok(body.events.some((e) => e.kind === 'bloom'));
});

test('a resumed snapshot continues the same world instead of reseeding', () => {
  const a = createApp({ seed: 7 });
  for (let i = 0; i < 25; i++) tick(a.world, { chain: 0.5, market: 0.5 }, []);
  const ids = (w: typeof a.world) => w.creatures.map((c) => `${c.id}:${Math.round(c.energy)}`);

  const b = createApp({ snapshot: toJSON(a.world) });
  assert.equal(b.world.tick, a.world.tick);
  assert.deepEqual(ids(b.world), ids(a.world));
  assert.equal(b.world.rng.getState(), a.world.rng.getState());

  // Divergence check: the same next input produces the same next world.
  tick(a.world, { chain: 0.5, market: 0.5 }, []);
  tick(b.world, { chain: 0.5, market: 0.5 }, []);
  assert.equal(b.world.tick, a.world.tick);
  assert.deepEqual(ids(b.world), ids(a.world));
});

test('chain whales: lane is a pure function of the address and stays in the tank', async () => {
  const { whaleLaneOf, whalePosition } = await import('../src/arc.js');
  const addr = '0xAbC0000000000000000000000000000000000001';
  const lane = whaleLaneOf(addr);
  // Case-insensitive + deterministic: every viewer must agree on the animal.
  assert.deepEqual(whaleLaneOf(addr.toLowerCase()), lane);
  assert.notDeepEqual(whaleLaneOf('0xabc0000000000000000000000000000000000002'), lane);
  assert.ok(lane.lane > 0.15 && lane.lane < 0.85, 'lane should keep whales off the top/bottom UI');
  assert.ok(lane.period >= 210_000 && lane.period < 300_000);

  const W = 1000;
  const H = 1000;
  // Sampled across a full wrap of the lane cycle rather than from Date.now():
  // a wall-clock slice can land entirely in the seam fade-out, which would make
  // these assertions pass or fail depending on when the suite happened to run.
  const span = lane.period * 1.2;
  let onWorld = 0;
  const SAMPLES = 240;
  for (let i = 0; i < SAMPLES; i++) {
    const p = whalePosition(lane, (i / SAMPLES) * span, W, H);
    if (!p) continue;
    onWorld++;
    assert.ok(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H, 'whale must stay inside the tank');
  }
  assert.ok(onWorld > SAMPLES * 0.7, 'the whale should be visible most of the time, not parked on the seam');

  // The premise of the whole mechanic: between two ticks the animal moves less
  // than a body length, so plankton dropped "at the whale" is still at the
  // whale by the time the viewer's next frame renders it.
  let checked = 0;
  for (let t = 0; t < span; t += 250) {
    const a = whalePosition(lane, t, W, H);
    const b = whalePosition(lane, t + 250, W, H);
    if (!a || !b) continue;
    checked++;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 6, 'whale must not teleport between ticks');
  }
  assert.ok(checked > 400);
});

test('x402: an authorization signed by another account is caught before Circle sees it', async () => {
  const seller = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const buyer = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
  const stranger = privateKeyToAccount('0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82');
  // A facilitator that settles whatever it is handed: only our own pre-checks
  // stand between the buyer and a successful settlement.
  const stub = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, transaction: '0xfeed', payer: buyer.address }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  const cfg: FacilitatorConfig = {
    network: 'eip155:5042002',
    chainId: 5042002,
    payTo: seller.address.toLowerCase(),
    baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    usdc: ARC_USDC,
    account: seller,
  };
  const requirement = exactRequirement(cfg, '0.05');
  const authorization = {
    from: buyer.address,
    to: cfg.payTo as `0x${string}`,
    value: requirement.amount,
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce: `0x${'11'.repeat(32)}`,
  };
  const sign = (key: typeof buyer): Promise<`0x${string}`> =>
    key.signTypedData({
      domain: {
        name: 'USDC',
        version: '2',
        chainId: cfg.chainId,
        verifyingContract: cfg.usdc as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
    });
  const call = (signature: string): Promise<{ ok: boolean; reason?: string; tx?: string }> => {
    const envelope = {
      x402Version: 2,
      resource: { url: 'http://localhost/intervene', description: 'test', mimeType: 'application/json' },
      accepted: requirement,
      payload: { signature, authorization },
    };
    return settleFromRequest(
      new Request('http://localhost/intervene', {
        method: 'POST',
        headers: { 'x-payment': Buffer.from(JSON.stringify(envelope)).toString('base64url') },
      }),
      cfg,
      requirement,
    );
  };

  const wrong = await call(await sign(stranger));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'signer_mismatch');

  const right = await call(await sign(buyer));
  assert.equal(right.ok, true, `a correctly signed authorization must settle, got ${right.reason}`);
  assert.equal(right.tx, '0xfeed');
  stub.close();
});

/* ---------- bandwidth: compression, decimation, incremental polls ---------- */

test('encodeBody: brotli wins when offered, gzip is the fallback, identity when neither', async () => {
  const { compressible, encodeBody } = await import('../src/compress.js');
  const { brotliDecompressSync, gunzipSync } = await import('node:zlib');
  assert.ok(compressible('application/json; charset=utf-8'));
  assert.ok(compressible('text/javascript; charset=utf-8'));
  assert.ok(compressible('text/css; charset=utf-8'));
  assert.ok(!compressible('image/png'), 'png is already compressed');

  const payload = Buffer.from(
    JSON.stringify({ creatures: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `MOBY-${i}` })) }),
  );
  const br = await encodeBody(payload, 'gzip, deflate, br', 'application/json; charset=utf-8');
  assert.equal(br.encoding, 'br');
  assert.ok(br.body.length < payload.length);
  // Round-trip is the property that matters: a corrupt frame is worse than a fat one.
  assert.deepEqual(brotliDecompressSync(br.body), payload);

  const gz = await encodeBody(payload, 'gzip, deflate', 'application/json; charset=utf-8');
  assert.equal(gz.encoding, 'gzip');
  assert.deepEqual(gunzipSync(gz.body), payload);

  const identity = await encodeBody(payload, 'identity', 'application/json; charset=utf-8');
  assert.equal(identity.encoding, undefined);
  assert.equal(identity.body, payload);

  const tiny = Buffer.from('{"ok":true}');
  assert.equal((await encodeBody(tiny, 'br', 'application/json')).encoding, undefined);
  assert.equal((await encodeBody(payload, 'br', 'image/png')).encoding, undefined);
});

test('serveStatic advertises a validator and answers 304 when it still matches', async () => {
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { serveStatic } = await import('../src/static.js');
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web');

  const headers = new Headers();
  const first = await serveStatic(webRoot, '/index.html', headers);
  assert.equal(first?.status, 200);
  const etag = first?.headers.get('etag');
  assert.ok(etag, 'without a validator every reload re-downloads ~193 KB of assets');
  assert.ok(first?.headers.get('last-modified'));

  headers.set('if-none-match', etag);
  const cached = await serveStatic(webRoot, '/index.html', headers);
  assert.equal(cached?.status, 304);
  assert.equal((await cached?.arrayBuffer()).byteLength, 0);

  // A stale validator must fall through to a real 200, not a broken 304.
  headers.set('if-none-match', 'W/"0-0"');
  assert.equal((await serveStatic(webRoot, '/index.html', headers))?.status, 200);
});

test('/history?slots= decimates server-side exactly the way the charts do', async () => {
  const app = createApp({ seed: 1 });
  for (let i = 0; i < 120; i++) tick(app.world, { chain: 0.5, market: 0.5 }, []);
  const stats = async (q: string) =>
    ((await (await app.fetch(new Request(`http://localhost/history?${q}`))).json()) as {
      stats: unknown[];
    }).stats;

  const full = await stats('window=120');
  assert.equal(full.length, 120);

  // Mirror of computePoints() in app.js, the drawn line must not change.
  const clientStride = (rows: unknown[], slots: number) => {
    const step = Math.max(1, Math.ceil(rows.length / slots));
    const out: unknown[] = [];
    for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
    return out;
  };
  const decimated = await stats('window=120&slots=20');
  assert.equal(decimated.length, 20);
  assert.deepEqual(decimated, clientStride(full, 20));
  // Idempotence is what lets the client run its own pass afterwards and still
  // land on the identical points.
  assert.deepEqual(clientStride(decimated, 20), decimated);

  // No slots param: the pre-optimisation behaviour, byte for byte.
  assert.deepEqual(await stats('window=120'), full);
});

test('/snapshot?tail= keeps the newest events and leaves the cursor at the true max', async () => {
  const app = createApp({ seed: 1 });
  for (let i = 0; i < 150; i++) tick(app.world, { chain: 0.9, market: 0.5 }, []);
  const events = async (q: string) =>
    ((await (await app.fetch(new Request(`http://localhost/snapshot?${q}`))).json()) as {
      events: { seq: number }[];
    }).events;

  const full = await events('since=0');
  assert.ok(full.length > 6, 'need a backlog for the cap to mean anything');
  const capped = await events('since=0&tail=6');
  assert.deepEqual(capped, full.slice(-6));
  // The client derives its next `since` from what it received, so the last entry
  // must still be the newest, otherwise the backlog is re-sent every poll.
  assert.equal(capped[capped.length - 1].seq, full[full.length - 1].seq);
});

test('/snapshot?tx= replays only the meteors the client has not seen', async () => {
  const app = createApp({ seed: 1 });
  const rain = async (q: string) =>
    ((await (await app.fetch(new Request(`http://localhost/snapshot?${q}`))).json()) as {
      txRain: { hash: string }[];
    }).txRain;

  await app.fetch(post('/tick', {}));
  const first = await rain('since=0');
  assert.ok(first.length > 0, 'the synthetic feed should have rained something');
  const cursor = first[first.length - 1].hash;

  // The whole point: an unchanged window must not ride along again. It used to
  // be ~4 KB of addresses and hashes every 400ms, all of it discarded client-side.
  assert.equal((await rain(`since=0&tx=${cursor}`)).length, 0);

  await app.fetch(post('/tick', {}));
  const next = await rain(`since=0&tx=${cursor}`);
  assert.ok(next.length > 0);
  assert.ok(!next.some((t) => t.hash === cursor), 'the cursor itself is already seen');

  // A cursor that aged out of the 12-entry window (or outlived a server restart)
  // falls back to the full window. The client keys its seen-set by hash, so this
  // is safe, and far better than silently never showing another meteor.
  const fallback = await rain('since=0&tx=0xnotawindowmember');
  assert.deepEqual(fallback.map((t) => t.hash), (await rain('since=0')).map((t) => t.hash));
});

test('FlowMeter calibrates by rank: bounded, median-centred, outlier-proof', async () => {
  const { FlowMeter } = await import('../src/arc.js');

  const m = new FlowMeter(60, 0.5);
  for (let i = 0; i < 80; i++) m.read(10 + (i % 3));
  const calm = m.value;
  assert.ok(calm > 0.35 && calm < 0.65, `a stationary flow should sit near the middle, got ${calm}`);

  // A step up reads hot while it is unusual relative to the recent window.
  for (let i = 0; i < 10; i++) m.read(1000);
  assert.ok(m.value > 0.8, 'a sudden sustained spike must read hot');

  // And re-centres once the spike IS the recent regime: rank measures
  // unusualness, not absolute throughput, so growth never pins it at 1.
  for (let i = 0; i < 140; i++) m.read(1000);
  assert.ok(m.value > 0.35 && m.value < 0.65, `a settled new regime must re-centre, got ${m.value}`);

  // One absurd settlement must not stretch the scale for the polls after it.
  const n = new FlowMeter(60, 1);
  for (let i = 0; i < 40; i++) n.read(10);
  n.read(1e12);
  const after = n.read(10);
  assert.ok(after < 0.6, `an ordinary poll after a whale must not read saturated, got ${after}`);

  for (const v of [-5, 0, 1e18]) {
    const r = m.read(v);
    assert.ok(r >= 0 && r <= 1, 'percentile must stay inside [0,1]');
  }
});

test('invalid params are rejected before the burn receipt is consumed', async () => {
  const app = createApp({ seed: 1 });
  const hash = '0x' + 'b9'.repeat(32);
  const bad = await app.fetch(post('/intervene', { type: 'feed', x: -5, y: 5 }, { 'x-payment-tx': hash }));
  assert.equal(bad.status, 400, 'a malformed intervention must not charge anyone');
  const good = await app.fetch(post('/intervene', { type: 'feed', x: 500, y: 500 }, { 'x-payment-tx': hash }));
  assert.equal(good.status, 200, 'the receipt must survive the rejected request');
});

test('used burn receipts persist through the ledger, so restarts cannot replay', async () => {
  const { setBurnLedger, verifyBurnReceipt, burnOffer } = await import('../src/payments.js');
  const file = join(tmpdir(), `abyssal-burns-${process.pid}-${Date.now()}.txt`);
  const mk = () => ({
    load: () => {
      try { return readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    },
    append: (h: string) => appendFileSync(file, `${h}\n`),
  });
  setBurnLedger(mk());
  const srv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: {
        status: '0x1',
        logs: [{
          address: process.env.ABYS_TOKEN_ADDRESS,
          topics: [TRANSFER_TOPIC, `0x${'cd'.repeat(20).padStart(64, '0')}`, BURN_SINK],
          data: '0x' + (100_000_000_000).toString(16),
        }],
      },
    }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const hash = '0x' + 'b8'.repeat(32);
    const first = await verifyBurnReceipt(url, burnOffer('feed'), hash);
    assert.equal(first.ok, true);
    assert.ok(readFileSync(file, 'utf8').includes(hash), 'the used hash must hit the ledger file');
    // A fresh boot reloads the ledger: the same burn is dead on arrival.
    setBurnLedger(mk());
    const replayed = await verifyBurnReceipt(url, burnOffer('feed'), hash);
    assert.equal(replayed.ok, false);
    assert.equal(replayed.reason, 'receipt already used');
  } finally {
    srv.close();
    rmSync(file, { force: true });
  }
});
