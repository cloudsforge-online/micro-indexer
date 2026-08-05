/**
 * Raw block bytes → the shape `bitcoin.ts` already indexes.
 *
 * ## The seam this file defends
 *
 * `bitcoin.ts` is the part of this service that has been reviewed, tested and reasoned about for
 * reorgs, replace-by-fee and the double-spend invariant, and none of it should change because the
 * transport did. So this file's job is to produce exactly the `RawBtcBlock` that Bitcoin Core's
 * `getblock` verbosity 2 produces, from bytes a stranger sent, and to refuse anything it cannot
 * vouch for.
 *
 * ## The three checks, and what each one stops
 *
 * A block arrives from a peer with no authority behind it whatsoever. Three checks turn it into
 * something safe to index, and each stops a different lie:
 *
 *   1. **The header hashes to the hash we asked for.** Stops a peer answering `getdata` with a
 *      different block than the one requested — which, if it went unnoticed, would file another
 *      block's transactions under our height.
 *   2. **The header's proof of work is valid, and the header is the one our header chain already
 *      accepted at this height.** That check lives in `btcheaders.ts`; the point here is that this
 *      decoder never sees a block whose header was not already committed to.
 *   3. **The merkle root of the decoded transactions equals the header's merkle root.** This is the
 *      one that matters for money. It is what binds the transaction list — the actual amounts and
 *      the actual scripts — to the proof of work. Without it a peer with no hash power could hand
 *      us a valid header and a transaction list of its own invention, and we would credit it.
 *
 * The merkle computation refuses duplicated rows rather than merely computing over them. That is
 * CVE-2012-2459: two different transaction lists can produce one merkle root when the last element
 * of an odd row is duplicated, so a block that only *hashes* correctly is not enough.
 */

import type { RawBtcBlock, RawBtcTx, RawScriptPubKey, RawVin, RawVout } from './bitcoin.ts'
import type { AddressParams } from './btcaddress.ts'
import { scriptToAddress } from './btcaddress.ts'
import { Reader, WireError, dsha256, hashToHex, hexToHash } from './btcwire.ts'

/** Consensus limits, used as allocation bounds so a malformed count cannot exhaust memory. */
const MAX_TX_PER_BLOCK = 1_000_000
const MAX_INPUTS = 1_000_000
const MAX_OUTPUTS = 1_000_000
const MAX_SCRIPT = 4_000_000

export class BlockDecodeError extends Error {
  readonly blockHash: string
  /**
   * The transaction ids this decoder produced, when it produced any.
   *
   * Carried on the error rather than in the message. A merkle mismatch means one transaction in a
   * list of hundreds was read wrongly, and "the root does not match" localises nothing — the only
   * question worth asking next is *which* transaction first differs from the node's, and without
   * this the answer needs the whole decode run again by hand.
   */
  readonly txids: readonly string[]
  constructor(blockHash: string, message: string, txids: readonly string[] = []) {
    super(`${blockHash}: ${message}`)
    this.name = 'BlockDecodeError'
    this.blockHash = blockHash
    this.txids = txids
  }
}

interface DecodedTx {
  readonly tx: RawBtcTx
  /** Every output script, for the filter audit in `btcgcs.verifyOutputScripts`. */
  readonly outputScripts: readonly Buffer[]
}

/**
 * Satoshis → the BTC number Core would have serialised.
 *
 * `bitcoin.ts`'s `btcToSats` recovers the exact integer with `Math.round`, and its header carries
 * the proof that the recovery is exact for every representable amount. This is the inverse of that
 * and is safe for the same reason: satoshi counts up to the 21 million cap are below 2^53, so
 * `Number(sats)` is exact and only the division rounds.
 */
function satsToBtc(sats: bigint): number {
  return Number(sats) / 1e8
}

/**
 * One transaction, segwit-aware.
 *
 * The txid and the wtxid are computed from two different serialisations of the same transaction,
 * and confusing them is the classic segwit bug: the wtxid is what the witness commitment covers,
 * the txid is what the merkle root, every explorer and every row in this service's `transactions`
 * table is keyed by. So the non-witness bytes are reserialised deliberately rather than the
 * original slice being reused.
 */
