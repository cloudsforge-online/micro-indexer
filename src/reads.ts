/**
 * The read API's view of the database, and the only place a stored row becomes JSON.
 *
 * It exists as an interface so a route can be tested without a database and a query can be tested
 * without a socket, and because the conversions it performs are the ones most likely to be got
 * wrong somewhere else if they are spread around:
 *
 *   - **Amounts leave as decimal strings.** `JSON.stringify` cannot serialise a `bigint` at all,
 *     and the obvious repair — `Number(amount)` — silently loses the low digits of any 18-decimal
 *     value above about 9 ETH. A string is the only representation that survives the round trip.
 *   - **Confirmations are computed here, from the tip, at the moment of the read.** They are not a
 *     column, because a stored confirmation count is wrong the moment the next block is mined and
 *     a crediting decision taken against a stale one is the failure the depth exists to prevent.
 *   - **`requiredConfirmations` is returned alongside.** A consumer must never have to hardcode a
 *     depth to interpret this API; the number comes from `contracts-chain` and travels with the
 *     answer.
 *
 * ## Two reads that exist because a consumer was blocked, and what makes them safe
 *
 * `confirmation` and `tokenBalances` were added for `micro-market`'s escrow gate and
 * `micro-community`'s token-gating job (18-build-status §3.3j). Both are decision inputs rather
 * than records, and both are read during reorgs, so both are built on the same two rules:
 *
 *   1. **Confirmations are counted against the stored canonical HEAD, never against
 *      `checkpoints.tip_height`.** The tip is what a provider last claimed; the head is what this
 *      service has actually walked and would have detected a reorg in. Counting against blocks
 *      nobody here has looked at over-reports depth, and over-reporting depth credits early.
 *   2. **A read that would straddle a reorg takes one snapshot.** `confirmation` is a single
 *      statement; `tokenBalances` is a REPEATABLE READ transaction. `orphanAbove` retracts blocks,
 *      transactions and activity together, so one snapshot sees all of a reorg or none of it.
 */

import { chainSpec, explorerTxUrl, formatAmount, txUrn } from '@cloudsforge/contracts-chain'
import {
  assetOf,
  confirmationsAt,
  creditable,
  declaredChainId,
  familyOf,
  requiredConfirmations,
  type ChainScope,
} from './chains.ts'
import type { Db } from './outbox.ts'
import {
  TIP_STREAM,
  activityForAddress,
  blockWithTransactions,
  canonicalCoverage,
  confirmationOf,
  custodyAddressHistory,
  ensureBackfill,
  getCheckpoint,
  headBlock,
  listProviderHealth,
  partialFromHeight,
  recentReorgs,
  tokenBalancesAt,
  transactionByHash,
  watchAddress,
  type Exec,
  type HistoryClaim,
} from './store.ts'

export interface ProviderView {
  readonly provider: string
  readonly host: string
  readonly state: 'healthy' | 'degraded' | 'down'
  readonly consecutiveFailures: number
  readonly totalRequests: number
  readonly totalFailures: number
  readonly latencyMs: number | null
  readonly lastOkAt: string | null
  readonly lastFailureAt: string | null
  readonly lastError: string | null
  readonly rateLimitedUntil: string | null
}

export interface ChainStatus {
  readonly chain: string
  readonly network: string
  readonly family: string
  readonly asset: string
  readonly chainId: number | null
  readonly requiredConfirmations: number
  readonly reorgAlarmDepth: number
  readonly tipHeight: number | null
  readonly tipSeenAt: string | null
  readonly indexedHeight: number | null
  readonly indexedHash: string | null
  /** Null when no tip has ever been observed — a lag of zero would be a lie, not a default. */
  readonly lagBlocks: number | null
  readonly halted: boolean
  readonly haltReason: string | null
  readonly providers: readonly ProviderView[]
  readonly recentReorgs: ReadonlyArray<{
    readonly id: string
    readonly detectedAt: string
    readonly depth: number
    readonly commonAncestorHeight: number
    readonly alarming: boolean
    readonly orphanedBlocks: number
    readonly orphanedTransactions: number
    readonly orphanedActivity: number
  }>
}

