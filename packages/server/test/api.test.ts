import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIntervention, tick, toJSON } from '@abyssal/sim';
import { createApp, readEnv, type LedgerSnapshot, type WorldStore } from '../src/handler.js';
import type { ChainFeed, FeedState, PulseRow } from '../src/chain.js';
import type { MarketFeed } from '../src/market.js';
import { serveStatic } from '../src/static.js';
import {
  ARC_USDC,
  buildFacilitatorConfig,
  DATA_PRICE_USDC,
  exactRequirement,
  settleFromRequest,
  usdcUnits,
  type FacilitatorConfig,
} from '../src/facilitator.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  buildPayload, censusChanges, censusProblem, censusReset, digestHash, digestStats, encodeDigest, newDigestRecord,
  markFailed, markPending, markSubmitted, markConfirmed, markUnconfigured,
  nextDigestAction, coherenceProblem, verifyPayload, isSettled,
  CENSUS_CAP, CENSUS_BUDGET_BYTES, CENSUS_ROW_BYTES,
  censusReading, censusRow, headcountByArchetype, type DigestWorldView,
  DIGEST_HASH_FIELDS, DIGEST_MAGIC, DIGEST_MAX_ATTEMPTS, DIGEST_POLL_MS,
  DIGEST_RETRY_MS, DIGEST_V, stampAnchor,
  type CensusChange, type CensusDay, type DigestPayload, type DigestRecord,
} from '../src/digest.js';
import { BURN_SINK, DEAD_SINK, TRANSFER_TOPIC } from '../src/payments.js';
import {
  createHealth, healthProblem, PROBLEM_WINDOW_MS, receiptsValueBytes, SIGNAL_KINDS, staleSignals,
  type HealthView,
} from '../src/health.js';
import {
  addDecimalUnits, anchorEconProblem, anchorRunway, ARC_FEE_DECIMALS, newAnchorEcon, RUNWAY_ALARM_ANCHORS,
  txFeeUnits, unitScaleProblem, USDC_TOKEN_DECIMALS,
  type AnchorEcon,
} from '../src/econ.js';

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
  // Cloned on the way in AND on the way out, because that is what a Durable
  // Object does: `storage.put(key, object)` hands the value to a serializer and
  // `get` hands back a new object graph. Holding the reference instead — which
  // this fixture used to do — makes "the row survived the isolate that wrote it"
  // untestable by construction: the test reads back the identical object the
  // writer still has, so anything that cannot survive a serialization round trip
  // (a field that is not data, a number that is not finite, a shape the guard on
  // the load path reads differently) is invisible here and live in production.
  const store: WorldStore = {
    load: async () => structuredClone(state),
    save: (s) => { state = structuredClone(s); },
  };
  return {
    store,
    seedClock: (t: number) => { state = { ...state, lastAdvanceAt: t }; },
    clock: () => state.lastAdvanceAt,
    seedFeedState: (f: FeedState) => { state = { ...state, feedState: structuredClone(f) }; },
    feedState: () => state.feedState,
    /**
     * The day digest, read straight out of what the app last persisted rather
     * than out of its closure. The pump is a floating promise on the request
     * path, so the only honest way to watch it is through the storage it is
     * required to write every transition to — which is also the D2 regression.
     */
    digest: () => state.digest,
    seedDigest: (d: DigestRecord) => { state = { ...state, digest: structuredClone(d) }; },
    /**
     * The day book, out of the persisted ledger rather than the closure, for the
     * same reason as `digest()` above — and reading it back through a second
     * `createApp` is the only way to test that a row survives the isolate that
     * wrote it, which is the whole difference between a history and a session.
     */
    dayBook: () => state.dayBook,
    seedDayBook: (rows: CensusDay[]) => { state = { ...state, dayBook: structuredClone(rows) }; },
    /** The anchor's economics, for the same reason: they are read back by a later isolate. */
    anchor: () => state.anchor,
    seedAnchor: (a: AnchorEcon) => { state = { ...state, anchor: structuredClone(a) }; },
  };
}

/**
 * The fixture's own fidelity, checked. Every hydrate test below reads "the row
 * survived the isolate that wrote it" out of this object, so if it handed back
 * the reference the writer still holds then those tests measure a memory, not a
 * storage: a row that cannot survive being serialized would pass here and fail
 * in production, which is the shape of the bug that emptied the published book.
 */
test('the ledger fixture is a serialization, not a shared reference', async () => {
  const m = memStore();
  const row = censusFixture(3);
  // Only `dayBook` is filled in: this is about what the fixture does to the bytes,
  // and `save`/`load` are the two doors the app and its next isolate use.
  m.store.save({ dayBook: [row] } as LedgerSnapshot);
  row.population = 9_999;
  row.byArchetype.APE = 1;
  const read = (await m.store.load()).dayBook!;
  assert.equal(read.length, 1, 'what one isolate wrote, the next one can read');
  assert.equal(read[0].population, 5, 'storage holds what was written, not a live view of it');
  assert.equal(read[0].byArchetype.APE, 2, 'including the nested object a row is made of');
  assert.notEqual(read[0], row, 'and the reader gets a different object graph than the writer kept');
});

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
 * `setFinalityLag` holds the named finality tags that many blocks behind the head
 * (0, as the deployed endpoint answers today), `setFinalityRefused` makes the node
 * answer `finalized` with an error instead, `setFinalityEcho` makes it repeat the
 * tag back where the height belongs, and `delayMs` makes a poll slow enough to
 * outlast the feed's own throttle —
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
  const calls = { heads: 0, blocks: 0, tags: 0 };
  /** Every `[fromBlock, toBlock]` the feed asked for, as heights. */
  const logRanges: [number, number][] = [];
  let currentHead = head;
  let finalityLag = 0;
  let refuseFinality = false;
  let echoTags = false;
  /**
   * The height a named tag refers to, the way a node resolves it. Hex answers
   * itself. The point of doing this in the stub rather than letting it echo the
   * parameter is that an echo is what the real code mistook for block 15 on the
   * first run: `parseInt('finalized', 16)` is 15 because `f` is a hex digit.
   */
  const askedHeight = (asked: string): number => {
    if (/^0x[0-9a-f]+$/i.test(asked)) return parseInt(asked, 16);
    if (asked === 'finalized' && refuseFinality) return NaN;
    if (asked === 'latest' || asked === 'pending') return currentHead;
    if (asked === 'finalized' || asked === 'safe') return currentHead - finalityLag;
    return NaN;
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const call = JSON.parse(body || '{}') as { method?: string; params?: unknown[] };
    // Counted on arrival, before the delay: a redundant poll is dispatched
    // asynchronously, and counting it only when answered would let an assertion
    // run before the extra request had shown up.
    if (call.method === 'eth_blockNumber') calls.heads++;
    if (call.method === 'eth_getBlockByNumber') {
      // Counted by what was asked for, not just by the method. `calls.blocks` is
      // the venue path's full-block fetches, which is what the assertions about
      // "a backfill fetches no blocks" mean; the finality probe asks the same
      // method for a named tag and would otherwise be mistaken for venue work.
      const asked = String(call.params?.[0] ?? '');
      if (/^0x[0-9a-f]+$/i.test(asked)) calls.blocks++;
      else calls.tags++;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    let result: unknown = { transactions: [] };
    if (call.method === 'eth_blockNumber') {
      result = `0x${currentHead.toString(16)}`;
    } else if (call.method === 'eth_getBlockByNumber') {
      const n = askedHeight(String(call.params?.[0] ?? ''));
      if (!Number.isFinite(n)) {
        // A tag this stub does not know is reported the way an unsupported tag is
        // reported by a node that has never heard of it, so a test can tell "the
        // feed asked for something odd" apart from "the feed asked and was told a
        // height".
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: `unknown block tag: ${String(call.params?.[0])}` } }));
        return;
      }
      const b = txAt(n);
      const asked = String(call.params?.[0] ?? '');
      result = {
        // An endpoint that echoes the tag back in the place a block height goes,
        // for callers stubborn enough to keep asking it that way.
        number: echoTags && !/^0x/i.test(asked) ? asked : `0x${n.toString(16)}`,
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
      const end = parseInt(p.toBlock, 16);
      // Recorded so a test can assert on what the feed *asked for* and not only on
      // what it got back: this stub answers any range with the same handful of
      // transfers, so a poll that walked past the height it meant to count is
      // invisible in the logs it receives and plain in the request it sent.
      logRanges.push([start, end]);
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
  return {
    server,
    calls,
    logRanges,
    setHead: (n: number) => { currentHead = n; },
    setFinalityLag: (n: number) => { finalityLag = n; },
    /** Answer the finality tag with `unknown block tag`, like a node that never heard of it. */
    setFinalityRefused: (on: boolean) => { refuseFinality = on; },
    /** Put the tag itself where the block height belongs, for every named tag. */
    setFinalityEcho: (on: boolean) => { echoTags = on; },
  };
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

/* ---------- which blocks a poll is willing to count as fact ---------- */

test('the feed counts what the node calls final, not whatever it last offered', async () => {
  // Every number this observatory publishes — the temperature, the pulse, which
  // rail a transfer travelled on — is computed over the blocks one poll walked,
  // so "which blocks" is not chain plumbing: it is the scope of every claim on
  // the page. Measured against the deployed endpoint, that scope is currently the
  // whole chain — asked inside one JSON-RPC batch, `latest`, `safe` and
  // `finalized` name the same height in every round, and `FINALITY_TAG` in arc.ts
  // carries the sample. So the rule below has no visible effect in production
  // today, which is exactly why it needs a test: the alternative is discovering
  // what the feed indexes on the day a node starts lagging and something
  // unmeasured starts reaching the page.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server, calls, logRanges, setFinalityLag } = chainRpcStub(HEAD, 2);
  setFinalityLag(500);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
    await feed.settle();
    assert.ok(calls.tags > 0, 'the poll asked the node which block it calls final');
    assert.equal(feed.finalityStatus().indexedUpTo, HEAD - 500, 'and indexed to that height and no further');
    const status = feed.finalityStatus();
    assert.equal(status.head, HEAD, 'the head it declined is recorded beside what it counted');
    assert.equal(status.lagBlocks, 500, 'so the gap is a number a reader can watch rather than a property of the code');
    assert.equal(status.tag, 'finalized', 'the answer names which rule bounds the height');
    const obs = feed.observePayload();
    assert.equal(obs.lastBlock, HEAD - 500, 'the published window ends at finality, not at the tip');
    assert.equal(obs.finalityLagBlocks, 500);
    assert.ok(logRanges.length > 0, 'the walk did ask for logs');
    assert.ok(
      logRanges.every(([, end]) => end <= HEAD - 500),
      `no chunk it asked for reaches above the ceiling (asked: ${JSON.stringify(logRanges)})`,
    );
    assert.ok(
      obs.flows.every((f) => f.block <= HEAD - 500),
      'and no flow in it came from a block above the height the poll claims to have counted',
    );
  } finally {
    server.close();
  }
});

test('a finality answer ahead of the head is clamped to the head, not believed', async () => {
  // Not a hypothetical ordering: the first probe of this measured `latest`, waited
  // ten seconds, then measured `finalized` — and got a finality 17 blocks *ahead*
  // of the head on a chain that produces a block every half second. That was the
  // probe measuring its own sleep rather than the chain, and it is also exactly the
  // shape a node produces whenever the two answers come from different moments.
  // Trusting the higher of the two would index blocks this feed has never been
  // told exist, and publish a negative lag while doing it.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server, setFinalityLag } = chainRpcStub(HEAD, 2);
  setFinalityLag(-200);   // a node whose `finalized` sits 200 blocks above its head
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
    await feed.settle();
    const status = feed.finalityStatus();
    assert.equal(status.indexedUpTo, HEAD, 'the head it reported is the ceiling, whichever answer is higher');
    assert.equal(status.lagBlocks, 0, 'and the gap is zero rather than the -200 the two answers imply');
    const obs = feed.observePayload();
    assert.equal(obs.finalityLagBlocks, 0);
    assert.ok(
      obs.flows.every((f) => f.block <= HEAD),
      'no flow was invented from a block above the head',
    );
  } finally {
    server.close();
  }
});

test('a node that will not name a final block says so, and so does the feed', async () => {
  // A tag an endpoint has never heard of is not a reason to stop observing the
  // chain: the choice is between indexing the head and indexing nothing at all,
  // and on a chain whose head *is* confirmed blocks that is not close. What the
  // feed must not do is fall back silently, because "we only index final blocks"
  // would then be a sentence about some other node's answer. So the degradation
  // is counted, and the count is what separates a guarantee that lapsed from one
  // that was never in play.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server, calls, setFinalityRefused } = chainRpcStub(HEAD, 2);
  setFinalityRefused(true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const health = createHealth();
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0, health });
    await feed.settle();
    const status = feed.finalityStatus();
    assert.equal(status.indexedUpTo, HEAD, 'the poll went on to the head it was offered');
    assert.equal(status.lagBlocks, 0, 'and says plainly that it is not holding anything back');
    assert.ok(calls.tags > 0, 'it asked anyway — the fallback is the answer to the question, not a refusal to ask');
    assert.equal(health.view().counts.arc_finality_unavailable, 1, 'one poll, one record of having had to fall back');
    assert.match(
      health.view().last.arc_finality_unavailable.detail,
      /unknown block tag: finalized/,
      'with the node\'s own reason, not just the fact of it',
    );
    assert.ok(feed.observePayload().stats.transfers > 0, 'and the degradation is a footnote to a poll that still worked');
  } finally {
    server.close();
  }
});

test('an answer that repeats the question is not a block height', async () => {
  // `parseInt('finalized', 16)` is 15: the leading `f` is a hex digit. So an
  // endpoint that echoes the requested tag back where the height belongs is read
  // as block 15 by any parser that only parses, and a feed that believed it would
  // stop indexing 4,081 blocks short of the head while reporting a lag it had
  // invented. This is not a hypothetical shape — the stub in this file answered
  // that way on the first run of the code above, and the twelve failures it
  // produced are the evidence for checking an answer's shape rather than trusting
  // the name of the method that produced it.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server, setFinalityEcho } = chainRpcStub(HEAD, 2);
  setFinalityEcho(true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const health = createHealth();
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0, health });
    await feed.settle();
    const status = feed.finalityStatus();
    assert.equal(status.indexedUpTo, HEAD, 'the tag was refused, so the head stands — instead of 15, which is what reading it as a height gives');
    assert.equal(health.view().counts.arc_finality_unavailable, 1);
    assert.match(
      health.view().last.arc_finality_unavailable.detail,
      /finalized answered "finalized" as a block number/,
      'and the detail carries what actually arrived, because "not a number" does not say',
    );
  } finally {
    server.close();
  }
});

test('the two heights a finality reading needs survive the isolate that took them', async () => {
  // `lastBlock` on its own is half a claim: it says where the feed stopped, not
  // how far that was from what it was offered. A lag of zero read from a ledger
  // that never stored a head would be the reassuring answer and the wrong one,
  // so both heights are persisted together, and a ledger written before either
  // existed reports unknown rather than a gap nobody measured.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server, calls } = chainRpcStub(HEAD, 2);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const first = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
    await first.settle();
    const exported = first.exportState();
    assert.equal(exported.headBlock, HEAD, 'the head is part of what goes into the ledger');
    const pollsBefore = calls.heads;
    const second = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
    second.importState(exported);
    assert.deepEqual(second.finalityStatus(), first.finalityStatus(), 'and comes back with the same reading');
    assert.equal(calls.heads, pollsBefore, 'which it did not have to ask the chain for');

    const legacy = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, {});
    legacy.importState({ ...feedStateAt(2000), headBlock: undefined });
    assert.equal(legacy.finalityStatus().indexedUpTo, 2000, 'the cursor a pre-finality ledger does carry');
    assert.equal(legacy.finalityStatus().lagBlocks, null, 'and not the gap it never measured');

    // A head behind the cursor cannot be a lag, and clamping it to one would turn
    // a ledger whose two halves came apart into a chain that looks fully indexed.
    const backwards = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, {});
    backwards.importState({ ...feedStateAt(2000), headBlock: 1500 });
    assert.equal(backwards.finalityStatus().head, -1, 'the unusable head was dropped rather than believed');
    assert.equal(backwards.finalityStatus().lagBlocks, null, 'and the gap it would have produced is not published as zero');
    assert.equal(backwards.finalityStatus().indexedUpTo, 2000, 'while the half that can still be used is kept');
  } finally {
    server.close();
  }
});

test('a live poll under a lagging node resolves its rails without reaching past the ceiling', async () => {
  // A backfill reads no transaction bodies at all, so the tests above cannot see
  // the venue walk — and that walk is the part of a live poll that costs RPC
  // calls. Bounding it at the same height as everything else is not decoration:
  // an unbounded one would buy block bodies for transfers the log walk was told
  // not to count, and the rails panel would be drawing a window nobody agreed on.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server, calls, setFinalityLag } = chainRpcStub(HEAD, 2);
  setFinalityLag(500);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
    // 100 blocks behind the finality edge, which is a missed beat rather than
    // history: a live poll, the only kind that resolves venues.
    feed.importState(feedStateAt(HEAD - 500 - 100));
    await feed.settle();
    const obs = feed.observePayload();
    assert.equal(calls.blocks, 100, 'one block body per block in the counted span, and none above it');
    assert.ok(obs.stats.resolved > 0, 'the rails were read, lagging node notwithstanding');
    assert.equal(obs.lastBlock, HEAD - 500);
    assert.ok(obs.flows.every((f) => f.block <= HEAD - 500));
  } finally {
    server.close();
  }
});

test('a poll with nothing new to count still reports how far the head moved', async () => {
  // The other half of publishing two heights: a poll that indexes nothing is
  // exactly when the gap between them changes, because "the node is falling
  // behind" arrives as a head that outruns a ceiling that does not. Writing both
  // heights only where work was done would freeze the one number an operator
  // watches, and freeze it at the reassuring value.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 4096;
  const { server, calls, setFinalityLag, setHead } = chainRpcStub(HEAD, 2);
  setFinalityLag(500);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
    await feed.settle();
    const before = feed.finalityStatus();
    assert.equal(before.indexedUpTo, HEAD - 500);
    const polls = calls.heads;
    // 200 blocks of new chain, none of it final: the ceiling does not move, the
    // head does, and the poll has nothing to walk.
    setHead(HEAD + 200);
    setFinalityLag(700);
    await feed.settle();
    const after = feed.finalityStatus();
    assert.ok(calls.heads > polls, 'a poll did run');
    assert.equal(after.indexedUpTo, before.indexedUpTo, 'and counted nothing, as it should');
    assert.equal(after.head, HEAD + 200, 'while still recording what it was offered');
    assert.equal(after.lagBlocks, 700, 'which is the only way the lag it is now holding is visible');
  } finally {
    server.close();
  }
});

