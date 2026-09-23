import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIntervention, tick, toJSON } from '@abyssal/sim';
import { createApp, type LedgerSnapshot, type WorldStore } from '../src/handler.js';
import type { ChainFeed, FeedState, PulseRow } from '../src/chain.js';
import type { MarketFeed } from '../src/market.js';
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
import { BURN_SINK, DEAD_SINK, TRANSFER_TOPIC } from '../src/payments.js';

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
const DEC18 = '0x' + (18).toString(16).padStart(64, '0');

/** RPC stub: decimals(), a confirmed head, and whatever the receipt handler returns. */
function rpcStub(answer: (method: string, data: string | undefined) => unknown) {
  return createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const parsed = JSON.parse(body || '{}') as { method?: string; params?: [{ data?: string }] };
    const data = parsed.params?.[0]?.data;
    const result =
      parsed.method === 'eth_blockNumber' ? '0x100' : answer(parsed.method ?? '', data);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
}

const receiptStub = rpcStub((method, data) => (data === '0x313ce567'
  ? DEC18
  : {
      status: '0x1',
      blockNumber: '0x80',
      logs: [{
        address: process.env.ABYS_TOKEN_ADDRESS,
        topics: [
          TRANSFER_TOPIC,
          `0x${'ab'.repeat(20).padStart(64, '0')}`,
          BURN_SINK,
        ],
        data: '0x' + (100_000n * 10n ** 18n).toString(16),
      }],
    }));
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
  assert.equal(req.amount, '100000000000000000000000'); // 100,000 ABYS at 18 decimals
});

test('402 amounts follow the ABYS price list in base units', async () => {
  const app = createApp({ seed: 1 });
  const id = app.world.creatures[0].id;
  // Whole tokens as the price list states them; the quote must be that number
  // scaled by the token's own decimals(), which the stub answers as 18.
  const units = (whole: number): string => (BigInt(whole) * 10n ** 18n).toString();
  for (const [type, whole, body] of [
    ['feed', 100_000, { type: 'feed', x: 10, y: 10 }],
    ['poison', 150_000, { type: 'poison', x: 10, y: 10 }],
    ['bloom', 200_000, { type: 'bloom' }],
    ['drought', 200_000, { type: 'drought' }],
    ['pass', 5_000, { type: 'pass' }],
    ['name', 50_000, { type: 'name', creatureId: id, name: 'Moby' }],
    ['wish', 25_000, { type: 'wish', message: 'be kind' }],
    ['mutate', 100_000, { type: 'mutate', creatureId: id, trait: 'speed', direction: 'boost' }],
    ['ark', 75_000, { type: 'ark', creatureId: id }],
  ] as const) {
    const res = await app.fetch(post('/intervene', body));
    assert.equal(res.status, 402);
    const quoted = (await res.json()) as { accepts: { amount: string }[] };
    assert.equal(quoted.accepts[0].amount, units(whole), `${type} should cost ${whole} ABYS`);
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
  const { verifyBurnReceipt, burnOffer, recordBurnReceipt, hydrateReceipts, TRANSFER_TOPIC, BURN_SINK } = await import('../src/payments.js');
  const token = process.env.ABYS_TOKEN_ADDRESS as string;
  const payer = '0x' + 'ab'.repeat(20);
  const PRICE = 100_000n * 10n ** 18n; // 100,000 ABYS at 18 decimals
  const stub = (receipt: unknown) => rpcStub((method, data) => (data === '0x313ce567' ? DEC18 : receipt));
  const burnLog = (to: string, value: bigint, addr = token) => ({
    address: addr,
    topics: [TRANSFER_TOPIC, `0x${payer.slice(2).padStart(64, '0')}`, to],
    data: `0x${value.toString(16)}`,
  });
  const run = async (receipt: unknown, hash: string) => {
    const srv = stub(receipt);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      return await verifyBurnReceipt(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, offer, hash);
    } finally {
      srv.close();
    }
  };

  const offer = (await burnOffer(`http://127.0.0.1:1`, 'feed'))!; // decimals cached from the stubs below
  const v = await run({ status: '0x1', blockNumber: '0x80', logs: [burnLog(BURN_SINK, PRICE)] }, '0x' + 'a1'.repeat(32));
  assert.equal(v.ok, true, `zero-sink burn rejected: ${v.reason}`);
  assert.equal(v.payer, payer);

  const v2 = await run({ status: '0x1', logs: [burnLog(payer, PRICE)] }, '0x' + 'a2'.repeat(32));
  assert.equal(v2.ok, false, 'a transfer to a person is not a burn');

  const v3 = await run({ status: '0x1', logs: [burnLog(BURN_SINK, PRICE - 1n)] }, '0x' + 'a3'.repeat(32));
  assert.equal(v3.ok, false, 'underpaying must not settle');

  const v4 = await run({ status: '0x0', logs: [burnLog(BURN_SINK, PRICE)] }, '0x' + 'a4'.repeat(32));
  assert.equal(v4.ok, false);
  assert.equal(v4.reason, 'transaction reverted');
  // The blackhole convention counts as burning too.
  const v5 = await run({ status: '0x1', blockNumber: '0x80', logs: [burnLog(DEAD_SINK, PRICE)] }, '0x' + 'a6'.repeat(32));
  assert.equal(v5.ok, true, `blackhole burn rejected: ${v5.reason}`);
  // An unconfirmed receipt is spendable by nobody.
  const pendingStub = rpcStub((method, data) => (data === '0x313ce567'
    ? DEC18
    : { status: '0x1', blockNumber: '0x100', logs: [burnLog(BURN_SINK, PRICE)] }));
  await new Promise<void>((r) => pendingStub.listen(0, '127.0.0.1', () => r()));
  const pending = await verifyBurnReceipt(
    `http://127.0.0.1:${(pendingStub.address() as AddressInfo).port}`,
    offer,
    '0x' + 'a7'.repeat(32),
  );
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, 'receipt pending');
  pendingStub.close();

  const hash = '0x' + 'a5'.repeat(32);
  const first = await run({ status: '0x1', blockNumber: '0x80', logs: [burnLog(BURN_SINK, PRICE)] }, hash);
  assert.equal(first.ok, true, `replay pair rejected: ${first.reason}`);
  // verify no longer records; the handler records after the action succeeds.
  recordBurnReceipt(hash);
  const second = await run({ status: '0x1', blockNumber: '0x80', logs: [burnLog(BURN_SINK, PRICE)] }, hash);
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

test('whale ranking ignores the burn sinks and the token itself', async () => {
  const { ArcUsdcFeed } = await import('../src/arc.js');
  const feed = new ArcUsdcFeed('http://127.0.0.1:1');
  const now = Date.now();
  const burner = '0x' + 'a1'.repeat(20);
  (feed as unknown as { flows: unknown[] }).flows = [
    { t: now, block: 1, tx: '0x01', from: burner, to: '0x0000000000000000000000000000000000000000', amount: 9000, x402: true },
    { t: now, block: 1, tx: '0x02', from: burner, to: '0x000000000000000000000000000000000000dead', amount: 500, x402: false },
    { t: now, block: 2, tx: '0x03', from: '0x' + 'b2'.repeat(20), to: '0x' + 'c3'.repeat(20), amount: 10, x402: false },
  ];
  const addrs = feed.whalesPayload().map((r) => r.address);
  assert.ok(!addrs.includes('0x0000000000000000000000000000000000000000'), 'the zero sink is not an actor');
  assert.ok(!addrs.includes('0x000000000000000000000000000000000000dead'), 'the blackhole is not an actor');
  const top = feed.whalesPayload()[0];
  assert.equal(top.address, burner, 'a burner still ranks on the money it moved');
  assert.equal(top.volume, 9500);
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

test('/intervene accepts same-origin https posts and rejects foreign pages', async () => {
  const app = createApp({ seed: 1 });
  const same = await app.fetch(
    new Request('https://www.abyssal-arc.com/intervene', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://www.abyssal-arc.com' },
      body: JSON.stringify({ type: 'feed', x: 100, y: 100 }),
    }),
  );
  assert.notEqual(same.status, 403, 'same-origin https must not trip the gate');
  const foreign = await app.fetch(
    new Request('https://www.abyssal-arc.com/intervene', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ type: 'feed', x: 100, y: 100 }),
    }),
  );
  assert.equal(foreign.status, 403);
});

test('invalid params are rejected before the burn receipt is consumed', async () => {
  const app = createApp({ seed: 1 });
  const hash = '0x' + 'b9'.repeat(32);
  const bad = await app.fetch(post('/intervene', { type: 'feed', x: -5, y: 5 }, { 'x-payment-tx': hash }));
  assert.equal(bad.status, 400, 'a malformed intervention must not charge anyone');
  const good = await app.fetch(post('/intervene', { type: 'feed', x: 500, y: 500 }, { 'x-payment-tx': hash }));
  const goodBody = (await good.json()) as { reason?: string };
  assert.equal(good.status, 200, `the receipt must survive the rejected request, got ${goodBody.reason}`);
});