export interface ActivityView {
  readonly id: string
  readonly address: string
  readonly direction: 'in' | 'out'
  readonly assetCode: string
  readonly assetKind: 'native' | 'token'
  readonly tokenAddress: string | null
  readonly amount: string
  readonly amountFormatted: string | null
  readonly txHash: string
  readonly txUrn: string
  readonly explorerUrl: string | null
  readonly logIndex: number | null
  readonly blockHeight: number
  readonly blockHash: string
  /**
   * `conflicted` is reachable only on a UTXO family, and it is the one a consumer must branch on:
   * an `orphaned` movement may still be re-mined, a `conflicted` one cannot, because the coins
   * behind it have been spent by a different canonical transaction. A wallet that treats the two
   * alike waits forever for a confirmation that is not coming. See `store.markConflictedSpends`.
   */
  readonly status: 'included' | 'orphaned' | 'conflicted'
  readonly confirmations: number | null
  readonly confirmed: boolean
  readonly firstSeenAt: string
  readonly confirmedAt: string | null
  readonly reorgedAt: string | null
}

export interface ActivityPageView {
  readonly chain: string
  readonly network: string
  readonly address: string
  readonly tipHeight: number | null
  readonly requiredConfirmations: number
  readonly items: readonly ActivityView[]
  readonly nextCursor: string | null
  /**
   * Present exactly when the page is not this address's record, and absent when it is.
   *
   * `address_activity` was written for every address a block touched, which is what let the block
   * explorer and `wallet`'s portfolio ask about addresses nobody registered. A deployment running
   * `INDEXER_WATCHED_ADDRESSES_ONLY` no longer records those, and the answer for one of them is an
   * empty page — which reads as "this address has never transacted" and is a different, false
   * statement. So the page says which it is. An empty `items` with this field set means **unknown**;
   * an empty `items` without it means **nothing happened**.
   *
   * `fromHeight` is the height at which the recorded set narrows: below it every address was
   * recorded, at and above it only watched ones were. It is read off the head block rather than
   * searched for, so it is the conservative answer — the whole record above the point the switch
   * was last seen on is suspect, including any window in which it was switched back off.
   */
  readonly incomplete?: {
    readonly reason: 'address_not_watched'
    readonly fromHeight: number
  }
}

export interface TransactionView {
  readonly chain: string
  readonly network: string
  readonly hash: string
  readonly txUrn: string
  readonly explorerUrl: string | null
  readonly blockHash: string | null
  readonly blockHeight: number | null
  readonly txIndex: number | null
  readonly from: string | null
  readonly to: string | null
  readonly value: string
  readonly fee: string | null
  readonly status: string
  readonly nonceOrSequence: number | null
  readonly confirmations: number | null
  readonly detail: Record<string, unknown>
  readonly firstSeenAt: string
  readonly logs: ReadonlyArray<{
    readonly logIndex: number
    readonly address: string
    readonly topics: readonly string[]
    readonly data: string
    readonly status: string
  }>
}

export interface BlockView {
  readonly chain: string
  readonly network: string
  readonly height: number
  readonly hash: string
  readonly parentHash: string
  readonly blockTime: string
  readonly status: string
  readonly reorgDepth: number | null
  readonly txCount: number
  readonly confirmations: number | null
  readonly detail: Record<string, unknown>
  readonly transactionHashes: readonly string[]
}

/**
 * Whether a transaction has reached its depth, and nothing else.
 *
 * Separate from `TransactionView` because the two answer different questions for different
 * callers. `TransactionView` is a record of what the chain said; this is a decision input, and a
 * caller taking a money decision on it must not have to reconstruct the depth policy, guess at the
 * head, or notice that `status` was `failed` — so `confirmed` is computed here, once, and every
 * input it was computed from travels with it.
 *
 * **A transaction this indexer has never seen does not produce one of these.** The read returns
 * null and the route answers 404 `transaction_not_found`, which is a different answer from a 200
 * saying `confirmed: false`. Collapsing the two is precisely the defect that made
 * `micro-market` report "the on-chain escrow is not confirmed yet" for a route that did not exist.
 */
