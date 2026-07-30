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
  ensureBackfill,
  getCheckpoint,
  listProviderHealth,
  recentReorgs,
  transactionByHash,
  watchAddress,
  type Exec,
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
  readonly status: 'included' | 'orphaned'
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

export interface ReadStore {
  status(scope: ChainScope): Promise<ChainStatus>
  activity(
    scope: ChainScope,
    address: string,
    limit: number,
    cursor: string | null,
  ): Promise<ActivityPageView>
  transaction(scope: ChainScope, hash: string): Promise<TransactionView | null>
  block(scope: ChainScope, height: number): Promise<BlockView | null>
  watch(scope: ChainScope, address: string, label: string | null): Promise<void>
  requestBackfill(scope: ChainScope, from: number, to: number): Promise<string>
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

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
      const [checkpoint, page] = await Promise.all([
        getCheckpoint(exec, scope, TIP_STREAM),
        activityForAddress(exec, scope, address, limit, cursor),
      ])
      const tipHeight = checkpoint?.tipHeight ?? null
      return {
        chain: scope.chain,
        network: scope.network,
        address,
        tipHeight,
        requiredConfirmations: requiredConfirmations(scope.chain),
        items: page.items.map((item) => {
          const confirmations =
            tipHeight === null || item.status === 'orphaned'
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

    async watch(scope, address, label) {
      await watchAddress(exec, scope, address, label)
    },

    async requestBackfill(scope, from, to) {
      return ensureBackfill(exec, scope, from, to)
    },
  }
}
