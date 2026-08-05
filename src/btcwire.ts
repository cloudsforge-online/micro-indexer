/**
 * The Bitcoin peer-to-peer wire format. Framing, the primitive encodings, and the handful of
 * messages this service actually speaks.
 *
 * ## Why this file exists at all
 *
 * `rpc.ts` talks to a node somebody else runs. Every deposit this estate credits therefore rests
 * on a third party's honesty and their uptime, and the owner has refused that. The replacement is
 * to speak Bitcoin's own protocol, outbound-dialled, to peers we choose — which works through NAT
 * and needs no inbound port, and so survives the tunnel-only ingress the estate actually has.
 *
 * What is deliberately NOT here: the crypto. There is none. Bitcoin's wire protocol is plaintext,
 * its checksum is a double SHA-256 and `node:crypto` has SHA-256. This file adds no dependency,
 * which is the point — a protocol decoder is exactly the kind of thing this estate writes itself
 * (see hearth's own EVM and RLP), and a decoder is also exactly the kind of thing that must never
 * be trusted to guess. Every read here is bounds-checked and every length is bounded, because the
 * bytes arrive from a stranger.
 *
 * ## The threat model of a decoder
 *
 * A peer is hostile until proven otherwise, and it controls every byte on this socket. So:
 *
 *   - **Every read is bounds-checked.** `Reader` throws `WireError` rather than returning a short
 *     value or `undefined`. A decoder that returns a plausible value for truncated input is how a
 *     malformed block becomes a wrong balance.
 *   - **Every count is bounded before it is allocated.** `readVarInt` is used for array lengths, so
 *     an unbounded count is a peer that makes this process allocate until it dies. Callers pass a
 *     maximum and the maximum is a protocol fact, never a guess.
 *   - **The payload length is bounded at the frame.** `MAX_PAYLOAD` is the ceiling Bitcoin Core
 *     itself enforces; anything above it is disconnected without being buffered.
 */

import { createHash } from 'node:crypto'

/** Bitcoin Core's `MAX_PROTOCOL_MESSAGE_LENGTH`. A frame claiming more is a peer to drop. */
export const MAX_PAYLOAD = 4 * 1_000_000

/** The frame header: magic(4) + command(12) + length(4) + checksum(4). */
export const HEADER_SIZE = 24

/** Anything this service sends declares this. 70016 is BIP339 (wtxid relay), which Core expects. */
export const PROTOCOL_VERSION = 70_016

/** Service bits. Only the three this service reasons about are named. */
export const NODE_NETWORK = 1n << 0n
export const NODE_WITNESS = 1n << 3n
/**
 * `NODE_COMPACT_FILTERS`, BIP157's service bit — the one that decides whether a peer is any use.
 *
 * Bitcoin Core builds the filter index only under `-blockfilterindex=1` and serves it only under
 * `-peerblockfilters=1`, and **both default off**, so most of the network cannot answer
 * `getcfilters` at all. Litecoin Core defaults both ON since v0.21.3, which is why Litecoin is the
 * easier of the pair despite arriving second. `btcpool.ts` will not keep a peer that lacks this.
 */
export const NODE_COMPACT_FILTERS = 1n << 6n

/** Inventory type codes. The witness variants are what a segwit-aware peer must ask for. */
export const MSG_TX = 1
export const MSG_BLOCK = 2
export const MSG_WITNESS_TX = 0x4000_0001
export const MSG_WITNESS_BLOCK = 0x4000_0002

/** BIP158's only defined filter type. */
export const FILTER_TYPE_BASIC = 0

/** A peer sent bytes this decoder will not vouch for. Always a disconnect, never a retry. */
export class WireError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WireError'
  }
}

export function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

/** Bitcoin's hash: SHA-256 applied twice. Used for txids, block hashes and frame checksums. */
export function dsha256(data: Uint8Array): Buffer {
  return sha256(sha256(data))
}

