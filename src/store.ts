/**
 * Every statement this service issues against chain data.
 *
 * Two rules hold across the whole file, and both are checked by `store.test.ts` rather than by
 * review, because review is what let the defect they prevent into the estate in the first place:
 *
 *   1. **Every function takes a `ChainScope`, and every statement filters on both of its
 *      columns.** 00-current-state §3.5 records XRP sharing one address across testnet and
 *      mainnet; 04-domain-model §4.1 makes "no query may span networks" an invariant. The schema
 *      makes a cross-network *reference* impossible; this file is what makes a cross-network
 *      *read* impossible, and the test greps the source for a statement that mentions a chain
 *      table without mentioning both columns.
 *
 *   2. **Nothing here decides anything.** There is no crediting, no balance, no policy. The
 *      functions record what a worker observed and answer questions about what was recorded. The
 *      one judgement in the file is `orphanAbove` clearing `confirmed_at`, and that is a
 *      retraction rather than a decision.
 *
 * Amounts cross this boundary as `bigint` and live in the database as `numeric(78,0)`, which holds
 * a uint256 exactly. postgres.js hands numerics back as strings, so every read goes through
 * `BigInt(...)` and no amount is ever a `number` at any point in this repository.
 */

import type { ISql } from 'postgres'
import type { ChainScope } from './chains.ts'

/**
 * Anything that can run a query: the pool, or a transaction inside `withOutbox`.
 *
 * `ISql` rather than `Sql` because `TransactionSql` extends `ISql` and not `Sql`, so this is the
 * one type that accepts both without a cast at every call site.
 */
export type Exec = ISql

/**
 * Bind an object to a `jsonb` column.
 *
 * The obvious spelling — interpolating `JSON.stringify(value)` and casting the parameter with
 * `::jsonb` — is wrong, and wrong in a way nothing complains about: postgres.js infers the
 * parameter's type from the target column, encodes the string it was given as a JSON *string*,
 * and the column ends up holding `"{\"miner\":…}"` rather than an object. Everything keeps
 * working until a consumer tries `detail->>'miner'` and gets null, or the read API returns a
 * quoted blob where a caller expected a field. `sql.json` is what encodes the value once.
 */
function jsonb(exec: Exec, value: Record<string, unknown>): ReturnType<Exec['json']> {
  return exec.json(value as Record<string, never>)
}

/* ------------------------------------------------------------------ records */

export type BlockStatus = 'pending' | 'included' | 'finalised' | 'orphaned'
export type TransactionStatus = 'pending' | 'success' | 'failed' | 'dropped' | 'orphaned'
export type Direction = 'in' | 'out'
export type AssetKind = 'native' | 'token'
/**
 * `conflicted` is reachable only on a UTXO family: it means the movement was retracted by a reorg
 * AND the coins behind it have since been spent by a different canonical transaction, so it can
 * never return. See `markConflictedSpends`.
 */
export type RowStatus = 'included' | 'orphaned' | 'conflicted'

export interface BlockInput {
  readonly height: number
  readonly hash: string
  readonly parentHash: string
  readonly blockTime: Date
  readonly txCount: number
  readonly detail: Record<string, unknown>
}

export interface StoredBlock extends BlockInput {
  readonly status: BlockStatus
  readonly reorgDepth: number | null
}

export interface TransactionInput {
  readonly hash: string
  readonly blockHash: string
  readonly blockHeight: number
  readonly txIndex: number
  readonly from: string | null
  readonly to: string | null
  readonly value: bigint
  readonly fee: bigint | null
  readonly status: TransactionStatus
  readonly nonceOrSequence: number | null
  readonly rawRef: Record<string, unknown>
}

export interface LogInput {
  readonly txHash: string
  readonly logIndex: number
  readonly blockHash: string
  readonly blockHeight: number
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
}

export interface ActivityInput {
  readonly address: string
  readonly direction: Direction
  readonly assetCode: string
  readonly assetKind: AssetKind
  readonly tokenAddress: string | null
  readonly amount: bigint
  readonly txHash: string
  /** Deterministic within the transaction. `activityEntryKey` is the only producer. */
  readonly entryKey: string
  readonly logIndex: number | null
  readonly blockHeight: number
  readonly blockHash: string
}

/**
 * The key that makes re-indexing a block a no-op rather than a duplicate.
 *
 * It names the movement, not the row: which log inside the transaction produced it (or `native`
 * for the value transfer of the transaction itself), which way the money went, and whose address
 * it was. A single transaction that pays an address from itself produces `in` and `out` entries
 * whose keys differ, which is correct — both movements happened.
 */
export function activityEntryKey(
  logIndex: number | null,
  direction: Direction,
  address: string,
): string {
  return `${logIndex === null ? 'native' : String(logIndex)}:${direction}:${address}`
}

/* ------------------------------------------------------------------ block writes */

interface BlockRow {
  readonly height: string
  readonly hash: string
  readonly parent_hash: string
  readonly block_time: Date
  readonly status: BlockStatus
  readonly reorg_depth: number | null
  readonly tx_count: number
  readonly detail: Record<string, unknown>
}

const toBlock = (row: BlockRow): StoredBlock => ({
  height: Number(row.height),
  hash: row.hash,
  parentHash: row.parent_hash,
  blockTime: row.block_time,
  status: row.status,
  reorgDepth: row.reorg_depth,
  txCount: row.tx_count,
  detail: row.detail,
})

/**
 * Insert or refresh a block.
 *
 * `on conflict (chain, network, hash)` is the idempotency: re-indexing a height whose block is
 * already stored updates the row it already has. What it deliberately does NOT swallow is a
 * *different* hash arriving at an already-occupied height — that violates
 * `blocks_canonical_height_uniq` and raises 23505, because the only correct way to put a new block
 * at an occupied height is to orphan the incumbent first, and a reorg path that forgot to must
 * fail loudly rather than leave two blocks claiming one height.
 */
export async function upsertBlock(
  exec: Exec,
  scope: ChainScope,
  block: BlockInput,
  status: BlockStatus = 'included',
): Promise<void> {
  await exec`
    insert into blocks (
      chain, network, height, hash, parent_hash, block_time, status, reorg_depth, tx_count, detail
    ) values (
      ${scope.chain}, ${scope.network}, ${block.height}, ${block.hash}, ${block.parentHash},
      ${block.blockTime}, ${status}, null, ${block.txCount}, ${jsonb(exec, block.detail)}
    )
    on conflict (chain, network, hash) do update set
      height      = excluded.height,
      parent_hash = excluded.parent_hash,
      block_time  = excluded.block_time,
      status      = excluded.status,
      reorg_depth = null,
      tx_count    = excluded.tx_count,
      detail      = excluded.detail,
      updated_at  = now()
  `
}

/** The canonical block at a height, or null. Orphans are excluded — they are not the chain. */
export async function blockAtHeight(
  exec: Exec,
  scope: ChainScope,
  height: number,
): Promise<StoredBlock | null> {
  const rows = await exec<BlockRow[]>`
    select height, hash, parent_hash, block_time, status, reorg_depth, tx_count, detail
      from blocks
     where chain = ${scope.chain} and network = ${scope.network}
       and height = ${height} and status <> 'orphaned'
  `
  const row = rows[0]
  return row ? toBlock(row) : null
}

