/**
 * Addresses ↔ output scripts, for Bitcoin and Litecoin, on both networks.
 *
 * ## Why this file is new work rather than a port
 *
 * `chains.ts` says of Litecoin that this repository "never encodes an address, only reads the one
 * `scriptPubKey.address` the node emits". That was true while the transport was Bitcoin Core
 * JSON-RPC and it stops being true here. A peer sends raw blocks; a raw block contains scripts and
 * no addresses at all. So the encoding this service was careful to avoid owning is now something
 * it must own — in **both** directions:
 *
 *   - **address → script**, because a compact filter is a set of scripts, so the watched addresses
 *     have to become scripts before anything can be matched against them.
 *   - **script → address**, because `address_activity` is keyed by address and every consumer in
 *     the estate — wallet, settlement, the explorer — reads that column.
 *
 * The two directions are written against one table of parameters so they cannot drift. A round
 * trip is asserted in the tests for every address type on every supported network, because the
 * failure mode of a wrong version byte is not an error: it is a valid-looking address on the wrong
 * chain, and on Litecoin's legacy P2SH range it is a Bitcoin address that a user might actually
 * send to.
 *
 * ## What is deliberately refused
 *
 * An address type this file cannot round-trip is refused loudly rather than approximated. Bare
 * multisig and other non-standard scripts have no address and get `null` — the same answer
 * `addressOf` gave when Core produced it, and for the same reason: an unattributable output
 * credited to a plausible address is worse than one credited to nobody. Litecoin's MWEB addresses
 * are refused explicitly, because MWEB outputs are not transparent and an indexer that pretended
 * to watch one would be promising an observation it cannot make.
 */

import { dsha256 } from './btcwire.ts'

export type BtcChain = 'btc' | 'ltc'
export type BtcNetwork = 'mainnet' | 'testnet'

export interface AddressParams {
  /** Version byte for pay-to-public-key-hash. */
  readonly p2pkh: number
  /** Version byte for pay-to-script-hash. */
  readonly p2sh: number
  /**
   * P2SH version bytes accepted on decode but never produced.
   *
   * Litecoin moved P2SH from 0x05 to 0x32 in 2017 precisely because 0x05 collides with Bitcoin's,
   * and it still accepts the old one. Accepting it here means a user who pastes a legacy Litecoin
   * P2SH address is watched rather than rejected; producing only the new one means this service
   * never emits the ambiguous spelling.
   */
  readonly p2shLegacy: readonly number[]
  /** The bech32 human-readable part. */
  readonly hrp: string
  /** HRPs that are valid on this chain but describe something this service cannot observe. */
  readonly opaqueHrps: readonly string[]
  /**
   * Witness versions that are valid on this chain but name no payable address.
   *
   * Litecoin's MWEB uses two witness programs that look exactly like ordinary future segwit
   * outputs and are not: `OP_8 <32>` is `witness_mweb_hogaddr`, the commitment the HogEx
   * transaction carries, and `OP_9 <32>` is `witness_mweb_pegin`, coins moving INTO the
   * confidential pool. Litecoin Core gives neither an address, and neither is a party anyone can
   * be credited as.
   *
   * The differential harness found this: a general bech32m encoder happily turns `OP_8 <32>` into
   * a well-formed `ltc1g...` string, and it is a **plausible wrong answer** — the exact failure
   * this file's header warns about. Crediting an MWEB peg-in to a synthesised address would
   * attribute money to somebody who does not exist, and the string would never match a real watch
   * because no user was ever given one.
   *
   * Empty on Bitcoin, and it must stay empty: Bitcoin has no MWEB, so a version 8 program there is
   * an unrecognised-but-valid future segwit output, and Core does give it a bech32m address.
   */
  readonly unaddressableWitnessVersions: readonly number[]
}

