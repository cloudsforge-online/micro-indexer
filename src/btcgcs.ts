/**
 * BIP158 compact block filters: SipHash-2-4, Golomb-Rice decoding, and set membership.
 *
 * ## What a compact filter is, and what it is for
 *
 * For each block the miner's peers can compute a small probabilistic set containing every script
 * that block touched — every output's `scriptPubKey`, and every input's *prevout* `scriptPubKey`.
 * A client that holds a set of watched scripts asks "does this block's filter match any of mine",
 * and downloads the block only when the answer is yes. For this estate that is exactly the
 * question and nothing more: **did anything arrive at, or leave, one of our addresses.**
 *
 * The numbers make the case on their own. At 200 watched addresses the filter for a block is about
 * 18 KB against a block of about 1.5 MB, and a false positive costs one unnecessary block
 * download. See `FALSE_POSITIVE_RATE` below for the arithmetic on how often that is.
 *
 * ## The one thing this cannot do, stated plainly
 *
 * A **correct** filter never produces a false negative: BIP158 guarantees that every script the
 * block touched is in the set. But nothing in the block header commits to the filter, so a peer
 * that simply builds a filter with our script left out produces a filter that is well-formed,
 * decodes cleanly, and silently hides a user's deposit. No confirmation depth rescues that — the
 * deposit is never seen at any depth.
 *
 * The defences are therefore not in this file. They are: (1) filter *headers* chained across
 * peers, so two peers cannot disagree undetectably (`btcwire.filterHeader`); (2) peer diversity,
 * so agreement means something (`btcpool.ts`); and (3) a random audit that downloads whole blocks
 * and checks the filter really did contain their output scripts (`verifyOutputScripts` here).
 * Together those turn "one lying peer" from a lost deposit into a detected and banned peer.
 */

import { Reader, WireError, hexToHash } from './btcwire.ts'

/**
 * BIP158's parameters for the basic filter, and they are not tunable.
 *
 * `P` is the Golomb-Rice parameter (the remainder width in bits) and `M` scales the range each
 * element is hashed into. They are consensus-of-convention: a decoder using different values
 * decodes the same bytes into a completely different set, quietly.
 */
export const GCS_P = 19
export const GCS_M = 784_931n

/**
 * The chance one filter falsely matches one watched script in one block: `1 / M`.
 *
 * With 200 watched scripts that is 200/784931 ≈ 2.5e-4 per block, so about 0.037 blocks a day on
 * Bitcoin and 13-14 spurious block downloads a year — roughly 21 MB. The cost of a false positive
 * is bandwidth and nothing else: the block is downloaded, examined, and found to contain nothing
 * of ours. It cannot produce a wrong credit, because the credit is decided from the block's actual
 * contents and never from the filter.
 */
export const FALSE_POSITIVE_RATE = 1 / Number(GCS_M)

/* ------------------------------------------------------------------ SipHash-2-4 */

const MASK64 = (1n << 64n) - 1n

function rotl(v: bigint, n: bigint): bigint {
  return ((v << n) | (v >> (64n - n))) & MASK64
}

/**
 * SipHash-2-4, the keyed hash BIP158 specifies.
 *
 * Written here rather than taken from a dependency because it is forty lines of arithmetic with no
 * secrets in it: the key is a public block hash, so this is a *placement* function, not a
 * cryptographic protection, and there is no key material to leak or side channel to worry about.
 * The estate already writes keccak and secp256k1 by hand in hearth; this is far below that bar.
 *
 * BigInt rather than 32-bit limb pairs. The workload is ~5000 hashes per matched block plus 200
 * per block scanned, which at 144 blocks a day is nothing, and limb arithmetic is where a subtle
 * carry bug would live undetected until it silently failed to match a real deposit.
 */