export async function blockByHash(
  exec: Exec,
  scope: ChainScope,
  hash: string,
): Promise<StoredBlock | null> {
  const rows = await exec<BlockRow[]>`
    select height, hash, parent_hash, block_time, status, reorg_depth, tx_count, detail
      from blocks
     where chain = ${scope.chain} and network = ${scope.network} and hash = ${hash}
  `
  const row = rows[0]
  return row ? toBlock(row) : null
}

/** The highest canonical block. This is what the follower's parent check is anchored on. */
export async function headBlock(exec: Exec, scope: ChainScope): Promise<StoredBlock | null> {
  const rows = await exec<BlockRow[]>`
    select height, hash, parent_hash, block_time, status, reorg_depth, tx_count, detail
      from blocks
     where chain = ${scope.chain} and network = ${scope.network} and status <> 'orphaned'
     order by height desc
     limit 1
  `
  const row = rows[0]
  return row ? toBlock(row) : null
}

/* ------------------------------------------------------------------ transaction, log, activity */

export async function upsertTransaction(
  exec: Exec,
  scope: ChainScope,
  input: TransactionInput,
): Promise<void> {
  await exec`
    insert into transactions (
      chain, network, hash, block_hash, block_height, tx_index, from_address, to_address,
      value, fee, status, nonce_or_sequence, raw_ref
    ) values (
      ${scope.chain}, ${scope.network}, ${input.hash}, ${input.blockHash}, ${input.blockHeight},
      ${input.txIndex}, ${input.from}, ${input.to}, ${input.value.toString()},
      ${input.fee === null ? null : input.fee.toString()}, ${input.status},
      ${input.nonceOrSequence}, ${jsonb(exec, input.rawRef)}
    )
    on conflict (chain, network, hash) do update set
      block_hash        = excluded.block_hash,
      block_height      = excluded.block_height,
      tx_index          = excluded.tx_index,
      from_address      = excluded.from_address,
      to_address        = excluded.to_address,
      value             = excluded.value,
      fee               = excluded.fee,
      status            = excluded.status,
      nonce_or_sequence = excluded.nonce_or_sequence,
      raw_ref           = excluded.raw_ref,
      updated_at        = now()
  `
}

export async function upsertLog(exec: Exec, scope: ChainScope, input: LogInput): Promise<void> {
  await exec`
    insert into logs (
      chain, network, tx_hash, log_index, block_hash, block_height, address, topics, data, status
    ) values (
      ${scope.chain}, ${scope.network}, ${input.txHash}, ${input.logIndex}, ${input.blockHash},
      ${input.blockHeight}, ${input.address}, ${[...input.topics]}, ${input.data}, 'included'
    )
    on conflict (chain, network, tx_hash, log_index) do update set
      block_hash   = excluded.block_hash,
      block_height = excluded.block_height,
      address      = excluded.address,
      topics       = excluded.topics,
      data         = excluded.data,
      status       = 'included'
  `
}

/**
 * Record one address movement.
 *
 * `inserted` distinguishes the first sighting from a re-index. It is what stops a re-run of the
 * same height producing a second `indexer.deposit.observed`, and it is read from `xmax = 0`, which
 * Postgres leaves at zero only on the insert path of an upsert.
 *
 * A movement that had been orphaned and is now back on the canonical chain updates rather than
 * inserts, so it does not re-announce itself as observed — the consumer deduped that event on
 * `(topic, event_id)` long ago. What it does regain is a null `confirmed_at`, cleared when it was
 * orphaned, so `indexer.deposit.confirmed` fires again once it re-reaches its depth. Retracting
 * the confirmation and re-issuing it is the honest report; leaving a confirmation standing for a
 * transaction that briefly left the chain is not.
 */
export async function upsertActivity(
  exec: Exec,
  scope: ChainScope,
  input: ActivityInput,
): Promise<{ id: string; inserted: boolean }> {
  const rows = await exec<{ id: string; inserted: boolean }[]>`
    insert into address_activity (
      chain, network, address, direction, asset_code, asset_kind, token_address, amount,
      tx_hash, entry_key, log_index, block_height, block_hash, status
    ) values (
      ${scope.chain}, ${scope.network}, ${input.address}, ${input.direction}, ${input.assetCode},
      ${input.assetKind}, ${input.tokenAddress}, ${input.amount.toString()}, ${input.txHash},
      ${input.entryKey}, ${input.logIndex}, ${input.blockHeight}, ${input.blockHash}, 'included'
    )
    on conflict (chain, network, tx_hash, entry_key) do update set
      address       = excluded.address,
      direction     = excluded.direction,
      asset_code    = excluded.asset_code,
      asset_kind    = excluded.asset_kind,
      token_address = excluded.token_address,
      amount        = excluded.amount,
      log_index     = excluded.log_index,
      block_height  = excluded.block_height,
      block_hash    = excluded.block_hash,
      status        = 'included',
      reorged_at    = null,
      updated_at    = now()
    returning id, (xmax = 0) as inserted
  `
  const row = rows[0]
  if (!row) throw new Error('address_activity upsert returned no row')
  return { id: row.id, inserted: row.inserted }
}

/* ------------------------------------------------------------------ spent outpoints (UTXO) */

/**
 * One outpoint consumed by one transaction.
 *
 * Written only by the Bitcoin worker. An account-model family has no outpoints and writes none,
 * which is why this lives beside the shared tables rather than inside them: the one schema across
 * five families (migration 4's first invariant) is about not splitting `transactions` per family,
 * not about pretending a UTXO chain has no facts of its own.
 */
export interface SpendInput {
  readonly txid: string
  readonly vout: number
  readonly spendingTxHash: string
  readonly blockHeight: number
  readonly blockHash: string
}

/**
 * Record what a transaction spent.
 *
 * `on conflict do update` on the full primary key makes re-indexing a block idempotent. What it
 * does NOT swallow is a *different* transaction spending an outpoint that an included transaction
 * already spent: that violates `spent_outpoints_canonical_uniq` and raises 23505, which is the
 * database refusing to hold two canonical spends of one coin. See migration 5's header for why
 * that belongs here rather than in a worker.
 */
export async function recordSpends(
  exec: Exec,
  scope: ChainScope,
  spends: readonly SpendInput[],
): Promise<void> {
  for (const spend of spends) {
    await exec`
      insert into spent_outpoints (
        chain, network, txid, vout, spending_tx_hash, block_height, block_hash, status
      ) values (
        ${scope.chain}, ${scope.network}, ${spend.txid}, ${spend.vout},
        ${spend.spendingTxHash}, ${spend.blockHeight}, ${spend.blockHash}, 'included'
      )
      on conflict (chain, network, spending_tx_hash, txid, vout) do update set
        block_height = excluded.block_height,
        block_hash   = excluded.block_hash,
        status       = 'included'
    `
  }
}