test('used burn receipts persist through the ledger, so restarts cannot replay', async () => {
  const { setBurnLedger, verifyBurnReceipt, burnOffer, recordBurnReceipt, hydrateReceipts } = await import('../src/payments.js');
  const file = join(tmpdir(), `abyssal-burns-${process.pid}-${Date.now()}.txt`);
  const mk = () => ({
    load: async () => {
      try { return readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
    },
    add: (h: string) => appendFileSync(file, `${h}\n`),
  });
  setBurnLedger(mk());
  const srv = rpcStub(() => ({
    status: '0x1',
    blockNumber: '0x80',
    logs: [{
      address: process.env.ABYS_TOKEN_ADDRESS,
      topics: [TRANSFER_TOPIC, `0x${'cd'.repeat(20).padStart(64, '0')}`, BURN_SINK],
      data: '0x' + PRICE.toString(16),
    }],
  }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const PRICE = 100_000n * 10n ** 18n;
  const offer = (await burnOffer(url, 'feed'))!;
  try {
    const hash = '0x' + 'b8'.repeat(32);
    const first = await verifyBurnReceipt(url, offer, hash);
    assert.equal(first.ok, true);
    // Recording happens after the paid action succeeds, not inside verify.
    recordBurnReceipt(hash);
    assert.ok(readFileSync(file, 'utf8').includes(hash), 'the used hash must hit the ledger file');
    // A fresh boot reloads the ledger: the same burn is dead on arrival.
    setBurnLedger(mk());
    await hydrateReceipts();
    const replayed = await verifyBurnReceipt(url, offer, hash);
    assert.equal(replayed.ok, false);
    assert.equal(replayed.reason, 'receipt already used');
  } finally {
    srv.close();
    rmSync(file, { force: true });
  }
});

test('one burn buys one intervention, whatever casing the hash arrives in', async () => {
  const { setBurnLedger, verifyBurnReceipt, burnOffer, recordBurnReceipt, hydrateReceipts, isBurnRecorded } =
    await import('../src/payments.js');

  // A tx hash is hex, so its casing names nothing: `0xd4cB…` and `0xd4cb…` are
  // the same transaction and one RPC answers for both. The replay check always
  // compared the lowercased form, but the set was keyed by whatever casing the
  // caller presented — so a burn recorded mixed-case was simply absent when the
  // next request arrived in lowercase, the identical receipt verified again, and
  // the paid action ran again. Every distinct spelling of one burn was another
  // intervention, bounded only by how many letters the hash happened to contain.
  //
  // The test above missed this for a whole suite-run because it replays the same
  // string it recorded: `'0x' + 'a5'.repeat(32)` is already lowercase, so both
  // sides of its pair agreed by accident. This one varies the spelling on
  // purpose, which is the only way it would have failed before the fix.
  const MIXED = '0x' + 'd4cB9a7E'.repeat(8);
  const variants = [MIXED, MIXED.toLowerCase(), '0x' + 'd4cB9a7E'.repeat(8).toUpperCase()];
  assert.equal(new Set(variants).size, 3, 'three spellings of one burn, three distinct strings');

  const stored: string[] = [];
  setBurnLedger({ load: async () => [], add: (h) => { stored.push(h); } });

  const PRICE = 100_000n * 10n ** 18n;
  const srv = rpcStub((method, data) => (data === '0x313ce567'
    ? DEC18
    : {
        status: '0x1',
        blockNumber: '0x80',
        logs: [{
          address: process.env.ABYS_TOKEN_ADDRESS,
          topics: [TRANSFER_TOPIC, `0x${'cd'.repeat(20).padStart(64, '0')}`, BURN_SINK],
          data: `0x${PRICE.toString(16)}`,
        }],
      }));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const offer = (await burnOffer(url, 'feed'))!;
    let accepted = 0;
    for (const h of variants) {
      const v = await verifyBurnReceipt(url, offer, h);
      if (v.ok) {
        accepted += 1;
        recordBurnReceipt(h); // what the handler does once the action succeeded
      }
    }
    assert.equal(accepted, 1, `one burn settled ${accepted} times; only the first spelling may buy anything`);

    // What an eviction hydrates back has to be canonical too, or the guard holds
    // only as long as this isolate does.
    assert.deepEqual(stored, [MIXED.toLowerCase()], 'the ledger is written in the one canonical form');

    // Receipts already sitting in production storage from before this was fixed
    // are mixed case, and that is the case this has to survive: hydrating them
    // must guard both spellings, not just the one they were stored under.
    const legacy = '0x' + 'e5fA0b1C'.repeat(8);
    setBurnLedger({ load: async () => [legacy], add: () => {} });
    await hydrateReceipts();
    assert.ok(isBurnRecorded(legacy), 'a legacy mixed-case entry guards the spelling it arrived in');
    assert.ok(isBurnRecorded(legacy.toLowerCase()), 'and the canonical one, which is the whole point');

    // Normalizing must not collapse distinct payments into a single bucket.
    assert.ok(!isBurnRecorded('0x' + 'f6eB1c2D'.repeat(8)), 'a different hash is still its own money');
  } finally {
    srv.close();
    setBurnLedger({ load: async () => [], add: () => {} });
  }
});

test('passes and burners survive a restart through the store', async () => {
  const mem = { passes: [] as [string, number][], burners: [] as [string, { total: number; last: number }][] };
  const store = {
    load: async () => mem,
    save: (s: typeof mem) => { mem.passes = s.passes; mem.burners = s.burners; },
  };
  // The shared receipt stub burns from this address, so the pass lands on it.
  const payer = '0x' + 'ab'.repeat(20);
  const first = createApp({ seed: 1, store });
  const hash = '0x' + 'd1'.repeat(32);
  const grant = await first.fetch(
    new Request('http://localhost/intervene', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment-tx': hash },
      body: JSON.stringify({ type: 'pass' }),
    }),
  );
  assert.equal(grant.status, 200, 'a verified burn must grant the pass');
  // A fresh isolate hydrates from the same store: the pass and the recorded
  // receipt both survive.
  const second = createApp({ seed: 1, store });
  await second.hydrate();
  const exportRes = await second.fetch(new Request(`http://localhost/export?pass=${payer}`));
  assert.equal(exportRes.status, 200, 'the pass must survive a restart');
});

test('/reports opens on the burn and scores it 400 ticks later', async () => {
  const app = createApp({ seed: 1 });
  const hash = '0x' + 'c7'.repeat(32);
  const paid = await app.fetch(
    post('/intervene', { type: 'feed', x: 500, y: 500, radius: 300 }, { 'x-payment-tx': hash }),
  );
  assert.equal(paid.status, 200, 'the shared stub settles a feed-price burn');

  type Report = {
    tx: string; type: string; atTick: number; affectedIds: number[];
    score?: number; survivors?: number;
  };
  const get = async () => ((await (await app.fetch(new Request('http://localhost/reports'))).json()) as {
    reports: Report[];
  }).reports;

  const open = (await get()).find((r) => r.tx === hash);
  assert.ok(open, 'a paid intervention opens a battle report');
  assert.equal(open.type, 'feed');
  assert.equal(open.score, undefined, 'nothing is scored before the window closes');
  assert.ok(open.affectedIds.length > 0, 'the report names everyone caught in it');

  for (let i = 0; i < 401; i++) await app.fetch(post('/tick', {}));
  const scored = (await get()).find((r) => r.tx === hash)!;
  assert.equal(typeof scored.score, 'number', 'the window has closed, so the report is scored');
  assert.ok(scored.survivors! <= scored.affectedIds.length);
  assert.equal(scored.score, scored.survivors, 'a feed is judged by who lived through it');
});

test('the render payload carries the daily report, the memorial ring and the eater trails', async () => {
  const app = createApp({ seed: 1 });
  for (let i = 0; i < 3; i++) await app.fetch(post('/tick', {}));
  const w = (await (await app.fetch(new Request('http://localhost/world'))).json()) as {
    daily: {
      day: number;
      maxFall: { day: number; size: number; hash: string } | null;
      winner: { species: string; kills: number } | null;
      biggestIntervention: unknown;
      deaths: Record<string, number>;
      mvp: { strongest: unknown; burner: unknown; saddest: unknown };
    };
    obituaries: { id: number; cause: string; diedTick: number; titles: string[] }[];
    eaters: Record<string, number[]>;
    creatures: { offspring: number; maxMeal: number }[];
  };
  assert.equal(typeof w.daily.day, 'number');
  assert.equal(typeof w.daily.deaths, 'object');
  assert.ok('mvp' in w.daily, 'the day names an MVP');
  assert.ok(w.daily.maxFall === null || w.daily.maxFall.hash, 'no fall today reads as no line at all');
  assert.ok(Array.isArray(w.obituaries));
  assert.ok(w.obituaries.length <= 12, 'the payload ships the near ring, not the whole book');
  for (const o of w.obituaries) {
    assert.ok(typeof o.cause === 'string' && typeof o.diedTick === 'number');
    assert.ok(Array.isArray(o.titles));
  }
  assert.equal(typeof w.eaters, 'object');
  assert.ok(w.creatures.every((c) => typeof c.offspring === 'number' && typeof c.maxMeal === 'number'));
});

type Who = {
  known: boolean; burned: number; burns: number; byType: Record<string, number>;
  badges: string[]; rank: number | null; cheer: string | null;
  pass: { active: boolean; until: number | null };
  reports: { tx: string; type: string; affected: number; score?: number }[];
};

test('/who reports one address standing, badges and rank', async () => {
  const app = createApp({ seed: 1 });
  const payer = '0x' + 'ab'.repeat(20);
  const hash = '0x' + 'e2'.repeat(32);
  const paid = await app.fetch(
    post('/intervene', { type: 'feed', x: 500, y: 500, radius: 300 }, { 'x-payment-tx': hash }),
  );
  assert.equal(paid.status, 200);

  const who = async (addr: string) =>
    (await (await app.fetch(new Request(`http://localhost/who?addr=${addr}`))).json()) as Who;

  const me = await who(payer);
  assert.equal(me.known, true);
  assert.equal(me.burned, 100_000);
  assert.equal(me.burns, 1);
  assert.equal(me.byType.feed, 1);
  assert.ok(me.badges.includes('firstBurn'));
  assert.equal(me.rank, 1);
  assert.equal(me.reports[0].tx, hash);
  assert.equal(me.reports[0].affected > 0, true);

  const stranger = await who('0x' + '99'.repeat(20));
  assert.equal(stranger.known, false);
  assert.equal(stranger.burned, 0);
  assert.deepEqual(stranger.badges, []);
  assert.equal(stranger.rank, null);

  const bad = await app.fetch(new Request('http://localhost/who?addr=0x123'));
  assert.equal(bad.status, 400);
});

test('badges are derived from the record, never stored', async () => {
  const { badgesFor, badgeBits, normalizeProfile, BADGES } = await import('../src/handler.js');
  assert.deepEqual(badgesFor(normalizeProfile(null), false), []);
  // A row written before actions were counted still proves at least one burn.
  assert.deepEqual(badgesFor(normalizeProfile({ total: 5, last: 1 }), false), ['firstBurn']);

  const killer = normalizeProfile({
    burns: 3,
    byType: { poison: 3 },
    bestByType: { poison: 12, feed: 2 },
    maxAffected: 60,
    total: 1_200_000,
  });
  const got = badgesFor(killer, true);
  for (const id of ['firstBurn', 'executioner', 'whalefall', 'patron', 'passHolder']) {
    assert.ok(got.includes(id), `${id} should be earned`);
  }
  assert.ok(!got.includes('benefactor'), 'a feed that saved two is not patronage');
  assert.ok(!got.includes('weathermaker'), 'no weather bought, no weather badge');

  const bits = badgeBits(killer, true);
  assert.deepEqual(BADGES.filter((_, i) => bits & (1 << i)), got, 'the bitmask follows BADGES order');
});

test('cheering is free, but only an address the tank has seen may vote', async () => {
  const app = createApp({ seed: 1 });
  const payer = '0x' + 'ab'.repeat(20);
  const cheer = (addr: string, species: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request('http://localhost/cheer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ addr, species }),
    }));

  const stranger = await cheer('0x' + '55'.repeat(20), 'WHALE');
  assert.equal(stranger.status, 403, 'no footprint, no vote');

  await app.fetch(
    post('/intervene', { type: 'feed', x: 400, y: 400, radius: 200 }, { 'x-payment-tx': '0x' + 'e3'.repeat(32) }),
  );
  const first = await cheer(payer, 'WHALE');
  assert.equal(first.status, 200);
  const body = (await first.json()) as { cheer: string; cheers: Record<string, number> };
  assert.equal(body.cheer, 'WHALE');
  assert.equal(body.cheers.WHALE, 1);

  const same = await cheer(payer, 'WHALE');
  assert.equal(same.status, 200, 'repeating your own vote is a no-op, not a rate limit');

  const flip = await cheer(payer, 'APE');
  assert.equal(flip.status, 429, 'switching sides waits out the cooldown');

  const bogus = await cheer(payer, 'UNICORN');
  assert.equal(bogus.status, 400);

  const foreign = await cheer(payer, 'APE', { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403, 'a foreign page cannot vote for you');
});

test('the board in the payload carries burns, badge bits and the faction tally', async () => {
  const app = createApp({ seed: 1 });
  const payer = '0x' + 'ab'.repeat(20);
  await app.fetch(
    post('/intervene', { type: 'feed', x: 300, y: 300, radius: 100 }, { 'x-payment-tx': '0x' + 'e4'.repeat(32) }),
  );
  await app.fetch(new Request('http://localhost/cheer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ addr: payer, species: 'ALGO' }),
  }));
  const w = (await (await app.fetch(new Request('http://localhost/world'))).json()) as {
    burners: { address: string; total: number; burns: number; cheer: string | null; badges: number }[];
    cheers: Record<string, number>;
  };
  const row = w.burners.find((b) => b.address === payer);
  assert.ok(row, 'the payer belongs on the board');
  assert.equal(row.burns, 1);
  assert.equal(row.cheer, 'ALGO');
  assert.equal(typeof row.badges, 'number');
  assert.equal(row.badges & 1, 1, 'the firstBurn bit is set');
  assert.deepEqual(w.cheers, { ALGO: 1 });
});

