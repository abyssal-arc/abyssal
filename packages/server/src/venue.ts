/**
 * Which rail a USDC movement travelled on.
 *
 * The feed used to ask one question about every transfer — "did somebody other
 * than the payer submit this transaction?" — and called a yes an x402 payment.
 * On Arc that question is mostly about account abstraction and DEX routing, not
 * about machines paying machines. A swap moves USDC out of a pool contract, so
 * the submitter is never the `from` of the Transfer log, and every internal leg
 * of every swap answered yes. Measured against mainnet, the heuristic flagged
 * two thirds of all flows as x402, and in 129 of 134 flagged flows the payer
 * turned out to be a contract — which cannot be an x402 payer, because an x402
 * payer is the party whose signature authorized the movement.
 *
 * The rail is a fact rather than an inference: it is the contract the
 * transaction called and the method it called. x402 settles USDC through
 * EIP-3009, where the payer signs an authorization off-chain and a facilitator
 * submits it, so a genuine machine payment is a transaction addressed to the
 * USDC token itself carrying `transferWithAuthorization`. Nothing else on Arc
 * looks like that.
 *
 * Every selector and address below was read off mainnet or confirmed against
 * the 4byte directory rather than recalled. Anything not catalogued falls
 * through to `contract` with its bare address as the label: an unnamed venue is
 * honest, a guessed one is not.
 */

export type VenueKind = 'x402' | 'swap' | 'aa' | 'direct' | 'contract' | 'unknown';

/** Stable iteration order for tallies and for anything that renders them. */
export const VENUE_KINDS: readonly VenueKind[] = ['x402', 'swap', 'aa', 'direct', 'contract', 'unknown'];

export interface VenueInfo {
  kind: VenueKind;
  /** Registry name when the venue is catalogued; otherwise the bare address. */
  label: string;
}

/** Per-kind counts. Kept as a total record so a missing kind is a type error. */
export type VenueTally = Record<VenueKind, number>;

/**
 * Labels for the two venues whose address is the token itself, where the
 * address cannot distinguish them and only the method can. Exported so a caller
 * aggregating flows into rows can label them without restating the strings.
 */
export const X402_LABEL = 'x402 (EIP-3009 authorization)';
export const DIRECT_LABEL = 'direct USDC transfer';
/**
 * A transaction with no destination at all. Shared by both labelling paths
 * because there is no address to fall back on here, and the two must not
 * describe the same row differently.
 */
export const CREATION_LABEL = 'contract creation';

export function emptyTally(): VenueTally {
  return { x402: 0, swap: 0, aa: 0, direct: 0, contract: 0, unknown: 0 };
}

/**
 * EIP-3009 gasless transfer authorizations. Both spellings, because either
 * party can be the one to submit: the payer's side calls `transferWith...`, a
 * receiver accepting an authorization it was handed calls `receiveWith...`.
 */
const SEL_X402 = new Set([
  '0xe3ee160e', // transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
  '0xef55bec6', // receiveWithAuthorization(...)
]);

/**
 * ERC-4337 bundling. Deliberately NOT counted as x402: a bundled userOp could
 * be an authorization settlement, but telling that apart needs internal traces
 * we do not fetch, and guessing is how the old heuristic got it wrong. This
 * makes the reported x402 share a floor rather than an estimate.
 */
const SEL_AA = new Set([
  '0x765e827f', // handleOps(PackedUserOperation[],address)
]);

/**
 * DEX entry points. Used as a fallback for routers that are not catalogued by
 * address yet, which on a chain six days old means most of them.
 *
 * `multicall(uint256,bytes[])` is pointedly absent: it is a wrapper whose real
 * action lives in calldata we do not decode, so classifying it as a swap would
 * be an inference dressed as an observation.
 */
