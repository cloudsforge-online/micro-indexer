import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { PARTIAL_DETAIL_KEY } from './btcsource.ts'
import type { ChainScope } from './chains.ts'
import {
  ERC20_TRANSFER_TOPIC,
  EvmWorker,
  addressFromTopic,
  difficultyGaugeValue,
  minerWindowStats,
  extractBlock,
  hexToBigInt,
  hexToNumber,
} from './evm.ts'
import { FakeChain, deadClient, fakeClient, type TxSpec } from './fakechain.ts'
import { registerServiceMetrics } from './metrics.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import { verifyDelivery } from '@cloudsforge/contracts-events'
import {
  DEPOSIT_CONFIRMED,
  DEPOSIT_OBSERVED,
  buildEnvelope,
  signEvent,
  type Db,
  type OutboxRow,
} from './outbox.ts'
import { KEYED_BY, envelopeDefects } from './topics.ts'
import { postgresReadStore } from './reads.ts'
import { RpcPool } from './rpc.ts'
import { TIP_STREAM, ensureBackfill, getCheckpoint, watchAddress } from './store.ts'

/* ------------------------------------------------------------------ pure, no database */

const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'
const TOKEN = '0x3333333333333333333333333333333333333333'
/** An address that never appears on the fake chain — so nothing about it was ever recorded. */
const CAROL = '0x4444444444444444444444444444444444444444'

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

test('the miner window reads dominance and the easement signature, and nothing else', () => {
  // Newest first, exactly as minerWindow returns it. The shape of the 2026-08-12 measurement:
  // one tab holding 15 of 16 blocks, difficulty ~0x36xx throughout.
  const tab = '0xd8e8e0ed392d57d9d57da146856cfab7835bf294'
  const server = '0x2098b519aaf94e704534c6de35c5c516723dcca8'
  const rows = Array.from({ length: 16 }, (_, i) => ({
    height: 20438 - i,
    miner: i === 7 ? server : tab,
    difficulty: '0x36d3',
  }))
  const stats = minerWindowStats(rows)
  assert.ok(stats)
  assert.equal(stats.dominantShare, 15 / 16)
  assert.equal(stats.easedBlocks, 0, 'flat difficulty is not an easement')

  // The hearth#13 cliff: 0x36d3 (14,035) to 0x100 (256) in ONE step — a 54x drop no LWMA step
  // can produce (one sample is ~3% of a 60-block window). The child is the EASED block.
  const eased = minerWindowStats([
    { height: 3, miner: server, difficulty: '0x100' },
    { height: 2, miner: tab, difficulty: '0x36d3' },
    { height: 1, miner: tab, difficulty: '0x36a0' },
  ])
  assert.ok(eased)
  assert.equal(eased.easedBlocks, 1)

  // An honest LWMA slide of the same total size, spread over steps each under 4x, counts nothing:
  // the detector reads the CLIFF, not the destination.
  const slide = minerWindowStats([
    { height: 4, miner: tab, difficulty: '0x100' },   // 256
    { height: 3, miner: tab, difficulty: '0x300' },   // 768  (3x step)
    { height: 2, miner: tab, difficulty: '0x900' },   // 2304 (3x step)
    { height: 1, miner: tab, difficulty: '0x1b00' },  // 6912 (3x step)
  ])
  assert.ok(slide)
  assert.equal(slide.easedBlocks, 0)

  // Attribution honesty: blocks with no miner stay in the denominator. Three blocks, one
  // attributable, must read 1/3 — never 1.0.
  const sparse = minerWindowStats([
    { height: 3, miner: tab, difficulty: null },
    { height: 2, miner: null, difficulty: null },
    { height: 1, miner: null, difficulty: null },
  ])
  assert.ok(sparse)
  assert.equal(sparse.dominantShare, 1 / 3)

  // A window too short to say anything says nothing — null, not a confident 1.0 from one block.
  assert.equal(minerWindowStats([{ height: 1, miner: tab, difficulty: '0x100' }]), null)
})

