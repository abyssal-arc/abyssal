/**
 * What the daily commitment costs, and how long it is funded for.
 *
 * The anchor is not free: committing one day of the tank was measured twice on
 * the deployed account — 30,440 gas for day 15 (`0xcc60e690…`) and 30,560 for day
 * 28 (`0x17d59a2f…`), each at about 20 gwei, so a day costs roughly 0.00062 of
 * the money — and gas on Arc is paid in the same money the site earns when a
 * machine buys a window of flow history: the `payTo` of `GET /data/flows` and the
 * signer of the daily digest are the same address. That loop is the honest
 * description of how this stays up, and until now the only way to check it was to
 * run the arithmetic by hand against an RPC and hope the reader trusted the
 * intermediate numbers. So they are computed here instead, in one place, and
 * published.
 *
 * Two things this module refuses to do:
 *
 *   - **No floating-point money.** Every quantity is a decimal string of integer
 *     units plus the scale it is denominated in. `0.001` rounded through a number
 *     is how a payment route quoted by the cent ended up writing zero, and a
 *     runway figure has the same shape: the account held 19.991420355 of the
 *     money against a measured 0.000617282 per day, which is 32,386 divisions of
 *     a number that cannot represent either operand exactly.
 *   - **No invented zero.** An unreadable balance, a missing receipt or a chain
 *     that reported no gas price yields `null` and a reason, never `0`. A runway
 *     of zero means the anchor is about to stop; a runway of zero because an RPC
 *     timed out means nothing at all, and the two must not be writable by the
 *     same expression.
 *
 * The scales are measured, not recalled. `eth_getBalance` and the USDC token's
 * `balanceOf` name the *same* money for one address — the fee layer speaks 18
 * decimals and the token contract speaks 6 — with the relation that the token
 * balance is the fee balance truncated at that boundary (see `unitScaleProblem`).
 * That relation is checked on every read rather than assumed, because the whole
 * module's arithmetic rests on it: a chain that changes how the two layers
 * relate changes what "funded" means.
 */

/** Decimals of the native fee unit, which is what `eth_getBalance` returns. */
export const ARC_FEE_DECIMALS = 18;

/** Decimals of the USDC contract, which is what `balanceOf` returns. */
export const USDC_TOKEN_DECIMALS = 6;

/** `10 ** (ARC_FEE_DECIMALS - USDC_TOKEN_DECIMALS)`: the ratio between them. */
export const ARC_UNIT_SCALE = 10n ** BigInt(ARC_FEE_DECIMALS - USDC_TOKEN_DECIMALS);

/**
 * Anchors below this remaining is an alarm rather than a fact.
 *
 * One anchor per world day, so this reads as ninety days of commitment. How long
 * that is in the real world was measured two ways on the deployed tank: 77
 * minutes from the tick rate over a 90-second sample, and 86.6 minutes between
 * two consecutive closes (day 27 at 07:35:11Z, day 28 at 09:01:45Z) — so ninety
 * anchors is somewhere between five and six days of operation. Generous on
 * purpose: the point is to be told while a top-up is a decision rather than an
 * emergency, and the counter that fires is edge-triggered so a low balance cannot
 * fill the ledger with repeats.
 */
export const RUNWAY_ALARM_ANCHORS = 90;

/** The number of days of commitment the chain said each anchor costs. */
export interface AnchorCost {
  /** Native fee units, as an integer decimal string. */
  units: string;
  /** `gasUsed` and `effectiveGasPrice` exactly as the receipt carried them. */
  gasUsed: string;
  gasPrice: string;
}

/** A `0x`-prefixed hex quantity, as an RPC returns for every gas and value field. */
const HEX_QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;

/** An integer in decimal, which is how every quantity below is stored. */
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * Sum of two decimal unit strings, or null when either is not one.
 *
 * Used for the revenue tally, where a lost increment would be a permanently
 * understated number: refusing the addition and leaving the old total standing is
 * recoverable, writing a float sum is not.
 */
