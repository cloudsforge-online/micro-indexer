/**
 * The Solana worker's tests.
 *
 * The bar is `evm.test.ts`, but the interesting assertions are the ones that would FAIL against a
 * ported EVM implementation: a skipped slot that is not a gap, a parent link that is not slot − 1,
 * a deep fork above the finalized watermark that is repaired without alarm, and a shallow one below
 * it that halts the chain. Those four are the whole of "Solana's commitment levels are not block
 * depth", driven rather than asserted about.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import type { ChainScope } from './chains.ts'
import {
  ACCEPTED_GENESIS,
  GENESIS_HASHES,
  SolanaClusterError,
  SolanaFinalizedForkError,
  SolanaWorker,
  accountKeysOf,
  extractSolanaBlock,
  lamportsOf,
  signatureOf,
  type RawSolBlock,
} from './solana.ts'
import { FakeSolanaNode, deadSolanaClient, fakeSolanaClient } from './fakesolana.ts'
import { registerServiceMetrics } from './metrics.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import { DEPOSIT_CONFIRMED, DEPOSIT_OBSERVED, type Db } from './outbox.ts'
import { postgresReadStore } from './reads.ts'
import { RpcPool } from './rpc.ts'
import { TIP_STREAM, getCheckpoint, watchAddress } from './store.ts'

/* ------------------------------------------------------------------ pure, no database */

const ALICE = 'A1iceA1iceA1iceA1iceA1iceA1iceA1iceA1ice111'
const BOB = 'B0bB0bB0bB0bB0bB0bB0bB0bB0bB0bB0bB0bB0b2222'
const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

test('a lamport value that has already lost precision is refused, not credited', () => {
  assert.equal(lamportsOf(0), 0n)
  assert.equal(lamportsOf(undefined), 0n)
  assert.equal(lamportsOf(1_000_000_000), 1_000_000_000n)
  assert.throws(() => lamportsOf(Number.NaN), RangeError)
  assert.throws(() => lamportsOf(-1), RangeError)
  // Above 2^53 a u64 has already been rounded by JSON.parse. Crediting the rounded number is worse
  // than refusing it, because it is plausible and wrong.
  assert.throws(() => lamportsOf(Number.MAX_SAFE_INTEGER + 2), RangeError)
})

test('a versioned transaction resolves lookup-table accounts writable-first', () => {
  const tx = {
    transaction: { signatures: ['sig'], message: { accountKeys: ['a', 'b'] } },
    meta: { loadedAddresses: { writable: ['w1', 'w2'], readonly: ['r1'] } },
  }
  // The ORDER is the correctness: preBalances is indexed over this list, so getting it wrong
  // attributes one account's movement to another — a deposit credited to the wrong user.
  assert.deepEqual(accountKeysOf(tx), ['a', 'b', 'w1', 'w2', 'r1'])
  assert.deepEqual(
    accountKeysOf({ transaction: { signatures: ['s'], message: { accountKeys: ['a'] } } }),
    ['a'],
  )
  assert.equal(signatureOf(tx), 'sig')
})

test('deposits come from balance deltas, so any program that moved lamports is seen', () => {
  const raw: RawSolBlock = {
    blockhash: 'h100',
    previousBlockhash: 'h97',
    parentSlot: 97,
    blockTime: 1_700_000_000,
    blockHeight: 50,
    transactions: [
      {
        transaction: { signatures: ['sigA'], message: { accountKeys: [ALICE, BOB] } },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000, 0],
          postBalances: [899_995_000, 100_000_000],
        },
      },
    ],
  }
  const out = extractSolanaBlock(raw, 100, 'SOL')

  assert.equal(out.block.height, 100, 'the SLOT, not blockHeight')
  assert.equal(out.block.detail['parentSlot'], 97, 'the parent is not slot - 1')
  assert.equal(out.block.detail['blockHeight'], 50, 'kept, but never used as the checkpoint')

  const inbound = out.activity.find((a) => a.address === BOB)
  assert.equal(inbound?.direction, 'in')
  assert.equal(inbound?.amount, 100_000_000n)
  const outbound = out.activity.find((a) => a.address === ALICE)
  assert.equal(outbound?.direction, 'out')
  // 100_000_000 sent plus the 5_000 fee. The delta is the truth, and it includes the fee because
  // the fee genuinely left the account.
  assert.equal(outbound?.amount, 100_005_000n)
  assert.equal(out.transactions[0]?.from, ALICE, 'accountKeys[0] is the fee payer by definition')
  assert.equal(out.transactions[0]?.to, null, 'a transaction may credit any number of accounts')
})