function decodeTx(r: Reader): DecodedTx {
  const start = r.offset
  const version = r.i32()

  let segwit = false
  let mweb = false
  let inputCount = r.varInt()
  if (inputCount === 0) {
    // A zero input count is impossible in a real transaction, so it is the marker for the extended
    // serialisation. The flag byte that follows says WHICH extensions are present, and it is a bit
    // field rather than a boolean — which is the whole trap here.
    //
    // Bit 0 is segwit. **Bit 3 is Litecoin's MWEB**, and a transaction may carry it with bit 0
    // clear: the HogEx transaction that closes every post-MWEB Litecoin block has flag `0x08`, two
    // ordinary inputs, and no witness stacks at all. Treating any non-zero flag as "segwit" — which
    // is what every Bitcoin-only decoder does, and what this one did — then reads witness stacks
    // that were never written, consumes the following transaction's bytes as witness data, and
    // produces a wrong txid for the last transaction in the block.
    //
    // The merkle check catches it, so it fails loudly rather than crediting anything wrong. But it
    // fails on roughly one Litecoin block in thirty, which is a chain that cannot be followed. The
    // differential harness found this; nothing else would have.
    const flag = r.u8()
    if (flag === 0) throw new WireError('extended transaction flag byte is zero')
    segwit = (flag & 1) !== 0
    mweb = (flag & 8) !== 0
    const known = 1 | 8
    if ((flag & ~known) !== 0) {
      // An unrecognised extension means bytes we do not know how to skip. Refusing is the only
      // safe answer: guessing the length would misparse every following transaction.
      throw new WireError(`unknown transaction serialisation flag 0x${flag.toString(16)}`)
    }
    inputCount = r.varInt()
  }
  if (inputCount > MAX_INPUTS) throw new WireError(`${inputCount} inputs`)
  if (inputCount === 0) throw new WireError('a transaction with no inputs')

  const nonWitness: Buffer[] = []
  const vin: RawVin[] = []
  const rawInputs: { prevTxid: Buffer; index: number; script: Buffer; sequence: number }[] = []
  for (let i = 0; i < inputCount; i++) {
    const prevTxid = r.hash()
    const index = r.u32()
    const script = r.varBytes(MAX_SCRIPT, 'input script')
    const sequence = r.u32()
    rawInputs.push({ prevTxid, index, script, sequence })
  }

  const outputCount = r.countUpTo(MAX_OUTPUTS, 'outputs')
  const vout: RawVout[] = []
  const outputScripts: Buffer[] = []
  const rawOutputs: { value: bigint; script: Buffer }[] = []
  for (let n = 0; n < outputCount; n++) {
    const value = r.u64()
    const script = r.varBytes(MAX_SCRIPT, 'output script')
    rawOutputs.push({ value, script })
    outputScripts.push(script)
  }

  // The witness stacks, one per input. They are consumed but not retained: this service reports
  // movements, and a witness is a spending proof rather than a movement.
  if (segwit) {
    for (let i = 0; i < inputCount; i++) {
      const items = r.countUpTo(MAX_INPUTS, 'witness items')
      for (let j = 0; j < items; j++) r.varBytes(MAX_SCRIPT, 'witness item')
    }
  }

  // The MWEB component, which sits between the witnesses and the locktime. It is serialised as an
  // optional: one presence byte, then the body. In a MINED block the body is always absent — the
  // MWEB data has moved into the block's extension block by then — so the byte is zero and there is
  // nothing to skip.
  //
  // A non-zero byte would be an MWEB transaction body, which this decoder cannot parse and, more
  // to the point, cannot attribute: MWEB amounts are confidential, so there is no deposit in there
  // to observe even if it were parsed. Refusing is correct and is not a limitation worth removing.
  if (mweb) {
    const present = r.u8()
    if (present !== 0) {
      throw new WireError('an MWEB transaction body is confidential and cannot be attributed')
    }
  }

  const locktime = r.u32()
  const end = r.offset

  // Reserialise without the marker, flag and witness. This is the txid preimage.
  const w: Buffer[] = []
  const u32 = (v: number): Buffer => {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32LE(v >>> 0)
    return b
  }
  const i32 = (v: number): Buffer => {
    const b = Buffer.allocUnsafe(4)
    b.writeInt32LE(v)
    return b
  }
  const u64 = (v: bigint): Buffer => {
    const b = Buffer.allocUnsafe(8)
    b.writeBigUInt64LE(v)
    return b
  }
  const varInt = (v: number): Buffer => {
    if (v < 0xfd) return Buffer.from([v])
    if (v <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), u32(v).subarray(0, 2)])
    if (v <= 0xffff_ffff) return Buffer.concat([Buffer.from([0xfe]), u32(v)])
    return Buffer.concat([Buffer.from([0xff]), u64(BigInt(v))])
  }

  w.push(i32(version), varInt(inputCount))
  for (const input of rawInputs) {
    w.push(input.prevTxid, u32(input.index), varInt(input.script.length), input.script, u32(input.sequence))
  }
  w.push(varInt(outputCount))
  for (const output of rawOutputs) {
    w.push(u64(output.value), varInt(output.script.length), output.script)
  }
  w.push(u32(locktime))
  nonWitness.push(...w)

  const stripped = Buffer.concat(nonWitness)
  const txid = hashToHex(dsha256(stripped))
  const full = Buffer.from(r.slice(start, end))
  const wtxid = segwit ? hashToHex(dsha256(full)) : txid

  for (let i = 0; i < rawInputs.length; i++) {
    const input = rawInputs[i] as (typeof rawInputs)[number]
    const prevHex = hashToHex(input.prevTxid)
    // The coinbase input spends the null outpoint: an all-zero txid at index 0xffffffff. Core
    // reports it as a `coinbase` field with no txid, and `bitcoin.ts` keys the whole
    // reward-is-not-a-fee branch on exactly that shape.
    const isCoinbase = i === 0 && input.index === 0xffff_ffff && /^0{64}$/.test(prevHex)
    vin.push(
      isCoinbase
        ? { coinbase: input.script.toString('hex'), sequence: input.sequence }
        : { txid: prevHex, vout: input.index, sequence: input.sequence },
    )
  }

  for (let n = 0; n < rawOutputs.length; n++) {
    const output = rawOutputs[n] as (typeof rawOutputs)[number]
    vout.push({ value: satsToBtc(output.value), n, scriptPubKey: { hex: output.script.toString('hex') } })
  }

  return {
    tx: {
      txid,
      hash: wtxid,
      version,
      size: end - start,
      vin,
      vout,
      locktime,
    },
    outputScripts,
  }
}

