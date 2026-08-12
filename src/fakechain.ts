/**
 * A fake Ethereum JSON-RPC provider that serves a chain and can rewrite its own history.
 *
 * This is the test rig for the one behaviour that cannot be tested against a real node: a reorg.
 * You cannot ask Hearth to reorganise, and waiting for one on a public testnet is not a test. So
 * the chain is built here, in memory, with a `reorg(fromHeight, replacementBlocks)` that discards
 * the suffix and mines a different one — which is exactly what a reorganisation is.
 *
 * Hashes are deterministic in `(fork, height)`, so a rewritten block at height 10 necessarily has
 * a different hash from the original block at height 10, and the assertions can talk about which
 * history a row belongs to rather than about opaque values.
 *
 * Not a test file: it has no `.test.ts` suffix, so `node --test src/*.test.ts` does not run it and
 * `tsconfig.build.json` excludes it from the published build.
 */

import { createHash } from 'node:crypto'
import { HttpError, type HttpClient, type RequestOptions } from '@cloudsforge/http'

export interface FakeLog {
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
}

export interface TxSpec {
  readonly from: string
  readonly to: string | null
  readonly value?: bigint
  readonly status?: 'success' | 'failed'
  readonly logs?: readonly FakeLog[]
  /**
   * Force a hash. A test that re-includes the same transaction on the replacement chain uses this,
   * which is how "an orphaned transaction that comes back is updated, not duplicated" is asserted.
   */
  readonly hash?: string
}

interface FakeTx {
  readonly hash: string
  readonly from: string
  readonly to: string | null
  readonly value: string
  readonly nonce: string
  readonly transactionIndex: string
  readonly gas: string
  readonly gasPrice: string
  readonly input: string
}

interface FakeReceipt {
  readonly transactionHash: string
  readonly status: string
  readonly gasUsed: string
  readonly effectiveGasPrice: string
  readonly contractAddress: string | null
  readonly logs: ReadonlyArray<{
    readonly address: string
    readonly topics: readonly string[]
    readonly data: string
    readonly logIndex: string
    readonly transactionHash: string
  }>
}

/**
 * A block header with the fields a real node sends, not the four this rig used to carry.
 *
 * The old shape held exactly the fields `evm.ts` then kept, so a fake chain could never have shown
 * that the extraction dropped anything — the rig and the defect agreed. micro-org#395 is about
 * `stateRoot` in particular, so the header served here is the one `eth_getBlockByNumber` returns,
 * in the order a node returns it.
 */
interface FakeBlock {
  readonly number: string
  readonly hash: string
  readonly parentHash: string
  readonly nonce: string
  readonly sha3Uncles: string
  readonly logsBloom: string
  readonly transactionsRoot: string
  readonly stateRoot: string
  readonly receiptsRoot: string
  readonly miner: string
  readonly difficulty: string
  readonly totalDifficulty: string
  readonly extraData: string
  readonly size: string
  readonly gasLimit: string
  readonly gasUsed: string
  readonly timestamp: string
  readonly mixHash: string
  readonly transactions: readonly FakeTx[]
  readonly uncles: readonly string[]
}

const ZERO_HASH = `0x${'0'.repeat(64)}`
/** keccak256(rlp([])) — what every uncle-less chain reports for `sha3Uncles`. */
const EMPTY_UNCLE_HASH = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347'

function digest(...parts: string[]): string {
  return `0x${createHash('sha256').update(parts.join('|')).digest('hex')}`
}

function hex(value: number | bigint): string {
  return `0x${value.toString(16)}`
}

export interface FakeChainOptions {
  readonly chainId?: number
  readonly startTimestamp?: number
  readonly blockSeconds?: number
  /** Providers that do not implement it force the per-transaction receipt path. */
  readonly supportsBlockReceipts?: boolean
}

export class FakeChain {
  readonly chainId: number
  readonly supportsBlockReceipts: boolean
  readonly #blocks: FakeBlock[] = []
  readonly #receipts = new Map<string, FakeReceipt>()
  readonly #startTimestamp: number
  readonly #blockSeconds: number
  /** Bumped on every rewrite so replacement blocks hash differently from what they replace. */
  #fork = 0
  /** Every method call, for assertions about failover and about the receipts capability probe. */
  readonly calls: string[] = []

