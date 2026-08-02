/**
 * A fake Bitcoin Core JSON-RPC node that serves a UTXO chain and can rewrite its own history.
 *
 * The counterpart of `fakechain.ts`, and it exists for the same reason: you cannot ask a node to
 * reorganise, and waiting for one on testnet is not a test. What it adds over the EVM fake is the
 * part that is Bitcoin — it tracks a real UTXO set, so a transaction must spend outputs that
 * actually exist, and a replacement chain can therefore spend the SAME outpoints as the chain it
 * replaced. That is a replace-by-fee, and it is the only way to drive the conflicted-out path
 * honestly rather than by asserting on a hand-written row.
 *
 * Hashes are deterministic in `(fork, height)` and txids in `(fork, height, index)`, so a rewritten
 * block necessarily differs from what it replaced and assertions can name a history.
 *
 * Not a test file: no `.test.ts` suffix, so `node --test src/*.test.ts` does not run it.
 */

import { createHash } from 'node:crypto'
import { HttpError, type HttpClient, type RequestOptions } from '@cloudsforge/http'
import { JsonRpcFault } from './fakechain.ts'

export interface Outpoint {
  readonly txid: string
  readonly vout: number
}

export interface OutputSpec {
  readonly address: string | null
  /** Satoshis. The fake converts to the BTC number Core would have serialised. */
  readonly sats: bigint
}

export interface BtcTxSpec {
  readonly inputs: readonly Outpoint[]
  readonly outputs: readonly OutputSpec[]
  /** Force a txid, so a test can re-mine the same transaction on the replacement chain. */
  readonly txid?: string
  /** BIP-125 opt-in. Drives `raw_ref.rbf` and nothing else. */
  readonly rbf?: boolean
}

interface FakeVin {
  readonly txid?: string
  readonly vout?: number
  readonly coinbase?: string
  readonly sequence: number
}

interface FakeVout {
  readonly value: number
  readonly n: number
  readonly scriptPubKey: { readonly address?: string; readonly type: string }
}

interface FakeTx {
  readonly txid: string
  readonly hash: string
  readonly version: number
  readonly size: number
  readonly vsize: number
  readonly weight: number
  readonly locktime: number
  readonly vin: readonly FakeVin[]
  readonly vout: readonly FakeVout[]
}

interface FakeBtcBlock {
  readonly hash: string
  readonly height: number
  readonly previousblockhash?: string
  readonly time: number
  readonly nTx: number
  readonly merkleroot: string
  readonly bits: string
  readonly size: number
  readonly weight: number
  readonly version: number
  readonly tx: readonly FakeTx[]
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

/** Satoshis → the BTC number Core would serialise. The inverse of `btcToSats`. */
export function satsToBtcNumber(sats: bigint): number {
  return Number(sats) / 1e8
}

export interface FakeBitcoinOptions {
  /** What `getblockchaininfo.chain` reports. */
  readonly coreChain?: string
  readonly startTime?: number
  readonly blockSeconds?: number
  /** A node too old for `getblock <hash> 3`, forcing the prevout-resolution fallback. */
  readonly supportsVerbosityThree?: boolean
  /** Reward paid to the coinbase, in satoshis. */
  readonly subsidySats?: bigint
  readonly minerAddress?: string
}

export class FakeBitcoinNode {
  readonly coreChain: string
  readonly supportsVerbosityThree: boolean
  readonly #blocks: FakeBtcBlock[] = []
  /** Every transaction ever mined on any history, for `getrawtransaction`. */
  readonly #txs = new Map<string, FakeTx>()
  readonly #startTime: number
  readonly #blockSeconds: number
  readonly #subsidySats: bigint
  readonly #minerAddress: string
  #fork = 0
  readonly calls: string[] = []