/**
 * A 32-byte hash as Bitcoin displays it: reversed, then hex.
 *
 * The reversal is not cosmetic. On the wire a block hash is little-endian; every explorer, every
 * `getblockhash` answer and every row already in this service's `blocks` table is the big-endian
 * spelling. Mixing the two produces a hash that matches nothing and looks entirely plausible.
 */
export function hashToHex(hash: Uint8Array): string {
  if (hash.length !== 32) throw new WireError(`a hash must be 32 bytes, got ${hash.length}`)
  return Buffer.from(hash).reverse().toString('hex')
}

/** The inverse of `hashToHex`. Throws rather than truncating, because a short hash is a bug. */
export function hexToHash(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new WireError(`not a 32-byte hex hash: ${hex.length} chars`)
  return Buffer.from(hex, 'hex').reverse()
}

/* ------------------------------------------------------------------ reading */

/**
 * A bounds-checked cursor over a peer's bytes.
 *
 * Every method throws `WireError` on underrun. That is the whole design: the alternative — a read
 * that returns zero, or undefined, or a truncated buffer — turns a malformed message into a
 * confidently wrong decode, and this decoder's output becomes money.
 */
export class Reader {
  readonly #buf: Buffer
  #at: number

  constructor(buf: Buffer, at = 0) {
    this.#buf = buf
    this.#at = at
  }

  get offset(): number {
    return this.#at
  }

  get remaining(): number {
    return this.#buf.length - this.#at
  }

  get exhausted(): boolean {
    return this.#at >= this.#buf.length
  }

  #need(n: number): void {
    if (n < 0 || this.#at + n > this.#buf.length) {
      throw new WireError(`short read: wanted ${n} at ${this.#at} of ${this.#buf.length}`)
    }
  }

  bytes(n: number): Buffer {
    this.#need(n)
    const out = this.#buf.subarray(this.#at, this.#at + n)
    this.#at += n
    return out
  }

  u8(): number {
    this.#need(1)
    const v = this.#buf.readUInt8(this.#at)
    this.#at += 1
    return v
  }

  u16(): number {
    this.#need(2)
    const v = this.#buf.readUInt16LE(this.#at)
    this.#at += 2
    return v
  }

  u32(): number {
    this.#need(4)
    const v = this.#buf.readUInt32LE(this.#at)
    this.#at += 4
    return v
  }

  i32(): number {
    this.#need(4)
    const v = this.#buf.readInt32LE(this.#at)
    this.#at += 4
    return v
  }

  u64(): bigint {
    this.#need(8)
    const v = this.#buf.readBigUInt64LE(this.#at)
    this.#at += 8
    return v
  }

  i64(): bigint {
    this.#need(8)
    const v = this.#buf.readBigInt64LE(this.#at)
    this.#at += 8
    return v
  }

  /** A 32-byte hash in wire order. Returned as-is; `hashToHex` is what reverses it. */
  hash(): Buffer {
    return Buffer.from(this.bytes(32))
  }

  /**
   * A window over already-read bytes, by absolute offset.
   *
   * Exists for exactly one caller: a segwit transaction's wtxid is the hash of the *whole*
   * serialisation, marker and witness included, which is only knowable once the transaction has
   * been read to its end. Re-reading it would mean decoding twice; recording the start and end and
   * slicing is the same bytes with none of the second decode's chances to differ from the first.
   */
  slice(from: number, to: number): Buffer {
    if (from < 0 || to > this.#buf.length || from > to) {
      throw new WireError(`slice ${from}..${to} is outside the buffer`)
    }
    return this.#buf.subarray(from, to)
  }

  /**
   * A CompactSize.
   *
   * Values above `Number.MAX_SAFE_INTEGER` are refused rather than silently rounded — a length
   * that has lost precision is a length that indexes the wrong byte.
   */
  varInt(): number {
    const first = this.u8()
    if (first < 0xfd) return first
    if (first === 0xfd) return this.u16()
    if (first === 0xfe) return this.u32()
    const big = this.u64()
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WireError('a compact size exceeded the safe integer range')
    }
    return Number(big)
  }

  /**
   * A CompactSize used as an array length, refused above `max`.
   *
   * The caller always passes a protocol maximum. A count read from a stranger and then used to
   * size an allocation is the classic remote memory exhaustion, and "it will be small in practice"
   * is not a bound.
   */
  countUpTo(max: number, what: string): number {
    const n = this.varInt()
    if (n > max) throw new WireError(`${what}: ${n} exceeds the maximum of ${max}`)
    return n
  }

  varBytes(max: number, what: string): Buffer {
    const n = this.countUpTo(max, what)
    return Buffer.from(this.bytes(n))
  }

  varString(max: number, what: string): string {
    return this.varBytes(max, what).toString('utf8')
  }
}