test('a store row from before profiles existed loads as a full one', async () => {
  const mem: { passes: [string, number][]; burners: [string, { total: number; last: number }][] } = {
    passes: [],
    burners: [['0x' + 'ab'.repeat(20), { total: 250_000, last: 1 }]],
  };
  const store = {
    load: async () => mem,
    save: (s: { passes: [string, number][]; burners: [string, unknown][] }) => { mem.passes = s.passes; },
  };
  const app = createApp({ seed: 1, store });
  await app.hydrate();
  const who = (await (await app.fetch(
    new Request(`http://localhost/who?addr=0x${'ab'.repeat(20)}`),
  )).json()) as Who;
  assert.equal(who.burned, 250_000);
  assert.equal(who.burns, 1);
  assert.ok(who.badges.includes('firstBurn'));
});

/* ---------- the paid actions aimed at one creature: name / wish / mutate / ark ---------- */

/** Who the shared receipt stub burns from, and so who every paid action is attributed to. */
const STUB_PAYER = '0x' + 'ab'.repeat(20);

/** A Transfer log to the burn sink for `whole` ABYS at 18 decimals. */
function burnLog(whole: bigint) {
  return {
    address: process.env.ABYS_TOKEN_ADDRESS,
    topics: [TRANSFER_TOPIC, `0x${'ab'.repeat(20).padStart(64, '0')}`, BURN_SINK],
    data: '0x' + (whole * 10n ** 18n).toString(16),
  };
}

test('state hands the client the price list, the legend line and the editable traits', async () => {
  const app = createApp({ seed: 1 });
  const s = (await (await app.fetch(new Request('http://localhost/state'))).json()) as {
    prices: Record<string, string>;
    legendaryNamePrice: string;
    legendary: { generation: number; kills: number };
    geneTraits: string[];
  };
  assert.deepEqual(
    [s.prices.name, s.prices.wish, s.prices.mutate, s.prices.ark],
    ['50000', '25000', '100000', '75000'],
  );
  assert.equal(s.legendaryNamePrice, '500000', 'ten times the base, quoted by the server so the card cannot disagree with the 402');
  assert.deepEqual(s.legendary, { generation: 5, kills: 5 });
  assert.deepEqual(s.geneTraits, ['speed', 'size', 'aggression', 'fertility', 'perception']);
});

