import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import type { ChainScope } from './chains.ts'
import {
  ERC20_TRANSFER_TOPIC,
  EvmWorker,
  addressFromTopic,
  extractBlock,
  hexToBigInt,
  hexToNumber,
} from './evm.ts'
import { FakeChain, deadClient, fakeClient, type TxSpec } from './fakechain.ts'
import { registerServiceMetrics } from './metrics.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import { DEPOSIT_CONFIRMED, DEPOSIT_OBSERVED, type Db } from './outbox.ts'
import { postgresReadStore } from './reads.ts'
import { RpcPool } from './rpc.ts'
import { TIP_STREAM, ensureBackfill, getCheckpoint, watchAddress } from './store.ts'

/* ------------------------------------------------------------------ pure, no database */

const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x3333333333333333333333333333333333333333'

const topicFor = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`
const amountData = (value: bigint): string => `0x${value.toString(16).padStart(64, '0')}`

test('hex quantities parse, and a height that would lose precision throws rather than rounds', () => {
  assert.equal(hexToNumber('0x1cf4'), 7412)
  assert.equal(hexToNumber(undefined), 0)
  assert.equal(hexToBigInt('0xde0b6b3a7640000'), 1_000_000_000_000_000_000n)
  // A silently rounded height is a checkpoint that resumes in the wrong place.
  assert.throws(() => hexToNumber('0xffffffffffffffff'), RangeError)
})

test('an indexed address topic yields a lower-cased address, and anything else yields null', () => {
  assert.equal(addressFromTopic(topicFor(ALICE)), ALICE)
  assert.equal(addressFromTopic(`0x${'f'.repeat(64)}`), null, 'not left-padded: not an address')
  assert.equal(addressFromTopic('0xdead'), null)
  assert.equal(addressFromTopic(undefined), null)
})

test('a native transfer produces one outbound and one inbound movement with the real hash', () => {
  const raw = {
    number: '0xa',
    hash: '0xblock',
    parentHash: '0xparent',
    timestamp: '0x65000000',
    transactions: [
      { hash: '0xtx1', from: ALICE.toUpperCase(), to: BOB, value: '0x64', transactionIndex: '0x0' },
    ],
  }
  const receipts = new Map([
    ['0xtx1', { transactionHash: '0xtx1', status: '0x1', gasUsed: '0x2', effectiveGasPrice: '0x3' }],
  ])
  const out = extractBlock(raw, receipts, 'EMBER')

  assert.equal(out.block.height, 10)
  assert.equal(out.transactions.length, 1)
  assert.equal(out.transactions[0]?.status, 'success')
  assert.equal(out.transactions[0]?.fee, 6n, 'gasUsed * effectiveGasPrice')
  // Checksum casing is a display convention; storing it makes `where address = $1` miss.
  assert.equal(out.transactions[0]?.from, ALICE)

  assert.equal(out.activity.length, 2)
  const [outbound, inbound] = out.activity
  assert.equal(outbound?.direction, 'out')
  assert.equal(outbound?.address, ALICE)
  assert.equal(inbound?.direction, 'in')
  assert.equal(inbound?.address, BOB)
  assert.equal(inbound?.amount, 100n)
  assert.equal(inbound?.assetCode, 'EMBER')
  assert.equal(inbound?.assetKind, 'native')
  assert.equal(inbound?.txHash, '0xtx1', 'a real chain hash, not a synthetic id')
})

test('a reverted transaction is recorded and produces no movement at all', () => {
  const raw = {
    number: '0x1',
    hash: '0xb',
    parentHash: '0xa',
    timestamp: '0x1',
    transactions: [{ hash: '0xtx', from: ALICE, to: BOB, value: '0x64' }],
  }
  const receipts = new Map([
    [
      '0xtx',
      {
        transactionHash: '0xtx',
        status: '0x0',
        gasUsed: '0x1',
        effectiveGasPrice: '0x1',
        logs: [{ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC], data: '0x' }],
      },
    ],
  ])
  const out = extractBlock(raw, receipts, 'EMBER')
  // "No failed-transaction visibility" is one of the defects in 00-current-state §3.4, so the row
  // exists — but a reverted transfer moved nothing, so there is no movement and no log.
  assert.equal(out.transactions[0]?.status, 'failed')
  assert.equal(out.activity.length, 0)
  assert.equal(out.logs.length, 0)
})

test('an ERC-20 Transfer produces token movements; an ERC-721 Transfer produces none', () => {
  const raw = {
    number: '0x2',
    hash: '0xc',
    parentHash: '0xb',
    timestamp: '0x1',
    transactions: [{ hash: '0xtx', from: ALICE, to: TOKEN, value: '0x0' }],
  }
  const receipts = new Map([
    [
      '0xtx',
      {
        transactionHash: '0xtx',
        status: '0x1',
        gasUsed: '0x1',
        effectiveGasPrice: '0x1',
        logs: [
          {
            address: TOKEN,
            topics: [ERC20_TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
            data: amountData(500n),
            logIndex: '0x0',
          },
          {
            // ERC-721: a fourth topic holding the token id rather than an amount in data.
            address: TOKEN,
            topics: [ERC20_TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB), amountData(7n)],
            data: '0x',
            logIndex: '0x1',
          },
        ],
      },
    ],
  ])
  const out = extractBlock(raw, receipts, 'EMBER')
  assert.equal(out.logs.length, 2, 'both logs are stored')
  assert.equal(out.activity.length, 2, 'only the fungible transfer is a movement')
  const inbound = out.activity.find((a) => a.direction === 'in')
  assert.equal(inbound?.amount, 500n)
  assert.equal(inbound?.assetKind, 'token')
  assert.equal(inbound?.tokenAddress, TOKEN)
  // The contract address, never a symbol: a symbol is mutable, spoofable and off-chain.
  assert.equal(inbound?.assetCode, TOKEN)
})

test('a transaction with no receipt is pending, not success', () => {
  const raw = {
    number: '0x1',
    hash: '0xb',
    parentHash: '0xa',
    timestamp: '0x1',
    transactions: [{ hash: '0xtx', from: ALICE, to: BOB, value: '0x64' }],
  }
  const out = extractBlock(raw, new Map(), 'EMBER')
  assert.equal(out.transactions[0]?.status, 'pending')
  assert.equal(out.transactions[0]?.fee, null)
  assert.equal(out.activity.length, 0, 'an unestablished outcome must not credit anything')
})

/* ------------------------------------------------------------------ database-backed */

/**
 * A database test runs only against a database whose name says it is a test database.
 *
 * Not a convenience: `beforeEach` truncates. Requiring "test" in the name is the difference
 * between a red build and an emptied environment.
 */
const url = process.env['INDEXER_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'

const SCOPE: ChainScope = { chain: 'ember', network: 'testnet' }

let sql: postgres.Sql
const db = (): Db => sql

const silent = new Logger({ service: 'indexer-test', sink: () => {} })

function workerFor(
  chain: FakeChain,
  options: {
    followBatchBlocks?: number
    backfillBatchBlocks?: number
    fault?: (method: string, callIndex: number) => Error | null
    dead?: boolean
  } = {},
): EvmWorker {
  const endpoints = options.dead
    ? [
        { name: 'primary', url: 'http://primary.invalid/' },
        { name: 'secondary', url: 'http://secondary.invalid/' },
      ]
    : [{ name: 'fake', url: 'http://fake.invalid/' }]
  // Built once, not per call: a fake client counts the calls it has served, and rebuilding it on
  // every request would reset that counter and make an injected mid-range fault unreachable.
  const clients = new Map<string, ReturnType<typeof fakeClient>>()
  for (const endpoint of endpoints) {
    clients.set(
      endpoint.name,
      endpoint.name === 'primary'
        ? deadClient()
        : fakeClient(chain, options.fault ? { fault: options.fault } : {}),
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
  return new EvmWorker({
    sql: db(),
    scope: SCOPE,
    family: 'ember',
    rpc: pool,
    logger: silent,
    metrics: registerServiceMetrics(new Metrics()),
    producer: 'indexer',
    followBatchBlocks: options.followBatchBlocks ?? 100,
    backfillBatchBlocks: options.backfillBatchBlocks ?? 100,
    startHeight: 0,
  })
}

const signal = (): AbortSignal => new AbortController().signal

async function canonicalHeights(): Promise<number[]> {
  const rows = await sql<{ height: string }[]>`
    select height from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and status <> 'orphaned'
     order by height
  `
  return rows.map((r) => Number(r.height))
}

async function countOf(table: string, where = ''): Promise<number> {
  const rows = (await sql.unsafe(
    `select count(*)::int as n from ${table} where chain = $1 and network = $2 ${where}`,
    [SCOPE.chain, SCOPE.network],
  )) as Array<{ n: number }>
  return rows[0]?.n ?? 0
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

test('the follower indexes from a cold start and chains the blocks it wrote', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(5)
  const worker = workerFor(chain)

  const outcome = await worker.follow(signal())
  assert.equal(outcome.blocksIndexed, 6, 'genesis plus five')
  assert.equal(outcome.tipHeight, 5)
  assert.equal(outcome.lag, 0)
  assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5])

  const rows = await sql<{ height: string; hash: string; parent_hash: string }[]>`
    select height, hash, parent_hash from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network}
     order by height
  `
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i]?.parent_hash, rows[i - 1]?.hash, `block ${i} does not chain`)
  }
  const checkpoint = await getCheckpoint(db(), SCOPE, TIP_STREAM)
  assert.equal(checkpoint?.height, 5)
  assert.equal(checkpoint?.blockHash, chain.hashAt(5))
})

test(
  'a reorg finds the common ancestor, marks the orphans, corrects activity and leaves no duplicates',
  { skip },
  async () => {
    const chain = new FakeChain()
    const survivor: TxSpec = { from: ALICE, to: BOB, value: 1_000n }
    const doomed: TxSpec = { from: ALICE, to: BOB, value: 7_000n }
    chain.appendMany(7) //          heights 1..7
    chain.append([survivor]) //     height 8  — below the fork, must survive
    chain.appendMany(1) //          height 9
    chain.append([doomed]) //       height 10 — above the fork, must be retracted
    chain.appendMany(1) //          height 11

    await watchAddress(db(), SCOPE, BOB, 'a watched deposit address')
    const worker = workerFor(chain)
    await worker.follow(signal())

    assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    assert.equal(await countOf('address_activity', `and direction = 'in'`), 2)
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_OBSERVED])
    const oldHead = chain.hashAt(11)

    // History is rewritten from height 9: blocks 9, 10 and 11 leave the canonical chain.
    chain.reorg(9, 3)
    const outcome = await worker.follow(signal())

    assert.equal(outcome.reorgs.length, 1)
    const reorg = outcome.reorgs[0]
    assert.ok(reorg)
    assert.equal(reorg.commonAncestorHeight, 8, 'the deepest block both histories agree on')
    assert.equal(reorg.depth, 3)
    assert.equal(reorg.previousTipHeight, 11)
    assert.equal(reorg.alarming, false, 'three is below EMBER’s alarm depth of five')
    assert.equal(reorg.orphanedBlocks, 3)
    assert.equal(reorg.orphanedTransactions, 1, 'the doomed transaction')
    assert.equal(reorg.orphanedActivity, 2, 'its inbound and its outbound movement')

    // The reorg row is the durable record of the incident.
    const recorded = await sql<{ depth: number; alarming: boolean; common_ancestor_hash: string }[]>`
      select depth, alarming, common_ancestor_hash from reorgs
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
    `
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]?.depth, 3)
    assert.equal(recorded[0]?.common_ancestor_hash, chain.hashAt(8))

    // The chain was re-indexed forward, and exactly one block claims each height.
    assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const duplicates = await sql<{ height: string }[]>`
      select height from blocks
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and status <> 'orphaned'
       group by height having count(*) > 1
    `
    assert.equal(duplicates.length, 0, 'two blocks may never claim one height')

    // The old head is retained, marked, and carries the depth that displaced it.
    const orphan = await sql<{ status: string; reorg_depth: number }[]>`
      select status, reorg_depth from blocks
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and hash = ${oldHead}
    `
    assert.equal(orphan[0]?.status, 'orphaned')
    assert.equal(orphan[0]?.reorg_depth, 3)

    // address_activity is corrected: the movement below the fork stands, the one above does not.
    const movements = await sql<
      { block_height: string; status: string; reorged_at: Date | null; confirmed_at: Date | null }[]
    >`
      select block_height, status, reorged_at, confirmed_at from address_activity
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
         and address = ${BOB} and direction = 'in'
       order by block_height
    `
    assert.equal(movements.length, 2, 'retracted, not deleted — the evidence stays')
    assert.equal(movements[0]?.status, 'included')
    assert.equal(movements[1]?.block_height, '10')
    assert.equal(movements[1]?.status, 'orphaned')
    assert.ok(movements[1]?.reorged_at instanceof Date)
    assert.equal(movements[1]?.confirmed_at, null, 'a confirmation of a retracted movement is void')

    // No event was emitted for the replacement chain, because it paid nobody being watched.
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_OBSERVED])
  },
)

test(
  'the reorg retracts a confirmation and a balance, so neither reports a state that was rolled back',
  { skip },
  async () => {
    // The same simulated reorg as above, asked through the two READ capabilities rather than
    // through the tables. These are the reads `micro-market`'s escrow gate and
    // `micro-community`'s token gate take decisions on, so "a reorg cannot produce a wrong answer"
    // has to be true of the answers and not only of the rows underneath them.
    const chain = new FakeChain()
    const transfer: TxSpec = {
      from: ALICE,
      to: TOKEN,
      logs: [
        {
          address: TOKEN,
          topics: [ERC20_TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
          data: amountData(5_000n),
        },
      ],
      hash: `0x${'cd'.repeat(32)}`,
    }
    chain.appendMany(9) //       heights 1..9, genesis is 0
    chain.append([transfer]) //  height 10
    chain.appendMany(2) //       heights 11, 12

    const worker = workerFor(chain)
    await worker.follow(signal())
    const reads = postgresReadStore(db())

    // A balance may be believed here only because this chain was followed from its genesis block.
    const held = await reads.tokenBalances(SCOPE, BOB, TOKEN, null)
    assert.equal(held.coverage.fromHeight, 0)
    assert.equal(held.coverage.complete, true, 'unbroken from genesis, so the sum is a balance')
    assert.equal(held.balance, '5000')
    assert.equal(held.unavailable, undefined)

    const before = await reads.confirmation(SCOPE, transfer.hash!)
    assert.equal(before?.canonical, true)
    // Counted against the stored head of 12, not against whatever a provider last claimed the tip
    // was: 12 − 10 + 1. The block containing a transaction is its first confirmation.
    assert.equal(before?.confirmations, 3)
    assert.equal(before?.requiredConfirmations, 60)
    assert.equal(before?.confirmed, false, 'three is far below EMBER’s depth of sixty')

    // History is rewritten from height 10. The transfer is no longer on the chain.
    chain.reorg(10, 3)
    const outcome = await worker.follow(signal())
    assert.equal(outcome.reorgs.length, 1)
    assert.equal(outcome.reorgs[0]?.depth, 3)

    const after = await reads.confirmation(SCOPE, transfer.hash!)
    assert.equal(after?.status, 'orphaned')
    assert.equal(after?.canonical, false)
    // Null, not a smaller number: a depth measured on a chain that no longer contains the
    // transaction is not a smaller depth, it is not a depth at all.
    assert.equal(after?.confirmations, null)
    assert.equal(after?.confirmed, false)

    const gone = await reads.tokenBalances(SCOPE, BOB, TOKEN, null)
    assert.equal(gone.coverage.complete, true)
    assert.equal(gone.balance, '0', 'the movement left the chain, so the holding left with it')

    // A snapshot block this service has not reached is withheld rather than quietly answered from
    // the head. A gate asking "what did they hold at block 900" must not be handed the balance at
    // block 12 under a heading that says 900.
    const ahead = await reads.tokenBalances(SCOPE, BOB, TOKEN, 900)
    assert.equal(ahead.atBlock, 900, 'the question is echoed, not rewritten')
    assert.equal(ahead.coverage.complete, false)
    assert.equal(ahead.unavailable, 'coverage_incomplete')
    assert.equal('balance' in ahead, false)

    // And a block it HAS reached is answered as at that block, not as at the head.
    const earlier = await reads.tokenBalances(SCOPE, BOB, TOKEN, 5)
    assert.equal(earlier.atBlock, 5)
    assert.equal(earlier.coverage.complete, true)
    assert.equal(earlier.balance, '0', 'nothing had moved to this address by height five')
  },
)

test(
  'a chain followed from the tip withholds a balance rather than reporting the window total',
  { skip },
  async () => {
    // The follower cold-starts at `tip − 2 × depth` unless told otherwise, so an indexer that was
    // never backfilled to zero has seen a WINDOW of an address's movements and not all of them.
    // Summing that window would produce a plausible number and a wrong one, and for a token gate a
    // wrong low number evicts a member who never sold anything.
    const chain = new FakeChain()
    chain.appendMany(9)
    chain.append([
      {
        from: ALICE,
        to: TOKEN,
        logs: [
          {
            address: TOKEN,
            topics: [ERC20_TRANSFER_TOPIC, topicFor(ALICE), topicFor(BOB)],
            data: amountData(5_000n),
          },
        ],
      },
    ])
    chain.appendMany(2)

    const worker = new EvmWorker({
      sql: db(),
      scope: SCOPE,
      family: 'ember',
      rpc: new RpcPool({
        scope: SCOPE,
        endpoints: [{ name: 'fake', url: 'http://fake.invalid/' }],
        clientFor: () => fakeClient(chain),
      }),
      logger: silent,
      metrics: registerServiceMetrics(new Metrics()),
      producer: 'indexer',
      followBatchBlocks: 100,
      backfillBatchBlocks: 100,
      startHeight: 8,
    })
    await worker.follow(signal())

    const answer = await postgresReadStore(db()).tokenBalances(SCOPE, BOB, TOKEN, null)
    assert.equal(answer.coverage.fromHeight, 8, 'the window this service actually holds')
    assert.equal(answer.coverage.complete, false)
    assert.equal(answer.unavailable, 'coverage_incomplete')
    // ABSENT, not zero and not null. A consumer's rule for a missing balance is the same as its
    // rule for an outage, and for a gate that rule is "do not demote".
    assert.equal('balance' in answer, false)
    assert.equal('balances' in answer, false)
  },
)

test(
  'a transaction re-included on the replacement chain is updated in place, never duplicated',
  { skip },
  async () => {
    const chain = new FakeChain()
    const moved: TxSpec = { from: ALICE, to: BOB, value: 42n, hash: `0x${'ab'.repeat(32)}` }
    chain.appendMany(3)
    chain.append([moved]) // height 4
    chain.appendMany(1) // height 5

    await watchAddress(db(), SCOPE, BOB, null)
    const worker = workerFor(chain)
    await worker.follow(signal())
    assert.equal(await countOf('transactions'), 1)

    // The same transaction is mined again, one block later, on a different history.
    chain.reorg(4, 3, [[], [moved]])
    await worker.follow(signal())

    assert.equal(await countOf('transactions'), 1, 'one hash, one row — the primary key holds')
    const row = await sql<{ status: string; block_height: string }[]>`
      select status, block_height from transactions
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and hash = ${moved.hash!}
    `
    assert.equal(row[0]?.status, 'success')
    assert.equal(row[0]?.block_height, '5', 'it now lives at its new height')

    const movements = await sql<{ status: string; block_height: string }[]>`
      select status, block_height from address_activity
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and direction = 'in'
    `
    assert.equal(movements.length, 1, 'one movement, corrected rather than doubled')
    assert.equal(movements[0]?.status, 'included')
    assert.equal(movements[0]?.block_height, '5')
    // Already announced once. A re-inclusion does not re-announce, because the consumer deduped
    // that event long ago; what it regains is a null confirmed_at.
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
  },
)

test('a reorg at or past the alarm depth halts the chain rather than repairing it', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(11) // heights 0..11
  const worker = workerFor(chain)
  await worker.follow(signal())

  // EMBER alarms at five. Rewriting from height 6 orphans six blocks.
  chain.reorg(6, 6)
  const outcome = await worker.follow(signal())

  assert.equal(outcome.reorgs[0]?.depth, 6)
  assert.equal(outcome.reorgs[0]?.alarming, true)
  assert.equal(outcome.halted, true)

  const checkpoint = await getCheckpoint(db(), SCOPE, TIP_STREAM)
  assert.equal(checkpoint?.halted, true)
  assert.match(checkpoint?.haltReason ?? '', /depth 6/)
  assert.equal(checkpoint?.height, 5, 'rewound to the common ancestor and stopped')

  // Nothing was re-indexed forward: the assumption the depth encodes has failed, and only an
  // operator may decide it has come back.
  assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5])

  const again = await worker.follow(signal())
  assert.equal(again.halted, true)
  assert.equal(again.blocksIndexed, 0)
  assert.equal(await countOf('reorgs'), 1, 'a halted chain does not re-detect its own reorg')
})

test('indexing the same range twice produces identical state and no second event', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(4)
  chain.append([{ from: ALICE, to: BOB, value: 5n }])
  chain.appendMany(2)

  await watchAddress(db(), SCOPE, BOB, null)
  const worker = workerFor(chain)
  await worker.follow(signal())

  const snapshot = async () => ({
    blocks: await sql<{ height: string; hash: string; status: string }[]>`
      select height, hash, status from blocks
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by height`,
    transactions: await sql<{ hash: string; status: string; block_height: string }[]>`
      select hash, status, block_height from transactions
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by hash`,
    activity: await sql<{ entry_key: string; amount: string; status: string }[]>`
      select entry_key, amount, status from address_activity
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by entry_key`,
    topics: await outboxTopics(),
  })
  const first = await snapshot()
  assert.equal(first.topics.length, 1)

  // Rewind the checkpoint to genesis and index the whole range again, exactly as a replay would.
  await sql`
    update checkpoints set height = 0, block_hash = ${chain.hashAt(0)}
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and stream = ${TIP_STREAM}
  `
  const outcome = await worker.follow(signal())
  assert.equal(outcome.blocksIndexed, 7, 'every block above genesis was re-read')
  assert.equal(outcome.reorgs.length, 0, 're-reading identical history is not a reorg')

  const second = await snapshot()
  assert.deepEqual(second, first, 'a replay is a no-op, not a duplicate')
})

test('a restart resumes from the checkpoint with no gap and no duplicate', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(9) // heights 0..9

  const first = workerFor(chain, { followBatchBlocks: 4 })
  const one = await first.follow(signal())
  assert.equal(one.blocksIndexed, 4)
  assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3])
  assert.equal(one.lag, 6)

  // A different worker instance, holding none of the first one's state: a restart.
  const second = workerFor(chain, { followBatchBlocks: 4 })
  await second.follow(signal())
  await second.follow(signal())

  const heights = await canonicalHeights()
  assert.deepEqual(heights, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'contiguous: no gap')
  assert.equal(new Set(heights).size, heights.length, 'no duplicate')
  assert.equal((await getCheckpoint(db(), SCOPE, TIP_STREAM))?.height, 9)
})

test('a provider outage mid-range pauses rather than leaving a gap', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(9)

  // The primary is dead throughout, so every call fails over. The secondary then fails from its
  // twelfth call onwards, which lands part way through the range.
  let broken = false
  const worker = workerFor(chain, {
    dead: true,
    fault: (_method, index) => (broken && index > 10 ? new Error('socket hang up') : null),
  })
  broken = true

  const outcome = await worker.follow(signal())
  assert.equal(outcome.providerUnavailable, true, 'reported, not thrown: a recurring job must live')
  const partial = await canonicalHeights()
  assert.ok(partial.length > 0 && partial.length < 10, `expected partial progress, got ${partial.length}`)
  assert.deepEqual(partial, [...Array(partial.length).keys()], 'contiguous as far as it got')
  assert.equal(
    (await getCheckpoint(db(), SCOPE, TIP_STREAM))?.height,
    partial[partial.length - 1],
    'the checkpoint is exactly as far as the rows go — that is what makes it a pause',
  )

  // The provider comes back and the range completes without a gap.
  broken = false
  const healthy = workerFor(chain)
  await healthy.follow(signal())
  assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

  await worker.persistHealth()
  const health = await sql<{ provider: string; state: string; total_failures: string }[]>`
    select provider, state, total_failures from provider_health
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by provider
  `
  assert.equal(health.length, 2)
  assert.equal(health[0]?.provider, 'primary')
  // Degraded rather than down, and that is the design working: once a provider is demoted the
  // pool stops calling it, so its failure count only grows on the ticks when the healthy one also
  // failed. A dead provider that is never called is not evidence of anything new.
  assert.equal(health[0]?.state, 'degraded')
  assert.ok(Number(health[0]?.total_failures) > 0)
})

test('a deposit is confirmed once, at the depth the pinned contract publishes', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(4)
  chain.append([{ from: ALICE, to: BOB, value: 9n }]) // height 5
  await watchAddress(db(), SCOPE, BOB, null)

  const worker = workerFor(chain)
  await worker.follow(signal())
  assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED], 'observed long before confirmed')

  // One short of EMBER's sixty: height 5 has 59 confirmations at tip 63.
  chain.appendMany(58)
  assert.equal(chain.tip, 63)
  await worker.follow(signal())
  assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])

  chain.appendMany(1)
  const outcome = await worker.follow(signal())
  assert.equal(outcome.confirmed, 1)
  assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED])

  // The payload is the point of the whole service: a real hash, a URN and an explorer link.
  const payload = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from outbox where topic = ${DEPOSIT_CONFIRMED}
  `
  const body = payload[0]?.payload ?? {}
  assert.equal(body['address'], BOB)
  assert.equal(body['amount'], '9')
  assert.equal(body['confirmations'], 60)
  assert.equal(body['requiredConfirmations'], 60)
  assert.match(String(body['txUrn']), /^cf:chain:ember:testnet:0x/)
  assert.match(String(body['explorerUrl']), /explorer\.cloudsforge\.online/)

  // And never twice.
  await worker.follow(signal())
  assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED])
})