/* ------------------------------------------------------------------ writing */

export class Writer {
  #parts: Buffer[] = []
  #length = 0

  #push(b: Buffer): this {
    this.#parts.push(b)
    this.#length += b.length
    return this
  }

  get length(): number {
    return this.#length
  }

  bytes(b: Uint8Array): this {
    return this.#push(Buffer.from(b))
  }

  u8(v: number): this {
    const b = Buffer.allocUnsafe(1)
    b.writeUInt8(v)
    return this.#push(b)
  }

  u16(v: number): this {
    const b = Buffer.allocUnsafe(2)
    b.writeUInt16LE(v)
    return this.#push(b)
  }

  /** Big-endian, and used for exactly one thing: the port in a network address. */
  u16be(v: number): this {
    const b = Buffer.allocUnsafe(2)
    b.writeUInt16BE(v)
    return this.#push(b)
  }

  u32(v: number): this {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32LE(v)
    return this.#push(b)
  }

  i32(v: number): this {
    const b = Buffer.allocUnsafe(4)
    b.writeInt32LE(v)
    return this.#push(b)
  }

  u64(v: bigint): this {
    const b = Buffer.allocUnsafe(8)
    b.writeBigUInt64LE(v)
    return this.#push(b)
  }

  i64(v: bigint): this {
    const b = Buffer.allocUnsafe(8)
    b.writeBigInt64LE(v)
    return this.#push(b)
  }

  varInt(v: number): this {
    if (!Number.isInteger(v) || v < 0) throw new WireError(`compact size ${v} is not a count`)
    if (v < 0xfd) return this.u8(v)
    if (v <= 0xffff) return this.u8(0xfd).u16(v)
    if (v <= 0xffff_ffff) return this.u8(0xfe).u32(v)
    return this.u8(0xff).u64(BigInt(v))
  }

  varBytes(b: Uint8Array): this {
    return this.varInt(b.length).bytes(b)
  }

  varString(s: string): this {
    return this.varBytes(Buffer.from(s, 'utf8'))
  }

  done(): Buffer {
    return Buffer.concat(this.#parts, this.#length)
  }
}

/* ------------------------------------------------------------------ framing */

export interface WireMessage {
  readonly command: string
  readonly payload: Buffer
}

/**
 * Frame one message.
 *
 * The command is twelve bytes, null-padded. A longer one is a programming error here rather than
 * a peer's fault, so it throws instead of truncating — a truncated command is a message the peer
 * silently ignores, which presents as an unexplained stall.
 */
export function encodeMessage(magic: number, command: string, payload: Buffer): Buffer {
  if (command.length > 12) throw new WireError(`command ${command} exceeds 12 bytes`)
  const header = Buffer.alloc(HEADER_SIZE)
  header.writeUInt32LE(magic >>> 0, 0)
  header.write(command, 4, 12, 'ascii')
  header.writeUInt32LE(payload.length, 16)
  dsha256(payload).copy(header, 20, 0, 4)
  return Buffer.concat([header, payload], HEADER_SIZE + payload.length)
}

export interface DecodedFrame {
  readonly message: WireMessage
  /** Bytes consumed. The caller keeps the remainder for the next call. */
  readonly consumed: number
}