test('a targeted action validates its whole request before any money moves', async () => {
  const app = createApp({ seed: 1 });
  const id = app.world.creatures[0].id;
  const hash = '0x' + 'e5'.repeat(32);
  for (const body of [
    { type: 'name', creatureId: 999_999, name: 'Ghost' },
    { type: 'name', creatureId: 1.5, name: 'Moby' },
    { type: 'name', creatureId: id, name: '' },
    { type: 'name', creatureId: id, name: '   ' },
    { type: 'name', creatureId: id, name: 'x'.repeat(25) },
    { type: 'name', creatureId: id, name: 42 },
    { type: 'mutate', creatureId: id, trait: 'wings', direction: 'boost' },
    { type: 'mutate', creatureId: id, trait: 'speed', direction: 'sideways' },
    { type: 'mutate', creatureId: id, trait: 'speed' },
    { type: 'mutate', creatureId: -1, trait: 'speed', direction: 'boost' },
    { type: 'ark', creatureId: 999_999 },
    { type: 'ark' },
    { type: 'wish', message: '' },
    { type: 'wish', message: 'x'.repeat(61) },
    { type: 'wish', message: 7 },
    { type: 'wish', message: 'hi', x: -1, y: 5 },
    { type: 'wish', message: 'hi', x: 5, y: 99_999 },
    { type: 'wish', message: 'hi', x: 5 },
  ]) {
    const res = await app.fetch(post('/intervene', body, { 'x-payment-tx': hash }));
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused before the burn is looked at`);
  }
  // Proof the receipt survived every rejection: it still buys something.
  const good = await app.fetch(post('/intervene', { type: 'wish', message: 'be kind' }, { 'x-payment-tx': hash }));
  assert.equal(good.status, 200, 'a rejected request must not consume the burn');
});

test('paid words are stripped of markup before they enter the world', async () => {
  const app = createApp({ seed: 1 });
  const id = app.world.creatures[0].id;
  const res = await app.fetch(post(
    '/intervene',
    { type: 'name', creatureId: id, name: '<img src=x onerror=alert(1)>Moby' },
    { 'x-payment-tx': '0x' + 'e6'.repeat(32) },
  ));
  assert.equal(res.status, 200);
  const c = app.world.creatures.find((x) => x.id === id)!;
  // Stripped rather than escaped: the same string is dropped into innerHTML, a
  // canvas fillText and a CSV export, so nothing downstream has to remember.
  assert.equal(c.customName, 'Moby');
  assert.ok(!/[<>]/.test(c.customName ?? ''), 'no angle bracket survives into the world');
  // A name that was only markup sanitizes to nothing, and so is refused.
  const empty = await app.fetch(post(
    '/intervene',
    { type: 'wish', message: '<b></b>' },
    { 'x-payment-tx': '0x' + 'ec'.repeat(32) },
  ));
  assert.equal(empty.status, 400);
});

test('naming a legend is quoted at ten times the base, and a base receipt will not buy it', async () => {
  const app = createApp({ seed: 1 });
  const legend = app.world.creatures[0];
  legend.generation = 9;
  const quote = await app.fetch(post('/intervene', { type: 'name', creatureId: legend.id, name: 'Legend' }));
  assert.equal(quote.status, 402);
  const asked = (await quote.json()) as {
    accepts: { amount: string }[]; price: string; legendary: boolean;
  };
  assert.equal(asked.accepts[0].amount, (500_000n * 10n ** 18n).toString());
  assert.equal(asked.price, '500000 ABYS');
  assert.equal(asked.legendary, true, 'the wallet is told why the number is what it is');
  // The shared stub burns 100,000, so it cannot reach a legend's price.
  const short = await app.fetch(post(
    '/intervene',
    { type: 'name', creatureId: legend.id, name: 'Legend' },
    { 'x-payment-tx': '0x' + 'f1'.repeat(32) },
  ));
  assert.equal(short.status, 402);
  assert.equal((await short.json() as { reason: string }).reason, 'no burn of the asked amount in this transaction');
  // A fish beside it is base-priced, so the two are never confused.
  const fish = app.world.creatures.find((c) => c.generation < 5 && c.kills < 5)!;
  const cheap = await app.fetch(post(
    '/intervene',
    { type: 'name', creatureId: fish.id, name: 'Tiny' },
    { 'x-payment-tx': '0x' + 'f2'.repeat(32) },
  ));
  assert.equal(cheap.status, 200, 'the same receipt is enough for a fish');
  const sold = (await cheap.json()) as { legendary: boolean; price: string; receipt: string };
  assert.equal(sold.legendary, false);
  assert.equal(sold.price, '50000 ABYS');
  assert.match(sold.receipt, /Tiny/);
});

test('a second ark ticket on one body is refused before it is charged for', async () => {
  const app = createApp({ seed: 1 });
  const id = app.world.creatures[0].id;
  const first = await app.fetch(post('/intervene', { type: 'ark', creatureId: id }, { 'x-payment-tx': '0x' + 'e7'.repeat(32) }));
  assert.equal(first.status, 200);
  const bought = (await first.json()) as { ok: boolean; price: string; affected: number };
  assert.equal(bought.price, '75000 ABYS');
  assert.equal(bought.affected, 1);
  const hash = '0x' + 'e8'.repeat(32);
  // The cheap path: the body is already spoken for, so this is caught while the
  // request is still being validated and no burn is ever looked at.
  const second = await app.fetch(post('/intervene', { type: 'ark', creatureId: id }, { 'x-payment-tx': hash }));
  assert.equal(second.status, 400, 'selling a second ticket to one body must not even reach the payment');
  assert.match((await second.json() as { error: string }).error, /already holds an ark ticket/);
  const reused = await app.fetch(post('/intervene', { type: 'feed', x: 500, y: 500 }, { 'x-payment-tx': hash }));
  assert.equal(reused.status, 200, 'a rejected sale must leave the burn untouched');
});

test('an ark ticket bought by somebody else mid-verification refunds the loser', async () => {
  // The race the pre-payment check cannot see: two wallets aim at one body, and
  // the other receipt clears first. The loser must not be charged for a ticket
  // that no longer exists.
  type Tank = ReturnType<typeof createApp>['world'];
  let tank: Tank | null = null;
  let target = 0;
  const srv = rpcStub((_method, data) => {
    if (data === '0x313ce567') return DEC18;
    const c = tank?.creatures.find((x) => x.id === target);
    if (c) {
      c.arkProtected = true;
      c.arkBy = '0x' + 'cc'.repeat(20);
    }
    return { status: '0x1', blockNumber: '0x80', logs: [burnLog(100_000n)] };
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const app = createApp({ seed: 1, rpc: url });
    tank = app.world;
    target = app.world.creatures[0].id;
    const hash = '0x' + 'ed'.repeat(32);
    const res = await app.fetch(post('/intervene', { type: 'ark', creatureId: target }, { 'x-payment-tx': hash }));
    assert.equal(res.status, 409, 'the body was spoken for while the receipt was in flight');
    const body = (await res.json()) as { refunded: boolean; tx: string };
    assert.equal(body.refunded, true);
    assert.equal(body.tx, hash);
    // The refund is the whole point: that same burn is still the payer's to
    // spend, and it still buys a ticket — just on a body nobody has spoken for.
    const elsewhere = app.world.creatures[1].id;
    const retry = await app.fetch(post('/intervene', { type: 'ark', creatureId: elsewhere }, { 'x-payment-tx': hash }));
    assert.equal(retry.status, 200, 'a refunded receipt must still be spendable');
    assert.equal(
      app.world.creatures.find((c) => c.id === elsewhere)?.arkProtected,
      true,
      'and spend it on something real, not into thin air',
    );
  } finally {
    srv.close();
  }
});

test('a subject that dies mid-verification refunds the receipt instead of buying nothing', async () => {
  // The tank keeps ticking while a receipt is being checked against the chain.
  // Kill the subject from inside that round trip, which is exactly when it would
  // really happen, and assert the payer is not left holding a spent burn.
  let tank: { creatures: { id: number }[] } | null = null;
  let victim = 0;
  const srv = rpcStub((_method, data) => {
    if (data === '0x313ce567') return DEC18;
    if (tank) tank.creatures = tank.creatures.filter((c) => c.id !== victim);
    return { status: '0x1', blockNumber: '0x80', logs: [burnLog(100_000n)] };
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const app = createApp({ seed: 1, rpc: url });
    tank = app.world;
    victim = app.world.creatures[0].id;
    const hash = '0x' + 'ea'.repeat(32);
    const res = await app.fetch(post('/intervene', { type: 'ark', creatureId: victim }, { 'x-payment-tx': hash }));
    assert.equal(res.status, 409, 'a sale with nothing to sell must be refused, not settled');
    const body = (await res.json()) as { refunded: boolean; tx: string };
    assert.equal(body.refunded, true);
    assert.equal(body.tx, hash);
    // Aim the same burn at somebody still swimming.
    const survivor = app.world.creatures[0].id;
    const retry = await app.fetch(post('/intervene', { type: 'ark', creatureId: survivor }, { 'x-payment-tx': hash }));
    assert.equal(retry.status, 200, 'the receipt was never consumed by the refused sale');
  } finally {
    srv.close();
  }
});

test('a paid wish joins the meteor rain with its words and the address that paid', async () => {
  const app = createApp({ seed: 1 });
  const res = await app.fetch(post('/intervene', { type: 'wish', message: 'be kind' }, { 'x-payment-tx': '0x' + 'eb'.repeat(32) }));
  assert.equal(res.status, 200);
  const sold = (await res.json()) as { at: { x: number; y: number } | null; price: string };
  assert.equal(sold.price, '25000 ABYS');
  assert.ok(sold.at, 'the receipt says where it fell');
  const snap = (await (await app.fetch(new Request('http://localhost/snapshot'))).json()) as {
    txRain: { hash: string; size: number; x: number; y: number; wish?: { message: string; addr: string } }[];
  };
  const drop = snap.txRain.find((m) => m.wish);
  assert.ok(drop, 'the wish rides the rain every viewer is already rendering');
  assert.equal(drop!.wish!.message, 'be kind');
  assert.equal(drop!.wish!.addr, STUB_PAYER, 'the words stay linked to the wallet that paid for them');
  assert.deepEqual({ x: drop!.x, y: drop!.y }, sold.at, 'the rain falls where the receipt said it did');
});

test('the render payload carries paid identity, and only for those who have any', async () => {
  const app = createApp({ seed: 1 });
  const [a, b] = app.world.creatures;
  const bornA = a.name;
  applyIntervention(app.world, { type: 'name', creatureId: a.id, name: 'Moby' });
  applyIntervention(app.world, { type: 'ark', creatureId: b.id }, { payer: STUB_PAYER });
  const w = (await (await app.fetch(new Request('http://localhost/world'))).json()) as {
    creatures: {
      id: number; name: string; baseName?: string;
      ark?: boolean; arkBy?: string | null; legendary?: boolean;
    }[];
  };
  const ra = w.creatures.find((c) => c.id === a.id)!;
  assert.equal(ra.name, 'Moby', 'the tank speaks the paid name');
  assert.equal(ra.baseName, bornA, 'and hands down the codename it replaced');
  assert.equal(ra.ark, undefined);
  const rb = w.creatures.find((c) => c.id === b.id)!;
  assert.equal(rb.ark, true);
  assert.equal(rb.arkBy, STUB_PAYER);
  assert.equal(rb.baseName, undefined);
  const plain = w.creatures.find((c) => c.id !== a.id && c.id !== b.id)!;
  assert.equal(plain.baseName, undefined, 'an unmodified tank pays nothing for the extra fields');
  assert.equal(plain.ark, undefined);
  assert.equal(plain.legendary, undefined);
});

/* ---------- the durable wall clock behind catchUp ---------- */

/**
 * A Worker isolate is torn down between requests, and the cron that keeps an
 * unwatched tank alive lands on a cold one every time. `catchUp()` measures the
 * owed ticks against `lastAdvanceAt`, so unless that clock is persisted every
 * cold boot starts from `Date.now()`, finds zero elapsed, and silently forgives
 * the whole idle gap. That is the regression which made the declared cron a
 * no-op: the world only advanced while somebody happened to be watching.
 *
 * Both feeds are stubbed because `catchUp()` samples the chain for real.
 */
const offlineFeeds: { chainFeed: ChainFeed; marketFeed: MarketFeed } = {
  chainFeed: {
    name: 'test-chain',
    sample: async () => ({ temp: 0.5, delta: 0, blockNumber: 1 }),
    recentTxs: () => [],
  },
  marketFeed: { name: 'test-market', sample: async () => ({ temp: 0.5 }) },
};

/** An in-memory stand-in for the Durable Object's ledger storage. */
function memStore() {
  let state: Partial<LedgerSnapshot> = {};
  const store: WorldStore = {
    load: async () => state,
    save: (s) => { state = s; },
  };
  return {
    store,
    seedClock: (t: number) => { state = { ...state, lastAdvanceAt: t }; },
    clock: () => state.lastAdvanceAt,
    seedFeedState: (f: FeedState) => { state = { ...state, feedState: f }; },
    feedState: () => state.feedState,
  };
}

test('a cold isolate replays the idle gap from the persisted wall clock', async () => {
  const m = memStore();
  // A minute of unattended wall clock, owed by whoever boots next.
  m.seedClock(Date.now() - 60_000);
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  const advanced = await app.catchUp();
  assert.equal(advanced, 240, '60s at 250ms/tick is 240 ticks, and the cap is 240');
  assert.equal(app.world.tick, 240, 'and the world actually lived them');
  assert.ok(
    (m.clock() ?? 0) > Date.now() - 5_000,
    'the advanced clock is persisted, so the next isolate inherits it rather than the gap',
  );
});

test('with no persisted clock a first boot owes nothing and stays put', async () => {
  const m = memStore();
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  assert.equal(await app.catchUp(), 0, 'a world with no history has no gap to replay');
  assert.equal(app.world.tick, 0);
});

test('a clock from the future is ignored instead of pinning the tank', async () => {
  const m = memStore();
  // Clock skew between isolates must not be able to freeze the world: hydrate
  // only ever moves the local clock backwards, never forwards.
  m.seedClock(Date.now() + 60_000);
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  assert.equal(await app.catchUp(), 0);
  assert.equal(app.world.tick, 0);
});

/* ---------- the chain feed's heartbeat in a runtime with no interval ---------- */

/**
 * Overrides the transaction body the stub serves, so a test can put a flow on a
 * rail other than x402. `to: null` models a contract creation, which has no
 * destination to classify, and `amount` overrides the size of the transfer that
 * block's log reports.
 */
type StubTx = { to?: string | null; input?: string; amount?: number };

/**
 * Either one body for the whole window, or a function of the block number so a
 * single poll can land flows on more than one rail. The second form is what lets
 * a test compare venues against each other rather than only against a fixed
 * expectation.
 */
type StubTxAt = StubTx | ((block: number) => StubTx | null | undefined);

/**
 * A JSON-RPC stub answering the calls a poll makes: the head, the log chunks,
 * and the full blocks that carry each transaction's destination and calldata.
 * `transfersPerChunk` fills each `eth_getLogs` range with that many USDC
 * transfers, enough to give the flow ring and the pulse series something to
 * hold. By default every block reports its transfer as an EIP-3009
 * authorization submitted by a relayer against the USDC contract itself, which
 * is the x402 rail, so a poll that resolves venues at all is observable in
 * `stats.x402Count`; pass `tx` to put it on a different one.
 * `calls` counts polls and block fetches so a test can tell one round of RPC
 * from two, `setHead` moves the chain forward between polls to widen a span,
 * and `delayMs` makes a poll slow enough to outlast the feed's own throttle —
 * without it a local stub answers in under a millisecond and the throttle can
 * never be observed expiring.
 */
function chainRpcStub(head: number, transfersPerChunk: number, delayMs = 0, tx?: StubTxAt) {
  const from = '0x' + 'cd'.repeat(20);
  const to = '0x' + 'ef'.repeat(20);
  const txAt = (n: number): StubTx => {
    const b = typeof tx === 'function' ? tx(n) : tx;
    return b ?? {};
  };
  /**
   * Submits the transfer on the payer's behalf, which is what a facilitator does
   * for an EIP-3009 authorization. The venue no longer depends on noticing that:
   * it is read off the transaction's destination and calldata, so the default
   * body below is addressed to the USDC contract itself and carries
   * `transferWithAuthorization`. `relayer` stays in the body because a real one
   * has it, and because a stub that quietly dropped the field the old heuristic
   * needed would not prove the new one is independent of it.
   */
  const relayer = '0x' + 'ab'.repeat(20);
  /** transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) */
  const X402_INPUT = '0xe3ee160e' + '00'.repeat(32);
  const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
  /**
   * Keyed by the block that carries it, so `eth_getLogs` and
   * `eth_getBlockByNumber` agree on which hash belongs to which block and a
   * venue lookup can actually hit.
   */
  const txHash = (n: number) => `0x${(n * 100).toString(16).padStart(64, '0')}`;
  const calls = { heads: 0, blocks: 0 };
  let currentHead = head;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const call = JSON.parse(body || '{}') as { method?: string; params?: unknown[] };
    // Counted on arrival, before the delay: a redundant poll is dispatched
    // asynchronously, and counting it only when answered would let an assertion
    // run before the extra request had shown up.
    if (call.method === 'eth_blockNumber') calls.heads++;
    if (call.method === 'eth_getBlockByNumber') calls.blocks++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    let result: unknown = { transactions: [] };
    if (call.method === 'eth_blockNumber') {
      result = `0x${currentHead.toString(16)}`;
    } else if (call.method === 'eth_getBlockByNumber') {
      const n = parseInt(call.params?.[0] as string, 16);
      const b = txAt(n);
      result = {
        number: call.params?.[0],
        transactions: [{
          hash: txHash(n),
          from: relayer,
          to: 'to' in b ? b.to : ARC_USDC,
          input: b.input ?? X402_INPUT,
        }],
      };
    } else if (call.method === 'eth_getLogs') {
      const p = (call.params?.[0] ?? {}) as Record<string, string>;
      const start = parseInt(p.fromBlock, 16);
      result = Array.from({ length: transfersPerChunk }, (_, i) => {
        // The amount is per block for the same reason the body is: ranking two
        // venues against each other needs one to carry more value and the other
        // to carry more transfers, and a stub that fixes the value can only ever
        // produce the two in the same order.
        const amt = txAt(start + i).amount ?? 1_000_000;
        return {
          address: ARC_USDC,
          topics: [TRANSFER_TOPIC, topic(from), topic(to)],
          data: `0x${amt.toString(16).padStart(64, '0')}`,
          blockNumber: `0x${(start + i).toString(16)}`,
          transactionHash: txHash(start + i),
        };
      });
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  return { server, calls, setHead: (n: number) => { currentHead = n; } };
}

test("a feed that has not landed a poll cannot claim 'live'", async () => {
  // `sample()` starts its poll without awaiting it, which is right for a 250ms
  // tick loop and fatal in a Worker: the invocation ends when the response is
  // sent, the un-awaited backfill is cancelled, and the next request rebuilds
  // the feed from `lastBlock = -1`. Production ran like that for long enough to
  // have a tank permanently pinned at 0.5 with zero transfers observed — while
  // /state reported `feedStatus: "live"` and /observe reported `available: true`,
  // because both only ever checked whether Arc was *configured*.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server: rpc } = chainRpcStub(HEAD, 2, 60);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  try {
    // A throttle far shorter than one poll, so the interval is guaranteed to have
    // expired by the time the poll returns — which is exactly the moment a
    // throttle measured from the request would let a second, redundant poll out.
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, {
      backfillBlocks: 8,
      pollEveryMs: 20,
    });
    const app = createApp({ seed: 1, chainFeed: feed, store: memStore().store });
    const read = async () =>
      (await (await app.fetch(new Request('http://localhost/state'))).json()) as {
        feedStatus: string;
        blockNumber?: number;
        chainTemp: number;
      };
    const poke = () => app.fetch(new Request('http://localhost/tick', { method: 'POST' }));

    await poke();
    const cold = await read();
    assert.equal(cold.feedStatus, 'synthetic', 'configured is not the same as working');
    assert.equal(cold.blockNumber, undefined);
    assert.equal(cold.chainTemp, 0.5, 'and the tank is being fed the initializer');

    // The heartbeat: the one caller with nobody waiting on it can afford to
    // block until the backfill finishes, which is what lets it complete at all.
    await app.warmFeed();

    await poke();
    const warm = await read();
    assert.equal(warm.blockNumber, HEAD, 'the poll it waited for actually landed');
    assert.equal(warm.feedStatus, 'live');
    // Still 0.5, and correctly so: the temperature is a rank percentile, and the
    // first reading into an empty window is the neutral rank by construction.
    // What warming buys is the *next* reading being able to move.
    assert.equal(warm.chainTemp, 0.5);

    const observe = (await
      (await app.fetch(new Request('http://localhost/observe'))).json()) as {
      available: boolean;
      lastBlock: number;
      stats: { transfers: number; volume: number };
      pulse: unknown[];
    };
    assert.equal(observe.available, true);
    assert.equal(observe.lastBlock, HEAD);
    assert.ok(observe.stats.transfers > 0, 'a warm feed has actually seen transfers');
    assert.ok(observe.pulse.length > 0, 'and has a pulse series to chart');
  } finally {
    rpc.close();
  }
});

test('the heartbeat polls once, not twice, for the same minute of chain', async () => {
  // `warmFeed()` exists so the cron can block until a poll lands. If the poll
  // throttle were measured from when the request *started*, the advance that
  // follows a multi-second backfill would find the interval already elapsed and
  // kick off a second poll for data the feed is already holding — doubling the
  // RPC load and putting two pulse buckets on one minute. So the throttle resets
  // on completion. This walks the cron's exact order on a cold feed; the stub
  // delays every call so a poll genuinely outlasts the throttle, which an
  // instant local stub never does.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const { server: rpc, calls } = chainRpcStub(8192, 2, 60);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, {
      backfillBlocks: 8,
      pollEveryMs: 20, // far shorter than one poll, so the interval always expires
    });
    const app = createApp({ seed: 1, chainFeed: feed, store: memStore().store });
    await app.warmFeed();
    assert.equal(calls.heads, 1, 'a cold heartbeat polls once');
    await app.fetch(new Request('http://localhost/tick', { method: 'POST' }));
    // A poll the advance should not have started is dispatched but not yet
    // answered when the response returns, so give it room to arrive before
    // counting. Longer than the stub's delay, so this is not a race.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      calls.heads,
      1,
      'and the advance that follows must not re-poll for data it already has',
    );
  } finally {
    rpc.close();
  }
});

test("catchUp deals the interval's meteors across the replay, not into one tick", async () => {
  // `advance()` samples the chain once and drains one tick's worth of meteors,
  // but the ticks catchUp replays cover a whole interval of real chain time.
  // Handing the replay nothing starved the one food source that carries
  // provenance: at cron cadence that is 6 meteors a minute against the ~13
  // transfers a second a live Arc poll actually yields, so on the deployed tank
  // nothing ever rained.
  let askedFor = 0;
  const BATCH = 60;
  const rain: ChainFeed = {
    name: 'test-rain',
    sample: async () => ({ temp: 0.5, delta: 0, blockNumber: 1 }),
    recentTxs: (max = 6) => {
      askedFor = Math.max(askedFor, max);
      return Array.from({ length: Math.min(max, BATCH) }, (_, i) => ({
        // Distinct hashes, so the pellets each one spawns can be counted.
        hash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
        size: 1, // 3 * size^2 = 3 pellets each
        usd: 1,
      }));
    },
  };
  const m = memStore();
  m.seedClock(Date.now() - 5_000); // ~20 ticks owed
  const app = createApp({
    seed: 1,
    store: m.store,
    chainFeed: rain,
    marketFeed: offlineFeeds.marketFeed,
  });
  const advanced = await app.catchUp();
  assert.ok(advanced >= 20, `expected ~20 ticks owed, got ${advanced}`);
  assert.equal(askedFor, 6 * (advanced - 1), 'the replay budgets the whole interval');

  // The boundary that matters: one tick's drain is 6, so more than six distinct
  // source hashes can only mean the meteors reached the replayed ticks too.
  const distinct = new Set(app.world.foods.filter((f) => f.src).map((f) => f.src));
  assert.ok(
    distinct.size > 6,
    `only ${distinct.size} distinct transfer hashes fed the tank; the replay was starved`,
  );
});

test('a poll wider than the old 24-block gate still resolves x402', async () => {
  // Sender resolution used to be skipped unless a poll spanned 24 blocks or
  // fewer. That ceiling was sized for a 250ms tick loop, where a poll is four
  // blocks; a runtime that polls once a minute spans ~120, because Arc produces
  // a block every 500ms (measured against mainnet, not assumed). So the gate
  // never opened, every flow came back `x402: null`, and the machine-payment
  // share this observatory is named after read as exactly zero in production —
  // while a viewer polling fast enough to squeeze under the gate saw real ones,
  // which made it look intermittent rather than broken.
  //
  // Nothing caught it because the stub answered `eth_getBlockByNumber` from the
  // default branch with an empty tx list, so senders were unresolvable in tests
  // too: same zero, different reason, equally silent.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const { server: rpc, calls, setHead } = chainRpcStub(4096, 2);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, {
      backfillBlocks: 32,
      // No throttle at all, rather than a short one. `poll()` stamps
      // `lastPollAt` when it *finishes*, so any small throttle leaves the second
      // poll gated on how long the assertions in between happened to take, and
      // the test passes or fails on machine speed alone.
      pollEveryMs: 0,
    });
    // The first poll is the backfill, which resolves no senders by design: it
    // covers 30 minutes of history and full blocks are not affordable there.
    await feed.settle();
    assert.equal(calls.blocks, 0, 'a backfill does not fetch full blocks');
    assert.equal(
      feed.observePayload().stats.x402Count,
      0,
      'backfilled flows are unknown, which is not the same as unrelayed',
    );

    // Move the head a cron interval's worth of blocks, so the next poll spans
    // 118 — five times the gate that used to suppress it.
    setHead(4096 + 118);
    await feed.settle();

    const obs = feed.observePayload();
    assert.equal(
      calls.blocks,
      118,
      'the whole span was queried for senders, in batches of 24',
    );
    assert.equal(obs.stats.x402Count, 2, 'both transfers in the wide span resolved as relayed');
    assert.ok(
      obs.stats.x402Share > 0,
      `the share the UI shows is still pinned at zero (got ${obs.stats.x402Share})`,
    );
    assert.deepEqual(
      obs.flows.slice(-2).map((f) => f.x402),
      [true, true],
      'and the per-flow mark survives a wide poll, which is what the tx drawer reads',
    );
  } finally {
    rpc.close();
  }
});

/* ---------- the feed outliving the object that held it ---------- */

/** A quiet market feed: these tests are about the chain feed, not the price. */
const quietMarket: MarketFeed = { name: 'test-market', sample: async () => ({ temp: 0.5 }) };

/** A stored feed state, shaped like one coming back out of Durable Object storage. */
const feedStateAt = (lastBlock: number): FeedState => ({
  lastBlock,
  level: { window: [1, 2, 3], smooth: 0.4 },
  turbulence: { window: [0.1, 0.2], smooth: 0.6 },
  chainTemp: 0.4,
  marketTemp: 0.6,
  prevVolume: 12,
  prevTemp: 0.4,
});

test('an evicted object resumes the feed instead of backfilling from scratch', async () => {
  // The Durable Object is not resident: the cron wakes it, it answers, and it is
  // collected. Everything the feed knew lived in that object's memory, so every
  // eviction restarted it at `lastBlock = -1` — a 3600-block backfill a minute,
  // which resolves no senders (so every flow it produces is `x402: null`),
  // rebuilds the pulse series wholesale, and pushes enough flows through the ring
  // to evict the live readings a viewer came for. In production that read as an
  // x402 share of 60-82% inside a live pulse bucket and 0% across the window
  // around it: the numerator had been resolved, the denominator had been
  // backfilled, and the backfill kept winning because it kept happening.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const { server: rpc, calls, setHead } = chainRpcStub(4096, 2);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const m = memStore();
  try {
    // The object that is about to be evicted: one backfill, then two live polls,
    // so its rank meters have a window worth carrying over.
    const first = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 32, pollEveryMs: 0 });
    await first.settle();
    setHead(4096 + 118);
    await first.settle();
    setHead(4096 + 236);
    await first.settle();
    const appA = createApp({ seed: 1, chainFeed: first, store: m.store, marketFeed: quietMarket });
    m.seedClock(Date.now() - 60_000);
    await appA.catchUp();
    // `catchUp()` calls `advance()`, which samples the feed, which on a feed with
    // no throttle at all kicks one more poll and deliberately does not await it.
    // Drain it here, before the head moves: left in flight it reads the *new*
    // head, resolves senders for a span of its own, and lands those fetches
    // wherever it likes relative to the count below. Production cannot hit this
    // — there the throttle is 2s and `advance()` follows `warmFeed()` by
    // milliseconds — but a test that races is a test that lies.
    await first.settle();

    assert.equal(
      m.feedState()?.lastBlock,
      4096 + 236,
      'the ledger carries the block the feed reached — the one thing an eviction cannot re-derive',
    );

    // The next object: cold memory, warm storage, one cron interval later.
    const second = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 32 });
    const appB = createApp({ seed: 1, chainFeed: second, store: m.store, marketFeed: quietMarket });
    setHead(4096 + 354);
    const blocksBefore = calls.blocks;
    // `warmFeed` is the cron's opening move and must hydrate first: `settle()`
    // starts a poll on a cold feed, and a poll that runs before the stored block
    // is restored backfills no matter how faithfully the block was saved.
    await appB.warmFeed();

    // A backfill fetches no full blocks, so a non-zero count is itself the proof
    // of a resume: the span was narrow enough to be treated as live.
    assert.equal(
      calls.blocks - blocksBefore,
      118,
      'the new object polled forward from the stored block instead of re-backfilling 3600 of them',
    );
    const carried = second.exportState();
    assert.ok(
      carried.level.window.length >= 4,
      `the rank window came back with it (got ${carried.level.window.length} scores, a cold feed has 1 after its first poll), so the temperature is a rank against history rather than a fresh initializer`,
    );
    assert.ok(
      second.observePayload().stats.x402Count > 0,
      'and the x402 signal survived the eviction, which is what the whole repair was for',
    );
  } finally {
    rpc.close();
  }
});

test('a stored block too far behind re-backfills instead of reporting the gap as now', async () => {
  // Resuming is only honest while the gap is a missed beat. A live poll stamps
  // every log it reads with `now`, so resuming across an hour that way folds an
  // hour of transfers into one 15s pulse bucket and into /observe's five-minute
  // window — a spike that never happened, sitting in the history for a day, and
  // x402 marks claimed for the newest 240 blocks only. Persisting `lastBlock`
  // without this guard would trade a loud failure for a quiet lie.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 20_000;
  const { server: rpc, calls } = chainRpcStub(HEAD, 2);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const m = memStore();
  // An hour of Arc at 500ms a block, unwatched.
  m.seedFeedState(feedStateAt(HEAD - 7200));
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 32 });
    const app = createApp({ seed: 1, chainFeed: feed, store: m.store, marketFeed: quietMarket });
    const blocksBefore = calls.blocks;
    await app.warmFeed();
    assert.equal(
      calls.blocks - blocksBefore,
      0,
      'a gap that wide is history rather than a live span, so no transaction bodies are fetched and no rail is claimed for transfers nobody resolved',
    );
    const flows = feed.observePayload().flows;
    assert.ok(flows.length > 0, 'the backfill still landed its flows');
    const age = Date.now() - flows[0].t;
    assert.ok(
      age > 10_000,
      `backfilled flows carry their own block's time (oldest is ${Math.round(age / 1000)}s old); a live poll would have stamped the whole hour as happening now`,
    );
  } finally {
    rpc.close();
  }
});

