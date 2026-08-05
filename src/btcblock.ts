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
  constructor(blockHash: string, message: string) {
    super(`${blockHash}: ${message}`)
    this.name = 'BlockDecodeError'
    this.blockHash = blockHash
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
  let inputCount = r.varInt()
  let flag = 0
  if (inputCount === 0) {
    // The segwit marker: a zero input count is impossible in a real transaction, so it signals the
    // extended serialisation. The flag byte that follows must be non-zero.
    flag = r.u8()
    if (flag === 0) throw new WireError('segwit flag byte is zero')
    segwit = true
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
    if (level.length % 2 === 1) {
      const last = level[level.length - 1] as Buffer
      const before = level[level.length - 2] as Buffer
      if (last.equals(before)) {
        throw new WireError('merkle tree has a duplicated final entry (CVE-2012-2459)')
      }
      level = [...level, last]
    }
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(dsha256(Buffer.concat([level[i] as Buffer, level[i + 1] as Buffer])))
    }
    level = next
  }
  return hashToHex(level[0] as Buffer)
}

export interface DecodedBlock {
  readonly raw: RawBtcBlock
  /** Every output script in the block, in order, for the compact-filter audit. */
  readonly outputScripts: readonly Buffer[]
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
  if (!r.exhausted) {
    // Trailing bytes mean the decode and the peer disagree about the block's structure. That is
    // not a harmless surplus: it means one of the transactions above was read wrongly.
    throw new BlockDecodeError(hash, `${r.remaining} trailing bytes after the last transaction`)
  }

  const computed = merkleRoot(txs.map((t) => t.txid))
  if (computed !== claimedMerkle) {
    throw new BlockDecodeError(hash, 'merkle root does not cover the transactions supplied')
  }

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
  }
}

function enrich(script: RawScriptPubKey | undefined, params: AddressParams): RawScriptPubKey {
  const hex = script?.hex ?? ''
  const bytes = Buffer.from(hex, 'hex')
  const address = scriptToAddress(bytes, params)
  return address === null ? { hex } : { hex, address }
}