test('a feed the handler builds for itself reports to the counters the handler owns', async () => {
  // Every other finality test names the health view when constructing the feed.
  // Production does not: the tank asks `createApp` for a feed and never sees the
  // one it got. That wiring is where the digest key went missing in September —
  // configured, read by the code that had a counter, and never handed to the one
  // that did the work — so the app-built feed gets its own test rather than
  // inheriting confidence from a constructor call in a file that ships nothing.
  const HEAD = 4096;
  const { server, setFinalityRefused } = chainRpcStub(HEAD, 2);
  setFinalityRefused(true);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const had = process.env.CHAIN_FEED;
  delete process.env.CHAIN_FEED;   // the suite pins the offline rain; this test is about the other branch
  try {
    const health = createHealth();
    const app = createApp({ seed: 1, store: memStore().store, rpc: url, health, marketFeed: quietMarket });
    await app.warmFeed();
    const body = await readHealth(app);
    assert.ok(body.feed, 'the app made an Arc feed, and says so instead of publishing nothing');
    assert.equal(body.feed?.indexedUpTo, HEAD, 'a refused tag did not stop the poll');
    assert.equal(health.view().counts.arc_finality_unavailable, 1, 'and the refusal landed in the counters the reader is shown');
    assert.match(healthDetail(body, 'arc_finality_unavailable'), /unknown block tag/);
    assert.equal(body.data.arcFeed, true, 'and `data` agrees that this tank is on Arc, which is what the feed block is a claim about');
  } finally {
    if (had !== undefined) process.env.CHAIN_FEED = had;
    else process.env.CHAIN_FEED = 'synthetic';
    server.close();
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
 * `maxFlows` shrinks the ring below that, which is how a test overflows it without
 * waiting for a busy chain. `seedBack` is how far behind the head the cursor sits,
 * and so how many blocks the poll spans: `transfersPerChunk` puts its transfers on
 * the *lowest* blocks of the range, so a poll narrower than the number of transfers
 * would answer with logs past the height it indexed, and those get no venue.
 */
async function pollLive(tx?: StubTxAt, perChunk = 2, maxFlows?: number, seedBack = 4) {
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 8192;
  const { server: rpc } = chainRpcStub(HEAD, perChunk, 0, tx);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0, maxFlows });
  try {
    feed.importState(feedStateAt(HEAD - seedBack));
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
  // Four blocks of a seeded cursor is a live poll, and the ring is far wider than
  // the flows it lands, so the window and the ring hold the same set here. The
  // equality is the payload's own invariant and the client's sentence is built
  // from these two numbers, so it is checked where both are published.
  assert.equal(obs.venueCoverage.windowTransfers, obs.stats.transfers, 'the coverage denominator is the heading number, not a second count of something else');
  assert.equal(obs.venueCoverage.windowFlows, obs.stats.transfers, 'a ring with room left holds every flow in the window');
  assert.equal(obs.venueCoverage.unseen, 0, 'and says so instead of inventing a shortfall');
});

test('rails that describe part of the window say which part', async () => {
  // The failure this guards is invisible in every other number on the panel: the
  // flow ring is 6,000 places and the stats window is five minutes of chain, which
  // today runs ~2,500 transfers, so the ring covers the window — *unless the
  // isolate is young*. The block cursor survives an eviction and suppresses the
  // backfill that would otherwise refill the ring, so a restored feed serves a
  // full window of pulse history over a ring that has been filling one poll at a
  // time since it woke. Measured on the deployed feed at 03:48:16Z on 2026-09-25:
  // 2,098 transfers in the window and 0 ring flows, with `unattributed` at 0 too,
  // because a flow the ring never held cannot be unattributed either.
  const obs = await pollLive(undefined, 8, 3, 8);
  assert.equal(obs.stats.transfers, 8, 'the poll read eight transfers');
  assert.equal(obs.venueCoverage.windowFlows, 3, 'the ring kept three of them');
  assert.equal(obs.venueCoverage.windowTransfers, obs.stats.transfers, 'and the denominator is the number on the heading');
  assert.equal(obs.venueCoverage.unseen, 5, 'five were never in hand, which is a coverage fact and not a classification fact');
  assert.equal(obs.venueCoverage.unattributed, 0, 'the three it kept were all resolved, so nothing is unattributed — the old single number reported a clean bill of health');
  assert.equal(
    obs.venueCoverage.unseen,
    Math.max(0, obs.stats.transfers - obs.venueCoverage.windowFlows),
    'unseen is that subtraction, computed here as well as in the feed so the two cannot drift',
  );
});

test('a backfill counts every transfer it read, not the ones the ring kept', async () => {
  // Same subtraction on the other path. The pulse series used to be rebuilt by
  // walking the ring after the trim, so a backfill wide enough to overflow it
  // printed its own survivors as the window's total and then reported no
  // shortfall at all — the pair stayed self-consistent while both numbers were
  // short, which is the one shape of this bug no ratio can show.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 8192;
  const { server: rpc } = chainRpcStub(HEAD, 8);
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 32, pollEveryMs: 0, maxFlows: 3 });
  try {
    await feed.settle();   // cold: this is the backfill
    const obs = feed.observePayload();
    assert.equal(obs.stats.transfers, 8, 'the whole backfill is inside the stats window, so all eight belong to it');
    assert.equal(obs.venueCoverage.windowFlows, 3, 'the ring kept three');
    assert.equal(obs.venueCoverage.unseen, 5, 'and the window says how much of it the rails do not describe');
    assert.equal(obs.stats.volume, 8, 'the volume the pulse sums is the same eight transfers (1 USDC each), not the surviving three');
  } finally {
    rpc.close();
  }
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
  let health: HealthBody;
  try {
    res = await obj.fetch(new Request('https://abyssal.internal/api'));
    // Read through the same object rather than a second one: what is being
    // checked here is that the guard which prints also counts, so both halves
    // have to be observed on the isolate that failed. Fetched inline rather
    // than through the helper below, which is declared after this test runs.
    health = (await (await obj.fetch(new Request('https://abyssal.internal/health'))).json()) as HealthBody;
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
  assert.equal(health.signals?.counts.snapshot_not_saved, 1, 'and counted, for anyone who asks later');
  assert.equal(health.healthy, false);
  assert.ok((health.storage?.snapshotBytes ?? 0) > 1000, 'the size that failed is still the size on record');
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

/* ---------- the day digest: what is promised, and what may be claimed ---------- */

/**
 * Nothing in this section existed when the digest code was moved out of
 * `handler.ts`, which is the reason the move was safe to make and the reason it
 * had to be paid for afterwards: six defects sat in ~80 lines that no test had
 * ever executed, one of which (`pending` written by the send-failure path with
 * no transaction behind it) was telling every visitor "Committing…" about a
 * broadcast that had never been attempted.
 *
 * The chain is stubbed locally. `sendTransaction` on viem 2.56 walks
 * `eth_fillTransaction → eth_getTransactionCount → eth_getBlockByNumber →
 * eth_maxPriorityFeePerGas → eth_estimateGas → eth_sendRawTransaction` before
 * it gives anyone a hash, so the stub answers all of them — and records the raw
 * transaction it was finally handed, because the payload arriving on the wire is
 * the only end-to-end proof that what was hashed is what was broadcast.
 */
const DIGEST_BLOCK = {
  number: '0x100',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  nonce: '0x0000000000000000',
  sha3Uncles: `0x${'33'.repeat(32)}`,
  logsBloom: `0x${'00'.repeat(256)}`,
  transactionsRoot: `0x${'44'.repeat(32)}`,
  stateRoot: `0x${'55'.repeat(32)}`,
  receiptsRoot: `0x${'66'.repeat(32)}`,
  miner: `0x${'00'.repeat(20)}`,
  difficulty: '0x0',
  totalDifficulty: '0x0',
  extraData: '0x',
  size: '0x200',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  timestamp: '0x65c00000',
  // Arc's constant base fee, measured against mainnet block 22326411.
  baseFeePerGas: '0x4a817c800',
  uncles: [],
};

/** The hash a broadcast is answered with, unless a test overrides it. */
const DIGEST_TX = `0x${'ee'.repeat(32)}`;

/* What committing a day costs, as the stub reports it. The two real anchors
 * measured on 2026-09-24 used 30,440 gas (day 15) and 30,560 (day 28) at about
 * 20 gwei; this fixture sits between them and stays a fixture — a fixed number,
 * so the runway assertions below are exact divisions rather than a second
 * measurement to keep in sync. `DIGEST_BLOCK` carries the same base fee. */
const DIGEST_GAS_USED = '0x7738';
const DIGEST_GAS_PRICE = '0x4a817c800';
const DIGEST_COST_UNITS = 30520n * 20000000000n;

/**
 * A contract's answer, in the shape a contract actually sends it: one 32-byte word,
 * zero-padded on the left.
 *
 * `eth_getBalance` is not written this way — a quantity is minimal — and this stub
 * used to answer both calls minimally, which is how a reader that refused leading
 * zeros passed every test in this file while refusing every answer the real chain
 * sent. A fixture that records the value it concluded with, instead of the bytes it
 * observed, cannot catch that class of mistake at all.
 */
const dataWord = (units: bigint): string => `0x${units.toString(16).padStart(64, '0')}`;

/** The two balances the stub reports by default: the same 1 USDC at each scale. */
const STUB_FEE_BALANCE = `0x${(10n ** 18n).toString(16)}`;
const STUB_USDC_BALANCE = dataWord(10n ** 6n);

type DigestRpc = {
  url: string;
  /** Serialized transactions, in the order the endpoint was asked to accept them. */
  sends: string[];
  methods: string[];
  /** The `eth_call` requests, so a test can check what was asked and not just that it asked. */
  calls: { to: string; data: string }[];
  setReceipt: (result: unknown) => void;
  /** The fee balance and the token balance, as hex quantities. */
  setBalances: (feeUnits: string, tokenUnits: string) => void;
  /** Make the next `eth_call` fail the way a node fails: an error answer, not a null. */
  setCallError: (message: string | null) => void;
  /**
   * Hold up the two balance reads by `ms`. The day is already `confirmed` when
   * they go out — they are the pump's tail — so this is the knob that turns "an
   * assertion that races the tail" from an occasional failure on a busy machine
   * into a certain one in CI.
   */
  setBalanceLatency: (ms: number) => void;
  close: () => void;
};

/**
 * `sendError` models the failure mode the old code mistook for a commitment.
 *
 * The balance is answered rather than left null because this path is about an
 * account that can pay and is still refused; an unfunded stub would describe a
 * different tank's problem. Worth knowing when a rejection fails the suite:
 * viem re-narrates whatever the endpoint answers — a refusal here comes out
 * headed "the total cost exceeds the balance of the account" with the real
 * message only in `Details` — so the assertion on `eth_sendRawTransaction`
 * appearing in `methods` is what proves the wire was asked at all.
 */
async function digestRpcStub(sendError?: string): Promise<DigestRpc> {
  const sends: string[] = [];
  const methods: string[] = [];
  const calls: { to: string; data: string }[] = [];
  let receipt: unknown = null;
  let feeBalance = STUB_FEE_BALANCE;
  let tokenBalance = STUB_USDC_BALANCE;
  let callError: string | null = null;
  let balanceLatencyMs = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const call = JSON.parse(body || '{}') as { method?: string; params?: unknown[] };
    methods.push(call.method ?? '');
    // Delayed after `methods.push` and before the answer, so a test can tell "the
    // read was made and was slow" from "the read was never made".
    if (balanceLatencyMs > 0 && (call.method === 'eth_getBalance' || call.method === 'eth_call')) {
      await new Promise((r) => setTimeout(r, balanceLatencyMs));
    }
    let result: unknown = null;
    switch (call.method) {
      case 'eth_blockNumber': result = '0x100'; break;
      case 'eth_chainId': result = '0x13b2'; break;
      case 'eth_getBlockByNumber': result = DIGEST_BLOCK; break;
      case 'eth_getTransactionCount': result = '0x0'; break;
      case 'eth_maxPriorityFeePerGas': result = '0x0'; break;
      case 'eth_estimateGas': result = '0x61a8'; break;
      case 'eth_gasPrice': result = '0x4a817c800'; break;
      case 'eth_getBalance': result = feeBalance; break;
      case 'eth_getTransactionReceipt': result = receipt; break;
      case 'eth_call':
        calls.push({
          to: String((call.params?.[0] as { to?: unknown } | undefined)?.to ?? ''),
          data: String((call.params?.[0] as { data?: unknown } | undefined)?.data ?? ''),
        });
        if (callError) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: callError } }));
          return;
        }
        result = tokenBalance;
        break;
      case 'eth_sendRawTransaction':
        if (sendError) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: sendError } }));
          return;
        }
        sends.push(String(call.params?.[0]));
        result = DIGEST_TX;
        break;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sends,
    methods,
    calls,
    setReceipt: (result) => {
      // A mined receipt always carries both gas fields, and `readAnchorEcon` counts
      // their absence, so the stub fills them in unless a test overrides them —
      // otherwise every pre-existing test that confirms a day would also be proving
      // an economics failure it never mentions. A test that wants the missing-field
      // case passes `gasUsed: undefined` explicitly, which wins over the default.
      const mined = result && typeof result === 'object' && (result as { status?: string }).status === '0x1';
      receipt = mined ? { gasUsed: DIGEST_GAS_USED, effectiveGasPrice: DIGEST_GAS_PRICE, ...(result as object) } : result;
    },
    setBalances: (fee, token) => { feeBalance = fee; tokenBalance = token; },
    setCallError: (message) => { callError = message; },
    setBalanceLatency: (ms) => { balanceLatencyMs = ms; },
    close: () => server.close(),
  };
}

/** The signing key, set for one test and removed afterwards like every other env the suite touches. */
async function withDigestKey<T>(fn: () => Promise<T>): Promise<T> {
  const had = process.env.ARC_DIGEST_KEY;
  process.env.ARC_DIGEST_KEY = `0x${'ab'.repeat(32)}`;
  try {
    return await fn();
  } finally {
    if (had === undefined) delete process.env.ARC_DIGEST_KEY;
    else process.env.ARC_DIGEST_KEY = had;
  }
}

/**
 * A day is 19200 ticks, which is not a number of `advance()` calls anybody
 * wants to sit through. Replacing the config with a clone shortens the day
 * without touching `DEFAULT_CONFIG`, which every other test in this file shares
 * by reference — mutating it in place would quietly redefine the length of a
 * day for the whole suite.
 */
function shortenDay(app: ReturnType<typeof createApp>, ticksPerDay = 4): void {
  app.world.config = { ...app.world.config, ticksPerDay };
}

async function tickTimes(app: ReturnType<typeof createApp>, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const res = await app.fetch(post('/tick', {}));
    assert.equal(res.status, 200, `the debug tick is enabled for the whole suite`);
  }
}

/**
 * Wait for the pump to reach a state. `advance()` deliberately does not await
 * it — a stalled chain RPC must not be able to hold up a page load — so the
 * only observable truth is what the pump has persisted, and the assertion has to
 * read that rather than assume the floating promise already landed.
 */
