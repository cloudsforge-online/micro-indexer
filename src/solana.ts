/**
 * The Solana worker. Slots rather than heights, balance deltas rather than transfer parsing, and
 * a reorg model that is not depth at all.
 *
 * ## Why almost none of `evm.ts`'s reorg reasoning survives contact with Solana
 *
 * The EVM worker's model is: any block can be replaced, deeper is less likely, so a depth is a
 * probability and `reorgAlarmDepth` is where the probability stops being acceptable. Every line of
 * `#handleReorg` there follows from that. Solana does not work that way, and porting the model
 * would produce something that looks right and is wrong in both directions at once:
 *
 *   1. **Below the finalized slot, a reorg cannot happen** — not "is unlikely". Finalization is
 *      the cluster's own supermajority root; a block below it is not deep, it is *done*. So a
 *      disagreement below the finalized slot is not a deep reorg to be recorded and survived. It
 *      means the endpoint changed its mind about settled history, which is a cluster restart, a
 *      rolled-back ledger, or an endpoint on a different cluster than the one it claimed. That
 *      halts the chain **at any depth, including one**, where EVM at depth 1 would shrug.
 *
 *   2. **Above the finalized slot, a fork is ordinary and its depth means nothing.** The confirmed
 *      commitment is explicitly a not-yet-final view, and slots are wall-clock ticks rather than
 *      blocks: 400ms passes whether or not anybody produced a block. So the *slot* distance across
 *      a fork counts skipped slots that never held a block at all, and comparing it to a threshold
 *      compares a duration with a block count. `alarming` is therefore decided by **which side of
 *      the finalized watermark the common ancestor falls on**, and never by `isReorgAlarming`.
 *
 * The depth is still recorded, because an operator wants the number and `reorgs.depth` is where
 * incidents live. It is recorded as what it is — a slot distance — and nothing branches on it.
 *
 * ## Skipped slots are not gaps
 *
 * A slot with no block is normal traffic, not a hole to be retried and not evidence of a reorg.
 * The follower therefore never walks `cursor + 1`: it asks `getBlocks` which slots in a range
 * actually produced one, and treats the answer as complete. Equally, the parent check cannot
 * compare against `slot - 1`, because the parent of slot N is usually not slot N-1. Solana states
 * the link itself — `parentSlot` and `previousBlockhash` — and that is what is checked.
 *
 * ## Deposits are read from balance deltas, not from parsed instructions
 *
 * `meta.preBalances` and `meta.postBalances` are the account balances immediately before and after
 * the transaction, indexed over the transaction's account list. Diffing them attributes every
 * lamport that moved, no matter which program moved it — a System transfer, a CPI from an
 * arbitrary program, a rent refund. Parsing `SystemProgram::Transfer` would find the first and
 * silently miss the rest, and a deposit that arrived through a program the parser did not know is
 * a deposit that never arrives.
 *
 * It also disposes of a special case rather than adding one. `evm.ts` must skip activity for a
 * reverted transaction, because a reverted EVM transaction's `value` was never transferred. A
 * failed Solana transaction is different: it is committed, and it *does* move money — the fee is
 * still charged. The balance deltas already say exactly that, so there is no `status !== 'success'`
 * branch here. The chain is telling the truth and the worker copies it down.
 */

import { explorerTxUrl, txUrn } from '@cloudsforge/contracts-chain'
import type { ChainFamily, Network } from '@cloudsforge/contracts-chain'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import {
  assetOf,
  confirmationsAt,
  creditable,
  requiredConfirmations,
  scopeKey,
  type ChainScope,
} from './chains.ts'
import {
  ACTIVITY_TOTAL,
  BLOCKS_INDEXED_TOTAL,
  CHAIN_HALTED,
  DEPOSITS_CONFIRMED_TOTAL,
  DEPOSITS_OBSERVED_TOTAL,
  LAG_BLOCKS,
  REORGS_TOTAL,
  TIP_HEIGHT,
  TRANSACTIONS_INDEXED_TOTAL,
  depthBucket,
} from './metrics.ts'
import { DEPOSIT_CONFIRMED, DEPOSIT_OBSERVED, withOutbox, type Db } from './outbox.ts'
import { RpcError, RpcUnavailableError, type RpcPool } from './rpc.ts'
import {
  TIP_STREAM,
  activityEntryKey,
  blockAtHeight,
  filterWatched,
  getCheckpoint,
  haltChain,
  headBlock,
  insertReorg,
  isHalted,
  markConfirmed,
  nextUnfinishedBackfill,
  orphanAbove,
  pendingConfirmations,
  recordTip,
  setCheckpoint,
  upsertActivity,
  upsertBlock,
  upsertProviderHealth,
  upsertTransaction,
  type ActivityInput,
  type BlockInput,
  type TransactionInput,
} from './store.ts'
import type { BackfillOutcome, ChainWorker, FollowOutcome, ReorgOutcome } from './worker.ts'

/* ------------------------------------------------------------------ JSON-RPC shapes */

