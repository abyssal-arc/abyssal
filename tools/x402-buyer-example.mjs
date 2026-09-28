#!/usr/bin/env node
/**
 * A buyer's end-to-end call to the paid data tier, in one runnable file.
 *
 * This is deliberately NOT a second implementation of the payment. It imports
 * the same `buyFlows` the README's "how to pay" recipe describes and the server
 * test settles against, so what you can run here is exactly what is proven to
 * work — an example maintained separately from the code it demonstrates is how
 * examples rot.
 *
 *   npm run build                              # compile the package once
 *   node tools/x402-buyer-example.mjs \
 *     --url https://www.abyssal-arc.com \
 *     --addr 0x… --limit 5
 *
 * Without a wallet key it still does something useful: it makes the unpaid
 * request and prints the seller's quote, so you can see the price and the exact
 * offer you would sign without spending anything. To actually receive data you
 * need a `BUYER_PRIVATE_KEY` whose account holds USDC on Arc mainnet (chainId
 * 5042) — the tier then settles that USDC to the seller through Circle and
 * answers 200. Off Arc, or with no seller configured, the honest answer is 503
 * and this script says so rather than pretending.
 */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const baseUrl = arg('url', process.env.ABYSSAL_URL ?? 'https://www.abyssal-arc.com');
const privateKey = process.env.BUYER_PRIVATE_KEY ?? arg('key', undefined);

// Only forward filters that were actually given, so the query stays honest about
// what the caller asked for rather than sending empty strings the route must reject.
const query = {};
for (const k of ['addr', 'venue', 'blockFrom', 'blockTo', 'from', 'to', 'limit']) {
  const v = arg(k, undefined);
  if (v !== undefined) query[k] = v;
}

let buyFlows;
try {
  ({ buyFlows } = await import('../packages/server/dist/src/x402-client.js'));
} catch {
  console.error(
    'Could not load the built client. Run `npm run build` first so packages/server/dist exists.',
  );
  process.exit(1);
}

const paid = privateKey ? 'with a buyer key, so it will try to pay' : 'with no key, so it stops at the quote';
console.log(`GET ${baseUrl}/data/flows ${JSON.stringify(query)} — ${paid}`);

const result = await buyFlows({ baseUrl, privateKey, query });

if (result.status === 503) {
  console.log(`\nNot for sale right now (${result.status}): ${JSON.stringify(result.json)}`);
  console.log('The data tier opens only when the seller key is configured on the server; off-Arc it stays closed.');
} else if (!result.paid && result.status === 402) {
  console.log('\nQuote received, nothing paid. This is the offer a buyer would sign:');
  console.log(JSON.stringify(result.requirement, null, 2));
  console.log('\nSet BUYER_PRIVATE_KEY (an Arc mainnet wallet holding USDC) and rerun to settle it and read the data.');
} else if (result.ok) {
  const body = result.json;
  console.log(`\n200 — data received. matched=${body?.matched} retained=${body?.retained}`);
  console.log(`settlement tx: ${body?.settlement?.tx} (payer ${body?.settlement?.payer})`);
  for (const flow of (body?.flows ?? []).slice(0, 5)) {
    console.log(`  block ${flow.block}  ${flow.from} -> ${flow.to}  ${flow.amount} USDC  venue=${flow.venue ?? '-'}`);
  }
} else {
  console.log(`\n${result.status} after paying — the seller did not accept the settlement:`);
  console.log(JSON.stringify(result.json));
  console.log('A 402 here means the facilitator refused the authorization (wrong chain, no USDC balance, or expired).');
}