export const ADDRESS_PARAMS: Readonly<Record<BtcChain, Readonly<Record<BtcNetwork, AddressParams>>>> =
  Object.freeze({
    btc: Object.freeze({
      mainnet: Object.freeze({
        p2pkh: 0x00,
        p2sh: 0x05,
        p2shLegacy: [],
        hrp: 'bc',
        opaqueHrps: [],
        unaddressableWitnessVersions: [],
      }),
      testnet: Object.freeze({
        p2pkh: 0x6f,
        p2sh: 0xc4,
        p2shLegacy: [],
        hrp: 'tb',
        opaqueHrps: [],
        unaddressableWitnessVersions: [],
      }),
    }),
    ltc: Object.freeze({
      mainnet: Object.freeze({
        p2pkh: 0x30,
        p2sh: 0x32,
        p2shLegacy: [0x05],
        hrp: 'ltc',
        // MWEB. Confidential by construction: there is no transparent output to observe and no
        // amount to read, so an address here is honestly unobservable rather than unsupported.
        opaqueHrps: ['ltcmweb'],
        unaddressableWitnessVersions: [8, 9],
      }),
      testnet: Object.freeze({
        p2pkh: 0x6f,
        p2sh: 0x3a,
        p2shLegacy: [0xc4],
        hrp: 'tltc',
        opaqueHrps: ['tmweb'],
        unaddressableWitnessVersions: [8, 9],
      }),
    }),
  })

export class AddressError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.name = 'AddressError'
    this.reason = reason
  }
}

/* ------------------------------------------------------------------ base58check */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_INDEX: ReadonlyMap<string, number> = new Map([...B58].map((c, i) => [c, i]))

export function base58Encode(payload: Uint8Array): string {
  let n = 0n
  for (const b of payload) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    const rem = Number(n % 58n)
    out = (B58[rem] as string) + out
    n /= 58n
  }
  // Leading zero bytes are not represented by the arithmetic above and must be restored one '1'
  // each, or every mainnet P2PKH address loses its leading '1' and decodes to a different hash.
  for (const b of payload) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

export function base58Decode(text: string): Buffer {
  let n = 0n
  for (const ch of text) {
    const v = B58_INDEX.get(ch)
    if (v === undefined) throw new AddressError('base58_char', `'${ch}' is not a base58 character`)
    n = n * 58n + BigInt(v)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const ch of text) {
    if (ch !== '1') break
    bytes.unshift(0)
  }
  return Buffer.from(bytes)
}

export function base58CheckEncode(version: number, payload: Uint8Array): string {
  const body = Buffer.concat([Buffer.from([version]), Buffer.from(payload)])
  return base58Encode(Buffer.concat([body, dsha256(body).subarray(0, 4)]))
}

export function base58CheckDecode(text: string): { version: number; payload: Buffer } {
  const raw = base58Decode(text)
  if (raw.length < 5) throw new AddressError('base58_short', 'base58check payload is too short')
  const body = raw.subarray(0, raw.length - 4)
  const checksum = raw.subarray(raw.length - 4)
  if (!dsha256(body).subarray(0, 4).equals(checksum)) {
    throw new AddressError('base58_checksum', 'base58check checksum does not match')
  }
  return { version: body[0] as number, payload: Buffer.from(body.subarray(1)) }
}

/* ------------------------------------------------------------------ bech32 / bech32m */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const CHARSET_INDEX: ReadonlyMap<string, number> = new Map([...CHARSET].map((c, i) => [c, i]))
const BECH32_CONST = 1
const BECH32M_CONST = 0x2bc830a3

function polymod(values: readonly number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ff_ffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i] as number
    }
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5)
  out.push(0)
  for (const c of hrp) out.push(c.charCodeAt(0) & 31)
  return out
}

/**
 * Regroup bits, as bech32 needs between its 5-bit characters and 8-bit payload.
 *
 * The padding rules are the security-relevant part and are enforced rather than assumed: on the
 * way in, leftover bits must be zero and fewer than 8, or two distinct character strings decode to
 * one address. That is the flaw that made several early implementations accept malleable
 * addresses.
 */
function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new AddressError('bech32_range', 'value out of range')
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new AddressError('bech32_padding', 'bech32 payload has non-zero padding')
  }
  return out
}