async function untilDigest(
  read: () => DigestRecord | undefined,
  done: (r: DigestRecord) => boolean,
  what: string,
): Promise<DigestRecord> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const r = read();
    if (r && done(r)) return r;
    if (Date.now() > deadline) throw new Error(`digest never became ${what}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

/**
 * Let the floating pump land before concluding it did nothing.
 *
 * `advance()` deliberately does not await the pump, so an assertion that fires
 * the instant a request returns is racing a promise that still has a hash to
 * compute and a round trip to make. Positive assertions dodge this by waiting
 * for a state (`untilDigest`); a negative one — "no second transaction was
 * bought" — has to wait for the absence, which means giving the pump more than
 * the local endpoint needs to answer. Without this, a test passes identically
 * whether the code is correct or the guard it is checking has been deleted.
 */
async function pumpQuiet(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

/**
 * Make the day's hash take real time, so a second request can land inside it.
 *
 * The only thing separating the two reads of the world in `pumpDigest` is time:
 * in production, the time it takes another viewer request to tick the tank while
 * the anchor's payload is being hashed. `sha256Hex` reaches for
 * `globalThis.crypto.subtle` when it is called rather than when the module loaded,
 * so wrapping it is the one seam that turns "occasionally, under load" into
 * "every run, in this file" — which is the difference between a bug that only the
 * public site can meet and a regression test.
 */
async function withSlowDigest<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const real = globalThis.crypto;
  const slow = new Proxy(real, {
    get(target, prop) {
      if (prop !== 'subtle') return Reflect.get(target, prop);
      const subtle = target.subtle;
      return new Proxy(subtle, {
        get(t, p) {
          if (p !== 'digest') return Reflect.get(t, p);
          return async (algorithm: string, data: Uint8Array) => {
            await new Promise((r) => setTimeout(r, ms));
            return t.digest(algorithm, data);
          };
        },
      });
    },
  });
  Object.defineProperty(globalThis, 'crypto', { value: slow, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true, writable: true });
  }
}

type StateWithDigest = {
  day: number;
  ticksPerDay: number;
  dayAnchor: { day: number; digest: string };
  digestChain: {
    day: number;
    status: DigestRecord['status'];
    txHash: string | null;
    confirmedAt: number | null;
    attempts: number;
    maxAttempts: number;
    payload: DigestPayload;
    hash: string;
    verifies: boolean;
  } | null;
};

const readState = async (app: ReturnType<typeof createApp>): Promise<StateWithDigest> =>
  (await (await app.fetch(new Request('http://localhost/state'))).json()) as StateWithDigest;

const STATS = {
  day: 7, tick: 12345, population: 44, totalEnergy: 8123,
  born: 500, died: 480, predations: 311, topPredator: 'ghast:12',
};

test('the pre-image is a fixed published string, so a stranger can reproduce the hash', async () => {
  // Both literals below came from a different SHA-256 implementation
  // (`printf '%s' '…' | shasum -a 256`), written out by hand from
  // `DIGEST_HASH_FIELDS`. This is the test that turns "somebody tidied the
  // pre-image" into a red build instead of a chain of anchors that nobody can
  // verify any more — which is the whole asset the anchor is.
  assert.equal(
    await digestHash(STATS),
    'de7c09b114dae50e27882d2af92fca863e0fe4ef78366f9e595cb84cd75cb746',
  );
  // An empty world anchors too, and `null` renders as `~` rather than nothing.
  assert.equal(
    await digestHash({ ...STATS, day: 0, tick: 19200, population: 0, totalEnergy: 0, born: 0, died: 0, predations: 0, topPredator: null }),
    'bde238eb14bb65166e582d60b37339e65269bd055cd69087462627a545a044f7',
  );
  // Positional, not serialization-dependent: a verifier who rebuilds the object
  // in a different key order must still agree.
  const shuffled = {
    topPredator: STATS.topPredator, born: STATS.born, totalEnergy: STATS.totalEnergy,
    predations: STATS.predations, died: STATS.died, population: STATS.population,
    tick: STATS.tick, day: STATS.day,
  };
  assert.equal(await digestHash(shuffled), await digestHash(STATS));
  assert.equal(DIGEST_V, 1, 'v:1 is the only rule that ever anchored anything');
});

test('the day\'s numbers come off the world, and a tie is settled by name', async () => {
  const creatures = [
    { archetype: 'ghast', kills: 3, energy: 10.4 },
    { archetype: 'angler', kills: 3, energy: 20.6 },
  ];
  const w = { tick: 99, creatures, totalBorn: 12, totalDied: 7, totalPredations: 6 };
  assert.deepEqual(digestStats(5, w), {
    day: 5, tick: 99, population: 2, totalEnergy: 31, born: 12, died: 7, predations: 6,
    topPredator: 'angler:3',
  });
  // The same population in the other order must produce the same winner. Built
  // by iterating the array, an order-dependent tie-break would anchor a fact
  // about who spawned first — which no holder of the payload can reproduce.
  assert.equal(
    digestStats(5, { ...w, creatures: [...creatures].reverse() }).topPredator,
    'angler:3',
    'a tie settled by array order is not a commitment',
  );
  assert.equal(digestStats(0, { ...w, creatures: [] }).topPredator, null);
  assert.equal(digestStats(0, { ...w, creatures: [] }).totalEnergy, 0, 'an empty tank hashes cleanly');
});

test('every field the payload publishes is inside the commitment', async () => {
  const p = await buildPayload(STATS, 1_700_000_000_000);
  // D3, structurally: the payload's own key list minus the two fields that are
  // not world facts must equal the published field list. A field added for the
  // viewer without joining the pre-image — the exact gap that let the old code
  // show `topPredator` uncommitted — fails here rather than in production.
  assert.deepEqual(
    Object.keys(p).filter((k) => k !== 'hash' && k !== 'ts'),
    [...DIGEST_HASH_FIELDS],
  );
  assert.equal(await verifyPayload(p), true, 'and a payload we built verifies');

  for (const field of DIGEST_HASH_FIELDS) {
    const value = p[field];
    const tampered = { ...p, [field]: value === null ? 'x:1' : typeof value === 'number' ? value + 1 : 'tampered' };
    assert.equal(await verifyPayload(tampered), false, `${field} is in the hash, so changing it must break it`);
  }
  // Dropping a field breaks it too: `undefined` is not `~`.
  const { predations: _dropped, ...minusOne } = p;
  assert.equal(await verifyPayload(minusOne as DigestPayload), false);
  // When we broadcast is not a world fact, so it is deliberately outside the
  // hash and may change without invalidating anything.
  assert.equal(await verifyPayload({ ...p, ts: p.ts + 60_000 }), true);
});

test('the next move is decided by the wall clock, not by how often the pump runs', () => {
  const now = 1_800_000_000_000;
  const base = newDigestRecord(0, { ...STATS, day: 0, v: DIGEST_V, hash: 'x', ts: now });
  assert.equal(base.status, 'queued');
  assert.equal(base.lastAttemptAt, 0, 'a fresh record is due immediately, so a day boundary can anchor in the same tick');
  assert.equal(nextDigestAction(base, now), 'submit');

  const sent = markSubmitted(base, now);
  assert.equal(sent.status, 'submitting');
  assert.equal(sent.attempts, 1, 'the attempt is counted before the network call, not after');
  assert.equal(nextDigestAction(sent, now), 'none', 'an in-flight attempt is not retried a quarter second later');
  assert.equal(nextDigestAction(sent, now + DIGEST_RETRY_MS), 'submit', 'a crashed isolate is recovered on the retry clock');

  const acked = markPending(sent, DIGEST_TX, now);
  assert.equal(nextDigestAction(acked, now + DIGEST_POLL_MS - 1), 'none');
  assert.equal(nextDigestAction(acked, now + DIGEST_POLL_MS), 'poll');
  assert.equal(isSettled(acked), false, 'a transaction in flight is not the end of the day');

  const dropped = markFailed(sent, now);
  assert.equal(nextDigestAction(dropped, now + DIGEST_RETRY_MS), 'submit');
  const exhausted = { ...dropped, attempts: DIGEST_MAX_ATTEMPTS };
  assert.equal(nextDigestAction(exhausted, now + DIGEST_RETRY_MS * 10), 'none', 'the budget is finite');
  assert.equal(isSettled(exhausted), true, 'so the next day may take over the record');
  assert.equal(isSettled(dropped), false, 'one hiccup across a day boundary does not forfeit the anchor');

  assert.equal(nextDigestAction(markConfirmed(acked, now), now), 'none');
  assert.equal(nextDigestAction(markUnconfigured(base, now), now), 'none');
  assert.equal(isSettled(markUnconfigured(base, now)), true, 'unconfigured is terminal, so configuring a key starts within a day');
});

test('a record may not claim a transaction that was never broadcast', () => {
  const now = 1_800_000_000_000;
  const base = newDigestRecord(0, { ...STATS, day: 0, v: DIGEST_V, hash: 'x', ts: now });
  // Every transition the pump can perform lands clean, which is the point of
  // having them: the states below are reachable only by writing a status and a
  // txHash independently, and that separation is the bug this module exists to
  // make unrepresentable.
  for (const r of [
    base,
    markSubmitted(base, now),
    markPending(markSubmitted(base, now), DIGEST_TX, now),
    markFailed(markSubmitted(base, now), now),
    markConfirmed(markPending(markSubmitted(base, now), DIGEST_TX, now), now),
    markUnconfigured(base, now),
  ]) {
    assert.equal(coherenceProblem(r), null, `${r.status} is a legal state`);
  }

  const liar = { ...markPending(markSubmitted(base, now), DIGEST_TX, now), txHash: null };
  assert.match(coherenceProblem(liar) ?? '', /pending without a txHash/, 'D1 named out loud');
  const confirmed = markConfirmed(markPending(markSubmitted(base, now), DIGEST_TX, now), now);
  assert.match(
    coherenceProblem({ ...confirmed, confirmedAt: null }) ?? '',
    /confirmed without a confirmation time/,
    'a checkmark needs a time, or the UI is promising a fact it does not have',
  );
  assert.match(
    coherenceProblem({ ...confirmed, txHash: null }) ?? '',
    /confirmed without a txHash/,
  );
  assert.match(coherenceProblem({ ...base, attempts: 3 }) ?? '', /fresh record/, 'an attempt count cannot predate the record');
  // On an otherwise sound record, so the named problem is the one under test:
  // the checks are ordered, and a `pending` with no hash reports that first.
  assert.match(coherenceProblem({ ...confirmed, attempts: -1 }) ?? '', /negative/);
  assert.match(coherenceProblem({ ...confirmed, txHash: '0x123' }) ?? '', /not a tx hash/);

  // A revert keeps its hash, because the chain produced real evidence; a throw
  // keeps nothing, because there is no transaction to point at.
  assert.equal(markFailed(markSubmitted(base, now), now, DIGEST_TX).txHash, DIGEST_TX);
  assert.equal(markFailed(markSubmitted(base, now), now).txHash, null);
});

test('the calldata is a tagged payload a reader of the chain can decode alone', () => {
  const p = { ...STATS, v: DIGEST_V, hash: 'ab'.repeat(32), ts: 1 };
  const data = encodeDigest(p);
  assert.ok(data.startsWith(DIGEST_MAGIC), '"ABYS", so our records are findable on a block explorer');
  assert.deepEqual(
    JSON.parse(Buffer.from(data.slice(DIGEST_MAGIC.length), 'hex').toString('utf8')),
    p,
    'the JSON survives the hex round trip byte for byte',
  );
});

/* ---------- the pump, driven through the handler ---------- */

test('crossing into a new day anchors the day that closed', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withDigestKey(async () => {
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 3);
      assert.equal(m.digest(), undefined, 'day 0 has not closed, so nothing is promised about it');
      assert.equal(rpc.sends.length, 0, 'and no gas has been offered for it');

      await tickTimes(app, 1); // tick 4, day 1: the pump now owns day 0
      const rec = await untilDigest(m.digest, (r) => r.status === 'pending', 'pending');
      assert.equal(rec.day, 0, 'the day that closed, not the one that opened');
      assert.equal(rec.attempts, 1);
      assert.equal(rec.txHash, DIGEST_TX, 'pending is the one status that may carry a hash');
      assert.equal(coherenceProblem(rec), null);
      assert.equal(rec.payload.tick, 4, 'the world as of the boundary, not as of whenever the send landed');
      assert.deepEqual(
        rec.payload,
        await buildPayload(digestStats(0, app.world), rec.payload.ts),
        'the record is exactly what the shared stats+hash calls produce from this world',
      );

      const state = await readState(app);
      assert.equal(state.digestChain?.status, 'pending');
      assert.equal(state.digestChain?.verifies, true, 'and the API invites the reader to check it');
      assert.equal(state.digestChain?.maxAttempts, DIGEST_MAX_ATTEMPTS);
      assert.equal(state.digestChain?.txHash, DIGEST_TX);
      assert.equal(state.digestChain?.hash, rec.payload.hash);

      // The signed transaction carries the payload whole, so what was hashed is
      // what the chain will hold. RLP leaves the calldata verbatim, which makes
      // a substring check a complete test of the encode-to-wire path.
      assert.equal(rpc.sends.length, 1);
      assert.ok(
        rpc.sends[0].includes(encodeDigest(rec.payload).slice(2)),
        'the bytes on the wire are the bytes in the API',
      );

      // A day still outstanding is not replaced, and not resent either: an
      // unresolved anchor crossing a boundary must not buy a second one.
      await tickTimes(app, 4);
      await pumpQuiet();
      assert.equal(rpc.sends.length, 1, 'no duplicate commitment while the first is unconfirmed');
      assert.equal(m.digest()?.day, 0, 'the unsettled day keeps its record rather than being dropped for a newer one');
    });
  } finally {
    rpc.close();
  }
});

test('a broadcast the endpoint refuses is recorded as a failure, not as a commitment', async () => {
  // The exact shape of the first real deployment: Arc takes fees in USDC, so an
  // account that was funded with nothing throws on the very first send.
  const rpc = await digestRpcStub('insufficient funds for gas * price + value');
  const m = memStore();
  try {
    await withDigestKey(async () => {
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 4);
      const rec = await untilDigest(m.digest, (r) => r.status === 'failed', 'failed');
      assert.equal(rec.txHash, null, 'there is no transaction to point at');
      assert.equal(rec.attempts, 1);
      assert.equal(coherenceProblem(rec), null, 'a failure is a legal state, unlike the one it replaces');
      assert.equal(rpc.sends.length, 0, 'and it was never accepted');
      assert.ok(
        rpc.methods.includes('eth_sendRawTransaction'),
        'the endpoint was actually asked and actually refused, not a client-side complaint about '
        + 'a balance the stub never gave it',
      );
      assert.equal(
        nextDigestAction(rec, Date.now() + DIGEST_RETRY_MS),
        'submit',
        'and it is the state a retry follows, which the old one was not',
      );

      const state = await readState(app);
      assert.notEqual(state.digestChain?.status, 'pending', 'the UI can never render "Committing…" over this');
      assert.equal(state.digestChain?.txHash, null);
      assert.equal(state.digestChain?.attempts, 1);
      assert.equal(state.digestChain?.verifies, true, 'the payload was sound; the broadcast is what failed');
    });
  } finally {
    rpc.close();
  }
});

test('a retry re-sends the numbers it committed, not a fresh reading of the tank', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withDigestKey(async () => {
      // Deliberately a payload from a different world than the one the app is
      // about to run: only a mismatch between "recorded then" and "reading now"
      // can distinguish resending a commitment from re-sampling it. The old code
      // did the latter, so a retried anchor carried a hash from one moment and
      // numbers from a later one — still verifiable against itself, and lying
      // about the day it claimed to describe.
      const committed = await buildPayload({ ...STATS, day: 0, tick: 4 }, 1);
      m.seedDigest(markFailed(markSubmitted(newDigestRecord(0, committed), 1), 0));
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 4);
      const rec = await untilDigest(m.digest, (r) => r.status === 'pending', 'resent');
      assert.deepEqual(rec.payload, committed, 'the record still describes the world it was taken from');
      assert.equal(rec.attempts, 2, 'the retry consumed its own attempt');
      assert.equal(rpc.sends.length, 1);
      assert.ok(
        rpc.sends[0].includes(encodeDigest(committed).slice(2)),
        'and the bytes the chain was handed are the bytes that were hashed, not the live tank',
      );
      assert.notEqual(
        rec.payload.population,
        app.world.creatures.length,
        'sanity: the two really do differ, or none of the above proves anything',
      );
    });
  } finally {
    rpc.close();
  }
});

test('a cold isolate inherits the outstanding anchor instead of buying a second one', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withDigestKey(async () => {
      const first = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(first);
      await tickTimes(first, 4);
      const sent = await untilDigest(m.digest, (r) => r.status === 'pending', 'pending');
      assert.equal(rpc.sends.length, 1);

      // A fresh isolate, same storage: this is every eviction and every cold
      // boot. The record has to come back out of the ledger, because a digest
      // that starts from nothing re-submits the day it already paid for.
      const second = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(second);
      const inherited = await readState(second);
      assert.equal(inherited.digestChain?.payload.hash, sent.payload.hash, 'hydrated, before any day boundary');
      assert.equal(inherited.digestChain?.status, 'pending');

      await tickTimes(second, 4);
      await pumpQuiet();
      assert.equal(rpc.sends.length, 1, 'and the second isolate never asks the chain to take the same money twice');
      assert.equal(m.digest()?.attempts, 1, 'the attempt count survived, so the retry budget did not reset');
      assert.deepEqual(m.digest()?.payload, sent.payload, 'the payload is the one that was broadcast, not a re-read');
    });
  } finally {
    rpc.close();
  }
});

test('a stored record that claims more than happened is dropped, not trusted', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    // Written under some other set of rules, or by a bug since fixed: the
    // storage outlives the code, and this is the one place anybody finds out.
    m.seedDigest({
      ...newDigestRecord(3, await buildPayload({ ...STATS, day: 3 }, 1)),
      status: 'pending',
      txHash: null,
      attempts: 1,
      lastAttemptAt: 1,
    });
    const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
    const state = await readState(app);
    assert.equal(state.digestChain, null, 'a lie is not a status worth publishing');
    await tickTimes(app, 1);
    assert.equal(rpc.sends.length, 0, 'and it is not one worth acting on');
  } finally {
    rpc.close();
  }
});

test('a payload that does not verify is never broadcast, and never wedges the pipeline', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withDigestKey(async () => {
      // One attempt short of the budget, with a hash that cannot survive
      // verification — the state a corrupted payload or a changed rule produces.
      const broken = await buildPayload({ ...STATS, day: 0, tick: 4 }, 1);
      m.seedDigest({
        ...newDigestRecord(0, broken),
        status: 'failed',
        attempts: DIGEST_MAX_ATTEMPTS - 1,
        lastAttemptAt: 0,
        payload: { ...broken, hash: 'ff'.repeat(32) },
      });
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 4);

      // The gate is before the network: refusing to anchor a claim we cannot
      // stand behind costs a hash and buys the guarantee that anything on the
      // chain is internally consistent, which is the only thing an anchor is.
      const spent = await untilDigest(m.digest, (r) => r.attempts >= DIGEST_MAX_ATTEMPTS, 'a spent budget');
      assert.equal(rpc.sends.length, 0, 'nothing was broadcast');
      assert.equal(spent.status, 'failed');
      assert.equal(isSettled(spent), true, 'an attempt that cannot succeed is counted, so the budget still closes');

      // And closing is the point: an attempt that was never counted would leave
      // this record unsettled forever, holding every later day behind it.
      await tickTimes(app, 4);
      // Waiting for the outcome, not merely for the day: `submitting` is written
      // to storage before the network call, so a record for day 1 is visible
      // while the broadcast is still in flight. A test that stopped at the day
      // would end with a live promise against an endpoint it is about to close.
      const next = await untilDigest(m.digest, (r) => r.day === 1 && r.status === 'pending', 'the next day anchored');
      assert.equal(rpc.sends.length, 1);
      assert.equal(next.attempts, 1, 'a fresh budget, because the broken day spent its own');
    });
  } finally {
    rpc.close();
  }
});

test('the receipt settles an anchor, and a settled day lets the next one through', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withDigestKey(async () => {
      const queued = newDigestRecord(0, await buildPayload({ ...STATS, day: 0, tick: 4 }, 1));
      m.seedDigest(markPending(markSubmitted(queued, 1), DIGEST_TX, 0));
      rpc.setReceipt({ status: '0x1', blockNumber: '0x101', transactionHash: DIGEST_TX });
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 4);

      const done = await untilDigest(m.digest, (r) => r.status === 'confirmed', 'confirmed');
      // Settle before spending any more ticks. The confirmation's economics read is
      // still running, the pump is not re-entered while it runs, and these four
      // ticks are the only thing that drives day 1 forward — so on a busy machine
      // they were all swallowed by the busy window and the next day never anchored
      // at all. Under load this failed 4 times in 6 before the wait was here.
      await app.settleDigest();
      assert.equal(done.txHash, DIGEST_TX, 'the hash that was confirmed stays on the record');
      assert.ok((done.confirmedAt ?? 0) > 1, 'with a time, so the UI can show a checkmark and nothing more');
      assert.equal(rpc.methods.filter((x) => x === 'eth_sendRawTransaction').length, 0, 'a poll is not a resend');
      assert.equal(coherenceProblem(done), null);

      const state = await readState(app);
      assert.equal(state.digestChain?.status, 'confirmed');
      assert.equal(state.digestChain?.confirmedAt, done.confirmedAt);

      // Day 2 opens, and the record is free to move on because day 0 is finished.
      await tickTimes(app, 4);
      const next = await untilDigest(m.digest, (r) => r.day === 1 && r.status === 'pending', 'day 1 anchored');
      assert.equal(next.attempts, 1, 'a fresh budget for a fresh day');
      assert.equal(rpc.sends.length, 1);
    });
  } finally {
    rpc.close();
  }
});

test('a transaction that mined and reverted keeps its hash and loses its status', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withDigestKey(async () => {
      const queued = newDigestRecord(0, await buildPayload({ ...STATS, day: 0, tick: 4 }, 1));
      m.seedDigest(markPending(markSubmitted(queued, 1), DIGEST_TX, 0));
      rpc.setReceipt({ status: '0x0', blockNumber: '0x101', transactionHash: DIGEST_TX });
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 4);

      const reverted = await untilDigest(m.digest, (r) => r.status === 'failed', 'a failed revert');
      assert.equal(reverted.txHash, DIGEST_TX, 'the chain produced real evidence, so the record keeps it');
      assert.equal(coherenceProblem(reverted), null);
      assert.equal((await readState(app)).digestChain?.txHash, DIGEST_TX);

      // No receipt at all means still in flight, which is precisely what
      // `pending` claims — the honest reading, and the one the old code reached
      // by accident from a path that had never broadcast anything.
      const still = markPending(markSubmitted(queued, 1), DIGEST_TX, 0);
      rpc.setReceipt(null);
      m.seedDigest(still);
      const another = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
      shortenDay(another);
      await tickTimes(another, 4);
      await pumpQuiet();
      // Both halves of the record are checked, because they are two different
      // chances to be wrong: an unanswered poll may rewrite what was persisted,
      // or rewrite only this isolate's copy of it and leave `/state` reporting
      // something the ledger never agreed to.
      assert.equal(m.digest()?.status, 'pending', 'an unanswered poll says nothing about the transaction');
      assert.equal(m.digest()?.txHash, DIGEST_TX);
      assert.equal((await readState(another)).digestChain?.status, 'pending', 'including what the API tells a viewer');
    });
  } finally {
    rpc.close();
  }
});

test('with no signing key a day closes off-chain and says so', async () => {
  assert.equal(process.env.ARC_DIGEST_KEY, undefined, 'no test may leak a key into this one');
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, ...offlineFeeds });
    shortenDay(app);
    await tickTimes(app, 4);
    const rec = await untilDigest(m.digest, (r) => r.status === 'unconfigured', 'unconfigured');
    assert.equal(rec.txHash, null);
    assert.equal(rpc.sends.length, 0, 'not one request was made');
    const state = await readState(app);
    assert.equal(state.digestChain?.status, 'unconfigured', 'the same word the UI renders as "Off-chain"');
    assert.equal(isSettled(rec), true, 'so configuring a key starts anchoring within a day, without a restart');
  } finally {
    rpc.close();
  }
});

test('the preview a viewer watches all day is the computation the anchor uses', async () => {
  const m = memStore();
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  await tickTimes(app, 2);
  const state = await readState(app);
  // The label under the chip promises that this number commits on chain at the
  // end of the day. It used to be an 8-digit FNV over a different field list
  // than the one that got broadcast, so the promise was false for the entire
  // life of the feature; both sides now call the same two functions, which is
  // the only arrangement that cannot drift back apart.
  assert.equal(state.dayAnchor.day, Math.floor(app.world.tick / state.ticksPerDay));
  assert.equal(state.dayAnchor.digest, await digestHash(digestStats(state.dayAnchor.day, app.world)));
  assert.match(state.dayAnchor.digest, /^[0-9a-f]{64}$/, 'a SHA-256, not eight hex digits');
});

/* ---------- self-observation: the counters behind the log lines ---------- */

/**
 * Nine guards in the deployed code print a line when something fails, and every
 * one of those lines is addressed to a reader who happens to be tailing the
 * worker at the second the failure happens. Whether that reader exists is not a
 * hypothetical to argue about: in the tail captures kept on disk, console output
 * has never once arrived, while platform exceptions have. These tests are the
 * other half — a number that can be asked for later, through the same durable
 * object that had the failure, and through an isolate that did not.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a signal ledger counts, keeps the reason, and refuses a name nobody declared', () => {
  const h = createHealth(1000);
  assert.deepEqual(h.view(), { startedAt: 1000, counts: {}, last: {} }, 'a fresh ledger has nothing to say');
  assert.equal(healthProblem(h.view()), null);

  h.note('ledger_not_stored', new Error('string or blob too big'));
  h.note('ledger_not_stored', 'a reason that is only a string');
  const v = h.view();
  assert.equal(v.counts.ledger_not_stored, 2);
  assert.equal(v.last.ledger_not_stored.count, 2, 'the event carries the total it was the second of');
  assert.equal(v.last.ledger_not_stored.detail, 'a reason that is only a string', 'the newest reason wins');
  assert.equal(healthProblem(v), 'ledger_not_stored=2');

  assert.throws(
    () => h.note('made_up_kind' as never),
    /unknown health signal/,
    'a typo at a call site is a bug, not a place to lose a count',
  );

  // Every declared kind has to be usable and has to reach `problem`: dropping
  // one from the list would otherwise turn that guard back into a log line.
  const all = createHealth(1);
  for (const kind of SIGNAL_KINDS) all.note(kind);
  assert.deepEqual(Object.keys(all.view().counts).sort(), [...SIGNAL_KINDS].sort());
  const reported = healthProblem(all.view())?.split(' ') ?? [];
  assert.equal(reported.length, SIGNAL_KINDS.length, 'nothing is counted and then left unsaid');

  // A detail is capped, because this object is written to storage: an error
  // carrying a 1 MB SQL statement must not become a 1 MB health record. And the
  // cap keeps both ends, because the errors met for real here bury the reason
  // last: viem prints a headline, then the request (hundreds of characters of
  // calldata), then `Details:` with the endpoint's own answer.
  const long = createHealth(1);
  long.note('snapshot_not_saved', new Error('x'.repeat(5000)));
  const clipped = long.view().last.snapshot_not_saved.detail;
  assert.ok(clipped.length <= 400, `capped, was ${clipped.length}`);
  assert.match(clipped, / … /, 'with the cut marked rather than hidden');
});

test('merging a stored ledger only ever moves it forward', () => {
  const mine = createHealth(1000);
  mine.note('receipt_not_stored');
  mine.note('receipt_not_stored');

  // The stored copy is behind. Reading it must not rewrite history this isolate
  // has already lived through — the write that would have raised it is the
  // failure being counted.
  mine.merge({ counts: { receipt_not_stored: 1 }, last: {} });
  assert.equal(mine.view().counts.receipt_not_stored, 2, 'a merge never lowers a count');

  // The stored copy is ahead: another isolate saw things this one did not.
  const later = Date.now() + 60_000;
  mine.merge({
    counts: { receipt_not_stored: 7, snapshot_not_saved: 3 },
    last: {
      receipt_not_stored: { at: later, detail: 'from disk', count: 7 },
      snapshot_not_saved: { at: later, detail: 'older isolate', count: 3 },
    },
  });
  const v = mine.view();
  assert.equal(v.counts.receipt_not_stored, 7, 'what the other isolate saw is still counted');
  assert.equal(v.counts.snapshot_not_saved, 3);
  assert.equal(v.last.receipt_not_stored.detail, 'from disk', 'and the newer event wins for that kind');
  assert.equal(v.last.receipt_not_stored.count, 7);

  // Junk in storage is ignored rather than trusted, and cannot invent a kind.
  const strict = createHealth(1);
  strict.merge('not an object');
  strict.merge({ counts: { made_up_kind: 9, real_but_float: 1.5, snapshot_not_saved: -4 }, last: null });
  assert.deepEqual(strict.view().counts, {}, 'unknown, non-numeric and negative entries all go unread');

  // And a view that went through JSON is the same shape it came out as: this is
  // what the Durable Object stores.
  const round = createHealth(2222);
  round.note('digest_reverted', new Error('execution reverted'));
  const json = JSON.parse(JSON.stringify(round.view())) as HealthView;
  assert.deepEqual(json.counts, { digest_reverted: 1 });
  assert.equal(json.startedAt, 2222);
});

test('the receipts byte formula is checked against the array it describes', async () => {
  const { SNAPSHOT_BUDGET, DO_VALUE_LIMIT } = await import('@abyssal/sim');
  // The claim is that one storage value grows by exactly 69 bytes a burn, which
  // is only true while every entry is a 66-character hash. Measured against the
  // real thing rather than trusted: if the shape of a stored receipt ever
  // changes, this is the test that notices the arithmetic did not follow.
  for (const n of [0, 1, 2, 7, 500]) {
    const arr = Array.from({ length: n }, (_, i) => '0x' + i.toString(16).padStart(64, '0'));
    assert.equal(receiptsValueBytes(n), JSON.stringify(arr).length, `n=${n}`);
  }

  // Where that leaves the guard, in burns rather than bytes.
  const crossing = Math.floor((SNAPSHOT_BUDGET - 1) / 69);
  assert.ok(receiptsValueBytes(crossing) <= SNAPSHOT_BUDGET, 'the last count under the alarm line');
  assert.ok(receiptsValueBytes(crossing + 1) > SNAPSHOT_BUDGET, 'and the first over it');
  const wall = Math.floor((DO_VALUE_LIMIT - 1) / 69);
  assert.ok(receiptsValueBytes(wall) <= DO_VALUE_LIMIT && receiptsValueBytes(wall + 1) > DO_VALUE_LIMIT);
  assert.ok(crossing > 20_000, 'which puts the alarm tens of thousands of burns away, not around the corner');
  assert.ok(wall > crossing, 'and the wall behind it');
});

/* ---------- the same thing through the Durable Object that has to do it ---------- */

const { AbyssalWorld: WorldDO } = await import('../src/worker.js');

interface DoHandle {
  obj: InstanceType<typeof WorldDO>;
  stored: Map<string, unknown>;
  attempted: string[];
  failing: Set<string>;
}

/**
 * A Durable Object over an in-memory storage, with the keys a caller wants to
 * break held in a set that can still be edited after the object is built —
 * seeding a condition and *then* making the write fail is most of what is worth
 * testing here.
 */
function worldDO(stored = new Map<string, unknown>(), env: Record<string, unknown> = {}): DoHandle {
  const attempted: string[] = [];
  const failing = new Set<string>();
  const obj = new WorldDO(
    {
      storage: {
        get: async <T = unknown>(key: string): Promise<T | undefined> => stored.get(key) as T | undefined,
        put: async (key: string, value: unknown) => {
          attempted.push(key);
          if (failing.has(key)) throw new Error(`string or blob too big: SQLITE_TOOBIG on ${key}`);
          stored.set(key, value);
        },
      },
      waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}); },
    },
    { WORLD: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null) }) }, ...env },
  );
  return { obj, stored, attempted, failing };
}

type HealthBody = {
  healthy: boolean | null;
  problem: string | null;
  signals: { counts: Record<string, number>; last: Record<string, { at: number; detail: string; count: number }> } | null;
  storage: {
    snapshotBytes: number | null;
    overBudget: boolean;
    receipts: number | null;
    receiptsBytes: number | null;
    receiptsOver: boolean;
    budget: number;
    limit: number;
  } | null;
  digest: {
    day: number;
    status: DigestRecord['status'];
    attempts: number;
    maxAttempts: number;
    txHash: string | null;
    verifies: boolean;
    signer: string | null;
  } | null;
  census: { days: number; cap: number; first: number | null; last: number | null };
  /** Signals that have fired and fallen out of the window that reddens the light. */
  stale: string | null;
  anchor: {
    signer: string | null;
    readAt: number;
    ageSeconds: number | null;
    funded: {
      feeUnits: string | null;
      feeDecimals: number;
      usdcUnits: string | null;
      usdcDecimals: number;
      bothRead: boolean;
      scaleOk: boolean | null;
    };
    lastCost: { feeUnits: string | null; day: number | null };
    runway: { anchors: number | null; unknown: string | null; alarmBelow: number; low: boolean; alarmNoted: boolean; capped: boolean };
    revenue: { sales: number; quotedUnits: string; atReadingUnits: string | null; unitDecimals: number };
  };
  data: {
    forSale: boolean;
    priceUsdc: string;
    network: string;
    payTo: string | null;
    arcFeed: boolean;
    sales: number;
    salesThisIsolate: number;
    spentPayments: number;
  };
  /**
   * Which blocks the numbers above were computed from, and how far the chain had
   * moved beyond them. Null on the offline rain, which has no chain to hold a
   * position on.
   */
  feed: {
    indexedUpTo: number;
    head: number;
    lagBlocks: number | null;
    tag: string;
  } | null;
  world: { tick: number; day: number; ticksPerDay: number; population: number };
  instance: string;
  isolateStartedAt: number | null;
  serverTime: number;
};

const readHealth = async (target: { fetch(req: Request): Promise<Response> }): Promise<HealthBody> =>
  (await (await target.fetch(new Request('http://localhost/health'))).json()) as HealthBody;

/** The stored reason for one kind, or '' when that kind was never counted. */
const healthDetail = (body: HealthBody, kind: string): string => body.signals?.last[kind]?.detail ?? '';

/** Capture rather than silence: several of these tests assert on the printed line too. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[]; warnings: string[] }> {
  const realError = console.error;
  const realWarn = console.warn;
  const errs: unknown[][] = [];
  const warns: unknown[][] = [];
  console.error = (...args: unknown[]) => { errs.push(args); };
  console.warn = (...args: unknown[]) => { warns.push(args); };
  try {
    const value = await fn();
    return { value, errors: errs.map((a) => String(a[0])), warnings: warns.map((a) => String(a[0])) };
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

test('/health reports a tank with nothing to report, with the numbers behind the answer', async () => {
  const { SNAPSHOT_BUDGET, DO_VALUE_LIMIT } = await import('@abyssal/sim');
  const { obj } = worldDO();
  const { value: body, errors, warnings } = await quiet(async () => {
    await obj.fetch(new Request('http://localhost/api'));
    return readHealth(obj);
  });
  assert.deepEqual(errors, [], 'a healthy tank prints nothing and claims nothing');
  assert.deepEqual(warnings, []);
  assert.equal(body.healthy, true);
  assert.equal(body.problem, null);
  assert.deepEqual(body.signals?.counts, {});
  assert.equal(body.storage?.receipts, 0, 'the receipt count comes from the object that owns the array');
  assert.equal(body.storage?.budget, SNAPSHOT_BUDGET);
  assert.equal(body.storage?.limit, DO_VALUE_LIMIT);
  assert.ok((body.storage?.snapshotBytes ?? 0) > 1000, 'the last save reported the size it wrote');
  assert.equal(body.storage?.overBudget, false);
  assert.equal(body.digest, null, 'day zero has anchored nothing, and does not invent a status for it');
  assert.ok(body.world.population > 0, 'the world it is reporting on is the one it is holding');
  assert.ok(body.isolateStartedAt && body.isolateStartedAt <= body.serverTime);
  assert.ok(typeof body.instance === 'string' && body.instance.length > 0);
});

test('/health says nothing at all when nobody is counting', async () => {
  // A bare `createApp` has no durable object to ask about storage and no ledger
  // wired, which is the truth the route has to tell. Reporting `healthy: true`
  // from an uninstrumented process is how a monitor learns to trust a hunch.
  const app = createApp({ seed: 1, ...offlineFeeds });
  const { value: body } = await quiet(() => readHealth(app));
  assert.equal(body.healthy, null, 'unknown, not clean');
  assert.equal(body.signals, null);
  assert.equal(body.storage, null);
  assert.equal(body.problem, null);
});

test('/health publishes how much of the chain its own numbers were computed from', async () => {
  // Every meter, flow and census row this endpoint reports is computed over the
  // blocks one poll walked, and none of them say which. A reader checking the page
  // against a block explorer wants the height the observatory stopped at, and the
  // operator wants the gap between that and the head: whether "final" is currently
  // the whole chain or something short of it is a reading, and a reading that
  // cannot be looked up can only be argued about.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const HEAD = 8192;
  const { server, setFinalityLag } = chainRpcStub(HEAD, 2);
  setFinalityLag(64);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const m = memStore();
  try {
    const feed = new ArcUsdcFeed(url, ARC_USDC_ADDRESS, { backfillBlocks: 16, pollEveryMs: 0 });
    const app = createApp({ seed: 1, chainFeed: feed, store: m.store, marketFeed: quietMarket });
    await app.warmFeed();
    const { value: body, errors } = await quiet(() => readHealth(app));
    assert.deepEqual(
      body.feed,
      { indexedUpTo: HEAD - 64, head: HEAD, lagBlocks: 64, tag: 'finalized' },
      'the two heights, the gap, and the rule that produced it — in one object',
    );
    assert.equal(body.data.arcFeed, true, 'the block agreeing on which feed this is agrees with this one');
    assert.deepEqual(errors, [], 'publishing a lag is not an alarm: nothing failed here');

    // The offline rain has no chain position to publish, and an invented one is
    // the difference between `null` and a `0` a reader would take as "fully
    // indexed" from a feed that never asked the question.
    const bare = createApp({ seed: 1, ...offlineFeeds });
    assert.equal((await readHealth(bare)).feed, null);
  } finally {
    server.close();
  }
});

test('a burn that cannot be stored becomes a number a later isolate can still read', async () => {
  const { recordBurnReceipt, setBurnLedger } = await import('../src/payments.js');
  const { obj, stored, attempted, failing } = worldDO();
  try {
    const { value } = await quiet(async () => {
      await obj.fetch(new Request('http://localhost/api'));
      failing.add('receipts');
      recordBurnReceipt('0x' + 'd7'.repeat(32));
      await sleep(80);
      return readHealth(obj);
    });
    assert.ok(attempted.includes('receipts'), 'the write was attempted');
    assert.equal(value.healthy, false);
    assert.equal(value.problem, 'receipt_not_stored=1');
    assert.equal(value.signals?.counts.receipt_not_stored, 1);
    assert.match(
      value.signals?.last.receipt_not_stored.detail ?? '',
      /SQLITE_TOOBIG on receipts/,
      'the counter keeps the reason, not only the tally',
    );

    // The counters live in their own storage value precisely because the
    // failure they describe is a storage value that could not be written. A
    // receipt too big to store says nothing about a 300-byte record of it.
    assert.ok(stored.has('health'), 'the counter itself reached storage');
    assert.equal((stored.get('health') as HealthView).counts.receipt_not_stored, 1);

    // An eviction: same storage, new object, no new failure.
    failing.clear();
    const second = worldDO(stored);
    const afterEviction = await quiet(async () => {
      await second.obj.fetch(new Request('http://localhost/api'));
      return readHealth(second.obj);
    });
    assert.equal(afterEviction.value.signals?.counts.receipt_not_stored, 1, 'the count outlived the isolate that recorded it');
    assert.equal(afterEviction.value.healthy, false, 'and the tank still reports as unwell');
    assert.deepEqual(afterEviction.errors, [], 'reading it back does not re-print the failure');
  } finally {
    setBurnLedger({ load: async () => [], add: () => {} });
  }
});

test('the receipt array gets its own alarm, because it is its own storage value', async () => {
  // This one is not hypothetical in the way the snapshot warning is: the receipts
  // array is append-only by design, since dropping an entry is dropping a replay
  // guard. So it reaches the ceiling on one storage value eventually, and until
  // now the only thing that said so was a line nobody reads.
  const { SNAPSHOT_BUDGET } = await import('@abyssal/sim');
  const { recordBurnReceipt, setBurnLedger } = await import('../src/payments.js');
  const seeded = Math.floor((SNAPSHOT_BUDGET - 1) / 69);
  assert.ok(receiptsValueBytes(seeded) <= SNAPSHOT_BUDGET, 'the seeded count is under the line');

  const stored = new Map<string, unknown>();
  stored.set('receipts', Array.from({ length: seeded }, (_, i) => '0x' + i.toString(16).padStart(64, '0')));
  const { obj } = worldDO(stored);
  try {
    const first = await quiet(async () => {
      await obj.fetch(new Request('http://localhost/api'));
      recordBurnReceipt('0x' + 'e5'.repeat(32));
      await sleep(120);
      return readHealth(obj);
    });
    assert.equal(first.value.storage?.receipts, seeded + 1, 'the burn was recorded');
    assert.equal(first.value.signals?.counts.receipts_past_budget, 1, 'and crossing the line announced itself once');
    assert.match(first.warnings.join('\n'), /burn receipts past budget/);
    assert.deepEqual(first.errors, [], 'a warning is not an error: nothing has failed yet');

    const second = await quiet(async () => {
      recordBurnReceipt('0x' + 'e6'.repeat(32));
      await sleep(120);
      return readHealth(obj);
    });
    assert.equal(second.value.storage?.receipts, seeded + 2);
    assert.equal(
      second.value.signals?.counts.receipts_past_budget,
      1,
      'staying over the line is not a second crossing, which is what makes the count worth reading',
    );
  } finally {
    setBurnLedger({ load: async () => [], add: () => {} });
  }
});

test('a refused broadcast is counted by the same guard that prints about it', async () => {
  const rpc = await digestRpcStub('insufficient funds for gas * price + value');
  const m = memStore();
  const health = createHealth(1);
  try {
    await withDigestKey(async () => {
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(app);
      await quiet(() => tickTimes(app, 4));
      await untilDigest(m.digest, (r) => r.status === 'failed', 'failed');
      const body = await readHealth(app);
      assert.equal(body.signals?.counts.digest_not_broadcast, 1);
      assert.equal(body.healthy, false);
      assert.match(body.problem ?? '', /digest_not_broadcast=1/);
      // The record and the counter are two views of one fact, and saying so in
      // one payload is the point: a reader can check the status against the tally
      // rather than take either on faith.
      assert.equal(body.digest?.status, 'failed');
      assert.equal(body.digest?.attempts, 1);
      assert.equal(body.digest?.verifies, true, 'the payload was sound; the broadcast is what failed');
      assert.equal(
        healthDetail(body, 'digest_not_broadcast').length <= 400,
        true,
        'the stored reason is bounded, whatever the endpoint said',
      );
      assert.match(
        healthDetail(body, 'digest_not_broadcast'),
        /^TransactionExecutionError: The total cost /,
        'the headline survives the cap',
      );
      assert.match(
        healthDetail(body, 'digest_not_broadcast'),
        /insufficient funds for gas \* price \+ value/,
        'and so does the endpoint\u2019s own answer, which sits at the end of a message whose '
        + 'middle is several hundred characters of calldata',
      );
    });
  } finally {
    rpc.close();
  }
});

test('a stored record that cannot be read back is counted every time it is refused', async () => {
  const m = memStore();
  const health = createHealth(1);
  m.seedDigest({
    ...newDigestRecord(3, await buildPayload({ ...STATS, day: 3 }, 1)),
    status: 'pending',
    txHash: null,
    attempts: 1,
    lastAttemptAt: 1,
  });
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  const { value } = await quiet(() => readHealth(app));
  assert.equal(value.digest, null, 'a lie is still not a status worth publishing');
  assert.equal(value.signals?.counts.digest_record_rejected, 1);
  assert.match(value.problem ?? '', /digest_record_rejected=1/);
  assert.equal(value.healthy, false, 'and the tank says so rather than reporting an empty history as clean');
  // The reason has to travel with the count. `console.error` next door is the
  // channel proven never to reach the edge, so a rejection that reports only that
  // a rejection happened is a number that still has to be guessed at by hand.
  assert.equal(
    value.signals?.last?.digest_record_rejected?.detail,
    coherenceProblem(m.digest()!),
    'the detail is the contradiction itself, not a mention that there was one',
  );
});

test('a payload whose hash no longer describes it is named without an attempt being made', async () => {
  // The condition this covers is not one the code can produce any more, which is
  // exactly why it needs reporting: a record written while the hashed field list
  // was different passes every state transition check, is still the outstanding
  // anchor, and will never be caught by the gate in front of a broadcast because
  // nothing ever reaches the gate — the day is already settled.
  const good = await buildPayload({ ...STATS, day: 12 }, 7);
  const tampered: DigestPayload = { ...good, population: good.population + 1 };
  assert.equal(await verifyPayload(tampered), false, 'the hash no longer describes the numbers');
  assert.equal(coherenceProblem(newDigestRecord(12, tampered)), null, 'and no state rule can see it');

  const m = memStore();
  const health = createHealth(1);
  m.seedDigest(newDigestRecord(12, tampered));
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  const { value } = await quiet(() => readHealth(app));
  assert.deepEqual(value.signals?.counts, {}, 'nothing happened, so nothing was counted');
  assert.equal(value.problem, 'digest_payload_mismatch', 'and it is still said');
  assert.equal(value.healthy, false);
  assert.equal(value.digest?.verifies, false);
  assert.equal(value.digest?.status, 'queued');
});

/* ---------- the day book: what was alive, beside what was anchored ---------- */

/**
 * The census route's payload, named once so the tests below assert against a
 * shape rather than against a pile of `as any`.
 */
type CensusBody = {
  cap: number;
  book: number;
  coverage: { first: number; last: number; days: number } | null;
  hashed: string[];
  rows: CensusDay[];
  changes: CensusChange[];
  today: Omit<CensusDay, 'hash' | 'ts'> & { committed: boolean };
};

const readCensus = async (
  target: { fetch(req: Request): Promise<Response> },
  query = '',
): Promise<CensusBody> =>
  (await (await target.fetch(new Request(`http://localhost/history/census${query}`))).json()) as CensusBody;

const sumHeads = (row: { byArchetype: Record<string, number> }): number =>
  Object.values(row.byArchetype).reduce((s, n) => s + n, 0);

/**
 * A hand-built row for the tests that need many of them (the cap, the
 * derivations) and cannot afford to live through that many days of tank.
 * Cumulative counters run forward by a fixed amount per day, so a delta is a
 * small literal instead of arithmetic on the fixture. Every one of these is
 * asserted to be a legal row in the test below it: a rejection anywhere else is
 * then the guard firing, not sloppy data.
 */
function censusFixture(
  day: number,
  byArchetype: Record<string, number> = { APE: 2, WHALE: 1, ALGO: 1, INSIDER: 1 },
): CensusDay {
  const population = sumHeads({ byArchetype });
  return {
    day,
    tick: (day + 1) * 19_200,
    population,
    totalEnergy: population * 100,
    born: 100 + day * 10,
    died: 50 + day * 5,
    predations: day * 3,
    topPredator: population ? `APE:${population}` : null,
    byArchetype,
    hash: 'ab'.repeat(32),
    ts: 1_800_000_000_000 + day * 86_400_000,
  };
}

test('the fixtures are rows the guard accepts, so a rejection later means something', () => {
  assert.equal(censusProblem(censusFixture(0)), null);
  assert.equal(censusProblem(censusFixture(401)), null);
  assert.equal(censusProblem(censusFixture(3, {})), null, 'an extinct day is a legal row, not a missing one');
});

test('a closed day is written into the book and still there when it is read back', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth(1);
  try {
    await withDigestKey(async () => {
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 3);
      assert.equal(m.dayBook()?.length ?? 0, 0, 'day 0 is still open, so nothing is promised about it and nothing is filed');

      await tickTimes(app, 1);
      const rec = await untilDigest(m.digest, (r) => r.status === 'pending', 'pending');
      const book = m.dayBook() ?? [];
      assert.equal(book.length, 1, 'the row and the record land in one write, so one without the other is a bug');
      const row = book[0];
      assert.equal(row.day, 0, 'the day that closed');
      assert.match(row.hash, /^[0-9a-f]{64}$/, 'bare digest hex, the shape `digestHash` emits — not a `0x` tx hash');
      assert.equal(await digestHash(row), row.hash, 'the stored row is still the pre-image its hash was taken from');
      assert.equal(sumHeads(row), row.population, 'the species add up to the population they were counted with');
      // The claim the whole design rests on, checked rather than described: the
      // census and the anchor are the same reading, so no viewer can be shown a
      // population that the chain commitment contradicts.
      assert.equal(row.population, rec.payload.population);
      assert.equal(row.tick, rec.payload.tick);

      // A second isolate over the same storage. This is the assertion that makes
      // the hash shape above load-bearing: a validator that expected the `0x` a
      // transaction hash carries would drop every honest row here, and the tank
      // would serve an empty history to anybody who restarted.
      const again = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      const reread = await readCensus(again);
      assert.deepEqual(reread.rows, book, 'read back whole, oldest first, with its hash intact');
      assert.deepEqual(reread.coverage, { first: 0, last: 0, days: 1 });
      const h = await readHealth(again);
      assert.equal(h.signals?.counts.census_row_rejected, undefined, 'a sound row is not refused on the way in');
      assert.deepEqual(h.census, { days: 1, cap: CENSUS_CAP, first: 0, last: 0 });
    });
  } finally {
    rpc.close();
  }
});

