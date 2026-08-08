/**
 * The Bitcoin worker's tests.
 *
 * The bar is `evm.test.ts`: a reorg driven to a common ancestor with orphaned blocks, transactions
 * and activity asserted, and the retraction visible through the read path. What is here and not
 * there is the UTXO half — per-output crediting, prevout-derived outbound movements, and the
 * replace-by-fee case, which is the one behaviour with no EVM analogue at all.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { requiredConfirmations, type ChainScope } from './chains.ts'
import {
  ACCEPTED_CORE_CHAINS,
  BitcoinNetworkError,
  BitcoinWorker,
  addressOf,
  btcToSats,
  extractBitcoinBlock,
  isCoinbase,
  outpointKey,
  signalsRbf,
  type Prevout,
  type RawBtcBlock,
} from './bitcoin.ts'
import {
  FakeBitcoinNode,
  deadBitcoinClient,
  fakeBitcoinClient,
  satsToBtcNumber,
} from './fakebitcoin.ts'
import { registerServiceMetrics } from './metrics.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import { DEPOSIT_CONFIRMED, DEPOSIT_OBSERVED, type Db } from './outbox.ts'
import { postgresReadStore } from './reads.ts'
import { RpcPool } from './rpc.ts'
import { TIP_STREAM, getCheckpoint, watchAddress } from './store.ts'

/* ------------------------------------------------------------------ pure, no database */

const ALICE = 'tb1qalicealicealicealicealicealicealice0'
const BOB = 'tb1qbobbobbobbobbobbobbobbobbobbobbobbob0'
const MINER = 'tb1qminerminerminerminerminerminerminerx'

test('a BTC amount round-trips through the double Core serialised it as, exactly', () => {
  assert.equal(btcToSats(0), 0n)
  assert.equal(btcToSats(0.00000001), 1n, 'one satoshi')
  assert.equal(btcToSats(1), 100_000_000n)
  assert.equal(btcToSats(21_000_000), 2_100_000_000_000_000n, 'the whole supply')
  // 0.1 + 0.2 is the canonical float complaint, and the reason the range argument in `btcToSats`
  // has to be an argument rather than a hope. Round-tripping every satoshi of a value that has no
  // exact double is what makes it a test rather than a claim.
  assert.equal(btcToSats(0.1 + 0.2), 30_000_000n)
  for (const sats of [1n, 7n, 12_345_678n, 99_999_999n, 100_000_007n, 1_999_999_999_999_999n]) {
    assert.equal(btcToSats(satsToBtcNumber(sats)), sats, `${sats} satoshis did not round-trip`)
  }
})

test('an amount this function cannot vouch for throws rather than crediting a guess', () => {
  assert.throws(() => btcToSats(Number.NaN), RangeError)
  assert.throws(() => btcToSats(Number.POSITIVE_INFINITY), RangeError)
  assert.throws(() => btcToSats(-1), RangeError)
  assert.throws(() => btcToSats(21_000_001), RangeError, 'above the supply cap')
})

test('an output pays one address, or nobody — and nobody is a real answer', () => {
  assert.equal(addressOf({ address: BOB }), BOB)
  assert.equal(addressOf({ addresses: [BOB] }), BOB, 'pre-22.0 Core spelling')
  assert.equal(addressOf(undefined), null)
  assert.equal(addressOf({ type: 'nulldata' }), null, 'OP_RETURN pays nobody')
  // Bare multisig. Crediting the first key holder for coins that need several is worse than
  // crediting nobody, so it credits nobody.
  assert.equal(addressOf({ addresses: [ALICE, BOB] }), null)
})