export interface RawSolTokenBalance {
  readonly accountIndex: number
  readonly mint: string
  readonly owner?: string
  readonly uiTokenAmount?: { readonly amount?: string; readonly decimals?: number }
}

export interface RawSolMeta {
  /** Null on success. Any other value is a committed failure — which still charged the fee. */
  readonly err?: unknown
  readonly fee?: number
  readonly preBalances?: readonly number[]
  readonly postBalances?: readonly number[]
  readonly preTokenBalances?: readonly RawSolTokenBalance[]
  readonly postTokenBalances?: readonly RawSolTokenBalance[]
  /** Versioned transactions resolve extra accounts from address lookup tables. */
  readonly loadedAddresses?: {
    readonly writable?: readonly string[]
    readonly readonly?: readonly string[]
  }
}

export interface RawSolTransaction {
  readonly transaction: {
    readonly signatures?: readonly string[]
    readonly message?: { readonly accountKeys?: readonly (string | { readonly pubkey: string })[] }
  }
  readonly meta?: RawSolMeta | null
}

export interface RawSolBlock {
  readonly blockhash: string
  readonly previousBlockhash: string
  readonly parentSlot: number
  readonly blockTime?: number | null
  readonly blockHeight?: number | null
  readonly transactions?: readonly RawSolTransaction[]
}

/* ------------------------------------------------------------------ lamports */

/** Total SOL supply is far below this; a delta beyond it is a decode fault, not an amount. */
export const MAX_LAMPORTS = 1_000_000_000_000_000_000n

/**
 * A lamport count from JSON.
 *
 * The RPC serialises balances as JSON numbers. Unlike Bitcoin's BTC-denominated floats these are
 * already integers, so there is no scaling to do — but a `u64` above 2^53 cannot survive a double
 * and JavaScript will have rounded it before this code ever sees it. Rather than pretend, anything
 * that is not an exact integer is refused. Silently crediting a rounded balance is the failure
 * mode this whole service exists to remove.
 */
export function lamportsOf(value: number | undefined): bigint {
  if (value === undefined) return 0n
  if (!Number.isFinite(value)) throw new RangeError(`lamport value ${value} is not finite`)
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`lamport value ${value} has already lost precision as a double`)
  }
  if (value < 0) throw new RangeError(`lamport value ${value} is negative`)
  return BigInt(value)
}

/**
 * The full account list a transaction's balance arrays are indexed over.
 *
 * For a legacy transaction this is just `message.accountKeys`. For a versioned one the accounts
 * resolved from address lookup tables are appended — **writable first, then readonly**, which is
 * the order the runtime uses and therefore the order `preBalances` is indexed in. Getting that
 * order wrong does not fail loudly; it attributes one account's movement to another, which is a
 * deposit credited to the wrong user.
 */
export function accountKeysOf(tx: RawSolTransaction): string[] {
  const declared = (tx.transaction.message?.accountKeys ?? []).map((key) =>
    typeof key === 'string' ? key : key.pubkey,
  )
  const loaded = tx.meta?.loadedAddresses
  if (!loaded) return declared
  return [...declared, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])]
}

/** A Solana signature is the transaction's id, and the first signature is the one explorers use. */
export function signatureOf(tx: RawSolTransaction): string | null {
  return tx.transaction.signatures?.[0] ?? null
}

/* ------------------------------------------------------------------ extraction */

export interface ExtractedSolanaBlock {
  readonly block: BlockInput
  readonly transactions: readonly TransactionInput[]
  readonly activity: readonly ActivityInput[]
}

/**
 * One Solana block into rows. Pure.
 *
 * `block.height` is the **slot**, not `blockHeight`. Two numbers exist and they are not
 * interchangeable: the slot is the position on the ledger's clock and is what `getBlock`,
 * `getBlocks`, every commitment and every checkpoint in this worker are expressed in; `blockHeight`
 * counts only slots that produced a block. Storing `blockHeight` in the column the follower
 * checkpoints on would make the resume point unresolvable against the RPC, so the slot is stored
 * and `blockHeight` is kept in `detail` for anyone who wants it.
 */