function bech32Encode(hrp: string, data: readonly number[], constant: number): string {
  const values = [...hrpExpand(hrp), ...data]
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ constant
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d] as string).join('')}`
}

interface Bech32Decoded {
  readonly hrp: string
  readonly data: readonly number[]
  readonly bech32m: boolean
}

function bech32Decode(text: string): Bech32Decoded {
  // Mixed case is refused outright. The checksum is defined over one case, so a mixed string is
  // either a transcription error or an attempt to make two spellings of one address.
  const lower = text.toLowerCase()
  const upper = text.toUpperCase()
  if (text !== lower && text !== upper) {
    throw new AddressError('bech32_mixed_case', 'a bech32 address must not mix case')
  }
  if (lower.length < 8 || lower.length > 108) {
    throw new AddressError('bech32_length', 'bech32 length is out of range')
  }
  const split = lower.lastIndexOf('1')
  if (split < 1 || split + 7 > lower.length) {
    throw new AddressError('bech32_separator', 'bech32 separator is missing or misplaced')
  }
  const hrp = lower.slice(0, split)
  const data: number[] = []
  for (const ch of lower.slice(split + 1)) {
    const v = CHARSET_INDEX.get(ch)
    if (v === undefined) throw new AddressError('bech32_char', `'${ch}' is not a bech32 character`)
    data.push(v)
  }
  const mod = polymod([...hrpExpand(hrp), ...data])
  const bech32m = mod === BECH32M_CONST
  if (mod !== BECH32_CONST && !bech32m) {
    throw new AddressError('bech32_checksum', 'bech32 checksum does not match')
  }
  return { hrp, data: data.slice(0, data.length - 6), bech32m }
}

/* ------------------------------------------------------------------ scripts */

const OP_DUP = 0x76
const OP_HASH160 = 0xa9
const OP_EQUAL = 0x87
const OP_EQUALVERIFY = 0x88
const OP_CHECKSIG = 0xac
const OP_0 = 0x00
const OP_1 = 0x51
const OP_16 = 0x60
export const OP_RETURN = 0x6a

/**
 * The address a script pays, or null when it pays no single identifiable party.
 *
 * Null is a normal answer and never an error. `bitcoin.ts` already documents why: an OP_RETURN
 * pays nobody and a bare multisig pays several, so attributing either to one address would be a
 * plausible wrong answer that every downstream consumer would believe.
 *
 * Witness programs of version 1 and above are encoded with bech32m and, crucially, are **not
 * decoded further**. A version-1 32-byte program is a Taproot output today; a version-2 program is
 * something not yet defined. Encoding by version and length rather than by an assumed meaning is
 * what makes this function still correct after the next soft fork.
 */
export function scriptToAddress(script: Uint8Array, params: AddressParams): string | null {
  // P2PKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
  if (
    script.length === 25 &&
    script[0] === OP_DUP &&
    script[1] === OP_HASH160 &&
    script[2] === 20 &&
    script[23] === OP_EQUALVERIFY &&
    script[24] === OP_CHECKSIG
  ) {
    return base58CheckEncode(params.p2pkh, script.subarray(3, 23))
  }

  // P2SH: OP_HASH160 <20> OP_EQUAL
  if (script.length === 23 && script[0] === OP_HASH160 && script[1] === 20 && script[22] === OP_EQUAL) {
    return base58CheckEncode(params.p2sh, script.subarray(2, 22))
  }

  // Witness program: a version opcode, then a single push of 2..40 bytes, and nothing else.
  if (script.length >= 4 && script.length <= 42) {
    const op = script[0] as number
    const isVersion = op === OP_0 || (op >= OP_1 && op <= OP_16)
    const pushLen = script[1] as number
    if (isVersion && pushLen >= 2 && pushLen <= 40 && script.length === pushLen + 2) {
      const version = op === OP_0 ? 0 : op - (OP_1 - 1)
      // Version 0 has exactly two defined lengths. Anything else at version 0 is not a valid
      // witness program and has no address, rather than an address nobody can spend from.
      if (version === 0 && pushLen !== 20 && pushLen !== 32) return null
      // Litecoin's MWEB peg scripts. They are shaped exactly like a future segwit output and name
      // nobody: encoding one would invent a payee. See `unaddressableWitnessVersions`.
      if (params.unaddressableWitnessVersions.includes(version) && pushLen === 32) return null
      const words = [version, ...convertBits([...script.subarray(2)], 8, 5, true)]
      return bech32Encode(params.hrp, words, version === 0 ? BECH32_CONST : BECH32M_CONST)
    }
  }

  return null
}

export interface DecodedAddress {
  readonly script: Buffer
  readonly kind: 'p2pkh' | 'p2sh' | 'witness'
  /** Witness version, for witness programs only. */
  readonly witnessVersion?: number
}

/**
 * An address → the output script that pays it.
 *
 * This is what turns a watched address into something a compact filter can be asked about, so a
 * silent failure here is a deposit that is never seen. Every refusal therefore carries a reason
 * code, and `btcp2p.ts` surfaces those rather than dropping the address from the watch set: an
 * address that cannot be watched must make the chain refuse for that user, not quietly succeed.
 */
export function addressToScript(address: string, params: AddressParams): DecodedAddress {
  const trimmed = address.trim()
  if (trimmed.length === 0) throw new AddressError('empty', 'an address must not be empty')

  const lower = trimmed.toLowerCase()
  const sep = lower.lastIndexOf('1')
  const maybeHrp = sep > 0 ? lower.slice(0, sep) : ''
  if (params.opaqueHrps.includes(maybeHrp)) {
    throw new AddressError(
      'opaque',
      `${maybeHrp} addresses are confidential; there is no transparent output to observe`,
    )
  }

  if (maybeHrp === params.hrp) {
    const decoded = bech32Decode(trimmed)
    const [version, ...rest] = decoded.data
    if (version === undefined) throw new AddressError('bech32_empty', 'no witness version')
    if (version > 16) throw new AddressError('witness_version', `witness version ${version}`)
    // The checksum variant is not cosmetic: version 0 uses bech32 and every later version uses
    // bech32m. A version-0 address that checksums as bech32m is a corruption, not an alternative
    // spelling, and accepting it would watch a script nobody is paying.
    if (version === 0 && decoded.bech32m) {
      throw new AddressError('bech32_variant', 'a version 0 address must use bech32, not bech32m')
    }
    if (version > 0 && !decoded.bech32m) {
      throw new AddressError('bech32_variant', 'a version 1+ address must use bech32m')
    }
    const program = convertBits(rest, 5, 8, false)
    if (program.length < 2 || program.length > 40) {
      throw new AddressError('witness_length', `witness program of ${program.length} bytes`)
    }
    // The mirror of the refusal in `scriptToAddress`. A user cannot be handed one of these as a
    // deposit address, so accepting it here would register a watch that can never match — silence
    // rather than a refusal, which is the outcome this codebase spends the most effort avoiding.
    if (params.unaddressableWitnessVersions.includes(version) && program.length === 32) {
      throw new AddressError(
        'opaque',
        `witness version ${version} is an MWEB peg script and names no payable party`,
      )
    }
    if (version === 0 && program.length !== 20 && program.length !== 32) {
      throw new AddressError('witness_length', 'a version 0 program must be 20 or 32 bytes')
    }
    const opcode = version === 0 ? OP_0 : OP_1 + (version - 1)
    const script = Buffer.from([opcode, program.length, ...program])
    return { script, kind: 'witness', witnessVersion: version }
  }

  const { version, payload } = base58CheckDecode(trimmed)
  if (payload.length !== 20) {
    throw new AddressError('hash_length', `a base58 address payload must be 20 bytes`)
  }
  if (version === params.p2pkh) {
    return {
      script: Buffer.from([OP_DUP, OP_HASH160, 20, ...payload, OP_EQUALVERIFY, OP_CHECKSIG]),
      kind: 'p2pkh',
    }
  }
  if (version === params.p2sh || params.p2shLegacy.includes(version)) {
    return { script: Buffer.from([OP_HASH160, 20, ...payload, OP_EQUAL]), kind: 'p2sh' }
  }
  throw new AddressError(
    'version_byte',
    `version byte 0x${version.toString(16)} is not valid on this chain and network`,
  )
}

export function paramsFor(chain: BtcChain, network: BtcNetwork): AddressParams {
  return ADDRESS_PARAMS[chain][network]
}
