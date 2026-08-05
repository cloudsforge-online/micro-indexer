/**
 * The Bitcoin peer-protocol stack, tested against a real block from a real chain.
 *
 * ## Why the fixture is what it is
 *
 * `testdata/ltc-2000000.json` is Litecoin mainnet block 2,000,000, pulled from the estate's **own
 * fully-validating node** — the same node that will act as ground truth for the light client. It
 * carries the raw block, the compact filter Litecoin Core computed for it, that filter's header,
 * the previous block's filter header, and every txid, output script and address Core itself
 * derived.
 *
 * That makes these tests something better than unit tests of my own arithmetic. Each one asserts
 * that this implementation produces **byte-identical output to Bitcoin Core** for a block that
 * really happened:
 *
 *   - the block decoder must recover Core's 43 txids and Core's merkle root from 138 KB of raw
 *     bytes, which exercises segwit's two serialisations and the coinbase's null outpoint;
 *   - the address encoder must produce Core's address string for every output, which is the check
 *     that the version bytes and the bech32 variant are right — and a wrong version byte produces a
 *     valid-looking address on the wrong chain rather than an error;
 *   - the GCS decoder must find every one of Core's output scripts in Core's own filter, which is
 *     the check that SipHash, the range mapping and the Golomb-Rice decoding all agree with the
 *     encoder that produced those bytes.
 *
 * A silent disagreement in any of those is a deposit that is never seen, so none of it is left to
 * a hand-written expectation.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  ADDRESS_PARAMS,
  AddressError,
  addressToScript,
  base58CheckDecode,
  base58CheckEncode,
  paramsFor,
  scriptToAddress,
} from './btcaddress.ts'
import { decodeBlock, merkleRoot } from './btcblock.ts'
import { CompactFilter, sipHash24, verifyOutputScripts } from './btcgcs.ts'
import {
  MAX_GETCFILTERS,
  Reader,
  WireError,
  Writer,
  decodeCFHeaders,
  decodeFrame,
  decodeHeaders,
  encodeMessage,
  filterHash,
  filterHeader,
  hashToHex,
  hexToHash,
} from './btcwire.ts'

interface Fixture {
  readonly height: number
  readonly blockHash: string
  readonly previousBlockHash: string
  readonly merkleRoot: string
  readonly time: number
  readonly nTx: number
  readonly filter: string
  readonly filterHeader: string
  readonly previousFilterHeader: string
  readonly rawBlock: string
  readonly outputScripts: readonly string[]
  readonly outputAddresses: readonly (string | null)[]
  readonly txids: readonly string[]
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('./testdata/ltc-2000000.json', import.meta.url), 'utf8'),
) as Fixture

const LTC_MAIN = paramsFor('ltc', 'mainnet')

/* ------------------------------------------------------------------ SipHash */

describe('sipHash24', () => {
  // The reference vectors from the SipHash paper: key 000102...0f, input 00,01,...  Getting this
  // wrong produces a filter matcher that never matches and never errors, which is the single worst
  // failure mode available to a deposit watcher — total, plausible silence.
  const k0 = 0x0706050403020100n
  const k1 = 0x0f0e0d0c0b0a0908n

  it('matches the reference vector for the empty input', () => {
    assert.equal(sipHash24(k0, k1, new Uint8Array(0)), 0x726fdb47dd0e0e31n)
  })

  it('matches the reference vector for a one-byte input', () => {
    assert.equal(sipHash24(k0, k1, Uint8Array.from([0x00])), 0x74f839c593dc67fdn)
  })

  it('matches the reference vector for an eight-byte input, which crosses the block boundary', () => {
    const input = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    assert.equal(sipHash24(k0, k1, input), 0x93f5f5799a932462n)
  })

  it('matches the reference vector for a fifteen-byte input', () => {
    const input = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    assert.equal(sipHash24(k0, k1, input), 0xa129ca6149be45e5n)
  })
})

/* ------------------------------------------------------------------ addresses */