export interface ConfirmationView {
  readonly chain: string
  readonly network: string
  readonly hash: string
  readonly txUrn: string
  readonly explorerUrl: string | null
  readonly status: string
  readonly blockHash: string | null
  readonly blockHeight: number | null
  /** True while the block this transaction names is still on the canonical chain. */
  readonly canonical: boolean
  /** Null whenever there is nothing honest to count: pending, dropped, or reorged away. */
  readonly confirmations: number | null
  readonly requiredConfirmations: number
  /**
   * The one field a caller may act on. True only when the transaction succeeded, is on the
   * canonical chain, has reached the depth `contracts-chain` publishes for this coin, and the
   * chain is not halted.
   */
  readonly confirmed: boolean
  /** The highest canonical block this service has walked. Confirmations are counted against it. */
  readonly indexedHeight: number | null
  /** What a provider last claimed the tip was. Reported for lag, never counted against. */
  readonly tipHeight: number | null
  readonly halted: boolean
}

export interface TokenBalanceView {
  readonly contract: string
  /** Smallest units, decimal string. A uint256 does not survive a JSON number. */
  readonly balance: string
}

/**
 * What the indexer's own record says an address holds, and the evidence that it is a balance.
 *
 * **A balance derived from movements is only a balance if the movements are all of them**, so
 * `coverage` is not decoration: it is the reason the number may be believed. When the canonical
 * chain this service holds does not run unbroken from the genesis block to `atBlock`, `balances`
 * and `balance` are **absent** — not zero, not null. A consumer's rule is then the same as for an
 * outage, which for `micro-community`'s gate means "do not demote", and that is the correct
 * behaviour: an indexer that started following at the tip knows nothing about what anybody held.
 *
 * `coverage` answers that question about BLOCKS, and it is necessary rather than sufficient. Since
 * micro-org#253 a block can be walked for only some addresses, and a complete `coverage` over such
 * blocks says nothing about whether the rows for THIS address were ever written — so
 * `unavailable: 'address_not_watched'` is the second half of the same guarantee. See the field.
 */
export interface CoverageView {
  readonly fromHeight: number | null
  readonly toHeight: number | null
  readonly blocks: number
  /** True only when the range is [0, atBlock] with no hole in it. */
  readonly complete: boolean
}

export interface TokenBalancesView {
  readonly chain: string
  readonly network: string
  readonly address: string
  /** The height the answer is as at. Null when nothing has been indexed for this scope. */
  readonly atBlock: number | null
  readonly indexedHeight: number | null
  readonly tipHeight: number | null
  readonly halted: boolean
  readonly coverage: CoverageView
  /** Absent unless the answer may be believed. A missing balance is missing, never zero. */
  readonly balances?: readonly TokenBalanceView[]
  /** Absent unless a single `contract` was asked for and the answer may be believed. */
  readonly balance?: string
  /**
   * Present exactly when a balance is withheld, naming which of the reasons applied.
   *
   * **`address_not_watched` is the one that is not about coverage**, and it was added because the
   * other four could not express it (micro-org#281). The three that guard the sum are statements
   * about BLOCKS; on a deployment running `INDEXER_WATCHED_ADDRESSES_ONLY` every block is present and
   * canonical, so `coverage.complete` is true and no refusal fires — while the `address_activity`
   * rows this sum is made of were never written for an address nobody registered. The sum is then
   * empty, and an empty sum left as `balances: []` is a nought with an indexer's authority behind
   * it on the read a token gate demotes from. See `activity`'s `incomplete` marker, which is the
   * same fact about the same rows, decided by the same predicate.
   */
  readonly unavailable?:
    | 'nothing_indexed'
    | 'coverage_incomplete'
    | 'chain_halted'
    | 'negative'
    | 'address_not_watched'
  /**
   * Set exactly when `unavailable` is `address_not_watched`: the height at which the recorded set
   * narrows. Below it every address was recorded, at and above it only watched ones were.
   *
   * Carried here so this read is answerable on its own. It is the same number `activity` reports as
   * `incomplete.fromHeight`, and it is here because without it a consumer that wanted to know how
   * much of the record is suspect would have to go and ask the other resource — which is the
   * coupling this field exists to let `explorer-web` delete.
   */
  readonly notWatchedFromHeight?: number
}