export function extractSolanaBlock(
  raw: RawSolBlock,
  slot: number,
  nativeAssetCode: string,
): ExtractedSolanaBlock {
  const rawTxs = raw.transactions ?? []

  const block: BlockInput = {
    height: slot,
    hash: raw.blockhash,
    parentHash: raw.previousBlockhash,
    // Seconds since the epoch, and nullable: an old block whose time the node no longer has.
    blockTime: new Date((raw.blockTime ?? 0) * 1_000),
    txCount: rawTxs.length,
    detail: {
      // The slot the parent block occupies. It is USUALLY NOT slot - 1, because slots are skipped,
      // and it is the only honest way to express the chain link on this family.
      parentSlot: raw.parentSlot,
      blockHeight: raw.blockHeight ?? null,
    },
  }

  const transactions: TransactionInput[] = []
  const activity: ActivityInput[] = []

  for (let index = 0; index < rawTxs.length; index++) {
    const tx = rawTxs[index]
    if (!tx) continue
    const signature = signatureOf(tx)
    // A transaction with no signature cannot be referenced, linked or deduped. Storing it under a
    // synthetic id is exactly the defect 00-current-state §3.4 records for deposits today.
    if (!signature) continue

    const meta = tx.meta ?? null
    const failed = meta?.err !== undefined && meta?.err !== null
    const keys = accountKeysOf(tx)
    const pre = meta?.preBalances ?? []
    const post = meta?.postBalances ?? []

    let moved = 0n
    // The balance arrays are indexed over the account list. A length disagreement means the two
    // cannot be aligned, and aligning them anyway would attribute one account's movement to
    // another — so nothing is attributed at all.
    const alignable = pre.length === post.length && pre.length === keys.length
    if (alignable) {
      for (let i = 0; i < keys.length; i++) {
        const address = keys[i]
        if (address === undefined) continue
        const delta = lamportsOf(post[i]) - lamportsOf(pre[i])
        if (delta === 0n) continue
        const direction = delta > 0n ? 'in' : 'out'
        const amount = delta > 0n ? delta : -delta
        if (direction === 'in') moved += amount
        activity.push({
          address,
          direction,
          assetCode: nativeAssetCode,
          assetKind: 'native',
          tokenAddress: null,
          amount,
          txHash: signature,
          // The ACCOUNT INDEX, which is stable within the transaction and unique per account. It
          // is what stops two accounts' movements colliding on one key.
          entryKey: activityEntryKey(i, direction, address),
          logIndex: i,
          blockHeight: slot,
          blockHash: raw.blockhash,
        })
      }
    }

    // SPL token movements, from the same before/after shape. `owner` rather than the token account
    // address, because the owner is the party a wallet knows about; a token account is an
    // implementation detail the user never sees.
    const tokenBefore = new Map<string, bigint>()
    for (const balance of meta?.preTokenBalances ?? []) {
      tokenBefore.set(
        `${balance.accountIndex}:${balance.mint}`,
        BigInt(balance.uiTokenAmount?.amount ?? '0'),
      )
    }
    for (const balance of meta?.postTokenBalances ?? []) {
      const key = `${balance.accountIndex}:${balance.mint}`
      const owner = balance.owner
      if (!owner) continue
      const after = BigInt(balance.uiTokenAmount?.amount ?? '0')
      const delta = after - (tokenBefore.get(key) ?? 0n)
      if (delta === 0n) continue
      const direction = delta > 0n ? 'in' : 'out'
      const amount = delta > 0n ? delta : -delta
      activity.push({
        address: owner,
        direction,
        // The mint address, never a symbol — the same rule `evm.ts` applies to an ERC-20 contract.
        assetCode: balance.mint,
        assetKind: 'token',
        tokenAddress: balance.mint,
        amount,
        txHash: signature,
        // Offset past the native movements' index space so a token movement and a native movement
        // on the same account index can never collide on one entry key.
        entryKey: activityEntryKey(1_000_000 + balance.accountIndex, direction, owner),
        logIndex: balance.accountIndex,
        blockHeight: slot,
        blockHash: raw.blockhash,
      })
    }

    transactions.push({
      hash: signature,
      blockHash: raw.blockhash,
      blockHeight: slot,
      txIndex: index,
      // The fee payer is `accountKeys[0]` by definition, so this one IS knowable — unlike Bitcoin.
      // The recipient is not: a Solana transaction may credit any number of accounts, so the
      // movements carry that and the column stays null.
      from: keys[0] ?? null,
      to: null,
      value: moved,
      fee: lamportsOf(meta?.fee),
      // A committed failure is `failed`, and it still charged a fee and still produced the balance
      // movements above. That is not a contradiction: on Solana a failed transaction is a real,
      // recorded event, not a reverted one.
      status: failed ? 'failed' : 'success',
      // Solana has no nonce and no sequence: replay protection is the recent blockhash, which is
      // not an ordinal and must not be stored in a column consumers compare like one.
      nonceOrSequence: null,
      rawRef: {
        err: failed ? JSON.stringify(meta?.err) : null,
        accounts: keys.length,
        // Recorded rather than silently dropped, so a block whose balances could not be aligned is
        // visible as a data-quality fact instead of as an address that mysteriously has no history.
        balancesAligned: alignable,
        versioned: Boolean(meta?.loadedAddresses),
      },
    })
  }

  return { block, transactions, activity }
}

/* ------------------------------------------------------------------ identity */

/**
 * Genesis hashes. This is Solana's chain id, and it is the only reliable one — an RPC URL says
 * nothing about which cluster is behind it.
 */
export const GENESIS_HASHES = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
})

/**
 * Which genesis hashes are admissible for a scope.
 *
 * The estate's `testnet` covers both of Solana's non-production clusters, because which one a
 * deployment points at is an operational choice and both are test coins. What is NOT admissible in
 * either direction is mainnet-beta against a testnet scope or vice versa, and that is the whole
 * job: indexing mainnet-beta into rows every consumer believes are test coins is the Solana
 * spelling of the mistake `evm.ts` refuses to boot past.
 */