/**
 * Mark, permanently, every retracted movement whose coins somebody else has now spent.
 *
 * This is the state an account chain does not have. After a Bitcoin reorg the worker re-indexes
 * the winning chain; some transactions that left come back with the same txid and some do not,
 * and the difference is not visible from the transaction itself — it is visible from whether the
 * outpoints it spent are now spent by a *different* canonical transaction. Where they are, the
 * orphaned transaction is dead rather than merely absent: no future block can contain it, because
 * its inputs no longer exist to be spent.
 *
 * Two words rather than one, and both are already in the schema's vocabulary. The transaction
 * becomes `dropped` (migration 4 already allows it) and its movements become `conflicted`
 * (migration 5 widens the check for it). `orphaned` is deliberately not reused: a consumer that
 * cannot tell "gone for now" from "gone for good" will wait for a confirmation that cannot come,
 * and waiting forever on a deposit is the failure this distinction exists to prevent.
 *
 * Returns the number of transactions killed, so the caller can report it and a test can assert it.
 */
export async function markConflictedSpends(
  exec: Exec,
  scope: ChainScope,
): Promise<{ transactions: number; activity: number }> {
  const killed = await exec<{ hash: string }[]>`
    update transactions t set status = 'dropped', updated_at = now()
     where t.chain = ${scope.chain} and t.network = ${scope.network}
       and t.status = 'orphaned'
       and exists (
         select 1
           from spent_outpoints mine
           join spent_outpoints theirs
             on theirs.chain = mine.chain and theirs.network = mine.network
            and theirs.txid = mine.txid and theirs.vout = mine.vout
            and theirs.spending_tx_hash <> mine.spending_tx_hash
            and theirs.status = 'included'
          where mine.chain = t.chain and mine.network = t.network
            and mine.spending_tx_hash = t.hash
       )
    returning t.hash
  `
  if (killed.length === 0) return { transactions: 0, activity: 0 }

  const hashes = killed.map((k) => k.hash)
  const activity = await exec<{ id: string }[]>`
    update address_activity
       set status = 'conflicted', updated_at = now()
     where chain = ${scope.chain} and network = ${scope.network}
       and tx_hash = any(${hashes}::text[])
       and status = 'orphaned'
    returning id
  `
  return { transactions: killed.length, activity: activity.length }
}

/* ------------------------------------------------------------------ reorg */

export interface OrphanCounts {
  readonly blockHashes: readonly string[]
  readonly transactions: number
  readonly logs: number
  readonly activity: number
}

/**
 * Retract everything above the common ancestor.
 *
 * Four statements rather than one cascade, because the rows are *retracted*, not deleted: a
 * transaction that was on the chain and then was not is a fact an operator will want to see, and
 * `on delete cascade` would erase the evidence of the incident along with its effects.
 *
 * `confirmed_at` is cleared. A confirmation is a statement about depth on the canonical chain, and
 * the canonical chain no longer contains this movement.
 */
export async function orphanAbove(
  exec: Exec,
  scope: ChainScope,
  ancestorHeight: number,
  depth: number,
): Promise<OrphanCounts> {
  const blocks = await exec<{ hash: string }[]>`
    update blocks set status = 'orphaned', reorg_depth = ${depth}, updated_at = now()
     where chain = ${scope.chain} and network = ${scope.network}
       and height > ${ancestorHeight} and status <> 'orphaned'
    returning hash
  `
  const transactions = await exec<{ hash: string }[]>`
    update transactions set status = 'orphaned', updated_at = now()
     where chain = ${scope.chain} and network = ${scope.network}
       and block_height > ${ancestorHeight} and status <> 'orphaned'
    returning hash
  `
  const logs = await exec<{ tx_hash: string }[]>`
    update logs set status = 'orphaned'
     where chain = ${scope.chain} and network = ${scope.network}
       and block_height > ${ancestorHeight} and status <> 'orphaned'
    returning tx_hash
  `
  const activity = await exec<{ id: string }[]>`
    update address_activity
       set status = 'orphaned', reorged_at = now(), confirmed_at = null, updated_at = now()
     where chain = ${scope.chain} and network = ${scope.network}
       and block_height > ${ancestorHeight} and status = 'included'
    returning id
  `
  // Releasing the outpoints is what makes the replacement chain indexable at all. The winning
  // chain's transactions spend the same coins; if the losing chain's spends stayed `included`,
  // `spent_outpoints_canonical_uniq` would reject every one of them at 23505. Retracting them in
  // the SAME transaction as the blocks is therefore not tidiness, it is the reason the reorg can
  // commit — and it is also what leaves the losing spends on the record for `markConflictedSpends`
  // to compare against once the winner is indexed.
  await exec`
    update spent_outpoints set status = 'orphaned'
     where chain = ${scope.chain} and network = ${scope.network}
       and block_height > ${ancestorHeight} and status <> 'orphaned'
  `
  return {
    blockHashes: blocks.map((b) => b.hash),
    transactions: transactions.length,
    logs: logs.length,
    activity: activity.length,
  }
}

export interface ReorgInput {
  readonly commonAncestorHeight: number
  readonly commonAncestorHash: string
  readonly previousTipHeight: number
  readonly previousTipHash: string
  readonly depth: number
  readonly alarming: boolean
  readonly counts: OrphanCounts
}

export async function insertReorg(
  exec: Exec,
  scope: ChainScope,
  input: ReorgInput,
): Promise<string> {
  const rows = await exec<{ id: string }[]>`
    insert into reorgs (
      chain, network, common_ancestor_height, common_ancestor_hash, previous_tip_height,
      previous_tip_hash, depth, alarming, orphaned_blocks, orphaned_transactions,
      orphaned_activity, orphaned_block_hashes
    ) values (
      ${scope.chain}, ${scope.network}, ${input.commonAncestorHeight}, ${input.commonAncestorHash},
      ${input.previousTipHeight}, ${input.previousTipHash}, ${input.depth}, ${input.alarming},
      ${input.counts.blockHashes.length}, ${input.counts.transactions}, ${input.counts.activity},
      ${[...input.counts.blockHashes]}
    )
    returning id
  `
  const row = rows[0]
  if (!row) throw new Error('reorg insert returned no row')
  return row.id
}

export interface ReorgRecord {
  readonly id: string
  readonly detectedAt: Date
  readonly commonAncestorHeight: number
  readonly depth: number
  readonly alarming: boolean
  readonly orphanedBlocks: number
  readonly orphanedTransactions: number
  readonly orphanedActivity: number
}

export async function recentReorgs(
  exec: Exec,
  scope: ChainScope,
  limit: number,
): Promise<ReorgRecord[]> {
  const rows = await exec<
    {
      id: string
      detected_at: Date
      common_ancestor_height: string
      depth: number
      alarming: boolean
      orphaned_blocks: number
      orphaned_transactions: number
      orphaned_activity: number
    }[]
  >`
    select id, detected_at, common_ancestor_height, depth, alarming,
           orphaned_blocks, orphaned_transactions, orphaned_activity
      from reorgs
     where chain = ${scope.chain} and network = ${scope.network}
     order by detected_at desc
     limit ${limit}
  `
  return rows.map((r) => ({
    id: r.id,
    detectedAt: r.detected_at,
    commonAncestorHeight: Number(r.common_ancestor_height),
    depth: r.depth,
    alarming: r.alarming,
    orphanedBlocks: r.orphaned_blocks,
    orphanedTransactions: r.orphaned_transactions,
    orphanedActivity: r.orphaned_activity,
  }))
}

/* ------------------------------------------------------------------ checkpoints */

/** The follower's stream. One per (chain, network); the chain's halt flag lives on this row. */
export const TIP_STREAM = 'tip'

export function backfillStream(from: number, to: number): string {
  return `backfill:${from}-${to}`
}