/* ---------- which rail a transfer actually travelled on ---------- */

// Venues below are written out rather than imported from the registry: a test
// that reads the same table the code reads can only ever agree with itself.
// Each address and selector was read off Arc mainnet or confirmed against the
// 4byte directory on 2026-09-22 — what cannot be tested is whether that reading
// was right, only that the classification follows from it.
const ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';      // Uniswap Universal Router
const ENTRYPOINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';   // ERC-4337 EntryPoint v0.7
const UNCATALOGUED = '0x' + '77'.repeat(20);
const SEL_ROUTER_EXECUTE = '0x3593564c';
const SEL_EXACT_INPUT_SINGLE = '0x04e45aaf';
const SEL_TRANSFER = '0xa9059cbb';
const SEL_APPROVE = '0x095ea7b3';
const SEL_MULTICALL = '0x5ae401dc';
// Read off mainnet on 2026-09-22 by fetching receipts for transactions addressed
// to each one: USDC moved alongside seven unrelated ERC-20s in a single call,
// from 13 distinct callers, holding no balance in between.
const AGGREGATOR = '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const SEL_AGG_MULTICALL = '0xcd6e13f7';   // multicall((address,bool,uint256,bytes)[],address,address,bytes)
// 1.5 KB exposing `initiator()`, `reenter(...)` and `reenterHash()`.
const EXECUTOR = '0x855dbe13c409df75caf6a985cf6993a4d0319feb';
const pad = (sel: string) => sel + '00'.repeat(32);