test('a difficulty gauge value is the block’s number, and null wherever there is not one', () => {
  // The two live readings micro-org#363 is about, taken from `cf-hearth-seed` on 2026-08-10 with
  // `eth_getBlockByNumber`. 0x100 is 256, the floor EMBER sat at for ~2,000 blocks; 0x1fd2 is the
  // 8,146 the browser-hashrate burst drove it to before the tab closed and the tip stopped for
  // nineteen minutes. Both are literal here so the alert's `== 256` is anchored to a measurement
  // rather than to arithmetic done in a comment.
  assert.equal(difficultyGaugeValue('0x100'), 256)
  assert.equal(difficultyGaugeValue('0x1fd2'), 8146)
  assert.equal(difficultyGaugeValue('100'), 256, 'the odd provider omits the 0x')

  // EVERY ONE OF THESE MUST BE `null` AND NOT `0`, and they are the reason this function exists.
  // `0` is a publishable gauge value: it renders, Prometheus stores it, and it reads on a
  // dashboard as a chain whose work has collapsed. Each of these is instead a chain that has no
  // difficulty to report, which is a series that must not exist at all.
  assert.equal(difficultyGaugeValue('0x0'), null, "Hearth's own genesis header, measured 2026-08-10")
  assert.equal(difficultyGaugeValue(undefined), null, 'the provider omitted the field')
  assert.equal(difficultyGaugeValue(null), null)
  assert.equal(difficultyGaugeValue(''), null)
  assert.equal(difficultyGaugeValue('0xzz'), null, 'not a quantity: we were told nothing')

  // Above 2^53 it rounds rather than throwing, unlike `hexToNumber`. Pre-merge Ethereum ran near
  // 1.5e16, and refusing to publish there would cost the metric on the chains it is most worth
  // having. Prometheus stores a float64 either way, so the rounding is the exposition format's and
  // not this line's.
  assert.equal(difficultyGaugeValue('0x2386f26fc10000'), 10_000_000_000_000_000)
  assert.throws(() => hexToNumber('0xffffffffffffffff'), RangeError, 'heights still refuse to round')
})

test('the stored header is every field the node sent, and the body is the only thing dropped', () => {
  // EMBER mainnet genesis, field for field, as `eth_getBlockByNumber("0x0", true)` answered
  // `https://rpc.cloudsforge.online` on 2026-08-12 — the block micro-org#395 was filed against, and
  // the one whose `stateRoot` is the empty-trie root and therefore the only proof that nobody was
  // allocated a balance before the first block was mined. Nineteen fields plus the body; the code
  // this replaced stored four of them.
  const raw = {
    number: '0x0',
    hash: '0x0bd75ff12fe407213d4b5e43fc10777e5c24ee0484d3ea07ed1fa3516289900b',
    parentHash: `0x${'0'.repeat(64)}`,
    nonce: '0x0000000000000000',
    sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
    logsBloom: `0x${'0'.repeat(512)}`,
    transactionsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    stateRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    receiptsRoot: '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    miner: `0x${'0'.repeat(40)}`,
    difficulty: '0x0',
    totalDifficulty: '0x0',
    // "hearth/7411" — the network name in the genesis extraData, which is what makes a cheaply
    // mined empty testnet block structurally invalid on mainnet.
    extraData: '0x6865617274682f37343131',
    size: '0x236',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    timestamp: '0x684ee180',
    mixHash: `0x${'0'.repeat(64)}`,
    transactions: [],
    uncles: [],
  }
  const detail = extractBlock(raw, new Map(), 'EMBER').block.detail

  // THE ASSERTION IS ON THE WHOLE KEY SET, not on `stateRoot`. A test that named the four or five
  // fields somebody cared about in 2026 is the same shape of mistake as the code it replaced: it
  // would pass unchanged the day a curated list came back and dropped `baseFeePerGas`.
  assert.deepEqual(
    Object.keys(detail).sort(),
    Object.keys(raw)
      .filter((key) => key !== 'transactions')
      .sort(),
    'every header field the node sent is stored, and only the body is left out',
  )
  for (const [key, value] of Object.entries(detail)) {
    assert.equal(value, raw[key as keyof typeof raw], `${key} was reinterpreted on the way in`)
  }

  // The body is rows in `transactions`, with receipts resolved. A second copy inside a jsonb column
  // would be the largest object this service handles, stored twice.
  assert.equal('transactions' in detail, false)

  // What the page exists to show. Named separately from the set assertion above because a reader
  // arriving from micro-org#395 is looking for this line and not for a `deepEqual`.
  assert.equal(
    detail['stateRoot'],
    '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421',
    'the canonical empty-trie root: genesis allocated nothing to anybody',
  )
})