/**
 * Pull one message off a stream buffer, or `null` when the frame is not yet whole.
 *
 * Three things are refused rather than tolerated, and each has a reason a lenient decoder would
 * have got wrong:
 *
 *   - **A wrong magic.** It means the stream is desynchronised or the peer is on another network.
 *     Resynchronising by scanning for the next magic is what a lenient decoder does; it is also how
 *     a peer feeds this process a message body of its choosing. Disconnect instead.
 *   - **An oversized length.** Refused before a single byte is buffered.
 *   - **A bad checksum.** The payload is corrupt or forged. There is no partial credit.
 */
export function decodeFrame(buf: Buffer, magic: number): DecodedFrame | null {
  if (buf.length < HEADER_SIZE) return null
  const gotMagic = buf.readUInt32LE(0)
  if (gotMagic !== (magic >>> 0)) {
    throw new WireError(`wrong network magic ${gotMagic.toString(16)}`)
  }
  const length = buf.readUInt32LE(16)
  if (length > MAX_PAYLOAD) throw new WireError(`frame claims ${length} bytes`)
  if (buf.length < HEADER_SIZE + length) return null

  const payload = buf.subarray(HEADER_SIZE, HEADER_SIZE + length)
  const want = buf.subarray(20, 24)
  const got = dsha256(payload).subarray(0, 4)
  if (!got.equals(want)) throw new WireError('frame checksum mismatch')

  // The command is null-padded ASCII. Anything after the first NUL is padding; anything
  // non-printable before it is a peer being creative, and is refused.
  let end = 4
  while (end < 16 && buf[end] !== 0) end += 1
  const command = buf.toString('ascii', 4, end)
  if (!/^[a-z0-9]{1,12}$/.test(command)) throw new WireError('frame carries a non-ascii command')

  return {
    message: { command, payload: Buffer.from(payload) },
    consumed: HEADER_SIZE + length,
  }
}

/* ------------------------------------------------------------------ version */

export interface VersionPayload {
  readonly version: number
  readonly services: bigint
  readonly timestamp: bigint
  readonly userAgent: string
  readonly startHeight: number
  readonly relay: boolean
}

/**
 * The `version` we send.
 *
 * `relay = false` is deliberate and load-bearing. It tells the peer not to push us its mempool
 * (BIP37's `fRelay`), which this service has no use for: a deposit is credited at a confirmation
 * depth, never at zero confirmations, so unconfirmed transactions are bandwidth spent on something
 * that can never become a credit. It also makes the outbound peer set cheaper, which is what lets
 * us keep more of them — and more peers is the whole eclipse defence.
 *
 * The addresses are written as all-zero. A peer that believed our advertised address would gossip
 * it, and this node is behind a tunnel with no inbound port: an address we cannot be reached at is
 * a lie told to the whole network, and it also invites the exact inbound traffic we cannot serve.
 */
export function encodeVersion(args: {
  readonly services: bigint
  readonly nonce: bigint
  readonly userAgent: string
  readonly startHeight: number
  readonly timestamp: bigint
  readonly remotePort: number
}): Buffer {
  const w = new Writer()
  w.i32(PROTOCOL_VERSION)
  w.u64(args.services)
  w.i64(args.timestamp)
  // addr_recv: services, then a 16-byte IPv6-mapped address, then the port.
  w.u64(0n).bytes(Buffer.alloc(16)).u16be(args.remotePort)
  // addr_from: zeroes throughout. See the note above — we are not reachable and will not claim to be.
  w.u64(0n).bytes(Buffer.alloc(16)).u16be(0)
  w.u64(args.nonce)
  w.varString(args.userAgent)
  w.i32(args.startHeight)
  w.u8(0)
  return w.done()
}

export function decodeVersion(payload: Buffer): VersionPayload {
  const r = new Reader(payload)
  const version = r.i32()
  const services = r.u64()
  const timestamp = r.i64()
  r.bytes(26) // addr_recv
  r.bytes(26) // addr_from
  r.u64() // nonce
  const userAgent = r.varString(256, 'user agent')
  const startHeight = r.i32()
  // `relay` is absent on peers below 70001, and its absence means true. Reading a missing byte as
  // false would silently disable transaction relay against an old peer.
  const relay = r.remaining >= 1 ? r.u8() !== 0 : true
  return { version, services, timestamp, userAgent, startHeight, relay }
}

