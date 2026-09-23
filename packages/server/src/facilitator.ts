/**
 * Real x402 settlement through Circle's hosted Facilitator Service
 * (developers.circle.com/facilitator-service): the buyer signs an EIP-3009
 * `transferWithAuthorization` in their wallet (gasless, they never send a
 * transaction), we hand the authorization to Circle, and Circle broadcasts the
 * USDC transfer and pays the gas. On Arc the settlement is final immediately,
 * which is what lets an intervention land in the same tick as the payment.
 *
 * RESERVED: interventions do not use this module. They are paid by burning
 * ABYS and proven with a burn receipt (see payments.ts). What this module sells
 * is the data tier: `GET /data/flows`, priced in USDC and settled here. The
 * seller key arrives as a binding like every other secret in this build (see
 * `digestKey()` in handler.ts for why nothing trusts `process.env` first), and
 * without one the route reports itself not for sale rather than quoting a price
 * nobody can pay.
 */
import { keccak256, recoverTypedDataAddress, toBytes } from 'viem';

// Node exposes webcrypto globally since v19 and Workers always have it; the
// dynamic import only runs on runtimes that lack both, so it never executes
// where node:crypto does not exist.
const rand: { getRandomValues(b: Uint8Array): Uint8Array } =
  globalThis.crypto ?? (await import('node:crypto')).webcrypto;
import { privateKeyToAccount } from 'viem/accounts';

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_MAINNET_CHAIN_ID = 5042;
/** Native USDC precompile, identical address on Arc mainnet and testnet. */
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

export interface FacilitatorConfig {
  network: string;
  chainId: number;
  payTo: string;
  baseUrl: string;
  usdc: string;
  account: ReturnType<typeof privateKeyToAccount>;
}

/**
 * What one call to the data tier costs, in whole USDC. Taken from TOKEN_PLAN.md
 * §7 ("历史 API 单次调用 $0.001"), which is also the only place that price is
 * written down — so the constant lives beside the code that charges it.
 */
export const DATA_PRICE_USDC = '0.001';

/** Same shape the day-anchor key is checked against, for the same reason. */
const KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

export interface FacilitatorSource {
  /** Hex private key controlling `payTo`. Anything else means "not for sale". */
  sellerKey?: string | null;
  /** `1` selects the keyless Arc testnet trial; anything else is mainnet. */
  testnet?: string | null;
  /** Defaults to the address the seller key controls. */
  payTo?: string | null;
  /** Circle's hosted facilitator unless a test points this somewhere else. */
  baseUrl?: string | null;
}

/**
 * Null unless a well-formed seller key is present; the server then refuses to
 * sell.
 *
 * Two things this does on purpose. It never reads an environment itself — the
 * caller hands over what its runtime gave it, which is the arrangement
 * `ARC_DIGEST_KEY` moved to and the reason a configured secret can no longer be
 * invisible. And it shape-checks before `privateKeyToAccount`, because viem
 * throws on a key that was truncated on its way into a dashboard, and a throw
 * here would be a 500 on a route a paying customer just followed a 402 to.
 */
export function buildFacilitatorConfig(src: FacilitatorSource): FacilitatorConfig | null {
  const pk = src.sellerKey ?? null;
  if (!pk || !KEY_SHAPE.test(pk)) return null;
  const chainId = src.testnet === '1' ? ARC_TESTNET_CHAIN_ID : ARC_MAINNET_CHAIN_ID;
  const account = privateKeyToAccount(pk as `0x${string}`);
  return {
    network: `eip155:${chainId}`,
    chainId,
    payTo: (src.payTo ?? account.address).toLowerCase(),
    baseUrl: src.baseUrl ?? 'https://api.circle.com/v1/facilitator/x402',
    usdc: ARC_USDC,
    account,
  };
}

/** USDC is a 6-decimal token, and that is the only precision money can hold. */
const USDC_DECIMALS = 6;

/**
 * A price in whole USDC, as exact base units.
 *
 * `BigInt(Math.round(Number(price) * 1e6))` was the previous arithmetic, and it
 * fails in the one direction that matters: a price finer than a USDC base unit
 * rounds to `0`, which is an endpoint that quotes $0.0000001 and then accepts
 * nothing. Multiplying by a power of ten is exact once the fraction is read as
 * text, so it is read as text — and anything that does not fit in 6 decimals is
 * a mistake in this file rather than a price, and says so.
 */
