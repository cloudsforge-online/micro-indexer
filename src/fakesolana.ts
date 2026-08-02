/**
 * A fake Solana JSON-RPC node.
 *
 * The counterpart of `fakechain.ts` and `fakebitcoin.ts`, and the one whose shape differs most from
 * both — because the two things that make Solana's follower hard are things the other two fakes
 * cannot express:
 *
 *   * **Slots without blocks.** `skip()` advances the clock without producing anything, so a test
 *     can prove that a follower does not read a skipped slot as a gap, does not retry it, and does
 *     not stall on it. On an EVM fake every height has a block by construction.
 *
 *   * **A finalized watermark that moves independently of the tip.** `finalize(slot)` is what
 *     lets a test put a fork on either side of the only line that matters on this family, and
 *     therefore lets both branches of the reorg rule be driven rather than asserted about.
 *
 * Blockhashes are deterministic in `(fork, slot)`, so a slot re-produced on a different fork
 * necessarily hashes differently.
 *
 * Not a test file: no `.test.ts` suffix.
 */

import { createHash } from 'node:crypto'
import { HttpError, type HttpClient, type RequestOptions } from '@cloudsforge/http'
import { JsonRpcFault } from './fakechain.ts'
import { GENESIS_HASHES } from './solana.ts'

/** A lamport movement the fake will express as a balance delta, the way the RPC does. */
export interface SolTransferSpec {
  readonly from: string
  readonly to: string
  readonly lamports: bigint
  readonly feeLamports?: bigint
  /** A committed failure: the fee is still charged and nothing else moves. */
  readonly failed?: boolean
  readonly signature?: string
}

interface FakeSolTx {
  readonly transaction: {
    readonly signatures: readonly string[]
    readonly message: { readonly accountKeys: readonly string[] }
  }
  readonly meta: {
    readonly err: unknown
    readonly fee: number
    readonly preBalances: readonly number[]
    readonly postBalances: readonly number[]
    readonly preTokenBalances: readonly unknown[]
    readonly postTokenBalances: readonly unknown[]
  }
}

interface FakeSolBlock {
  readonly slot: number
  readonly blockhash: string
  readonly previousBlockhash: string
  readonly parentSlot: number
  readonly blockTime: number
  readonly blockHeight: number
  readonly transactions: readonly FakeSolTx[]
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

export interface FakeSolanaOptions {
  readonly genesisHash?: string
  readonly startTime?: number
  /** Starting lamport balance for any address the fake has not seen before. */
  readonly openingBalance?: bigint
}

export class FakeSolanaNode {
  readonly genesisHash: string
  /** Slot → block, sparse: a missing entry is a SKIPPED slot, which is normal traffic. */
  readonly #blocks = new Map<number, FakeSolBlock>()
  readonly #balances = new Map<string, bigint>()
  readonly #openingBalance: bigint
  readonly #startTime: number
  #slot = -1
  #lastProducedSlot = -1
  #blockHeight = -1
  #finalizedSlot = 0
  #fork = 0
  readonly calls: string[] = []

  constructor(options: FakeSolanaOptions = {}) {
    this.genesisHash = options.genesisHash ?? GENESIS_HASHES.devnet
    this.#startTime = options.startTime ?? 1_700_000_000
    this.#openingBalance = options.openingBalance ?? 1_000_000_000n
    this.produce()
  }

  get tip(): number {
    return this.#slot
  }

  get finalizedSlot(): number {
    return this.#finalizedSlot
  }

  hashAt(slot: number): string {
    const block = this.#blocks.get(slot)
    if (!block) throw new Error(`no block at slot ${slot}`)
    return block.blockhash
  }

  hasBlock(slot: number): boolean {
    return this.#blocks.has(slot)
  }

  balanceOf(address: string): bigint {
    return this.#balances.get(address) ?? this.#openingBalance
  }

  /** Advance the clock WITHOUT producing a block. A skipped slot is not a gap. */
  skip(count = 1): void {
    for (let i = 0; i < count; i++) this.#slot += 1
  }

