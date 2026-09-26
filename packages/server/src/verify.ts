/**
 * Reading one anchored day straight off the chain, with no trust in this site.
 *
 * Everything else in the anchoring path answers "what do we claim". This answers
 * the only question a claim is worth asking about: *is it on chain, and does what
 * is on chain say the same thing?* Until now that check existed in exactly two
 * places — a script outside the committed tree, and a reader with `curl`, a node
 * and sha256 — which is honest but a worse experience than the site can afford,
 * and the reason `PAPER` listed it as open work rather than as a feature.
 *
 * The shape of the answer matters as much as the arithmetic. A verifier that
 * returns a boolean has to lie in one of three situations, and this repository has
 * already been burned by exactly that:
 *
 *   - the transaction exists and its calldata names a rule *this build* has no
 *     entry for. That is a fact about the build, not about the day. Calling it a
 *     mismatch calls an honest on-chain record corrupt — the one verdict a
 *     verifier must never hand out;
 *   - the transaction has not mined yet. There is nothing to compare, which is
 *     neither of the answers above;
 *   - the node did not answer. "No commitment was made" and "we could not look"
 *     have different fixes, and only one of them is a bug in this code.
 *
 * So `verifyPayload`'s three outcomes are carried through here and widened, never
 * collapsed: `verified` / `mismatch` / `uncheckable`, plus `pending` for a
 * transaction with no receipt and `unknown` for a chain that would not answer.
 *
 * What this module does NOT do: no network, no storage, no `Date.now()`. Every
 * input arrives as an argument, because the whole job is to be the part a reader
 * can check line by line — the same reason `digest.ts` was extracted from the
 * handler, and the reason an RPC call living in here would undo it.
 */

import {
  DIGEST_RULE_TABLE, digestPreImage, verifyPayload,
  type DigestPayload, type VerifyOutcome, type CensusDay,
} from './digest.js';
import { hexToDecimalUnits } from './econ.js';

/** A `0x` followed by 64 hex digits: the shape every tx hash in the book has. */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** 4 bytes of `ABYS` magic, as hex digits. */
const MAGIC_HEX_LENGTH = 8;

/**
 * The largest calldata this will attempt to decode.
 *
 * A number out of the blue? No — it is a bound on *bytes this function will spend
 * time on* for a single request, and it is derived: a v1 payload measured 344
 * bytes of JSON in the deployed book's widest row (374 with the two fields the row
 * adds after the hash), and the hex doubles it plus the magic, so a real record is
 * under 800 hex digits. 4096 hex digits is 2 KB of JSON — five times the largest
 * payload this project has ever put on a chain — and past that a request is either
 * a truncation (answered as `unreadable` a few lines further down) or somebody
 * testing what the route spends CPU on. The bound exists so the size test is a
 * policy rather than an accident of `JSON.parse`.
 */
const MAX_CALLDATA_HEX = 4096;

/** Lowercase, `0x`-prefixed: the form the chain and our own records both use. */
export function isTxHash(value: unknown): value is string {
  return typeof value === 'string' && TX_HASH.test(value);
}

/** One JSON-RPC object from `eth_getTransactionByHash` / `eth_getTransactionReceipt`. */
export interface RpcObject {
  [key: string]: unknown;
}

/** What the chain said about the calldata we just decoded. */
export interface ChainFacts {
  /** `from`, which for our anchors is the signing account `/health` publishes. */
  from: string | null;
  /** `to`: the contract the record was written to, or null for a plain value transfer. */
  to: string | null;
  /** Block height the transaction object was included in, decimal string. */
  blockNumber: string | null;
  /** `true` when the calldata begins with the `ABYS` tag this project writes. */
  ours: boolean;
  /** Bytes of hex after the tag, before decoding: how big the record actually was. */
  payloadHexLength: number;
}

/** What the receipt said about whether the write happened. */
export interface ReceiptFacts {
  /** `confirmed` (status 0x1), `reverted` (status 0x0), `pending` (no receipt yet). */
  status: 'confirmed' | 'reverted' | 'pending';
  blockNumber: string | null;
  blockHash: string | null;
  /** `gasUsed × effectiveGasPrice` in native fee units, or null if either is unreadable. */
  feeUnits: string | null;
  gasUsed: string | null;
  gasPrice: string | null;
}