test('the tank keeps living while its day is filed, and the day still tells one story', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth(1);
  try {
    await withDigestKey(async () => {
      const app = createApp({ seed: 5, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 3);
      await withSlowDigest(120, async () => {
        const seam = Date.now();
        await digestHash(STATS);
        assert.ok(Date.now() - seam >= 60, 'the seam did not slow the hash, so nothing below can interleave');
        // `advance()` does not wait for the pump, so this request returns while the
        // day's payload is still being hashed — the exact arrangement that emptied
        // the published day book while every quiet-start test stayed green.
        const closing = app.fetch(post('/tick', {}));
        await new Promise((r) => setTimeout(r, 40));
        const atClosing = app.world.creatures.length;
        app.world.creatures.pop();
        await closing;
        await untilDigest(m.digest, (r) => r.day === 0, 'the closed day recorded');
        assert.equal(app.world.creatures.length, atClosing - 1, 'the world did move on mid-flight');
      });
      const book = m.dayBook() ?? [];
      assert.equal(book.length, 1, 'the day is filed');
      const row = book[0];
      assert.equal(sumHeads(row), row.population,
        'and its headcount is the population it was counted with, not the one standing when the hash landed');
      assert.equal(await digestHash(row), row.hash, 'the row still hashes to what went on chain');
      const h = await readHealth(app);
      assert.equal(h.signals?.counts.census_row_unsound, undefined, 'nothing had to be refused at the source');
      assert.equal(h.signals?.counts.census_row_rejected, undefined, 'and nothing will be dropped on the way back in');
    });
  } finally {
    rpc.close();
  }
});

test('one reading answers both questions, and two readings do not', () => {
  // A world that is different on every look is the harshest legal model of what
  // bit: `population` taken at one moment and `byArchetype` at another. One pass
  // cannot split, and the row built from two calls into the same world does.
  const tall = [
    { archetype: 'APE', kills: 1, energy: 10 },
    { archetype: 'APE', kills: 0, energy: 5 },
    { archetype: 'WHALE', kills: 4, energy: 20 },
  ];
  const short = [tall[0]];
  let high = true;
  const w: DigestWorldView = {
    tick: 19_200,
    totalBorn: 6,
    totalDied: 3,
    totalPredations: 2,
    get creatures() { const v = high ? tall : short; high = !high; return v; },
  };
  const reading = censusReading(7, w);
  assert.equal(sumHeads(reading), reading.stats.population, 'one look answers both questions');
  assert.equal(censusProblem(censusRow(reading.stats, reading.byArchetype, 'ab'.repeat(32), 1)), null,
    'and the row built from it is a row the guard accepts');
  const twice = censusRow(digestStats(7, w), headcountByArchetype(w), 'ab'.repeat(32), 1);
  assert.match(censusProblem(twice) ?? '', /is not the population/,
    'two reads of one world are the split this fixture can produce, and the guard exists for it');
});

test('a day whose own numbers disagree is not filed, and says which number lied', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth(1);
  try {
    await withDigestKey(async () => {
      const app = createApp({ seed: 7, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(app);
      // Not a contrived shape: the reading is taken off the world's own counters, so
      // an impossible one is how an upstream bug reaches the day book, and the
      // boundary is where it has to stop. Filed anyway, it would be charted as a
      // fact and refused on every cold start after — the book shrinking in silence.
      app.world.totalDied = -1_000_000;
      await tickTimes(app, 4);
      await untilDigest(m.digest, (r) => r.day === 0, 'the closed day recorded');
      assert.equal(m.dayBook()?.length ?? 0, 0, 'the day is not filed');
      const h = await readHealth(app);
      assert.equal(h.signals?.counts.census_row_unsound, 1, 'and not filed quietly');
      assert.match(h.signals?.last?.census_row_unsound?.detail ?? '', /negative cumulative counter/,
        'the reason travels to /health, because the console line never does');
      assert.match(h.problem ?? '', /census_row_unsound=1/);
    });
  } finally {
    rpc.close();
  }
});

test('a day that makes it on chain is told so, in its own row', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth(1);
  try {
    await withDigestKey(async () => {
      // Isolate one, the ordinary close of a day: the row is written and the
      // transaction is bought. The stamp is tested against *that* row and *that*
      // transaction rather than against two fixtures that agree because one hand
      // wrote them.
      const first = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(first);
      await tickTimes(first, 4);
      const sent = await untilDigest(m.digest, (r) => r.status === 'pending', 'pending');
      assert.equal(m.dayBook()?.length, 1);
      assert.equal(m.dayBook()![0].txHash, undefined, 'a broadcast still in flight is not yet evidence');

      // The receipt poll runs on a `DIGEST_POLL_MS` clock, which no test waits
      // out; backdating the last attempt is the same move `a poll that finds a
      // mined transaction` makes, and it touches only the clock the poll reads.
      m.seedDigest({ ...sent, lastAttemptAt: 0 });
      rpc.setReceipt({ status: '0x1', blockNumber: '0x101', transactionHash: sent.txHash });

      // Isolate two over the same storage. This is not ceremony: the row and the
      // outstanding record both have to come back off disk for a stamp to be
      // applied, so the case also settles whether a confirmation that lands
      // after an eviction still finds the day it belongs to.
      const second = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(second);
      await tickTimes(second, 4);
      await untilDigest(m.digest, (r) => r.status === 'confirmed', 'confirmed');

      const row = m.dayBook()![0];
      assert.equal(row.txHash, DIGEST_TX, 'the row names the transaction that carries it');
      assert.equal(row.hash, sent.payload.hash, 'stamping a row cannot change what it commits');
      assert.equal(await digestHash(row), row.hash, 'the new field sits outside the hash, like `ts` does');
      assert.equal(censusProblem(row), null, 'a stamped row is still a sound row');

      const served = await readCensus(second);
      assert.equal(served.rows[0].txHash, DIGEST_TX, 'the route publishes it, not just the store');
      const h = await readHealth(second);
      assert.equal(h.signals?.counts.digest_anchor_unstamped, undefined, 'a stamp that landed is not an event');
    });
  } finally {
    rpc.close();
  }
});

test('a reverted transaction is not offered as a day\'s evidence', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth(1);
  try {
    await withDigestKey(async () => {
      const first = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(first);
      await tickTimes(first, 4);
      const sent = await untilDigest(m.digest, (r) => r.status === 'pending', 'pending');
      m.seedDigest({ ...sent, lastAttemptAt: 0 });
      rpc.setReceipt({ status: '0x0', blockNumber: '0x101', transactionHash: sent.txHash });

      const second = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(second);
      await tickTimes(second, 4);
      const reverted = await untilDigest(m.digest, (r) => r.status === 'failed', 'a failed revert');

      // The two artifacts diverge on purpose, and this is the assertion that
      // keeps them apart: the record keeps the hash because it is evidence that
      // an attempt happened and a retry may follow it, while the row publishes a
      // population and must not point a reader at a transaction the chain says
      // did nothing.
      assert.equal(reverted.txHash, DIGEST_TX, 'the attempt is still on the record');
      assert.equal(m.dayBook()![0].txHash, undefined, 'and is not on the day');
      const h = await readHealth(second);
      assert.equal(h.signals?.counts.digest_anchor_unstamped, undefined, 'nothing was asked to be stamped, so nothing failed');
    });
  } finally {
    rpc.close();
  }
});

test('an anchored day the book cannot match is counted rather than guessed at', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth(1);
  try {
    await withDigestKey(async () => {
      // A record for a day whose row is gone. That is not a contrivance: the row
      // can fall out of the front of the book at the cap, or be refused on load
      // by `censusProblem`, while the record beside it hydrates fine — the two
      // are checked by separate rules and only meet again here.
      const queued = newDigestRecord(0, await buildPayload({ ...STATS, day: 0, tick: 4 }, 1));
      m.seedDigest(markPending(markSubmitted(queued, 1), DIGEST_TX, 0));
      rpc.setReceipt({ status: '0x1', blockNumber: '0x101', transactionHash: DIGEST_TX });
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(app);
      // Four ticks rather than one: the pump runs on a day boundary, and the
      // seeded record is unsettled, so it survives the boundary and is polled
      // there rather than being replaced by a fresh day.
      await tickTimes(app, 4);
      const done = await untilDigest(m.digest, (r) => r.status === 'confirmed', 'confirmed');

      assert.equal(done.txHash, DIGEST_TX, 'the transaction really is confirmed');
      assert.equal(m.dayBook()?.length ?? 0, 0, 'and there is genuinely no row to point at');
      const served = await readCensus(app);
      assert.equal(served.rows.length, 0, 'which the viewer sees as an empty book, not as a false link');
      const h = await readHealth(app);
      assert.equal(h.signals?.counts.digest_anchor_unstamped, 1, 'and only the counter says the promise broke');
      assert.match(h.signals?.last.digest_anchor_unstamped?.detail ?? '', /not in the book/);
    });
  } finally {
    rpc.close();
  }
});

test('a stamp joins one row to one transaction and refuses every other pair', () => {
  const row = (day: number, hash: string, txHash?: string): CensusDay => ({
    ...STATS, day, tick: day * 4, byArchetype: { APE: STATS.population },
    hash, ts: 1_700_000_000_000 + day,
    ...(txHash ? { txHash } : {}),
  });
  const book = [row(0, 'a'.repeat(64)), row(1, 'b'.repeat(64))];
  const TX = `0x${'cc'.repeat(32)}`;

  const ok = stampAnchor(book, 1, TX, 'b'.repeat(64));
  assert.equal(ok.stamped, true);
  assert.equal(ok.problem, null);
  assert.equal(ok.rows[1].txHash, TX, 'the named day gets the pointer');
  assert.equal(ok.rows[0].txHash, undefined, 'and its neighbours keep whatever they had');
  assert.equal(book[1].txHash, undefined, 'the caller\'s book is not mutated under it');

  // Each refusal below is a pair that could only have arrived by a bug or an
  // edited ledger, and the consequence of guessing is a public link that will be
  // believed, so none of them may write.
  assert.equal(stampAnchor(book, 9, TX, 'b'.repeat(64)).stamped, false, 'a day that is not in the book');
  assert.equal(stampAnchor(book, 1, TX, 'a'.repeat(64)).stamped, false, 'a transaction that committed other numbers');
  assert.equal(stampAnchor(book, 1, 'a'.repeat(64), 'b'.repeat(64)).stamped, false, 'a digest is not a transaction hash');
  const pointed = stampAnchor(ok.rows, 1, `0x${'dd'.repeat(32)}`, 'b'.repeat(64));
  assert.equal(pointed.rows[1].txHash, TX, 'one confirmed day keeps the transaction it was confirmed with');
  assert.equal(pointed.stamped, false, 'and the second one is said out loud rather than dropped');

  // The decision on the read path, written down because the alternative is a
  // plausible-looking "improvement": a row whose *pointer* is unsound keeps its
  // numbers. Dropping it would trade a day of real census for a broken link, and
  // `census_row_rejected` exists for rows that lie about what was alive, and the
  // line after these three still refuses one that does.
  const rotten = row(2, 'c'.repeat(64));
  assert.equal(censusProblem({ ...rotten, txHash: 'not a hash at all' }), null);
  assert.equal(censusProblem(rotten), null, 'and an unstamped day is not a problem either');
  assert.match(censusProblem({ ...rotten, byArchetype: { APE: 1 } }) ?? '', /is not the population/);
});

test('days are still written down when nothing goes on chain', async () => {
  assert.equal(process.env.ARC_DIGEST_KEY, undefined, 'no key in this one, on purpose');
  const m = memStore();
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  shortenDay(app);
  await tickTimes(app, 4);
  // Let day 0's pump finish before closing day 1. While a pump is in flight the
  // guard at the top of `pumpDigest` returns immediately, and a test that ticks
  // straight through two boundaries in one event-loop turn therefore never gives
  // the second day a pump at all — on a live tank the next tick retries in 250ms,
  // here nothing would ever ask again.
  await pumpQuiet();
  await tickTimes(app, 4);
  // Wait on the *second* day's record, not on any record: the first one is
  // already `unconfigured` the moment it lands, so asking for that status is
  // satisfied a whole day early and the assertion below races the pump.
  await untilDigest(m.digest, (r) => r.day === 1 && r.status === 'unconfigured', 'day 1 unconfigured');
  const body = await readCensus(app);
  assert.deepEqual(body.rows.map((r) => r.day), [0, 1], 'oldest first, and the off-chain days are in it');
  assert.equal(
    new Set(body.rows.map((r) => r.day)).size,
    body.rows.length,
    'one row per day — a book with two claims for a date is a book of deltas that are not days',
  );
});