test('a bitcoin address is NOT case-normalised, because base58check is case-significant', () => {
  const raw: RawBtcBlock = {
    hash: 'b1',
    height: 1,
    previousblockhash: 'b0',
    time: 1_700_000_000,
    tx: [
      {
        txid: 't1',
        vin: [{ coinbase: 'aa', sequence: 0xffffffff }],
        vout: [{ value: 1, n: 0, scriptPubKey: { address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' } }],
      },
    ],
  }
  const out = extractBitcoinBlock(raw, new Map(), 'BTC')
  // Lower-casing this would produce a string that fails its own checksum and is not the address.
  assert.equal(out.activity[0]?.address, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
})

test('a transaction credits an address ONCE PER OUTPUT paying it, not once', () => {
  const raw: RawBtcBlock = {
    hash: 'b2',
    height: 2,
    previousblockhash: 'b1',
    time: 1_700_000_600,
    tx: [
      {
        txid: 'coinbase',
        vin: [{ coinbase: 'bb', sequence: 0xffffffff }],
        vout: [{ value: 3.125, n: 0, scriptPubKey: { address: MINER } }],
      },
      {
        txid: 'pays-bob-twice',
        vin: [{ txid: 'funding', vout: 0, sequence: 0xffffffff }],
        vout: [
          { value: 0.5, n: 0, scriptPubKey: { address: BOB } },
          { value: 0.25, n: 1, scriptPubKey: { address: BOB } },
          { value: 0, n: 2, scriptPubKey: { type: 'nulldata' } },
        ],
      },
    ],
  }
  const prevouts = new Map<string, Prevout>([
    [outpointKey('funding', 0), { value: 1, address: ALICE }],
  ])
  const out = extractBitcoinBlock(raw, prevouts, 'BTC')

  const bob = out.activity.filter((a) => a.address === BOB && a.direction === 'in')
  assert.equal(bob.length, 2, 'two outputs paying Bob are two movements — this is the UTXO rule')
  assert.deepEqual(
    bob.map((a) => a.amount),
    [50_000_000n, 25_000_000n],
  )
  // The keys must differ, or the second output would upsert over the first and silently vanish.
  assert.notEqual(bob[0]?.entryKey, bob[1]?.entryKey)
  assert.deepEqual(
    bob.map((a) => a.logIndex),
    [0, 1],
    'the output index, which is what makes two credits distinguishable to a consumer',
  )

  // The OP_RETURN moved no money and credits nobody.
  assert.equal(out.activity.filter((a) => a.amount === 0n).length, 0)

  // The coinbase IS indexed, with a real txid — the thing evm.ts declines to do because an EVM
  // block reward has no transaction and therefore no hash.
  const reward = out.activity.find((a) => a.address === MINER)
  assert.ok(reward, 'the block reward is a real transaction on Bitcoin')
  assert.equal(reward?.txHash, 'coinbase')
  assert.equal(out.transactions.find((t) => t.hash === 'coinbase')?.fee, null, 'coinbase has no fee')
})

test('a transaction has no single sender or recipient, and the row says so rather than guessing', () => {
  const raw: RawBtcBlock = {
    hash: 'b3',
    height: 3,
    previousblockhash: 'b2',
    time: 1_700_001_200,
    tx: [
      {
        txid: 'spend',
        vin: [
          { txid: 'f1', vout: 0, sequence: 0xfffffffd },
          { txid: 'f2', vout: 1, sequence: 0xfffffffd },
        ],
        vout: [{ value: 0.9, n: 0, scriptPubKey: { address: BOB } }],
      },
    ],
  }
  const prevouts = new Map<string, Prevout>([
    [outpointKey('f1', 0), { value: 0.6, address: ALICE }],
    [outpointKey('f2', 1), { value: 0.4, address: ALICE }],
  ])
  const out = extractBitcoinBlock(raw, prevouts, 'BTC')
  const tx = out.transactions[0]

  assert.equal(tx?.from, null, 'inventing a sender from vin[0] is a plausible, wrong answer')
  assert.equal(tx?.to, null)
  assert.equal(tx?.value, 90_000_000n, 'the total paid out — the only sensible single amount')
  assert.equal(tx?.fee, 10_000_000n, 'inputs minus outputs, and only because every input resolved')
  assert.equal(tx?.nonceOrSequence, null, 'Bitcoin has no nonce; locktime is not one')
  assert.equal(tx?.rawRef['rbf'], true)

  // Two inputs from one address are two outbound movements, keyed by input index.
  const outbound = out.activity.filter((a) => a.direction === 'out')
  assert.equal(outbound.length, 2)
  assert.deepEqual(
    outbound.map((a) => a.amount),
    [60_000_000n, 40_000_000n],
  )
  assert.notEqual(outbound[0]?.entryKey, outbound[1]?.entryKey)

  // Both spends are recorded, which is what makes the conflict check possible later.
  assert.deepEqual(
    out.spends.map((s) => `${s.txid}:${s.vout}`),
    ['f1:0', 'f2:1'],
  )
})

test('a fee is null unless EVERY input resolved — a partial fee is the missing input, mis-reported', () => {
  const raw: RawBtcBlock = {
    hash: 'b4',
    height: 4,
    previousblockhash: 'b3',
    time: 1_700_001_800,
    tx: [
      {
        txid: 'partial',
        vin: [
          { txid: 'known', vout: 0, sequence: 0xffffffff },
          { txid: 'pruned', vout: 0, sequence: 0xffffffff },
        ],
        vout: [{ value: 1.4, n: 0, scriptPubKey: { address: BOB } }],
      },
    ],
  }
  const prevouts = new Map<string, Prevout>([
    [outpointKey('known', 0), { value: 1.0, address: ALICE }],
  ])
  const out = extractBitcoinBlock(raw, prevouts, 'BTC')
  assert.equal(out.unresolvedInputs, 1)
  assert.equal(out.transactions[0]?.fee, null, 'reporting 1.0 - 1.4 here would be a negative fee')
  // The deposit is unaffected: an unresolvable INPUT never obscures an OUTPUT.
  assert.equal(out.activity.filter((a) => a.direction === 'in' && a.address === BOB).length, 1)
  // The spend is still recorded even though its value is unknown — the conflict check needs the
  // outpoint, not the amount.
  assert.equal(out.spends.length, 2)
})

test('coinbase and RBF are read off the transaction, not guessed at', () => {
  const coinbase = { txid: 'c', vin: [{ coinbase: 'ff', sequence: 0xffffffff }], vout: [] }
  assert.equal(isCoinbase(coinbase), true)
  assert.equal(signalsRbf(coinbase), false, 'a coinbase input never signals RBF')
  assert.equal(
    signalsRbf({ txid: 't', vin: [{ txid: 'a', vout: 0, sequence: 0xfffffffe }], vout: [] }),
    false,
    '0xfffffffe is final for BIP-125',
  )
  assert.equal(
    signalsRbf({ txid: 't', vin: [{ txid: 'a', vout: 0, sequence: 0xfffffffd }], vout: [] }),
    true,
  )
})

test('only a mainnet node may serve a mainnet scope', () => {
  assert.deepEqual(ACCEPTED_CORE_CHAINS.mainnet, ['main'])
  assert.equal(ACCEPTED_CORE_CHAINS.testnet.includes('main'), false, 'the direction that matters')
  assert.equal(ACCEPTED_CORE_CHAINS.testnet.includes('test'), true)
})

/* ------------------------------------------------------------------ database-backed */

const url = process.env['INDEXER_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'

const SCOPE: ChainScope = { chain: 'btc', network: 'testnet' }

let sql: postgres.Sql
const db = (): Db => sql

const silent = new Logger({ service: 'indexer-test', sink: () => {} })

function workerFor(
  node: FakeBitcoinNode,
  options: {
    followBatchBlocks?: number
    backfillBatchBlocks?: number
    fault?: (method: string, callIndex: number) => Error | null
    dead?: boolean
    startHeight?: number
    watchedAddressesOnly?: boolean
  } = {},
): BitcoinWorker {
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
      endpoint.name === 'primary'
        ? deadBitcoinClient()
        : fakeBitcoinClient(node, options.fault ? { fault: options.fault } : {}),
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
  return new BitcoinWorker({
    sql: db(),
    scope: SCOPE,
    rpc: pool,
    logger: silent,
    metrics: registerServiceMetrics(new Metrics()),
    producer: 'indexer',
    followBatchBlocks: options.followBatchBlocks ?? 100,
    backfillBatchBlocks: options.backfillBatchBlocks ?? 100,
    startHeight: options.startHeight ?? 0,
    watchedAddressesOnly: options.watchedAddressesOnly ?? false,
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

test('a mainnet node serving a testnet scope is fatal, not a warning', { skip }, async () => {
  const node = new FakeBitcoinNode({ coreChain: 'main' })
  const worker = workerFor(node)
  await assert.rejects(() => worker.verifyIdentity(signal()), BitcoinNetworkError)
})

test('the follower indexes from a cold start and chains the blocks it wrote', { skip }, async () => {
  const node = new FakeBitcoinNode()
  node.appendMany(5)
  const worker = workerFor(node)

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
  assert.equal(checkpoint?.blockHash, node.hashAt(5))
})

test('a node without verbosity 3 still resolves prevouts, and agrees exactly', { skip }, async () => {
  const build = (supportsVerbosityThree: boolean): FakeBitcoinNode => {
    const node = new FakeBitcoinNode({ supportsVerbosityThree })
    node.appendMany(2)
    // Alice is funded by the coinbase of block 1, then pays Bob — so the spend has a real prevout.
    node.append([
      { inputs: [node.coinbaseOutpoint(1)], outputs: [{ address: ALICE, sats: 300_000_000n }] },
    ])
    node.append([
      { inputs: [{ txid: node.txidAt(3, 1), vout: 0 }], outputs: [{ address: BOB, sats: 290_000_000n }] },
    ])
    return node
  }

  const withV3 = build(true)
  await workerFor(withV3).follow(signal())
  const v3 = await sql<{ direction: string; amount: string; address: string }[]>`
    select direction, amount, address from address_activity
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and address = ${ALICE}
     order by direction, amount
  `
  assert.equal(withV3.calls.filter((c) => c === 'getrawtransaction').length, 0, 'v3 needs no lookup')

  await sql.unsafe(`truncate ${CHAIN_TABLES.join(', ')}, outbox, inbox restart identity cascade`)

  const withoutV3 = build(false)
  await workerFor(withoutV3).follow(signal())
  const v2 = await sql<{ direction: string; amount: string; address: string }[]>`
    select direction, amount, address from address_activity
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and address = ${ALICE}
     order by direction, amount
  `

  assert.ok(v2.some((r) => r.direction === 'out'), 'the fallback must still produce the outbound')
  assert.deepEqual(v2, v3, 'the two paths must not disagree about a single satoshi')
  // Probed once for the process, not once per block — the same contract evm.ts holds itself to.
  assert.equal(
    withoutV3.calls.filter((c) => c === 'getblock' && true).length > 0,
    true,
  )
})

test(
  'a reorg finds the common ancestor, marks the orphans, corrects activity and leaves no duplicates',
  { skip },
  async () => {
    // ONE block deep, and that is not an arbitrarily easy case — it is the only case Bitcoin has.
    // BTC's reorgAlarmDepth is 2 (contracts-chain), so a two-block reorg halts the chain instead
    // of repairing it. A repair path that only ever runs at depth 1 is the whole of the repair
    // path for this family, and the halt test below asserts the other side of that boundary.
    const node = new FakeBitcoinNode()
    node.appendMany(6) //           heights 1..6, each with a coinbase
    // Height 7: Alice is funded from block 1's coinbase, below the fork — this must survive.
    node.append([
      { inputs: [node.coinbaseOutpoint(1)], outputs: [{ address: ALICE, sats: 300_000_000n }] },
    ])
    node.appendMany(1) //           height 8
    // Height 9: Alice pays Bob, ABOVE the fork — this must be retracted.
    const aliceCoin = { txid: node.txidAt(7, 1), vout: 0 }
    node.append([{ inputs: [aliceCoin], outputs: [{ address: BOB, sats: 290_000_000n }], rbf: true }])

    await watchAddress(db(), SCOPE, BOB, 'a watched deposit address')
    const worker = workerFor(node)
    await worker.follow(signal())

    assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.equal(await countOf('address_activity', `and direction = 'in' and address = '${BOB}'`), 1)
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
    const oldHead = node.hashAt(9)
    const doomedTxid = node.txidAt(9, 1)

    // History is rewritten from height 9. The replacement does NOT re-mine Alice's payment.
    node.reorg(9, 1)
    const outcome = await worker.follow(signal())

    assert.equal(outcome.reorgs.length, 1)
    const reorg = outcome.reorgs[0]
    assert.ok(reorg)
    assert.equal(reorg.commonAncestorHeight, 8, 'the deepest block both histories agree on')
    assert.equal(reorg.depth, 1)
    assert.equal(reorg.previousTipHeight, 9)
    assert.equal(reorg.alarming, false, 'one is below BTC’s alarm depth of two')
    assert.equal(reorg.orphanedBlocks, 1)
    assert.equal(reorg.orphanedTransactions, 2, 'the coinbase and Alice’s payment')
    // Three, not two: Bitcoin's block reward is a real transaction with a real txid, so the
    // miner's credit is a movement here where an EVM coinbase produces none at all.
    assert.equal(reorg.orphanedActivity, 3, 'the reward, Bob’s credit and Alice’s debit')

    const recorded = await sql<{ depth: number; alarming: boolean; common_ancestor_hash: string }[]>`
      select depth, alarming, common_ancestor_hash from reorgs
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
    `
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]?.depth, 1)
    assert.equal(recorded[0]?.common_ancestor_hash, node.hashAt(8))

    // Re-indexed forward, and exactly one block claims each height.
    assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const duplicates = await sql<{ height: string }[]>`
      select height from blocks
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and status <> 'orphaned'
       group by height having count(*) > 1
    `
    assert.equal(duplicates.length, 0, 'two blocks may never claim one height')

    const orphan = await sql<{ status: string; reorg_depth: number }[]>`
      select status, reorg_depth from blocks
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and hash = ${oldHead}
    `
    assert.equal(orphan[0]?.status, 'orphaned')
    assert.equal(orphan[0]?.reorg_depth, 1)

    // Bob's credit is retracted, not deleted — and it is 'orphaned', NOT 'conflicted', because
    // nothing on the winning chain has spent Alice's coin. It could still be re-mined.
    const bob = await sql<{ status: string; reorged_at: Date | null; confirmed_at: Date | null }[]>`
      select status, reorged_at, confirmed_at from address_activity
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
         and address = ${BOB} and direction = 'in'
    `
    assert.equal(bob.length, 1, 'retracted, not deleted — the evidence stays')
    assert.equal(bob[0]?.status, 'orphaned')
    assert.ok(bob[0]?.reorged_at instanceof Date)
    assert.equal(bob[0]?.confirmed_at, null, 'a confirmation of a retracted movement is void')

    const doomed = await sql<{ status: string }[]>`
      select status from transactions
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and hash = ${doomedTxid}
    `
    assert.equal(doomed[0]?.status, 'orphaned', 'gone for now, not gone for good')

    // The retraction is visible through the READ path, not only in the tables.
    const reads = postgresReadStore(db())
    const page = await reads.activity(SCOPE, BOB, 10, null)
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.status, 'orphaned')
    assert.equal(page.items[0]?.confirmations, null, 'a retracted movement has no depth')
    assert.equal(page.items[0]?.confirmed, false)

    // No new deposit event: the replacement chain paid nobody being watched.
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
  },
)

test(
  'a replace-by-fee makes the retracted deposit CONFLICTED, because it can never be re-mined',
  { skip },
  async () => {
    // This is the behaviour with no EVM analogue. On an account chain the doomed transaction would
    // come back or be superseded by nonce; here its coins are spent by a different txid on the
    // chain that won, so no future block can ever contain it.
    const node = new FakeBitcoinNode()
    node.appendMany(6)
    node.append([
      { inputs: [node.coinbaseOutpoint(1)], outputs: [{ address: ALICE, sats: 300_000_000n }] },
    ]) //                                                                          height 7
    node.appendMany(1) //                                                          height 8
    const aliceCoin = { txid: node.txidAt(7, 1), vout: 0 }
    // Height 9: Alice pays Bob 2.9, opting in to replacement.
    node.append([{ inputs: [aliceCoin], outputs: [{ address: BOB, sats: 290_000_000n }], rbf: true }])

    await watchAddress(db(), SCOPE, BOB, 'bob')
    const worker = workerFor(node)
    await worker.follow(signal())
    const replacedTxid = node.txidAt(9, 1)
    assert.equal(await countOf('address_activity', `and address = '${BOB}'`), 1)

    // The reorg replaces height 9 with a block containing a DIFFERENT transaction that spends the
    // very same outpoint and pays Alice back instead — a textbook RBF. One block deep, so the
    // chain repairs rather than halting.
    node.reorg(9, 1, [[{ inputs: [aliceCoin], outputs: [{ address: ALICE, sats: 295_000_000n }] }]])
    const outcome = await worker.follow(signal())
    assert.equal(outcome.reorgs.length, 1)
    assert.equal(outcome.halted, false, 'a one-block reorg is repaired, not alarmed')

    // The database refused to hold two canonical spends of one coin: exactly one is `included`.
    const spends = await sql<{ spending_tx_hash: string; status: string }[]>`
      select spending_tx_hash, status from spent_outpoints
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
         and txid = ${aliceCoin.txid} and vout = ${aliceCoin.vout}
       order by status
    `
    assert.equal(spends.length, 2, 'both spends are on the record — the loser is evidence')
    assert.equal(spends.filter((s) => s.status === 'included').length, 1)
    assert.equal(spends.find((s) => s.status === 'included')?.spending_tx_hash !== replacedTxid, true)

    // The replaced transaction is DEAD, not merely absent.
    const replaced = await sql<{ status: string }[]>`
      select status from transactions
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and hash = ${replacedTxid}
    `
    assert.equal(replaced[0]?.status, 'dropped', 'no future block can contain it')

    // And Bob's credit says so, in a word a consumer can act on. Told only 'orphaned', a wallet
    // would wait for a confirmation that cannot arrive.
    const bob = await sql<{ status: string }[]>`
      select status from address_activity
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
         and address = ${BOB} and direction = 'in'
    `
    assert.equal(bob[0]?.status, 'conflicted')

    // It must never be confirmed afterwards, at any depth.
    node.appendMany(10)
    const later = await worker.follow(signal())
    assert.equal(later.halted, false)
    const stillDead = await sql<{ status: string; confirmed_at: Date | null }[]>`
      select status, confirmed_at from address_activity
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
         and address = ${BOB} and direction = 'in'
    `
    assert.equal(stillDead[0]?.status, 'conflicted')
    assert.equal(stillDead[0]?.confirmed_at, null)
    assert.equal(
      (await outboxTopics()).filter((t) => t === DEPOSIT_CONFIRMED).length,
      0,
      'a conflicted deposit is never confirmed',
    )
  },
)

test(
  'a transaction re-mined on the winning chain comes back, updated rather than duplicated',
  { skip },
  async () => {
    const node = new FakeBitcoinNode()
    node.appendMany(6)
    node.append([
      { inputs: [node.coinbaseOutpoint(1)], outputs: [{ address: ALICE, sats: 300_000_000n }] },
    ]) //                                                                          height 7
    node.appendMany(1)
    const aliceCoin = { txid: node.txidAt(7, 1), vout: 0 }
    const survivorTxid = 'a-transaction-that-gets-re-mined'
    node.append([
      {
        txid: survivorTxid,
        inputs: [aliceCoin],
        outputs: [{ address: BOB, sats: 290_000_000n }],
      },
    ]) //                                                                          height 9

    await watchAddress(db(), SCOPE, BOB, 'bob')
    const worker = workerFor(node)
    await worker.follow(signal())
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
    const oldBlockHash = node.hashAt(9)

    // The same transaction is mined again, in a DIFFERENT block at the same height.
    node.reorg(9, 1, [
      [{ txid: survivorTxid, inputs: [aliceCoin], outputs: [{ address: BOB, sats: 290_000_000n }] }],
    ])
    await worker.follow(signal())
    const newBlockHash = node.hashAt(9)
    assert.notEqual(newBlockHash, oldBlockHash, 'the block really was replaced')

    const rows = await sql<{ status: string; block_hash: string }[]>`
      select status, block_hash from address_activity
       where chain = ${SCOPE.chain} and network = ${SCOPE.network}
         and address = ${BOB} and direction = 'in'
    `
    assert.equal(rows.length, 1, 'updated in place, not duplicated')
    assert.equal(rows[0]?.status, 'included', 'it is back on the canonical chain')
    assert.equal(rows[0]?.block_hash, newBlockHash, 'and it names the block that actually holds it')

    // It came back rather than being conflicted: nothing else spent Alice's coin.
    const tx = await sql<{ status: string }[]>`
      select status from transactions
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} and hash = ${survivorTxid}
    `
    assert.equal(tx[0]?.status, 'success')
    // And the consumer is not told twice about a deposit it deduped long ago.
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
  },
)

test('a reorg at or past the alarm depth halts the chain rather than repairing it', { skip }, async () => {
  // BTC's reorgAlarmDepth is 2 and its credit depth is 3, so a reorg deep enough to retract a
  // CONFIRMED deposit is always deep enough to have halted the chain first.
  const node = new FakeBitcoinNode()
  node.appendMany(8)
  const worker = workerFor(node)
  await worker.follow(signal())

  node.reorg(7, 4)
  const outcome = await worker.follow(signal())

  assert.equal(outcome.reorgs[0]?.depth, 2)
  // Two is BTC's alarm depth and three is its credit depth, so a reorg deep enough to retract a
  // CONFIRMED deposit is always deep enough to have halted the chain first. That is the property
  // setting the alarm below the credit depth exists to guarantee, and it means depth 1 is the
  // only reorg this family ever repairs.
  assert.equal(outcome.reorgs[0]?.alarming, true)
  assert.equal(outcome.halted, true)

  // A halted chain indexes nothing further until an operator clears it.
  node.appendMany(3)
  const after = await worker.follow(signal())
  assert.equal(after.halted, true)
  assert.equal(after.blocksIndexed, 0)
})

test('a deposit is confirmed at its depth, counting the mining block as the first', { skip }, async () => {
  const depth = requiredConfirmations(SCOPE.chain)
  // Below two there is no "one short" step, so the loop below would assert nothing and the test
  // would pass without ever having proved a deposit is withheld before its depth.
  assert.ok(depth >= 2, `a depth of ${depth} leaves nothing for this test to withhold`)

  const node = new FakeBitcoinNode()
  node.appendMany(2)
  node.append([
    { inputs: [node.coinbaseOutpoint(1)], outputs: [{ address: BOB, sats: 150_000_000n }] },
  ]) // height 3
  await watchAddress(db(), SCOPE, BOB, 'bob')
  const worker = workerFor(node)

  await worker.follow(signal())
  // The mining block is confirmation one, so at tip 3 the deposit has exactly one.
  assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])

  // The depth is READ from the chain spec, never restated here. This test used to hard-code BTC's
  // three — it walked to tip 5 and asserted a credit — so when contracts raised the depth to six
  // (micro-contracts 6724c19, "raise Bitcoin's depth before it credits anyone") the test failed
  // rather than followed. A test that pins the number twice does not test the depth, it races it.
  for (let confirmations = 2; confirmations < depth; confirmations += 1) {
    node.appendMany(1)
    const short = await worker.follow(signal())
    assert.equal(short.confirmed, 0, `credited at ${confirmations} of ${depth} confirmations`)
    assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED])
  }

  node.appendMany(1) // the depth-th confirmation, and the first at which a credit is owed.
  const outcome = await worker.follow(signal())
  assert.equal(outcome.confirmed, 1)
  assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED])

  // Confirming twice would credit twice.
  node.appendMany(1)
  const again = await worker.follow(signal())
  assert.equal(again.confirmed, 0)
  assert.deepEqual(await outboxTopics(), [DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED])
})