export const ACCEPTED_GENESIS: Readonly<Record<Network, readonly string[]>> = Object.freeze({
  mainnet: Object.freeze([GENESIS_HASHES['mainnet-beta']]),
  testnet: Object.freeze([GENESIS_HASHES.devnet, GENESIS_HASHES.testnet]),
})

export class SolanaClusterError extends Error {
  constructor(scope: ChainScope, actual: string) {
    super(
      `${scopeKey(scope)} is pointed at a cluster whose genesis hash is '${actual}', which is not ` +
        'one this scope may index — a mainnet ledger written into testnet rows is silent until ' +
        'somebody tries to spend it',
    )
    this.name = 'SolanaClusterError'
  }
}

/**
 * Raised when settled history changed underneath us.
 *
 * Deliberately NOT a "reorg too deep" error. Depth is not the problem and a bigger walk would not
 * help: the endpoint contradicted its own finalized commitment, so the correct response is to stop
 * and involve a human rather than to re-index from a history nothing can vouch for.
 */
export class SolanaFinalizedForkError extends Error {
  constructor(scope: ChainScope, slot: number, finalizedSlot: number) {
    super(
      `${scopeKey(scope)} disagrees with the endpoint about slot ${slot}, which is at or below ` +
        `the finalized slot ${finalizedSlot} — finalized history does not fork, so this is a ` +
        'cluster restart, a rolled-back ledger, or an endpoint on another cluster',
    )
    this.name = 'SolanaFinalizedForkError'
  }
}

/* ------------------------------------------------------------------ the worker */

export interface SolanaWorkerDeps {
  readonly sql: Db
  readonly scope: ChainScope
  readonly rpc: RpcPool
  readonly logger: Logger
  readonly metrics: Metrics
  readonly producer: string
  readonly followBatchBlocks: number
  readonly backfillBatchBlocks: number
  readonly startHeight: number | undefined
  readonly maxReorgWalk?: number
  readonly confirmBatch?: number
}

const MAX_REORGS_PER_TICK = 4

/** "Slot was skipped, or missing due to ledger jump to recent snapshot." A fact, not a failure. */
const RPC_SLOT_SKIPPED = -32007
/** "Slot was skipped and not available." Same. */
const RPC_SLOT_MISSING = -32009
/** "Block not available for slot" — the node has it neither in ledger nor in its snapshot. */
const RPC_BLOCK_NOT_AVAILABLE = -32004
/** "Block cleaned up, does not exist on node." */
const RPC_BLOCK_CLEANED_UP = -32001

const MISSING_BLOCK_CODES = new Set([
  RPC_SLOT_SKIPPED,
  RPC_SLOT_MISSING,
  RPC_BLOCK_NOT_AVAILABLE,
  RPC_BLOCK_CLEANED_UP,
])

export class SolanaWorker implements ChainWorker {
  readonly #d: SolanaWorkerDeps
  readonly #maxReorgWalk: number
  readonly #confirmBatch: number
  #identityVerified = false

  constructor(deps: SolanaWorkerDeps) {
    this.#d = deps
    this.#maxReorgWalk = deps.maxReorgWalk ?? 512
    this.#confirmBatch = deps.confirmBatch ?? 200
  }

  get scope(): ChainScope {
    return this.#d.scope
  }

  get family(): ChainFamily {
    return 'solana'
  }

  get #labels(): Record<string, string> {
    return { chain: this.#d.scope.chain, network: this.#d.scope.network }
  }

