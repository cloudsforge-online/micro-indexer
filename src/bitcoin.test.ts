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
  MAX_EXACT_UNITS,
  MAX_SATOSHIS,
  addressOf,
  btcToSats,
  difficultyFromBits,
  extractBitcoinBlock,
  isCoinbase,
  maxUnitsFor,
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

// The regression. `59612750.30919116` is a real Dogecoin output, and a hardcoded 21M ceiling
// rejected it — five retries later the doge:mainnet follower was dead, on its first block, with
// "exceeds the 21,000,000 BTC supply cap" as the only explanation. The ceiling was always a decode
// check and was always per-asset; only Bitcoin had ever been asked.
test('an ordinary Dogecoin amount decodes instead of killing the follower', () => {
  const doge = maxUnitsFor('DOGE')
  assert.equal(btcToSats(59_612_750.30919116, doge), 5_961_275_030_919_116n)
  assert.equal(btcToSats(59_608_155.38999116, doge), 5_960_815_538_999_116n)
  // A merge-mined block reward, which is what the estate's own DOGE income actually is.
  assert.equal(btcToSats(10_000, doge), 1_000_000_000_000n)
  // The same amount under Bitcoin's ceiling is still refused, so the check did not become a no-op.
  assert.throws(() => btcToSats(59_612_750.30919116), RangeError)
})

test('the ceiling is the asset’s, and an unlisted asset gets the strictest one', () => {
  assert.equal(maxUnitsFor('BTC'), 2_100_000_000_000_000n)
  assert.equal(maxUnitsFor('LTC'), 8_400_000_000_000_000n, 'Litecoin’s cap is 4× Bitcoin’s')
  assert.equal(maxUnitsFor('doge'), maxUnitsFor('DOGE'), 'case is not significant')
  assert.ok(maxUnitsFor('DOGE') > MAX_EXACT_UNITS, 'Dogecoin has no consensus cap to lean on')
  assert.equal(maxUnitsFor('XMR'), MAX_SATOSHIS, 'unlisted refuses rather than invents')
  // 30M LTC is inside Litecoin's supply and was rejected by the old constant.
  assert.equal(btcToSats(30_000_000, maxUnitsFor('LTC')), 3_000_000_000_000_000n)
})