export interface ReadStore {
  status(scope: ChainScope): Promise<ChainStatus>
  activity(
    scope: ChainScope,
    address: string,
    limit: number,
    cursor: string | null,
  ): Promise<ActivityPageView>
  transaction(scope: ChainScope, hash: string): Promise<TransactionView | null>
  /** Null means this indexer has never seen the transaction, which is not "unconfirmed". */
  confirmation(scope: ChainScope, hash: string): Promise<ConfirmationView | null>
  tokenBalances(
    scope: ChainScope,
    address: string,
    contract: string | null,
    atBlock: number | null,
  ): Promise<TokenBalancesView>
  block(scope: ChainScope, height: number): Promise<BlockView | null>
  /**
   * `historyFromHeight` is the registrar's claim that this address had no chain activity below
   * that height — the input `custody.ts` needs before it will derive a UTXO balance. Null means
   * nobody said, which is a refusal there and not a zero. `'head'` resolves the claim against this
   * service's own view of the chain at write time, which is what a caller that has just derived the
   * key can say truthfully without having to know the height itself.
   *
   * A stated NUMBER also enqueues a rescan of the range it names, because on a deployment that
   * records only watched addresses the blocks below the registration do not contain this one. See
   * the implementation for why `'head'` deliberately does not need one.
   */
  watch(
    scope: ChainScope,
    address: string,
    label: string | null,
    historyFromHeight?: HistoryClaim,
  ): Promise<void>
  requestBackfill(scope: ChainScope, from: number, to: number): Promise<string>
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

/**
 * The height from which this scope's record is not this address's, or null when it is this
 * address's all the way down.
 *
 * **One function because two reads must not disagree.** `activity` and `tokenBalances` are built
 * from the same `address_activity` rows, so "were those rows written for this address" has exactly
 * one true answer, and a consumer holding both answers at once is entitled to see them agree. They
 * did not: until micro-org#281 only `activity` asked the question, `explorer-web`'s address page
 * had to pass the activity read's marker into its holdings panel to cover the gap, and a second
 * consumer would have had no reason to know it needed to. Deciding it here, once, is what makes the
 * agreement structural rather than a convention two call sites happen to share.
 *
 * Null on a scope that still records every address a block touches, which is every scope that has
 * not run `INDEXER_WATCHED_ADDRESSES_ONLY`. That case costs ONE index-only scan and the second
 * query is behind it, so the common deployment never pays for the lookup only a narrowed one
 * needs. Measured 2026-08-09 on `postgres:17-alpine`, 200 000 blocks in one scope, after
 * `vacuum analyze`: `Index Only Scan using blocks_partial_idx`, **1 buffer, 0 heap fetches,
 * 0.03 ms** with no block marked, and **4 buffers, 0.05 ms** with the highest 50 000 marked. The
 * index is partial on the marker, so an unmarked scope's entry in it is empty — which is why the
 * price of asking is a question the planner answers rather than a scan of every block walked.
 *
 * The number is the LOWEST marked height, not the most recent run of them: see
 * `store.partialFromHeight` for why over-stating how much of the record is suspect is the only
 * direction that cannot mislead anyone.
 */
async function notWatchedFromHeight(
  exec: Exec,
  scope: ChainScope,
  address: string,
): Promise<number | null> {
  const partialFrom = await partialFromHeight(exec, scope)
  if (partialFrom === null) return null
  const watched = (await custodyAddressHistory(exec, scope, [address])).length > 0
  return watched ? null : partialFrom
}

export function postgresReadStore(sql: Db): ReadStore {
  const exec: Exec = sql
  return {
    async status(scope) {
      const spec = chainSpec(assetOf(scope.chain))
      const [checkpoint, providers, reorgs] = await Promise.all([
        getCheckpoint(exec, scope, TIP_STREAM),
        listProviderHealth(exec, scope),
        recentReorgs(exec, scope, 5),
      ])
      const tipHeight = checkpoint?.tipHeight ?? null
      const indexedHeight = checkpoint?.height ?? null
      return {
        chain: scope.chain,
        network: scope.network,
        family: familyOf(scope.chain),
        asset: assetOf(scope.chain),
        chainId: declaredChainId(scope.chain, scope.network) ?? null,
        requiredConfirmations: requiredConfirmations(scope.chain),
        reorgAlarmDepth: spec.reorgAlarmDepth,
        tipHeight,
        tipSeenAt: iso(checkpoint?.tipSeenAt ?? null),
        indexedHeight,
        indexedHash: checkpoint?.blockHash ?? null,
        lagBlocks:
          tipHeight === null ? null : Math.max(0, tipHeight - (indexedHeight ?? tipHeight)),
        halted: checkpoint?.halted ?? false,
        haltReason: checkpoint?.haltReason ?? null,
        providers: providers.map((p) => ({
          provider: p.provider,
          host: p.urlHost,
          state: p.state,
          consecutiveFailures: p.consecutiveFailures,
          totalRequests: p.totalRequests,
          totalFailures: p.totalFailures,
          latencyMs: p.latencyMs,
          lastOkAt: iso(p.lastOkAt),
          lastFailureAt: iso(p.lastFailureAt),
          lastError: p.lastError,
          rateLimitedUntil: iso(p.rateLimitedUntil),
        })),
        recentReorgs: reorgs.map((r) => ({
          id: r.id,
          detectedAt: r.detectedAt.toISOString(),
          depth: r.depth,
          commonAncestorHeight: r.commonAncestorHeight,
          alarming: r.alarming,
          orphanedBlocks: r.orphanedBlocks,
          orphanedTransactions: r.orphanedTransactions,
          orphanedActivity: r.orphanedActivity,
        })),
      }
    },

    async activity(scope, address, limit, cursor) {
      const asset = assetOf(scope.chain)
      // An empty page for an unregistered address is indistinguishable from an address that has
      // never been paid, and this is the question that tells them apart. It is asked through the
      // same function `tokenBalances` asks it through — see `notWatchedFromHeight` — so the two
      // reads cannot answer differently about one address.
      const [checkpoint, page, narrowFrom] = await Promise.all([
        getCheckpoint(exec, scope, TIP_STREAM),
        activityForAddress(exec, scope, address, limit, cursor),
        notWatchedFromHeight(exec, scope, address),
      ])
      const tipHeight = checkpoint?.tipHeight ?? null
      return {
        chain: scope.chain,
        network: scope.network,
        address,
        tipHeight,
        requiredConfirmations: requiredConfirmations(scope.chain),
        items: page.items.map((item) => {
          // `!== 'included'` rather than `=== 'orphaned'`: a conflicted movement is off the chain
          // just as firmly as an orphaned one, and reporting a depth for it would be reporting a
          // depth for a transaction no block can ever contain.
          const confirmations =
            tipHeight === null || item.status !== 'included'
              ? null
              : confirmationsAt(tipHeight, item.blockHeight)
          return {
            id: item.id,
            address: item.address,
            direction: item.direction,
            assetCode: item.assetCode,
            assetKind: item.assetKind,
            tokenAddress: item.tokenAddress,
            amount: item.amount.toString(),
            // Only the native asset has a decimals this service knows. A token's decimals is a
            // call to the contract and a fact a token registry owns, so it is left unformatted
            // rather than guessed at eighteen — which is how a six-decimal stablecoin gets
            // displayed a million times too small.
            amountFormatted:
              item.assetKind === 'native'
                ? formatAmount(item.amount, chainSpec(asset).decimals)
                : null,
            txHash: item.txHash,
            txUrn: txUrn(asset, scope.network, item.txHash),
            explorerUrl: explorerTxUrl(asset, scope.network, item.txHash),
            logIndex: item.logIndex,
            blockHeight: item.blockHeight,
            blockHash: item.blockHash,
            status: item.status,
            confirmations,
            confirmed:
              confirmations !== null && creditable(scope.chain, confirmations),
            firstSeenAt: item.firstSeenAt.toISOString(),
            confirmedAt: iso(item.confirmedAt),
            reorgedAt: iso(item.reorgedAt),
          }
        }),
        nextCursor: page.nextCursor,
        ...(narrowFrom === null
          ? {}
          : { incomplete: { reason: 'address_not_watched' as const, fromHeight: narrowFrom } }),
      }
    },

    async transaction(scope, hash) {
      const [checkpoint, record] = await Promise.all([
        getCheckpoint(exec, scope, TIP_STREAM),
        transactionByHash(exec, scope, hash),
      ])
      if (!record) return null
      const asset = assetOf(scope.chain)
      const tipHeight = checkpoint?.tipHeight ?? null
      return {
        chain: scope.chain,
        network: scope.network,
        hash: record.hash,
        txUrn: txUrn(asset, scope.network, record.hash),
        explorerUrl: explorerTxUrl(asset, scope.network, record.hash),
        blockHash: record.blockHash,
        blockHeight: record.blockHeight,
        txIndex: record.txIndex,
        from: record.from,
        to: record.to,
        value: record.value.toString(),
        fee: record.fee === null ? null : record.fee.toString(),
        status: record.status,
        nonceOrSequence: record.nonceOrSequence,
        confirmations:
          tipHeight === null || record.blockHeight === null || record.status === 'orphaned'
            ? null
            : confirmationsAt(tipHeight, record.blockHeight),
        detail: record.rawRef,
        firstSeenAt: record.firstSeenAt.toISOString(),
        logs: record.logs.map((l) => ({
          logIndex: l.logIndex,
          address: l.address,
          topics: l.topics,
          data: l.data,
          status: l.status,
        })),
      }
    },

    async confirmation(scope, hash) {
      // One statement, deliberately — see `store.confirmationOf`. Two round trips can straddle a
      // reorg and count a retracted transaction against a head that has already moved past it.
      const record = await confirmationOf(exec, scope, hash)
      if (!record) return null
      const asset = assetOf(scope.chain)
      const canonical =
        record.status !== 'orphaned' &&
        record.blockStatus !== null &&
        record.blockStatus !== 'orphaned' &&
        record.blockHeight !== null
      const confirmations =
        canonical && record.headHeight !== null && record.blockHeight !== null
          ? confirmationsAt(record.headHeight, record.blockHeight)
          : null
      return {
        chain: scope.chain,
        network: scope.network,
        hash: record.hash,
        txUrn: txUrn(asset, scope.network, record.hash),
        explorerUrl: explorerTxUrl(asset, scope.network, record.hash),
        status: record.status,
        blockHash: record.blockHash,
        blockHeight: record.blockHeight,
        canonical,
        confirmations,
        requiredConfirmations: requiredConfirmations(scope.chain),
        // `status === 'success'` is not pedantry. An EVM transaction that reverted is mined, sits
        // in a block, and accumulates depth exactly like one that worked — so a confirmation test
        // that only counts blocks would tell a marketplace that a failed escrow deposit is
        // confirmed. `halted` is honoured for the reason the halt exists: an alarming reorg means
        // the assumption the depth encodes has failed, and depth is all this answer is made of.
        confirmed:
          canonical &&
          record.status === 'success' &&
          !record.halted &&
          confirmations !== null &&
          creditable(scope.chain, confirmations),
        indexedHeight: record.headHeight,
        tipHeight: record.tipHeight,
        halted: record.halted,
      }
    },

    async tokenBalances(scope, address, contract, atBlock) {
      // REPEATABLE READ, and this is the whole of the reorg argument for a balance. Coverage, head
      // and movements are three statements; under READ COMMITTED each gets its own snapshot, so a
      // reorg landing between them yields movements from after the retraction summed against a
      // coverage claim from before it. One snapshot makes the answer a statement about one state
      // of the chain, which is the only kind of statement worth making about money.
      return sql.begin('isolation level repeatable read', async (tx) => {
        const head = await canonicalCoverage(tx, scope, null)
        if (head.headHeight === null) {
          return {
            chain: scope.chain,
            network: scope.network,
            address,
            atBlock: null,
            indexedHeight: null,
            tipHeight: head.tipHeight,
            halted: head.halted,
            coverage: { fromHeight: null, toHeight: null, blocks: 0, complete: false },
            unavailable: 'nothing_indexed',
          } satisfies TokenBalancesView
        }

        // NOT clamped to the head. A caller that asks for a height this service has not reached is
        // asking a question it cannot answer, and silently answering the head's question instead
        // would hand back a number under a heading that says something else — which for a snapshot
        // gate is a balance from the wrong moment. `complete` fails below, and the balance is
        // withheld.
        const at = atBlock ?? head.headHeight
        const coverage = await canonicalCoverage(tx, scope, at)
        // Unbroken from genesis THROUGH the asked height, or it is a window total rather than a
        // balance. `blocks` counts the canonical rows at or below `at`; the range is [0, at] only
        // if there are exactly `at + 1` of them, which is a hole check that costs no extra query
        // and which also fails when `at` is above the head.
        const complete =
          coverage.lowestHeight === 0 &&
          coverage.highestHeight === at &&
          coverage.blocks === at + 1
        const view = {
          chain: scope.chain,
          network: scope.network,
          address,
          atBlock: at,
          indexedHeight: head.headHeight,
          tipHeight: head.tipHeight,
          halted: head.halted,
          coverage: {
            fromHeight: coverage.lowestHeight,
            toHeight: coverage.highestHeight,
            blocks: coverage.blocks,
            complete,
          },
        }

        if (!complete) return { ...view, unavailable: 'coverage_incomplete' } satisfies TokenBalancesView
        // A halted chain is one whose history this service has said it cannot vouch for. Answering
        // a holdings question from it would let a reorg past the alarm depth evict a community's
        // membership, which is the failure the halt was raised to stop.
        if (head.halted) return { ...view, unavailable: 'chain_halted' } satisfies TokenBalancesView

        // ── "NOBODY WROTE THIS ADDRESS DOWN" IS NOT NOUGHT. micro-org#281. ──────────────────────
        //
        // Every refusal above is a statement about BLOCKS, and that is why none of them can reach
        // this: on a deployment running `INDEXER_WATCHED_ADDRESSES_ONLY` every block is present and
        // canonical, `complete` is true, and the only thing missing is the per-address rows the sum
        // below is made of. Those rows were never written for an address nobody registered, so the
        // sum comes back empty and used to leave as `balances: []` — a nought carrying this
        // service's authority, on the read `micro-community`'s gate demotes from.
        //
        // It is a refusal and not an empty answer for the same reason `custody.ts` refuses with
        // `history_unknown` rather than summing what it happened to walk: a total over a record
        // that was never written for this subject is a measurement nobody took, and rendering one
        // as a number is the failure this estate has now been bitten by twice.
        //
        // It fires whether or not the sum found anything. Movements below `notWatchedFromHeight`
        // were recorded for everybody, so a narrowed record can hold real rows for this address and
        // still be missing every one above that height; summing those is a window total, which is
        // precisely what `coverage_incomplete` exists to refuse to do.
        //
        // AFTER the coverage and halt checks deliberately. Both of those already answer honestly
        // where they apply, and a consumer reads them today; moving this above them would change
        // answers that were never wrong. This one fires exactly where the read was confidently
        // wrong and nowhere else.
        //
        // Inside the same REPEATABLE READ snapshot as the rest, so the marker and the sum describe
        // one state of the record rather than two.
        const narrowFrom = await notWatchedFromHeight(tx, scope, address)
        if (narrowFrom !== null) {
          return {
            ...view,
            unavailable: 'address_not_watched',
            notWatchedFromHeight: narrowFrom,
          } satisfies TokenBalancesView
        }

        const records = await tokenBalancesAt(tx, scope, address, at, contract)
        // Impossible on a complete record — nobody sends what they never received — so it means the
        // derivation is wrong rather than that the address is overdrawn. Withheld, never clamped:
        // clamping to zero would turn a bug in this service into an eviction.
        if (records.some((r) => r.balance < 0n)) {
          return { ...view, unavailable: 'negative' } satisfies TokenBalancesView
        }

        const balances = records.map((r) => ({ contract: r.contract, balance: r.balance.toString() }))
        return {
          ...view,
          balances,
          // With coverage complete back to genesis AND the rows for this address actually written,
          // "no movement ever" IS a balance of zero, and a real answer that a gate should act on.
          // It is derived, not defaulted — and since micro-org#281 the second half of that sentence
          // is enforced above rather than assumed here.
          ...(contract === null ? {} : { balance: balances[0]?.balance ?? '0' }),
        } satisfies TokenBalancesView
      })
    },

    async block(scope, height) {
      const [checkpoint, record] = await Promise.all([
        getCheckpoint(exec, scope, TIP_STREAM),
        blockWithTransactions(exec, scope, height),
      ])
      if (!record) return null
      const tipHeight = checkpoint?.tipHeight ?? null
      return {
        chain: scope.chain,
        network: scope.network,
        height: record.height,
        hash: record.hash,
        parentHash: record.parentHash,
        blockTime: record.blockTime.toISOString(),
        status: record.status,
        reorgDepth: record.reorgDepth,
        txCount: record.txCount,
        confirmations: tipHeight === null ? null : confirmationsAt(tipHeight, record.height),
        detail: record.detail,
        transactionHashes: record.transactionHashes,
      }
    },

    async watch(scope, address, label, historyFromHeight = null) {
      const outcome = await watchAddress(exec, scope, address, label, historyFromHeight)

      // ── Making a newly-watched address answerable, when the record no longer holds everything.
      //
      // Once a block records only the addresses that were watched when it was walked, registering
      // an address does not retroactively put it in those blocks. Somebody has to walk them again,
      // and the mechanism for walking a range again already exists — so this enqueues one rather
      // than growing a second kind of catch-up.
      //
      // It fires for exactly one of the two claims, and the asymmetry is the whole argument:
      //
      //   * `'head'` is the claim of a caller that has JUST DERIVED THE KEY. There is nothing
      //     behind it to find, by construction, and the one block that could have been walked
      //     between reading the head and committing the row is already inside the claim — see
      //     `watchAddress`, which resolves `'head'` against the tip and not the head for precisely
      //     this reason. `micro-wallet` registers every deposit address this way, on a retry job
      //     that re-registers blindly, so this is also the path that must stay free.
      //   * A NUMBER is an operator stating that this address has history from a height, which is
      //     the case where the walked record demonstrably does not contain it. That range is
      //     rescanned, and it is deliberately NOT clamped to what has already been walked: an
      //     address funded before this service ever ran is the case the claim exists for, and
      //     narrowing the range to the part that is easy would answer a different question.
      //
      // And only when something changed. A re-registration that lowers nothing has nothing to
      // redo, which is what keeps `micro-wallet`'s blunt retry pass from enqueueing a range per
      // address per sweep.
      const changed = outcome.firstWatch || outcome.claimLowered
      if (typeof historyFromHeight === 'number' && changed && outcome.historyFromHeight !== null) {
        const head = (await headBlock(exec, scope))?.height ?? null
        if (head !== null && outcome.historyFromHeight <= head) {
          await ensureBackfill(exec, scope, outcome.historyFromHeight, head)
        }
      }
    },

    async requestBackfill(scope, from, to) {
      return ensureBackfill(exec, scope, from, to)
    },
  }
}