/**
 * The merkle root of a transaction list, refusing the duplicated-row construction.
 *
 * CVE-2012-2459 in one sentence: when a row has an odd number of entries the last is paired with
 * itself, so a block with `[A, B, B]` and a block with `[A, B]` produce the same root. A node that
 * only checks the root will accept the first, and the transaction list it then indexes is not the
 * one the proof of work covers. Detecting the duplicate and refusing is the standard mitigation,
 * and it is cheap: one comparison per odd row.
 */
export function merkleRoot(txids: readonly string[]): string {
  if (txids.length === 0) throw new WireError('a block with no transactions')
  let level = txids.map((h) => hexToHash(h))

  while (level.length > 1) {
    const next: Buffer[] = []

    // Pair up the REAL entries first, and refuse any adjacent pair that is identical. That test —
    // and not a test on the final entry of an odd row — is the actual mitigation, because the
    // forgery presents an EVEN row: appending a copy of the last transaction to a three-entry list
    // makes a four-entry list, whose synthetic-looking duplicate is now a genuine adjacent pair.
    // Checking only odd rows misses it entirely, which is precisely the bug this comment exists to
    // stop somebody reintroducing.
    for (let i = 0; i + 1 < level.length; i += 2) {
      const left = level[i] as Buffer
      const right = level[i + 1] as Buffer
      if (left.equals(right)) {
        throw new WireError('merkle tree has an identical adjacent pair (CVE-2012-2459)')
      }
      next.push(dsha256(Buffer.concat([left, right])))
    }

    // An odd row's last entry is paired with ITSELF. That duplication is synthetic — it is how the
    // tree is defined, not something a peer supplied — so it is not a mutation and must not be
    // flagged, or every block with an odd transaction count at any level would be rejected.
    if (level.length % 2 === 1) {
      const last = level[level.length - 1] as Buffer
      next.push(dsha256(Buffer.concat([last, last])))
    }

    level = next
  }
  return hashToHex(level[0] as Buffer)
}