test('a FAILED solana transaction still moved the fee, and the deltas say so with no special case', () => {
  // This is where evm.ts must branch and this worker must not. A reverted EVM transaction
  // transferred nothing; a failed Solana transaction is committed and IS charged.
  const raw: RawSolBlock = {
    blockhash: 'h1',
    previousBlockhash: 'h0',
    parentSlot: 0,
    blockTime: 1,
    transactions: [
      {
        transaction: { signatures: ['sigF'], message: { accountKeys: [ALICE, BOB] } },
        meta: {
          err: { InstructionError: [0, 'Custom'] },
          fee: 5_000,
          preBalances: [1_000_000_000, 7],
          postBalances: [999_995_000, 7],
        },
      },
    ],
  }
  const out = extractSolanaBlock(raw, 1, 'SOL')
  assert.equal(out.transactions[0]?.status, 'failed')
  assert.equal(out.transactions[0]?.fee, 5_000n)
  // Exactly one movement: the fee leaving. Bob is credited nothing, which is correct and required
  // no branch — the chain rolled the transfer back and the balances already reflect it.
  assert.equal(out.activity.length, 1)
  assert.equal(out.activity[0]?.address, ALICE)
  assert.equal(out.activity[0]?.direction, 'out')
  assert.equal(out.activity[0]?.amount, 5_000n)
})

test('balance arrays that cannot be aligned attribute NOTHING, and the row says so', () => {
  const raw: RawSolBlock = {
    blockhash: 'h2',
    previousBlockhash: 'h1',
    parentSlot: 1,
    blockTime: 2,
    transactions: [
      {
        transaction: { signatures: ['sigM'], message: { accountKeys: [ALICE, BOB] } },
        meta: { err: null, fee: 5_000, preBalances: [1, 2, 3], postBalances: [1, 2] },
      },
    ],
  }
  const out = extractSolanaBlock(raw, 2, 'SOL')
  assert.equal(out.activity.length, 0, 'aligning them anyway credits the wrong account')
  assert.equal(out.transactions[0]?.rawRef['balancesAligned'], false, 'visible as a data fact')
})

test('SPL movements are attributed to the OWNER and keyed clear of the native index space', () => {
  const raw: RawSolBlock = {
    blockhash: 'h3',
    previousBlockhash: 'h2',
    parentSlot: 2,
    blockTime: 3,
    transactions: [
      {
        transaction: { signatures: ['sigT'], message: { accountKeys: [ALICE, BOB] } },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000, 0],
          postBalances: [999_995_000, 0],
          preTokenBalances: [
            { accountIndex: 1, mint: MINT, owner: BOB, uiTokenAmount: { amount: '0' } },
          ],
          postTokenBalances: [
            { accountIndex: 1, mint: MINT, owner: BOB, uiTokenAmount: { amount: '250000' } },
          ],
        },
      },
    ],
  }
  const out = extractSolanaBlock(raw, 3, 'SOL')
  const token = out.activity.find((a) => a.assetKind === 'token')
  assert.equal(token?.address, BOB, 'the owner, not the token account')
  assert.equal(token?.amount, 250_000n)
  assert.equal(token?.assetCode, MINT, 'the mint address, never a symbol')

  // Alice has a native movement at account index 0 and there is a token movement at index 1; the
  // keys must not be able to collide across the two spaces.
  const keys = out.activity.map((a) => a.entryKey)
  assert.equal(new Set(keys).size, keys.length, 'entry keys must be unique within a transaction')
})

test('a mainnet-beta ledger may never be indexed into testnet rows, or the reverse', () => {
  assert.deepEqual(ACCEPTED_GENESIS.mainnet, [GENESIS_HASHES['mainnet-beta']])
  assert.equal(ACCEPTED_GENESIS.testnet.includes(GENESIS_HASHES['mainnet-beta']), false)
  assert.equal(ACCEPTED_GENESIS.testnet.includes(GENESIS_HASHES.devnet), true)
  assert.equal(ACCEPTED_GENESIS.testnet.includes(GENESIS_HASHES.testnet), true)
})