test('a header field the node omits is absent rather than stored as null', () => {
  // The old code wrote `gasUsed: null` for a provider that did not send it, which is a claim that
  // the node answered and said nothing. Absence is the honest record of a field that never arrived,
  // and it is what lets `not jsonb_exists(detail, 'stateRoot')` in migration 10 find the blocks
  // this service narrowed rather than the blocks a provider was thin about.
  const raw = { number: '0x1', hash: '0xb', parentHash: '0xa', timestamp: '0x1' }
  const detail = extractBlock(raw, new Map(), 'EMBER').block.detail
  assert.deepEqual(Object.keys(detail).sort(), ['hash', 'number', 'parentHash', 'timestamp'])
  assert.equal('gasUsed' in detail, false)
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
    /**
     * Supplied only by tests that read the exposition afterwards. The worker otherwise builds its
     * own, which is unreachable from here — and a metric nobody can render is a metric no test can
     * tell apart from one that was never set.
     */
    metrics?: Metrics
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
    metrics: options.metrics ?? registerServiceMetrics(new Metrics(), []),
    producer: 'indexer',
    followBatchBlocks: options.followBatchBlocks ?? 100,
    backfillBatchBlocks: options.backfillBatchBlocks ?? 100,
    startHeight: 0,
  })
}

const signal = (): AbortSignal => new AbortController().signal

/**
 * The label sets and values one metric name has in a Prometheus exposition.
 *
 * Reading the RENDERED text rather than asking the `Metrics` object is the point: a registration
 * with no sample behind it still emits `# HELP` and `# TYPE`, so only the series lines distinguish
 * "published" from "declared" — which is the distinction micro-org#310 was about.
 */
function renderedSeries(text: string, name: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(`${name}{`)) continue
    const brace = line.indexOf('}')
    found.set(line.slice(name.length, brace + 1), line.slice(brace + 2))
  }
  return found
}

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
      metrics: registerServiceMetrics(new Metrics(), []),
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

/**
 * Stamp a range of already-walked blocks as recorded for watched addresses only.
 *
 * The marker is written by the Bitcoin source and read by `store.partialFromHeight`, and no EVM
 * writer produces it today — micro-org#281 says so plainly and calls the defect latent. That is
 * exactly why the state is manufactured here rather than driven through a worker: the thing under
 * test is the READ's refusal to sum a record that was never written for an address, and the read
 * cannot tell which family narrowed it. Waiting for an EVM writer to narrow first would leave the
 * refusal unproven until the day it is needed, on the read a token gate demotes from.
 *
 * `PARTIAL_DETAIL_KEY` is imported rather than spelled: `store.test.ts` already pins the writer and
 * the index to one spelling, and a third hardcoded copy here would be free to drift into a test
 * that passes because it marks a key nobody reads.
 */
async function recordWatchedOnlyFrom(height: number): Promise<void> {
  await sql`
    update blocks
       set detail = jsonb_set(detail, ${[PARTIAL_DETAIL_KEY]}, '"watched-addresses-only"'::jsonb, true)
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and height >= ${height}
  `
}