export function usdcUnits(priceUsdc: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(priceUsdc.trim());
  if (!m) throw new TypeError(`not a USDC price: ${JSON.stringify(priceUsdc)}`);
  const frac = m[2] ?? '';
  if (frac.length > USDC_DECIMALS) {
    throw new TypeError(`finer than a USDC base unit: ${priceUsdc}`);
  }
  return BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, '0'));
}

/** x402-spec payment requirements for a USDC price, settled by Circle. */
export function exactRequirement(cfg: FacilitatorConfig, priceUsdc: string) {
  const amount = String(usdcUnits(priceUsdc));
  return {
    scheme: 'exact',
    network: cfg.network,
    amount,
    asset: cfg.usdc,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 30,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
  };
}

export type ExactRequirement = ReturnType<typeof exactRequirement>;

/**
 * base64url envelope with an EIP-712 signature proving control of `payTo`,
 * required in the Facilitator-Seller-Proof header of every seller call.
 */
async function sellerProof(
  cfg: FacilitatorConfig,
  purpose: 'verify' | 'settle' | 'status',
  method: string,
  body: string,
): Promise<string> {
  const nonce = `0x${Buffer.from(rand.getRandomValues(new Uint8Array(32))).toString('hex')}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const signature = await cfg.account.signTypedData({
    domain: {
      name: 'Circle Facilitator Seller Request',
      version: '1',
      chainId: cfg.chainId,
    },
    types: {
      SellerRequest: [
        { name: 'purpose', type: 'string' },
        { name: 'method', type: 'string' },
        { name: 'bodyHash', type: 'bytes32' },
        { name: 'network', type: 'string' },
        { name: 'payTo', type: 'address' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'SellerRequest',
    message: {
      purpose,
      method: method.toUpperCase(),
      bodyHash: keccak256(toBytes(body)),
      network: cfg.network,
      payTo: cfg.payTo as `0x${string}`,
      nonce: nonce as `0x${string}`,
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(expiresAt),
    },
  });
  const envelope = {
    version: 1,
    signature,
    network: cfg.network,
    payTo: cfg.payTo,
    nonce,
    issuedAt,
    expiresAt,
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64url');
}

/**
 * The verdict on one payment attempt, and where it came from.
 *
 * `stage` is not decoration. A caller that counts failures for `/health` has to
 * tell "a buyer's wallet handed us an expired authorization" apart from "Circle
 * could not be reached", because the first is reachable by anyone with a
 * keyboard and no money, while the second costs the attacker a real payment.
 * Counting both would let an anonymous flood turn the health light red, which is
 * the exact failure mode this whole module exists to avoid.
 */
export interface Settlement {
  ok: boolean;
  tx?: string;
  payer?: string;
  reason?: string;
  /** `precheck` refused before any network call; `facilitator` is what Circle answered. */
  stage: 'precheck' | 'facilitator';
}

/** One of our own refusals, before a single packet leaves for the facilitator. */
function reject(reason: string): Settlement {
  return { ok: false, reason, stage: 'precheck' };
}

/** Submit a buyer authorization to /settle and wait out any pending state. */
async function settle(
  cfg: FacilitatorConfig,
  paymentPayload: unknown,
  paymentRequirements: ExactRequirement,
): Promise<Settlement> {
  const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements });
  const proof = await sellerProof(cfg, 'settle', 'POST', body);
  const res = await fetch(`${cfg.baseUrl}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Facilitator-Seller-Proof': proof },
    body,
  });
  let out: any;
  try {
    out = await res.json();
  } catch {
    return { ok: false, reason: `facilitator http ${res.status}`, stage: 'facilitator' };
  }
  if (out?.success === true) {
    return { ok: true, tx: out.transaction, payer: out.payer, stage: 'facilitator' };
  }
  const pending = out?.extensions?.['settlement-status'];
  if (out?.errorReason === 'settlement_pending' && pending?.paymentId) {
    // Arc finality is instant; pending here means Circle's broadcast is still
    // in flight, so a short poll closes it out.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const sProof = await sellerProof(cfg, 'status', 'GET', '');
      const sRes = await fetch(`${cfg.baseUrl}/status/${pending.paymentId}`, {
        headers: { 'Facilitator-Seller-Proof': sProof },
      });
      let st: any;
      try {
        st = await sRes.json();
      } catch {
        continue;
      }
      if (st?.status === 'completed') return { ok: true, tx: st.transaction, payer: st.payer, stage: 'facilitator' };
      if (st?.status && st.status !== 'pending') return { ok: false, reason: st.reason ?? st.status, stage: 'facilitator' };
    }
    return { ok: false, reason: 'settlement timed out', stage: 'facilitator' };
  }
  return { ok: false, reason: out?.errorReason ?? `facilitator http ${res.status}`, stage: 'facilitator' };
}