export function sipHash24(k0: bigint, k1: bigint, data: Uint8Array): bigint {
  let v0 = (0x736f6d6570736575n ^ k0) & MASK64
  let v1 = (0x646f72616e646f6dn ^ k1) & MASK64
  let v2 = (0x6c7967656e657261n ^ k0) & MASK64
  let v3 = (0x7465646279746573n ^ k1) & MASK64

  const round = (): void => {
    v0 = (v0 + v1) & MASK64
    v1 = rotl(v1, 13n) ^ v0
    v0 = rotl(v0, 32n)
    v2 = (v2 + v3) & MASK64
    v3 = rotl(v3, 16n) ^ v2
    v0 = (v0 + v3) & MASK64
    v3 = rotl(v3, 21n) ^ v0
    v2 = (v2 + v1) & MASK64
    v1 = rotl(v1, 17n) ^ v2
    v2 = rotl(v2, 32n)
  }

  const len = data.length
  const blocks = len - (len % 8)
  for (let i = 0; i < blocks; i += 8) {
    let m = 0n
    for (let j = 7; j >= 0; j--) m = (m << 8n) | BigInt(data[i + j] as number)
    v3 ^= m
    round()
    round()
    v0 ^= m
  }

  // The final block is the remaining bytes, little-endian, with the low byte of the length in the
  // top byte. That length byte is what makes SipHash's padding unambiguous.
  let last = BigInt(len & 0xff) << 56n
  for (let i = len - 1; i >= blocks; i--) {
    last |= BigInt(data[i] as number) << BigInt((i - blocks) * 8)
  }
  v3 ^= last
  round()
  round()
  v0 ^= last

  v2 ^= 0xffn
  round()
  round()
  round()
  round()
  return (v0 ^ v1 ^ v2 ^ v3) & MASK64
}

/**
 * A script's position in the filter's range, per BIP158's `hash_to_range`.
 *
 * The key is the first 16 bytes of the block hash **in wire order** — that is, the reverse of the
 * hex an explorer shows. Getting that backwards produces a decoder that never matches anything and
 * never errors, which is the worst possible failure for a deposit watcher: total silence.
 */
export function hashToRange(key: Buffer, data: Uint8Array, f: bigint): bigint {
  const k0 = key.readBigUInt64LE(0)
  const k1 = key.readBigUInt64LE(8)
  return (sipHash24(k0, k1, data) * f) >> 64n
}

/** The 16-byte SipHash key for a block, from its display hash. */
export function filterKeyFor(blockHashHex: string): Buffer {
  return hexToHash(blockHashHex).subarray(0, 16)
}

/* ------------------------------------------------------------------ bit reading */

/** Reads bits most-significant-first, which is the order Golomb-Rice is written in. */
class BitReader {
  readonly #buf: Buffer
  #bit = 0

  constructor(buf: Buffer) {
    this.#buf = buf
  }

  get exhausted(): boolean {
    return this.#bit >= this.#buf.length * 8
  }