export interface DecodedBlock {
  readonly raw: RawBtcBlock
  /** Every output script in the block, in order, for the compact-filter audit. */
  readonly outputScripts: readonly Buffer[]
  /**
   * Bytes after the transaction list that this decoder did not interpret.
   *
   * Non-zero on every Litecoin block since MWEB activated. Zero on Bitcoin, always — Bitcoin has
   * no extension block, so a non-zero value there is worth an operator's attention even though it
   * cannot corrupt anything, since the merkle root has already proved the transaction list.
   */
  readonly extensionBytes: number
}

/**
 * Decode a `block` message and prove it belongs to the header we asked for.
 *
 * `height` is supplied by the caller from the validated header chain rather than read from the
 * block, because a block does not carry its own height in any form this service should trust —
 * BIP34 puts it in the coinbase script, where a miner writes it, not where consensus checks it for
 * old blocks. The header chain is the authority on height and this decoder does not second-guess
 * it.
 */
export function decodeBlock(
  payload: Buffer,
  expected: { readonly hash: string; readonly height: number },
  params: AddressParams,
): DecodedBlock {
  const r = new Reader(payload)
  const headerBytes = Buffer.from(r.bytes(80))
  const hash = hashToHex(dsha256(headerBytes))
  if (hash !== expected.hash) {
    throw new BlockDecodeError(expected.hash, `peer answered with block ${hash}`)
  }

  const hr = new Reader(headerBytes)
  const version = hr.i32()
  const prevHash = hashToHex(hr.hash())
  const claimedMerkle = hashToHex(hr.hash())
  const time = hr.u32()
  const bits = hr.u32()
  hr.u32() // nonce; the proof of work was checked on the header chain, not here.

  const count = r.countUpTo(MAX_TX_PER_BLOCK, 'transactions')
  const txs: RawBtcTx[] = []
  const outputScripts: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const decoded = decodeTx(r)
    txs.push(decoded.tx)
    outputScripts.push(...decoded.outputScripts)
  }
  // THE MERKLE ROOT IS CHECKED BEFORE ANY JUDGEMENT IS MADE ABOUT LEFTOVER BYTES, and the order
  // matters. An earlier version of this decoder refused any trailing bytes on the reasoning that a
  // surplus means a transaction above was read wrongly. That reasoning is sound for Bitcoin and
  // WRONG for Litecoin: since MWEB activated at height 2,265,984 every Litecoin block carries a
  // MimbleWimble extension block serialised after the transaction list — 172 bytes even when no
  // MWEB transaction occurred, and several kilobytes when one did. The differential harness caught
  // this on the first modern range it was pointed at, which is precisely what it was built for.
  //
  // Checking the merkle root first turns the question from a guess into a proof. If the root
  // computed from the transactions we decoded equals the root the proof of work commits to, then
  // the transaction list was read correctly and completely, and whatever follows it cannot be a
  // misparse of that list. Only then are the remaining bytes recorded as extension data.
  const txids = txs.map((t) => t.txid)
  const computed = merkleRoot(txids)
  if (computed !== claimedMerkle) {
    throw new BlockDecodeError(
      hash,
      `merkle root does not cover the transactions supplied (${txids.length} decoded)`,
      txids,
    )
  }

  // Reported, never interpreted. MWEB outputs are confidential: there is no transparent amount and
  // no address to attribute, so this service records that the extension was present and observes
  // nothing inside it. A peg-in is an ordinary transparent output and IS indexed, because it
  // appears in the transaction list above like any other payment.
  const extensionBytes = r.remaining

  // Addresses are attached only now, once the transactions are known to be the ones the proof of
  // work commits to. Deriving them earlier would mean this service had, however briefly, an
  // address list from an unverified block.
  const withAddresses: RawBtcTx[] = txs.map((tx) => ({
    ...tx,
    vout: tx.vout.map((out) => ({ ...out, scriptPubKey: enrich(out.scriptPubKey, params) })),
  }))

  return {
    raw: {
      hash,
      height: expected.height,
      previousblockhash: prevHash,
      time,
      nTx: txs.length,
      merkleroot: claimedMerkle,
      bits: bits.toString(16).padStart(8, '0'),
      size: payload.length,
      version,
      tx: withAddresses,
    },
    outputScripts,
    extensionBytes,
  }
}

function enrich(script: RawScriptPubKey | undefined, params: AddressParams): RawScriptPubKey {
  const hex = script?.hex ?? ''
  const bytes = Buffer.from(hex, 'hex')
  const address = scriptToAddress(bytes, params)
  return address === null ? { hex } : { hex, address }
}
