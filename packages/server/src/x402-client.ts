/**
 * The buyer's half of the paid data tier: `GET /data/flows` and `GET /data/history`.
 *
 * `facilitator.ts` is the seller: it quotes a price and settles whatever a
 * wallet signed. This file is the code a *customer* runs, and nothing in it is
 * privileged — no seller key, no facilitator credential, no state. It is `fetch`
 * plus one EIP-3009 signature, which is the whole of what x402 asks of a buyer.
 *
 * It ships in the same package as the route it talks to, rather than living only
 * inside the test that helped the seller check itself, for one reason: the
 * README prints a "how to pay" recipe, and a recipe whose only executable copy is
 * an in-test helper is how documentation and reality drift apart. Here the
 * documented steps, the runnable examples in `tools/` and `examples/`, and the
 * round-trip test all call this one implementation, so a change that breaks a
 * buyer breaks a test instead of quietly breaking whoever trusted the document.
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { ExactRequirement } from './facilitator.js';

// Node has exposed webcrypto globally since v19 and Workers always have it; the
// dynamic import only runs on a runtime that lacks both, so it never executes
// where node:crypto does not exist. Same arrangement as facilitator.ts.
const rand: { getRandomValues(b: Uint8Array): Uint8Array } =
  globalThis.crypto ?? (await import('node:crypto')).webcrypto;

/** The minimum the seller needs a buyer to sign, as a callable surface. */
type SigningAccount = ReturnType<typeof privateKeyToAccount>;

/** How long an authorization is offered for, in seconds, when a caller does not say. */
const DEFAULT_VALIDITY_SECONDS = 600;

/** The resource description that goes into the envelope; informational, echoed back by the facilitator. */
export interface X402Resource {
  url: string;
  description?: string;
  mimeType?: string;
}

/**
 * `eip155:5042` -> 5042.
 *
 * A wrong chain does not fail loudly: the signature is well-formed, recovers to
 * the right address, and simply authorizes a transfer on a chain where the
 * seller's `payTo` holds no balance, so the facilitator answers with an opaque
 * settlement failure and the reader debugs a signature that was fine. Throwing
 * on anything that is not `eip155:<digits>` puts the error where the mistake is.
 */
export function chainIdFromNetwork(network: string): number {
  const m = /^eip155:(\d+)$/.exec(String(network ?? '').trim());
  if (!m) throw new TypeError(`not an eip155 network identifier: ${JSON.stringify(network)}`);
  return Number(m[1]);
}

/** A fresh 32-byte authorization nonce, hex-encoded, unless the caller supplies one. */
function randomNonce(): string {
  return `0x${Buffer.from(rand.getRandomValues(new Uint8Array(32))).toString('hex')}`;
}

export interface PaymentHeaderInput {
  /** The offer the seller put in `accepts[0]` — the buyer signs against this, not a remembered copy. */
  requirement: ExactRequirement;
  /** The wallet paying: supplies `from` and the EIP-712 signature. */
  account: SigningAccount;
  /** 32-byte hex nonce; a fresh one when omitted. Reusing one spends the same authorization twice. */
  nonce?: string;
  /** Authorization expiry in unix seconds; `now + 600` when omitted. */
  validBefore?: string;
  /** What is being bought, for the facilitator's receipt. */
  resource?: X402Resource;
}

/**
 * The base64url `X-Payment` header carrying one EIP-3009 `transferWithAuthorization`
 * for the exact amount on offer, signed by `account`.
 *
 * Every value the signature covers is read off `requirement` — the amount, the
 * destination, the chain, the asset, and the `USDC`/`2` EIP-712 domain come from
 * the seller's own quote, never from a constant here. That is the point: a buyer
 * who hard-codes a price is a buyer whose integration breaks the day the price
 * moves, while a buyer who signs the quote adapts for free. The envelope shape
 * (`{ x402Version, resource, accepted, payload: { signature, authorization } }`)
 * is exactly what `readPayment` in facilitator.ts decodes on the other side.
 */
export async function buildPaymentHeader(input: PaymentHeaderInput): Promise<string> {
  const { requirement, account } = input;
  const chainId = chainIdFromNetwork(requirement.network);
  const authorization = {
    from: account.address,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter: '0',
    validBefore:
      input.validBefore ?? String(Math.floor(Date.now() / 1000) + DEFAULT_VALIDITY_SECONDS),
    nonce: input.nonce ?? randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: {
      name: String(requirement.extra.name),
      version: String(requirement.extra.version),
      chainId,
      verifyingContract: requirement.asset as `0x${string}`,
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
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  });
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: input.resource ?? {
        url: '',
        description: 'Abyssal paid data tier',
        mimeType: 'application/json',
      },
      accepted: requirement,
      payload: { signature, authorization },
    }),
  ).toString('base64url');
}

