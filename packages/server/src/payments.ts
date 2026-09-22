/**
 * Payment gating for interventions: the visitor burns ABYS and proves it.
 *
 * There is no seller key and no facilitator in this path. The buyer calls
 * `burn(amount)` on the ABYS token from their wallet, then retries with the
 * transaction hash; we fetch that receipt and accept the intervention only if
 * it contains an ABYS `Transfer` to the zero address (the ERC-20 burn event)
 * for at least the asked amount. Money leaves circulation instead of moving to
 * a treasury, so nobody has to custody it and nobody can lose it.
 *
 * The token address comes from ABYS_TOKEN_ADDRESS; until it is set there is
 * nothing to burn and /intervene answers 503.
 *
 * All env reads happen per call (never at module load) because dev.ts sets the
 * environment after the imports are evaluated.
 */

export type InterventionType =
  | 'feed' | 'poison' | 'bloom' | 'drought' | 'pass'
  | 'name' | 'wish' | 'mutate' | 'ark';

/** The one network this build targets. */
export const NETWORK = 'arc';
export const CHAIN_ID = 5042;
export const NETWORK_ID = `eip155:${CHAIN_ID}`;

/** ERC-20 Transfer(address,address,uint256) topic hash. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The zero address: `to` of a burn, per ERC-20 convention. */
export const BURN_SINK = '0x0000000000000000000000000000000000000000000000000000000000000000';
/** Blackhole address: transferring here is the other burn convention. */
export const DEAD_SINK = '0x000000000000000000000000000000000000000000000000000000000000dead';
/** Both conventions count as burning: contract burn() and blackhole transfer. */
const SINKS = new Set([BURN_SINK, DEAD_SINK]);

/**
 * Where used receipts live. Memory alone loses them on an isolate restart, so
 * the node adapter and the Durable Object each plug a durable backend in;
 * recording happens only after the paid action succeeded (see handler).
 */
export interface BurnLedger {
  load(): Promise<string[]>;
  add(hash: string): void;
}
let ledger: BurnLedger | null = null;
const usedReceipts = new Set<string>();

export function setBurnLedger(next: BurnLedger): void {
  ledger = next;
}
export async function hydrateReceipts(): Promise<void> {
  if (!ledger) return;
  for (const h of await ledger.load()) usedReceipts.add(h);
}
export function isBurnRecorded(hash: string): boolean {
  return usedReceipts.has(hash);
}
export function recordBurnReceipt(hash: string): void {
  usedReceipts.add(hash);
  ledger?.add(hash);
}

/** ABYS prices per intervention, in whole tokens; base units come from the token's decimals(). */
export const ABYS_PRICES: Record<InterventionType, string> = {
  feed: '100000',
  poison: '150000',
  bloom: '200000',
  drought: '200000',
  pass: '5000',
  name: '50000',
  wish: '25000',
  mutate: '100000',
  ark: '75000',
};

/**
 * Naming a legend — a creature old or bloody enough to have become a character
 * — costs ten times the base price. The sim owns the threshold (isLegendary);
 * this is only what that verdict is worth, derived from the base price so the
 * two can never drift apart.
 */
export const ABYS_PRICE_LEGENDARY_NAME = String(Number(ABYS_PRICES.name) * 10);

/** The whole-token price of one action, legendary naming included. */
export function priceWhole(type: InterventionType, legendary = false): string {
  return type === 'name' && legendary ? ABYS_PRICE_LEGENDARY_NAME : ABYS_PRICES[type];
}

/** Null until the operator deploys ABYS and exports ABYS_TOKEN_ADDRESS. */
export function tokenAddress(): string | null {
  const a = process.env.ABYS_TOKEN_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}

export function explorerTxUrl(): string {
  return process.env.EXPLORER_TX_URL ?? 'https://explorer.arc.io/tx/';
}

export interface BurnOffer {
  scheme: 'exact';
  /** How the payment is proven: a burn receipt on `network`. */
  settle: 'burn';
  network: typeof NETWORK_ID;
  chainId: typeof CHAIN_ID;
  /** ABYS contract the burn must happen in. */
  asset: string;
  /** Base units (whole tokens x 1e6). */
  amount: string;
}

let metaCache: { address: string; decimals: number; at: number } | null = null;
/**
 * Address plus decimals of the payment token, read from the chain and cached
 * for five minutes. Assuming a fixed decimals would let someone burn a dust
 * fraction and pass a whole-token check, so an unreadable token fails closed.
 */
export async function tokenMeta(
  rpcUrl: string,
  override?: string | null,
): Promise<{ address: string; decimals: number } | null> {
  const address = (override ?? process.env.ABYS_TOKEN_ADDRESS ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  if (metaCache && metaCache.address === address && Date.now() - metaCache.at < 300_000) {
    return metaCache;
  }
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] }),
    });
    const hex = ((await res.json()) as { result?: string }).result;
    if (typeof hex !== 'string') return null;
    const decimals = parseInt(hex, 16);
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 36) return null;
    metaCache = { address, decimals, at: Date.now() };
    return metaCache;
  } catch {
    return null;
  }
}

export async function burnOffer(
  rpcUrl: string,
  type: InterventionType,
  override?: string | null,
  whole?: string,
): Promise<BurnOffer | null> {
  const meta = await tokenMeta(rpcUrl, override);
  if (!meta) return null;
  return {
    scheme: 'exact',
    settle: 'burn',
    network: NETWORK_ID,
    chainId: CHAIN_ID,
    asset: meta.address,
    amount: String(BigInt(whole ?? ABYS_PRICES[type]) * 10n ** BigInt(meta.decimals)),
  };
}

export interface BurnVerdict {
  ok: boolean;
  payer?: string;
  reason?: string;
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? 'rpc error');
  return json.result;
}

/**
 * Accept a payment iff `txHash` is a successful transaction whose logs contain
 * an ABYS burn (Transfer to the zero address) of at least `offer.amount`.
 * Returns who burned, so the response can name the payer.
 */
export async function verifyBurnReceipt(
  rpcUrl: string,
  offer: BurnOffer,
  txHash: string,
): Promise<BurnVerdict> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: 'bad tx hash' };
  const key = txHash.toLowerCase();
  if (usedReceipts.has(key)) return { ok: false, reason: 'receipt already used' };
  let receipt: any;
  try {
    receipt = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
  } catch {
    return { ok: false, reason: 'receipt lookup failed' };
  }
  if (!receipt) return { ok: false, reason: 'receipt not found' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'transaction reverted' };
  // A receipt that is not final yet must not be spendable: wait for at least
  // one confirmation so a reorged payment can never buy an intervention.
  const head = await rpcCall(rpcUrl, 'eth_blockNumber', []);
  const latest = typeof head === 'string' ? parseInt(head, 16) : NaN;
  const at = typeof receipt.blockNumber === 'string' ? parseInt(receipt.blockNumber, 16) : NaN;
  if (!Number.isFinite(latest) || !Number.isFinite(at) || latest - at < 1) {
    return { ok: false, reason: 'receipt pending' };
  }
  const token = offer.asset.toLowerCase();
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== token) continue;
    const topics = log.topics ?? [];
    if (topics[0] !== TRANSFER_TOPIC) continue;
    if (!SINKS.has(String(topics[2]).toLowerCase())) continue;
    const value = BigInt(log.data ?? '0x0');
    if (value < BigInt(offer.amount)) continue;
    // Recording happens in the handler, after the paid action succeeded.
    return { ok: true, payer: `0x${String(topics[1]).slice(-40)}`.toLowerCase() };
  }
  return { ok: false, reason: 'no burn of the asked amount in this transaction' };
}