/**
 * One live poll against a stub serving `tx` as every transaction body, handed
 * back as the feed's /observe snapshot.
 *
 * The feed is seeded rather than started cold on purpose: a cold feed's first
 * poll is a backfill, which reads no transaction bodies at all and so resolves
 * no venues, leaving these tests nothing to assert about. Four blocks behind
 * the head is well inside MAX_LIVE_SPAN, so the poll this triggers is a live
 * one and every flow it lands is resolved.
 *
 * `perChunk` is how many transfers each `eth_getLogs` answer carries, at blocks
 * `from`, `from+1`, … A poll seeded four blocks back spans exactly four, and the
 * whole span is one chunk — `LOG_CHUNK_BLOCKS` is 400 — so this is also how many
 * flows a test gets, and how many distinct blocks it can vary the body across.
 */
async function pollLive(tx?: StubTxAt, perChunk = 2) {
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 8192;
  const { server: rpc } = chainRpcStub(HEAD, perChunk, 0, tx);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
  try {
    feed.importState(feedStateAt(HEAD - 4));
    await feed.settle();
    return feed.observePayload();
  } finally {
    rpc.close();
  }
}

test('a DEX swap is not a machine payment, however it was submitted', async () => {
  // The whole reason the venue model exists. The stub's block body still
  // carries `from: relayer` while the Transfer log's payer is somebody else, so
  // the condition the old heuristic tested — submitter differs from payer —
  // holds for every flow in this window. It used to report all of them as x402,
  // which on mainnet measured two thirds of all USDC flow as machine payments
  // when 129 of 134 sampled ones had a contract on the paying side.
  const obs = await pollLive({ to: ROUTER, input: pad(SEL_ROUTER_EXECUTE) });
  assert.ok(obs.flows.length > 0, 'the poll landed flows to classify');
  assert.equal(obs.stats.x402Count, 0, 'a swap moves USDC out of a pool; the pool is not a payer and the router is not a facilitator');
  assert.equal(obs.stats.x402Share, 0);
  assert.ok(obs.flows.every((f) => f.venue === 'swap' && f.x402 === false), 'every flow is on the swap rail and none is flagged x402');
  const swap = obs.venues.find((v) => v.kind === 'swap');
  assert.equal(swap?.count, obs.stats.resolved, 'the swap tally accounts for everything the poll read');
  assert.equal(obs.venueCoverage.unattributed, 0, 'a live poll resolves every flow it lands, so nothing is left unattributed');
});

test('an EIP-3009 authorization is the only thing counted, and the share names its denominator', async () => {
  const obs = await pollLive();   // the stub's default body is transferWithAuthorization against the token
  assert.ok(obs.stats.x402Count > 0, 'a real authorization settles on the x402 rail');
  assert.ok(obs.stats.resolved > 0);
  assert.equal(obs.stats.x402Count, obs.stats.resolved, 'everything read in this window was an authorization, so the share is the whole of it');
  assert.equal(obs.stats.x402Share, 1);
  assert.equal(obs.venueRows[0]?.kind, 'x402');
});

test('a plain transfer to the token is direct, not x402', async () => {
  // Same destination as an authorization — the token itself — so only the
  // method can tell them apart. This is the pair the address alone cannot
  // separate, and the reason `direct` exists as its own rail.
  const obs = await pollLive({ to: ARC_USDC, input: pad(SEL_TRANSFER) });
  assert.equal(obs.stats.x402Count, 0, 'moving USDC is not the same as authorizing a machine payment');
  const direct = obs.venues.find((v) => v.kind === 'direct');
  assert.ok(direct && direct.count > 0, 'it lands on the direct rail instead');
  assert.equal(obs.venues.find((v) => v.kind === 'x402')?.count, 0);
});

test('an uncatalogued router is recognised by its calldata and named by its address', async () => {
  const obs = await pollLive({ to: UNCATALOGUED, input: pad(SEL_EXACT_INPUT_SINGLE) });
  const row = obs.venueRows[0];
  assert.equal(row?.kind, 'swap', 'a swap selector on an unknown contract is still a swap');
  assert.equal(row?.label, UNCATALOGUED, 'an unnamed venue stays an address — inventing a name for it is how a guess starts looking like an observation');
});

test('a transfer emitted by a contract creation has no venue to point at', async () => {
  const obs = await pollLive({ to: null });
  assert.equal(obs.stats.x402Count, 0);
  assert.ok(obs.venues.find((v) => v.kind === 'unknown')!.count > 0, 'a creation transaction is unknown');
  assert.equal(obs.venues.find((v) => v.kind === 'contract')!.count, 0, 'unknown is a claim about the transaction, not a bucket for everything unclassified');
  assert.equal(obs.venueCoverage.unattributed, 0, 'and it is not unattributed either: the body was read, it simply had no destination');
  // The row's label, not just its kind: with no address to fall back on, the
  // labelling path has nothing to key off and once named this row a direct USDC
  // transfer — a specific claim about a transaction whose destination was never
  // there to read.
  const { CREATION_LABEL } = await import('../src/venue.js');
  assert.equal(obs.venueRows[0]?.kind, 'unknown');
  assert.equal(obs.venueRows[0]?.label, CREATION_LABEL, 'an unknown rail is labelled as unknown rather than borrowing the token label');
  assert.equal(obs.venueRows[0]?.address, null);
});

test('a backfilled window reports no x402 share rather than a share of zero', async () => {
  // A cold feed backfills, and a backfill reads no transaction bodies. Before
  // the resolved count existed, that window still went into the denominator, so
  // the headline share fell by however much history was on screen — with a real
  // x402 share near one percent, a half-resolved window reads as half a percent
  // and looks like a collapse rather than a gap in coverage.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 8192;
  const { server: rpc } = chainRpcStub(HEAD, 2);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 32 });
  try {
    await feed.settle();   // cold: this is the backfill
    const obs = feed.observePayload();
    assert.ok(obs.stats.transfers > 0, 'the backfill landed real transfers');
    assert.equal(obs.stats.resolved, 0, 'and read none of their transactions');
    assert.equal(obs.stats.x402Share, 0);
    assert.equal(obs.venueCoverage.attributed, 0);
    assert.equal(obs.venueCoverage.windowFlows, obs.venueCoverage.unattributed, 'every flow in the window is unattributed rather than spread across the rails');
    for (const v of obs.venues) {
      assert.equal(v.count, 0, `no rail may claim a flow nobody resolved (got ${v.count} on ${v.kind})`);
      assert.equal(v.volume, 0);
    }
    assert.ok(obs.pulse.length > 0, 'the pulse series was still rebuilt from history');
    for (const p of obs.pulse) {
      assert.equal(p.resolved, 0, `a backfilled bucket carries a count of ${p.count} and no resolved transfers, which is what lets the chart draw it as unknown`);
    }
    assert.ok(obs.flows.every((f) => f.venue === null && f.x402 === null), 'and the flows themselves say unknown, not false');
  } finally {
    rpc.close();
  }
});