describe('addresses', () => {
  // BIP173's own vectors, which pin the bech32 encoding against the specification rather than
  // against this implementation's opinion of it.
  it('encodes and decodes the BIP173 P2WPKH vector on Bitcoin mainnet', () => {
    const params = paramsFor('btc', 'mainnet')
    const address = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
    const { script } = addressToScript(address, params)
    assert.equal(script.toString('hex'), '0014751e76e8199196d454941c45d1b3a323f1433bd6')
    assert.equal(scriptToAddress(script, params), address)
  })

  it('encodes and decodes the BIP173 P2WSH vector on Bitcoin mainnet', () => {
    const params = paramsFor('btc', 'mainnet')
    const address = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'
    const { script } = addressToScript(address, params)
    assert.equal(
      script.toString('hex'),
      '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262',
    )
    assert.equal(scriptToAddress(script, params), address)
  })

  it('round-trips the genesis coinbase P2PKH address', () => {
    const params = paramsFor('btc', 'mainnet')
    const address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
    const { script, kind } = addressToScript(address, params)
    assert.equal(kind, 'p2pkh')
    assert.equal(script.toString('hex'), '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac')
    assert.equal(scriptToAddress(script, params), address)
  })

  it('round-trips a Taproot address with bech32m', () => {
    const params = paramsFor('btc', 'mainnet')
    // BIP086's first derived address.
    const address = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'
    const { script, witnessVersion } = addressToScript(address, params)
    assert.equal(witnessVersion, 1)
    assert.equal(script[0], 0x51)
    assert.equal(scriptToAddress(script, params), address)
  })

  it('refuses a version 0 address that carries a bech32m checksum', () => {
    // The two variants are not alternative spellings. A version 0 program checksummed as bech32m is
    // a corruption, and accepting it would watch a script nobody is paying to.
    const params = paramsFor('btc', 'mainnet')
    assert.throws(
      () => addressToScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', params),
      (err: unknown) => err instanceof AddressError,
    )
  })

  it('refuses a mixed-case bech32 address', () => {
    const params = paramsFor('btc', 'mainnet')
    assert.throws(
      () => addressToScript('bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', params),
      (err: unknown) => err instanceof AddressError && err.reason === 'bech32_mixed_case',
    )
  })

  it('refuses a Bitcoin mainnet address on Bitcoin testnet', () => {
    // The one that must never pass. A mainnet P2PKH accepted under btc:testnet is a watch on an
    // address the user does not control, and a deposit that never arrives.
    assert.throws(
      () => addressToScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', paramsFor('btc', 'testnet')),
      (err: unknown) => err instanceof AddressError && err.reason === 'version_byte',
    )
  })

  it('accepts a legacy Litecoin P2SH address but never produces one', () => {
    // Litecoin moved P2SH from 0x05 to 0x32 because 0x05 collides with Bitcoin's, and still accepts
    // the old spelling. A user who pastes the old one must be watched, not rejected.
    const params = paramsFor('ltc', 'mainnet')
    const legacy = base58CheckEncode(0x05, Buffer.alloc(20, 0x11))
    const { script, kind } = addressToScript(legacy, params)
    assert.equal(kind, 'p2sh')
    const produced = scriptToAddress(script, params) as string
    assert.notEqual(produced, legacy)
    assert.equal(base58CheckDecode(produced).version, 0x32)
    // Both spellings must resolve to the same script, or the two would be watched separately.
    assert.deepEqual(addressToScript(produced, params).script, script)
  })

  it('refuses an MWEB address as unobservable rather than unsupported', () => {
    // There is no transparent output to watch. Refusing with a reason is what lets the chain answer
    // `asset_not_observable` for that address instead of silently watching nothing.
    assert.throws(
      () => addressToScript('ltcmweb1qq' + 'q'.repeat(100), paramsFor('ltc', 'mainnet')),
      (err: unknown) => err instanceof AddressError && err.reason === 'opaque',
    )
  })

  it('gives no address to an OP_RETURN or a bare multisig', () => {
    const params = paramsFor('btc', 'mainnet')
    assert.equal(scriptToAddress(Buffer.from('6a0401020304', 'hex'), params), null)
    assert.equal(scriptToAddress(Buffer.from('51210201020304', 'hex'), params), null)
  })

  it('keeps every chain and network pair distinct', () => {
    // A collision here would mean one address string is valid on two of the estate's scopes, which
    // is the exact defect `chains.ts` records for XRP and must not be reintroduced.
    const seen = new Map<string, string>()
    for (const chain of ['btc', 'ltc'] as const) {
      for (const network of ['mainnet', 'testnet'] as const) {
        const params = ADDRESS_PARAMS[chain][network]
        for (const [kind, version] of [
          ['p2pkh', params.p2pkh],
          ['p2sh', params.p2sh],
        ] as const) {
          const address = base58CheckEncode(version, Buffer.alloc(20, 0x22))
          const key = `${address}`
          const previous = seen.get(key)
          // btc:testnet and ltc:testnet genuinely share 0x6f for P2PKH — that is Litecoin's own
          // choice and not something this code may paper over. It is asserted so the collision is
          // a recorded fact rather than a surprise: a testnet address alone does not identify the
          // chain, which is why every query in this repository carries `(chain, network)`.
          if (previous !== undefined) {
            assert.equal(kind, 'p2pkh')
            assert.ok(previous.endsWith(':testnet'), `${key} collides across ${previous}`)
          }
          seen.set(key, `${chain}:${network}`)
        }
      }
    }
  })
})

