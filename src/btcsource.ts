/**
 * The seam: what a Bitcoin-family chain has to be able to tell this service, and nothing else.
 *
 * ## Why the interface is this narrow
 *
 * Two sources will implement it, and they have almost nothing in common:
 *
 *   - **`nodeSource`** — a Bitcoin Core (or Litecoin Core) daemon we run ourselves, on our own
 *     hardware, reached over loopback. It validates every block itself, so its answers are ground
 *     truth. It costs a full chain on disk, which is why it cannot be the destination.
 *   - **`lightSource`** — a BIP157/158 client speaking the peer protocol outbound, holding a
 *     header chain and nothing else. It is portable to any box in minutes, and it is
 *     probabilistic and eclipse-prone, which is why it cannot be the only thing either.
 *
 * The interface is deliberately the *smallest* thing that supports the estate's real workload,
 * which `wallet` and `settlement` between them define as exactly two questions: **did money arrive
 * at one of these addresses, deep enough to credit**, and **please put these signed bytes on the
 * chain**. There is no balance read, no history query and no mempool. Every method here is one of
 * those two questions or a check that the source is on the chain it claims.
 *
 * ## The point of having two, which is not redundancy
 *
 * A compact-filter client's characteristic failure is silence. A peer that omits a script from a
 * filter produces a filter that is well-formed, decodes cleanly, and hides a deposit — and there
 * is no header commitment to catch it, because BIP157 declined to add one. Normally you would find
 * out when a user complained.
 *
 * Running both sources against the same address set on the same chain removes that. The node knows
 * the truth for every block; the light client's answer for that block can be compared to it. A
 * disagreement is a test failure rather than a lost deposit. `btcdiff.ts` is that harness, and it
 * is the reason the light client is allowed to become the default at all.
 *
 * **The light source is not permitted to serve deposits until it has agreed with the node** over a
 * contiguous range of real blocks. See `btcdiff.ts` for what range and why.
 */

import type { Prevout, RawBtcBlock } from './bitcoin.ts'
import type { ChainScope } from './chains.ts'
import type { ProviderHealthInput } from './store.ts'

/**
 * A block as a source produces it.
 *
 * `complete` is the honest part and it exists because of the light client. A compact-filter client
 * that finds no match for a block does not download it, so it has the header and no transactions —
 * and a block record showing zero transactions would be a *claim* that the block was empty, which
 * is false for essentially every Bitcoin block. So `complete: false` says "the transactions were
 * not fetched, because this source proved none of them concerned us", and `bitcoin.ts` writes a
 * block row that says exactly that rather than one that says the block was empty.
 *
 * The distinction is not academic. It decides what a future backfill has to redo: a `complete`
 * block is finished, an incomplete one is finished *for the address set that was watched at the
 * time*, and adding an address later means those blocks must be rescanned. `blocks.detail` carries
 * the marker so that decision can be made from the data rather than from memory.
 */
export interface SourcedBlock {
  readonly raw: RawBtcBlock
  readonly complete: boolean
  /**
   * Every output script in the block, when the whole block was fetched.
   *
   * Present only so the compact-filter audit can run: given the block and the filter that claimed
   * to describe it, every output script must be in the filter. That check is what makes a lying
   * peer detectable, so the bytes it needs are carried deliberately rather than re-derived.
   */
  readonly outputScripts?: readonly Uint8Array[]
}

/**
 * Why a block's rows are not the whole block, in the two ways that can happen.
 *
 * `SourcedBlock.complete` says whether the transactions were fetched. It is not the only way a
 * block can end up holding less than the chain put in it, and the two ways have to be told apart
 * by whoever decides what a rescan must redo:
 *
 *   - **`transactions-not-fetched`** — the light source proved no transaction in the block
 *     concerned the watched set and never downloaded the body. Nothing about the block is stored
 *     beyond its header.
 *   - **`watched-addresses-only`** — the whole block was fetched and every transaction is stored,
 *     but `address_activity` was written only for addresses that were watched at the time. The
 *     block's transactions are complete; its address record is not.
 *
 * Both mean the same thing to a backfill — rescan this block if the address set has grown since —
 * and they mean different things to a reader, because the second still answers "was this
 * transaction mined" for any hash and the first does not.
 */
export type PartialBlockReason = 'transactions-not-fetched' | 'watched-addresses-only'

/**
 * The key `blocks.detail` carries the marker under.
 *
 * Named here rather than spelled in each writer because two of them write it and a reader that
 * looked for a different spelling than the writer used would conclude, silently and wrongly, that
 * every block is complete.
 */
export const PARTIAL_DETAIL_KEY = 'partial'

/**
 * Stamp a block's `detail` with what was and was not stored for it.
 *
 * `null` means the block is whole and says so explicitly. That is worth a key of its own: a block
 * row written by an older build carries neither marker, and "no marker" has to keep meaning
 * "written before this service could tell you", not "complete". A reader that treats absence as
 * completeness would vouch for exactly the blocks nobody can vouch for.
 */
export function markPartial(
  detail: Record<string, unknown>,
  reason: PartialBlockReason | null,
): Record<string, unknown> {
  return { ...detail, [PARTIAL_DETAIL_KEY]: reason }
}