export function addDecimalUnits(a: unknown, b: unknown): string | null {
  const x = decimalUnits(a);
  const y = decimalUnits(b);
  if (x === null || y === null) return null;
  return (BigInt(x) + BigInt(y)).toString();
}

/**
 * A JSON-safe amount: `null` for absent, a decimal string for a number.
 *
 * Stored as a string rather than a number because these quantities do not fit in
 * one: 19.99 native fee units is 1.9992e19 of them, past `Number.MAX_SAFE_INTEGER`,
 * and a snapshot that silently rounded a balance would round the runway computed
 * from it with the same error.
 */
export function decimalUnits(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL_INTEGER.test(value)) return null;
  return value;
}

/** An RPC hex quantity as a decimal string, or null when it is not one. */
export function hexToDecimalUnits(hex: unknown): string | null {
  if (typeof hex !== 'string' || !HEX_QUANTITY.test(hex)) return null;
  return BigInt(hex).toString();
}

/**
 * What a mined transaction cost, from its own receipt.
 *
 * `gasUsed × effectiveGasPrice`, both read off the receipt rather than estimated
 * before the send: the estimate is what you expected to pay and the receipt is
 * what you paid, and the difference between those two is precisely the thing a
 * funding runway should be computed from.
 */
export function txFeeUnits(
  receipt: { gasUsed?: unknown; effectiveGasPrice?: unknown; gasPrice?: unknown } | null,
): AnchorCost | null {
  const gasUsed = hexToDecimalUnits(receipt?.gasUsed);
  const gasPrice = hexToDecimalUnits(receipt?.effectiveGasPrice ?? receipt?.gasPrice);
  if (gasUsed === null || gasPrice === null) return null;
  return {
    units: (BigInt(gasUsed) * BigInt(gasPrice)).toString(),
    gasUsed: `0x${BigInt(gasUsed).toString(16)}`,
    gasPrice: `0x${BigInt(gasPrice).toString(16)}`,
  };
}

/**
 * Whether the fee balance and the token balance still name the same money.
 *
 * `null` when either side is unknown — an unread balance is not a broken scale.
 * Otherwise the rule is that the token balance is the fee balance **truncated to
 * six decimals**, because that is what the chain says: reading the anchor account
 * on 2026-09-24 gave `0x1156fcae4bf3247f0` native (19.991420355) and `0x1310b7c`
 * USDC (19.991420), and 19991420355000000000 / 1e12 is exactly 19991420 with a
 * remainder of 355,000,000,000. A check demanding `native === token × 1e12` is
 * therefore wrong rather than strict: the 18-decimal layer carries sub-USDC dust
 * that the 6-decimal layer cannot show, so equality would fire on the deployed
 * account as soon as it was tried — an alarm about nothing, which is the fastest
 * way to teach whoever reads `/health` to ignore it. What the quotient *does*
 * catch is the thing worth catching: the relationship between the two layers
 * moving, which turns the quotient into a number that is not the token balance.
 */
export function unitScaleProblem(nativeUnits: unknown, tokenUnits: unknown): string | null {
  const native = decimalUnits(nativeUnits);
  const token = decimalUnits(tokenUnits);
  if (native === null || token === null) return null;
  if (BigInt(native) / ARC_UNIT_SCALE === BigInt(token)) return null;
  return `${native} fee units is not ${token} USDC units at 1e${ARC_FEE_DECIMALS - USDC_TOKEN_DECIMALS}`;
}

/** How many more days can be committed with what is in the account. */
export interface AnchorRunway {
  /** Whole anchors affordable, or null when it cannot be known. */
  anchors: number | null;
  /** Why it cannot be known, when it cannot. */
  problem: string | null;
  /** True when the quotient overflowed a JS number and was clamped. */
  capped: boolean;
}

/**
 * Balance divided by the last measured cost, in integer units.
 *
 * Both operands must be known. Cost is the *last* anchor's price rather than a
 * quote, so a fee-market jump shows up here as a shorter runway the day after it
 * happens instead of a promise that never gets revised.
 */