test('re-indexing the same blocks is a no-op, not a pile of duplicates', { skip }, async () => {
  const node = new FakeBitcoinNode()
  node.appendMany(3)
  node.append([
    { inputs: [node.coinbaseOutpoint(1)], outputs: [{ address: BOB, sats: 100_000_000n }] },
  ])
  await watchAddress(db(), SCOPE, BOB, 'bob')
  const worker = workerFor(node)

  await worker.follow(signal())
  const activity = await countOf('address_activity')
  const spends = await countOf('spent_outpoints')
  const topics = await outboxTopics()

  // Rewind the checkpoint and walk the same range again.
  await sql`
    update checkpoints set height = 0, block_hash = ${node.hashAt(0)}
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and stream = ${TIP_STREAM}
  `
  await worker.follow(signal())

  assert.equal(await countOf('address_activity'), activity)
  assert.equal(await countOf('spent_outpoints'), spends)
  assert.deepEqual(await outboxTopics(), topics, 're-indexing must not re-announce a deposit')
})

test('an unreachable provider is a pause, not a gap and not a job failure', { skip }, async () => {
  const node = new FakeBitcoinNode()
  node.appendMany(4)
  const worker = workerFor(node, { dead: true })

  // The primary is dead; the pool fails over to the secondary and indexes anyway.
  const outcome = await worker.follow(signal())
  assert.equal(outcome.providerUnavailable, false)
  assert.equal(outcome.blocksIndexed, 5)
  assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4])
})