/* ------------------------------------------------------------------ database-backed */

const url = process.env['INDEXER_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'

const SCOPE: ChainScope = { chain: 'sol', network: 'testnet' }

let sql: postgres.Sql
const db = (): Db => sql
const silent = new Logger({ service: 'indexer-test', sink: () => {} })

function workerFor(
  node: FakeSolanaNode,
  options: { followBatchBlocks?: number; dead?: boolean; startHeight?: number } = {},
): SolanaWorker {
  const endpoints = options.dead
    ? [
        { name: 'primary', url: 'http://primary.invalid/' },
        { name: 'secondary', url: 'http://secondary.invalid/' },
      ]
    : [{ name: 'fake', url: 'http://fake.invalid/' }]
  const clients = new Map<string, Pick<import('@cloudsforge/http').HttpClient, 'request'>>()
  for (const endpoint of endpoints) {
    clients.set(
      endpoint.name,
      endpoint.name === 'primary' ? deadSolanaClient() : fakeSolanaClient(node),
    )
  }
  const pool = new RpcPool({
    scope: SCOPE,
    endpoints,
    clientFor: (endpoint) => {
      const client = clients.get(endpoint.name)
      if (!client) throw new Error(`no client for ${endpoint.name}`)
      return client
    },
  })
  return new SolanaWorker({
    sql: db(),
    scope: SCOPE,
    rpc: pool,
    logger: silent,
    metrics: registerServiceMetrics(new Metrics(), []),
    producer: 'indexer',
    followBatchBlocks: options.followBatchBlocks ?? 100,
    backfillBatchBlocks: 100,
    startHeight: options.startHeight ?? 0,
  })
}

const signal = (): AbortSignal => new AbortController().signal

async function canonicalSlots(): Promise<number[]> {
  const rows = await sql<{ height: string }[]>`
    select height from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and status <> 'orphaned'
     order by height
  `
  return rows.map((r) => Number(r.height))
}

async function outboxTopics(): Promise<string[]> {
  const rows = await sql<{ topic: string }[]>`select topic from outbox order by occurred_at, topic`
  return rows.map((r) => r.topic)
}

before(async () => {
  if (!enabled) return
  sql = postgres(url!, { max: 4, onnotice: () => {} })
  await sql.unsafe(
    `drop table if exists ${CHAIN_TABLES.join(', ')}, outbox_deliveries, event_subscriptions,
     outbox, inbox, jobs, schema_migrations cascade`,
  )
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'indexer-test' })
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await sql.unsafe(`truncate ${CHAIN_TABLES.join(', ')}, outbox, inbox restart identity cascade`)
})

test('a cluster this scope may not index is fatal, not a warning', { skip }, async () => {
  const node = new FakeSolanaNode({ genesisHash: GENESIS_HASHES['mainnet-beta'] })
  await assert.rejects(() => workerFor(node).verifyIdentity(signal()), SolanaClusterError)
})

test(
  'SKIPPED SLOTS ARE NOT GAPS: the follower walks past them and never stalls',
  { skip },
  async () => {
    // The single most consequential difference from an EVM follower. Slots 1, 3, 6 and 7 never
    // produce a block; an implementation that asked for slot+1 and read the refusal as a gap
    // would stop dead at slot 1 and never reach the tip.
    const node = new FakeSolanaNode() //   slot 0 produced
    node.skip(1) //                        slot 1 skipped
    node.produce() //                      slot 2
    node.skip(1) //                        slot 3 skipped
    node.produce() //                      slot 4
    node.produce() //                      slot 5
    node.skip(2) //                        slots 6, 7 skipped
    node.produce() //                      slot 8
    node.finalize(8)

    const worker = workerFor(node)
    const outcome = await worker.follow(signal())

    assert.equal(outcome.blocksIndexed, 5, 'five blocks across nine slots')
    assert.equal(outcome.tipHeight, 8)
    assert.deepEqual(await canonicalSlots(), [0, 2, 4, 5, 8])
    assert.equal(outcome.reorgs.length, 0, 'a skipped slot is not a reorg')
    assert.equal(outcome.halted, false)
    // The checkpoint sits at the tip SLOT, not at the last slot that produced a block: leaving it
    // at 8 vs 5 is the difference between resuming and re-asking an empty range for ever.
    assert.equal((await getCheckpoint(db(), SCOPE, TIP_STREAM))?.height, 8)
    assert.equal(outcome.lag, 0)

    // A second tick with nothing new must be a no-op, not a re-walk.
    const again = await worker.follow(signal())
    assert.equal(again.blocksIndexed, 0)
    assert.equal(again.lag, 0)
  },
)

