/**
 * Real x402 settlement through Circle's hosted Facilitator Service
 * (developers.circle.com/facilitator-service): the buyer signs an EIP-3009
 * `transferWithAuthorization` in their wallet (gasless, they never send a
 * transaction), we hand the authorization to Circle, and Circle broadcasts the
 * USDC transfer and pays the gas. On Arc the settlement is final immediately,
 * which is what lets an intervention land in the same tick as the payment.
 *
 * Enabled by SELLER_PRIVATE_KEY in the environment (the key controlling
 * `payTo`); without it the server stays in demo mode. X402_MAINNET=1 settles
 * on Arc mainnet (eip155:5042, requires a Circle API key per the docs);
 * the default is the keyless trial on Arc testnet (eip155:5042002).
 */
import { keccak256, recoverTypedDataAddress, toBytes } from 'viem';
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

/** Null unless a seller key is configured, the server then stays in demo. */
export function facilitatorConfig(): FacilitatorConfig | null {
  const pk = process.env.SELLER_PRIVATE_KEY;
  if (!pk) return null;
  const chainId = process.env.X402_MAINNET === '1' ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID;
  const account = privateKeyToAccount(pk as `0x${string}`);
  return {
    network: `eip155:${chainId}`,
    chainId,
    payTo: (process.env.SELLER_PAY_TO ?? account.address).toLowerCase(),
    baseUrl: process.env.FACILITATOR_URL ?? 'https://api.circle.com/v1/facilitator/x402',
    usdc: ARC_USDC,
    account,
  };
}

/** x402-spec payment requirements for a USDC price, settled by Circle. */
export function exactRequirement(cfg: FacilitatorConfig, priceUsdc: string) {
  const amount = String(BigInt(Math.round(Number(priceUsdc) * 1_000_000)));
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
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`;
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

export interface Settlement {
  ok: boolean;
  tx?: string;
  payer?: string;
  reason?: string;
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
    return { ok: false, reason: `facilitator http ${res.status}` };
  }
  if (out?.success === true) {
    return { ok: true, tx: out.transaction, payer: out.payer };
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
      if (st?.status === 'completed') return { ok: true, tx: st.transaction, payer: st.payer };
      if (st?.status && st.status !== 'pending') return { ok: false, reason: st.reason ?? st.status };
    }
    return { ok: false, reason: 'settlement timed out' };
  }
  return { ok: false, reason: out?.errorReason ?? `facilitator http ${res.status}` };
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
 * Parse `X-Payment`, check the buyer's authorization against our own offer,
 * then settle it through Circle. Returns the settlement verdict; the caller
 * applies the intervention only on `ok`.
 */
export async function settleFromRequest(
  req: Request,
  cfg: FacilitatorConfig,
  requirement: ExactRequirement,
): Promise<Settlement> {
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
  if (String(accepted.amount) !== requirement.amount) return { ok: false, reason: 'amount mismatch' };
  if (String(accepted.payTo).toLowerCase() !== requirement.payTo) return { ok: false, reason: 'payTo mismatch' };
  if (accepted.network !== requirement.network) return { ok: false, reason: 'network mismatch' };
  if (String(auth.to).toLowerCase() !== requirement.payTo) return { ok: false, reason: 'authorization payTo mismatch' };
  if (String(auth.value) !== requirement.amount) return { ok: false, reason: 'authorization amount mismatch' };
  const validBefore = Number(auth.validBefore);
  if (Number.isFinite(validBefore) && validBefore * 1000 < Date.now()) {
    return { ok: false, reason: 'authorization expired' };
  }
  const signer = await recoverSigner(cfg, requirement, auth, signature as `0x${string}`);
  if (signer && signer.toLowerCase() !== String(auth.from).toLowerCase()) {
    return { ok: false, reason: 'signer_mismatch', payer: String(auth.from) };
  }
  return settle(cfg, payload, requirement);
}