  /** Advance the clock and produce a block in the new slot. */
  produce(transfers: readonly SolTransferSpec[] = []): number {
    this.#slot += 1
    const slot = this.#slot
    const parentSlot = this.#lastProducedSlot
    const parent = parentSlot >= 0 ? this.#blocks.get(parentSlot) : undefined
    this.#blockHeight += 1

    const txs: FakeSolTx[] = []
    transfers.forEach((spec, index) => {
      const fee = spec.feeLamports ?? 5_000n
      const keys = [spec.from, spec.to]
      const preFrom = this.balanceOf(spec.from)
      const preTo = this.balanceOf(spec.to)
      // A failed Solana transaction is COMMITTED and still charges the fee — everything else is
      // rolled back. Expressing that in the balances is what lets the worker need no special case.
      const postFrom = spec.failed ? preFrom - fee : preFrom - fee - spec.lamports
      const postTo = spec.failed ? preTo : preTo + spec.lamports
      this.#balances.set(spec.from, postFrom)
      this.#balances.set(spec.to, postTo)
      txs.push({
        transaction: {
          signatures: [
            spec.signature ?? digest('solsig', String(this.#fork), String(slot), String(index)),
          ],
          message: { accountKeys: keys },
        },
        meta: {
          err: spec.failed ? { InstructionError: [0, 'Custom'] } : null,
          fee: Number(fee),
          preBalances: [Number(preFrom), Number(preTo)],
          postBalances: [Number(postFrom), Number(postTo)],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      })
    })

    this.#blocks.set(slot, {
      slot,
      blockhash: digest('solblock', String(this.#fork), String(slot)),
      previousBlockhash: parent ? parent.blockhash : digest('solgenesis'),
      parentSlot: parentSlot >= 0 ? parentSlot : 0,
      blockTime: this.#startTime + slot,
      blockHeight: this.#blockHeight,
      transactions: txs,
    })
    this.#lastProducedSlot = slot
    return slot
  }

  produceMany(count: number): void {
    for (let i = 0; i < count; i++) this.produce()
  }

  /** Declare everything at or below `slot` finalized. Settled history does not fork. */
  finalize(slot: number): void {
    this.#finalizedSlot = slot
  }

  /**
   * Abandon every slot at or above `fromSlot` and produce `replacements` blocks in their place.
   *
   * Solana's spelling of a reorg: the fork that lost simply stops being what the cluster serves.
   */
  abandon(fromSlot: number, replacements: number): void {
    for (const slot of [...this.#blocks.keys()]) {
      if (slot >= fromSlot) this.#blocks.delete(slot)
    }
    this.#slot = fromSlot - 1
    this.#lastProducedSlot = Math.max(
      -1,
      ...[...this.#blocks.keys()].filter((s) => s < fromSlot),
    )
    this.#fork += 1
    for (let i = 0; i < replacements; i++) this.produce()
  }

  /** The JSON-RPC surface, as far as the Solana worker uses it. */
  handle(method: string, params: readonly unknown[]): unknown {
    this.calls.push(method)
    switch (method) {
      case 'getGenesisHash':
        return this.genesisHash
      case 'getSlot': {
        const options = params[0] as { commitment?: string } | undefined
        return options?.commitment === 'finalized' ? this.#finalizedSlot : this.#slot
      }
      case 'getBlocks': {
        const from = Number(params[0])
        const to = Number(params[1])
        return [...this.#blocks.keys()].filter((s) => s >= from && s <= to).sort((a, b) => a - b)
      }
      case 'getBlock': {
        const slot = Number(params[0])
        const block = this.#blocks.get(slot)
        // The node's own answer for a slot that produced nothing. A follower that reads this as a
        // failure never advances, which is the single easiest Solana bug to write.
        if (!block) throw new JsonRpcFault(-32007, `Slot ${slot} was skipped, or missing`)
        return block
      }
      default:
        throw new JsonRpcFault(-32601, `the method ${method} does not exist`)
    }
  }
}

/** Adapt a `FakeSolanaNode` to the shape `RpcPool` expects of `@cloudsforge/http`. */
export function fakeSolanaClient(
  node: FakeSolanaNode,
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
export function deadSolanaClient(status = 502): Pick<HttpClient, 'request'> {
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