test('backfill advances its own stream, resumes, and never touches the follower’s', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(20)

  // The follower starts near the tip, as a cold start does.
  const worker = workerFor(chain, { followBatchBlocks: 5, backfillBatchBlocks: 3 })
  await sql`
    insert into checkpoints (chain, network, stream, height, block_hash)
    values (${SCOPE.chain}, ${SCOPE.network}, ${TIP_STREAM}, 14, ${chain.hashAt(14)})
  `
  const stream = await ensureBackfill(db(), SCOPE, 0, 8)

  const first = await worker.backfill(signal())
  assert.equal(first.stream, stream)
  assert.equal(first.blocksIndexed, 3)
  assert.equal(first.complete, false)
  assert.equal((await getCheckpoint(db(), SCOPE, stream))?.height, 2)
  assert.equal(
    (await getCheckpoint(db(), SCOPE, TIP_STREAM))?.height,
    14,
    'the follower’s checkpoint is untouched — the whole point of a separate stream',
  )

  // It resumes rather than restarting.
  await worker.backfill(signal())
  await worker.backfill(signal())
  const last = await worker.backfill(signal())
  assert.equal(last.complete, true)
  assert.equal((await getCheckpoint(db(), SCOPE, stream))?.height, 8)
  assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5, 6, 7, 8])

  // A completed range is not picked up again.
  const done = await worker.backfill(signal())
  assert.equal(done.stream, null)
})