/** How the three artifacts — chain bytes, our stored row, the hash function — agree. */
export interface TxCheck {
  /** What we were asked about, normalised to lowercase. */
  txHash: string;
  /** Whether the node produced the transaction at all. */
  txFound: boolean;
  chain: ChainFacts | null;
  receipt: ReceiptFacts | null;
  /** The four states a reader needs; `hashOutcome` refines `confirmed`. */
  found: 'on-chain' | 'pending' | 'not-found' | 'unknown';
  /**
   * The decoded record, or null with a `problem` saying why there is none.
   * `fields` is the whole JSON object the calldata carried, keys and all — a
   * verifier that shows only the fields it wanted is a verifier that hides what
   * the record also claimed.
   */
  payload: { v: number; day: number; hash: string; ts: number; fields: Record<string, unknown> } | null;
  /** Why the calldata is not a record: too big, wrong tag, not JSON, wrong shape. */
  decodeProblem: string | null;
  /** Whether this build has a rule for the version the *record* names. */
  ruleKnown: boolean;
  /** `verified` / `mismatch` / `uncheckable`, or null when there was nothing to hash. */
  hashOutcome: VerifyOutcome | null;
  hashProblem: string | null;
  /** The exact bytes that were hashed, so a reader can redo it with `sha256sum`. */
  preImage: string | null;
  /** The row of the day book this transaction is pointed at, when one points at it. */
  book: {
    day: number | null;
    /** `true` when the row's own `txHash` is the transaction we are checking. */
    txMatches: boolean;
    /** The row's hashed fields as strings, for the comparison against `fields`. */
    row: Record<string, unknown> | null;
  } | null;
  /**
   * Payload against the stored row: does the on-chain record say what our own
   * book says it said? `same` compares each field its rule hashes, plus `hash`.
   */
  rowAgreement: 'same' | 'differs' | 'uncheckable' | null;
  /** Field names that disagree, and what each side said. Empty unless `differs`. */
  disagreements: { field: string; payload: string; row: string }[];
  /** The verdict, one level up from the parts: what a reader should believe. */
  verdict: 'verified' | 'mismatch' | 'uncheckable' | 'pending' | 'not-found' | 'unreadable' | 'unknown';
  /** Why, in one sentence, for the chip and the log. `null` exactly when `verified`. */
  problem: string | null;
}

/** A calldata decode: either the record, or the reason there is no record. */
export type DecodedCalldata =
  | { ok: true; magic: string; fields: Record<string, unknown> }
  | { ok: false; problem: string };

/**
 * The calldata bytes back into the JSON object they were made of.
 *
 * Inverse of `encodeDigest`, and deliberately as permissive about *keys* as that
 * function is strict: a payload carrying fields this build does not hash is a
 * payload from a newer rule, and the honest answer is to show them and let the
 * rule table decide what was hashed. Refusing unknown keys here would be a build
 * rejecting a chain record because it had not been updated yet — the mistake the
 * whole rule table exists to prevent, arriving from the other direction.
 *
 * What it does refuse, each with a sentence a reader can act on:
 *   - a length that is not even hex, or past `MAX_CALLDATA_HEX`;
 *   - fewer bytes than the four-byte tag (a truncation is not a record);
 *   - a tag that is not `ABYS` (a different writer's transaction);
 *   - JSON that does not parse, parses to an array or a scalar, or is missing a
 *     field that is not optional in any rule this project has ever shipped
 *     (`v`, `day`, `hash`, `ts`).
 */