const SEL_SWAP = new Set([
  '0x3593564c', // execute(bytes,bytes[],uint256)  — Universal Router
  '0x24856bc3', // execute(bytes,bytes[])
  '0x04e45aaf', // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  '0x414bf389', // exactInputSingle((...,bytes))
  '0xdb3e2198', // exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
  '0x4d819a2a', // swap((uint8,address,address,address,uint24,int24,address,bytes,address,bytes32)[],...)
  '0x0c307f76', // dagSwapTo(uint256,address,(uint256,address,uint256,uint256,uint256),(...)[])
  '0x38ed1739', // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
]);

/**
 * Catalogued Arc mainnet venues, each confirmed by code size, selector and
 * caller distribution on 2026-09-22. An address entry outranks a selector
 * match: knowing which contract this is beats recognizing the shape of its
 * calldata.
 */
const VENUES: Record<string, VenueInfo> = {
  // The canonical ERC-4337 v0.7 deployment address, 16 KB of code, reached by
  // half a dozen distinct bundlers.
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { kind: 'aa', label: 'ERC-4337 EntryPoint v0.7' },
  // 24.5 KB, called by 72 distinct wallets in 200 blocks — the busiest single
  // venue on the chain, and by a wide margin.
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1': { kind: 'swap', label: 'Uniswap Universal Router' },
  '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77': { kind: 'swap', label: 'Uniswap V3 SwapRouter' },
  // ~750 bytes each and reached by dozens of different wallets through one
  // `swap(...)` selector whose tuple carries a fee and a tick spacing — the
  // shape of a V4-style action router fronted by a proxy. The proxy is the
  // reason the label hedges: the implementation behind it is not on-chain
  // anywhere we can read.
  '0x53dea4f7783c1de84cecc5c989bc37a557154827': { kind: 'swap', label: 'swap router (V4-style proxy)' },
  '0x40fe100d34b6a552d49ad8cc252795ccead48277': { kind: 'swap', label: 'swap router (V4-style proxy)' },
  '0x4e3bcce28caf98a143fd8bd9e4875ccab3e7bbe0': { kind: 'swap', label: 'DAG swap aggregator' },
};

/**
 * Classify one transaction by the contract it called and the method it called.
 *
 * `to` is null for a contract-creation transaction, which cannot itself be a
 * venue but can still emit USDC transfers from its constructor; those are
 * `unknown` rather than being folded into `contract`, because there is no
 * address to point a viewer at.
 */
export function classifyVenue(
  usdc: string,
  to: string | null | undefined,
  selector: string | null | undefined,
): VenueInfo {
  const addr = (to ?? '').toLowerCase();
  const sel = (selector ?? '').toLowerCase();
  if (!addr) return { kind: 'unknown', label: CREATION_LABEL };

  // A call addressed to the token itself. Checked before the registry so that
  // the USDC contract can never be catalogued into something else, and before
  // the selector sets so that `transferWithAuthorization` is read as the
  // settlement it is rather than as a generic token method.
  if (addr === usdc.toLowerCase()) {
    return SEL_X402.has(sel)
      ? { kind: 'x402', label: X402_LABEL }
      : { kind: 'direct', label: DIRECT_LABEL };
  }

  const known = VENUES[addr];
  if (known) return known;
  if (SEL_AA.has(sel)) return { kind: 'aa', label: addr };
  if (SEL_SWAP.has(sel)) return { kind: 'swap', label: addr };
  return { kind: 'contract', label: addr };
}

/**
 * Label a venue that has already been classified, for callers that aggregate
 * many flows into one row and kept the kind and address rather than the label.
 *
 * The kind is not redundant here: for `x402` and `direct` the address is the
 * token itself, so it cannot tell the two apart and the method that decided
 * between them is no longer at hand.
 *
 * A null address is checked before that pair rather than after it. Only a
 * contract creation produces one, and letting it fall through to the
 * token-address branch would label the row a direct USDC transfer — a specific
 * claim about a transaction whose destination was never there to read.
 */
export function labelVenue(usdc: string, kind: VenueKind, addr: string | null): string {
  const a = (addr ?? '').toLowerCase();
  if (!a) return CREATION_LABEL;
  if (a !== usdc.toLowerCase()) return VENUES[a]?.label ?? a;
  return kind === 'x402' ? X402_LABEL : DIRECT_LABEL;
}