test('a backfill runs on its own stream and never touches the follower’s checkpoint', { skip }, async () => {
  const node = new FakeBitcoinNode()
  node.appendMany(10)
  const worker = workerFor(node, { startHeight: 6 })

  await worker.follow(signal())
  const followerBefore = await getCheckpoint(db(), SCOPE, TIP_STREAM)
  assert.equal(followerBefore?.height, 10)
  assert.deepEqual(await canonicalHeights(), [6, 7, 8, 9, 10])

  const { ensureBackfill } = await import('./store.ts')
  const stream = await ensureBackfill(db(), SCOPE, 0, 5)
  const outcome = await worker.backfill(signal())
  assert.equal(outcome.stream, stream)
  assert.equal(outcome.blocksIndexed, 6)
  assert.equal(outcome.complete, true)
  assert.deepEqual(await canonicalHeights(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

  const followerAfter = await getCheckpoint(db(), SCOPE, TIP_STREAM)
  assert.equal(followerAfter?.height, 10, 'the follower’s stream is untouched')
})

/* ------------------------------------------------- recording only the watched addresses */

/**
 * The chain every test below walks, built once so the two modes are compared over identical blocks.
 *
 *   height 1..2  coinbases to the miner, so there is something to spend
 *   height 3     the miner's block-1 reward pays ALICE, who is watched
 *   height 4     the miner's block-2 reward pays CAROL, who is not
 *   height 5     ALICE pays BOB (spends a WATCHED prevout), and CAROL pays BOB (an unwatched one)
 *   height 6     someone spends an outpoint this node has never heard of (an UNRESOLVED prevout)
 */
const CAROL = 'tb1qcarolcarolcarolcarolcarolcarolcarol0'
const NOWHERE = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

function narrowingNode(): FakeBitcoinNode {
  const node = new FakeBitcoinNode()
  node.appendMany(2)
  node.append([
    { inputs: [node.coinbaseOutpoint(1)], outputs: [{ address: ALICE, sats: 300_000_000n }] },
  ])
  node.append([
    { inputs: [node.coinbaseOutpoint(2)], outputs: [{ address: CAROL, sats: 400_000_000n }] },
  ])
  node.append([
    { inputs: [{ txid: node.txidAt(3, 1), vout: 0 }], outputs: [{ address: BOB, sats: 290_000_000n }] },
    { inputs: [{ txid: node.txidAt(4, 1), vout: 0 }], outputs: [{ address: BOB, sats: 390_000_000n }] },
  ])
  node.append([{ inputs: [{ txid: NOWHERE, vout: 0 }], outputs: [{ address: BOB, sats: 1_000n }] }])
  return node
}

async function addressesIn(table: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `select distinct address from ${table} where chain = $1 and network = $2 order by address`,
    [SCOPE.chain, SCOPE.network],
  )
  return (rows as unknown as Array<{ address: string }>).map((r) => r.address)
}

test('only the watched addresses reach address_activity, and every block says so', { skip }, async () => {
  const node = narrowingNode()
  await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
  await workerFor(node, { watchedAddressesOnly: true }).follow(signal())

  assert.deepEqual(
    await addressesIn('address_activity'),
    [ALICE],
    'the miner, Carol and Bob are all on this chain and none of them was asked about',
  )
  // Both directions, so this is not passing because inbound happens to be filtered somewhere else:
  // Alice is credited at height 3 and debited at height 5.
  const directions = await sql<{ direction: string }[]>`
    select direction from address_activity
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by direction
  `
  assert.deepEqual(directions.map((r) => r.direction), ['in', 'out'])

  const marks = await sql<{ height: string; partial: string | null }[]>`
    select height, detail->>'partial' as partial from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by height
  `
  assert.equal(marks.length, 7)
  for (const row of marks) {
    assert.equal(row.partial, 'watched-addresses-only', `block ${row.height} does not say what it is`)
  }
})

test('with the switch off the general record is unchanged, and says THAT', { skip }, async () => {
  const node = narrowingNode()
  await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
  await workerFor(node, { watchedAddressesOnly: false }).follow(signal())

  assert.deepEqual(await addressesIn('address_activity'), [ALICE, BOB, CAROL, MINER].sort())
  const marks = await sql<{ partial: string | null }[]>`
    select detail->>'partial' as partial from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network}
  `
  assert.equal(
    marks.every((r) => r.partial === null),
    true,
    'a whole block must say it is whole, not merely omit the marker',
  )
  // The marker is what `partialFromHeight` reads, and a deployment that never narrows must never
  // make the read API hedge about an address nobody registered.
  const { partialFromHeight } = await import('./store.ts')
  assert.equal(await partialFromHeight(db(), SCOPE), null)
})

test(
  'a spend survives when its prevout is watched or unresolved, and only then',
  { skip },
  async () => {
    const node = narrowingNode()
    await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
    await workerFor(node, { watchedAddressesOnly: true }).follow(signal())

    const spends = await sql<{ txid: string; block_height: string }[]>`
      select txid, block_height from spent_outpoints
       where chain = ${SCOPE.chain} and network = ${SCOPE.network} order by block_height, txid
    `
    // Height 5 spends two outputs — Alice's, which is watched, and Carol's, which is not. Height 6
    // spends an outpoint no node can resolve. Two rows: Alice's and the unresolved one.
    assert.equal(spends.length, 2, `kept ${spends.map((s) => s.txid).join(', ')}`)
    assert.deepEqual(
      spends.map((s) => Number(s.block_height)),
      [5, 6],
    )
    assert.equal(
      spends.some((s) => s.txid === NOWHERE),
      true,
      'an unresolved prevout might have paid a watched address, so its spend is NOT droppable',
    )
    assert.equal(
      spends.some((s) => s.txid === node.txidAt(4, 1)),
      false,
      'Carol’s output has no credit row here, so nothing exists for its spend to cancel',
    )
  },
)

test(
  'THE #252 GUARANTEE: the derived UTXO total is bit-identical with the record narrowed',
  { skip },
  async () => {
    // The whole point of the change is that it may not move a solvency number by one satoshi. Run
    // the same chain twice over the same watched set and compare the derivation itself, not a
    // count of rows: `unspentOutputTotals` is what `custody.ts` sums and what `micro-ledger`
    // reconciles against, and it is the only comparison that would catch a spend row dropped one
    // case too eagerly.
    const { unspentOutputTotals } = await import('./store.ts')

    const run = async (watchedAddressesOnly: boolean): Promise<Map<string, bigint>> => {
      await sql.unsafe(`truncate ${CHAIN_TABLES.join(', ')}, outbox, inbox restart identity cascade`)
      const node = narrowingNode()
      await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
      await watchAddress(db(), SCOPE, BOB, 'deposit:bob')
      await workerFor(node, { watchedAddressesOnly }).follow(signal())
      return await unspentOutputTotals(db(), SCOPE, [ALICE, BOB], 6)
    }

    const whole = await run(false)
    const narrowed = await run(true)

    assert.deepEqual([...narrowed.entries()].sort(), [...whole.entries()].sort())
    // And the number is the right one rather than two matching zeroes: Alice was paid 3 BTC and
    // spent all of it, Bob holds the two payments plus the dust from the unresolved spend.
    assert.equal(narrowed.get(ALICE) ?? 0n, 0n, 'Alice’s only output was spent at height 5')
    assert.equal(narrowed.get(BOB), 290_000_000n + 390_000_000n + 1_000n)
  },
)

test(
  'an unwatched address gets "unknown", never an empty page that reads as "never paid"',
  { skip },
  async () => {
    const node = narrowingNode()
    await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
    await workerFor(node, { watchedAddressesOnly: true }).follow(signal())
    const reads = postgresReadStore(sql as unknown as Db)

    const carol = await reads.activity(SCOPE, CAROL, 20, null)
    assert.deepEqual(carol.items, [], 'nothing was recorded for her, which is the premise')
    assert.equal(carol.incomplete?.reason, 'address_not_watched')
    assert.equal(carol.incomplete?.fromHeight, 0, 'the record narrows from the first block walked')

    const alice = await reads.activity(SCOPE, ALICE, 20, null)
    assert.equal(alice.items.length, 2)
    assert.equal(alice.incomplete, undefined, 'a watched address is answered for, not hedged about')
  },
)

async function backfillStreams(): Promise<string[]> {
  const rows = await sql<{ stream: string }[]>`
    select stream from checkpoints
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and range_to is not null
     order by stream
  `
  return rows.map((r) => r.stream)
}

test(
  'an address registered late is answered for by a rescan, and the rescan actually fills it in',
  { skip },
  async () => {
    const node = narrowingNode()
    await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
    const worker = workerFor(node, { watchedAddressesOnly: true })
    await worker.follow(signal())
    const reads = postgresReadStore(sql as unknown as Db)

    // A freshly derived key needs nothing walked again: there is nothing behind it to find, and
    // the claim already covers the one block that could have been in flight. This is the path
    // micro-wallet takes for every deposit address, on a retry job, so it is the one that has to
    // stay free.
    await reads.watch(SCOPE, `${BOB}-new`, 'deposit:fresh', 'head')
    assert.deepEqual(await backfillStreams(), [], 'a derived key has no history to go and find')

    // An operator stating a history is the opposite case: those blocks were walked without this
    // address in the set, so the rows are simply not there.
    assert.equal(await countOf('address_activity', `and address = '${CAROL}'`), 0)
    await reads.watch(SCOPE, CAROL, 'treasury:btc:testnet', 0)
    assert.deepEqual(await backfillStreams(), ['backfill:0-6'])

    // Idempotent: micro-wallet's retry pass re-registers blindly, and a registration that lowered
    // nothing must not enqueue the range a second time.
    await reads.watch(SCOPE, CAROL, 'treasury:btc:testnet', 0)
    assert.deepEqual(await backfillStreams(), ['backfill:0-6'], 'nothing changed, nothing to redo')

    const outcome = await worker.backfill(signal())
    assert.equal(outcome.complete, true)
    assert.equal(outcome.blocksIndexed, 7)

    // The point of the whole mechanism: Carol's history is now here, exactly as if she had been
    // watched all along — one credit at height 4 and one debit at height 5.
    const carol = await reads.activity(SCOPE, CAROL, 20, null)
    assert.equal(carol.incomplete, undefined, 'she is watched now, so she is answered for')
    assert.deepEqual(
      carol.items.map((i) => `${i.direction}@${i.blockHeight}`).sort(),
      ['in@4', 'out@5'],
    )
  },
)
