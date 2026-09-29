#!/usr/bin/env node
/**
 * A copy-paste buyer for the paid data tier — in one file, with no build step.
 *
 * Where `tools/x402-buyer-example.mjs` is a demo that runs inside this repository
 * (it imports the compiled `packages/server/dist` client), THIS file is written to
 * be lifted out and dropped into your own project. It depends on one thing the
 * README tells you to install — `npm i viem` — and otherwise uses only `fetch` and
 * a wallet key. You do not build Abyssal to read it, and you do not import Abyssal
 * to run it.
 *
 * That freedom has a price: it is a second copy of the signing logic, which is the
 * classic way an example rots. So it is pinned two ways by `packages/server/test`
 * rather than trusted:
 *   - the envelope it builds is compared field-for-field against the real
 *     `x402-client.ts` the server test settles with, so the two cannot drift; and
 *   - it is run through the actual `/data/flows` handler against a stub facilitator
 *     and must reach 200, so the copy is proven to buy, not merely to look right.
 *
 * Run it directly against a live server:
 *   node examples/buy-flows.mjs --url https://www.abyssal-arc.com --limit 5
 * With no key it only asks the unpaid question and prints the seller's offer. To
 * actually receive rows you need BUYER_PRIVATE_KEY for an Arc mainnet wallet
 * (chainId 5042) holding USDC — the tier settles that to the seller through the
 * facilitator and answers 200. Off Arc, or with no seller configured, the honest
 * answer is 503 and this says so instead of pretending.
 *
 * What this does NOT claim: that anyone has bought a read. The 200 is proven
 * against the real route with a stub facilitator, not against a live Circle settle.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';

// globalThis.crypto covers Node >=19 and Workers; the fallback is the only path
// that touches node:crypto, so this stays a plain module on any modern runtime.
const rand = globalThis.crypto ?? (await import('node:crypto')).webcrypto;

const DEFAULT_VALIDITY_SECONDS = 600;

/** `eip155:5042` -> 5042. Refuse anything else rather than sign the wrong chain. */
export function chainIdFromNetwork(network) {
  const m = /^eip155:(\d+)$/.exec(String(network ?? '').trim());
  if (!m) throw new TypeError(`not an eip155 network identifier: ${JSON.stringify(network)}`);
  return Number(m[1]);
}

function randomNonce() {
  return `0x${Buffer.from(rand.getRandomValues(new Uint8Array(32))).toString('hex')}`;
}

/**
 * The base64url `X-Payment` header for one EIP-3009 `transferWithAuthorization`.
 * Every signed value (amount, destination, chain, asset, and the USDC/2 domain) is
 * read off `requirement` — the seller's live `accepts[0]` — never from a constant.
 */
export async function buildPaymentHeader(input) {
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
      verifyingContract: requirement.asset,
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
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
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

/**
 * Ask for `path`, and if the seller answers 402 with an offer, sign that offer and
 * ask again with the payment attached. Any other status is returned untouched — a
 * 503 (not for sale) or a 400 (a bad filter) is not something you sign your way
 * out of, and no second request is made without a wallet.
 */
export async function buyFlows(options) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const path = options.path ?? '/data/flows';
  const qs = new URLSearchParams(
    Object.entries(options.query ?? {}).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${base}${path}${qs ? `?${qs}` : ''}`;
  const doFetch = options.fetchImpl ?? fetch;
  const asJson = async (res) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  const first = await doFetch(url);
  const firstBody = await asJson(first);
  if (first.status !== 402) {
    return {
      status: first.status,
      ok: first.status >= 200 && first.status < 300,
      paid: false,
      requirement: null,
      json: firstBody,
    };
  }

  const requirement = (firstBody?.accepts ?? [])[0] ?? null;
  const account =
    options.account ??
    (options.privateKey ? privateKeyToAccount(options.privateKey) : null);
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
  const paidBody = await asJson(paid);
  return {
    status: paid.status,
    ok: paid.status >= 200 && paid.status < 300,
    paid: true,
    requirement,
    json: paidBody,
  };
}

// --- CLI: runs only when this file is invoked directly, never on import. ---
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const baseUrl = arg('url', process.env.ABYSSAL_URL ?? 'https://www.abyssal-arc.com');
  const privateKey = process.env.BUYER_PRIVATE_KEY ?? arg('key', undefined);
  const query = {};
  for (const k of ['addr', 'venue', 'blockFrom', 'blockTo', 'from', 'to', 'limit']) {
    const v = arg(k, undefined);
    if (v !== undefined) query[k] = v;
  }

  console.log(
    `GET ${baseUrl}/data/flows ${JSON.stringify(query)} — ` +
      (privateKey ? 'with a buyer key, so it will try to pay' : 'with no key, so it stops at the quote'),
  );
  const result = await buyFlows({ baseUrl, privateKey, query });

  if (result.status === 503) {
    console.log(`\nNot for sale right now (503): ${JSON.stringify(result.json)}`);
    console.log('The tier opens only with a seller key configured; off Arc it stays closed.');
  } else if (!result.paid && result.status === 402) {
    console.log('\nQuote received, nothing paid. This is the offer a buyer would sign:');
    console.log(JSON.stringify(result.requirement, null, 2));
    console.log('\nSet BUYER_PRIVATE_KEY (an Arc wallet holding USDC) and rerun to settle and read.');
  } else if (result.ok) {
    const b = result.json;
    console.log(`\n200 — data received. matched=${b?.matched} retained=${b?.retained}`);
    console.log(`settlement tx: ${b?.settlement?.tx} (payer ${b?.settlement?.payer})`);
    for (const f of (b?.flows ?? []).slice(0, 5)) {
      console.log(`  block ${f.block}  ${f.from} -> ${f.to}  ${f.amount} USDC  venue=${f.venue ?? '-'}`);
    }
  } else {
    console.log(`\n${result.status} after paying — the seller did not accept the settlement:`);
    console.log(JSON.stringify(result.json));
  }
}