export interface Checkpoint {
  readonly stream: string
  /** Null means nothing has been indexed on this stream yet. */
  readonly height: number | null
  readonly blockHash: string | null
  readonly rangeFrom: number | null
  readonly rangeTo: number | null
  readonly tipHeight: number | null
  readonly tipSeenAt: Date | null
  readonly halted: boolean
  readonly haltReason: string | null
  readonly updatedAt: Date
}

interface CheckpointRow {
  readonly stream: string
  readonly height: string | null
  readonly block_hash: string | null
  readonly range_from: string | null
  readonly range_to: string | null
  readonly tip_height: string | null
  readonly tip_seen_at: Date | null
  readonly halted: boolean
  readonly halt_reason: string | null
  readonly updated_at: Date
}

const toCheckpoint = (row: CheckpointRow): Checkpoint => ({
  stream: row.stream,
  height: row.height === null ? null : Number(row.height),
  blockHash: row.block_hash,
  rangeFrom: row.range_from === null ? null : Number(row.range_from),
  rangeTo: row.range_to === null ? null : Number(row.range_to),
  tipHeight: row.tip_height === null ? null : Number(row.tip_height),
  tipSeenAt: row.tip_seen_at,
  halted: row.halted,
  haltReason: row.halt_reason,
  updatedAt: row.updated_at,
})

export async function getCheckpoint(
  exec: Exec,
  scope: ChainScope,
  stream: string,
): Promise<Checkpoint | null> {
  const rows = await exec<CheckpointRow[]>`
    select stream, height, block_hash, range_from, range_to, tip_height, tip_seen_at,
           halted, halt_reason, updated_at
      from checkpoints
     where chain = ${scope.chain} and network = ${scope.network} and stream = ${stream}
  `
  const row = rows[0]
  return row ? toCheckpoint(row) : null
}

/**
 * Advance a stream.
 *
 * Called inside the same transaction as the block it names. That is the whole of "a restart
 * resumes rather than rescans, with no gap and no duplicate": there is no instant at which the
 * checkpoint has moved past a block whose rows are not committed, and no instant at which the
 * rows are committed but the checkpoint is behind.
 */
export async function setCheckpoint(
  exec: Exec,
  scope: ChainScope,
  stream: string,
  height: number,
  blockHash: string | null,
): Promise<void> {
  await exec`
    insert into checkpoints (chain, network, stream, height, block_hash)
    values (${scope.chain}, ${scope.network}, ${stream}, ${height}, ${blockHash})
    on conflict (chain, network, stream) do update set
      height = excluded.height, block_hash = excluded.block_hash, updated_at = now()
  `
}

/** Record the tip as last observed. Separate from progress, because the lag is their difference. */
export async function recordTip(
  exec: Exec,
  scope: ChainScope,
  tipHeight: number,
): Promise<void> {
  await exec`
    insert into checkpoints (chain, network, stream, height, tip_height, tip_seen_at)
    values (${scope.chain}, ${scope.network}, ${TIP_STREAM}, null, ${tipHeight}, now())
    on conflict (chain, network, stream) do update set
      tip_height = excluded.tip_height, tip_seen_at = now(), updated_at = now()
  `
}

export async function ensureBackfill(
  exec: Exec,
  scope: ChainScope,
  from: number,
  to: number,
): Promise<string> {
  const stream = backfillStream(from, to)
  await exec`
    insert into checkpoints (chain, network, stream, height, range_from, range_to)
    values (${scope.chain}, ${scope.network}, ${stream}, null, ${from}, ${to})
    on conflict (chain, network, stream) do nothing
  `
  return stream
}

/**
 * The oldest backfill range that has not reached its end.
 *
 * Ordered by `range_from` so ranges are completed in chain order, which is the order in which a
 * consumer replaying address activity would want them.
 */
export async function nextUnfinishedBackfill(
  exec: Exec,
  scope: ChainScope,
): Promise<Checkpoint | null> {
  const rows = await exec<CheckpointRow[]>`
    select stream, height, block_hash, range_from, range_to, tip_height, tip_seen_at,
           halted, halt_reason, updated_at
      from checkpoints
     where chain = ${scope.chain} and network = ${scope.network}
       and range_to is not null
       and (height is null or height < range_to)
     order by range_from
     limit 1
  `
  const row = rows[0]
  return row ? toCheckpoint(row) : null
}

/**
 * Stop the chain.
 *
 * Only a reorg at or past `reorgAlarmDepth` reaches here. Clearing it is deliberately not
 * automatic and not exposed: the depth encodes an assumption about how far the chain can reorganise,
 * and a reorg that reaches it means the assumption failed. A machine deciding the assumption has
 * come back is the machine deciding it is safe to credit money again.
 */
export async function haltChain(
  exec: Exec,
  scope: ChainScope,
  reason: string,
): Promise<void> {
  await exec`
    insert into checkpoints (chain, network, stream, height, halted, halt_reason)
    values (${scope.chain}, ${scope.network}, ${TIP_STREAM}, null, true, ${reason})
    on conflict (chain, network, stream) do update set
      halted = true, halt_reason = excluded.halt_reason, updated_at = now()
  `
}

export async function isHalted(exec: Exec, scope: ChainScope): Promise<boolean> {
  const rows = await exec<{ halted: boolean }[]>`
    select halted from checkpoints
     where chain = ${scope.chain} and network = ${scope.network} and stream = ${TIP_STREAM}
  `
  return rows[0]?.halted ?? false
}

/* ------------------------------------------------------------------ provider health */

export interface ProviderHealthInput {
  readonly provider: string
  readonly urlHost: string
  readonly state: 'healthy' | 'degraded' | 'down'
  readonly consecutiveFailures: number
  readonly totalRequests: number
  readonly totalFailures: number
  readonly latencyMs: number | null
  readonly lastOkAt: Date | null
  readonly lastFailureAt: Date | null
  readonly lastError: string | null
  readonly rateLimitedUntil: Date | null
}

export async function upsertProviderHealth(
  exec: Exec,
  scope: ChainScope,
  input: ProviderHealthInput,
): Promise<void> {
  await exec`
    insert into provider_health (
      chain, network, provider, url_host, state, consecutive_failures, total_requests,
      total_failures, latency_ms, last_ok_at, last_failure_at, last_error, rate_limited_until
    ) values (
      ${scope.chain}, ${scope.network}, ${input.provider}, ${input.urlHost}, ${input.state},
      ${input.consecutiveFailures}, ${input.totalRequests}, ${input.totalFailures},
      ${input.latencyMs}, ${input.lastOkAt}, ${input.lastFailureAt},
      ${input.lastError === null ? null : input.lastError.slice(0, 500)},
      ${input.rateLimitedUntil}
    )
    on conflict (chain, network, provider) do update set
      url_host             = excluded.url_host,
      state                = excluded.state,
      consecutive_failures = excluded.consecutive_failures,
      total_requests       = excluded.total_requests,
      total_failures       = excluded.total_failures,
      latency_ms           = excluded.latency_ms,
      last_ok_at           = excluded.last_ok_at,
      last_failure_at      = excluded.last_failure_at,
      last_error           = excluded.last_error,
      rate_limited_until   = excluded.rate_limited_until,
      updated_at           = now()
  `
}

