import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIntervention, tick, toJSON } from '@abyssal/sim';
import { createApp, type LedgerSnapshot, type WorldStore } from '../src/handler.js';
import type { ChainFeed } from '../src/chain.js';
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
 * A JSON-RPC stub answering the calls a poll makes: the head, the log chunks,
 * and the full blocks that carry tx senders. `transfersPerChunk` fills each
 * `eth_getLogs` range with that many USDC transfers, enough to give the flow
 * ring and the pulse series something to hold. Every block reports its transfer
 * as submitted by a relayer rather than by the payer, which is the x402 signal,
 * so a poll that resolves senders at all is observable in `stats.x402Count`.
 * `calls` counts polls and block fetches so a test can tell one round of RPC
 * from two, `setHead` moves the chain forward between polls to widen a span,
 * and `delayMs` makes a poll slow enough to outlast the feed's own throttle —
 * without it a local stub answers in under a millisecond and the throttle can
 * never be observed expiring.
 */
function chainRpcStub(head: number, transfersPerChunk: number, delayMs = 0) {
  const from = '0x' + 'cd'.repeat(20);
  const to = '0x' + 'ef'.repeat(20);
  /** Submits the transfer on the payer's behalf: `tx.from != transfer.from`. */
  const relayer = '0x' + 'ab'.repeat(20);
  const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
  /**
   * Keyed by the block that carries it, so `eth_getLogs` and
   * `eth_getBlockByNumber` agree on which hash belongs to which block and a
   * sender lookup can actually hit.
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
      result = { number: call.params?.[0], transactions: [{ hash: txHash(n), from: relayer }] };
    } else if (call.method === 'eth_getLogs') {
      const p = (call.params?.[0] ?? {}) as Record<string, string>;
      const start = parseInt(p.fromBlock, 16);
      result = Array.from({ length: transfersPerChunk }, (_, i) => ({
        address: ARC_USDC,
        topics: [TRANSFER_TOPIC, topic(from), topic(to)],
        data: `0x${(1_000_000).toString(16).padStart(64, '0')}`,
        blockNumber: `0x${(start + i).toString(16)}`,
        transactionHash: txHash(start + i),
      }));
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