  async verifyIdentity(signal: AbortSignal): Promise<void> {
    const genesis = await this.#d.rpc.call<string>('getGenesisHash', [], { signal })
    if (!ACCEPTED_GENESIS[this.#d.scope.network].includes(genesis)) {
      throw new SolanaClusterError(this.#d.scope, genesis)
    }
    this.#identityVerified = true
    this.#d.logger.info('solana cluster verified', { ...this.#labels, genesis })
  }

  async #ensureIdentity(signal: AbortSignal): Promise<void> {
    if (this.#identityVerified) return
    await this.verifyIdentity(signal)
  }

  async persistHealth(): Promise<void> {
    for (const snapshot of this.#d.rpc.snapshot()) {
      await upsertProviderHealth(this.#d.sql, this.#d.scope, snapshot)
    }
  }

  async follow(signal: AbortSignal): Promise<FollowOutcome> {
    const empty: FollowOutcome = {
      blocksIndexed: 0,
      tipHeight: null,
      lag: null,
      reorgs: [],
      confirmed: 0,
      halted: false,
      providerUnavailable: false,
    }

    if (await isHalted(this.#d.sql, this.#d.scope)) {
      this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)
      return { ...empty, halted: true }
    }
    this.#d.metrics.set(CHAIN_HALTED, 0, this.#labels)

    let tip: number
    let finalizedSlot: number
    try {
      await this.#ensureIdentity(signal)
      // Two commitments, two questions. `confirmed` is how far there is anything to look at;
      // `finalized` is how far back the answer can still change. Everything below turns on the
      // second, and reading it once per tick is what keeps the whole tick self-consistent.
      tip = await this.#slotAt('confirmed', signal)
      finalizedSlot = await this.#slotAt('finalized', signal)
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        this.#d.logger.warn('no provider answered for the slot', { ...this.#labels, err })
        return { ...empty, providerUnavailable: true }
      }
      throw err
    }
    await recordTip(this.#d.sql, this.#d.scope, tip)
    this.#d.metrics.set(TIP_HEIGHT, tip, this.#labels)

    /*
     * AND DELIBERATELY NO `indexer_chain_difficulty` HERE (micro-org#363).
     *
     * `evm.ts` and `bitcoin.ts` both publish that gauge from the block they have just indexed, and
     * the symmetry makes this file look unfinished. It is not. Solana has no proof of work, so
     * there is no difficulty to read: not a difficulty this worker failed to find, not one behind
     * an RPC nobody wired up — the quantity does not exist. Leader schedules are stake-weighted and
     * slots are wall-clock ticks.
     *
     * The tempting thing is to publish 0, or 1, so the gauge has a series for every chain and the
     * dashboard has no holes. That is precisely the defect `beacon_chain_height_spread` was retired
     * for on 2026-08-10: it published a number that was constant by construction, which converted
     * "we cannot observe this" into "we observed it and it is fine". A missing series is legible —
     * an alert over it returns nothing and says so. A fabricated one is not.
     *
     * If a Solana health signal is ever wanted here, the honest ones are skip rate and the
     * confirmed-to-finalized distance, and both are new metrics with their own names.
     */

    const reorgs: ReorgOutcome[] = []
    let blocksIndexed = 0
    let halted = false
    let providerUnavailable = false

    try {
      // Check one: is the stored head still the block the cluster has at that slot.
      const head = await headBlock(this.#d.sql, this.#d.scope)
      if (head) {
        const onChain = await this.#blockAt(head.height, signal)
        if (!onChain || onChain.blockhash !== head.hash) {
          const outcome = await this.#handleReorg(head.height, finalizedSlot, signal)
          reorgs.push(outcome)
          halted = outcome.alarming
        }
      }

      let cursor = halted ? null : await this.#cursor(tip)
      let budget = this.#d.followBatchBlocks

      while (!halted && cursor !== null && budget > 0 && !signal.aborted) {
        if (cursor >= tip) break
        // Which slots in the next window actually produced a block. A slot that is absent from
        // this answer was SKIPPED — normal traffic, not a gap, not a retry and not a reorg.
        const upper = Math.min(tip, cursor + budget)
        const slots = await this.#blocksBetween(cursor + 1, upper, signal)
        if (slots.length === 0) {
          // Nothing was produced in the window. The window is still walked: leaving the cursor
          // behind would re-ask the same empty range for ever.
          cursor = upper
          await this.#advanceOverEmptyRange(upper)
          break
        }

        let reorgedThisPass = false
        for (const slot of slots) {
          if (budget <= 0 || signal.aborted) break
          const raw = await this.#blockAt(slot, signal)
          // Listed a moment ago and gone now: the fork that held it lost. The next tick re-reads.
          if (!raw) continue

          // Check two: the forward link. Solana states its own parent, so this compares against
          // `parentSlot` — NOT against `slot - 1`, which is usually a slot that never existed.
          const parent = await blockAtHeight(this.#d.sql, this.#d.scope, raw.parentSlot)
          if (parent && parent.hash !== raw.previousBlockhash) {
            if (reorgs.length >= MAX_REORGS_PER_TICK) {
              reorgedThisPass = true
              break
            }
            const outcome = await this.#handleReorg(raw.parentSlot, finalizedSlot, signal)
            reorgs.push(outcome)
            if (outcome.alarming) {
              halted = true
              break
            }
            cursor = outcome.commonAncestorHeight
            reorgedThisPass = true
            break
          }

          await this.#indexBlock(raw, slot, TIP_STREAM)
          blocksIndexed += 1
          cursor = slot
          budget -= 1
        }
        if (halted) break
        // Budget still left and no reorg means every slot the window listed has been indexed, so
        // the cursor may advance past the WHOLE window — including the skipped slots inside it,
        // which will never produce a block and must not be waited for. If the budget ran out
        // mid-window the cursor is already at the last slot actually indexed, and the next tick
        // resumes there.
        if (!reorgedThisPass && budget > 0) {
          cursor = upper
          await this.#advanceOverEmptyRange(cursor)
        }
      }
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        this.#d.logger.warn('provider became unavailable mid-tick', { ...this.#labels, err })
        providerUnavailable = true
      } else {
        throw err
      }
    }

    const confirmed = halted ? 0 : await this.#confirm(tip, finalizedSlot)

    const cursorNow = await this.#storedHeight()
    const lag = cursorNow === null ? tip : Math.max(0, tip - cursorNow)
    this.#d.metrics.set(LAG_BLOCKS, lag, this.#labels)

    return { blocksIndexed, tipHeight: tip, lag, reorgs, confirmed, halted, providerUnavailable }
  }

  async backfill(signal: AbortSignal): Promise<BackfillOutcome> {
    const none: BackfillOutcome = {
      stream: null,
      blocksIndexed: 0,
      complete: true,
      providerUnavailable: false,
    }
    if (await isHalted(this.#d.sql, this.#d.scope)) return none

    const checkpoint = await nextUnfinishedBackfill(this.#d.sql, this.#d.scope)
    if (!checkpoint || checkpoint.rangeFrom === null || checkpoint.rangeTo === null) return none

    const to = checkpoint.rangeTo
    let cursor = checkpoint.height ?? checkpoint.rangeFrom - 1
    let blocksIndexed = 0
    let providerUnavailable = false

    try {
      await this.#ensureIdentity(signal)
      let budget = this.#d.backfillBatchBlocks
      while (budget > 0 && cursor < to && !signal.aborted) {
        const upper = Math.min(to, cursor + budget)
        const slots = await this.#blocksBetween(cursor + 1, upper, signal)
        for (const slot of slots) {
          const raw = await this.#blockAt(slot, signal)
          if (!raw) continue
          await this.#indexBlock(raw, slot, checkpoint.stream)
          blocksIndexed += 1
          budget -= 1
        }
        cursor = upper
        await setCheckpointForStream(this.#d.sql, this.#d.scope, checkpoint.stream, cursor)
      }
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        providerUnavailable = true
      } else {
        throw err
      }
    }

    return {
      stream: checkpoint.stream,
      blocksIndexed,
      complete: cursor >= to,
      providerUnavailable,
    }
  }

  /* ---------------------------------------------------------------- internals */

  async #slotAt(commitment: 'confirmed' | 'finalized', signal: AbortSignal): Promise<number> {
    return this.#d.rpc.call<number>('getSlot', [{ commitment }], { signal })
  }

  /**
   * The slots in `[from, to]` that actually produced a block.
   *
   * This is the method that makes skipped slots a non-event. There is no equivalent in `evm.ts`
   * because on an EVM chain every height has a block by construction, so the follower can simply
   * count. Counting here would ask for slots that never existed and read each refusal as a gap.
   */
  async #blocksBetween(from: number, to: number, signal: AbortSignal): Promise<number[]> {
    if (to < from) return []
    const slots = await this.#d.rpc.call<readonly number[] | null>(
      'getBlocks',
      [from, to, { commitment: 'confirmed' }],
      { signal },
    )
    return slots ? [...slots] : []
  }

  async #blockAt(slot: number, signal: AbortSignal): Promise<RawSolBlock | null> {
    try {
      const raw = await this.#d.rpc.call<RawSolBlock | null>(
        'getBlock',
        [
          slot,
          {
            encoding: 'json',
            transactionDetails: 'full',
            rewards: false,
            commitment: 'confirmed',
            // Without this the node REFUSES any block containing a versioned transaction rather
            // than returning it, so a single versioned transaction would make the whole slot
            // permanently unreadable and stall the follower on it.
            maxSupportedTransactionVersion: 0,
          },
        ],
        { signal },
      )
      if (!raw || !raw.blockhash) return null
      return raw
    } catch (err) {
      // A skipped or unavailable slot is an ANSWER. Treating it as a failure is the single
      // easiest way to write a Solana follower that never advances.
      if (err instanceof RpcError && MISSING_BLOCK_CODES.has(err.code)) return null
      throw err
    }
  }

  async #cursor(tip: number): Promise<number | null> {
    const checkpoint = await getCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM)
    if (checkpoint?.height !== null && checkpoint?.height !== undefined) return checkpoint.height
    const head = await headBlock(this.#d.sql, this.#d.scope)
    if (head) return head.height
    if (this.#d.startHeight !== undefined) return this.#d.startHeight - 1
    const window = requiredConfirmations(this.#d.scope.chain) * 2
    return Math.max(0, tip - window) - 1
  }

  async #storedHeight(): Promise<number | null> {
    const checkpoint = await getCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM)
    return checkpoint?.height ?? null
  }

  /**
   * Move the checkpoint over a run of slots that produced nothing.
   *
   * The checkpoint's `block_hash` is deliberately left as it was: it names the last block actually
   * seen, and pointing it at a slot with no block would name something that does not exist.
   */
  async #advanceOverEmptyRange(slot: number): Promise<void> {
    const current = await getCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM)
    if (current && current.height !== null && current.height >= slot) return
    await setCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM, slot, current?.blockHash ?? null)
  }

  async #indexBlock(raw: RawSolBlock, slot: number, stream: string): Promise<void> {
    const asset = assetOf(this.#d.scope.chain)
    const extracted = extractSolanaBlock(raw, slot, asset)
    const addresses = [...new Set(extracted.activity.map((a) => a.address))]

    let observed = 0
    await withOutbox(this.#d.sql, this.#d.producer, async (tx, emit) => {
      const watched = await filterWatched(tx, this.#d.scope, addresses)

      await upsertBlock(tx, this.#d.scope, extracted.block)
      for (const transaction of extracted.transactions) {
        await upsertTransaction(tx, this.#d.scope, transaction)
      }
      for (const mv of extracted.activity) {
        const { inserted } = await upsertActivity(tx, this.#d.scope, mv)
        this.#d.metrics.increment(ACTIVITY_TOTAL, {
          ...this.#labels,
          direction: mv.direction,
          asset_kind: mv.assetKind,
        })
        if (!inserted || mv.direction !== 'in' || !watched.has(mv.address)) continue
        observed += 1
        emit({
          topic: DEPOSIT_OBSERVED,
          key: `${this.#d.scope.chain}:${this.#d.scope.network}:${mv.address}`,
          payload: this.#depositPayload(mv, extracted.block, null),
        })
      }
      await setCheckpoint(tx, this.#d.scope, stream, slot, extracted.block.hash)
    })

    this.#d.metrics.increment(BLOCKS_INDEXED_TOTAL, { ...this.#labels, stream })
    this.#d.metrics.increment(
      TRANSACTIONS_INDEXED_TOTAL,
      this.#labels,
      extracted.transactions.length,
    )
    if (observed > 0) {
      this.#d.metrics.increment(DEPOSITS_OBSERVED_TOTAL, this.#labels, observed)
    }
  }

  /**
   * Retract an abandoned fork, or halt because settled history moved.
   *
   * The walk itself looks like the EVM one and the resemblance is superficial. What decides the
   * outcome is not how far it walked but **where it stopped**: an ancestor above the finalized
   * slot is an ordinary abandoned fork at any distance, and an ancestor at or below it means the
   * endpoint contradicted its own finality guarantee, which no depth makes acceptable.
   */
  async #handleReorg(
    forkSlot: number,
    finalizedSlot: number,
    signal: AbortSignal,
  ): Promise<ReorgOutcome> {
    const scope = this.#d.scope
    const previousHead = await headBlock(this.#d.sql, scope)
    if (!previousHead) throw new Error('reorg handling reached with no stored head')

    // Anything at or below the finalized slot is settled. A disagreement there is not something to
    // walk past — it is the incident itself, and it is reported before any row is touched.
    if (forkSlot <= finalizedSlot) {
      const stored = await blockAtHeight(this.#d.sql, scope, forkSlot)
      const onChain = await this.#blockAt(forkSlot, signal)
      if (stored && onChain && onChain.blockhash !== stored.hash) {
        await haltChain(
          this.#d.sql,
          scope,
          `finalized slot ${forkSlot} changed hash — settled history does not fork`,
        )
        this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)
        throw new SolanaFinalizedForkError(scope, forkSlot, finalizedSlot)
      }
    }

    let ancestorSlot = -1
    let ancestorHash = ''
    // The floor is the finalized slot, not an arbitrary walk budget: there is nothing to find
    // below it, because nothing below it can have changed.
    const floor = Math.max(0, Math.min(finalizedSlot, forkSlot - this.#maxReorgWalk))

    for (let slot = forkSlot; slot >= floor; slot--) {
      const stored = await blockAtHeight(this.#d.sql, scope, slot)
      // A slot we never stored — skipped, or below our history. Not a disagreement.
      if (!stored) {
        if (slot <= finalizedSlot) {
          ancestorSlot = slot
          ancestorHash = ''
          break
        }
        continue
      }
      const onChain = await this.#blockAt(slot, signal)
      if (onChain && onChain.blockhash === stored.hash) {
        ancestorSlot = slot
        ancestorHash = stored.hash
        break
      }
    }

    if (ancestorSlot < 0) {
      await haltChain(
        this.#d.sql,
        scope,
        `no common ancestor found down to the finalized slot ${finalizedSlot}`,
      )
      this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)
      throw new SolanaFinalizedForkError(scope, forkSlot, finalizedSlot)
    }

    // A SLOT distance, not a block count — slots pass whether or not anyone produces a block, so
    // this number is closer to a duration than to EVM's or Bitcoin's depth. It is recorded because
    // an operator wants it; nothing branches on it, and `alarming` below is decided elsewhere.
    const depth = Math.max(1, previousHead.height - ancestorSlot)
    // THE Solana rule. Not `isReorgAlarming(depth)`.
    const isAlarming = ancestorSlot < finalizedSlot

    const outcome = await withOutbox(this.#d.sql, this.#d.producer, async (tx) => {
      const counts = await orphanAbove(tx, scope, ancestorSlot, depth)
      await insertReorg(tx, scope, {
        commonAncestorHeight: ancestorSlot,
        commonAncestorHash: ancestorHash,
        previousTipHeight: previousHead.height,
        previousTipHash: previousHead.hash,
        depth,
        alarming: isAlarming,
        counts,
      })
      await setCheckpoint(tx, scope, TIP_STREAM, ancestorSlot, ancestorHash || null)
      if (isAlarming) {
        await haltChain(
          tx,
          scope,
          `fork below the finalized slot ${finalizedSlot} — settled history does not fork`,
        )
      }
      const result: ReorgOutcome = {
        depth,
        commonAncestorHeight: ancestorSlot,
        previousTipHeight: previousHead.height,
        alarming: isAlarming,
        orphanedBlocks: counts.blockHashes.length,
        orphanedTransactions: counts.transactions,
        orphanedActivity: counts.activity,
      }
      return result
    })

    this.#d.metrics.increment(REORGS_TOTAL, {
      ...this.#labels,
      depth: depthBucket(depth),
      alarming: String(isAlarming),
    })
    if (isAlarming) this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)

    const line = {
      ...this.#labels,
      slotDistance: depth,
      commonAncestorSlot: ancestorSlot,
      finalizedSlot,
      previousTipSlot: previousHead.height,
      orphanedBlocks: outcome.orphanedBlocks,
      orphanedTransactions: outcome.orphanedTransactions,
      orphanedActivity: outcome.orphanedActivity,
    }
    if (isAlarming) {
      this.#d.logger.error(
        'a fork below the finalized slot — this chain is halted until an operator clears it',
        line,
      )
    } else {
      this.#d.logger.warn('an unfinalized fork was abandoned and retracted', line)
    }
    return outcome
  }

  /**
   * Report every watched inbound movement that is settled.
   *
   * Two conditions, and the AND is the point:
   *
   *   * **the slot is at or below the finalized slot** — the cluster's own statement that the
   *     block cannot be rolled back. This is the real one, and it is the condition `evm.ts` has no
   *     equivalent of;
   *   * **and `contracts-chain` agrees on depth** — SOL's declared 32. Keeping it means
   *     `settlement`, `custody`, `wallet` and this service still credit at one agreed number, and
   *     that agreement is the entire reason the package is exact-pinned.
   *
   * Requiring both is strictly safer than either alone and lets neither drift unnoticed.
   */
  async #confirm(tip: number, finalizedSlot: number): Promise<number> {
    const required = requiredConfirmations(this.#d.scope.chain)
    const byDepth = tip - required + 1
    const bound = Math.min(byDepth, finalizedSlot)
    if (bound < 0) return 0

    return withOutbox(this.#d.sql, this.#d.producer, async (tx, emit) => {
      const pending = await pendingConfirmations(tx, this.#d.scope, bound, this.#confirmBatch)
      const confirmedIds: string[] = []
      for (const mv of pending) {
        const confirmations = confirmationsAt(tip, mv.blockHeight)
        if (!creditable(this.#d.scope.chain, confirmations)) continue
        if (mv.blockHeight > finalizedSlot) continue
        confirmedIds.push(mv.id)
        emit({
          topic: DEPOSIT_CONFIRMED,
          key: `${this.#d.scope.chain}:${this.#d.scope.network}:${mv.address}`,
          payload: this.#depositPayload(
            {
              address: mv.address,
              direction: mv.direction,
              assetCode: mv.assetCode,
              assetKind: mv.assetKind,
              tokenAddress: mv.tokenAddress,
              amount: mv.amount,
              txHash: mv.txHash,
              entryKey: '',
              logIndex: mv.logIndex,
              blockHeight: mv.blockHeight,
              blockHash: mv.blockHash,
            },
            null,
            confirmations,
          ),
        })
      }
      await markConfirmed(tx, this.#d.scope, confirmedIds)
      if (confirmedIds.length > 0) {
        this.#d.metrics.increment(DEPOSITS_CONFIRMED_TOTAL, this.#labels, confirmedIds.length)
      }
      return confirmedIds.length
    })
  }

  #depositPayload(
    mv: ActivityInput,
    block: BlockInput | null,
    confirmations: number | null,
  ): Record<string, unknown> {
    const asset = assetOf(this.#d.scope.chain)
    return {
      chain: this.#d.scope.chain,
      network: this.#d.scope.network,
      address: mv.address,
      direction: mv.direction,
      assetCode: mv.assetCode,
      assetKind: mv.assetKind,
      tokenAddress: mv.tokenAddress,
      amount: mv.amount.toString(),
      txHash: mv.txHash,
      txUrn: txUrn(asset, this.#d.scope.network, mv.txHash),
      explorerUrl: explorerTxUrl(asset, this.#d.scope.network, mv.txHash),
      logIndex: mv.logIndex,
      // The SLOT. Named `blockHeight` because that is the shared field every consumer reads, and
      // `slot` is repeated beside it so nobody has to know which of Solana's two numbers this is.
      blockHeight: mv.blockHeight,
      slot: mv.blockHeight,
      blockHash: mv.blockHash,
      blockTime: block ? block.blockTime.toISOString() : null,
      confirmations,
      requiredConfirmations: requiredConfirmations(this.#d.scope.chain),
    }
  }
}

/** Advance a backfill stream over a window, without naming a block that may not exist. */
async function setCheckpointForStream(
  sql: Db,
  scope: ChainScope,
  stream: string,
  slot: number,
): Promise<void> {
  const current = await getCheckpoint(sql, scope, stream)
  await setCheckpoint(sql, scope, stream, slot, current?.blockHash ?? null)
}