export function decodeCalldataPayload(input: unknown): DecodedCalldata {
  if (typeof input !== 'string' || !/^0x[0-9a-fA-F]*$/.test(input)) {
    return { ok: false, problem: 'calldata is not a hex string' };
  }
  const hex = input.slice(2).toLowerCase();
  if (hex.length % 2 !== 0) return { ok: false, problem: `calldata has an odd number of hex digits (${String(hex.length)})` };
  if (hex.length > MAX_CALLDATA_HEX) {
    return { ok: false, problem: `calldata is ${String(hex.length / 2)} bytes, over the ${String(MAX_CALLDATA_HEX / 2)}-byte bound this route will decode` };
  }
  if (hex.length < MAGIC_HEX_LENGTH) {
    return { ok: false, problem: `calldata is ${String(hex.length / 2)} bytes, shorter than the 4-byte ABYS tag alone` };
  }
  const magic = `0x${hex.slice(0, MAGIC_HEX_LENGTH)}`;
  if (magic !== '0x41425953') return { ok: false, problem: `calldata begins with ${magic}, not the 0x41425953 ("ABYS") this project writes` };
  const body = hex.slice(MAGIC_HEX_LENGTH);
  let text: string;
  try {
    const bytes = new Uint8Array(body.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      const byte = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
      if (!Number.isInteger(byte)) return { ok: false, problem: 'calldata has a non-hex byte after the tag' };
      bytes[i] = byte;
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, problem: 'calldata after the tag is not valid UTF-8, so it is not the JSON this project writes' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'calldata after the tag does not parse as JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problem: `calldata decodes to ${Array.isArray(parsed) ? 'an array' : 'a ' + typeof parsed}, not an object` };
  }
  const fields = parsed as Record<string, unknown>;
  // The four keys every rule so far has hashed or carried. `hash` is the thing
  // being checked and `v`/`day`/`ts` are how it is dated and attributed, so a
  // record without them is not an old format — it is not this format.
  for (const key of ['v', 'day', 'hash', 'ts'] as const) {
    if (fields[key] === undefined) return { ok: false, problem: `decoded record carries no \`${key}\`, which no rule of ours has ever written without` };
  }
  if (typeof fields.v !== 'number' || !Number.isInteger(fields.v)) {
    return { ok: false, problem: 'decoded record\'s `v` is not a whole number, so no rule can be looked up by it' };
  }
  if (typeof fields.hash !== 'string' || !/^[0-9a-f]{64}$/.test(fields.hash.toLowerCase())) {
    return { ok: false, problem: 'decoded record\'s `hash` is not 64 hex digits, so there is nothing to compare a recomputation to' };
  }
  return { ok: true, magic, fields };
}

/** The chain's hex fields that a verification answer should repeat back, in decimal. */
export function chainFacts(tx: RpcObject | null | undefined): ChainFacts | null {
  if (!tx || typeof tx !== 'object') return null;
  const input = typeof tx.input === 'string' ? tx.input : typeof tx.data === 'string' ? tx.data : '';
  // Only the tag is looked at here. Decoding the body is `decodeCalldataPayload`'s
  // job and it is called once, below; a helper that also parsed would leave two
  // readers of the same bytes able to disagree about what they said.
  return {
    from: typeof tx.from === 'string' ? tx.from.toLowerCase() : null,
    to: typeof tx.to === 'string' ? tx.to.toLowerCase() : null,
    blockNumber: hexToDecimalUnits(tx.blockNumber),
    ours: /^0x41425953/i.test(input),
    payloadHexLength: Math.max(0, (typeof input === 'string' ? input.length - 2 : 0) - MAGIC_HEX_LENGTH),
  };
}

/**
 * What the receipt says, including the case where there is no receipt.
 *
 * `status` arrives as `0x1` or `0x0` and both are *answers*; a missing receipt is
 * a third answer, and the three must not be writable by the same branch — a
 * reverted transaction is a real on-chain record whose calldata still deserves
 * reading, while a pending one has nothing to read yet.
 */
export function receiptFacts(receipt: RpcObject | null | undefined): ReceiptFacts {
  if (!receipt || typeof receipt !== 'object' || receipt.status === undefined || receipt.status === null) {
    return { status: 'pending', blockNumber: null, blockHash: null, feeUnits: null, gasUsed: null, gasPrice: null };
  }
  const status = String(receipt.status).toLowerCase();
  const gasUsed = hexToDecimalUnits(receipt.gasUsed);
  const gasPrice = hexToDecimalUnits(receipt.effectiveGasPrice ?? receipt.gasPrice);
  return {
    status: status === '0x1' ? 'confirmed' : status === '0x0' ? 'reverted' : 'pending',
    blockNumber: hexToDecimalUnits(receipt.blockNumber),
    blockHash: typeof receipt.blockHash === 'string' ? receipt.blockHash.toLowerCase() : null,
    feeUnits: gasUsed !== null && gasPrice !== null ? (BigInt(gasUsed) * BigInt(gasPrice)).toString() : null,
    gasUsed,
    gasPrice,
  };
}

/**
 * The whole check, in one pure call: chain bytes, stored row, verdict.
 *
 * Note what is *not* compared: this does not re-derive the day's numbers from a
 * world state, because the world at a past tick is not something the server keeps.
 * It compares three artifacts that all exist today — the bytes the chain holds, the
 * row this server stored, and the hash a rule predicts from the first of them —
 * which is the claim the site can actually support: *the commitment we say we made
 * is the commitment the chain holds, and the record we keep beside it is the same
 * record.* Whether the numbers described the world honestly is a different
 * question, answered by the determinism of the engine and not by this function.
 */
export async function checkTransaction(
  txHash: string,
  tx: RpcObject | null,
  receipt: RpcObject | null,
  row: CensusDay | null,
  options: { chainAnswered?: boolean } = {},
): Promise<TxCheck> {
  const chainAnswered = options.chainAnswered !== false;
  const chain = chainFacts(tx);
  const rec = receiptFacts(receipt);
  const decoded = chain ? decodeCalldataPayload(typeof tx?.input === 'string' ? tx.input : typeof tx?.data === 'string' ? tx.data : '') : null;

  const base: TxCheck = {
    txHash: txHash.toLowerCase(),
    txFound: Boolean(chain),
    chain,
    receipt: rec,
    found: chain ? (rec.status === 'pending' ? 'pending' : 'on-chain') : chainAnswered ? 'not-found' : 'unknown',
    payload: null,
    decodeProblem: null,
    ruleKnown: false,
    hashOutcome: null,
    hashProblem: null,
    preImage: null,
    book: row
      ? {
        day: row.day,
        txMatches: typeof row.txHash === 'string' && row.txHash.toLowerCase() === txHash.toLowerCase(),
        row: { ...row },
      }
      : null,
    rowAgreement: null,
    disagreements: [],
    verdict: 'unknown',
    problem: null,
  };

  // Three different ways of not having a transaction, and this is the second.
  // A node that *answered* null is evidence — the hash is not a transaction on
  // this chain — while a caller that never got an answer has no evidence at all.
  // Folding those two together is how "the RPC timed out" gets reported as "no
  // commitment was ever made", which is a statement about our own history that
  // the network did not license. `econ.ts` refuses the same collapse for the
  // same reason: an unreadable balance is not a zero balance.
  if (!chainAnswered) {
    return { ...base, found: 'unknown', verdict: 'unknown', problem: 'the chain was not reached, so there is no answer about this transaction' };
  }
  if (!chain || !tx) {
    return { ...base, found: 'not-found', verdict: 'not-found', problem: 'the node answered: no transaction with that hash' };
  }
  if (!chain.ours) {
    // Somebody else's transaction. Nothing about it is our claim, and refusing to
    // hash it is the point: a verifier that will check any bytes is a verifier
    // whose "verified" means nothing.
    return { ...base, verdict: 'unreadable', problem: 'the transaction is not ours: its calldata has no ABYS tag' };
  }
  if (decoded && !decoded.ok) {
    return { ...base, decodeProblem: decoded.problem, verdict: 'unreadable', problem: decoded.problem };
  }
  if (!decoded || !decoded.ok) {
    return { ...base, decodeProblem: 'the calldata could not be read', verdict: 'unreadable', problem: 'the calldata could not be read' };
  }

  const fields = decoded.fields;
  const payload = {
    v: fields.v as number,
    day: typeof fields.day === 'number' ? fields.day : Number.NaN,
    hash: String(fields.hash).toLowerCase(),
    ts: typeof fields.ts === 'number' ? fields.ts : Number.NaN,
    fields,
  };
  const withPayload: TxCheck = { ...base, payload };
  const version = String(payload.v);
  const ruleKnown = DIGEST_RULE_TABLE[version] !== undefined;
  withPayload.ruleKnown = ruleKnown;

  // Recompute under the rule *the record* names. `verifyPayload` already answers
  // in three states and already refuses to hash a payload whose rule names a field
  // the payload lacks; handing it the decoded object is the whole integration.
  const verification = await verifyPayload({ ...fields } as unknown as DigestPayload);
  withPayload.hashOutcome = verification.outcome;
  withPayload.hashProblem = verification.problem;
  if (ruleKnown) {
    // Publish the bytes for a reader holding sha256. For `uncheckable` there is
    // deliberately no pre-image: this build cannot name the fields that would be
    // in it, and printing a guess as "the bytes hashed" is how a verifier starts
    // lying.
    const pre = digestPreImage({ ...fields } as unknown as { v: number });
    withPayload.preImage = 'preImage' in pre ? pre.preImage : null;
  }

  // Payload against the row we store. Both sides are rendered to the strings the
  // pre-image uses (`~` for null), because that is the comparison the hash was
  // made of — a number that differs from its own decimal rendering is not a
  // disagreement, and a `0` versus `null` is.
  if (row) {
    const render = (value: unknown): string => (value === null || value === undefined ? '~' : String(value));
    const fieldsToCompare = ruleKnown ? DIGEST_RULE_TABLE[version] : DIGEST_RULE_TABLE['1'];
    const disagreements: { field: string; payload: string; row: string }[] = [];
    for (const key of [...fieldsToCompare, 'hash']) {
      const a = render((fields as Record<string, unknown>)[key === 'v' ? 'v' : key]);
      const b = render((row as unknown as Record<string, unknown>)[key]);
      if (a !== b) disagreements.push({ field: key, payload: a, row: b });
    }
    // A record naming a rule we do not have cannot be compared field by field —
    // the list of fields is exactly what we lack — and `uncheckable` here is that
    // fact, not a hedge. The hash check above is still honest: it said the same.
    withPayload.rowAgreement = ruleKnown ? (disagreements.length === 0 ? 'same' : 'differs') : 'uncheckable';
    withPayload.disagreements = ruleKnown ? disagreements : [];
  }

  const verdict = verdictFor(withPayload);
  return {
    ...withPayload,
    verdict,
    problem: verdict === 'verified' ? null : problemFor(withPayload, verdict),
  };
}

/**
 * The one place the five parts become an answer, so that a caller cannot assemble
 * its own verdict out of whichever fields it looked at.
 *
 * A reverted transaction whose calldata hashes correctly is `verified` in the only
 * sense this route can mean it — the bytes that were sent are the bytes we claim —
 * and says so alongside a receipt that reports the revert. That is not a pass:
 * `verified` is a statement about the record's integrity, and `receipt.status` is
 * the statement about whether the write landed. Collapsing the two into one green
 * light would let a day whose commitment reverted be reported as anchored, which
 * is a lie about the chain rather than about arithmetic.
 */
function verdictFor(c: TxCheck): TxCheck['verdict'] {
  if (c.found === 'pending') return 'pending';
  if (!c.payload) return 'unreadable';
  if (c.hashOutcome === 'uncheckable') return 'uncheckable';
  if (c.hashOutcome === 'mismatch') return 'mismatch';
  if (c.rowAgreement === 'differs') return 'mismatch';
  if (c.hashOutcome === 'verified') return 'verified';
  return 'unknown';
}

function problemFor(c: TxCheck, verdict: TxCheck['verdict']): string {
  switch (verdict) {
    case 'mismatch':
      if (c.rowAgreement === 'differs') {
        const first = c.disagreements[0];
        return `the on-chain record and our stored row disagree on ${String(c.disagreements.length)} field(s), starting with \`${first?.field}\`: chain says ${String(first?.payload)}, the book says ${String(first?.row)}`;
      }
      return c.hashProblem ?? 'the fields do not hash to the hash the record carries';
    case 'uncheckable':
      return `the record names rule v=${String(c.payload?.v)}, which this build has no field list for; the row it describes is kept and not judged`;
    case 'pending':
      return 'the transaction is known to the node and has no receipt yet';
    case 'not-found':
      return 'the node answered: no transaction with that hash';
    case 'unreadable':
      return c.decodeProblem ?? 'the transaction is not ours, or its calldata is not a record we can read';
    default:
      return 'nothing was checked, and that is not the same as it passing';
  }
}