  constructor(options: FakeBitcoinOptions = {}) {
    this.coreChain = options.coreChain ?? 'test'
    this.supportsVerbosityThree = options.supportsVerbosityThree ?? true
    this.#startTime = options.startTime ?? 1_700_000_000
    this.#blockSeconds = options.blockSeconds ?? 600
    this.#subsidySats = options.subsidySats ?? 312_500_000n
    this.#minerAddress = options.minerAddress ?? 'tb1qminerminerminerminerminerminerminerx'
    this.#mine([])
  }

  get tip(): number {
    return this.#blocks.length - 1
  }

  hashAt(height: number): string {
    const block = this.#blocks[height]
    if (!block) throw new Error(`no block at ${height}`)
    return block.hash
  }

  /** The txid the fake assigned to transaction `index` of the block at `height`. */
  txidAt(height: number, index: number): string {
    const block = this.#blocks[height]
    const tx = block?.tx[index]
    if (!tx) throw new Error(`no transaction ${index} at height ${height}`)
    return tx.txid
  }

  /** The coinbase outpoint of a block, which is the usual way a test funds an address. */
  coinbaseOutpoint(height: number): Outpoint {
    return { txid: this.txidAt(height, 0), vout: 0 }
  }

  append(txs: readonly BtcTxSpec[] = []): void {
    this.#mine(txs)
  }

  appendMany(count: number): void {
    for (let i = 0; i < count; i++) this.#mine([])
  }