test('the parent link is parentSlot, not slot minus one', { skip }, async () => {
  const node = new FakeSolanaNode()
  node.skip(3)
  node.produce()
  node.skip(2)
  node.produce()
  node.finalize(node.tip)
  await workerFor(node).follow(signal())

  const rows = await sql<{ height: string; parent_hash: string; detail: { parentSlot: number } }[]>`
    select height, parent_hash, detail from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network}
     order by height
  `
  assert.equal(rows.length, 3)
  // Slot 4's parent is slot 0 and slot 7's parent is slot 4. Comparing against height - 1 would
  // compare against a slot that never existed.
  assert.equal(Number(rows[1]?.height), 4)
  assert.equal(rows[1]?.detail.parentSlot, 0)
  assert.equal(rows[1]?.parent_hash, rows[0]?.parent_hash === undefined ? '' : node.hashAt(0))
  assert.equal(Number(rows[2]?.height), 7)
  assert.equal(rows[2]?.detail.parentSlot, 4)
  assert.equal(rows[2]?.parent_hash, node.hashAt(4))
})

test(
  'a fork ABOVE the finalized slot is retracted at any distance, and does NOT alarm',
  { skip },
  async () => {
    // The opposite of the EVM rule. Nine slots is far past SOL's reorgAlarmDepth of 8, and an
    // EVM-shaped implementation would halt the chain here. Above the finalized watermark a fork is
    // ordinary and the distance is a duration, not a probability.
    const node = new FakeSolanaNode()
    node.produceMany(5) //                       slots 1..5
    node.finalize(5)
    node.produce([{ from: ALICE, to: BOB, lamports: 100_000_000n }]) // slot 6
    node.produceMany(9) //                       slots 7..15

    await watchAddress(db(), SCOPE, BOB, 'bob')
    const worker = workerFor(node)
    await worker.follow(signal())
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
    const oldHead = node.hashAt(15)

    // Everything from slot 6 up is abandoned — ten slots, all above the finalized slot 5.
    node.abandon(6, 4)
    const outcome = await worker.follow(signal())

    const reorg = outcome.reorgs[0]
    assert.ok(reorg)
    assert.equal(reorg.commonAncestorHeight, 5, 'the finalized slot is the deepest agreement')
    assert.equal(reorg.depth, 10, 'a SLOT distance, recorded but never branched on')
    assert.equal(
      reorg.alarming,
      false,
      'above the finalized slot, distance decides nothing — an EVM depth rule would halt here',
    )
    assert.equal(outcome.halted, false)
    assert.equal(reorg.orphanedBlocks, 10)

    // The retraction landed and the replacement chain was indexed.
    const orphan = await sql<{ status: string }[]>`
      select status from blocks
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and hash = ${oldHead}
    `
    assert.equal(orphan[0]?.status, 'orphaned')
    assert.deepEqual(await canonicalSlots(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    const duplicates = await sql<{ height: string }[]>`
      select height from blocks
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and status <> 'orphaned'
       group by height having count(*) > 1
    `
    assert.equal(duplicates.length, 0, 'two blocks may never claim one slot')

    // Bob's credit is retracted, and visible as retracted through the read path.
    const reads = postgresReadStore(db())
    const page = await reads.activity(SCOPE, BOB, 10, null)
    assert.equal(page.items[0]?.status, 'orphaned')
    assert.equal(page.items[0]?.confirmations, null)
    assert.equal(page.items[0]?.confirmed, false)
  },
)

test(
  'a fork BELOW the finalized slot halts the chain, however shallow it is',
  { skip },
  async () => {
    // One slot deep — far below SOL's alarm depth of 8, so an EVM depth rule would shrug and
    // repair it. Finalized history does not fork, so this is a cluster restart or the wrong
    // endpoint, and neither is something to re-index past.
    const node = new FakeSolanaNode()
    node.produceMany(9)
    node.finalize(9)
    const worker = workerFor(node)
    await worker.follow(signal())
    assert.deepEqual(await canonicalSlots(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    // The endpoint contradicts itself: slot 9 is finalized and now has a different blockhash.
    node.abandon(9, 1)
    node.finalize(9)

    await assert.rejects(() => worker.follow(signal()), SolanaFinalizedForkError)

    // The chain is halted, durably, and only an operator clears it.
    const checkpoint = await getCheckpoint(db(), SCOPE, TIP_STREAM)
    assert.equal(checkpoint?.halted, true)
    assert.match(String(checkpoint?.haltReason), /finalized/)

    const after = await worker.follow(signal())
    assert.equal(after.halted, true)
    assert.equal(after.blocksIndexed, 0)
  },
)

test(
  'a deposit is confirmed only when it is BOTH finalized and at its declared depth',
  { skip },
  async () => {
    const node = new FakeSolanaNode()
    node.produceMany(4)
    node.produce([{ from: ALICE, to: BOB, lamports: 250_000_000n }]) // slot 5
    await watchAddress(db(), SCOPE, BOB, 'bob')
    const worker = workerFor(node)

    node.produceMany(40) // slot 45: far past SOL's depth of 32...
    node.finalize(4) //     ...but the cluster has finalized nothing at or above slot 5.
    let outcome = await worker.follow(signal())
    assert.equal(outcome.confirmed, 0, 'depth alone must not credit — finality is the real one')
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])

    // Now the cluster finalizes past it. Both conditions hold.
    node.finalize(node.tip)
    outcome = await worker.follow(signal())
    assert.equal(outcome.confirmed, 1)
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED])

    // And never twice.
    node.produceMany(2)
    node.finalize(node.tip)
    assert.equal((await worker.follow(signal())).confirmed, 0)
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED])
  },
)