/* ------------------------------------------------------------------ headers */

/** A block header, exactly the 80 bytes on the wire plus the hash they produce. */
export interface BlockHeader {
  readonly hash: string
  readonly prevHash: string
  readonly merkleRoot: string
  readonly version: number
  readonly time: number
  readonly bits: number
  readonly nonce: number
  /** The 80 raw bytes. Kept because the proof-of-work check hashes them, not the fields. */
  readonly raw: Buffer
}

export const HEADER_BYTES = 80

/** Core's `MAX_HEADERS_RESULTS`. A peer sending more is not being generous, it is being hostile. */
export const MAX_HEADERS_PER_MESSAGE = 2_000

export function decodeHeader(raw: Buffer): BlockHeader {
  if (raw.length !== HEADER_BYTES) {
    throw new WireError(`a header is ${HEADER_BYTES} bytes, got ${raw.length}`)
  }
  const r = new Reader(raw)
  const version = r.i32()
  const prev = r.hash()
  const merkle = r.hash()
  const time = r.u32()
  const bits = r.u32()
  const nonce = r.u32()
  return {
    hash: hashToHex(dsha256(raw)),
    prevHash: hashToHex(prev),
    merkleRoot: hashToHex(merkle),
    version,
    time,
    bits,
    nonce,
    raw: Buffer.from(raw),
  }
}

/**
 * A `headers` message.
 *
 * Each entry is 80 bytes followed by a transaction count that is always zero — a historical
 * artefact of `headers` reusing the block serialiser. It is read and discarded, but it must be
 * read or every header after the first is misaligned by one byte, which decodes as garbage rather
 * than as an error.
 */
export function decodeHeaders(payload: Buffer): readonly BlockHeader[] {
  const r = new Reader(payload)
  const count = r.countUpTo(MAX_HEADERS_PER_MESSAGE, 'headers')
  const out: BlockHeader[] = []
  for (let i = 0; i < count; i++) {
    out.push(decodeHeader(Buffer.from(r.bytes(HEADER_BYTES))))
    r.varInt()
  }
  return out
}

/**
 * `getheaders`. The locator is a sparse, exponentially-spaced walk back from our tip.
 *
 * Sparse rather than "our tip only" because the peer answers from the first locator hash it
 * recognises: if we are on a branch it abandoned, a single-hash locator gets us nothing and the
 * sync silently stops, whereas the exponential walk finds the fork within a few dozen entries.
 */
export function encodeGetHeaders(locator: readonly string[], stop: string | null): Buffer {
  const w = new Writer()
  w.u32(PROTOCOL_VERSION)
  w.varInt(locator.length)
  for (const h of locator) w.bytes(hexToHash(h))
  w.bytes(stop ? hexToHash(stop) : Buffer.alloc(32))
  return w.done()
}

/* ------------------------------------------------------------------ inv / getdata */

export interface InvItem {
  readonly type: number
  readonly hash: string
}

/** Core's `MAX_INV_SZ`. */
export const MAX_INV_ITEMS = 50_000

export function decodeInv(payload: Buffer): readonly InvItem[] {
  const r = new Reader(payload)
  const count = r.countUpTo(MAX_INV_ITEMS, 'inv')
  const out: InvItem[] = []
  for (let i = 0; i < count; i++) {
    const type = r.u32()
    out.push({ type, hash: hashToHex(r.hash()) })
  }
  return out
}

export function encodeInv(items: readonly InvItem[]): Buffer {
  const w = new Writer()
  w.varInt(items.length)
  for (const item of items) {
    w.u32(item.type)
    w.bytes(hexToHash(item.hash))
  }
  return w.done()
}

export const encodeGetData = encodeInv

/* ------------------------------------------------------------------ BIP157 */

/**
 * Core's `MAX_GETCFILTERS_SIZE` and `MAX_GETCFHEADERS_SIZE`.
 *
 * These are not advice. `PrepareBlockFilterRequest` sets `fDisconnect` when a request exceeds
 * them, so asking for one filter too many does not produce an error message — it produces a peer
 * that vanishes, which is far harder to diagnose. `btcpeer.ts` chunks to these.
 */
