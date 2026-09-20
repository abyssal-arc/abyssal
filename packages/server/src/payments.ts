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

export type InterventionType = 'feed' | 'poison' | 'bloom' | 'drought';

/** The one network this build targets. */
export const NETWORK = 'arc';
export const CHAIN_ID = 5042;
export const NETWORK_ID = `eip155:${CHAIN_ID}`;

/** ERC-20 Transfer(address,address,uint256) topic hash. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The zero address: `to` of a burn, per ERC-20 convention. */
export const BURN_SINK = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** ABYS prices per intervention, whole tokens (6 decimals on-chain). */
export const ABYS_PRICES: Record<InterventionType, string> = {
  feed: '50000',
  poison: '100000',
  bloom: '200000',
  drought: '200000',
};

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

export function burnOffer(type: InterventionType): BurnOffer {
  return {
    scheme: 'exact',
    settle: 'burn',
    network: NETWORK_ID,
    chainId: CHAIN_ID,
    asset: tokenAddress() as string,
    amount: String(BigInt(Math.round(Number(ABYS_PRICES[type]) * 1_000_000))),
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
 * Hashes of burn receipts already accepted. In-memory on purpose: a restart
 * clears it, and the only thing a replayed old hash can buy is one extra
 * intervention at a price the payer already burned for, which the amount check
 * below still has to pass against the offer they present.
 */
const usedReceipts = new Set<string>();

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
  const token = offer.asset.toLowerCase();
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== token) continue;
    const topics = log.topics ?? [];
    if (topics[0] !== TRANSFER_TOPIC) continue;
    if (String(topics[2]).toLowerCase() !== BURN_SINK) continue;
    const value = BigInt(log.data ?? '0x0');
    if (value < BigInt(offer.amount)) continue;
    usedReceipts.add(key);
    return { ok: true, payer: `0x${String(topics[1]).slice(-40)}`.toLowerCase() };
  }
  return { ok: false, reason: 'no burn of the asked amount in this transaction' };
}