test('a day that is anchored twice replaces its row rather than stacking a second claim', async () => {
  const m = memStore();
  const health = createHealth(1);
  // The reachable collision: a record that hydrate refuses (here `pending` with
  // no transaction, the D1 lie) leaves the pump with nothing outstanding, so it
  // re-records the closed day — while the book still holds the row written
  // alongside the rejected record. Appending would hand `censusChanges` two
  // readings of one tick and let it publish the difference as a day of births.
  m.seedDigest({
    ...newDigestRecord(0, await buildPayload({ ...STATS, day: 0 }, 1)),
    status: 'pending',
    txHash: null,
    attempts: 1,
    lastAttemptAt: 1,
  });
  m.seedDayBook([censusFixture(0)]);
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  shortenDay(app);
  await tickTimes(app, 4);
  await untilDigest(m.digest, (r) => r.status === 'unconfigured', 'unconfigured');
  const body = await readCensus(app);
  assert.equal(body.rows.length, 1, 'one day, one row');
  assert.notEqual(body.rows[0].hash, censusFixture(0).hash, 'and it is the fresh reading, not the stale one');
  assert.deepEqual(body.changes, [], 'nothing is derived against a day that is no longer in the book');
});

test('a stored row whose headcount contradicts its population is dropped and counted', async () => {
  const m = memStore();
  const health = createHealth(1);
  m.seedDayBook([censusFixture(0), { ...censusFixture(1), byArchetype: { APE: 99 } }]);
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  const { value, errors } = await quiet(() => readHealth(app));
  assert.equal(value.signals?.counts.census_row_rejected, 1);
  assert.match(value.problem ?? '', /census_row_rejected=1/);
  assert.equal(value.healthy, false, 'a book that is being rewritten from zero is not a healthy one');
  assert.match(errors.join('\n'), /archetype headcount 99 is not the population 5/);
  // The same sentence has to reach `/health`, not only the console: the console is
  // the channel proven never to arrive at the edge, which is the whole reason the
  // counters exist. A count without its reason says the book is broken and not how.
  assert.match(value.signals?.last?.census_row_rejected?.detail ?? '', /headcount 99 is not the population 5/,
    'the detail names the contradiction, not just the fact that there was one');
  const body = await readCensus(app);
  assert.deepEqual(body.rows.map((r) => r.day), [0], 'the lie is not served as history');
  assert.deepEqual(body.coverage, { first: 0, last: 0, days: 1 }, 'and the route says which day it starts from');
});

test('a ledger over the cap is trimmed on the way in, keeping the newest days', async () => {
  const m = memStore();
  m.seedDayBook(Array.from({ length: CENSUS_CAP + 2 }, (_, i) => censusFixture(i)));
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  const body = await readCensus(app);
  assert.equal(body.book, CENSUS_CAP);
  assert.equal(body.rows[0].day, 2, 'the two oldest days are what it forgot');
  assert.equal(body.coverage?.last, CENSUS_CAP + 1);
  assert.equal((await readCensus(app, '?days=9999')).rows.length, CENSUS_CAP, 'asking for more than exists is not an error');
});

test('a book at the cap forgets the oldest day instead of growing, and says so', async () => {
  const m = memStore();
  const health = createHealth(1);
  m.seedDayBook(Array.from({ length: CENSUS_CAP }, (_, i) => censusFixture(i + 1)));
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  shortenDay(app);
  await tickTimes(app, 4);
  await untilDigest(m.digest, (r) => r.status === 'unconfigured', 'unconfigured');
  const body = await readCensus(app);
  assert.equal(body.book, CENSUS_CAP, 'the cap holds on the write side too');
  assert.equal(body.rows[0].day, 2, 'day 1 is the one it dropped');
  const h = await readHealth(app);
  assert.equal(h.signals?.counts.census_days_dropped, 1, 'forgetting is a signal, not a shrug');
});

test('extinctions and emergences are derived from the book, never stored in it', () => {
  const rows = [
    censusFixture(0, { APE: 2, INSIDER: 1 }),
    censusFixture(1, { APE: 2 }),
    censusFixture(2, { APE: 2, ALGO: 1 }),
  ];
  const changes = censusChanges(rows);
  assert.equal(changes.length, 2, 'the first day makes no claim, because its predecessor is not in the book');
  assert.deepEqual(changes[0].lost, ['INSIDER'], 'counted out of existence between two readings');
  assert.deepEqual(changes[0].gained, []);
  assert.equal(changes[0].populationDelta, -1);
  assert.equal(changes[0].born, 10, 'cumulative counters are differenced, not trusted');
  assert.equal(changes[0].died, 5);
  assert.equal(changes[0].predations, 3);
  assert.deepEqual(changes[1].gained, ['ALGO']);
  assert.deepEqual(changes[1].lost, []);

  const reseeded = censusChanges([rows[0], { ...censusFixture(1, { APE: 2 }), born: 1 }]);
  assert.equal(reseeded[0].born, null, 'a counter that ran backwards is a different tank, not a day with no births');
  assert.equal(reseeded[0].populationDelta, -1, 'and the fields that can still be compared are compared');
  assert.equal(censusReset(rows[0], rows[1]), false);
  assert.equal(censusReset(rows[0], { ...censusFixture(1, { APE: 2 }), born: 1 }), true);
  assert.deepEqual(censusChanges([rows[0]]), [], 'one row is a fact; a change needs two');
});

test('?days trims what is sent, never what the derivation is allowed to see', async () => {
  const m = memStore();
  m.seedDayBook([
    censusFixture(0, { APE: 2, INSIDER: 1 }),
    censusFixture(1, { APE: 2, INSIDER: 1 }),
    censusFixture(2, { APE: 2 }),
  ]);
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  const all = await readCensus(app);
  assert.equal(all.changes.length, 2, 'two differences over three days');
  assert.equal(sumHeads(all.today), all.today.population, 'and today is counted by the same rule as the rows behind it');
  const lastOne = await readCensus(app, '?days=1');
  assert.deepEqual(lastOne.rows.map((r) => r.day), [2]);
  assert.deepEqual(
    lastOne.changes.map((c) => c.day),
    [2],
    'the newest day still gets its change, computed against a row the window did not send',
  );
  assert.deepEqual(lastOne.changes[0].lost, ['INSIDER'], 'a window must not be able to hide an extinction');
  assert.equal(lastOne.book, 3, 'and it still says how deep the book really goes');
});

test('the route publishes what the hash covers, and today is marked uncommitted', async () => {
  const app = createApp({ seed: 7, ...offlineFeeds });
  const body = await readCensus(app);
  assert.equal(body.coverage, null, 'an empty book is admitted; a chart of nothing is not the same as no chart');
  assert.deepEqual(body.rows, []);
  assert.deepEqual(body.changes, []);
  assert.deepEqual(body.hashed, [...DIGEST_HASH_FIELDS], 'which fields travelled to the chain — the headcounts did not');
  assert.equal(body.today.committed, false, 'the live reading is not a promise');
  assert.equal(sumHeads(body.today), body.today.population, 'same headcount rule as every row behind it');
  const api = (await (await app.fetch(new Request('http://localhost/api'))).json()) as {
    endpoints: Record<string, string>;
  };
  assert.ok('GET /history/census' in api.endpoints, 'a route nobody can discover is a route nobody uses');
});

test('a day book row is as small as its comment claims', async () => {
  // The comment on `CENSUS_CAP` states byte counts and does the arithmetic for
  // the whole cap from them, which makes it a claim about the code. Measured here
  // on a real row from a real day — four archetypes present, so this is a full
  // row and not the thinnest one the tank can produce — in both shapes a row can
  // have, because the cap has to hold the wider one: a day that anchors grows a
  // transaction hash long after it was written.
  const m = memStore();
  const app = createApp({ seed: 1, store: m.store, ...offlineFeeds });
  shortenDay(app);
  await tickTimes(app, 4);
  await untilDigest(m.digest, (r) => r.status === 'unconfigured', 'unconfigured');
  const row = (await readCensus(app)).rows[0];
  assert.equal(Object.keys(row.byArchetype).length, 4, 'all four archetypes alive, so nothing is missing from the measurement');
  const bytes = JSON.stringify(row).length;
  const stamped = JSON.stringify(stampAnchor([row], row.day, DIGEST_TX, row.hash).rows[0]).length;
  assert.equal(
    stamped, CENSUS_ROW_BYTES,
    `a stamped row measures ${stamped} bytes and CENSUS_ROW_BYTES says ${CENSUS_ROW_BYTES}; the cap is derived from that number, so it is not a comment to leave behind`,
  );
  // The other half of the same measurement, stated separately so a row that grew
  // somewhere else cannot hide inside a matching total: 78 bytes is the JSON
  // encoding of one `"txHash"` and one 66-character hash, and nothing more.
  assert.equal(stamped - bytes, 78, `a stamp added ${stamped - bytes} bytes to a ${bytes}-byte row`);
  assert.ok(
    CENSUS_CAP * stamped < CENSUS_BUDGET_BYTES,
    `the cap must stay inside its storage budget: ${CENSUS_CAP * stamped} B of ${CENSUS_BUDGET_BYTES}`,
  );
});

/* ---------- how a signing key reaches the code that has to sign with it ---------- */

/**
 * The handler read its key out of `process.env` and nothing else, which is a
 * reasonable thing to write and an unreasonable thing to leave unwitnessed:
 * `wrangler secret put ARC_DIGEST_KEY` deposits a binding on the Durable Object,
 * and whether that binding also appears as a node-style environment variable is
 * a property of a runtime flag this Worker never asked for. Measured against the
 * local runtime, a worker without `nodejs_compat` throws `ReferenceError:
 * process is not defined` the first time it touches `process.env` at all — so
 * the two runtimes differ, and the failure mode of guessing wrong is the worst
 * one available: not an error, but a digest that reports `unconfigured` every
 * day, forever, while a key sits configured in a dashboard.
 *
 * These tests are the difference between "the plumbing exists" and "the
 * plumbing was checked from both ends".
 */
const BINDING_KEY = `0x${'ab'.repeat(32)}`;
const AMBIENT_KEY = `0x${'cd'.repeat(32)}`;

/** Run with no digest key in the environment, whatever the suite had before. */
async function withoutDigestEnv<T>(fn: () => Promise<T>): Promise<T> {
  const had = process.env.ARC_DIGEST_KEY;
  delete process.env.ARC_DIGEST_KEY;
  try {
    return await fn();
  } finally {
    if (had === undefined) delete process.env.ARC_DIGEST_KEY;
    else process.env.ARC_DIGEST_KEY = had;
  }
}

test('an environment that is not there reads as unset instead of throwing', () => {
  // The whole point of the seam: `undefined` is an answer, a crash is not. The
  // no-process case is injected as `null` rather than `undefined` because a
  // default parameter fires on `undefined` — passing nothing is the way to ask
  // for the real `process`, so it cannot also be the way to say there is none.
  assert.equal(readEnv('PATH'), process.env.PATH, 'the real process is the default source');
  assert.equal(readEnv('PATH', null), undefined, 'no process at all is no value, not a crash');
  assert.equal(readEnv('PATH', {}), undefined, 'a process with no env answers the same way');
  assert.equal(
    readEnv('ARC_DIGEST_KEY', { env: { ARC_DIGEST_KEY: 'from-injected' } }),
    'from-injected',
    'and an injected source is read',
  );
});

test('the anchor key can arrive as a binding, and /health names the account it came from', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withoutDigestEnv(async () => {
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, digestKey: BINDING_KEY, ...offlineFeeds });
      shortenDay(app);
      await quiet(() => tickTimes(app, 4));
      const rec = await untilDigest(
        m.digest,
        (r) => r.txHash !== null,
        'a broadcast that came back with a hash',
      );
      assert.equal(rec.status, 'pending');
      assert.equal(rpc.sends.length, 1, 'a key in the binding alone was enough to reach the wire');
      const body = await readHealth(app);
      assert.equal(
        body.digest?.signer,
        privateKeyToAccount(BINDING_KEY as `0x${string}`).address,
        'the address is derived from the key rather than configured next to it',
      );
      assert.equal(body.problem, null, 'and a tank that anchored normally counts nothing as a failure');
    });
  } finally {
    rpc.close();
  }
});

test('the binding wins over an ambient variable, so a stale global cannot sign', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const had = process.env.ARC_DIGEST_KEY;
  process.env.ARC_DIGEST_KEY = AMBIENT_KEY;
  try {
    const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, digestKey: BINDING_KEY, ...offlineFeeds });
    shortenDay(app);
    await quiet(() => tickTimes(app, 4));
    await untilDigest(m.digest, (r) => r.txHash !== null, 'a broadcast');
    const signer = (await readHealth(app)).digest?.signer;
    assert.equal(signer, privateKeyToAccount(BINDING_KEY as `0x${string}`).address, 'the binding is what signed');
    assert.notEqual(
      signer,
      privateKeyToAccount(AMBIENT_KEY as `0x${string}`).address,
      'and not a key left behind in the environment by some other deployment',
    );
  } finally {
    if (had === undefined) delete process.env.ARC_DIGEST_KEY;
    else process.env.ARC_DIGEST_KEY = had;
    rpc.close();
  }
});

test('a key that is not a key is reported as no key, and never reaches the wire', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  try {
    await withoutDigestEnv(async () => {
      // 62 hex digits: the shape a secret gets when a dashboard truncates it, or
      // when somebody pastes the wrong thing. viem would take this and throw
      // somewhere inside a cron; the record already had a status for it.
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, digestKey: `0x${'ab'.repeat(31)}`, ...offlineFeeds });
      shortenDay(app);
      const { errors } = await quiet(() => tickTimes(app, 4));
      const rec = await untilDigest(m.digest, (r) => r.status === 'unconfigured', 'unconfigured');
      assert.equal(rec.txHash, null, 'no transaction, because no usable key');
      assert.deepEqual(rpc.sends, [], 'the endpoint was never asked to accept one');
      assert.equal((await readHealth(app)).digest?.signer, null, 'and the answer says so rather than guessing');
      assert.deepEqual(errors, [], 'reported as a state, not as a stack trace');
    });
  } finally {
    rpc.close();
  }
});

test('the durable object forwards the signing key it was handed', async () => {
  // `handler.ts` preferring its binding is only half of it: the line that
  // decides whether `wrangler secret put` reaches anything at all is the one in
  // `worker.ts` that hands `env` to `createApp`. Delete that argument and every
  // test above still passes, because they all build the app themselves — this is
  // the one that goes through the object the deployment actually constructs.
  //
  // A day record is seeded rather than lived: crossing a day boundary would mean
  // shortening the tank's day, and the app is private inside the object. Which
  // day got anchored is beside the point; that the key travelled from the
  // binding into the code that signs is the entire claim.
  const stored = new Map<string, unknown>();
  stored.set('ledger', { digest: newDigestRecord(3, await buildPayload({ ...STATS, day: 3 }, 1)) });
  const { obj } = worldDO(stored, { ARC_DIGEST_KEY: BINDING_KEY });
  const value = await withoutDigestEnv(() => readHealth(obj));
  assert.equal(value.digest?.status, 'queued', 'the stored record came back, so there is one to sign');
  assert.equal(
    value.digest?.signer,
    privateKeyToAccount(BINDING_KEY as `0x${string}`).address,
    'the object passed the binding down to the code that signs',
  );
});

/* ---------- the paid data tier: GET /data/flows ---------- */

const SELLER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const BUYER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const STRANGER_KEY = '0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82';

test('a price is exact base units, and a fraction finer than a cent is a mistake', () => {
  // USDC has six decimals, so six decimals is all a price is ever allowed to
  // carry. What this replaced was `BigInt(Math.round(Number(price) * 1e6))`, run
  // side by side with the version above and measured rather than remembered:
  const floats = (p: string): bigint => BigInt(Math.round(Number(p) * 1e6));
  assert.equal(usdcUnits('0.001'), 1000n, 'the price this route actually charges');
  assert.equal(usdcUnits('1'), 1000000n);
  assert.equal(usdcUnits('0.000001'), 1n, 'one base unit is the smallest thing that can be sold');
  assert.equal(usdcUnits('9007199254740.991'), 9007199254740991000n);
  assert.equal(usdcUnits('10000000000000.001'), 10000000000000001000n);

  // Measured difference #1: a price under half a base unit became `0`, which is
  // an endpoint that advertises a payment and then charges nothing — the quote
  // and the accepted amount disagree with reality, and the free tier is back.
  assert.equal(floats('0.0000004'), 0n, 'what the old arithmetic made of it');
  assert.throws(() => usdcUnits('0.0000004'), TypeError, 'and here it says so instead');
  // Measured difference #2: past 2^53 base units a double stops carrying the
  // fraction at all. The old path was off by 1048 and by 1048 again in the other
  // direction, which is a buyer paying the wrong amount for a signed message.
  assert.equal(floats('9007199254740.991'), 9007199254740989952n, 'measured, not recalled');
  assert.equal(floats('10000000000000.001'), 10000000000000002048n);

  for (const bad of ['0.0000001', '1,000', '', '   ', '1.', '-1', '0x10', '1e-6', 'abc']) {
    assert.throws(() => usdcUnits(bad), TypeError, `${JSON.stringify(bad)} is not a price`);
  }
});

test('the seller identity is built from a key that is a key, and from nothing else', () => {
  const seller = privateKeyToAccount(SELLER_KEY as `0x${string}`);
  for (const missing of [undefined, null, '', '0x', `0x${'ab'.repeat(31)}`, 'nope', SELLER_KEY.slice(2)]) {
    assert.equal(buildFacilitatorConfig({ sellerKey: missing }), null, `${JSON.stringify(missing)} is not a key`);
  }
  // The shape check exists because viem throws on a truncated key, and a throw
  // here is a 500 on a page where a paying customer just agreed to sign.
  assert.equal(buildFacilitatorConfig({}), null, 'no key at all means nothing is for sale');

  const main = buildFacilitatorConfig({ sellerKey: SELLER_KEY });
  assert.ok(main);
  assert.equal(main.chainId, 5042, 'Arc mainnet unless something says otherwise');
  assert.equal(main.network, 'eip155:5042');
  assert.equal(main.payTo, seller.address.toLowerCase(), 'the seller gets their own money, in one casing');
  assert.equal(main.baseUrl, 'https://api.circle.com/v1/facilitator/x402');
  assert.equal(main.usdc, ARC_USDC);

  assert.equal(buildFacilitatorConfig({ sellerKey: SELLER_KEY, testnet: '1' })?.chainId, 5042002);
  // Anything but `1` is mainnet, including the near-misses a dashboard typo
  // produces: `true` read as a testnet setting must not quietly move real money
  // onto a trial network.
  for (const notTestnet of ['0', 'true', 'yes', '', undefined]) {
    assert.equal(buildFacilitatorConfig({ sellerKey: SELLER_KEY, testnet: notTestnet })?.chainId, 5042);
  }
  const moved = buildFacilitatorConfig({ sellerKey: SELLER_KEY, payTo: `0x${'cd'.repeat(20)}` });
  assert.equal(moved?.payTo, `0x${'cd'.repeat(20)}`, 'an explicit destination wins over the derived one');
  assert.equal(buildFacilitatorConfig({ sellerKey: SELLER_KEY, baseUrl: 'http://127.0.0.1:9' })?.baseUrl, 'http://127.0.0.1:9');

  // And the offer the buyer signs against is that identity, in base units.
  const requirement = exactRequirement(main, DATA_PRICE_USDC);
  assert.equal(requirement.amount, '1000');
  assert.equal(requirement.payTo, seller.address.toLowerCase());
  assert.equal(requirement.network, 'eip155:5042');
  assert.equal(requirement.asset, ARC_USDC);
  assert.equal(requirement.scheme, 'exact');
});

/**
 * The pricing document, when the checkout has one. `TOKEN_PLAN.md` is
 * deliberately gitignored — it carries commitments that are not published yet —
 * so a CI checkout does not contain it and a lock that depends on reading it
 * would fail there for the wrong reason. The lock is therefore a working-copy
 * guarantee: asserted when the document is present, announced as skipped when
 * it is not, so a green run never implies the two agreed.
 */
function readTokenPlan(): string | null {
  // The search walks upward rather than hard-coding a relative path, because
  // the same test runs from `src/` and from `dist/`, which are one level apart.
  // It stops at the repository root and nowhere else: measured, a copy of the
  // tree extracted into a subdirectory of a working copy climbed out of itself
  // and found the outer copy's plan, so the lock was silently validating a
  // file that did not belong to the checkout under test. `wrangler.toml` is the
  // root marker because it is committed, and a checkout without it is not this
  // repository.
  let dir = new URL('..', import.meta.url);
  for (let up = 0; up < 8; up += 1) {
    const plan = new URL('TOKEN_PLAN.md', dir);
    if (existsSync(plan)) return readFileSync(plan, 'utf8');
    if (existsSync(new URL('wrangler.toml', dir))) return null;
    dir = new URL('..', dir);
  }
  return null;
}

const TOKEN_PLAN = readTokenPlan();

test('the price in the code is the price written in the plan', {
  skip: TOKEN_PLAN === null ? 'TOKEN_PLAN.md is gitignored, so this lock only exists in a working copy' : false,
}, async () => {
  // TOKEN_PLAN.md §7 is where the number is promised to whoever reads the plan;
  // `DATA_PRICE_USDC` is where it is charged. Two places for one number is how
  // they drift apart, so the document is read back here on purpose.
  const plan = TOKEN_PLAN ?? '';
  const line = plan.split('\n').find((l) => l.includes('历史 API'));
  assert.ok(line, 'the plan still names the historical API price');
  const stated = /\$\s*([0-9.]+)/.exec(line ?? '');
  assert.ok(stated, `the price is a $ figure in: ${line}`);
  assert.equal(stated[1], DATA_PRICE_USDC, 'what the plan promises is what the route charges');
  assert.equal(usdcUnits(DATA_PRICE_USDC), 1000n, 'and it survives the conversion to base units');
});

/** One answer from the stub facilitator: a status, a JSON body, or neither. */
interface StubReply { status?: number; json?: unknown; text?: string }

interface StubFacilitator {
  url: string;
  /** What was POSTed, in arrival order — the whole body, not a summary of it. */
  bodies: any[];
  hits(): number;
  close(): Promise<void>;
}

/** Circle, replaced by a local server that says exactly what a test needs said. */
async function serveFacilitator(replies: StubReply[]): Promise<StubFacilitator> {
  const bodies: any[] = [];
  let hits = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      const reply = replies[Math.min(hits, replies.length - 1)];
      hits += 1;
      try {
        bodies.push(raw ? JSON.parse(raw) : null);
      } catch {
        bodies.push(raw);
      }
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status ?? 200;
      res.end(reply.text ?? JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * An `X-Payment` header carrying one EIP-3009 authorization for the price on
 * offer, signed for real by `key` — the same `signTypedData` path a wallet runs.
 * Nothing here is mocked except Circle itself, so a route test that settles has
 * actually settled a signature the pre-checks had to accept.
 */
async function payHeader(
  cfg: FacilitatorConfig,
  requirement: ReturnType<typeof exactRequirement>,
  key: ReturnType<typeof privateKeyToAccount>,
  nonce: string,
  over: Record<string, string> = {},
): Promise<string> {
  const authorization = {
    from: key.address,
    to: cfg.payTo,
    value: requirement.amount,
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce,
    ...over,
  };
  const signature = await key.signTypedData({
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
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: 'http://localhost/data/flows', description: 'flow ring', mimeType: 'application/json' },
    accepted: requirement,
    payload: { signature, authorization },
  })).toString('base64url');
}

const ALPHA = '0x' + 'a1'.repeat(20);
const BETA = '0x' + 'b2'.repeat(20);
const GAMMA = '0x' + 'c3'.repeat(20);
const T0 = 1_700_000_000_000;