  bit(): number {
    const byte = this.#bit >> 3
    if (byte >= this.#buf.length) throw new WireError('golomb stream ended mid-value')
    const v = ((this.#buf[byte] as number) >> (7 - (this.#bit & 7))) & 1
    this.#bit += 1
    return v
  }

  bits(n: number): bigint {
    let out = 0n
    for (let i = 0; i < n; i++) out = (out << 1n) | BigInt(this.bit())
    return out
  }
}

/**
 * Decode one Golomb-Rice value: a unary quotient, then `P` remainder bits.
 *
 * The quotient is bounded. It is written as that many 1-bits, so an unbounded read is a peer
 * sending a megabyte of 1s and this process looping on it — the bound turns a denial of service
 * into a `WireError` and a disconnect. The ceiling is generous: a quotient this large cannot occur
 * in a well-formed filter, because deltas are bounded by the range the elements were hashed into.
 */
const MAX_QUOTIENT = 1 << 20

function golombDecode(r: BitReader, p: number): bigint {
  let q = 0
  while (r.bit() === 1) {
    q += 1
    if (q > MAX_QUOTIENT) throw new WireError('golomb quotient is implausibly large')
  }
  return (BigInt(q) << BigInt(p)) + r.bits(p)
}

/* ------------------------------------------------------------------ the filter */

/**
 * A decoded BIP158 filter: the sorted set of 64-bit positions the block's scripts hash to.
 *
 * Held as a sorted `BigUint64Array` rather than a `Set` for two reasons. It is a third of the
 * memory of a `Set<bigint>`, which matters when the box has 8 GB free and forty containers on it;
 * and matching a sorted query set against a sorted filter is one linear pass rather than N hash
 * lookups, which is what makes `matchAny` cheap enough to run on every block.
 */
export class CompactFilter {
  readonly blockHash: string
  readonly #values: BigUint64Array
  readonly #key: Buffer
  readonly #f: bigint

  private constructor(blockHash: string, values: BigUint64Array, key: Buffer, f: bigint) {
    this.blockHash = blockHash
    this.#values = values
    this.#key = key
    this.#f = f
  }

  get size(): number {
    return this.#values.length
  }

  /**
   * Decode the serialised filter for a block.
   *
   * `n` is read as a CompactSize and bounded. A block cannot contain more scripts than it has
   * bytes to spell them in, so `MAX_ELEMENTS` is set from the consensus block size limit rather
   * than picked: it is impossible to exceed honestly, and refusing above it stops a peer claiming
   * a hundred million elements and making this process allocate for them.
   */
  static decode(blockHash: string, serialised: Buffer): CompactFilter {
    const MAX_ELEMENTS = 4_000_000
    const r = new Reader(serialised)
    const n = r.countUpTo(MAX_ELEMENTS, 'filter elements')
    const f = BigInt(n) * GCS_M
    const values = new BigUint64Array(n)
    const bits = new BitReader(serialised.subarray(r.offset))

    let last = 0n
    for (let i = 0; i < n; i++) {
      last += golombDecode(bits, GCS_P)
      values[i] = last
    }
    return new CompactFilter(blockHash, values, filterKeyFor(blockHash), f)
  }

  /** Where one script would sit in this filter's range. */
  positionOf(script: Uint8Array): bigint {
    return hashToRange(this.#key, script, this.#f)
  }

  /** Is this exact script in the set? A single-element `matchAny`. */
  match(script: Uint8Array): boolean {
    return this.#has(this.positionOf(script))
  }

  /**
   * Does the filter match ANY of these scripts?
   *
   * The query set is hashed, sorted, and walked in step with the filter — one pass over both, so
   * the cost is O(n + m) rather than O(n log m). An empty query is `false` and not an error: a
   * scope with nothing watched matches nothing, which is the honest answer and not a reason to
   * stop following the chain.
   */
  matchAny(scripts: readonly Uint8Array[]): boolean {
    if (scripts.length === 0 || this.#values.length === 0) return false
    const wanted = scripts.map((s) => this.positionOf(s)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    let i = 0
    let j = 0
    while (i < wanted.length && j < this.#values.length) {
      const a = wanted[i] as bigint
      const b = this.#values[j] as bigint
      if (a === b) return true
      if (a < b) i += 1
      else j += 1
    }
    return false
  }

  /** Which of these scripts the filter matched. Used to log what a match was actually about. */
  matched(scripts: readonly Uint8Array[]): readonly Uint8Array[] {
    return scripts.filter((s) => this.match(s))
  }

  #has(target: bigint): boolean {
    let lo = 0
    let hi = this.#values.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const v = this.#values[mid] as bigint
      if (v === target) return true
      if (v < target) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }
}

/**
 * The audit. Every output script in this block must be present in this block's filter.
 *
 * This is the check that makes a lying peer expensive. A filter that omits a script is exactly how
 * a deposit is silently lost, and it is otherwise undetectable — no block header commits to a
 * filter, so a well-formed lie decodes perfectly. But if we hold the block, we can recompute what
 * the filter was obliged to contain and see the omission.
 *
 * **The check is deliberately one-sided.** It covers output scripts, which we can read straight
 * out of the block, and NOT the prevout scripts of inputs, which would need a UTXO set this
 * service does not keep and will not build. So it proves the filter did not hide an incoming
 * payment, and says nothing about whether it hid a spend. That asymmetry is the right way round:
 * a hidden deposit is a user's money never credited, whereas a hidden spend is the estate's own
 * outgoing transaction, which the estate already knows about because it signed it.
 *
 * `btcpool.ts` runs this on every block it downloads — matches and random audits alike — so the
 * audit rate is not a policy knob that can be turned to zero by accident.
 */
export function verifyOutputScripts(
  filter: CompactFilter,
  outputScripts: readonly Uint8Array[],
): { readonly ok: boolean; readonly missing: number } {
  let missing = 0
  for (const script of outputScripts) {
    // BIP158 excludes empty scripts and everything beginning OP_RETURN from the filter, so their
    // absence is correct and counting it would fail every honest peer on the first block.
    if (script.length === 0 || script[0] === 0x6a) continue
    if (!filter.match(script)) missing += 1
  }
  return { ok: missing === 0, missing }
}
