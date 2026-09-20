/**
 * x402-compatible HTTP 402 payment gating for interventions.
 *
 * Single network: Arc mainnet (Circle L1), chainId 5042, USDC gas, native x402.
 * Dual pricing, USDC at list price, or ABYS at a ~30% discount (TOKEN_PLAN.md
 * §7). Real settlement goes through Circle's Facilitator Service when a seller
 * key is configured (see facilitator.ts); without one the server refuses to sell.
 *
 * All env reads happen per call (never at module load) because dev.ts sets the
 * environment after the imports are evaluated.
 */

export type InterventionType = 'feed' | 'poison' | 'bloom' | 'drought';

/** The one network this build targets. */
export const NETWORK = 'arc';
export const CHAIN_ID = 5042;

/** Native USDC on Arc mainnet (6 decimals). */
export const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

/** Placeholder treasury address; replace with the real multisig before mainnet. */
export const PAY_TO = '0x0000000000000000000000000000000000000000';

/**
 * ABYS ERC-20 contract address. `null` until the token is deployed;
 * the 402 payload carries whatever is configured so clients can build the
 * transfer once it exists.
 */
export const TOKEN_ADDRESS: string | null = null;

export interface PaymentRequirement {
  scheme: 'x402';
  network: typeof NETWORK;
  chainId: number;
  asset: 'ABYSSAL' | 'USDC';
  tokenAddress: string | null;
  amount: string;
  payTo: string;
}

export function explorerTxUrl(): string {
  return process.env.EXPLORER_TX_URL ?? 'https://explorer.arc.io/tx/';
}

/** ABYS prices on Arc (TOKEN_PLAN.md §7: the USDC list price minus ~30%). */
export const ABYS_PRICES: Record<InterventionType, string> = {
  feed: '35',
  poison: '70',
  bloom: '175',
  drought: '175',
};

/** USDC list prices on Arc (whole USDC). */
export const PRICES_USDC: Record<InterventionType, string> = {
  feed: '0.05',
  poison: '0.1',
  bloom: '0.25',
  drought: '0.25',
};

/**
 * The 402 `accepts` list for an intervention: USDC at list price first,
 * discounted ABYS second, the client picks either offer.
 */
export function acceptsFor(type: InterventionType): PaymentRequirement[] {
  const abys: PaymentRequirement = {
    scheme: 'x402',
    network: NETWORK,
    chainId: CHAIN_ID,
    asset: 'ABYSSAL',
    tokenAddress: TOKEN_ADDRESS,
    amount: ABYS_PRICES[type],
    payTo: PAY_TO,
  };
  return [
    {
      ...abys,
      asset: 'USDC',
      tokenAddress: ARC_USDC_ADDRESS,
      amount: PRICES_USDC[type],
    },
    abys,
  ];
}