/* ------------------------------------------------------------------ framing */

describe('wire framing', () => {
  const MAGIC = 0xfbc0b6db

  it('round-trips a message', () => {
    const payload = Buffer.from('hello wire', 'utf8')
    const frame = encodeMessage(MAGIC, 'verack', payload)
    const decoded = decodeFrame(frame, MAGIC)
    assert.ok(decoded)
    assert.equal(decoded.message.command, 'verack')
    assert.deepEqual(decoded.message.payload, payload)
    assert.equal(decoded.consumed, frame.length)
  })

  it('returns null for a partial frame rather than guessing', () => {
    const frame = encodeMessage(MAGIC, 'block', Buffer.alloc(64, 7))
    assert.equal(decodeFrame(frame.subarray(0, 20), MAGIC), null)
    assert.equal(decodeFrame(frame.subarray(0, frame.length - 1), MAGIC), null)
  })

  it('refuses a frame from another network rather than resynchronising', () => {
    const frame = encodeMessage(0xf9beb4d9, 'verack', Buffer.alloc(0))
    assert.throws(() => decodeFrame(frame, MAGIC), (err: unknown) => err instanceof WireError)
  })

  it('refuses a corrupted payload', () => {
    const frame = encodeMessage(MAGIC, 'headers', Buffer.alloc(8, 3))
    frame[frame.length - 1] = 0xff
    assert.throws(() => decodeFrame(frame, MAGIC), (err: unknown) => err instanceof WireError)
  })

  it('bounds every count it reads from a peer', () => {
    // A count read from a stranger and used to size an allocation is the classic remote memory
    // exhaustion. `countUpTo` is the only way this codebase reads one.
    const w = new Writer()
    w.varInt(5_000_000)
    assert.throws(
      () => new Reader(w.done()).countUpTo(MAX_GETCFILTERS, 'cfilters'),
      (err: unknown) => err instanceof WireError,
    )
  })

  it('refuses a short read instead of returning a truncated value', () => {
    const r = new Reader(Buffer.from([1, 2, 3]))
    assert.throws(() => r.u32(), (err: unknown) => err instanceof WireError)
  })

  it('reverses hashes between wire order and display order', () => {
    const display = fixture.blockHash
    assert.equal(hashToHex(hexToHash(display)), display)
    // The wire form is the reverse. Mixing the two produces a hash that matches nothing and looks
    // entirely plausible, which is why this is asserted rather than assumed.
    assert.notEqual(hexToHash(display).toString('hex'), display)
  })

  it('decodes an empty headers message', () => {
    const w = new Writer()
    w.varInt(0)
    assert.deepEqual(decodeHeaders(w.done()), [])
  })

  it('decodes a cfheaders message', () => {
    const w = new Writer()
    w.u8(0)
    w.bytes(hexToHash(fixture.blockHash))
    w.bytes(hexToHash(fixture.previousFilterHeader))
    w.varInt(1)
    w.bytes(hexToHash(filterHash(Buffer.from(fixture.filter, 'hex'))))
    const decoded = decodeCFHeaders(w.done())
    assert.equal(decoded.stopHash, fixture.blockHash)
    assert.equal(decoded.previousFilterHeader, fixture.previousFilterHeader)
    assert.equal(decoded.filterHashes.length, 1)
  })
})