export interface ProviderHealthRecord extends ProviderHealthInput {
  readonly updatedAt: Date
}

export async function listProviderHealth(
  exec: Exec,
  scope: ChainScope,
): Promise<ProviderHealthRecord[]> {
  const rows = await exec<
    {
      provider: string
      url_host: string
      state: 'healthy' | 'degraded' | 'down'
      consecutive_failures: number
      total_requests: string
      total_failures: string
      latency_ms: number | null
      last_ok_at: Date | null
      last_failure_at: Date | null
      last_error: string | null
      rate_limited_until: Date | null
      updated_at: Date
    }[]
  >`
    select provider, url_host, state, consecutive_failures, total_requests, total_failures,
           latency_ms, last_ok_at, last_failure_at, last_error, rate_limited_until, updated_at
      from provider_health
     where chain = ${scope.chain} and network = ${scope.network}
     order by provider
  `
  return rows.map((r) => ({
    provider: r.provider,
    urlHost: r.url_host,
    state: r.state,
    consecutiveFailures: r.consecutive_failures,
    totalRequests: Number(r.total_requests),
    totalFailures: Number(r.total_failures),
    latencyMs: r.latency_ms,
    lastOkAt: r.last_ok_at,
    lastFailureAt: r.last_failure_at,
    lastError: r.last_error,
    rateLimitedUntil: r.rate_limited_until,
    updatedAt: r.updated_at,
  }))
}

/* ------------------------------------------------------------------ watched addresses */

/**
 * What a registrar is claiming about an address's history, if anything.
 *
 * `'head'` is the claim a service that has JUST DERIVED THE KEY is entitled to make and the one it
 * can make without knowing anything about the chain: "nothing can have paid this address before
 * now". It is resolved here, against this service's own canonical head, rather than by the caller —
 * a caller-supplied height would be a height this service might not have walked, and the whole
 * purpose of the column is to be comparable with what it walked.
 *
 * A number is an operator stating a fact deliberately about an address whose funding history they
 * know. Null is silence, and silence is refused rather than assumed downstream.
 */
export type HistoryClaim = number | 'head' | null

export async function watchAddress(
  exec: Exec,
  scope: ChainScope,
  address: string,
  label: string | null,
  history: HistoryClaim = null,
): Promise<void> {
  // Read outside the insert, and a stale head is safe in the only direction that matters: it is a
  // LOWER claim than the truth, and a lower claim can only make a later observation refuse.
  const historyFromHeight = history === 'head' ? ((await headBlock(exec, scope))?.height ?? 0) : history
  await exec`
    insert into watched_addresses (chain, network, address, label, history_from_height)
    values (${scope.chain}, ${scope.network}, ${address}, ${label}, ${historyFromHeight})
    on conflict (chain, network, address) do update
      set label = excluded.label,
          -- LEAST, and it ignores nulls in postgres, so this keeps the LOWEST claim either
          -- registration made and never loses one to a re-registration that made none. The
          -- direction matters: the column says "no activity below this height", so a lower number
          -- is a STRONGER statement and a higher one would quietly narrow what the derivation is
          -- allowed to see. A re-watch is routine — micro-wallet re-registers on a retry job —
          -- and routine must not be able to weaken a solvency input.
          history_from_height = least(
            watched_addresses.history_from_height,
            excluded.history_from_height
          )
  `
}

/**
 * An address and whatever claim its registrar made about its history — whether or not it is
 * custody's.
 *
 * Separate from `CustodyAddress` below because the single-address read is entitled to ask about an
 * address nobody has labelled, and a type demanding a bucket for it would have to be answered with
 * an invented one.
 */
export interface AddressHistory {
  readonly address: string
  /**
   * The height below which the registrar asserts this address had no chain activity, or null for
   * "nobody said". Null is the reason a UTXO observation is refused rather than the reason it is
   * approximated — see `custody.ts`, `history_unknown`.
   */
  readonly historyFromHeight: number | null
}

/** One member of the custody set: an address history, plus the bucket its label put it in. */
export interface CustodyAddress extends AddressHistory {
  /**
   * Which configured prefix this address's label matched — the FIRST one in the configured order,
   * so an address labelled with two of them lands in exactly one bucket and always the same one.
   *
   * It is the bucket the aggregate is broken down by, and it is carried per address rather than
   * re-derived from the label at the point of summing so that the grouping and the membership test
   * are the same decision, made once. An address that reaches this type matched something — the
   * query returns nothing else — so this is never null.
   */
  readonly labelPrefix: string
}

/**
 * Σ unspent output value over `addresses` as of `height`, from this service's own walked record.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **Outputs minus spent outpoints, and NOT `in` minus `out`.** The two look interchangeable and
 * are not, because of one line in `bitcoin.ts`: the spend record is pushed from the txin outpoint
 * unconditionally, while the outbound MOVEMENT is only written when the prevout resolves to a value
 * and an address. An input whose prevout could not be fetched increments `unresolvedInputs` and
 * leaves no `out` row behind — so a balance summed as `in − out` is over-stated by every such
 * spend. Over-stated reads at the ledger as NEGATIVE drift, which freezes the asset while the
 * platform is entirely solvent. That is the 2026-08-05 shape, and it would arrive here as a data
 * artefact rather than as a bookkeeping mistake, which is far harder to recognise.
 *
 * This formulation cannot express that error. It asks two questions of the record — was this output
 * paid to us, and has it since been spent — and both are answered by rows that exist whether or not
 * any prevout ever resolved.
 *
 * `status = 'included'` on both sides. An orphaned or conflicted credit is not money, and an
 * orphaned or conflicted spend did not happen; taking either at face value would move the total in
 * the direction of whichever reorg is currently unrepaired.
 *
 * The caller is responsible for the two facts this query cannot establish: that the record is
 * contiguous down to a height below any activity these addresses have ever had, and that `height`
 * is at the chain's confirmation depth. Without those it returns a number that is arithmetically
 * correct about an incomplete record, which is the most dangerous kind of correct.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function unspentOutputTotal(
  exec: Exec,
  scope: ChainScope,
  addresses: readonly string[],
  height: number,
): Promise<bigint> {
  let total = 0n
  for (const amount of (await unspentOutputTotals(exec, scope, addresses, height)).values()) {
    total += amount
  }
  return total
}

/**
 * The same sum, kept per address, so the aggregate can be broken down without being measured twice.
 *
 * A freeze reason that prints one observed number tells an operator that the estate and the chain
 * disagree; it does not tell them WHERE. Grouping this map by each address's label prefix does, and
 * the grouping is only trustworthy if it is the same arithmetic as the total. So the total is the
 * sum of this map rather than its own query: there is no second SELECT that could drift from the
 * first, and no ordering in which the parts fail to add up to the whole.
 *
 * **An address absent from the result holds nothing**, and that is a fact about the record rather
 * than a default: the query returns a row per address that has an unspent credit at or below
 * `height`, so an address missing from it has no such credit. The caller supplies the zero, which is
 * why this returns a map keyed by address rather than an array the caller must align by index.
 */