/**
 * There is deliberately no `partialReason(detail)` reader here. Everything in this service that
 * asks about the marker asks it of many blocks at once — "is any block in range narrow" — and
 * answers it in SQL against the partial index, not by pulling `detail` back into JavaScript one
 * row at a time. A helper that existed only to be available would be the mistake this file's own
 * machinery already made once.
 */

/**
 * The watched address set, as a source needs it.
 *
 * A light source must know the scripts *before* it decides whether to download a block, which is
 * the opposite order from the node source — `bitcoin.ts` filters to watched addresses after
 * indexing. So the set is supplied to the source rather than queried by it, and the supplier is a
 * function rather than a value because the set changes whenever a user is assigned an address and
 * a source holding a stale set silently stops watching the newest customer.
 *
 * `unwatchable` is the honest half. An address this chain cannot express as an output script — a
 * Litecoin MWEB address, a malformed paste — must not be silently dropped from the set, because a
 * dropped address is a deposit that is never seen and never explained. It is reported so the
 * chain can refuse for that address instead.
 */
export interface WatchedSet {
  readonly scripts: readonly Uint8Array[]
  readonly addresses: readonly string[]
  readonly unwatchable: readonly { readonly address: string; readonly reason: string }[]
}

export type WatchedSetReader = (signal: AbortSignal) => Promise<WatchedSet>

/**
 * What a source cannot answer.
 *
 * Distinguished from a refusal on purpose, and for the same reason `rpc.ts` separates `RpcError`
 * from `RpcUnavailableError`: a follower that treats "nobody answered" as a job failure burns its
 * attempt budget and dead-letters, and then the chain is not followed at all even after the source
 * recovers. Unavailability is "no progress this tick", never a fault.
 */
export class SourceUnavailableError extends Error {
  readonly scope: ChainScope
  constructor(scope: ChainScope, message: string) {
    super(message)
    this.name = 'SourceUnavailableError'
    this.scope = scope
  }
}

/** The source is following a different chain than the scope claims. Always fatal at boot. */
export class SourceIdentityError extends Error {
  readonly scope: ChainScope
  readonly reported: string
  constructor(scope: ChainScope, reported: string, expected: string) {
    super(`${scope.chain}:${scope.network} expects ${expected} but the source reports ${reported}`)
    this.name = 'SourceIdentityError'
    this.scope = scope
    this.reported = reported
  }
}

/**
 * The whole of what a Bitcoin-family source must do.
 *
 * Six methods. Anything a caller wants that is not here is either a question this service has
 * decided not to answer (a balance — AD-07 removed balance probing on purpose) or one it answers
 * from its own database rather than from the chain (history, confirmations, reorg depth).
 */
export interface BitcoinSource {
  readonly scope: ChainScope
  /** `node` validates everything itself; `light` trusts a peer set. Recorded on every block row. */
  readonly kind: 'node' | 'light'

  /**
   * Prove the source is on the chain this scope names.
   *
   * `bitcoin.ts`'s header already argues why this is fatal rather than a warning: indexing mainnet
   * into the rows labelled `btc:testnet` is silent for as long as nobody looks. Both sources can
   * do it — the node reports `getblockchaininfo.chain`, and the light client compares the genesis
   * hash its header chain starts from, which is a stronger check than a string.
   */
  verifyIdentity(signal: AbortSignal): Promise<void>

  tipHeight(signal: AbortSignal): Promise<number>

  /** The ACTIVE chain's hash at a height, or null when the chain is shorter. Drives reorg walks. */
  hashAt(height: number, signal: AbortSignal): Promise<string | null>

  /**
   * The block at a height, or null when there is none.
   *
   * The watched set is passed in rather than held, because it is what decides whether a light
   * source downloads the block at all. A node source ignores it and returns the whole block.
   */
  blockAt(height: number, watched: WatchedSet, signal: AbortSignal): Promise<SourcedBlock | null>

  /**
   * Resolve the prevouts a block spends that the block did not carry.
   *
   * Both sources may legitimately answer incompletely, and `bitcoin.ts` already handles that: the
   * *inbound* movements — the deposits, the only thing that becomes a credit — need no prevouts at
   * all, and `unresolvedInputs` records what was missed. A node with `txindex=0` cannot resolve a
   * historical transaction, and a light client never can. Neither is a fault.
   */
  prevouts(raw: RawBtcBlock, signal: AbortSignal): Promise<Map<string, Prevout>>

  /**
   * Put signed bytes on the chain, and return the txid the chain will know them by.
   *
   * Idempotent by construction: re-broadcasting bytes already in a block or a mempool is a success
   * and returns the same txid, because `settlement`'s recovery path re-sends the identical bytes
   * after a crash between broadcast and its own record. A source that reported "already have
   * transaction" as a failure would make that recovery look like a lost payment.
   */
  broadcast(rawTxHex: string, signal: AbortSignal): Promise<string>

  /** Health, in the shape `provider_health` stores. A light source reports one row per peer. */
  health(): readonly ProviderHealthInput[]

  close(): Promise<void>
}