/* ------------------------------------------------------------------ the real block */

describe('block decoding against a real Litecoin block', () => {
  const raw = Buffer.from(fixture.rawBlock, 'hex')

  it('recovers exactly the transaction ids Litecoin Core reports', () => {
    const decoded = decodeBlock(raw, { hash: fixture.blockHash, height: fixture.height }, LTC_MAIN)
    assert.equal(decoded.raw.tx.length, fixture.nTx)
    assert.deepEqual(
      decoded.raw.tx.map((t) => t.txid),
      fixture.txids,
    )
  })

  it('recovers the header fields the node reports', () => {
    const decoded = decodeBlock(raw, { hash: fixture.blockHash, height: fixture.height }, LTC_MAIN)
    assert.equal(decoded.raw.hash, fixture.blockHash)
    assert.equal(decoded.raw.previousblockhash, fixture.previousBlockHash)
    assert.equal(decoded.raw.merkleroot, fixture.merkleRoot)
    assert.equal(decoded.raw.time, fixture.time)
  })

  it('derives exactly the addresses Litecoin Core derives, for every output', () => {
    // The check that the version bytes and the bech32 variant are right. A wrong version byte is
    // not an error: it is a valid-looking address on the wrong chain.
    const decoded = decodeBlock(raw, { hash: fixture.blockHash, height: fixture.height }, LTC_MAIN)
    const ours = decoded.raw.tx.flatMap((t) => t.vout.map((o) => o.scriptPubKey?.address ?? null))
    assert.deepEqual(ours, fixture.outputAddresses)
  })

  it('refuses a block whose merkle root does not cover its transactions', () => {
    // The check that binds the amounts and the scripts to the proof of work. Without it a peer with
    // no hash power could supply a valid header and a transaction list of its own invention.
    const tampered = Buffer.from(raw)
    // Flip a byte in the middle of the transaction list, well past the 80-byte header. Whether it
    // lands in an amount, a script or a length, the result must be a refusal: either the decode
    // fails outright or the merkle root no longer covers what was decoded. What must NOT happen is
    // a clean decode of different money.
    const at = Math.floor(tampered.length / 2)
    tampered.writeUInt8(tampered.readUInt8(at) ^ 0x01, at)
    assert.throws(
      () => decodeBlock(tampered, { hash: fixture.blockHash, height: fixture.height }, LTC_MAIN),
      /merkle root|trailing|short read|golomb|transaction/i,
    )
  })

  it('refuses a block answered under the wrong hash', () => {
    const wrong = fixture.previousBlockHash
    assert.throws(
      () => decodeBlock(raw, { hash: wrong, height: fixture.height }, LTC_MAIN),
      /peer answered with block/,
    )
  })

  it('refuses the CVE-2012-2459 duplicated final entry', () => {
    // `[A, B, B]` and `[A, B]` produce the same merkle root. A node that only checks the root
    // accepts the first, and then indexes a transaction list the proof of work does not cover.
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    assert.throws(() => merkleRoot([a, b, b]), /CVE-2012-2459/)
    // The honest odd-length case still works: the duplication only matters when the last two
    // entries were already equal.
    assert.equal(merkleRoot([a, b, 'c'.repeat(64)]).length, 64)
  })

  it('computes the merkle root of a single-transaction block as that transaction', () => {
    const only = fixture.txids[0] as string
    assert.equal(merkleRoot([only]), only)
  })
})