  constructor(options: FakeChainOptions = {}) {
    this.chainId = options.chainId ?? 7412
    this.#startTimestamp = options.startTimestamp ?? 1_700_000_000
    this.#blockSeconds = options.blockSeconds ?? 15
    this.supportsBlockReceipts = options.supportsBlockReceipts ?? true
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

  append(txs: readonly TxSpec[] = []): void {
    this.#mine(txs)
  }

  appendMany(count: number): void {
    for (let i = 0; i < count; i++) this.#mine([])
  }

  /**
   * Discard every block at or above `fromHeight` and mine `replacements` in their place.
   *
   * The depth of the resulting reorganisation, as the indexer will compute it, is
   * `previousTip - (fromHeight - 1)` — the number of blocks that left the canonical chain.
   */
  reorg(fromHeight: number, replacements: number, txsPerBlock: readonly TxSpec[][] = []): void {
    if (fromHeight < 1) throw new Error('cannot rewrite the genesis block')
    if (fromHeight > this.#blocks.length) throw new Error('cannot rewrite above the tip')
    this.#blocks.length = fromHeight
    this.#fork += 1
    for (let i = 0; i < replacements; i++) this.#mine(txsPerBlock[i] ?? [])
  }

  #mine(txs: readonly TxSpec[]): void {
    const height = this.#blocks.length
    const parent = this.#blocks[height - 1]
    const hash = digest('block', String(this.#fork), String(height))

    const built: FakeTx[] = []
    txs.forEach((spec, index) => {
      const txHash = spec.hash ?? digest('tx', String(this.#fork), String(height), String(index))
      built.push({
        hash: txHash,
        from: spec.from,
        to: spec.to,
        value: hex(spec.value ?? 0n),
        nonce: hex(index),
        transactionIndex: hex(index),
        gas: hex(21_000),
        gasPrice: hex(1_000_000_000),
        input: '0x',
      })
      this.#receipts.set(txHash.toLowerCase(), {
        transactionHash: txHash,
        status: spec.status === 'failed' ? '0x0' : '0x1',
        gasUsed: hex(21_000),
        effectiveGasPrice: hex(1_000_000_000),
        contractAddress: null,
        logs: (spec.logs ?? []).map((log, logIndex) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: hex(logIndex),
          transactionHash: txHash,
        })),
      })
    })

    this.#blocks.push({
      number: hex(height),
      hash,
      parentHash: parent ? parent.hash : ZERO_HASH,
      nonce: '0x0000000000000000',
      sha3Uncles: EMPTY_UNCLE_HASH,
      logsBloom: `0x${'0'.repeat(512)}`,
      transactionsRoot: digest('txroot', String(this.#fork), String(height)),
      // Derived from `(fork, height)` like every other hash here, so a rewritten block's state root
      // differs from the one it replaced — which is what lets a test tell the two apart.
      stateRoot: digest('stateroot', String(this.#fork), String(height)),
      receiptsRoot: digest('receiptsroot', String(this.#fork), String(height)),
      miner: '0x00000000000000000000000000000000000000aa',
      difficulty: hex(1_000),
      totalDifficulty: hex(1_000 * (height + 1)),
      extraData: '0x',
      size: hex(512 + 100 * built.length),
      gasLimit: hex(30_000_000),
      gasUsed: hex(21_000 * built.length),
      timestamp: hex(this.#startTimestamp + height * this.#blockSeconds),
      mixHash: ZERO_HASH,
      transactions: built,
      uncles: [],
    })
  }

  /** The JSON-RPC surface, as far as the EVM worker uses it. */
  handle(method: string, params: readonly unknown[]): unknown {
    this.calls.push(method)
    switch (method) {
      case 'eth_chainId':
        return hex(this.chainId)
      case 'eth_blockNumber':
        return hex(this.tip)
      case 'eth_getBlockByNumber': {
        const height = Number(BigInt(String(params[0])))
        return this.#blocks[height] ?? null
      }
      case 'eth_getBlockReceipts': {
        if (!this.supportsBlockReceipts) {
          throw new JsonRpcFault(-32601, 'the method eth_getBlockReceipts does not exist')
        }
        const height = Number(BigInt(String(params[0])))
        const block = this.#blocks[height]
        if (!block) return null
        return block.transactions.map((tx) => this.#receipts.get(tx.hash.toLowerCase()) ?? null)
      }
      case 'eth_getTransactionReceipt':
        return this.#receipts.get(String(params[0]).toLowerCase()) ?? null
      default:
        throw new JsonRpcFault(-32601, `the method ${method} does not exist`)
    }
  }
}

/** A provider answering "no". Carried through as a JSON-RPC error object, not as a transport fault. */
export class JsonRpcFault extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'JsonRpcFault'
    this.code = code
  }
}

export interface FakeClientOptions {
  /** Return a fault to inject a transport failure for this call, or null to serve normally. */
  readonly fault?: (method: string, callIndex: number) => Error | null
}

/**
 * Adapt a `FakeChain` to the shape `RpcPool` expects of `@cloudsforge/http`.
 *
 * It reads the JSON-RPC request out of `options.body`, which is precisely the contract the real
 * client has, so a change to how the pool frames a call fails these tests rather than passing them
 * and failing in production.
 */
export function fakeClient(
  chain: FakeChain,
  options: FakeClientOptions = {},
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
        const result = chain.handle(method, body?.params ?? [])
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

/** A provider that is simply down. The transport fault the pool must fail over from. */
export function deadClient(status = 502): Pick<HttpClient, 'request'> {
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

/** A provider that is throttling. 429 is what puts an endpoint into rate-limit backoff. */
export function throttledClient(): Pick<HttpClient, 'request'> {
  return {
    async request<T>(): Promise<T> {
      throw new HttpError({
        status: 429,
        body: 'rate limit exceeded',
        url: 'http://throttled.invalid/',
        method: 'POST',
      })
    },
  }
}