  /** Discard every block at or above `fromHeight` and mine `replacements` in their place. */
  reorg(fromHeight: number, replacements: number, txsPerBlock: readonly BtcTxSpec[][] = []): void {
    if (fromHeight < 1) throw new Error('cannot rewrite the genesis block')
    if (fromHeight > this.#blocks.length) throw new Error('cannot rewrite above the tip')
    this.#blocks.length = fromHeight
    this.#fork += 1
    for (let i = 0; i < replacements; i++) this.#mine(txsPerBlock[i] ?? [])
  }

  #mine(specs: readonly BtcTxSpec[]): void {
    const height = this.#blocks.length
    const parent = this.#blocks[height - 1]
    const hash = digest('btcblock', String(this.#fork), String(height))

    const built: FakeTx[] = []

    // The coinbase, which on Bitcoin is a real transaction with a real txid — unlike an EVM block
    // reward, which has neither. `bitcoin.ts` indexes it for exactly that reason.
    const coinbaseTxid = digest('btccoinbase', String(this.#fork), String(height))
    built.push(
      this.#tx(coinbaseTxid, [{ coinbase: `${this.#fork}${height}`, sequence: 0xffffffff }], [
        { address: this.#minerAddress, sats: this.#subsidySats },
      ]),
    )

    specs.forEach((spec, index) => {
      const txid = spec.txid ?? digest('btctx', String(this.#fork), String(height), String(index))
      const vin: FakeVin[] = spec.inputs.map((input) => ({
        txid: input.txid,
        vout: input.vout,
        sequence: spec.rbf ? 0xfffffffd : 0xffffffff,
      }))
      built.push(this.#tx(txid, vin, spec.outputs))
    })

    for (const tx of built) this.#txs.set(tx.txid, tx)

    this.#blocks.push({
      hash,
      height,
      ...(parent ? { previousblockhash: parent.hash } : {}),
      time: this.#startTime + height * this.#blockSeconds,
      nTx: built.length,
      merkleroot: digest('merkle', hash),
      bits: '1d00ffff',
      size: 285 * built.length,
      weight: 1140 * built.length,
      version: 0x20000000,
      tx: built,
    })
  }

  #tx(txid: string, vin: readonly FakeVin[], outputs: readonly OutputSpec[]): FakeTx {
    return {
      txid,
      // The wtxid differs from the txid on a segwit transaction. Making them differ here is what
      // proves `bitcoin.ts` keys on `txid` rather than on `hash`.
      hash: digest('wtxid', txid),
      version: 2,
      size: 285,
      vsize: 141,
      weight: 561,
      locktime: 0,
      vin,
      vout: outputs.map((output, n) => ({
        value: satsToBtcNumber(output.sats),
        n,
        scriptPubKey: output.address
          ? { address: output.address, type: 'witness_v0_keyhash' }
          : { type: 'nulldata' },
      })),
    }
  }

  /** A block with `prevout` filled in on every non-coinbase input: Core's verbosity 3. */
  #withPrevouts(block: FakeBtcBlock): unknown {
    return {
      ...block,
      tx: block.tx.map((tx) => ({
        ...tx,
        vin: tx.vin.map((vin) => {
          if (vin.coinbase !== undefined || vin.txid === undefined || vin.vout === undefined) {
            return vin
          }
          const funding = this.#txs.get(vin.txid)
          const out = funding?.vout[vin.vout]
          if (!out) return vin
          return { ...vin, prevout: { value: out.value, scriptPubKey: out.scriptPubKey } }
        }),
      })),
    }
  }

  /** The JSON-RPC surface, as far as the Bitcoin worker uses it. */
  handle(method: string, params: readonly unknown[]): unknown {
    this.calls.push(method)
    switch (method) {
      case 'getblockchaininfo':
        return { chain: this.coreChain, blocks: this.tip, bestblockhash: this.hashAt(this.tip) }
      case 'getblockcount':
        return this.tip
      case 'getblockhash': {
        const height = Number(params[0])
        const block = this.#blocks[height]
        // Core's own error for a height above the active chain. Not a provider failing.
        if (!block) throw new JsonRpcFault(-8, 'Block height out of range')
        return block.hash
      }
      case 'getblock': {
        const hash = String(params[0])
        const verbosity = Number(params[1] ?? 1)
        const block = this.#blocks.find((b) => b.hash === hash)
        if (!block) throw new JsonRpcFault(-5, 'Block not found')
        if (verbosity >= 3) {
          if (!this.supportsVerbosityThree) {
            throw new JsonRpcFault(-8, 'Verbosity 3 is not supported by this node')
          }
          return this.#withPrevouts(block)
        }
        return block
      }
      case 'getrawtransaction': {
        const txid = String(params[0])
        const tx = this.#txs.get(txid)
        if (!tx) throw new JsonRpcFault(-5, 'No such mempool or blockchain transaction')
        return tx
      }
      default:
        throw new JsonRpcFault(-32601, `the method ${method} does not exist`)
    }
  }
}

/** Adapt a `FakeBitcoinNode` to the shape `RpcPool` expects of `@cloudsforge/http`. */
export function fakeBitcoinClient(
  node: FakeBitcoinNode,
  options: { readonly fault?: (method: string, callIndex: number) => Error | null } = {},
): Pick<HttpClient, 'request'> {
  let callIndex = 0
  return {
    async request<T>(_path: string, requestOptions: RequestOptions = {}): Promise<T> {
      const body = requestOptions.body as
        | { readonly method?: string; readonly params?: readonly unknown[]; readonly id?: number }
        | undefined
      const method = body?.method ?? ''
      const index = callIndex++
      const fault = options.fault?.(method, index)
      if (fault) throw fault
      try {
        const result = node.handle(method, body?.params ?? [])
        return { jsonrpc: '2.0', id: body?.id ?? 1, result } as T
      } catch (err) {
        if (err instanceof JsonRpcFault) {
          return {
            jsonrpc: '2.0',
            id: body?.id ?? 1,
            error: { code: err.code, message: err.message },
          } as T
        }
        throw err
      }
    },
  }
}

/** A node that is simply down, for the failover path. */
export function deadBitcoinClient(status = 502): Pick<HttpClient, 'request'> {
  return {
    async request<T>(): Promise<T> {
      throw new HttpError({
        status,
        body: 'upstream is unavailable',
        url: 'http://dead.invalid/',
        method: 'POST',
      })
    },
  }
}