/* ------------------------------------------------------------------ the real filter */

describe('BIP158 against the filter Litecoin Core computed', () => {
  const serialised = Buffer.from(fixture.filter, 'hex')

  it('chains to exactly the filter header the node reports', () => {
    // This is BIP157's whole authentication mechanism. If this arithmetic is wrong, two honest
    // peers appear to disagree and the client bans the network.
    assert.equal(
      filterHeader(filterHash(serialised), fixture.previousFilterHeader),
      fixture.filterHeader,
    )
  })

  it('decodes to a set whose size matches the block it describes', () => {
    const filter = CompactFilter.decode(fixture.blockHash, serialised)
    assert.ok(filter.size > 0)
    // BIP158 deduplicates, so the set is at most the scripts the block touched and never more.
    assert.ok(filter.size <= fixture.outputScripts.length + 4_000)
  })

  it('contains every output script in the block except the OP_RETURNs', () => {
    // The audit that makes a lying peer detectable, run here against a filter known to be honest.
    // If this fails, the audit would reject every genuine peer.
    const filter = CompactFilter.decode(fixture.blockHash, serialised)
    const scripts = fixture.outputScripts.map((hex) => Buffer.from(hex, 'hex'))
    const { ok, missing } = verifyOutputScripts(filter, scripts)
    assert.equal(missing, 0)
    assert.ok(ok)
  })

  it('excludes OP_RETURN outputs, as BIP158 requires', () => {
    const filter = CompactFilter.decode(fixture.blockHash, serialised)
    const opReturns = fixture.outputScripts
      .map((hex) => Buffer.from(hex, 'hex'))
      .filter((s) => s.length > 0 && s[0] === 0x6a)
    assert.ok(opReturns.length > 0, 'the fixture block must contain a witness commitment')
    for (const script of opReturns) assert.equal(filter.match(script), false)
  })

  it('matches when a watched address is paid, and reports which', () => {
    const filter = CompactFilter.decode(fixture.blockHash, serialised)
    const paid = fixture.outputAddresses.find((a): a is string => a !== null) as string
    const { script } = addressToScript(paid, LTC_MAIN)
    assert.ok(filter.matchAny([script]))
    assert.equal(filter.matched([script]).length, 1)
  })

  it('does not match an address the block never touched', () => {
    // The false positive rate is 1/784931 per script, so a handful of unrelated scripts matching
    // would mean the decoder is wrong rather than that we got unlucky.
    const filter = CompactFilter.decode(fixture.blockHash, serialised)
    const strangers = Array.from({ length: 64 }, (_unused, i) =>
      addressToScript(base58CheckEncode(LTC_MAIN.p2pkh, Buffer.alloc(20, i + 1)), LTC_MAIN).script,
    )
    assert.equal(filter.matchAny(strangers), false)
  })

  it('answers false for an empty watch set rather than throwing', () => {
    // A scope with nothing watched matches nothing. That is the honest answer and not a reason to
    // stop following the chain.
    const filter = CompactFilter.decode(fixture.blockHash, serialised)
    assert.equal(filter.matchAny([]), false)
  })

  it('refuses a filter whose golomb stream is truncated', () => {
    const truncated = serialised.subarray(0, serialised.length - 8)
    assert.throws(
      () => CompactFilter.decode(fixture.blockHash, truncated),
      (err: unknown) => err instanceof WireError,
    )
  })

  it('decodes to a different set under a different block key', () => {
    // The key is the block hash, so the same bytes describe a different set for a different block.
    // A client that mixed the two up would match nothing and report nothing, silently.
    const wrongKey = CompactFilter.decode(fixture.previousBlockHash, serialised)
    const scripts = fixture.outputScripts.map((hex) => Buffer.from(hex, 'hex')).slice(0, 32)
    const { missing } = verifyOutputScripts(wrongKey, scripts)
    assert.ok(missing > 0, 'the filter key must depend on the block hash')
  })
})