test('two runs over the same historical range produce identical rows', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(4)
  chain.append([{ from: ALICE, to: BOB, value: 11n }])
  chain.appendMany(3)

  const worker = workerFor(chain, { backfillBatchBlocks: 100 })
  await ensureBackfill(db(), SCOPE, 0, 8)
  await worker.backfill(signal())
  const first = await sql<{ hash: string; height: string; tx_count: number }[]>`
    select hash, height, tx_count from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by height`

  await sql`
    update checkpoints set height = null
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and stream <> ${TIP_STREAM}
  `
  await worker.backfill(signal())
  const second = await sql<{ hash: string; height: string; tx_count: number }[]>`
    select hash, height, tx_count from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by height`

  assert.deepEqual(second, first, 'backfill replay is deterministic')
  assert.equal(await countOf('address_activity'), 2)
})

test('the worker refuses a provider that serves a different chain', { skip }, async () => {
  const chain = new FakeChain({ chainId: 11155111 })
  const worker = workerFor(chain)
  await assert.rejects(
    () => worker.follow(signal()),
    /expects chain id 7412 but the provider answered 11155111/,
  )
  assert.equal(await countOf('blocks'), 0, 'not one block from the wrong chain')
})

test('a provider without eth_getBlockReceipts falls back per transaction', { skip }, async () => {
  const chain = new FakeChain({ supportsBlockReceipts: false })
  chain.append([{ from: ALICE, to: BOB, value: 3n }])
  const worker = workerFor(chain)
  await worker.follow(signal())

  assert.ok(chain.calls.includes('eth_getTransactionReceipt'))
  // Probed once, then remembered: probing per block wastes a round trip on every block.
  assert.equal(chain.calls.filter((c) => c === 'eth_getBlockReceipts').length, 1)
  assert.equal(await countOf('transactions', `and status = 'success'`), 1)
})