test(
  'a holdings read on a narrowed record says nobody wrote the address down, rather than nought',
  { skip },
  async () => {
    // micro-org#281. Every refusal the holdings read had was about BLOCKS, and a deployment that
    // records only watched addresses has all of them: it walks every block, stores every
    // transaction, and simply does not write `address_activity` for addresses it was not watching.
    // So coverage is complete, no refusal fires, the sum of nothing is nothing, and the read used
    // to hand back an empty holdings list — which is a nought with this service's authority behind
    // it for an address it never looked at.
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
    }
    chain.appendMany(9) //      heights 1..9, genesis is 0
    chain.append([transfer]) // height 10
    chain.appendMany(2) //      heights 11, 12

    await workerFor(chain).follow(signal())
    const reads = postgresReadStore(db())

    // While the record still holds every address, a nought IS an answer and stays one. This is the
    // case the fix must not break: an address with no movements over a complete record has a
    // derived balance of zero, and a gate is entitled to act on it.
    const whole = await reads.tokenBalances(SCOPE, CAROL, TOKEN, null)
    assert.equal(whole.coverage.complete, true)
    assert.equal(whole.balance, '0', 'a measured nought over a whole record')
    assert.equal(whole.unavailable, undefined)

    await recordWatchedOnlyFrom(6)

    const silent_ = await reads.tokenBalances(SCOPE, CAROL, TOKEN, null)
    // The same complete coverage as above, and this is the whole point: no existing refusal could
    // have fired here, because every block really is present and canonical.
    assert.equal(silent_.coverage.complete, true, 'the blocks are all there — only the rows are not')
    assert.equal(silent_.unavailable, 'address_not_watched')
    assert.equal(silent_.notWatchedFromHeight, 6, 'where the recorded set narrows')
    // ABSENT, not zero and not null — the same shape every other withheld balance takes, so a
    // consumer that already handles one handles this without being taught a new rule.
    assert.equal('balance' in silent_, false)
    assert.equal('balances' in silent_, false)

    // And it fires with rows on it. BOB was paid at height 10, above the boundary, so his stored
    // movements are whatever happened to be written rather than all of them; summing them is a
    // window total, which is the thing `coverage_incomplete` exists to refuse. The old read
    // answered 5000 here — a number that is right only by luck, because this record was narrowed
    // after the fact rather than while it was being walked.
    const windowed = await reads.tokenBalances(SCOPE, BOB, TOKEN, null)
    assert.equal(windowed.unavailable, 'address_not_watched')
    assert.equal('balance' in windowed, false)

    // Registering the address makes it answerable again, and the number that comes back is the one
    // the movements say. Nothing about the balance changed; what changed is that the record is now
    // this address's.
    await watchAddress(db(), SCOPE, BOB, null)
    const known = await reads.tokenBalances(SCOPE, BOB, TOKEN, null)
    assert.equal(known.unavailable, undefined)
    assert.equal(known.balance, '5000')
    assert.equal('notWatchedFromHeight' in known, false, 'set only alongside the refusal')
  },
)

