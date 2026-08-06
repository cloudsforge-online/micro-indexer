/**
 * The integration test: index the real Hearth node.
 *
 * Everything else in this suite runs against a chain this repository invented, which is the only
 * way to test a reorganisation — you cannot ask a node to reorganise, and waiting for one is not a
 * test. What a fake chain cannot tell you is whether the worker's assumptions about a real
 * Ethereum JSON-RPC implementation hold: the exact field names, the hex encoding of a quantity,
 * whether `eth_getBlockReceipts` exists, and whether the block a node calls its tip is one it will
 * actually serve.
 *
 * So this reads the tip of the local Hearth testnet, indexes the last few blocks, and asserts the
 * three facts that would each be a silent disaster if wrong: the chain id is the one
 * `contracts-chain` publishes, the blocks chain to their parents, and the checkpoint advanced to
 * where the rows go.
 *
 * It skips cleanly when the node is unreachable — a developer without a local chain must get a
 * green suite that says why, not a red one. AD-07 calls Hearth "a first-class family, not a
 * special case", and this is what makes that claim checkable.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { chainSpec } from '@cloudsforge/contracts-chain'
import type { ChainScope } from './chains.ts'
import { EvmWorker, hexToNumber } from './evm.ts'
import { registerServiceMetrics } from './metrics.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import type { Db } from './outbox.ts'
import { postgresReadStore } from './reads.ts'
import { RpcPool } from './rpc.ts'
import { TIP_STREAM, getCheckpoint } from './store.ts'

const RPC_URL = process.env['INDEXER_HEARTH_RPC_URL'] ?? 'http://127.0.0.1:8545'
const DATABASE_URL = process.env['INDEXER_TEST_DATABASE_URL']

const SCOPE: ChainScope = { chain: 'ember', network: 'testnet' }
/** Small enough to be quick, large enough for the parent-hash chain to mean something. */
const WINDOW = 8

/**
 * Is a Hearth node answering?
 *
 * **A REFERENCED TIMER, NOT `AbortSignal.timeout`.** That helper's timer is `unref()`'d, so it
 * cannot fire once nothing else is holding the event loop open — and this call is `await`ed at
 * module scope, which means a probe that never settles hangs the whole file and takes the indexer
 * suite with it. `@cloudsforge/http` had the identical bug in its own DEADLINE
 * (`runtime/packages/http/src/index.ts`) and its comment records this as the FOURTH instance in
 * the estate; the rule it states is that `unref()` belongs on a timer nobody is waiting for, and
 * somebody is waiting for this one.
 *
 * The timer is cleared in `finally` so a fast answer does not keep the process alive for two
 * seconds afterwards, which is the opposite mistake and just as real.
 */
async function reachable(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

const nodeUp = await reachable()
const dbReady = Boolean(DATABASE_URL && /test/i.test(DATABASE_URL))
const skip = !nodeUp
  ? `no Hearth node at ${RPC_URL}`
  : !dbReady
    ? 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'
    : false

let sql: postgres.Sql
const db = (): Db => sql

before(async () => {
  if (skip) return
  sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} })
  await sql.unsafe(
    `drop table if exists ${CHAIN_TABLES.join(', ')}, outbox_deliveries, event_subscriptions,
     outbox, inbox, jobs, schema_migrations cascade`,
  )
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'indexer-test' })
})

after(async () => {
  if (skip) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (skip) return
  await sql.unsafe(`truncate ${CHAIN_TABLES.join(', ')}, outbox, inbox restart identity cascade`)
})

function poolAndWorker(startHeight: number): { pool: RpcPool; worker: EvmWorker } {
  // No `clientFor`: this goes through @cloudsforge/http for real, with its deadlines, its retry
  // policy and its circuit breaker, over a real socket.
  const pool = new RpcPool({
    scope: SCOPE,
    endpoints: [{ name: 'hearth-local', url: RPC_URL }],
    deadlineMs: 10_000,
  })
  return {
    pool,
    worker: new EvmWorker({
      sql: db(),
      scope: SCOPE,
      family: 'ember',
      rpc: pool,
      logger: new Logger({ service: 'indexer-test', sink: () => {} }),
      metrics: registerServiceMetrics(new Metrics()),
      producer: 'indexer',
      followBatchBlocks: WINDOW,
      backfillBatchBlocks: WINDOW,
      startHeight,
    }),
  }
}