export const MAX_GETCFILTERS = 1_000
export const MAX_GETCFHEADERS = 2_000

export function encodeGetCFilters(startHeight: number, stopHash: string): Buffer {
  const w = new Writer()
  w.u8(FILTER_TYPE_BASIC)
  w.u32(startHeight)
  w.bytes(hexToHash(stopHash))
  return w.done()
}

export const encodeGetCFHeaders = encodeGetCFilters

export function encodeGetCFCheckpt(stopHash: string): Buffer {
  const w = new Writer()
  w.u8(FILTER_TYPE_BASIC)
  w.bytes(hexToHash(stopHash))
  return w.done()
}

export interface CFilterMessage {
  readonly filterType: number
  readonly blockHash: string
  readonly filter: Buffer
}

export function decodeCFilter(payload: Buffer): CFilterMessage {
  const r = new Reader(payload)
  const filterType = r.u8()
  const blockHash = hashToHex(r.hash())
  // A filter is bounded by the block it describes; `MAX_PAYLOAD` is the real ceiling and the frame
  // decoder has already applied it.
  const filter = r.varBytes(MAX_PAYLOAD, 'cfilter')
  return { filterType, blockHash, filter }
}

export interface CFHeadersMessage {
  readonly filterType: number
  readonly stopHash: string
  readonly previousFilterHeader: string
  /** Filter *hashes*, in height order. The headers are the running chain over them. */
  readonly filterHashes: readonly string[]
}

export function decodeCFHeaders(payload: Buffer): CFHeadersMessage {
  const r = new Reader(payload)
  const filterType = r.u8()
  const stopHash = hashToHex(r.hash())
  const previousFilterHeader = hashToHex(r.hash())
  const count = r.countUpTo(MAX_GETCFHEADERS, 'cfheaders')
  const filterHashes: string[] = []
  for (let i = 0; i < count; i++) filterHashes.push(hashToHex(r.hash()))
  return { filterType, stopHash, previousFilterHeader, filterHashes }
}

export interface CFCheckptMessage {
  readonly filterType: number
  readonly stopHash: string
  /** One filter header per 1000 blocks, at heights 1000, 2000, ... */
  readonly headers: readonly string[]
}

/** Core's cap on checkpoint entries: the chain length divided by the 1000-block interval. */
const MAX_CHECKPOINTS = 100_000

export function decodeCFCheckpt(payload: Buffer): CFCheckptMessage {
  const r = new Reader(payload)
  const filterType = r.u8()
  const stopHash = hashToHex(r.hash())
  const count = r.countUpTo(MAX_CHECKPOINTS, 'cfcheckpt')
  const headers: string[] = []
  for (let i = 0; i < count; i++) headers.push(hashToHex(r.hash()))
  return { filterType, stopHash, headers }
}

/**
 * The filter header chain: `dsha256(filterHash || previousFilterHeader)`.
 *
 * This is the whole of BIP157's authentication, and it is worth being precise about what it does
 * and does not buy. It makes a peer's filters *self-consistent and comparable*: two peers that
 * disagree about any filter must produce different headers from that height on, so the
 * disagreement is detectable at O(1) and resolvable by downloading the one block and recomputing.
 *
 * What it does NOT buy: any commitment from the chain itself. No block header commits to a filter
 * header, and BIP157 explicitly declined to add one because that needs a consensus change. So a
 * set of peers that ALL lie identically is undetectable by this mechanism, and the only defence
 * left is that they are not all the same party — which is why `btcpool.ts` treats peer diversity
 * as a correctness property rather than a nicety.
 */
export function filterHeader(filterHash: string, previousHeader: string): string {
  const w = Buffer.concat([hexToHash(filterHash), hexToHash(previousHeader)])
  return hashToHex(dsha256(w))
}

/** The hash of a filter is the double SHA-256 of its serialised bytes. */
export function filterHash(filter: Uint8Array): string {
  return hashToHex(dsha256(filter))
}