/** Four transfers, arranged so each filter has something only it can match. */
const RING = [
  { t: T0 + 1, block: 101, tx: '0x' + 'e1'.repeat(32), from: ALPHA, to: BETA, amount: 0.001, venue: 'x402', venueAddr: ARC_USDC, x402: true },
  { t: T0 + 2, block: 102, tx: '0x' + 'e2'.repeat(32), from: BETA, to: GAMMA, amount: 1234.567891, venue: 'swap', venueAddr: '0x' + 'd4'.repeat(20), x402: false },
  { t: T0 + 3, block: 103, tx: '0x' + 'e3'.repeat(32), from: GAMMA, to: ALPHA, amount: 5, venue: null, venueAddr: null, x402: null },
  { t: T0 + 4, block: 104, tx: '0x' + 'e4'.repeat(32), from: BETA, to: ALPHA, amount: 7, venue: 'unknown', venueAddr: '0x' + 'f5'.repeat(20), x402: null },
];

/** An app whose feed is Arc (so there is a ring to sell) over a stub facilitator. */
async function dataTierApp(env: {
  sellerKey?: string | null;
  replies?: StubReply[];
  /** `false` runs the synthetic feed: a seller with nothing recorded. */
  arc?: boolean;
  health?: ReturnType<typeof createHealth>;
}): Promise<{
  app: ReturnType<typeof createApp>;
  stub: StubFacilitator;
  close: () => Promise<void>;
  /** The ledger the app writes through, so a second isolate can be started over it. */
  m: ReturnType<typeof memStore>;
}> {
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const stub = await serveFacilitator(env.replies ?? [{ json: { success: true, transaction: '0x' + 'fe'.repeat(32), payer: ALPHA } }]);
  const arc = env.arc !== false;
  const feed = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  (feed as unknown as { flows: unknown[] }).flows = arc ? RING.map((r) => ({ ...r })) : [];
  const m = memStore();
  const app = createApp({
    seed: 1,
    store: m.store,
    chainFeed: arc ? feed : offlineFeeds.chainFeed,
    marketFeed: arc ? undefined : offlineFeeds.marketFeed,
    sellerKey: env.sellerKey === null ? undefined : env.sellerKey ?? SELLER_KEY,
    facilitatorUrl: stub.url,
    health: env.health,
  });
  return { app, m, stub, close: () => stub.close() };
}

const get = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`http://localhost${path}`, { headers });

test('the data tier is closed until a seller key arrives, and names the knob', async () => {
  const app = createApp({ seed: 1, ...offlineFeeds });
  const res = await app.fetch(get('/data/flows'));
  assert.equal(res.status, 503, 'not for sale, and not pretending to be');
  const body = (await res.json()) as { available: boolean; error: string; hint: string; price: { usdc: string; network: string } };
  assert.equal(body.available, false);
  assert.match(body.hint, /SELLER_PRIVATE_KEY/, 'a 503 that says which secret is missing is a fixable 503');
  assert.equal(body.price.usdc, DATA_PRICE_USDC);
  assert.equal(body.price.network, 'eip155:5042', 'the network the price would be charged on');

  const health = await readHealth(app);
  assert.equal(health.data.forSale, false);
  assert.equal(health.data.payTo, null, 'nothing derived, because nothing was derived from');
  assert.equal(health.data.arcFeed, false, 'a synthetic feed has no Arc history either');
  assert.equal(health.data.sales, 0);
  assert.equal(health.data.spentPayments, 0);
});

test('a key with nothing recorded still refuses to charge', async () => {
  // The state worth covering is the half-configured one: secret installed, chain
  // feed off. Selling an empty list for real money is worse than saying so.
  const { app, stub, close } = await dataTierApp({ arc: false, replies: [{ text: 'must never be reached', status: 599 }] });
  try {
    const res = await app.fetch(get('/data/flows'));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /no Arc flow history/);
    assert.equal(stub.hits(), 0, 'no payment was quoted, so none could be taken');

    const health = await readHealth(app);
    assert.equal(health.data.forSale, true, 'the key is there');
    assert.equal(health.data.arcFeed, false, 'and the endpoint says the other half is not');
  } finally {
    await close();
  }
});

test('a filter nobody can honour is refused before anything is quoted', async () => {
  const { app, stub, close } = await dataTierApp({});
  try {
    for (const [path, needle] of [
      ['/data/flows?addr=nothex', /addr/],
      ['/data/flows?addr=' + ALPHA + '1', /addr/],
      ['/data/flows?venue=exchange', /venue/],
      ['/data/flows?blockFrom=-5', /blockFrom/],
      ['/data/flows?blockFrom=9&blockTo=1', /blockFrom is after blockTo/],
      ['/data/flows?from=99999&to=111', /from is after to/],
      ['/data/flows?limit=many', /limit/],
    ] as const) {
      const res = await app.fetch(get(path));
      assert.equal(res.status, 400, `${path} should be a bad request, not a bill`);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, needle, `the refusal names the parameter: ${body.error}`);
    }
    assert.equal(stub.hits(), 0, 'and Circle never hears about a request that was never going to be answered');
  } finally {
    await close();
  }
});

test('the 402 quotes one base-unit-exact price against the seller identity', async () => {
  const { app, stub, close } = await dataTierApp({});
  try {
    const res = await app.fetch(get('/data/flows?addr=' + ALPHA));
    assert.equal(res.status, 402);
    const body = (await res.json()) as { x402Version: number; error: string; accepts: ReturnType<typeof exactRequirement>[] };
    assert.equal(body.x402Version, 2);
    assert.match(body.error, /missing X-Payment/, 'the reason is the missing header, not a mystery');
    assert.equal(body.accepts.length, 1);
    const req = body.accepts[0];
    assert.equal(req.scheme, 'exact');
    assert.equal(req.network, 'eip155:5042');
    assert.equal(req.amount, '1000', '0.001 USDC, in the units the token actually has');
    assert.equal(req.payTo, privateKeyToAccount(SELLER_KEY as `0x${string}`).address.toLowerCase());
    assert.equal(req.asset, ARC_USDC);
    assert.equal(req.extra.assetTransferMethod, 'eip3009');
    assert.equal(stub.hits(), 0);
  } finally {
    await close();
  }
});

test('flowQueryFromUrl defaults the depth it documents and refuses the rest', async () => {
  const { flowQueryFromUrl } = await import('../src/handler.js');
  type Parsed = { query?: Record<string, unknown>; error?: string };
  const parse = (q: string): Parsed =>
    flowQueryFromUrl(new URL(`http://localhost/data/flows${q}`)) as Parsed;
  const error = (q: string): string => String(parse(q).error ?? '');

  assert.equal(parse('').query?.limit, 500, 'the documented default');
  assert.equal(parse('?limit=0').query?.limit, 500, 'a zero asks for the default, not for nothing');
  assert.equal(parse('?limit=37').query?.limit, 37, 'a real number is honoured');
  assert.equal(parse('?limit=999999').query?.limit, 2000, 'and the ceiling on one answer is the ceiling');
  assert.equal(parse('?addr=' + ALPHA).query?.addr, ALPHA, 'kept as sent; the query normalizes, not the parser');
  assert.equal(parse('?blockFrom=12').query?.blockFrom, 12);
  assert.equal(parse('?blockTo=').query?.blockTo, null, 'an empty value is an absent value');
  assert.ok(parse('?venue=x402').query, 'no error for a venue the feed reports');
  for (const venue of ['swap', 'aa', 'direct', 'contract', 'unknown']) {
    assert.equal(error(`?venue=${venue}`), '', `${venue} is a venue the feed reports`);
  }
  assert.match(error('?venue=borrowed'), /x402, swap, aa, direct, contract, unknown/);
  assert.match(error('?blockFrom=1&limit=x&venue=y'), /;.*/, 'every problem at once, in one answer');
});

test('the ring answers its filters, and reports the ceiling on its own answer', async () => {
  // `queryFlows` is the half of the paid tier that has no money in it, so it is
  // tested as itself: same feed, same injected ring, no envelope.
  const { ArcUsdcFeed, ARC_USDC_ADDRESS } = await import('../src/arc.js');
  const feed = new ArcUsdcFeed(UNUSED_RPC, ARC_USDC_ADDRESS, { pollEveryMs: 0 });
  const ring = (rows: Record<string, unknown>[]): void => {
    (feed as unknown as { flows: unknown[] }).flows = rows.map((r) => ({ ...r }));
  };
  ring(RING);

  assert.equal(feed.queryFlows().matched, 4, 'no filter is everything retained');
  ring([]);
  const bare = feed.queryFlows();
  assert.equal(bare.retained, 0, 'an empty ring says it is empty');
  assert.equal(bare.matched, 0);
  assert.deepEqual(bare.flows, []);
  assert.deepEqual([bare.oldest, bare.newest], [null, null], 'and invents no span to fill the list');
  assert.equal(bare.query.limit, 500, 'the echoed query carries the default that was applied');
  ring(RING);

  // Either side of a transfer matches, which is the only reading of "what came
  // through this address" that a buyer would accept. Counted off `RING`, which is
  // ALPHA→BETA, BETA→GAMMA, GAMMA→ALPHA, BETA→ALPHA.
  assert.equal(feed.queryFlows({ addr: BETA }).matched, 3, 'one in, two out');
  assert.equal(feed.queryFlows({ addr: ALPHA }).matched, 3, 'one out, two in');
  assert.equal(feed.queryFlows({ addr: GAMMA }).matched, 2, 'one in, one out');
  assert.equal(feed.queryFlows({ addr: '0x' + 'ff'.repeat(20) }).matched, 0, 'an address with nothing to show');

  // `unknown` covers both ways an unattributed transfer can read: never
  // resolved, and resolved to something uncatalogued.
  assert.deepEqual(feed.queryFlows({ venue: 'unknown' }).flows.map((r) => r.tx), [RING[2].tx, RING[3].tx]);
  assert.deepEqual(feed.queryFlows({ venue: 'x402' }).flows.map((r) => r.tx), [RING[0].tx]);

  assert.deepEqual(feed.queryFlows({ blockFrom: 103 }).flows.map((r) => r.block), [103, 104]);
  assert.deepEqual(feed.queryFlows({ blockTo: 102 }).flows.map((r) => r.block), [101, 102]);
  assert.deepEqual(feed.queryFlows({ from: T0 + 2, to: T0 + 3 }).flows.map((r) => r.t), [T0 + 2, T0 + 3]);

  // Over the limit, the recent end is what survives — and the response owns the
  // fact rather than letting a short list imply one.
  const page = feed.queryFlows({ limit: 2 });
  assert.equal(page.matched, 4);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.flows.map((r) => r.t), [T0 + 3, T0 + 4], 'newest last, and only the newest two');
  assert.equal(feed.queryFlows({ limit: 4 }).truncated, false, 'exactly the depth asked for is not truncated');
});