export async function unspentOutputTotals(
  exec: Exec,
  scope: ChainScope,
  addresses: readonly string[],
  height: number,
): Promise<Map<string, bigint>> {
  if (addresses.length === 0) return new Map()
  const rows = await exec<{ address: string; total: string | null }[]>`
    select credit.address as address, coalesce(sum(credit.amount), 0)::text as total
      from address_activity credit
     where credit.chain = ${scope.chain}
       and credit.network = ${scope.network}
       and credit.direction = 'in'
       and credit.status = 'included'
       and credit.asset_kind = 'native'
       and credit.block_height <= ${height}
       and credit.address = any(${[...addresses]}::text[])
       and not exists (
         select 1
           from spent_outpoints spend
          where spend.chain = credit.chain
            and spend.network = credit.network
            and spend.txid = credit.tx_hash
            and spend.vout = credit.log_index
            and spend.status = 'included'
            and spend.block_height <= ${height}
       )
     group by credit.address
  `
  return new Map(rows.map((row) => [row.address, BigInt(row.total ?? '0')]))
}

/**
 * Which of these addresses is worth a deposit event.
 *
 * Asked per block with the addresses that block actually touched, rather than loading the whole
 * watch list. That is not an optimisation, it is the defect being replaced: forge-pay's watcher
 * loads *every* address row with no pagination on a thirty-second timer (00-current-state §3.4),
 * so its cost grows with the number of users rather than with the amount of chain activity.
 */
export async function filterWatched(
  exec: Exec,
  scope: ChainScope,
  addresses: readonly string[],
): Promise<Set<string>> {
  if (addresses.length === 0) return new Set()
  const rows = await exec<{ address: string }[]>`
    select address from watched_addresses
     where chain = ${scope.chain} and network = ${scope.network}
       and address = any(${[...addresses]}::text[])
  `
  return new Set(rows.map((r) => r.address))
}

/**
 * Every watched address whose label marks it as holding platform money.
 *
 * This is the **custody set**, and it is the input to the aggregate `micro-ledger` reconciles
 * against. It exists as a whole-list read — the one thing `filterWatched` above deliberately is
 * not — because the question is a sum over the set rather than a membership test for a block. The
 * cost is bounded by the caller (`custody.ts` refuses a set above a configured size) rather than
 * by pagination, because a page of a custody set is a partial sum and a partial sum is the exact
 * lie this whole path exists to refuse.
 *
 * `starts_with` rather than `like`, so a prefix containing `%` or `_` matches literally instead of
 * silently becoming a wildcard that pulls in every watched address on the chain.
 *
 * Ordered by address so two runs a moment apart sum the same rows in the same order, which is what
 * makes a difference between them a fact about the chain rather than about the planner.
 */
export async function custodyAddresses(
  exec: Exec,
  scope: ChainScope,
  labelPrefixes: readonly string[],
  limit: number,
): Promise<readonly CustodyAddress[]> {
  if (labelPrefixes.length === 0) return []
  const rows = await exec<{ address: string; label: string; history_from_height: string | null }[]>`
    select address, label, history_from_height from watched_addresses
     where chain = ${scope.chain} and network = ${scope.network}
       and label is not null
       and exists (
         select 1 from unnest(${[...labelPrefixes]}::text[]) as prefix
          where starts_with(watched_addresses.label, prefix)
       )
     order by address
     limit ${limit}
  `
  return rows.flatMap((r) => {
    // The same `starts_with` the WHERE clause applied, re-applied here to learn WHICH prefix
    // matched. `find` rather than `filter` is the tie-break: configured order decides, so a label
    // matching two prefixes is counted once, under the earlier one, and the breakdown always sums
    // to the total.
    const labelPrefix = labelPrefixes.find((prefix) => r.label.startsWith(prefix))
    // Unreachable — the query returned this row because some prefix matched. Dropped rather than
    // defaulted, because a row assigned to a bucket it does not belong to would make the breakdown
    // disagree with the total it is meant to explain, and a silently wrong explanation of a freeze
    // is worse than a missing one. If it ever fires, the address is also absent from `addresses`
    // and the count no longer matches the set, which is visible.
    if (labelPrefix === undefined) return []
    return [
      {
        address: r.address,
        // `bigint` columns arrive as strings from this driver. `Number(null)` is 0 and 0 is a
        // meaningful height, so the null is carried through as null rather than coerced — the
        // difference between "no activity below genesis" and "nobody said" is the difference
        // between an observation and a refusal.
        historyFromHeight: r.history_from_height === null ? null : Number(r.history_from_height),
        labelPrefix,
      },
    ]
  })
}

/**
 * The history claims carried by named addresses, whether or not they are custody's.
 *
 * `custodyAddresses` answers "who is in the set"; this answers "what has been claimed about these
 * specific ones", which is what the single-address balance read needs. An address that is not
 * watched at all is simply absent from the result — not an error here, because the caller is
 * entitled to ask about an address it is about to register, and the absence of a claim is a fact
 * the caller must weigh rather than a failure of this query.
 */
export async function custodyAddressHistory(
  exec: Exec,
  scope: ChainScope,
  addresses: readonly string[],
): Promise<readonly AddressHistory[]> {
  if (addresses.length === 0) return []
  const rows = await exec<{ address: string; history_from_height: string | null }[]>`
    select address, history_from_height from watched_addresses
     where chain = ${scope.chain} and network = ${scope.network}
       and address = any(${[...addresses]}::text[])
  `
  return rows.map((r) => ({
    address: r.address,
    historyFromHeight: r.history_from_height === null ? null : Number(r.history_from_height),
  }))
}

/* ------------------------------------------------------------------ confirmation sweep */

export interface PendingActivity {
  readonly id: string
  readonly address: string
  readonly direction: Direction
  readonly assetCode: string
  readonly assetKind: AssetKind
  readonly tokenAddress: string | null
  readonly amount: bigint
  readonly txHash: string
  readonly logIndex: number | null
  readonly blockHeight: number
  readonly blockHash: string
  readonly firstSeenAt: Date
}

/**
 * Inbound movements on watched addresses at or below `maxBlockHeight` that have not been reported
 * confirmed.
 *
 * The caller computes `maxBlockHeight` from the tip and the asset's depth, so the depth policy is
 * applied in exactly one place — `chains.confirmationsAt` plus `contracts-chain.isConfirmed` — and
 * never re-derived in SQL, where it could not be unit tested and would silently disagree with the
 * three other services that read the same package.
 */
export async function pendingConfirmations(
  exec: Exec,
  scope: ChainScope,
  maxBlockHeight: number,
  limit: number,
): Promise<PendingActivity[]> {
  const rows = await exec<
    {
      id: string
      address: string
      direction: Direction
      asset_code: string
      asset_kind: AssetKind
      token_address: string | null
      amount: string
      tx_hash: string
      log_index: number | null
      block_height: string
      block_hash: string
      first_seen_at: Date
    }[]
  >`
    select a.id, a.address, a.direction, a.asset_code, a.asset_kind, a.token_address, a.amount,
           a.tx_hash, a.log_index, a.block_height, a.block_hash, a.first_seen_at
      from address_activity a
      join watched_addresses w
        on w.chain = a.chain and w.network = a.network and w.address = a.address
     where a.chain = ${scope.chain} and a.network = ${scope.network}
       and a.direction = 'in' and a.status = 'included' and a.confirmed_at is null
       and a.block_height <= ${maxBlockHeight}
     order by a.block_height
     limit ${limit}
  `
  return rows.map(toPendingActivity)
}