test('the local node is the chain contracts-chain says it is', { skip }, async () => {
  const { worker, pool } = poolAndWorker(0)
  // Hearth testnet is 7412, mainnet 7411 — and this is the check that stops Sepolia being indexed
  // into the rows labelled ember:testnet, which is silent for as long as nobody looks.
  await worker.verifyIdentity(new AbortController().signal)
  const answered = hexToNumber(await pool.call<string>('eth_chainId'))
  assert.equal(answered, chainSpec('EMBER').chainId?.testnet)
  assert.equal(answered, 7412)
})

test('indexing the last blocks of the real chain chains them correctly', { skip }, async () => {
  const probe = new RpcPool({ scope: SCOPE, endpoints: [{ name: 'hearth-local', url: RPC_URL }] })
  const tip = hexToNumber(await probe.call<string>('eth_blockNumber'))
  assert.ok(tip > 0, 'the node has produced at least one block')

  const from = Math.max(0, tip - (WINDOW - 1))
  const { worker } = poolAndWorker(from)
  const outcome = await worker.follow(new AbortController().signal)

  assert.ok(outcome.tipHeight !== null && outcome.tipHeight >= tip)
  assert.ok(outcome.blocksIndexed > 0, 'nothing was indexed from a live chain')
  assert.equal(outcome.reorgs.length, 0)
  assert.equal(outcome.halted, false)

  const rows = await sql<{ height: string; hash: string; parent_hash: string }[]>`
    select height, hash, parent_hash from blocks
     where chain = ${SCOPE.chain} and network = ${SCOPE.network} and status <> 'orphaned'
     order by height
  `
  assert.ok(rows.length >= WINDOW - 1, `expected the window, got ${rows.length}`)
  for (let i = 1; i < rows.length; i++) {
    assert.equal(
      Number(rows[i]?.height),
      Number(rows[i - 1]?.height) + 1,
      'the indexed heights are not contiguous',
    )
    assert.equal(
      rows[i]?.parent_hash,
      rows[i - 1]?.hash,
      `block ${rows[i]?.height} does not chain to its parent`,
    )
    assert.match(rows[i]?.hash ?? '', /^0x[0-9a-f]{64}$/, 'a real 32-byte block hash')
  }

  // The checkpoint is exactly as far as the rows go, which is the property that makes a restart a
  // resume rather than a rescan.
  const checkpoint = await getCheckpoint(db(), SCOPE, TIP_STREAM)
  assert.equal(checkpoint?.height, Number(rows[rows.length - 1]?.height))
  assert.equal(checkpoint?.blockHash, rows[rows.length - 1]?.hash)
})

test('the read API answers about the real chain from what was indexed', { skip }, async () => {
  const probe = new RpcPool({ scope: SCOPE, endpoints: [{ name: 'hearth-local', url: RPC_URL }] })
  const tip = hexToNumber(await probe.call<string>('eth_blockNumber'))
  const { worker } = poolAndWorker(Math.max(0, tip - (WINDOW - 1)))
  await worker.follow(new AbortController().signal)
  await worker.persistHealth()

  const reads = postgresReadStore(db())
  const status = await reads.status(SCOPE)
  assert.equal(status.chain, 'ember')
  assert.equal(status.network, 'testnet')
  assert.equal(status.chainId, 7412)
  assert.equal(status.requiredConfirmations, 60)
  assert.equal(status.reorgAlarmDepth, 5)
  assert.ok((status.tipHeight ?? 0) >= tip)
  assert.ok((status.indexedHeight ?? 0) > 0)
  assert.equal(status.halted, false)
  assert.equal(status.providers[0]?.provider, 'hearth-local')
  assert.equal(status.providers[0]?.state, 'healthy')

  const block = await reads.block(SCOPE, status.indexedHeight!)
  assert.ok(block, 'the block the status route claims to have indexed must be readable')
  assert.match(block.hash, /^0x[0-9a-f]{64}$/)
  assert.equal(block.confirmations, 1, 'the tip block is its own first confirmation')
  // Family-specific header detail is an object a consumer can index into, not a quoted blob.
  assert.equal(typeof block.detail, 'object')
  assert.match(String(block.detail['miner']), /^0x[0-9a-f]{40}$/)
})