test('a paid call settles first and answers with the depth the free stream withholds', async () => {
  const health = createHealth();
  const { app, m, stub, close } = await dataTierApp({ health });
  try {
    const cfg = buildFacilitatorConfig({ sellerKey: SELLER_KEY });
    assert.ok(cfg);
    const requirement = exactRequirement(cfg, DATA_PRICE_USDC);
    const buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`);
    const header = await payHeader(cfg, requirement, buyer, `0x${'11'.repeat(32)}`);
    const res = await app.fetch(get('/data/flows', { 'x-payment': header }));
    assert.equal(res.status, 200, `a settled payment must be answered, got ${JSON.stringify(await res.clone().json())}`);
    assert.equal(res.headers.get('cache-control'), 'no-store',
      'an answer somebody paid for may not be served to the next reader for free');
    const body = (await res.json()) as {
      retained: number; matched: number; truncated: boolean;
      oldest: { t: number; block: number } | null; newest: { t: number; block: number } | null;
      flows: { amount: number; amountUnits: number; venue: string | null }[];
      settlement: { tx: string; payer: string; network: string; amount: string };
      sold: number;
    };
    assert.equal(stub.hits(), 1, 'Circle was asked once');
    assert.equal(body.settlement.tx, '0x' + 'fe'.repeat(32));
    assert.equal(body.settlement.network, 'eip155:5042');
    assert.equal(body.settlement.amount, '1000');
    assert.equal(body.sold, 1, 'one sale, counted');
    assert.equal(body.retained, 4);
    assert.equal(body.matched, 4);
    assert.equal(body.truncated, false);
    assert.deepEqual([body.oldest, body.newest], [{ t: T0 + 1, block: 101 }, { t: T0 + 4, block: 104 }]);

    // The precision the paid rows carry and the display rows do not. This route
    // sells for 0.001 USDC, and every one of its own sales is a flow in this
    // ring: rounded to cents the way the free stream rounds, a buyer would pay
    // for a ledger in which what they paid for reads as zero.
    assert.equal(body.flows[0].amount, 0.001);
    assert.equal(body.flows[0].amountUnits, 1000);
    assert.equal(body.flows[1].amount, 1234.567891);
    assert.equal(body.flows[1].amountUnits, 1234567891);

    // What left for Circle is the buyer's envelope, whole. Reassembling it from
    // the three fields this module needs would drop `x402Version` and
    // `resource` from a document Circle defined them.
    assert.equal(stub.bodies[0].x402Version, 2);
    assert.equal(stub.bodies[0].paymentPayload.x402Version, 2);
    assert.equal(stub.bodies[0].paymentPayload.resource.url, 'http://localhost/data/flows');
    assert.equal(stub.bodies[0].paymentPayload.accepted.amount, '1000');
    assert.equal(stub.bodies[0].paymentRequirements.payTo, cfg.payTo);

    const after = await readHealth(app);
    assert.equal(after.data.sales, 1);
    assert.equal(after.data.spentPayments, 1, 'the nonce that bought this is remembered as spent');
    assert.deepEqual(after.signals?.counts, {}, 'a sale is not a failure');
    // The same sale as the durable ledger records it. `data.sales` outlives this
    // isolate and `salesThisIsolate` does not, and the two answers are different
    // questions; `quotedUnits` is what Circle confirmed, in base units, because
    // 1000 of them is 0.001 USDC and a float is how a price gets lost.
    assert.equal(after.data.salesThisIsolate, 1);
    assert.equal(after.anchor.revenue.sales, 1);
    assert.equal(after.anchor.revenue.quotedUnits, '1000');
    assert.equal(after.anchor.revenue.unitDecimals, USDC_TOKEN_DECIMALS);
    // And it really is the durable one: a process that never saw the sale reads the
    // same total out of the ledger, while its own counter starts at zero. Without
    // this half the distinction above is a comment about a field nobody checked.
    const cold = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
    const third = await readHealth(cold);
    assert.equal(third.data.sales, 1, 'the sale outlives the isolate that settled it');
    assert.equal(third.data.salesThisIsolate, 0, 'the per-isolate count does not');
    assert.equal(third.anchor.revenue.quotedUnits, '1000');
  } finally {
    await close();
  }
});

test('the refusal a buyer sees before paying is uncacheable too', async () => {
  // The 402 carries the offer: which chain, which asset, what amount, to whom.
  // A cached copy of it would outlive the seller key that produced it, so a
  // buyer could be told to send money to an arrangement that has since closed.
  const { app, close } = await dataTierApp({});
  try {
    const quote = await app.fetch(get('/data/flows'));
    assert.equal(quote.status, 402);
    assert.equal(quote.headers.get('cache-control'), 'no-store');
    const bad = await app.fetch(get('/data/flows?addr=nothex'));
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('cache-control'), 'no-store', 'a refusal is not a caching hint either');
  } finally {
    await close();
  }
});

test('making the paid answer uncacheable did not take the free stream with it', async () => {
  // The two policies differ on purpose: the flow stream is public, stale-by-3-
  // seconds and worth serving from the edge, while a paid answer is not.
  // Asserting only the first half would let a change that puts `no-store` on
  // every response pass as a fix.
  const { app, close } = await dataTierApp({});
  try {
    const observed = await app.fetch(get('/observe'));
    assert.equal(observed.status, 200);
    const policy = observed.headers.get('cache-control') ?? '';
    assert.match(policy, /public, s-maxage=\d+, stale-while-revalidate=\d+/);
    assert.doesNotMatch(policy, /no-store/, '/observe is the route that asked to be cached');
  } finally {
    await close();
  }
});

test('a mixed-case ?addr= finds the transfers it describes', async () => {
  // The burn receipts learned what one-sided normalization costs; this is the
  // same comparison with the casing flipped, on the newest path that has it.
  const { app, close } = await dataTierApp({});
  try {
    const cfg = buildFacilitatorConfig({ sellerKey: SELLER_KEY });
    assert.ok(cfg);
    const requirement = exactRequirement(cfg, DATA_PRICE_USDC);
    const buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`);
    const mixed = '0x' + 'A1'.repeat(20);
    assert.notEqual(mixed, ALPHA, 'the same address, spelled the other way');
    const header = await payHeader(cfg, requirement, buyer, `0x${'12'.repeat(32)}`);
    const res = await app.fetch(get(`/data/flows?addr=${mixed}`, { 'x-payment': header }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { matched: number; query: { addr: string }; flows: { from: string; to: string }[] };
    assert.equal(body.matched, 3, 'the mixed-case spelling matches the lowercased ring');
    assert.equal(body.query.addr, ALPHA, 'and the answer echoes one casing');
    for (const row of body.flows) {
      assert.ok([row.from, row.to].includes(ALPHA), `${row.from}->${row.to} does not involve ${ALPHA}`);
    }
  } finally {
    await close();
  }
});

test('one authorization buys one answer, whatever casing it returns in', async () => {
  const health = createHealth();
  const { app, stub, close } = await dataTierApp({ health });
  try {
    const cfg = buildFacilitatorConfig({ sellerKey: SELLER_KEY });
    assert.ok(cfg);
    const requirement = exactRequirement(cfg, DATA_PRICE_USDC);
    const buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`);
    // A nonce with letters, so that a second spelling of it exists to try.
    const nonce = '0x' + 'aB'.repeat(32);
    const first = await app.fetch(get('/data/flows', { 'x-payment': await payHeader(cfg, requirement, buyer, nonce) }));
    assert.equal(first.status, 200);

    const again = await app.fetch(get('/data/flows', { 'x-payment': await payHeader(cfg, requirement, buyer, nonce) }));
    assert.equal(again.status, 402, 'the ring of spent nonces refuses before Circle is asked again');
    const refused = (await again.json()) as { error: string; flows?: unknown };
    assert.match(refused.error, /already been spent/);
    assert.equal(refused.flows, undefined, 'and no row travels with the refusal');

    // The bytes32 is the same bytes either way, so the signature still verifies
    // and only the spelling changed. That is precisely the difference the
    // receipts bug turned into infinite money, so it is tested here too.
    const respelled = await app.fetch(get('/data/flows', { 'x-payment': await payHeader(cfg, requirement, buyer, '0x' + 'Ab'.repeat(32)) }));
    assert.equal(respelled.status, 402, 'a re-spent nonce is refused in either casing');
    assert.match(((await respelled.json()) as { error: string }).error, /already been spent/);

    assert.equal(stub.hits(), 1, 'the facilitator was told about the sale exactly once');
    const after = await readHealth(app);
    assert.equal(after.data.sales, 1, 'the refusal did not sell anything');
    assert.equal(after.data.spentPayments, 1);
    assert.deepEqual(after.signals?.counts, {}, 'a replay is not counted as a failure: see data_settle_failed');
  } finally {
    await close();
  }
});

test('a facilitator that answers badly is counted, and hands back no rows', async () => {
  const health = createHealth();
  const { app, stub, close } = await dataTierApp({ health, replies: [{ status: 502, text: 'upstream refused the request' }] });
  try {
    const cfg = buildFacilitatorConfig({ sellerKey: SELLER_KEY });
    assert.ok(cfg);
    const header = await payHeader(cfg, exactRequirement(cfg, DATA_PRICE_USDC), privateKeyToAccount(BUYER_KEY as `0x${string}`), `0x${'13'.repeat(32)}`);
    const res = await app.fetch(get('/data/flows', { 'x-payment': header }));
    assert.equal(res.status, 402, 'the buyer keeps their money and learns what failed');
    const body = (await res.json()) as { error: string; flows?: unknown; accepts: unknown[] };
    assert.equal(body.error, 'facilitator http 502');
    assert.equal(body.flows, undefined, 'no row leaves the handler on a failed settlement — the other order is a paywall you can read through');
    assert.equal(body.accepts.length, 1, 'and the offer is restated, so a client can try again');
    assert.equal(stub.hits(), 1);

    const after = await readHealth(app);
    assert.equal(after.healthy, false, 'a lost sale has no other witness, so this one has to');
    assert.equal(after.problem, 'data_settle_failed=1');
    assert.match(after.signals?.last.data_settle_failed.detail ?? '', /facilitator http 502/);
    assert.equal(after.data.sales, 0);
    assert.equal(after.data.spentPayments, 0, 'a payment that never settled did not become a spent nonce');
  } finally {
    await close();
  }
});

test('a facilitator that cannot be reached is a counted failure rather than a 500', async () => {
  const health = createHealth();
  const { app, close } = await dataTierApp({ health });
  const cfg = buildFacilitatorConfig({ sellerKey: SELLER_KEY });
  assert.ok(cfg);
  const header = await payHeader(cfg, exactRequirement(cfg, DATA_PRICE_USDC), privateKeyToAccount(BUYER_KEY as `0x${string}`), `0x${'14'.repeat(32)}`);
  // Outlive the stub first: now every request faces a port nobody listens on,
  // which is a rejected `fetch` rather than an answer, and a rejection is not a
  // verdict. Left uncaptured it becomes a 500 with nothing said anywhere about
  // the sale that was lost.
  await close();
  const { value: res, errors } = await quiet(() => Promise.resolve(app.fetch(get('/data/flows', { 'x-payment': header }))));
  assert.equal(res.status, 402, 'the buyer is told, not left with a stack trace');
  const body = (await res.json()) as { error: string; flows?: unknown };
  assert.equal(body.error, 'settlement unavailable');
  assert.equal(body.flows, undefined);
  assert.equal((await readHealth(app)).problem, 'data_settle_failed=1');
  assert.match(errors.join('\n'), /settleFromRequest threw/, 'the console line stays, next to the counter');
});

test("a buyer's own bad payment is refused without turning the tank red", async () => {
  const health = createHealth();
  const { app, stub, close } = await dataTierApp({ health });
  try {
    const cfg = buildFacilitatorConfig({ sellerKey: SELLER_KEY });
    assert.ok(cfg);
    const requirement = exactRequirement(cfg, DATA_PRICE_USDC);
    const buyer = privateKeyToAccount(BUYER_KEY as `0x${string}`);
    const stranger = privateKeyToAccount(STRANGER_KEY as `0x${string}`);
    const expired = String(Math.floor(Date.now() / 1000) - 10);
    let n = 0x20;
    const once = async (over: Record<string, string>, key = buyer, ask = requirement): Promise<string> => {
      const header = await payHeader(cfg, ask, key, `0x${(n += 1).toString(16).padStart(64, '0')}`, over);
      const res = await app.fetch(get('/data/flows', { 'x-payment': header }));
      assert.equal(res.status, 402, 'each of these is the buyer\'s fix to make, so each is answered');
      const body = (await res.json()) as { error: string; flows?: unknown };
      assert.equal(body.flows, undefined, 'and none of them is served data');
      return body.error;
    };

    // Signed by somebody else over the buyer's own authorization.
    assert.match(await once({ from: buyer.address }, stranger), /signer_mismatch/);
    assert.match(await once({ validBefore: expired }), /authorization expired/);
    assert.match(await once({ value: '999' }), /authorization amount mismatch/);
    assert.match(await once({ to: '0x' + '99'.repeat(20) }), /authorization payTo mismatch/);
    assert.match(await once({}, buyer, exactRequirement(cfg, '0.002')), /amount mismatch/, 'an offer from a different price list');
    assert.match(((await (await app.fetch(get('/data/flows', { 'x-payment': 'not-even-base64' }))).json()) as { error: string }).error, /bad X-Payment encoding/);

    assert.equal(stub.hits(), 0, 'not one of them reached Circle, which is the point of checking first');
    const after = await readHealth(app);
    assert.deepEqual(after.signals?.counts, {}, 'and none of them is counted as the tank being unwell');
    assert.equal(after.healthy, true, 'anybody with a keyboard could otherwise keep this red forever');
    assert.equal(after.problem, null);
    assert.equal(after.data.sales, 0);
  } finally {
    await close();
  }
});

test('a browser is allowed to send the payment header the paid route reads', async () => {
  // The preflight list used to carry `x-payment-tx` (the burn path's receipt
  // header) and not `X-Payment`, which is the header every x402 client puts the
  // signed authorization in. A route that only server-to-server callers can
  // reach is a route the product cannot sell from its own page.
  const app = createApp({ seed: 1, ...offlineFeeds });
  const res = await app.fetch(new Request('http://localhost/data/flows', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  const allow = res.headers.get('access-control-allow-headers') ?? '';
  for (const header of ['content-type', 'x-payment', 'x-payment-tx']) {
    assert.ok(allow.split(',').includes(header), `${header} must survive the preflight: ${allow}`);
  }
});

test('the endpoint index advertises the price and the knob that opens it', async () => {
  const app = createApp({ seed: 1, ...offlineFeeds });
  const index = (await (await app.fetch(get('/api'))).json()) as { endpoints?: Record<string, string> } & Record<string, any>;
  const listing = JSON.stringify(index);
  assert.match(listing, /GET \/data\/flows|\/data\/flows/);
  assert.ok(listing.includes(DATA_PRICE_USDC), 'the price is published where a buyer can read it before signing');
  assert.ok(listing.includes('SELLER_PRIVATE_KEY'), 'and so is the fact that it is closed until the secret arrives');
});

test('the durable object forwards the seller key the way it forwards the anchor key', async () => {
  // Same reasoning as the anchor-key test: every other test here builds its own
  // app, so only this one goes through the object the deployment constructs. The
  // four knobs below are four separate lines in `worker.ts`, and each of them is
  // a `wrangler secret put` or a var that can fail to arrive in silence.
  const seller = privateKeyToAccount(SELLER_KEY as `0x${string}`);
  const armed = await readHealth(worldDO(new Map(), { SELLER_PRIVATE_KEY: SELLER_KEY }).obj);
  assert.equal(armed.data.forSale, true, 'the binding reached createApp');
  assert.equal(armed.data.payTo, seller.address.toLowerCase(), 'and defaulted to the address it controls');
  assert.equal(armed.data.network, 'eip155:5042');
  assert.equal(armed.data.priceUsdc, DATA_PRICE_USDC);

  const testnet = await readHealth(worldDO(new Map(), { SELLER_PRIVATE_KEY: SELLER_KEY, X402_TESTNET: '1' }).obj);
  assert.equal(testnet.data.network, 'eip155:5042002', 'X402_TESTNET is what chooses the chain');

  const swept = await readHealth(worldDO(new Map(), { SELLER_PRIVATE_KEY: SELLER_KEY, SELLER_PAY_TO: `0x${'CD'.repeat(20)}` }).obj);
  assert.equal(swept.data.payTo, `0x${'cd'.repeat(20)}`, 'SELLER_PAY_TO arrives, in one casing');

  const off = await readHealth(worldDO(new Map(), { SELLER_PRIVATE_KEY: `0x${'ab'.repeat(31)}` }).obj);
  assert.equal(off.data.forSale, false, 'a truncated key is no key, and the route says closed rather than broken');
  assert.equal(off.data.payTo, null);
  const bare = await readHealth(worldDO().obj);
  assert.equal(bare.data.forSale, false);
});

test('the seller binding wins over an ambient key, so a stale global cannot be paid', async () => {
  // The failure mode that made the anchor key invisible in production, read
  // first from `process.env` and never from the binding. On the data tier the
  // consequence is worse than a missing feature: an ambient key left behind by
  // another deployment would quietly take the money.
  const had = process.env.SELLER_PRIVATE_KEY;
  process.env.SELLER_PRIVATE_KEY = STRANGER_KEY;
  try {
    const app = createApp({ seed: 1, ...offlineFeeds, sellerKey: SELLER_KEY });
    const body = await readHealth(app);
    assert.equal(body.data.payTo, privateKeyToAccount(SELLER_KEY as `0x${string}`).address.toLowerCase(), 'the binding is who gets paid');
    assert.notEqual(
      body.data.payTo,
      privateKeyToAccount(STRANGER_KEY as `0x${string}`).address.toLowerCase(),
      'and not a key that happens to be in the environment',
    );
  } finally {
    if (had === undefined) delete process.env.SELLER_PRIVATE_KEY;
    else process.env.SELLER_PRIVATE_KEY = had;
  }
});

/* ---------- what committing a day costs, and how long it is funded for ---------- */

/**
 * The anchor has been paying for itself out of an account nobody measured. These
 * tests are the measurement: what a receipt says a day cost, what the chain says
 * is left to pay for, and the two failure modes that would make a published number
 * a lie — a read that did not happen reported as a balance of zero, and an alarm
 * that fires once per process restart instead of once per event.
 */

const feeHex = (units: bigint): string => `0x${units.toString(16)}`;

/**
 * Seed a day whose transaction is already broadcast, so the next tick polls it —
 * and seed the book row that its confirmation points at.
 *
 * Both halves are needed because `stampAnchor` refuses to link a commitment to a
 * row carrying a different hash, so seeding only the record makes every test below
 * also fire `digest_anchor_unstamped` — a fact worth its own test (there is one),
 * and noise in all the others.
 */
async function seedPendingDay(m: ReturnType<typeof memStore>, day: number): Promise<void> {
  const queued = newDigestRecord(day, await buildPayload({ ...STATS, day, tick: day * 4 }, 1));
  m.seedDigest(markPending(markSubmitted(queued, 1), DIGEST_TX, 0));
  m.seedDayBook([{ ...censusFixture(day), hash: queued.payload.hash }]);
}

test('the cost of a day is read from the receipt, in units that cannot round', () => {
  const cost = txFeeUnits({ gasUsed: DIGEST_GAS_USED, effectiveGasPrice: DIGEST_GAS_PRICE });
  assert.ok(cost);
  assert.equal(cost.units, DIGEST_COST_UNITS.toString());
  assert.equal(cost.gasUsed, DIGEST_GAS_USED, 'the operands stay visible, so a reader can redo the product');
  assert.equal(cost.gasPrice, DIGEST_GAS_PRICE);
  // A node that answers with the pre-`effectiveGasPrice` field is still legible,
  // because the quantity that matters is the one the chain charged.
  assert.equal(txFeeUnits({ gasUsed: '0x2', gasPrice: '0x3' })?.units, '6');
  for (const bad of [null, undefined, {}, { gasUsed: '0x2' }, { effectiveGasPrice: '0x3' },
    { gasUsed: '0x', effectiveGasPrice: '0x3' }, { gasUsed: 'zz', effectiveGasPrice: '0x3' }]) {
    assert.equal(txFeeUnits(bad as never), null, `no cost is claimable from ${JSON.stringify(bad)}`);
  }

  // The scales are asserted as numbers rather than as prose: every figure below is
  // converted across the difference between them, and the ratio is a measurement of
  // Arc (the same money named twice), not a preference.
  assert.equal(ARC_FEE_DECIMALS - USDC_TOKEN_DECIMALS, 12);
  // Hex in, nothing out. The comparison runs across *parsed* quantities, and an
  // answer that has not become a decimal string is not a scale anybody can check.
  // Asserted as a refusal on purpose: this line used to read like a passing scale
  // check while both of its arguments were being discarded inside the function.
  assert.equal(unitScaleProblem(feeHex(10n ** 18n), dataWord(10n ** 6n), '0'), null, 'hex in is not a claim about the scale');
  assert.equal(unitScaleProblem('1000000000000000000', '1000000', '0'), null, 'decimal strings work too');
  assert.match(unitScaleProblem('1000000000000000000', '5000000', '0') ?? '', /at 1e12 plus .* is not/);
  // Both directions, because a one-sided comparison passes for the other half of
  // the mistakes: a fee balance that *overstates* what the token contract reports
  // is the version that promises more anchors than exist.
  assert.match(unitScaleProblem('2000000000000000000', '1000000', '0') ?? '', /at 1e12 plus .* is not/,
    'a fee balance twice the token one is as much a moved scale as half of it');
  assert.equal(unitScaleProblem(null, '5000000', '0'), null, 'an unread balance is not a broken scale');
  // The rule is a truncation, not a scaled equality, and the deployed account is
  // what proved it: read on 2026-09-24 it answered `0x1156fcae4bf3247f0` for
  // `eth_getBalance` and `0x1310b7c` for `balanceOf` — the same money, with
  // 355,000,000,000 fee units of dust under the six-decimal boundary. A check that
  // demanded exact equality would have alarmed on the first read after shipping.
  assert.equal(unitScaleProblem('19991420355000000000', '19991420', '0'), null,
    'sub-USDC dust in the fee layer is not a moved scale');
  assert.match(unitScaleProblem('19991420355000000000', '19991421', '0') ?? '', /at 1e12 plus .* is not/,
    'but one whole USDC off is');
  // And one whole USDC off is exactly what a sale is, which is why the third
  // argument exists. The deployed `payTo` is the address whose two balances are
  // being compared, so the first customer to pay 0.001 USDC moves the token side of
  // this comparison by 1,000 units and nothing else — a rule without the revenue
  // term reads that as the chain having changed its units.
  assert.equal(unitScaleProblem('19991420355000000000', '19992420', '1000'), null,
    'revenue paid into this account is part of what its token balance should be');
  assert.match(unitScaleProblem('19991420355000000000', '19991420', '1000') ?? '', /plus 1000 USDC units paid in is not/,
    'revenue that is on the tally but not on the chain is still a mismatch');
  assert.match(unitScaleProblem('19991420355000000000', '19991421', '1000') ?? '', /is not 19991421/,
    'and the tally does not excuse an unexplained unit');
  // Three quantities, one instant: an unknown in any of them makes the comparison
  // not knowable rather than failed.
  assert.equal(unitScaleProblem('1000000000000000000', '1000000', null), null,
    'a tally that has not been taken is not a broken scale');
  assert.equal(unitScaleProblem('19991420355000000000', '19992420', null), null,
    'and it is not read as a tally of zero either, which would turn the unknown into a mismatch');
  assert.equal(unitScaleProblem('1000000000000000000', '1000000', '1.5'), null,
    'and neither is one that is not a count');

  assert.equal(addDecimalUnits('1000', '1000'), '2000');
  assert.equal(addDecimalUnits('1000', '0.5'), null, 'half a base unit is not a count');
  assert.equal(addDecimalUnits('-1', '1'), null);
});

test('a runway is a division, and refuses to be one when either side is missing', () => {
  const funded = anchorRunway((10n ** 18n).toString(), DIGEST_COST_UNITS.toString());
  assert.equal(funded.anchors, 1638, 'one USDC of fee balance at the measured price');
  assert.equal(funded.problem, null);
  assert.equal(funded.capped, false);
  assert.equal(anchorRunway('0', DIGEST_COST_UNITS.toString()).anchors, 0, 'an empty account is a real answer');

  // The three ways to have no answer are named separately, because they want three
  // different actions and `0` would be the wrong answer for all of them.
  assert.match(anchorRunway(null, '5').problem ?? '', /balance not read/);
  assert.match(anchorRunway('10', null).problem ?? '', /no anchor cost measured/);
  assert.match(anchorRunway('10', '0').problem ?? '', /not believable/);
  assert.equal(anchorRunway('10', '0').anchors, null, 'a zero-cost receipt is not an infinite runway');

  const huge = anchorRunway('1' + '0'.repeat(40), '1');
  assert.equal(huge.anchors, Number.MAX_SAFE_INTEGER, 'the clamp is reported rather than silently saturating');
  assert.equal(huge.capped, true);
});

test('the stored economics object is asked whether it still means what it claims', () => {
  assert.equal(anchorEconProblem(newAnchorEcon(0)), null);
  assert.equal(anchorEconProblem(newAnchorEcon(123)), null);
  const corrupt: [string, AnchorEcon][] = [
    ['a balance that arrived as a number', { ...newAnchorEcon(1), balanceUnits: 12345 as unknown as string }],
    ['a token balance that arrived as a number', { ...newAnchorEcon(1), tokenUnits: 7n as unknown as string }],
    ['a cost that arrived as a number', { ...newAnchorEcon(1), costUnits: 5 as unknown as string, costDay: 1 }],
    ['a revenue total that is not a count', { ...newAnchorEcon(1), revenueUnits: '1.5' }],
    ['the revenue beside a reading that is not a count', { ...newAnchorEcon(1), revenueAtRead: '1e3' }],
    ['a negative sale count', { ...newAnchorEcon(1), sales: -1 }],
    ['an alarm flag that is a string', { ...newAnchorEcon(1), lowNoted: 'yes' as unknown as boolean }],
    ['a cost belonging to no day', { ...newAnchorEcon(1), costUnits: '5', costDay: null }],
    ['a day attached to no cost', { ...newAnchorEcon(1), costUnits: null, costDay: 3 }],
    ['an unparseable timestamp', { ...newAnchorEcon(Number.NaN) }],
  ];
  for (const [what, value] of corrupt) assert.ok(anchorEconProblem(value), what);

  // Absent is not corrupt. Every ledger written before `revenueAtRead` existed is in
  // this set — the deployed one included, on the first day after a deploy — and
  // refusing one would throw away the cost of every anchored day so far to keep a
  // bookkeeping rule tidy.
  const beforeField = { ...newAnchorEcon(1), balanceUnits: '19991420355000000000', tokenUnits: '19991420' };
  delete (beforeField as { revenueAtRead?: string | null }).revenueAtRead;
  assert.equal(anchorEconProblem(beforeField as AnchorEcon), null, 'a reading with no tally stored beside it loads');
});

test('a signal reddens the health light only while it is still happening', () => {
  const T = 1_700_000_000_000;
  const view = (at: number | undefined): HealthView => ({
    startedAt: T,
    counts: { census_row_rejected: 2 },
    last: at === undefined ? {} : { census_row_rejected: { at, detail: 'headcount does not add up', count: 2 } },
  });
  assert.equal(healthProblem(view(T), T + 1000), 'census_row_rejected=2', 'a fresh signal is a red light');
  assert.equal(healthProblem(view(T), T + PROBLEM_WINDOW_MS), 'census_row_rejected=2', 'the boundary itself counts');
  assert.equal(healthProblem(view(T), T + PROBLEM_WINDOW_MS + 1), null, 'and the moment after it is history');
  assert.deepEqual(staleSignals(view(T), T + PROBLEM_WINDOW_MS + 1), ['census_row_rejected=2'],
    'out of window is not the same as forgotten');
  // A count with nothing to date it by is treated as fresh: guessing "ancient" is
  // how the one ledger that should be looked at gets the benefit of the doubt.
  const undated = { startedAt: T, counts: { census_row_rejected: 2 }, last: {} } as HealthView;
  assert.equal(healthProblem(undated, T + 10 * PROBLEM_WINDOW_MS), 'census_row_rejected=2');
  assert.deepEqual(staleSignals(undated, T + 10 * PROBLEM_WINDOW_MS), []);
  assert.equal(healthProblem(null), 'no health view');
  assert.deepEqual(staleSignals(undefined), []);
});

/**
 * Drive one already-broadcast day to confirmation and hand back what `/health`
 * says. `balanceLatencyMs` holds up the pump's tail so a caller can tell waiting
 * for it from getting lucky; the default of 0 leaves every other test in this
 * family exactly as fast as it has always been.
 */
async function anchoredOnce(
  rpc: DigestRpc,
  m: ReturnType<typeof memStore>,
  health: ReturnType<typeof createHealth>,
  day = 0,
  balanceLatencyMs = 0,
): Promise<HealthBody> {
  const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
  rpc.setBalanceLatency(balanceLatencyMs);
  shortenDay(app);
  await tickTimes(app, 4);
  await untilDigest(m.digest, (r) => r.status === 'confirmed' && r.day === day, `day ${day} confirmed`);
  // `confirmed` is not the end of the pump: the economics read that fills every
  // number below is the pump's last act and does two RPC calls *after* the status
  // flips, because a viewer's tick must never block on the chain. Reading `/health`
  // without waiting for that tail is what made this family of assertions pass on an
  // idle machine and fail on a busy one.
  await app.settleDigest();
  return readHealth(app);
}

test('/health reports a repaired defect as history, not as a present failure', async () => {
  // The state the public tank actually reached: rows refused by a loader that has
  // since been fixed, with the counts still standing in durable storage. Reddening
  // forever over a defect that no longer happens is how an alarm becomes a
  // decoration, and the count going backwards is not an option either — it happened.
  const health = createHealth();
  health.merge({
    counts: { census_row_rejected: 2 },
    last: {
      census_row_rejected: {
        at: Date.now() - PROBLEM_WINDOW_MS - 60_000, detail: 'headcount does not add up', count: 2,
      },
    },
  });
  const app = createApp({ seed: 1, health, ...offlineFeeds });
  const { value: body } = await quiet(() => readHealth(app));
  assert.equal(body.healthy, true, 'clean for longer than the window, which is what healthy means');
  assert.equal(body.problem, null);
  assert.equal(body.stale, 'census_row_rejected=2', 'and the total is still there to be read');
  assert.equal(body.signals?.counts.census_row_rejected, 2);

  // The same kind firing again is news again: a window is not a mute button.
  health.note('census_row_rejected', 'headcount does not add up');
  const now = await readHealth(app);
  assert.equal(now.healthy, false);
  assert.equal(now.problem, 'census_row_rejected=3');
  assert.equal(now.stale, null, 'a signal cannot be both current and out of window');
});

test('the reading beside a confirmed day is waited for, not raced', async () => {
  // The status flips to `confirmed` and the pump then makes two more RPC calls for
  // the balances every figure in this file's anchor assertions is computed from. A
  // local stub answers those in microseconds, which is how those assertions came to
  // be written as though confirming implied them: they pass on an idle machine,
  // fail on a busy one, and a failure that only happens under load is one nobody
  // can reproduce. So the slowness is installed deliberately — with it in place,
  // deleting the wait in `anchoredOnce()` turns an occasional red into a permanent
  // one, and the pair of reads below is the difference between waiting for the pump
  // and guessing how long to sleep.
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      rpc.setBalanceLatency(120);
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', blockNumber: '0x101', transactionHash: DIGEST_TX });
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 4);
      await untilDigest(m.digest, (r) => r.status === 'confirmed' && r.day === 0, 'day 0 confirmed');
      // Still outstanding at 10ms, which is what the 120ms delay buys: a budget that
      // only ever expired on a pump that had already finished would be a sleep, and
      // this is the assertion that says it is not.
      await assert.rejects(
        () => app.settleDigest(10),
        /the anchor pump never settled within 10ms/,
        'a pump that outruns the budget is reported rather than waited out',
      );
      await app.settleDigest();
      const body = await readHealth(app);
      assert.ok(rpc.methods.includes('eth_getBalance'), 'the fee balance was read, not assumed');
      assert.equal(body.anchor.funded.bothRead, true, 'the tail landed before the reading was taken');
      assert.equal(body.anchor.funded.feeUnits, (10n ** 18n).toString());
      assert.equal(body.anchor.funded.scaleOk, true);
      assert.equal(body.anchor.runway.anchors, 1638, 'a runway computed from balances that had arrived');
      assert.equal(health.view().counts.digest_pump_failed, undefined, 'and nothing failed on the way');

      // The same day through `anchoredOnce()`, the helper every other test in this
      // family reads its numbers from. Its wait is the line that used to be a coin
      // flip, so it is the one place the slowness has to be installed too: with it,
      // deleting that wait fails here on every run rather than on a busy machine.
      const m2 = memStore();
      await seedPendingDay(m2, 0);
      const viaHelper = await anchoredOnce(rpc, m2, createHealth(), 0, 120);
      assert.equal(viaHelper.anchor.funded.bothRead, true, 'the helper returns after the tail, not after the status');
      assert.equal(viaHelper.anchor.runway.low, false);
    });
  } finally {
    rpc.close();
  }
});

test('a tick that arrives while the pump is busy does not answer "the pump has finished"', async () => {
  // The wait above is only as honest as the promise it watches. `advance()` used to
  // write that promise at the call site, so the next tick — the one the re-entry
  // guard turns into an immediate no-op — replaced the running one with a promise
  // that had already settled, and `settleDigest()` answered "done" while a
  // confirmed day's two balance reads were still open. Every anchor assertion in
  // this file would then be reading a moment that had not happened yet, which is
  // the false green the wait exists to prevent. The latency is generous on purpose:
  // the point to prove is that a skipped tick still has a run outstanding, and a
  // machine under load should not be able to fake the other answer.
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      rpc.setBalanceLatency(300);
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', blockNumber: '0x101', transactionHash: DIGEST_TX });
      const app = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      shortenDay(app);
      await tickTimes(app, 4);
      await untilDigest(m.digest, (r) => r.status === 'confirmed' && r.day === 0, 'day 0 confirmed');
      // Ticks the guard swallows, arriving while the tail is open: these are the
      // calls that used to satisfy the wait.
      await tickTimes(app, 2);
      await assert.rejects(
        () => app.settleDigest(10),
        /the anchor pump never settled within 10ms/,
        'a skipped re-entry is not a finished run',
      );
      await app.settleDigest();
      const body = await readHealth(app);
      assert.equal(body.anchor.funded.bothRead, true, 'the wait handed over balances that had arrived');
      assert.equal(body.anchor.funded.feeUnits, (10n ** 18n).toString());
      assert.equal(body.anchor.runway.anchors, 1638);
      assert.equal(health.view().counts.digest_pump_failed, undefined, 'and refusing to finish early is not a failure');
    });
  } finally {
    rpc.close();
  }
});

test('a confirmed day says what it cost and how long the account funds', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', blockNumber: '0x101', transactionHash: DIGEST_TX });
      const { value: body, errors } = await quiet(() => anchoredOnce(rpc, m, health));
      assert.ok(rpc.methods.includes('eth_call'), 'the token balance was asked for, not assumed');
      // Asked, and asked *correctly*: the call has to be `balanceOf(signer)` against
      // the USDC contract. A `to` that names some other contract, or an account that
      // names some other holder, both answer with a number that looks like a result —
      // and the scale check below would then be comparing the wrong two balances.
      const { ARC_USDC_ADDRESS } = await import('../src/arc.js');
      assert.equal(rpc.calls.length, 1, 'one token read per confirmed day');
      assert.equal(rpc.calls[0].to.toLowerCase(), ARC_USDC_ADDRESS.toLowerCase(), 'against the USDC contract');
      assert.equal(
        rpc.calls[0].data,
        `0x70a08231${(body.anchor.signer ?? '').toLowerCase().replace(/^0x/, '').padStart(64, '0')}`,
        'for the balance of the address that pays for the anchor',
      );
      assert.ok(errors.every((e) => !/anchor economics|runway/.test(e)), 'a clean read prints nothing');
      assert.ok(!body.signals?.counts.anchor_econ_unreadable, 'and files no signal about it');
      assert.equal(body.healthy, true, `nothing went wrong: ${body.problem ?? ''}`);
      assert.equal(body.anchor.signer, body.digest?.signer, 'whose balance this is, named once');
      assert.ok(body.anchor.signer, 'with a key configured, there is a signer');
      assert.ok(body.anchor.readAt > 0, 'the reading is stamped with when it happened');
      assert.ok((body.anchor.ageSeconds ?? 99) < 5, 'and its age is published beside it');
      assert.equal(body.anchor.funded.feeUnits, (10n ** 18n).toString());
      assert.equal(body.anchor.funded.feeDecimals, ARC_FEE_DECIMALS);
      assert.equal(body.anchor.funded.usdcUnits, (10n ** 6n).toString());
      assert.equal(body.anchor.funded.usdcDecimals, USDC_TOKEN_DECIMALS);
      assert.equal(body.anchor.funded.bothRead, true);
      assert.equal(body.anchor.funded.scaleOk, true, 'the two balances name the same money');
      assert.equal(body.anchor.lastCost.feeUnits, DIGEST_COST_UNITS.toString());
      assert.equal(body.anchor.lastCost.day, 0, 'a cost always names the day it belongs to');
      assert.equal(body.anchor.runway.anchors, 1638);
      assert.equal(body.anchor.runway.unknown, null);
      assert.equal(body.anchor.runway.low, false);
      assert.equal(body.anchor.runway.alarmBelow, RUNWAY_ALARM_ANCHORS);
      assert.equal(body.anchor.revenue.sales, 0);
      assert.equal(body.anchor.revenue.quotedUnits, '0');

      // Durable, and not re-read by an idle isolate: the numbers a later process
      // publishes are the ones the chain gave, with the age they have earned.
      assert.equal(m.anchor()?.costUnits, DIGEST_COST_UNITS.toString());
      const later = createApp({ seed: 1, store: m.store, rpc: rpc.url, health, ...offlineFeeds });
      const second = await readHealth(later);
      assert.equal(second.anchor.readAt, body.anchor.readAt, 'the reading survived the isolate that took it');
      assert.equal(second.anchor.funded.feeUnits, body.anchor.funded.feeUnits);
      assert.equal(second.anchor.runway.anchors, 1638);
      assert.ok((second.anchor.ageSeconds ?? 0) >= 0, 'older now, and saying so');
    });
  } finally {
    rpc.close();
  }
});

test('a low runway is one event, and falling again after recovering is two', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  const feePerToken = 10n ** 12n;
  const poor = 50n * DIGEST_COST_UNITS;
  const rich = 200n * DIGEST_COST_UNITS;
  const stage = async (day: number, feeUnits: bigint) => {
    rpc.setBalances(feeHex(feeUnits), dataWord(feeUnits / feePerToken));
    await seedPendingDay(m, day);
    rpc.setReceipt({ status: '0x1', blockNumber: '0x101', transactionHash: DIGEST_TX });
    const { value: body, errors } = await quiet(() => anchoredOnce(rpc, m, health, day));
    return { body, errors };
  };
  try {
    await withDigestKey(async () => {
      const first = await stage(0, poor);
      assert.equal(first.body.anchor.runway.anchors, 50, 'fifty days of commitment left, which is a fact worth printing');
      assert.equal(first.body.anchor.runway.low, true);
      assert.equal(first.body.anchor.runway.alarmNoted, true);
      assert.equal(first.body.signals?.counts.anchor_runway_low, 1);
      assert.match(first.body.problem ?? '', /anchor_runway_low=1/, 'and it reddens the light');
      assert.ok(first.errors.some((e) => /anchor runway low/.test(e)), 'the line a human tails still prints');

      // A later process over an account that is still poor does not raise it again:
      // the count would otherwise measure how long the tank has been broke, which is
      // not a thing anyone needs a counter for.
      const again = await stage(1, poor);
      assert.equal(again.body.anchor.runway.anchors, 50);
      assert.equal(again.body.signals?.counts.anchor_runway_low, 1, 'one event, not one per isolate');
      assert.equal(again.errors.filter((e) => /anchor runway low/.test(e)).length, 0, 'and nothing printed the second time');

      // Recovering clears the stored flag, so a second fall is genuinely new news.
      const toppedUp = await stage(2, rich);
      assert.equal(toppedUp.body.anchor.runway.anchors, 200);
      assert.equal(toppedUp.body.anchor.runway.low, false);
      assert.equal(toppedUp.body.anchor.runway.alarmNoted, false, 'the edge state resets with the balance');
      assert.equal(toppedUp.body.signals?.counts.anchor_runway_low, 1);

      const fell = await stage(3, poor);
      assert.equal(fell.body.signals?.counts.anchor_runway_low, 2, 'a second fall is a second event');
      assert.equal(fell.body.anchor.lastCost.day, 3, 'and the cost shown is the newest receipt');
    });
  } finally {
    rpc.close();
  }
});

test('a receipt without gas is one failure, and does not erase the last cost', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const priced = await anchoredOnce(rpc, m, health);
      assert.equal(priced.anchor.lastCost.feeUnits, DIGEST_COST_UNITS.toString());

      // Day 1's receipt arrives without the gas fields a mined receipt always has.
      // Explicitly undefined: they must beat the stub's defaults, because this is
      // the case where the node answered something that cannot be priced.
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX, gasUsed: undefined, effectiveGasPrice: undefined });
      await seedPendingDay(m, 1);
      const { value: body, errors } = await quiet(() => anchoredOnce(rpc, m, health, 1));
      // Nothing new is claimed about day 1's price, and nothing already known is
      // thrown away: the cost stays the one the chain actually reported, with the
      // day it belongs to still attached.
      assert.equal(body.anchor.lastCost.feeUnits, DIGEST_COST_UNITS.toString(), 'the last real cost survives an unreal one');
      assert.equal(body.anchor.lastCost.day, 0, 'and it keeps saying which day it was');
      assert.equal(body.anchor.runway.anchors, 1638, 'the runway is still the division it was');
      assert.equal(body.signals?.counts.anchor_econ_unreadable, 1);
      assert.match(healthDetail(body, 'anchor_econ_unreadable'), /gasUsed.effectiveGasPrice/, 'with the reason');
      assert.ok(errors.some((e) => /anchor economics incomplete/.test(e)));
      assert.match(body.problem ?? '', /anchor_econ_unreadable=1/);
    });
  } finally {
    rpc.close();
  }
});

test('a chain that stops naming one money with two units is reported, not absorbed', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      // 1e18 fee units against 5e6 token units: the same account, two incompatible
      // stories. Every conversion in `econ.ts` goes through that ratio, so the
      // runway below would still print — and mean nothing.
      rpc.setBalances(feeHex(10n ** 18n), dataWord(5n * 10n ** 6n));
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const body = await anchoredOnce(rpc, m, health);
      assert.equal(body.anchor.funded.scaleOk, false);
      assert.equal(body.anchor.funded.bothRead, true);
      assert.equal(body.signals?.counts.arc_unit_scale_unexpected, 1);
      assert.match(healthDetail(body, 'arc_unit_scale_unexpected') ?? '', /fee units at 1e12 plus .* is not/);
      assert.match(body.problem ?? '', /arc_unit_scale_unexpected=1/);
      // The figures are still published, with the alarm beside them: a reader who
      // wants the balance gets it and sees that it is distrusted.
      assert.equal(body.anchor.runway.anchors, 1638);
      assert.equal(body.anchor.runway.low, false);
    });
  } finally {
    rpc.close();
  }
});

test('a sale that lands in the checked account is part of that account\u2019s own scale rule', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      // One 0.001-USDC sale settled, and the fee layer untouched. This is the exact
      // state the first customer produces on the deployed world, because the money
      // arrives at the address whose two balances are being compared: the live 402
      // quote read on 2026-09-25 names payTo 0x42e60b67…, which is the same account
      // `/health` publishes as `anchor.signer`. Before this term existed the
      // comparison ignored it, so a paying customer was reported as the chain having
      // changed its units.
      rpc.setBalances('0x1156fcae4bf3247f0', dataWord(19_992_420n));
      m.seedAnchor({ ...newAnchorEcon(0), sales: 1, revenueUnits: '1000' });
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const app = createApp({
        seed: 1, store: m.store, rpc: rpc.url, health, sellerKey: process.env.ARC_DIGEST_KEY, ...offlineFeeds,
      });
      shortenDay(app);
      await tickTimes(app, 4);
      await untilDigest(m.digest, (r) => r.status === 'confirmed' && r.day === 0, 'day 0 confirmed');
      await app.settleDigest();
      const { value: body, errors } = await quiet(() => readHealth(app));
      assert.equal(body.data.forSale, true, 'the seller key reached the object, so the tally is this address\u2019s');
      assert.equal(body.data.payTo, (body.anchor.signer ?? '').toLowerCase(), 'and it is paid to the checked address');
      assert.equal(body.anchor.funded.usdcUnits, '19992420');
      assert.equal(body.anchor.funded.scaleOk, true, 'truncated fee balance plus the revenue that landed here');
      assert.equal(body.anchor.funded.bothRead, true);
      assert.equal(body.signals?.counts.arc_unit_scale_unexpected, undefined, 'a customer is not an alarm');
      assert.ok(errors.every((e) => !/suspect/.test(e)), 'and nothing is printed about it');
      assert.equal(body.anchor.revenue.quotedUnits, '1000');
      assert.equal(body.anchor.revenue.atReadingUnits, '1000', 'the third term of the comparison is published beside it');
      assert.equal(m.anchor()?.revenueAtRead, '1000', 'and it is the reading that is durable, not the page view');
    });
  } finally {
    rpc.close();
  }
});

test('revenue paid somewhere else excuses nothing about the account being checked', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      // The same chain answer as above, the same tally, and a `payTo` that is a
      // different account. Handing the comparison the whole tally regardless of
      // where the money went would excuse a moved scale for any deployment that
      // sells from a separate treasury, which is the mistake in the other
      // direction — and the one a reader of `/health` could not see.
      rpc.setBalances('0x1156fcae4bf3247f0', dataWord(19_992_420n));
      m.seedAnchor({ ...newAnchorEcon(0), sales: 1, revenueUnits: '1000' });
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const app = createApp({
        seed: 1, store: m.store, rpc: rpc.url, health,
        sellerKey: process.env.ARC_DIGEST_KEY,
        sellerPayTo: '0x1111111111111111111111111111111111111111',
        ...offlineFeeds,
      });
      shortenDay(app);
      await tickTimes(app, 4);
      await untilDigest(m.digest, (r) => r.status === 'confirmed' && r.day === 0, 'day 0 confirmed');
      await app.settleDigest();
      const body = await readHealth(app);
      assert.equal(body.data.payTo, '0x1111111111111111111111111111111111111111', 'the money goes elsewhere');
      assert.equal(body.anchor.funded.scaleOk, false, 'so its token balance is unexplained by this one');
      assert.equal(body.signals?.counts.arc_unit_scale_unexpected, 1);
      assert.match(healthDetail(body, 'arc_unit_scale_unexpected') ?? '', /plus 0 USDC units paid in/,
        'and the reason says which term was counted, because that is the whole question');
      assert.equal(body.anchor.revenue.quotedUnits, '1000', 'the sales count is still reported as itself');
      assert.equal(body.anchor.revenue.atReadingUnits, '0');
    });
  } finally {
    rpc.close();
  }
});

test('a sale that settles after a reading does not re-light that reading\u2019s comparison', async () => {
  const m = memStore();
  const health = createHealth();
  // The balances were read when nothing had been sold; a sale has settled since.
  // Recomputing `scaleOk` against the live tally would turn that ordinary sequence
  // into a disagreement lasting until the next reading, which on this product is up
  // to one anchored day away — long enough to make /health red over a customer.
  m.seedAnchor({
    ...newAnchorEcon(1_700_000_000_000),
    balanceUnits: '19991420355000000000', tokenUnits: '19991420',
    costUnits: DIGEST_COST_UNITS.toString(), costDay: 3,
    sales: 3, revenueUnits: '3000', revenueAtRead: '0',
  });
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  const { value: body } = await quiet(() => readHealth(app));
  assert.equal(body.anchor.funded.scaleOk, true, 'the stored comparison stands on the stored terms');
  assert.equal(body.anchor.revenue.quotedUnits, '3000', 'the tally itself is not hidden');
  assert.equal(body.anchor.revenue.atReadingUnits, '0', 'and the reader is told which one the check used');
  assert.equal(body.healthy, true, 'nothing went wrong: ' + (body.problem ?? ''));
});

test('a reading written before the tally field existed is not read as a tally of zero', async () => {
  const m = memStore();
  const health = createHealth();
  // The one ledger this rewrite actually meets in production: two balances stored
  // by a build that recorded no `revenueAtRead`, and a non-zero tally beside them.
  // The pair below is consistent with 3,000 units having landed at the checked
  // address and with nothing having landed there equally badly — only one of the
  // two answers is true, and the stored reading does not say which. Substituting
  // `'0'` for the absent term therefore does not report an unknown, it reports a
  // disagreement, and it reports it for as long as it takes the next day to
  // confirm: up to 86 minutes of `/health` claiming the account's money stopped
  // naming itself, because a customer bought something.
  const stored = {
    ...newAnchorEcon(1_700_000_000_000),
    balanceUnits: '19991420355000000000', tokenUnits: '19994420',
    costUnits: DIGEST_COST_UNITS.toString(), costDay: 3,
    sales: 3, revenueUnits: '3000',
  };
  delete (stored as { revenueAtRead?: string | null }).revenueAtRead;
  m.seedAnchor(stored);
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  const { value: body } = await quiet(() => readHealth(app));
  assert.equal(body.anchor.funded.scaleOk, null, 'the third term is unknown, which is not the same as false');
  assert.equal(body.anchor.revenue.atReadingUnits, null, 'and the page says so rather than picking a number');
  assert.equal(body.anchor.revenue.quotedUnits, '3000', 'the tally since then is still reported as itself');
  assert.equal(body.healthy, true, 'a field an older build never wrote is not a problem: ' + (body.problem ?? ''));
});

test('the account the chain actually reports has dust in it, and is still believed', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      // Both figures are the ones the deployed anchor account answered on
      // 2026-09-24: `0x1156fcae4bf3247f0` from `eth_getBalance`, and a `balanceOf`
      // word whose low digits are `1310b7c` — sent padded to a full word, which is
      // the form that used to be written here unpadded and therefore the form no
      // test ever exercised. The stub's default pair is exactly 1e12 apart, which is
      // precisely why it was the wrong shape to test this with — a balance with no
      // dust under the six-decimal boundary is not a balance an account holds.
      rpc.setBalances('0x1156fcae4bf3247f0', dataWord(0x1310b7cn));
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const { value: body, errors } = await quiet(() => anchoredOnce(rpc, m, health));
      assert.equal(body.healthy, true, `dust is not a defect: ${body.problem ?? ''}`);
      assert.equal(body.anchor.funded.scaleOk, true, 'the two readings still name one money');
      assert.equal(body.anchor.funded.bothRead, true);
      assert.equal(body.signals?.counts.arc_unit_scale_unexpected, undefined, 'and no alarm is raised');
      assert.ok(errors.every((e) => !/suspect/.test(e)), 'nothing is printed about it either');
      assert.equal(body.anchor.runway.anchors, 32_751, 'the division is the same one, on the real balance');
      assert.equal(body.anchor.runway.low, false, 'and 32,751 days of commitment is not an alarm');
    });
  } finally {
    rpc.close();
  }
});

test('a contract answers in a padded word, and the reader that knows the difference believes it', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      // The stub's default pair is one USDC at each scale, and the token side is
      // sent the way a node sends it: padded to a full word. Everything asserted
      // below is the difference between that shape being recognised and the
      // deployed reader never once having seen the balance it was asked for.
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const body = await anchoredOnce(rpc, m, health);
      assert.equal(body.anchor.funded.usdcUnits, (10n ** 6n).toString(), 'the padded word is read as the number it is');
      assert.equal(body.anchor.funded.bothRead, true, 'both halves of the pair are here');
      assert.equal(body.anchor.funded.scaleOk, true,
        'and the invariant the two readings exist to check has now actually been checked');
      assert.equal(body.signals?.counts.arc_unit_scale_unexpected, undefined, 'a check that passes raises nothing');
    });
  } finally {
    rpc.close();
  }
});

test('the two hex shapes on the wire are not interchangeable, in either direction', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      // The same 32-byte word sent to the two calls, and only one of them is a
      // contract answer. A reader that gave up on the distinction — by accepting
      // padding everywhere, which is the tempting way to fix the bug this test
      // exists for — would then believe a node that had started padding its
      // quantities, and the two balances would stop being comparable in silence.
      rpc.setBalances(dataWord(10n ** 18n), dataWord(10n ** 6n));
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const body = await anchoredOnce(rpc, m, health);
      assert.equal(body.anchor.funded.feeUnits, null, 'a quantity is minimal, and a padded one is not one');
      assert.equal(body.anchor.funded.usdcUnits, (10n ** 6n).toString(), 'the call answer is still a balance');
      assert.equal(body.anchor.funded.bothRead, false, 'half a pair is not a pair');
      assert.equal(body.anchor.funded.scaleOk, null, 'which is reported as unknowable, not as broken');
      assert.equal(body.anchor.runway.anchors, null, 'and the division that needs the missing half does not print');
      assert.equal(body.anchor.runway.unknown, 'balance not read');
      // Counted as well as published. `/health` saying `bothRead: false` is a fact
      // only a reader who already suspects something will go and look at; the
      // signal is the half that arrives on its own, and it names the call that
      // was refused and the shape it was refused for.
      assert.equal(body.signals?.counts.anchor_econ_unreadable, 1);
      assert.match(
        healthDetail(body, 'anchor_econ_unreadable'),
        /eth_getBalance answered .*64 hex digits.* does not read as quantity/,
        'the reason says which call was refused, in roughly what shape',
      );
    });
  } finally {
    rpc.close();
  }
});

test('a call that answers with more than one word is not a balance', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      // 96 hex digits — the shape of a log topic blob or a list of addresses, which
      // is what a wrong `to` or a wrong selector answers with. `BigInt` reads it
      // happily, and the resulting "balance" would be a number nobody can question.
      rpc.setBalances(STUB_FEE_BALANCE, `0x${'11'.repeat(48)}`);
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const body = await anchoredOnce(rpc, m, health);
      assert.equal(body.anchor.funded.usdcUnits, null, 'too long to be a word is not a quantity');
      assert.equal(body.anchor.funded.bothRead, false);
      assert.equal(body.anchor.funded.feeUnits, (10n ** 18n).toString(), 'the half that answered normally still speaks');
      assert.equal(body.signals?.counts.anchor_econ_unreadable, 1, 'and the half that did not is counted');
      assert.match(
        healthDetail(body, 'anchor_econ_unreadable'),
        /eth_call answered .*96 hex digits.* does not read as data/,
        'under the name of the call that was too long, not as a generic failure',
      );
    });
  } finally {
    rpc.close();
  }
});

test('the stub answers each hex type the way the chain answers that hex type', async () => {
  // The fixture's own fidelity, asked directly. Every shape test above reads the
  // chain through this stub, so a stub that padded both answers — or, worse, one
  // that quietly went back to minimising both — would leave the reader's shape
  // rules untested while every test here stayed green.
  const rpc = await digestRpcStub();
  const ask = async (method: string, params: unknown[]): Promise<string> => {
    const res = await fetch(rpc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return String((await res.json() as { result?: unknown }).result);
  };
  try {
    const word = await ask('eth_call', [{ to: ARC_USDC, data: '0x70a08231' }, 'latest']);
    assert.match(word, /^0x[0-9a-f]{64}$/, `a contract answer is a full word, and the stub sent ${word}`);
    const quantity = await ask('eth_getBalance', ['0x' + '22'.repeat(20), 'latest']);
    assert.match(quantity, /^0x(0|[1-9a-f][0-9a-f]*)$/, `a quantity stays minimal, and the stub sent ${quantity}`);
  } finally {
    rpc.close();
  }
});

test('an unreadable balance ages the last figures instead of erasing them quietly', async () => {
  const rpc = await digestRpcStub();
  const m = memStore();
  const health = createHealth();
  try {
    await withDigestKey(async () => {
      await seedPendingDay(m, 0);
      rpc.setReceipt({ status: '0x1', transactionHash: DIGEST_TX });
      const good = await anchoredOnce(rpc, m, health);
      assert.equal(good.anchor.funded.feeUnits, (10n ** 18n).toString());

      // Day 1 confirms and the node *refuses* the token read. An error answer
      // changes nothing but the counter: the previous figures stay, and the age
      // they publish grows, which is the only honest way to say "we have not heard
      // from the chain since" without inventing a zero.
      rpc.setCallError('execution reverted');
      await seedPendingDay(m, 1);
      // `anchoredOnce`, not a hand-rolled copy of what it does: the copy waited for
      // the record to say `confirmed` and then read `/health`, and `confirmed` is
      // persisted *before* the two balance reads start, because a viewer's tick must
      // never block on the chain. So the copy raced the very refusal it asserts —
      // which is how it passed on an idle machine and failed on the runner.
      const { value: refused, errors } = await quiet(() => anchoredOnce(rpc, m, health, 1));
      assert.equal(refused.signals?.counts.anchor_econ_unreadable, 1);
      assert.match(refused.problem ?? '', /anchor_econ_unreadable=1/);
      assert.ok(errors.some((e) => /anchor economics not read/.test(e)));
      assert.equal(refused.anchor.readAt, good.anchor.readAt, 'a read that failed does not restamp the figures');
      assert.equal(refused.anchor.funded.feeUnits, (10n ** 18n).toString(), 'the last answer stands');
      assert.equal(refused.anchor.runway.anchors, 1638, 'and is still divided by the cost it was divided by');

      // Day 2 confirms and the node answers one balance and mangles the other.
      // That is the opposite case to a refusal: a legible "I have no idea" gets a
      // fresh timestamp and a null, because the alternative is a stale figure
      // wearing a current one — and `bothRead` has to be false rather than letting
      // the half that answered speak for the half that did not.
      rpc.setCallError(null);
      rpc.setBalances(feeHex(10n ** 18n), '0x');
      await seedPendingDay(m, 2);
      const unread = await quiet(() => anchoredOnce(rpc, m, health, 2));
      assert.equal(unread.value.anchor.readAt > refused.anchor.readAt, true, 'a new timestamp, for a new answer');
      assert.equal(unread.value.anchor.funded.usdcUnits, null, 'the half that mangled is null, not stale');
      assert.equal(unread.value.anchor.funded.feeUnits, (10n ** 18n).toString(), 'the half that answered is the fresh one');
      assert.equal(unread.value.anchor.funded.bothRead, false);
      assert.equal(unread.value.anchor.funded.scaleOk, null, 'not knowable, which is not the same as false');
      // The runway is still a number, because the money that pays for a day anchor
      // is the fee balance and the cost is quoted in the same units: the half that
      // mangled is the token one, and what it was supposed to prove — that the two
      // readings name the same money — is reported as `scaleOk: null` above rather
      // than being smuggled into the division. "No balance was read at all" is a
      // different sentence and is locked by the test that loads a refused ledger.
      assert.equal(unread.value.anchor.runway.unknown, null);
      assert.equal(unread.value.anchor.runway.anchors, 1638, 'the readable half still carries the runway');
      // The cost survives both failures, because it belongs to a day rather than to
      // a read: it is the newest receipt, whichever day that was.
      assert.equal(unread.value.anchor.lastCost.feeUnits, DIGEST_COST_UNITS.toString());
      assert.equal(unread.value.anchor.lastCost.day, 2);
      assert.equal(unread.value.stale, null, 'a signal this fresh cannot be stale');
    });
  } finally {
    rpc.close();
  }
});

test('a stored economics object that no longer means what it claims is refused out loud', async () => {
  const m = memStore();
  const health = createHealth();
  // A balance that arrived as a JSON number: every comparison downstream would
  // throw inside the health route, which is the worst place in the build for it.
  m.seedAnchor({ ...newAnchorEcon(1_700_000_000_000), sales: 9, revenueUnits: '9000', balanceUnits: 42 as unknown as string });
  const app = createApp({ seed: 1, store: m.store, health, ...offlineFeeds });
  const { value: body, errors } = await quiet(() => readHealth(app));
  assert.equal(body.signals?.counts.anchor_econ_rejected, 1);
  assert.match(healthDetail(body, 'anchor_econ_rejected'), /balanceUnits is not a decimal integer string/);
  assert.ok(errors.some((e) => /stored anchor economics refused/.test(e)));
  assert.match(body.problem ?? '', /anchor_econ_rejected=1/);
  // Refused rather than repaired: the nine sales go with it, which is exactly why
  // the refusal is counted, and the funding figures start over as never-read.
  assert.equal(body.anchor.readAt, 0, 'never read, which is not the same as zero');
  assert.equal(body.anchor.revenue.sales, 0);
  assert.equal(body.anchor.funded.feeUnits, null);
  assert.equal(body.anchor.runway.anchors, null);
  assert.match(body.anchor.runway.unknown ?? '', /balance not read/);
});