function toPendingActivity(r: {
  id: string
  address: string
  direction: Direction
  asset_code: string
  asset_kind: AssetKind
  token_address: string | null
  amount: string
  tx_hash: string
  log_index: number | null
  block_height: string
  block_hash: string
  first_seen_at: Date
}): PendingActivity {
  return {
    id: r.id,
    address: r.address,
    direction: r.direction,
    assetCode: r.asset_code,
    assetKind: r.asset_kind,
    tokenAddress: r.token_address,
    amount: BigInt(r.amount),
    txHash: r.tx_hash,
    logIndex: r.log_index,
    blockHeight: Number(r.block_height),
    blockHash: r.block_hash,
    firstSeenAt: r.first_seen_at,
  }
}

export async function markConfirmed(
  exec: Exec,
  scope: ChainScope,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return
  await exec`
    update address_activity set confirmed_at = now(), updated_at = now()
     where chain = ${scope.chain} and network = ${scope.network}
       and id = any(${[...ids]}::uuid[])
       and confirmed_at is null
  `
}

/* ------------------------------------------------------------------ read API */

export interface ActivityRecord {
  readonly id: string
  readonly address: string
  readonly direction: Direction
  readonly assetCode: string
  readonly assetKind: AssetKind
  readonly tokenAddress: string | null
  readonly amount: bigint
  readonly txHash: string
  readonly logIndex: number | null
  readonly blockHeight: number
  readonly blockHash: string
  readonly status: RowStatus
  readonly firstSeenAt: Date
  readonly confirmedAt: Date | null
  readonly reorgedAt: Date | null
}

export interface ActivityPage {
  readonly items: readonly ActivityRecord[]
  /** `<blockHeight>:<id>`, or null at the end of the list. Keyset, never an offset. */
  readonly nextCursor: string | null
}

/**
 * One address's activity, newest first, keyset-paginated.
 *
 * Keyset rather than offset because an indexer's tables grow at the head: with `offset`, a page
 * boundary shifts every time a block lands and a caller walking pages sees rows twice or not at
 * all. The cursor is `(block_height, id)`, which is exactly the index this table carries.
 */
export async function activityForAddress(
  exec: Exec,
  scope: ChainScope,
  address: string,
  limit: number,
  cursor: string | null,
): Promise<ActivityPage> {
  const parsed = cursor === null ? null : parseCursor(cursor)
  const rows = await exec<
    {
      id: string
      address: string
      direction: Direction
      asset_code: string
      asset_kind: AssetKind
      token_address: string | null
      amount: string
      tx_hash: string
      log_index: number | null
      block_height: string
      block_hash: string
      status: RowStatus
      first_seen_at: Date
      confirmed_at: Date | null
      reorged_at: Date | null
    }[]
  >`
    select id, address, direction, asset_code, asset_kind, token_address, amount, tx_hash,
           log_index, block_height, block_hash, status, first_seen_at, confirmed_at, reorged_at
      from address_activity
     where chain = ${scope.chain} and network = ${scope.network} and address = ${address}
       and (
         ${parsed === null}
         or (block_height, id) < (${parsed?.height ?? 0}, ${parsed?.id ?? '00000000-0000-4000-8000-000000000000'}::uuid)
       )
     order by block_height desc, id desc
     limit ${limit + 1}
  `
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    address: r.address,
    direction: r.direction,
    assetCode: r.asset_code,
    assetKind: r.asset_kind,
    tokenAddress: r.token_address,
    amount: BigInt(r.amount),
    txHash: r.tx_hash,
    logIndex: r.log_index,
    blockHeight: Number(r.block_height),
    blockHash: r.block_hash,
    status: r.status,
    firstSeenAt: r.first_seen_at,
    confirmedAt: r.confirmed_at,
    reorgedAt: r.reorged_at,
  }))
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: rows.length > limit && last ? `${last.blockHeight}:${last.id}` : null,
  }
}

const CURSOR = /^(\d{1,19}):([0-9a-f-]{36})$/i

export function parseCursor(cursor: string): { height: number; id: string } | null {
  const match = CURSOR.exec(cursor)
  if (!match) return null
  const height = Number(match[1])
  const id = match[2]
  if (!Number.isSafeInteger(height) || id === undefined) return null
  return { height, id }
}

export interface TransactionRecord {
  readonly hash: string
  readonly blockHash: string | null
  readonly blockHeight: number | null
  readonly txIndex: number | null
  readonly from: string | null
  readonly to: string | null
  readonly value: bigint
  readonly fee: bigint | null
  readonly status: TransactionStatus
  readonly nonceOrSequence: number | null
  readonly rawRef: Record<string, unknown>
  readonly firstSeenAt: Date
  readonly logs: readonly LogRecord[]
}

export interface LogRecord {
  readonly logIndex: number
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
  readonly status: RowStatus
}

export async function transactionByHash(
  exec: Exec,
  scope: ChainScope,
  hash: string,
): Promise<TransactionRecord | null> {
  const rows = await exec<
    {
      hash: string
      block_hash: string | null
      block_height: string | null
      tx_index: number | null
      from_address: string | null
      to_address: string | null
      value: string
      fee: string | null
      status: TransactionStatus
      nonce_or_sequence: string | null
      raw_ref: Record<string, unknown>
      first_seen_at: Date
    }[]
  >`
    select hash, block_hash, block_height, tx_index, from_address, to_address, value, fee,
           status, nonce_or_sequence, raw_ref, first_seen_at
      from transactions
     where chain = ${scope.chain} and network = ${scope.network} and hash = ${hash}
  `
  const row = rows[0]
  if (!row) return null

  const logRows = await exec<
    { log_index: number; address: string; topics: string[]; data: string; status: RowStatus }[]
  >`
    select log_index, address, topics, data, status
      from logs
     where chain = ${scope.chain} and network = ${scope.network} and tx_hash = ${hash}
     order by log_index
  `

  return {
    hash: row.hash,
    blockHash: row.block_hash,
    blockHeight: row.block_height === null ? null : Number(row.block_height),
    txIndex: row.tx_index,
    from: row.from_address,
    to: row.to_address,
    value: BigInt(row.value),
    fee: row.fee === null ? null : BigInt(row.fee),
    status: row.status,
    nonceOrSequence: row.nonce_or_sequence === null ? null : Number(row.nonce_or_sequence),
    rawRef: row.raw_ref,
    firstSeenAt: row.first_seen_at,
    logs: logRows.map((l) => ({
      logIndex: l.log_index,
      address: l.address,
      topics: l.topics,
      data: l.data,
      status: l.status,
    })),
  }
}

/* ------------------------------------------------------------------ confirmation depth */

/**
 * Everything a confirmation answer needs, read in ONE statement.
 *
 * The single statement is the correctness, not an optimisation. `orphanAbove` retracts blocks,
 * transactions and activity inside one transaction, so a statement sees either all of a reorg or
 * none of it. Reading the transaction and the head in two round trips does not: a reorg landing
 * between them yields a row that still says `included` counted against a head that has already
 * moved past it, which is a confirmation for a transaction that is no longer on the chain — the
 * exact wrong answer a depth exists to prevent.
 *
 * `head_height` is the highest CANONICAL block this indexer has stored, not `checkpoints.tip_height`.
 * The tip is what a provider last claimed; the head is what this service has actually walked and
 * would have detected a reorg in. Counting confirmations against blocks nobody here has looked at
 * is over-reporting depth, and over-reporting depth is how money is credited early.
 */