export interface BuyOptions {
  /** Server origin, e.g. `https://www.abyssal-arc.com`. No trailing path. */
  baseUrl: string;
  /** Hex private key for the buyer wallet. Without it the call stops at the quote. */
  privateKey?: string;
  /** Route to buy; defaults to the tier each helper is named for (`/data/flows`, `/data/history`). */
  path?: string;
  /** Query filters passed straight through to the route (addr, venue, blockFrom, limit, ...). */
  query?: Record<string, string | number>;
  /** Override the signing wallet (mutually exclusive with `privateKey`). */
  account?: SigningAccount;
  /** Bring your own `fetch`; a test hands the app's own `fetch` to settle in-process. */
  fetchImpl?: typeof fetch;
  /** Force an authorization nonce instead of drawing a random one. */
  nonce?: string;
  /** Authorization expiry in unix seconds. */
  validBefore?: string;
}

export interface BuyResult {
  /** Status of the final (paid, if it came to that) response. */
  status: number;
  ok: boolean;
  /** Whether a payment header was actually sent — false when a quote was never answered. */
  paid: boolean;
  /** The offer the seller made in `accepts[0]`, kept so a caller can see what it paid. */
  requirement: ExactRequirement | null;
  /**
   * Parsed body of the final response: an object for a JSON answer, an array of
   * lines for an NDJSON one (`/data/history`, manifest last), or `null` when the
   * body was neither.
   */
  json: unknown;
  /** A buyer-side reason the flow stopped before data, distinct from a server error. */
  error?: string;
}

/**
 * Turn a response body into the shape `BuyResult.json` reports, by content type:
 * newline-delimited JSON (the history download) becomes an array of parsed lines,
 * anything else is read as one JSON value. A non-JSON history line throws rather
 * than being skipped, because a silently dropped row is a download that quietly
 * stops being a complete record of the days it claims to cover.
 */
async function readBody(res: Response): Promise<unknown> {
  if (!(res.headers.get('content-type') ?? '').includes('ndjson')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  const text = await res.text();
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as unknown);
}

/**
 * The one quote→sign→retry loop both paid reads share.
 *
 * Ask without a payment; if the seller answers 402 with an offer, sign that offer
 * and ask again with the header attached. The order is the whole of the client: a
 * first request carries no payment, so the price is always read from the server's
 * live quote rather than assumed; only a `402` moves to signing. Every other status
 * is returned as-is — a `503` (the tier is not for sale), a `400` (a range no
 * payment can fix), or a `200` (nothing to pay) are all correct endings that must
 * not be papered over with a signature. And no second request is made without a
 * wallet: the honest outcome of "I want this but have no key" is the quote plus a
 * stated reason, not a crash. This never throws on a server status; it throws only
 * if the seller's 402 carried no parseable offer, which is a broken seller, not a
 * buyer mistake.
 */
async function runBuy(options: BuyOptions, defaultPath: string): Promise<BuyResult> {
  const base = options.baseUrl.replace(/\/+$/, '');
  const path = options.path ?? defaultPath;
  const qs = new URLSearchParams(
    Object.entries(options.query ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;
  const doFetch = options.fetchImpl ?? fetch;

  const first = await doFetch(url);
  const firstBody = await readBody(first);
  if (first.status !== 402) {
    return {
      status: first.status,
      ok: first.status >= 200 && first.status < 300,
      paid: false,
      requirement: null,
      json: firstBody,
    };
  }

  const requirement =
    ((firstBody as { accepts?: ExactRequirement[] } | null)?.accepts ?? [])[0] ?? null;

  const account = options.account ?? (options.privateKey ? privateKeyToAccount(options.privateKey as `0x${string}`) : null);
  if (!account) {
    return {
      status: 402,
      ok: false,
      paid: false,
      requirement,
      json: firstBody,
      error: 'no buyer key supplied: this is the quote only, and nothing was signed',
    };
  }
  if (!requirement) {
    throw new Error(`seller answered 402 without an offer in accepts[0]: ${JSON.stringify(firstBody)}`);
  }

  const header = await buildPaymentHeader({
    requirement,
    account,
    nonce: options.nonce,
    validBefore: options.validBefore,
    resource: { url, description: 'Abyssal paid data tier', mimeType: 'application/json' },
  });
  const paid = await doFetch(url, { headers: { 'x-payment': header } });
  const paidBody = await readBody(paid);
  return {
    status: paid.status,
    ok: paid.status >= 200 && paid.status < 300,
    paid: true,
    requirement,
    json: paidBody,
  };
}

/**
 * Buy one paid read of the flow ring (`GET /data/flows`). See `runBuy` for the
 * quote→sign→retry order, which is the whole of the client, and `buildPaymentHeader`
 * for the one place a signature is made.
 */
export async function buyFlows(options: BuyOptions): Promise<BuyResult> {
  return runBuy(options, '/data/flows');
}

/**
 * Buy one paid read of the day book (`GET /data/history`).
 *
 * Deliberately thin: it shares `runBuy`'s single quote→sign→retry loop and
 * `buildPaymentHeader`'s single signing core with `buyFlows`, so there is no second
 * copy of either to drift from the documented recipe. The one thing that differs is
 * the body, and `readBody` settles that by content type — the answer arrives as
 * newline-delimited JSON, so `json` is an array of day rows followed by a manifest.
 */
export async function buyHistory(options: BuyOptions): Promise<BuyResult> {
  return runBuy(options, '/data/history');
}