test('the rail is decided by the contract and the method, and never by a guess', async () => {
  const { classifyVenue, X402_LABEL, DIRECT_LABEL } = await import('../src/venue.js');
  // A catalogued address outranks the shape of its calldata: knowing which
  // contract this is beats recognising a selector several routers share.
  assert.equal(classifyVenue(ARC_USDC, ENTRYPOINT, SEL_EXACT_INPUT_SINGLE).kind, 'aa');
  // `multicall` is a wrapper whose real action sits in calldata nobody decodes,
  // so reading it as a swap would be an inference dressed as an observation.
  assert.equal(classifyVenue(ARC_USDC, UNCATALOGUED, SEL_MULTICALL).kind, 'contract');
  // Either party may submit an authorization, so both spellings settle one.
  assert.equal(classifyVenue(ARC_USDC, ARC_USDC, '0xe3ee160e').kind, 'x402');
  assert.equal(classifyVenue(ARC_USDC, ARC_USDC, '0xef55bec6').kind, 'x402');
  // Approving the token is not paying with it: 57 of the 87 direct USDC calls
  // sampled on mainnet were approvals.
  assert.equal(classifyVenue(ARC_USDC, ARC_USDC, SEL_APPROVE).kind, 'direct');
  assert.equal(classifyVenue(ARC_USDC, ARC_USDC, SEL_APPROVE).label, DIRECT_LABEL);
  assert.equal(classifyVenue(ARC_USDC, ARC_USDC, '0xe3ee160e').label, X402_LABEL);
  // No destination at all cannot be a venue.
  assert.equal(classifyVenue(ARC_USDC, null, '0xe3ee160e').kind, 'unknown');
  // Address case and a missing selector must not change the answer.
  assert.equal(classifyVenue(ARC_USDC, ROUTER.toUpperCase(), undefined).kind, 'swap');
  assert.equal(classifyVenue(ARC_USDC, ARC_USDC.toUpperCase(), '0xE3EE160E').kind, 'x402');
});

test('a venue catalogued from its receipts is a swap even though its method is multicall', async () => {
  const { classifyVenue } = await import('../src/venue.js');
  // The two halves of that sentence have to hold at once. The selector on its own
  // still proves nothing — `multicall` is a wrapper whose real action sits in
  // calldata nobody decodes — so an uncatalogued contract using it stays a bare
  // address. What makes this one a swap is that its receipts were read: USDC left
  // it in the same transaction as seven unrelated ERC-20s. Naming it is a claim
  // about evidence, and the pair of assertions is what keeps it from silently
  // becoming a claim about method names.
  assert.equal(classifyVenue(ARC_USDC, AGGREGATOR, SEL_AGG_MULTICALL).kind, 'swap');
  assert.equal(classifyVenue(ARC_USDC, UNCATALOGUED, SEL_AGG_MULTICALL).kind, 'contract');
  // An executor is named for what its interface does and promoted no further: it
  // batches calls and hands control back to whoever started them, and nothing
  // on-chain says what it was batching.
  assert.equal(classifyVenue(ARC_USDC, EXECUTOR, SEL_AGG_MULTICALL).kind, 'contract');
  const label = classifyVenue(ARC_USDC, EXECUTOR, SEL_AGG_MULTICALL).label;
  assert.notEqual(label, EXECUTOR, 'a catalogued contract is named rather than shown as its own address');
});

test('the leaderboard ranks a rail by how often it is used, not by what one caller moved', async () => {
  // Production supplied the counterexample: a single atomic arbitrage through an
  // uncatalogued executor came in at $8.15M against a window total of $8.17M.
  // Ordered by volume it outranked the Uniswap router, the ERC-4337 EntryPoint
  // and every aggregator combined, and the other eleven rows drew a bar of zero
  // width beside it — the panel named one bot as the state of the ecosystem.
  // Every fourth block carries the large single transfer, the rest carry the
  // small repeated ones. Four transfers fill the four-block span the seeded poll
  // covers, which is what makes the counts differ rather than tie.
  const obs = await pollLive(
    (b) =>
      b % 4 === 0
        ? { to: UNCATALOGUED, input: pad(SEL_AGG_MULTICALL), amount: 500_000_000 }
        : { to: ROUTER, input: pad(SEL_ROUTER_EXECUTE), amount: 1_000_000 },
    4,
  );
  const busy = obs.venueRows.find((r) => r.address === ROUTER);
  const whale = obs.venueRows.find((r) => r.address === UNCATALOGUED);
  assert.ok(busy && whale, 'both venues landed in the window');
  // The premise of the test: the outlier really does carry more money, so an
  // ordering by volume would really do put it first.
  assert.ok(whale.volume > busy.volume, `the one-off carries more value ($${whale.volume} vs $${busy.volume})`);
  assert.ok(busy.count > whale.count, `the rail is reached more often (${busy.count} vs ${whale.count})`);
  assert.equal(obs.venueRows[0]?.address, ROUTER, 'the busiest rail leads even though it moved less');
  assert.ok(
    obs.venueRows.every((r) => r.count > 0),
    'every row names a count, which is the figure the rows are ordered by and the one that makes a large amount beside ×1 readable as a single event',
  );
});

/* ---------- the volume chart outliving the object that drew it ---------- */

/** The RPC is never dialled here: these tests move state, not blocks. */
const UNUSED_RPC = 'http://127.0.0.1:1';

/**
 * A persisted series shaped like the one that comes back out of the ledger:
 * tuples, seconds, oldest first. Spaced a minute apart on purpose — that is the
 * pace an unwatched feed runs at, one poll per cron fire and one bucket per poll,
 * and it is the spacing production actually had.
 */
const pulseRows = (n: number, stepSec = 60): PulseRow[] => {
  const last = Math.floor(Date.now() / 15_000) * 15;
  return Array.from({ length: n }, (_, i) => {
    const back = n - 1 - i;
    return [last - back * stepSec, 10 + i, 100 + i, i % 3 === 0 ? 1 : 0, 10 + i] as PulseRow;
  });
};

test('the volume chart resumes instead of restarting at one bar', async () => {
  // Measured in production rather than hypothesized: eight probes of /observe
  // across two minutes returned series of 1, 3, 3, 6, 7 and 8 buckets, resetting
  // whenever the object was collected, while `lastBlock` climbed monotonically
  // across the same probes. That pair is the diagnosis — the block was in the
  // ledger and the chart was not. A bucket is one per 15 seconds of wall clock,
  // so the series refills at exactly the rate it records, and the 1h and 24h
  // ranges came back as 60 and 96 columns with one nonzero column between them.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const rows = pulseRows(8);
  const first = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  first.importState({ ...feedStateAt(1024), pulse: rows });
  const carried = first.exportState().pulse;
  assert.deepEqual(carried, rows, 'what went into the ledger is byte-for-byte what comes back out of it');

  // The next object: cold memory, warm storage.
  const second = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  second.importState({ ...feedStateAt(1024), pulse: carried! });
  assert.deepEqual(
    second.observePayload().pulse.map((b) => b.t),
    rows.map((r) => r[0] * 1000),
    'every stored bucket reaches /observe in order, rather than only the one the next poll happens to land',
  );

  // And the ranges that were empty. Eight buckets a minute apart are eight
  // distinct 60s columns, so the 1h view has eight real columns instead of one.
  const hist = second.historyPulse(3_600_000, 60_000);
  assert.equal(hist.length, 60, 'the range stays dense: every slot in the window is served, quiet ones zeroed');
  assert.equal(
    hist.filter((b) => b.count > 0).length,
    8,
    'and eight of them carry something, which is the difference between a time-travel control and a decoration',
  );
  assert.ok(
    hist.every((b) => b.count === 0 || b.resolvedVolume > 0),
    'a bucket that was resolved keeps its denominator through the round trip, so its share is not restated as unknown',
  );
});

test('a ledger that cannot be trusted costs a short chart, not an invented one', async () => {
  // These bytes come back out of Durable Object storage, where a truncated value
  // is a real possibility and not a hypothetical. Every way a row can be wrong has
  // to cost one bar rather than a column nobody measured — and the failure that
  // would be worst is a timestamp from the future, because the chart's right-hand
  // axis label is the last bucket's, so one bad row moves the whole window.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const now = Date.now();
  const slot = Math.floor(now / 15_000) * 15_000;
  const good = (t: number, count: number): PulseRow => [t / 1000, count, count * 10, 0, count];
  const rows = [
    good(slot - 60_000, 1),                                  // kept
    [(slot - 45_000) / 1000, 5] as unknown as PulseRow,      // truncated
    null as unknown as PulseRow,                             // not a row at all
    good(slot - 90_000, 2),                                  // older than the one before it
    [NaN, 1, 1, 0, 1] as unknown as PulseRow,                // no usable timestamp
    good(slot + 3_600_000, 3),                               // an hour from now
    good(slot - 30_000, 4),                                  // kept
    good(now - 25 * 3_600_000, 5),                           // older than the series can hold
  ];
  const feed = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  feed.importState({ ...feedStateAt(1024), pulse: rows });
  const p = feed.observePayload().pulse;
  assert.deepEqual(
    p.map((b) => b.t),
    [slot - 60_000, slot - 30_000],
    'the two rows that are real, ordered, in range and dated in the past are the only two drawn',
  );
  assert.deepEqual(p.map((b) => b.count), [1, 4], 'and each carries its own count, not a neighbour’s');

  // The out-of-order row is dropped rather than sorted into place: the series is
  // appended to at its tail, so a bucket in the middle would be silently
  // overwritten by the next poll's merge-or-push and the chart would end up
  // keeping two accounts of the same minute.
  const warm = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  warm.importState({ ...feedStateAt(1024), pulse: pulseRows(3) });
  warm.importState({ ...feedStateAt(1024), pulse: [[NaN, 1, 1, 0, 1] as unknown as PulseRow] });
  assert.equal(
    warm.observePayload().pulse.length,
    3,
    'a ledger with nothing usable in it leaves the series alone rather than emptying it',
  );
});

test('a backfill fills the gap it was called for and leaves the chart it resumed from alone', async () => {
  // Restoring the series only helps if the next poll does not undo it, and the
  // poll that can is a backfill. A backfill re-reads blocks the feed has already
  // counted — that is what makes it a backfill — and it resolves no venues, so
  // every bucket it rebuilds arrives with `resolved: 0`. Replacing the series
  // with them, which is what the rebuild used to do, would trade a reading the
  // feed actually took for one it did not, and count the same transfers twice
  // wherever the two overlapped.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 8192;
  const { server: rpc } = chainRpcStub(HEAD, 2, 0);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  // Two blocks of backfill is a second of chain, which lands the flows beside
  // `now`; `restorePulse` admits a bucket up to one slot ahead of it, so the
  // seeded band brackets the present on both sides. Whichever slot the poll's
  // own `Date.now()` puts those flows in — a boundary can pass between this line
  // and that one — it collides with a seeded bucket rather than adding a fourth.
  const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 2, pollEveryMs: 0 });
  try {
    const slot = Math.floor(Date.now() / 15_000) * 15_000;
    const rows = [-15_000, 0, 15_000].map(
      (off, i) => [(slot + off) / 1000, 776 + i, 8_000 + i, 0, 776 + i] as PulseRow,
    );
    // `importState` refuses `-1` as a block number, so `lastBlock` stays cold and
    // the poll this triggers is a backfill no matter how narrow the head is.
    feed.importState({ ...feedStateAt(-1), pulse: rows });
    await feed.settle();
    const p = feed.observePayload().pulse;
    assert.ok(p.length > 0, 'the backfill ran');
    assert.deepEqual(
      p.map((b) => [b.t, b.count, b.resolved]),
      rows.map((r) => [r[0] * 1000, r[1], r[4]]),
      'every restored bucket kept its own count and its own denominator, and the rebuild added nothing over them',
    );
    assert.ok(
      feed.observePayload().flows.length > 0,
      'the backfill still landed its flows — this is a merge, not a refusal to read',
    );
  } finally {
    rpc.close();
  }
});