/**
 * Recover the address Circle will see behind a buyer's authorization, using
 * the same EIP-712 domain Circle rebuilds it from (our `extra.name`/`version`,
 * the settlement chain, the USDC asset). A wallet that signs with an account
 * other than the one it reported, multi-account, a hardware-wallet derivation
 * path, or a contract wallet that can't do EIP-3009 at all, hands back a
 * well-formed signature over the right digest that simply isn't `from`'s, and
 * Circle answers only with an opaque invalid_exact_evm_payload_signature.
 * Checking first lets us tell the buyer what to fix. Null when recovery fails.
 */
async function recoverSigner(
  cfg: FacilitatorConfig,
  requirement: ExactRequirement,
  auth: any,
  signature: `0x${string}`,
): Promise<string | null> {
  try {
    return await recoverTypedDataAddress({
      domain: {
        name: String(requirement.extra.name),
        version: String(requirement.extra.version),
        chainId: cfg.chainId,
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
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter ?? 0),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    });
  } catch {
    return null;
  }
}

/**
 * One read of the `X-Payment` envelope, shared by the settlement path and by any
 * caller that needs a field from it before deciding to settle.
 *
 * Exported because the alternative — a second decoder in the handler, written
 * from memory of this one — is how the burn-receipt guard got two spellings of
 * the same key and started disagreeing about casing.
 */
export type PaymentRead =
  | { ok: true; accepted: any; auth: any; signature: string; envelope: any }
  | { ok: false; reason: string };

export function readPayment(req: Request): PaymentRead {
  const header = req.headers.get('x-payment');
  if (!header) return { ok: false, reason: 'missing X-Payment' };
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    try {
      payload = JSON.parse(header);
    } catch {
      return { ok: false, reason: 'bad X-Payment encoding' };
    }
  }
  const accepted = payload?.accepted;
  const auth = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  if (!accepted || !auth || !signature) return { ok: false, reason: 'malformed payment payload' };
  // `envelope` is the whole decoded header, not the pieces above: it is what
  // gets handed to Circle, so reassembling it here from three fields would put
  // a second, lossier copy of the buyer's payment on the wire.
  return { ok: true, accepted, auth, signature, envelope: payload };
}

/**
 * Parse `X-Payment`, check the buyer's authorization against our own offer,
 * then settle it through Circle. Returns the settlement verdict; the caller
 * applies the intervention only on `ok`.
 */
export async function settleFromRequest(
  req: Request,
  cfg: FacilitatorConfig,
  requirement: ExactRequirement,
): Promise<Settlement> {
  const read = readPayment(req);
  if (!read.ok) return reject(read.reason);
  const { accepted, auth, signature, envelope } = read;
  if (String(accepted.amount) !== requirement.amount) return reject('amount mismatch');
  if (String(accepted.payTo).toLowerCase() !== requirement.payTo) return reject('payTo mismatch');
  if (accepted.network !== requirement.network) return reject('network mismatch');
  if (String(auth.to).toLowerCase() !== requirement.payTo) return reject('authorization payTo mismatch');
  if (String(auth.value) !== requirement.amount) return reject('authorization amount mismatch');
  const validBefore = Number(auth.validBefore);
  if (Number.isFinite(validBefore) && validBefore * 1000 < Date.now()) {
    return reject('authorization expired');
  }
  const signer = await recoverSigner(cfg, requirement, auth, signature as `0x${string}`);
  if (signer && signer.toLowerCase() !== String(auth.from).toLowerCase()) {
    return { ok: false, reason: 'signer_mismatch', payer: String(auth.from), stage: 'precheck' };
  }
  return settle(cfg, envelope, requirement);
}