export function anchorRunway(balanceUnits: unknown, costUnits: unknown): AnchorRunway {
  const balance = decimalUnits(balanceUnits);
  const cost = decimalUnits(costUnits);
  if (balance === null) return { anchors: null, problem: 'balance not read', capped: false };
  if (cost === null) return { anchors: null, problem: 'no anchor cost measured yet', capped: false };
  if (BigInt(cost) === 0n) return { anchors: null, problem: 'zero-cost anchor: the receipt is not believable', capped: false };
  // No sign check here: both operands are validated as non-negative decimal counts
  // above, so a negative quotient is not a state this function can reach and a
  // branch for it would be a line no test can ever make red.
  const quotient = BigInt(balance) / BigInt(cost);
  if (quotient > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { anchors: Number.MAX_SAFE_INTEGER, problem: null, capped: true };
  }
  return { anchors: Number(quotient), problem: null, capped: false };
}

/** The durable economics of the anchor, as stored in the world ledger. */
export interface AnchorEcon {
  /** Wall clock of the last successful read. Staleness is reported, not hidden. */
  at: number;
  /** `eth_getBalance` of the signing address, in native fee units. */
  balanceUnits: string | null;
  /** `balanceOf` of the same address on the USDC contract, in token units. */
  tokenUnits: string | null;
  /** What the most recent confirmed anchor cost, in native fee units. */
  costUnits: string | null;
  /** Which day that cost belongs to, so a stale cost cannot pose as a fresh one. */
  costDay: number | null;
  /** Data sales settled since this ledger existed — durable, unlike the per-isolate count. */
  sales: number;
  /** Sum of the quoted amounts over those sales, in token units. */
  revenueUnits: string;
  /**
   * Whether the last read found the runway below `RUNWAY_ALARM_ANCHORS`.
   *
   * Stored rather than kept in a closure flag, because the flag's job is to make
   * "the balance is low" one event: a flag that dies with the isolate turns a
   * persistently poor account into one alarm per eviction, so the count would
   * measure how long the tank has been broke rather than whether anything happened.
   * Being durable also means it can be *cleared*, which is the other half: a
   * balance that recovers and falls again is reported twice, and the second fall is
   * genuinely news.
   */
  lowNoted: boolean;
}

/**
 * Whether a stored economics object says more than it can support.
 *
 * Same shape as `coherenceProblem` for the digest record: this value outlives the
 * code that wrote it, so every field is checked on the way in rather than trusted.
 * The unit strings are the interesting part — a `balanceUnits` that arrived as a
 * JSON number would make every comparison below throw inside the health route,
 * which is the worst possible place for it.
 */
export function anchorEconProblem(a: AnchorEcon): string | null {
  if (!Number.isFinite(a.at) || a.at < 0) return 'economics without a readable timestamp';
  for (const field of ['balanceUnits', 'tokenUnits', 'costUnits'] as const) {
    const value = a[field];
    if (value !== null && decimalUnits(value) === null) return `${field} is not a decimal integer string`;
  }
  if (decimalUnits(a.revenueUnits) === null) return 'revenueUnits is not a decimal integer string';
  if (!Number.isInteger(a.sales) || a.sales < 0) return 'negative or fractional sales count';
  if (typeof a.lowNoted !== 'boolean') return 'lowNoted is not a boolean';
  if (a.costUnits === null && a.costDay !== null) return 'a cost day with no cost';
  if (a.costUnits !== null && !Number.isInteger(a.costDay)) return 'a cost with no day to belong to';
  return null;
}

/** A fresh, empty economics record for a ledger that has not anchored yet. */
export function newAnchorEcon(at: number): AnchorEcon {
  return {
    at, balanceUnits: null, tokenUnits: null, costUnits: null, costDay: null,
    sales: 0, revenueUnits: '0', lowNoted: false,
  };
}