test(
  'finality without depth does not credit either — both conditions, not one',
  { skip },
  async () => {
    const node = new FakeSolanaNode()
    node.produceMany(4)
    node.produce([{ from: ALICE, to: BOB, lamports: 250_000_000n }]) // slot 5
    node.produceMany(3) //                                              slot 8
    // The cluster says finalized, but only 4 slots of depth have passed against a declared 32.
    // contracts-chain is exact-pinned precisely so this number is the same in four services.
    node.finalize(node.tip)
    await watchAddress(db(), SCOPE, BOB, 'bob')

    const outcome = await workerFor(node).follow(signal())
    assert.equal(outcome.confirmed, 0)
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
  },
)

test('re-indexing the same slots is a no-op, not a pile of duplicates', { skip }, async () => {
  const node = new FakeSolanaNode()
  node.produceMany(2)
  node.produce([{ from: ALICE, to: BOB, lamports: 100_000_000n }])
  node.skip(1)
  node.produce()
  node.finalize(node.tip)
  await watchAddress(db(), SCOPE, BOB, 'bob')
  const worker = workerFor(node)

  await worker.follow(signal())
  const before = await sql<{ n: number }[]>`
    select count(*)::int as n from address_activity
     where chain = ${SCOPE.chain} and network = ${SCOPE.network}
  `
  const topics = await outboxTopics()

  await sql`
    update checkpoints set height = 0
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and stream = ${TIP_STREAM}
  `
  await worker.follow(signal())

  const after = await sql<{ n: number }[]>`
    select count(*)::int as n from address_activity
     where chain = ${SCOPE.chain} and network = ${SCOPE.network}
  `
  assert.equal(after[0]?.n, before[0]?.n)
  assert.deepEqual(await outboxTopics(), topics, 're-indexing must not re-announce a deposit')
})

test('an unreachable provider is failed over, not treated as a gap', { skip }, async () => {
  const node = new FakeSolanaNode()
  node.produceMany(4)
  node.finalize(node.tip)
  const outcome = await workerFor(node, { dead: true }).follow(signal())
  assert.equal(outcome.providerUnavailable, false)
  assert.equal(outcome.blocksIndexed, 5)
  assert.deepEqual(await canonicalSlots(), [0, 1, 2, 3, 4])
})