test('the ledger carries a day of chart, and it is the newest day', async () => {
  // The in-memory series runs to 24h of 15s slots and the ledger is rewritten
  // whole on every save, which is about once a minute. Carrying all of it would
  // put a six-figure byte count behind that write to store a chart. Which end the
  // cap keeps is the part worth pinning down: dropping the newest buckets would
  // leave a chart that ends in the past and never catches up.
  //
  // 1440 is written out rather than read from the module, for the usual reason —
  // a test that consults the same constant the code does can only agree with
  // itself, and it is the number itself that has to stay affordable.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const feed = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  const rows = pulseRows(2000, 15);
  feed.importState({ ...feedStateAt(1024), pulse: rows });
  const carried = feed.exportState().pulse!;
  assert.equal(carried.length, 1440, 'the stored copy is capped');
  assert.deepEqual(carried[carried.length - 1], rows[rows.length - 1], 'the newest bucket survives');
  // This is also what proves memory kept all 2000: had the restore capped at the
  // same 1440, the first row carried would be the first row stored.
  assert.deepEqual(carried[0], rows[2000 - 1440], 'and the oldest 560 are what the cap drops');
});

test('the ledger stays a fraction of the value limit it has to fit in', async () => {
  // The world snapshot is not the only state riding in a single Durable Object
  // value with a 2 MB ceiling, and this is the change that put a day of chart in
  // the other one. Measured rather than assumed: "it is only a few numbers" is
  // the reasoning that let the world snapshot grow past the same ceiling — a
  // local world on the same code and the same chain reached 13.63 MiB, and
  // production logs showed `storage.put` throwing SQLITE_TOOBIG on every save.
  // Fed more buckets than the cap will carry, so the number here is the stored
  // size and not the in-memory one — a series that is capped on the way out is
  // the whole point.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const feed = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  feed.importState({ ...feedStateAt(1024), pulse: pulseRows(5000, 15) });
  const bytes = Buffer.byteLength(JSON.stringify(feed.exportState()), 'utf8');
  assert.ok(
    bytes < 256 * 1024,
    `the ledger is ${(bytes / 1024).toFixed(0)} KB; it shares a 2 MB value limit with nothing, but a chart that costs megabytes to store is a chart that will one day fail to`,
  );
});

test('the sim keeps more tick history than the deepest window the API serves', async () => {
  // `/history` answers with `statsLog.slice(-window)` for a window up to
  // HISTORY_WINDOW_MAX, and the sim trims that log in one bite rather than a row
  // at a time — so its length sawtooths, and the *bottom* of the sawtooth is
  // what has to still cover the deepest window. The two numbers live in
  // different packages and nothing else ties them together: lowering the sim's
  // cap would not break a build or throw at runtime, it would quietly hand back
  // a shorter chart than the one asked for.
  const { STATS_LOG_CAP, STATS_LOG_TRIM } = await import('@abyssal/sim');
  const { HISTORY_WINDOW_MAX } = await import('../src/handler.js');
  assert.ok(
    STATS_LOG_CAP - STATS_LOG_TRIM >= HISTORY_WINDOW_MAX,
    `the sim can trim its log down to ${STATS_LOG_CAP - STATS_LOG_TRIM} rows, short of the ${HISTORY_WINDOW_MAX} this API promises to serve`,
  );
});

test('a snapshot too big to store costs a log line, not the response', async () => {
  // The production failure, reproduced end to end through the Durable Object
  // rather than through createApp: the world outgrew the 2 MB ceiling on a
  // single storage value, `storage.put` started throwing SQLITE_TOOBIG, and
  // because `persist()` is awaited on the request path every /observe became a
  // 500 — seven of twenty-four requests in one window — while the cron threw
  // once a minute on top of it.
  //
  // The caps in the sim are what stop the snapshot growing. This guards the
  // other half, the part no size budget can promise: whatever makes a save fail
  // next, a reader who asked to look at the tank still gets their answer. It is
  // worth a test because the regression is invisible — removing the try/catch
  // breaks nothing until storage breaks, and by then the symptom is a tank that
  // stopped being saved, comes back as whatever its last good save held, and
  // answers 500 while doing it.
  const { AbyssalWorld } = await import('../src/worker.js');
  const stored = new Map<string, unknown>();
  const attempted: string[] = [];
  const obj = new AbyssalWorld(
    {
      storage: {
        // The interface's `get` is generic in a way no map can honour — it
        // promises whatever type the caller names — so the stand-in asserts it.
        get: async <T = unknown>(key: string): Promise<T | undefined> => stored.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          attempted.push(key);
          // Only the snapshot fails, which is what made the incident so hard to
          // see: the instance id and the burn receipts kept storing fine, so the
          // object looked healthy from every other angle.
          if (key === 'world') throw new Error('string or blob too big: SQLITE_TOOBIG');
          stored.set(key, value);
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        void promise.catch(() => {});
      },
    },
    {
      WORLD: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response(null) }),
      },
    },
  );

  // Captured rather than left to print: an error and a stack trace in the middle
  // of a green suite reads like a failure, and the log is itself part of what is
  // being asserted. A save that fails silently is how the tank came to reset for
  // days with nothing anywhere saying so.
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  let res: Response;
  try {
    res = await obj.fetch(new Request('https://abyssal.internal/api'));
  } finally {
    console.error = realError;
  }

  assert.ok(attempted.includes('world'), 'the snapshot save was attempted');
  assert.equal(res.status, 200, 'and its failure did not become the caller\u2019s problem');
  assert.equal(logged.length, 1, 'it was logged, exactly once, not swallowed');
  assert.match(
    String(logged[0][0]),
    /world snapshot not saved: [1-9]\d* bytes/,
    'with the size it tried to write, which is the number that decides whether the caps still hold',
  );
});

test('a write fired without awaiting still says which one broke', async () => {
  // The snapshot above got a guard; these two had none. Both are `void promise`
  // with no `.catch()`, and inside a Durable Object a rejected `void` is an
  // unhandled rejection: the platform reports that something failed and the
  // report names no key, no line and no consequence.
  //
  // The receipts write is why this is worth a test rather than a shrug. A burn
  // receipt that never reaches storage sits in the in-memory set, refuses the
  // duplicate for as long as this isolate lives, and admits it again the moment
  // the isolate is gone. One burn, two paid interventions, and nothing anywhere
  // in the running system says a word. That is a payment invariant failing
  // quietly, which is precisely the class of thing the size caps cannot catch.
  const { AbyssalWorld } = await import('../src/worker.js');
  const { recordBurnReceipt, setBurnLedger } = await import('../src/payments.js');

  const stored = new Map<string, unknown>();
  const attempted: string[] = [];
  const failing = new Set(['ledger', 'receipts']);
  const obj = new AbyssalWorld(
    {
      storage: {
        get: async <T = unknown>(key: string): Promise<T | undefined> => stored.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          attempted.push(key);
          if (failing.has(key)) throw new Error(`SQLITE_TOOBIG on ${key}`);
          stored.set(key, value);
        },
      },
      waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}); },
    },
    { WORLD: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null) }) } },
  );

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const lines = () => logged.map((a) => String(a[0]));
  try {
    // The first cron only boots the tank; `catchUp()` repays *wall-clock* ticks
    // and calls saveStore() on the way, which is the only thing that puts
    // 'ledger' on the wire. One tick is 250ms, so owe a couple of them.
    await obj.fetch(new Request('https://abyssal.internal/__cron'));
    await new Promise((r) => setTimeout(r, 600));
    attempted.length = 0;
    const res = await obj.fetch(new Request('https://abyssal.internal/__cron'));
    await settle();

    assert.ok(attempted.includes('ledger'), 'the cron advanced the tank and tried to store the ledger');
    assert.equal(res.status, 200, 'a ledger that cannot be stored is still not the cron\u2019s answer');
    assert.equal(
      lines().filter((l) => /world ledger not stored/.test(l)).length,
      1,
      'the failed ledger write was reported exactly once',
    );

    logged.length = 0;
    const burn = '0x' + 'c3'.repeat(32);
    recordBurnReceipt(burn);
    await settle();
    assert.ok(attempted.includes('receipts'), 'the receipt write was attempted');
    assert.equal(
      lines().filter((l) => /burn receipt not stored/.test(l)).length,
      1,
      'and reported once, on its own line',
    );
    assert.ok(
      lines().some((l) => /replayed after an eviction/.test(l)),
      'the line says what is at stake, because \u201csave failed\u201d is not enough to act on',
    );

    // Telling the two apart is the entire value of the guard, so a shared or
    // generic message would pass a weaker test and still be useless at 3am.
    assert.ok(
      !lines().some((l) => /world ledger not stored/.test(l)),
      'the receipt failure does not borrow the ledger\u2019s message',
    );

    assert.deepEqual(unhandled, [], 'neither rejection escaped as an unhandled rejection');
  } finally {
    console.error = realError;
    process.off('unhandledRejection', onUnhandled);
    setBurnLedger({ load: async () => [], add: () => {} });
  }
});

test('the snapshot budget announces a crossing, not a condition', async () => {
  const { budgetCrossed } = await import('../src/worker.js');
  const { SNAPSHOT_BUDGET, DO_VALUE_LIMIT } = await import('@abyssal/sim');

  // No legally built world reaches this line — every cap full is about 1.15 MiB
  // against a 1.5 MiB alarm — so the state machine is driven by numbers here
  // rather than by a world. Asserted against the imported budget, which is the
  // point of moving it into the sim: the worker's alarm line and the caps'
  // target stop being two numbers that happen to agree.
  const B = SNAPSHOT_BUDGET;
  assert.deepEqual(budgetCrossed(B - 1, false, B), { over: false, announce: false }, 'under the line is silent');
  assert.deepEqual(budgetCrossed(B, false, B), { over: false, announce: false }, 'exactly at budget is not past it');
  assert.deepEqual(budgetCrossed(B + 1, false, B), { over: true, announce: true }, 'crossing up announces');
  assert.deepEqual(budgetCrossed(B + 1, true, B), { over: true, announce: false }, 'staying over does not repeat');
  assert.deepEqual(budgetCrossed(B - 1, true, B), { over: false, announce: false }, 'dropping back re-arms it');

  // And the default argument is the shared budget, not a second literal: if
  // someone re-hardcodes a threshold here the crossing tests above stop lining
  // up with what persist() actually calls.
  assert.equal(budgetCrossed(B + 1, false).announce, true, 'the default budget is the imported one');
  assert.ok(B < DO_VALUE_LIMIT, 'the alarm sits inside the wall, not on it');
  assert.ok(DO_VALUE_LIMIT - B >= 512 * 1024, 'and leaves at least half a megabyte of lead time to act on');
});