export interface ConfirmationRecord {
  readonly hash: string
  readonly status: TransactionStatus
  readonly blockHash: string | null
  readonly blockHeight: number | null
  /** The status of the block the transaction names. Null when it names none. */
  readonly blockStatus: BlockStatus | null
  /** Highest canonical stored block. Null when nothing has been indexed for this scope. */
  readonly headHeight: number | null
  /** The tip as last observed. Reported, never counted against. */
  readonly tipHeight: number | null
  readonly halted: boolean
}

export async function confirmationOf(
  exec: Exec,
  scope: ChainScope,
  hash: string,
): Promise<ConfirmationRecord | null> {
  const rows = await exec<
    {
      hash: string
      status: TransactionStatus
      block_hash: string | null
      block_height: string | null
      block_status: BlockStatus | null
      head_height: string | null
      tip_height: string | null
      halted: boolean
    }[]
  >`
    select t.hash,
           t.status,
           t.block_hash,
           t.block_height,
           b.status as block_status,
           (
             select max(height) from blocks
              where chain = ${scope.chain} and network = ${scope.network}
                and status <> 'orphaned'
           ) as head_height,
           c.tip_height,
           coalesce(c.halted, false) as halted
      from transactions t
      left join blocks b
        on b.chain = t.chain and b.network = t.network and b.hash = t.block_hash
      left join checkpoints c
        on c.chain = t.chain and c.network = t.network and c.stream = ${TIP_STREAM}
     where t.chain = ${scope.chain} and t.network = ${scope.network} and t.hash = ${hash}
  `
  const row = rows[0]
  if (!row) return null
  return {
    hash: row.hash,
    status: row.status,
    blockHash: row.block_hash,
    blockHeight: row.block_height === null ? null : Number(row.block_height),
    blockStatus: row.block_status,
    headHeight: row.head_height === null ? null : Number(row.head_height),
    tipHeight: row.tip_height === null ? null : Number(row.tip_height),
    halted: row.halted,
  }
}

/* ------------------------------------------------------------------ token balances */

/**
 * What stretch of the canonical chain this service actually holds, at or below a height.
 *
 * A balance derived from movements is only a balance if the movements are ALL of them. This is the
 * evidence for that: `lowestHeight` must be the genesis block and the range must have no hole, or
 * the sum below is a sum over a window and not a balance. The follower cold-starts at
 * `tip − 2 × depth` (`evm.ts` `#cursor`), so an indexer that was never backfilled to zero cannot
 * answer, and must say so rather than return the window's total.
 *
 * The count rides `blocks_canonical_height_uniq` — `(chain, network, height) where status <>
 * 'orphaned'` — which is the same partial index the reorg constraint needs, so this costs an
 * index-only scan and no new index.
 */
export interface CanonicalCoverage {
  /** Highest canonical block stored for the scope, ignoring the bound. Null when none is. */
  readonly headHeight: number | null
  readonly lowestHeight: number | null
  readonly highestHeight: number | null
  readonly blocks: number
  readonly tipHeight: number | null
  readonly halted: boolean
}

export async function canonicalCoverage(
  exec: Exec,
  scope: ChainScope,
  upToHeight: number | null,
): Promise<CanonicalCoverage> {
  const rows = await exec<
    {
      head_height: string | null
      lowest_height: string | null
      highest_height: string | null
      blocks: string
      tip_height: string | null
      halted: boolean
    }[]
  >`
    select (
             select max(height) from blocks
              where chain = ${scope.chain} and network = ${scope.network}
                and status <> 'orphaned'
           ) as head_height,
           (
             select min(height) from blocks
              where chain = ${scope.chain} and network = ${scope.network}
                and status <> 'orphaned'
                and (${upToHeight === null} or height <= ${upToHeight ?? 0})
           ) as lowest_height,
           (
             select max(height) from blocks
              where chain = ${scope.chain} and network = ${scope.network}
                and status <> 'orphaned'
                and (${upToHeight === null} or height <= ${upToHeight ?? 0})
           ) as highest_height,
           (
             select count(*) from blocks
              where chain = ${scope.chain} and network = ${scope.network}
                and status <> 'orphaned'
                and (${upToHeight === null} or height <= ${upToHeight ?? 0})
           ) as blocks,
           (
             select tip_height from checkpoints
              where chain = ${scope.chain} and network = ${scope.network}
                and stream = ${TIP_STREAM}
           ) as tip_height,
           coalesce((
             select halted from checkpoints
              where chain = ${scope.chain} and network = ${scope.network}
                and stream = ${TIP_STREAM}
           ), false) as halted
  `
  const row = rows[0]
  if (!row) throw new Error('coverage query returned no row')
  return {
    headHeight: row.head_height === null ? null : Number(row.head_height),
    lowestHeight: row.lowest_height === null ? null : Number(row.lowest_height),
    highestHeight: row.highest_height === null ? null : Number(row.highest_height),
    blocks: Number(row.blocks),
    tipHeight: row.tip_height === null ? null : Number(row.tip_height),
    halted: row.halted,
  }
}

export interface TokenBalanceRecord {
  readonly contract: string
  readonly balance: bigint
  readonly movements: number
}

/**
 * Net token movement for one address, at or below a height.
 *
 * `in` minus `out` over the included rows. Orphaned rows are excluded, which is what makes this
 * reorg-correct: `orphanAbove` marks them in the same transaction that retracts the blocks, so a
 * reader either sees the reorg or does not, and never sees a movement whose block has left.
 *
 * Native movements are excluded deliberately. A native balance would also have to account for gas
 * paid, which `address_activity` does not record as a movement, so the sum would be short by every
 * fee this address has ever paid — a plausible number and a wrong one.
 */
export async function tokenBalancesAt(
  exec: Exec,
  scope: ChainScope,
  address: string,
  upToHeight: number,
  contract: string | null,
): Promise<TokenBalanceRecord[]> {
  const rows = await exec<{ contract: string; balance: string; movements: number }[]>`
    select token_address as contract,
           sum(case when direction = 'in' then amount else -amount end)::text as balance,
           count(*)::int as movements
      from address_activity
     where chain = ${scope.chain} and network = ${scope.network}
       and address = ${address}
       and asset_kind = 'token'
       and status = 'included'
       and block_height <= ${upToHeight}
       and (${contract === null} or token_address = ${contract ?? ''})
     group by token_address
     order by token_address
  `
  return rows.map((r) => ({
    contract: r.contract,
    balance: BigInt(r.balance),
    movements: r.movements,
  }))
}

export interface BlockRecord extends StoredBlock {
  readonly transactionHashes: readonly string[]
}

export async function blockWithTransactions(
  exec: Exec,
  scope: ChainScope,
  height: number,
): Promise<BlockRecord | null> {
  const block = await blockAtHeight(exec, scope, height)
  if (!block) return null
  const rows = await exec<{ hash: string }[]>`
    select hash from transactions
     where chain = ${scope.chain} and network = ${scope.network} and block_hash = ${block.hash}
     order by tx_index
  `
  return { ...block, transactionHashes: rows.map((r) => r.hash) }
}