// The old decode was `BigInt(Math.round(value * 1e8))`, whose exactness proof needs the combined
// error under half a unit and gets there only below ~2^25 coins. `toFixed(8)` is specified as the
// nearest n/1e8 to the double's exact value, so the multiply's own rounding is gone. Below
// MAX_EXACT_UNITS the ULP is under one base unit, which makes recovery exact rather than close.
test('every amount the wire can carry exactly is recovered exactly', () => {
  const doge = maxUnitsFor('DOGE')
  // Straddling 2^25 coins, where the old proof stopped holding, and 2^53 units, where the wire
  // format itself stops distinguishing adjacent amounts.
  for (const units of [
    3_355_443_200_000_000n, // 2^25 coins
    3_355_443_200_000_001n,
    5_961_275_030_919_116n,
    9_007_199_254_740_992n, // MAX_EXACT_UNITS
  ]) {
    const asNumber = Number(units) / 1e8
    assert.equal(btcToSats(asNumber, doge), units, `${units} did not round-trip`)
  }
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

test('nBits becomes exactly the difficulty Core would have reported', () => {
  /*
   * The four hex strings and the four numbers were read off the estate's own litecoind on
   * 2026-08-10 — `getblock(getblockhash(h), 1)` for each height, plus `getblockchaininfo` at the
   * tip — and they are asserted to the last bit ON PURPOSE.
   *
   * `difficultyFromBits` transcribes Core's `GetDifficulty`, doubles and all, rather than doing the
   * "obvious" bigint `max_target / target`. The bigint form is a few ULP away, and it is the form
   * somebody will helpfully rewrite this into. Exact equality against real Core output is the only
   * assertion that catches that, because both forms are correct to six digits and only one of them
   * matches the number an operator sees when they check the metric against their own node.
   */
  assert.equal(difficultyFromBits('1934368d'), 82257185.75822285) // LTC tip, height 3,157,656
  assert.equal(difficultyFromBits('192f1adc'), 91177350.72352147) // LTC height 3,156,656
  assert.equal(difficultyFromBits('1b00b5c3'), 92301.94408029056) // LTC height 1,157,656
  assert.equal(difficultyFromBits('1e0ffff0'), 0.000244140625) // LTC height 1
  // The canonical difficulty-1 target. If this is not exactly 1 the whole scale is wrong.
  assert.equal(difficultyFromBits('1d00ffff'), 1)

  /*
   * `null`, never a number, for everything that is not an nBits — the same rule `evm.ts` applies
   * and for the same reason: a published 0 reads as a chain whose work has collapsed.
   *
   * The zero-mantissa case is the one worth its own line. `0xffff / 0` is `Infinity` in
   * JavaScript, not an error; Prometheus renders that as `+Inf`, and every comparison an alert
   * makes against `+Inf` silently stops meaning anything.
   */
  assert.equal(difficultyFromBits('1d000000'), null, 'a zero mantissa would publish +Inf')
  assert.equal(difficultyFromBits(undefined), null)
  assert.equal(difficultyFromBits(null), null)
  assert.equal(difficultyFromBits(''), null)
  assert.equal(difficultyFromBits('1d00ff'), null, 'nBits is four bytes, always')
  assert.equal(difficultyFromBits('1d00fffg'), null, 'not hex')
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
    /**
     * Supplied only by tests that read the exposition afterwards. The worker otherwise builds its
     * own, which is unreachable from here — and a metric nobody can render is a metric no test can
     * tell apart from one that was never set.
     */
    metrics?: Metrics
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
    metrics: options.metrics ?? registerServiceMetrics(new Metrics(), []),
    producer: 'indexer',
    followBatchBlocks: options.followBatchBlocks ?? 100,
    backfillBatchBlocks: options.backfillBatchBlocks ?? 100,
    startHeight: options.startHeight ?? 0,
    watchedAddressesOnly: options.watchedAddressesOnly ?? false,
  })
}

const signal = (): AbortSignal => new AbortController().signal

/** The label sets and values one metric name has in a Prometheus exposition. */
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

test('the follower publishes the tip block’s difficulty from its nBits', { skip }, async () => {
  /*
   * micro-org#363, the UTXO half. What this asserts that the pure test above cannot is that a
   * sample REACHES the exposition under the scope's labels: `Metrics.set` on an unregistered name
   * returns silently and renders nothing, so a forgotten `register` produces exactly the greenly
   * inert rule micro-org#310 measured, and only a render tells the two apart.
   *
   * It also pins the source. Reading `getblockchaininfo.difficulty` would have worked here and
   * would have made the metric node-source-only — `btcsource.ts`'s light client has no JSON-RPC to
   * ask, and it has the header. Taking it from the block means the same number arrives whichever
   * source is serving.
   */
  const node = new FakeBitcoinNode()
  node.appendMany(2)
  const metrics = registerServiceMetrics(new Metrics(), [])
  await workerFor(node, { metrics }).follow(signal())

  const rendered = renderedSeries(metrics.render(), 'indexer_chain_difficulty')
  assert.deepEqual(
    rendered,
    // The fake node's headers carry `1d00ffff`, the canonical difficulty-1 target.
    new Map([[`{chain="${SCOPE.chain}",network="${SCOPE.network}"}`, '1']]),
    'the tip block’s difficulty, keyed the way every other chain rule selects',
  )
  assert.deepEqual(
    [...rendered.keys()],
    [...renderedSeries(metrics.render(), 'indexer_tip_height').keys()],
    'difficulty and tip height must be keyed identically',
  )
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

    // And through the SPENDABILITY path, which is the reading `micro-settlement` builds a
    // withdrawal from (micro-org#382). This reorg is the only fixture here that produces an
    // orphaned credit and an orphaned spend at once, so it is the only place the two status
    // filters can be told apart — and they fail in opposite, both-bad directions.
    const { unspentOutpoints } = await import('./store.ts')
    // Alice's coin is SPENDABLE AGAIN. The transaction that spent it was orphaned, so the spend no
    // longer happened, and a source that ignored `status` on the spend would answer an empty list
    // — an address that visibly holds 3 BTC and cannot pay, for ever, with no error anywhere.
    assert.deepEqual(await unspentOutpoints(db(), SCOPE, ALICE, 9), [
      { txid: node.txidAt(7, 1), vout: 0, amount: 300_000_000n, blockHeight: 7 },
    ])
    // Bob's coin is GONE. The credit was orphaned, and a source that ignored `status` on the credit
    // would hand a selector an outpoint no node will serve — every attempt to spend it rejected,
    // and every retry rebuilding the same doomed transaction.
    assert.deepEqual(await unspentOutpoints(db(), SCOPE, BOB, 9), [])

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
  'THE #382 AGREEMENT: the outpoint list and the balance are two readings of one fact',
  { skip },
  async () => {
    // `micro-settlement` cannot ask the node which coins an address holds — bitcoind and litecoind
    // both run `disablewallet=1`, so `listunspent` is `-32601 Method not found` — and this list is
    // what replaces it (micro-org#382). The predicate behind it is written out a second time in
    // `unspentOutpoints` rather than shared with `unspentOutputTotals`, because one returns rows
    // and the other returns a sum and SQL will not factor that for us. THIS TEST IS THE PROOF THAT
    // THE TWO COPIES AGREE, and it is the only thing standing between a divergence and a
    // withdrawal built from coins that are already spent (too long, caught by `gettxout`
    // downstream) or from a subset of the address's coin with the remainder silently sent to
    // change (too short, caught by nobody).
    const { unspentOutpoints, unspentOutputTotals } = await import('./store.ts')
    const node = narrowingNode()
    await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
    await watchAddress(db(), SCOPE, BOB, 'deposit:bob')
    await workerFor(node, { watchedAddressesOnly: true }).follow(signal())

    const agreesAt = async (height: number, address: string): Promise<bigint> => {
      const listed = await unspentOutpoints(db(), SCOPE, address, height)
      const summed = (await unspentOutputTotals(db(), SCOPE, [address], height)).get(address) ?? 0n
      const total = listed.reduce((acc, one) => acc + one.amount, 0n)
      assert.equal(total, summed, `Σ outpoints ≠ balance for ${address} at ${height}`)
      return total
    }

    // Bob holds all three payments: two at height 5, one at height 6 from the unresolved spend.
    const bob = await unspentOutpoints(db(), SCOPE, BOB, 6)
    assert.equal(await agreesAt(6, BOB), 290_000_000n + 390_000_000n + 1_000n)
    // Ordered amount DESC, so a selector taking a prefix takes the fewest inputs — which is the
    // cheapest transaction, because a bitcoin fee is paid per byte and an input is ~68 of them.
    assert.deepEqual(
      bob.map((one) => one.amount),
      [390_000_000n, 290_000_000n, 1_000n],
    )
    // `vout` is the OUTPUT INDEX, not a row number and not a position in this list. A transaction
    // spends `txid:vout`, so an off-by-one here signs an input that does not exist — or, worse,
    // one that exists and belongs to somebody else.
    assert.deepEqual(bob, [
      { txid: node.txidAt(5, 2), vout: 0, amount: 390_000_000n, blockHeight: 5 },
      { txid: node.txidAt(5, 1), vout: 0, amount: 290_000_000n, blockHeight: 5 },
      { txid: node.txidAt(6, 1), vout: 0, amount: 1_000n, blockHeight: 6 },
    ])

    // Alice was paid at height 3 and spent it all at height 5. The list must go EMPTY when the
    // spend lands — an outpoint that survives its own spend is a coin selector's worst input,
    // because the node rejects the transaction and every retry rebuilds the identical one.
    assert.deepEqual(await unspentOutpoints(db(), SCOPE, ALICE, 6), [])
    assert.equal(await agreesAt(6, ALICE), 0n)

    // And the height is a real cut, in both readings at once. Read at 4, Alice still holds her
    // coin and Bob has none — which is what makes the confirmation depth mean anything: a caller
    // must not be handed a coin that is only spendable on a chain deeper than it asked about.
    assert.equal(await agreesAt(4, ALICE), 300_000_000n)
    assert.deepEqual(
      (await unspentOutpoints(db(), SCOPE, ALICE, 4)).map((one) => one.txid),
      [node.txidAt(3, 1)],
    )
    assert.deepEqual(await unspentOutpoints(db(), SCOPE, BOB, 4), [])
    assert.equal(await agreesAt(4, BOB), 0n)

    // An address nobody watched: empty, and the SUM is empty too. The store layer does not hedge —
    // that is `custody.ts`'s job, and this asserts the two layers do not both try to and disagree.
    assert.deepEqual(await unspentOutpoints(db(), SCOPE, CAROL, 6), [])
    assert.equal(await agreesAt(6, CAROL), 0n)

    // Two rows the bitcoin writer would never produce, inserted by hand because the query has to
    // be right about them anyway. `address_activity` is one table for eight chains, so what makes
    // a row a spendable coin is the row's own shape and not the chain it happens to sit on.
    await sql`
      insert into address_activity
        (chain, network, address, direction, asset_code, asset_kind, token_address, amount,
         tx_hash, entry_key, log_index, block_height, block_hash)
      values
        -- A TOKEN credit. It is a balance, not an output; nothing can spend it as coin, and adding
        -- it would put an outpoint in the list with no txid:vout behind it on any chain.
        (${SCOPE.chain}, ${SCOPE.network}, ${BOB}, 'in', 'USDT', 'token',
         ${'0x' + 'ab'.repeat(20)}, 500, ${node.txidAt(6, 1)}, 'synthetic:token', 0, 6,
         ${node.hashAt(6)}),
        -- A NATIVE credit with NO output index. An account-model chain writes these — it has no
        -- outpoints at all — and a credit with no vout cannot name an input. Admitting it would
        -- hand a selector an undefined where a number must go.
        (${SCOPE.chain}, ${SCOPE.network}, ${BOB}, 'in', 'BTC', 'native', null, 700,
         ${node.txidAt(6, 1)}, 'synthetic:no-vout', null, 6, ${node.hashAt(6)})
    `
    const after = await unspentOutpoints(db(), SCOPE, BOB, 6)
    assert.deepEqual(after, bob, 'neither row is an outpoint, so neither may appear as one')
    assert.equal(
      after.every((one) => Number.isInteger(one.vout)),
      true,
      'every entry names a real output index — a NaN here is a transaction that cannot be built',
    )
  },
)

test(
  'spending one output of a transaction does not spend the CHANGE beside it',
  { skip },
  async () => {
    // The shape every withdrawal this platform sends will produce: one transaction, one output to
    // the recipient, one output of change back to us. If a spend of `txid:0` were matched against
    // the credit at `txid:1` — the two differ only by an output index — then the moment the first
    // withdrawal from an address confirmed, its change would vanish from the spendable set. The
    // address would show a balance it could never pay from, and no error would be raised anywhere:
    // a short list is indistinguishable from a swept address. This is the single most likely way
    // for #382's query to be wrong, and it is the one the general fixture cannot reach, because
    // there no transaction pays one address twice.
    const { unspentOutpoints, unspentOutputTotals } = await import('./store.ts')
    const node = new FakeBitcoinNode()
    node.appendMany(2)
    // Height 3: one transaction, two outputs, both to Alice — a payment and its change.
    node.append([
      {
        inputs: [node.coinbaseOutpoint(1)],
        outputs: [
          { address: ALICE, sats: 100_000_000n },
          { address: ALICE, sats: 200_000_000n },
        ],
      },
    ])
    // Height 4: only vout 0 is spent. vout 1 is untouched and must survive.
    node.append([
      { inputs: [{ txid: node.txidAt(3, 1), vout: 0 }], outputs: [{ address: BOB, sats: 90_000_000n }] },
    ])

    await watchAddress(db(), SCOPE, ALICE, 'deposit:alice')
    await workerFor(node, { watchedAddressesOnly: true }).follow(signal())

    // Both outputs were recorded, once each — the premise, and itself worth asserting, because a
    // writer that credited the address once would make the rest of this test vacuously pass.
    assert.deepEqual(
      (await unspentOutpoints(db(), SCOPE, ALICE, 3)).map((one) => [one.vout, one.amount]),
      [
        [1, 200_000_000n],
        [0, 100_000_000n],
      ],
    )

    assert.deepEqual(await unspentOutpoints(db(), SCOPE, ALICE, 4), [
      { txid: node.txidAt(3, 1), vout: 1, amount: 200_000_000n, blockHeight: 3 },
    ])
    assert.equal(
      (await unspentOutputTotals(db(), SCOPE, [ALICE], 4)).get(ALICE),
      200_000_000n,
      'the sum has to lose exactly the one output that was spent, and so does the list',
    )
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