test(
  'the holdings read and the activity read agree about whether an address was written down',
  { skip },
  async () => {
    // The two reads are built from the same `address_activity` rows, so the question has one true
    // answer, and a consumer holding both is entitled to see them agree. Before micro-org#281 only
    // `activity` asked it, and `explorer-web`'s address page had to pass the activity read's marker
    // into its holdings panel to cover the gap — a consumer correlating two resources to find out
    // whether one of them looked. They now share one predicate, and this is what says so.
    const chain = new FakeChain()
    chain.appendMany(4)
    await workerFor(chain).follow(signal())
    await recordWatchedOnlyFrom(2)

    const reads = postgresReadStore(db())
    for (const [address, watched] of [
      [CAROL, false],
      [BOB, true],
    ] as const) {
      if (watched) await watchAddress(db(), SCOPE, address, null)
      const page = await reads.activity(SCOPE, address, 50, null)
      const holdings = await reads.tokenBalances(SCOPE, address, TOKEN, null)
      assert.equal(
        page.incomplete?.reason ?? null,
        holdings.unavailable === 'address_not_watched' ? 'address_not_watched' : null,
        `the two reads disagree about ${address}`,
      )
      assert.equal(page.incomplete?.fromHeight ?? null, holdings.notWatchedFromHeight ?? null)
      assert.equal(page.incomplete === undefined, watched)
    }
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

  // The halt is a claim in the PRESENT TENSE, and a deployment that no longer follows this scope
  // is not making it. Measured on mainnet on 2026-08-10: `checkpoints` held an `ember:testnet` row
  // halted at height 87 on 2026-08-04 by a provider that had since been removed from
  // `INDEXER_CHAINS`, and `micro-network-site` rendered it to readers as "This chain is halted" —
  // six days after the last worker touched it. `custody.ts` had always refused such a scope with
  // `chain_not_followed`; this document had not asked.
  const stranger = postgresReadStore(db(), { has: () => false })
  const unfollowed = await stranger.status(SCOPE)
  assert.equal(unfollowed.followed, false)
  assert.equal(unfollowed.halted, false, 'not a live alarm — this process is not walking this chain')
  assert.equal(unfollowed.haltReason, null)
  // The row itself is untouched: it is the record of what happened on the day it happened.
  assert.equal((await getCheckpoint(db(), SCOPE, TIP_STREAM))?.halted, true)

  // And it is a live claim again the moment the scope is followed again.
  const follower = postgresReadStore(db(), { has: () => true })
  const followed = await follower.status(SCOPE)
  assert.equal(followed.followed, true)
  assert.equal(followed.halted, true)
  assert.match(followed.haltReason ?? '', /depth 6/)
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
  // The TESTNET host, because the URN one line above says testnet. This asserted
  // `explorer.cloudsforge.online` — the MAINNET host — and passed only because
  // @cloudsforge/contracts-chain published the mainnet URL for both environments. That was a real
  // defect (a testnet deposit's link opened the mainnet explorer, where the hash does not exist);
  // micro-contracts 326de9d fixed it, and this assertion, which had been encoding the bug, started
  // failing. Pinned to the exact host rather than loosened to a substring: a link that names the
  // wrong environment is the failure this line exists to catch.
  assert.equal(
    String(body['explorerUrl']),
    // Single-label, not `explorer.testnet.…`. The two-label form is DEAD: the estate's wildcard
    // certificate covers one label, so `<surface>.testnet.<apex>` never presented a valid chain and
    // every such host failed TLS. Testnet moved to `<surface>-testnet.<apex>` and the code followed;
    // this expectation did not, so it pinned a hostname that resolves to nothing and had been
    // failing CI on every commit since.
    `https://explorer-testnet.cloudsforge.online/#/tx/${String(body['txUrn']).replace(/^cf:chain:ember:testnet:/, '')}`,
  )

  /* ---------------------------------------------------------------------------------------------
   * **THE ROW THE REAL WORKER WROTE, THROUGH THE RELAY'S OWN BUILDER, INTO THE CONTRACT'S OWN
   * CLASSIFIER.** `topics.test.ts` runs this against a fixture row and is the guard; this runs it
   * against a row nothing in the test wrote by hand, which is what makes the fixture honest. It is
   * the check whose absence let four other services relay nothing but refusals for weeks — each
   * suite verified against its own fake bus, so an envelope no consumer could read looked perfect
   * from inside the producer.
   *
   * It is here rather than in `topics.test.ts` because a real outbox row only exists where a real
   * chain worker has run.
   * ------------------------------------------------------------------------------------------- */
  const stored = await sql<OutboxRow[]>`
    select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
      from outbox where topic = ${DEPOSIT_CONFIRMED}
  `
  const row = stored[0]
  assert.ok(row, 'the confirmed deposit wrote no outbox row')

  // The ordering partition, off the wire rather than off a regex over the emit site. Two movements
  // on one address stay in chain order; two addresses do not serialise against each other.
  assert.equal(row.key, `${SCOPE.chain}:${SCOPE.network}:${BOB}`)
  assert.equal(KEYED_BY[DEPOSIT_CONFIRMED], 'chain:network:address')

  // Both columns really are null on a real emit — which is why `buildEnvelope` has to map them, and
  // why a fixture that supplied them would be testing an envelope this service never produces.
  assert.equal(row.actor, null, 'a chain worker has no principal behind it')
  assert.equal(row.correlation_id, null, 'nor an inbound request')

  const built = buildEnvelope(row)
  assert.ok(built.ok, 'the relay would refuse the envelope it built from a real deposit')
  assert.deepEqual(
    envelopeDefects(JSON.parse(JSON.stringify(built.value))),
    [],
    'a real confirmed deposit would be refused at the envelope by every consumer in the estate',
  )
  assert.equal(built.value.version, '1.0', 'the wire version is "major.minor", never the stored integer')

  // And the delivery a subscriber receives verifies with the contract's verifier — the exact check
  // activity's ingest, notify's /ingest and settlement's inbound run.
  const wire = JSON.stringify(built.value)
  assert.equal(verifyDelivery(wire, signEvent(wire, 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'), ['K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4']).ok, true)

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

test('the tip stream publishes difficulty; a backfill deliberately does not', { skip }, async () => {
  /*
   * micro-org#363. `EmberDifficultyAtFloor` reads `indexer_chain_difficulty` and there was no such
   * name in the estate before this change, so what has to be asserted first is the thing that is
   * invisible in a code review: that a sample REACHES the exposition, under the label set the rule
   * selects on. `Metrics.set` on a name that was never registered is a silent no-op — it returns
   * without throwing and renders nothing — so a missing `register` produces exactly the greenly
   * inert rule micro-org#310 measured, and only a render can tell the two apart.
   */
  const chain = new FakeChain()
  chain.appendMany(3)

  /*
   * THE BACKFILL RUNS FIRST, ON ITS OWN REGISTRY, AND THIS ORDER IS THE ASSERTION. A backfill
   * walks history. EMBER spent roughly 2,000 blocks pinned at difficulty 256 before 2026-08-10, so
   * a backfill that published would hold this gauge at the floor — firing `EmberDifficultyAtFloor`
   * — while the live chain sat 32x above it. The gauge means "the tip", so a registry that has
   * only ever backfilled must have NO series at all, and it can only be shown to have none if
   * nothing followed before it.
   */
  const backfillOnly = registerServiceMetrics(new Metrics(), [])
  await ensureBackfill(db(), SCOPE, 0, 2)
  const backfilled = await workerFor(chain, {
    metrics: backfillOnly,
    backfillBatchBlocks: 100,
  }).backfill(signal())

  // The backfill did run. Without this the assertion below passes for the wrong reason, and goes
  // on passing if `backfill` is replaced with a no-op.
  assert.equal(backfilled.blocksIndexed, 3, 'the backfill must actually have walked the range')
  assert.equal(
    renderedSeries(backfillOnly.render(), 'indexer_chain_difficulty').size,
    0,
    'a backfill published a difficulty for a block that is not the tip',
  )

  const metrics = registerServiceMetrics(new Metrics(), [])
  await workerFor(chain, { metrics }).follow(signal())

  const rendered = renderedSeries(metrics.render(), 'indexer_chain_difficulty')
  assert.deepEqual(
    rendered,
    new Map([[`{chain="${SCOPE.chain}",network="${SCOPE.network}"}`, '1000']]),
    'the tip block’s difficulty, keyed the way every other chain rule selects',
  )
  // The same key as the tip height, spelled out rather than assumed: a dashboard that puts the two
  // on one panel, and any future rule that joins them, needs the label sets to be identical.
  assert.deepEqual(
    [...rendered.keys()],
    [...renderedSeries(metrics.render(), 'indexer_tip_height').keys()],
    'difficulty and tip height must be keyed identically',
  )
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

test('the whole header reaches the database and is served back', { skip }, async () => {
  const chain = new FakeChain()
  chain.appendMany(2)
  await workerFor(chain).follow(signal())

  const stored = await postgresReadStore(db()).block(SCOPE, 2)
  assert.ok(stored)

  // Compared against the node's own answer, key for key. Asserting a handful of names would let
  // the next curated list through as long as it kept the names this test happened to know.
  const served = chain.handle('eth_getBlockByNumber', ['0x2', true]) as Record<string, unknown>
  const header = Object.keys(served).filter((key) => key !== 'transactions')
  assert.deepEqual(Object.keys(stored.detail).sort(), header.sort())
  for (const key of header) {
    assert.equal(String(stored.detail[key]), String(served[key]), `${key} did not survive storage`)
  }
})

test('migration 10 enqueues a bounded re-walk of exactly the narrowed blocks', { skip }, async () => {
  /*
   * micro-org#395. The code fix serves the whole header for every block walked after it ships and
   * can do nothing for the blocks already stored — and `stateRoot` on block 0, the field a reader
   * comes to check, is by definition one of those. So the repair is a re-walk, and it is enqueued
   * as a `checkpoints` row because that is the row `ensureBackfill` writes and the backfill job
   * already drains.
   *
   * The migration's SQL is executed directly rather than through `migrate()`, which ran it once in
   * `before` against an empty `blocks`. That is the correct behaviour on a fresh database and also
   * the behaviour that proves nothing; what has to be asserted is what it does to a database that
   * HAS narrowed rows in it.
   */
  const migration = MIGRATIONS.find((m) => m.name === 'rewalk-narrowed-evm-headers')
  assert.ok(migration, 'the re-walk migration is gone; no estate ever gets its old headers back')

  const chain = new FakeChain()
  chain.appendMany(3)
  await workerFor(chain).follow(signal())

  // The old shape, written back over the first three blocks: the four fields `evm.ts` kept before
  // micro-org#395, and nothing else. Narrowing rows the follower has already written is the only
  // honest way to reach the state every live estate is actually in.
  await sql`
    update blocks
       set detail = jsonb_build_object('miner', detail->'miner', 'gasUsed', detail->'gasUsed',
                                       'gasLimit', detail->'gasLimit', 'difficulty', detail->'difficulty')
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and height <= 2
  `
  // A family this migration must leave alone. `bitcoin.ts` and `solana.ts` pick their header fields
  // from formats that are not one flat header, so they were never narrowed and re-walking them
  // would be cost with no repair behind it.
  await sql`
    insert into blocks (chain, network, height, hash, parent_hash, block_time, tx_count, detail)
    values ('sol', ${SCOPE.network}, 7, '0xsol', '0xp', now(), 0, ${sql.json({ parentSlot: 6 })})
  `

  await sql.unsafe(migration.up)

  const rows = await sql<{ chain: string; stream: string; lo: string; hi: string }[]>`
    select chain, stream, range_from as lo, range_to as hi from checkpoints
     where range_to is not null order by chain
  `
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [{ chain: SCOPE.chain, stream: 'backfill:0-2', lo: '0', hi: '2' }],
    'one range covering the narrow blocks only, and nothing at all for Solana',
  )

  // Draining it rewrites the headers, which is the only thing that makes the row worth writing.
  const before = await postgresReadStore(db()).block(SCOPE, 0)
  assert.equal(before?.detail['stateRoot'], undefined, 'the fixture must start without one')

  await workerFor(chain, { backfillBatchBlocks: 100 }).backfill(signal())

  const genesis = await postgresReadStore(db()).block(SCOPE, 0)
  const served = chain.handle('eth_getBlockByNumber', ['0x0', true]) as Record<string, unknown>
  assert.equal(
    genesis?.detail['stateRoot'],
    served['stateRoot'],
    'the block the ticket is about still has no state root after the re-walk',
  )

  // Idempotent: a migrator that runs twice, or an operator who pastes the statement, adds nothing.
  await sql.unsafe(migration.up)
  assert.equal(await countOf('checkpoints', 'and range_to is not null'), 1)
})
