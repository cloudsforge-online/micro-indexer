/**
 * THE LOOP, END TO END: a chain, this service's aggregate, an HTTP hop, and a real reconciliation
 * run in `micro-ledger` that freezes or does not freeze withdrawals as a result.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## Why this file exists in this repository
 *
 * Neither half of the defect could be seen from inside one repository. `ledger/src/reconcile.ts`
 * took an optional `indexerObservedTotal` and its whole test suite passed while no production
 * caller ever supplied one; this service served chain facts and nothing asked it for a solvency
 * number. The seam between them was the thing that was broken, and a seam is only testable by
 * driving both sides of it.
 *
 * So this test runs, for real and over real sockets:
 *
 *   1. a JSON-RPC node, on a real port, serving a deterministic EVM chain;
 *   2. this service's real `RpcPool`, real `rpcCustodyObserver` and real HTTP server;
 *   3. **the reference client** — the code `micro-ledger` must adopt, specified here so its
 *      properties are proved rather than described (see `observedTotalFor`);
 *   4. `micro-ledger`'s real `reconcileAsset`, against a real ledger database with migration 11's
 *      constraints live, producing real `reconciliation_runs` and `asset_freezes` rows.
 *
 * The chain is synthetic and that is stated rather than glossed: Hearth's mainnet has not launched
 * and there is no node to point at. Everything else — the pool, the depth arithmetic, the refusal
 * paths, the HTTP hop, the client's mapping, the ledger's transaction, its constraints and its
 * freeze — is the code that will run in production.
 *
 * ## What each case proves, and why the failures are the point
 *
 * A reconciliation that cannot fail is worthless — that is the whole finding this release came
 * from. So the happy path here is one test and the rest break one thing each:
 *
 *   * an unreadable address           → the aggregate refuses → ledger records `unavailable`
 *   * an unreachable indexer          → the client returns `undefined`, NEVER `0n`
 *   * a 200 whose body is not a total → the client returns `undefined`
 *   * a genuinely empty chain         → the ledger records an OBSERVED zero and still fails on it
 *
 * The last two are the pair that matters. `0n` and `undefined` reach `reconcileAsset` as different
 * questions — "the chain holds nothing" and "nobody could look" — and the database now enforces
 * the difference. A transport that collapsed them would put the original defect back at the layer
 * nobody was checking.
 *
 * ## Running it
 *
 * Both databases, both named `*test*`, and a `micro-ledger` checkout beside this one:
 *
 *     INDEXER_TEST_DATABASE_URL=... LEDGER_TEST_DATABASE_URL=... pnpm test
 *
 * `deploy/scripts/verify-chain-backing.sh` provisions both and runs exactly this file.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import type { Principal } from '@cloudsforge/auth'
import { rpcCustodyObserver } from './custody.ts'
import { registerServiceMetrics } from './metrics.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import type { Db } from './outbox.ts'
import { RpcPool } from './rpc.ts'
import { createServer } from './server.ts'
import type { ReadStore } from './reads.ts'
import type { TokenObserver } from './tokenstate.ts'
import { TIP_STREAM, setCheckpoint, upsertBlock, watchAddress } from './store.ts'

/* ------------------------------------------------------------------ gating */

/**
 * TWO preconditions, in the order they can be satisfied, and the skip names only the one that is
 * actually missing.
 *
 * ## Why the checkout is asked about FIRST, and why that is not a technicality
 *
 * This used to report `set INDEXER_TEST_DATABASE_URL and LEDGER_TEST_DATABASE_URL` for every
 * reason it could not run, and in the one place it runs most often that sentence is FALSE ADVICE.
 * The reusable service workflow checks out exactly two siblings — `micro-runtime` and
 * `micro-contracts` — so in CI `../../ledger/src` does not exist, `ledgerModule()` could not
 * import a thing, and setting both variables would change nothing at all. Somebody following that
 * instruction would provision two databases and get the same skip.
 *
 * It also cost a real run. `micro-org`'s service workflow fails a job whose output contains
 * `set <SERVICE>_TEST_DATABASE_URL`, because a database-backed suite that skips is a suite that
 * reports a pass for work it never did — fifteen services once went green that way. That guard is
 * right and it stays right: THIS SERVICE'S OWN database tests ran in that same job, all 205 of
 * them, against the Postgres the workflow provides. What tripped it was this cross-repository
 * file asking for a SECOND service's database, which no per-service job has or should have.
 *
 * So the DSN sentence is still here, unchanged, for the case it was written for — an estate
 * checkout with no databases provisioned — and it is no longer said about a checkout where the
 * databases are beside the point. `existsSync` on `reconcile.ts` specifically, not on the
 * directory: an empty `ledger/` from an interrupted clone is not a checkout.
 *
 * The seam itself is unchanged and still runs where it always has: `verify-chain-backing.sh` in
 * `micro-deploy` provisions both databases and invokes THIS FILE by path.
 */
const LEDGER_SRC = new URL('../../ledger/src/', import.meta.url)
const ledgerCheckedOut = existsSync(new URL('reconcile.ts', LEDGER_SRC))

const indexerUrl = process.env['INDEXER_TEST_DATABASE_URL']
const ledgerUrl = process.env['LEDGER_TEST_DATABASE_URL']
const databasesReady = Boolean(
  indexerUrl && /test/i.test(indexerUrl) && ledgerUrl && /test/i.test(ledgerUrl),
)
const enabled = ledgerCheckedOut && databasesReady
const skip = enabled
  ? false
  : ledgerCheckedOut
    ? 'set INDEXER_TEST_DATABASE_URL and LEDGER_TEST_DATABASE_URL (both names must contain "test")'
    : `micro-ledger is not checked out at ${LEDGER_SRC.pathname} — this seam drives both services, ` +
      'so no single-repository job can run it. deploy/scripts/verify-chain-backing.sh does.'

/**
 * `micro-ledger`'s own source, imported across the checkout at RUN TIME ONLY.
 *
 * ## Why the specifier is computed rather than written as a literal
 *
 * **Because `typeof import('../../ledger/src/reconcile.ts')` broke the estate's image build, and
 * it was this repository's own Dockerfile that said so.** `pnpm typecheck` runs inside the image;
 * the build context is this repository plus two named contexts for `runtime` and `contracts`, and
 * a sibling service's source is in none of them. A literal specifier is resolved by `tsc` whether
 * or not the import is dynamic, so eight `TS2307`s failed `indexer-migrate` — the container the
 * whole estate's schema depends on. Found by building it, which is the only way it could have
 * been found.
 *
 * A computed specifier is not resolved by `tsc`, so the types below are what this file knows about
 * `micro-ledger`, stated explicitly. That is a real cost and it is the smaller one: the alternative
 * was to copy `reconcileAsset` here, and testing a copy is the exact mistake that let a handler and
 * a schema disagree about the thing they both guarded. A drift between these declarations and
 * ledger's actual exports fails at run time, loudly, naming the missing export — which is the
 * failure this file exists to produce.
 *
 * `LEDGER_SRC` itself is declared above, beside the gate that asks whether it is there at all.
 */

/** Exactly the surface this file drives. Nothing here is inferred; all of it is asserted. */
interface LedgerReconcileResult {
  readonly observedSource: 'liability_sum' | 'indexer' | 'unavailable'
  readonly indexerObservedTotal: string | null
  readonly drift: string | null
  readonly status: string
  readonly froze: boolean
  readonly unfroze: boolean
}
interface LedgerReconcileInput {
  readonly assetCode: string
  readonly chain: string
  readonly network: 'mainnet' | 'testnet'
  readonly tolerance: Record<string, bigint>
  readonly producer: string
  readonly indexerObservedTotal?: bigint
}
interface LedgerModule {
  reconcileAsset(sql: unknown, input: LedgerReconcileInput): Promise<LedgerReconcileResult>
}
interface LedgerSupport {
  openDb(max?: number): import('postgres').Sql
  migrateTestDb(sql: import('postgres').Sql): Promise<void>
  resetLedger(sql: import('postgres').Sql): Promise<void>
  depositEntry(options: { amount: bigint; assetCode?: string }): unknown
}
interface LedgerEntries {
  postEntry(deps: { sql: unknown; producer: string }, request: unknown, fingerprint: string): Promise<unknown>
}
interface LedgerIdempotency {
  requestFingerprint(request: unknown): string
}

let ledger: LedgerModule
let support: LedgerSupport
let entries: LedgerEntries
let idempotency: LedgerIdempotency

/**
 * Import one of ledger's modules and prove it has the exports this file names.
 *
 * The check is the whole point of a computed specifier being acceptable: `tsc` cannot see across
 * the checkout, so this does at run time what it would have done at build time, and says which
 * export moved rather than failing later as `undefined is not a function`.
 */
async function ledgerModule<T>(file: string, exports: readonly string[]): Promise<T> {
  const loaded = (await import(`${LEDGER_SRC.href}${file}`)) as Record<string, unknown>
  for (const name of exports) {
    if (typeof loaded[name] !== 'function') {
      throw new Error(`micro-ledger's ${file} no longer exports a function named ${name}`)
    }
  }
  return loaded as T
}

/* ------------------------------------------------------------------ the chain */

const SCOPE = { chain: 'ember', network: 'testnet' } as const
const CONFIRMATIONS = 60
const HEAD = 100
const AT = HEAD - CONFIRMATIONS + 1

/** One EMBER, in wei. The units the ledger reconciles in. */
const ONE = 1_000_000_000_000_000_000n

const CUSTODY_ADDRESSES = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
]

const hashAt = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`

/**
 * What the node will say, and how it will misbehave. Every break in this file is a mutation of
 * this object rather than a stub swapped in, so the code under test is identical in every case.
 */
interface NodeState {
  balances: Map<string, bigint>
  /** Addresses the node refuses outright — a pruned state, a rate limit, a bad minute. */
  refuse: Set<string>
  /** A raw override, so a balance can be answered with something that is not a quantity. */
  raw: Map<string, unknown>
  requests: string[]
}

let node: NodeState
let rpcServer: Server
let rpcUrl: string

function startNode(): Promise<void> {
  rpcServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: unknown
        method: string
        params?: unknown[]
      }
      node.requests.push(body.method)
      const reply = (result: unknown): void => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        })
        res.end(payload)
      }
      const refuse = (message: string): void => {
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message },
        })
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        })
        res.end(payload)
      }

      if (body.method === 'eth_chainId') return reply('0x1cf4')
      if (body.method === 'eth_getBlockByNumber') {
        const height = Number(String(body.params?.[0] ?? '0x0'))
        return reply(height >= 0 && height <= HEAD ? { hash: hashAt(height), number: String(body.params?.[0]) } : null)
      }
      if (body.method === 'eth_getBalance') {
        const address = String(body.params?.[0] ?? '').toLowerCase()
        if (node.refuse.has(address)) return refuse('missing trie node')
        if (node.raw.has(address)) return reply(node.raw.get(address))
        return reply(`0x${(node.balances.get(address) ?? 0n).toString(16)}`)
      }
      return refuse(`unexpected method ${body.method}`)
    })
  })
  return new Promise((resolve) => {
    rpcServer.listen(0, '127.0.0.1', () => {
      rpcUrl = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`
      resolve()
    })
  })
}

/* ------------------------------------------------------------------ this service, for real */

let sql: Db
let indexerServer: Server
let indexerBase: string

/** Neither is reached by the custody route. Present because `createServer` demands the whole shape. */
const unusedReads = new Proxy({} as ReadStore, {
  get() {
    return () => {
      throw new Error('this test drives only the custody route')
    }
  },
})
const unusedTokens: TokenObserver = {
  observe() {
    throw new Error('this test drives only the custody route')
  },
}

const LEDGER_PRINCIPAL: Principal = {
  kind: 'service',
  service: 'ledger',
  scopes: ['indexer:read'],
}

/* ------------------------------------------------------------------ THE REFERENCE CLIENT */

/**
 * **The client `micro-ledger` must adopt, and the one rule it exists to hold:
 * UNREACHABLE ARRIVES AS `undefined`, NEVER AS `0n`.**
 *
 * `micro-deploy` owns the URL and the timeout; this owns what happens to every answer that is not
 * a total. There is exactly one path that returns a number, and it requires all of:
 *
 *   * a 200 — every refusal on that route is a 501 or a 503 with a code, and the codes are the
 *     operator's diagnosis, not a fallback signal;
 *   * a body whose `total` is a **string** — a JSON number has already lost the low digits of an
 *     18-decimal balance by the time it is parsed, and those digits are exactly where a
 *     reconciliation drift lives;
 *   * a string that is a non-negative decimal integer. `BigInt('')` is `0n`, which is how an empty
 *     answer becomes a confident statement that the chain holds nothing.
 *
 * Everything else — a timeout, a refused connection, DNS, a 401 from a missing grant, a 503 from a
 * halted chain, a body that does not parse — is `undefined`. `reconcileAsset` then records
 * `unavailable` / `failed`, which freezes the asset. **That is the correct outcome**: an asset
 * whose backing nobody can see is an asset nobody should be able to withdraw. What must never
 * happen is the other thing, and the other thing is one `?? 0n` away.
 *
 * Nothing is retried here. A retry inside the job would spend the lease on an outage; the job runs
 * again in fifteen minutes, and a freeze that lifts on the next clean observed run is the retry.
 */
export async function observedTotalFor(options: {
  baseUrl: string
  chain: string
  network: string
  timeoutMs: number
  token?: string
}): Promise<bigint | undefined> {
  const url = `${options.baseUrl}/v1/custody/${options.chain}/${options.network}/total`
  let response: Response
  try {
    response = await fetch(url, {
      headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
      // An absolute ceiling on the whole call. Without one, a provider holding the socket open
      // holds the reconciliation job's lease open with it.
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch {
    return undefined
  }
  if (response.status !== 200) return undefined
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null) return undefined
  const total = (body as { total?: unknown }).total
  // `typeof total === 'string'` FIRST. Without it a JSON number reaches `BigInt`, which accepts an
  // integral one and silently blesses a value that has already been rounded.
  if (typeof total !== 'string' || !/^(0|[1-9][0-9]*)$/.test(total)) return undefined
  return BigInt(total)
}

/* ------------------------------------------------------------------ setup */

before(async () => {
  if (!enabled) return
  ledger = await ledgerModule<LedgerModule>('reconcile.ts', ['reconcileAsset'])
  support = await ledgerModule<LedgerSupport>('testsupport.ts', [
    'openDb',
    'migrateTestDb',
    'resetLedger',
    'depositEntry',
  ])
  entries = await ledgerModule<LedgerEntries>('entries.ts', ['postEntry'])
  idempotency = await ledgerModule<LedgerIdempotency>('idempotency.ts', ['requestFingerprint'])

  const postgres = (await import('postgres')).default
  const { migrate } = await import('@cloudsforge/db')
  sql = postgres(indexerUrl!, { max: 4, onnotice: () => {} }) as unknown as Db
  await migrate(sql as never, MIGRATIONS, { service: 'indexer-chainbacking-test' })

  ledgerSql = support.openDb(4)
  await support.migrateTestDb(ledgerSql)

  node = { balances: new Map(), refuse: new Set(), raw: new Map(), requests: [] }
  await startNode()

  const pool = new RpcPool({
    scope: SCOPE,
    endpoints: [{ name: 'fake-hearth', url: rpcUrl }],
    deadlineMs: 4_000,
  })

  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 })
  indexerServer = createServer({
    lifecycle,
    logger: new Logger({ service: 'indexer-chainbacking', sink: () => {} }),
    metrics: registerServiceMetrics(registerHttpMetrics(new Metrics()), []),
    // The auth layer is proved by `server.test.ts` against the real `Verifier`'s error types. Here
    // it is stubbed so this file tests the seam it is named for rather than a JWKS.
    verifier: {
      async principal(token) {
        if (token === 'ledger') return LEDGER_PRINCIPAL
        throw new Error('unknown token')
      },
    },
    reads: unusedReads,
    tokens: unusedTokens,
    custody: rpcCustodyObserver({
      sql,
      callers: new Map([['ember:testnet', pool]]),
      labelPrefixes: ['deposit:', 'treasury:'],
      maxAddresses: 100,
      concurrency: 4,
    }),
  })
  await new Promise<void>((resolve) => indexerServer.listen(0, '127.0.0.1', () => resolve()))
  indexerBase = `http://127.0.0.1:${(indexerServer.address() as AddressInfo).port}`
  lifecycle.markReady()
})

let ledgerSql: import('postgres').Sql

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => indexerServer.close(() => resolve()))
  await new Promise<void>((resolve) => rpcServer.close(() => resolve()))
  await (sql as unknown as { end: (o: object) => Promise<void> }).end({ timeout: 5 })
  await ledgerSql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  for (const table of CHAIN_TABLES) await sql.unsafe(`truncate table ${table} cascade`)
  await support.resetLedger(ledgerSql)
  node.balances.clear()
  node.refuse.clear()
  node.raw.clear()
  node.requests.length = 0

  for (let height = 0; height <= HEAD; height += 1) {
    await upsertBlock(sql, SCOPE, {
      height,
      hash: hashAt(height),
      parentHash: height === 0 ? hashAt(0) : hashAt(height - 1),
      blockTime: new Date(1_700_000_000_000 + height * 15_000),
      txCount: 0,
      detail: {},
    })
  }
  await setCheckpoint(sql, SCOPE, TIP_STREAM, HEAD, hashAt(HEAD))
  for (const [index, address] of CUSTODY_ADDRESSES.entries()) {
    await watchAddress(sql, SCOPE, address, `deposit:u-${index}`)
  }
})

/* ------------------------------------------------------------------ driving both sides */

/** Credit EMBER into the ledger's custody asset account through the real posting path. */
async function credit(amount: bigint): Promise<void> {
  const request = support.depositEntry({ amount, assetCode: 'EMBER' })
  await entries.postEntry({ sql: ledgerSql, producer: 'ledger' }, request, idempotency.requestFingerprint(request))
}

/** The whole loop, in the order the scheduled job will run it. */
async function reconcile(): Promise<{
  observed: bigint | undefined
  result: LedgerReconcileResult
}> {
  const observed = await observedTotalFor({
    baseUrl: indexerBase,
    chain: 'ember',
    network: 'testnet',
    timeoutMs: 5_000,
    token: 'ledger',
  })
  const result = await ledger.reconcileAsset(ledgerSql, {
      assetCode: 'EMBER',
      chain: 'Hearth',
      network: 'testnet',
      tolerance: {},
      producer: 'ledger',
      // **The conditional spread, not `indexerObservedTotal: observed`.** `exactOptionalPropertyTypes`
      // aside, an explicitly-present `undefined` and an absent key are the same to
      // `reconcileAsset` — but writing it this way is what makes the absence deliberate at the
      // call site rather than a value that happened to be undefined.
    ...(observed === undefined ? {} : { indexerObservedTotal: observed }),
  })
  return { observed, result }
}

/** The row as the database actually holds it — the constraints are the thing being proved. */
async function lastRun(): Promise<{
  observed_source: string
  indexer_observed_total: string | null
  drift: string | null
  status: string
}> {
  const rows = await ledgerSql<
    { observed_source: string; indexer_observed_total: string | null; drift: string | null; status: string }[]
  >`
    select observed_source,
           indexer_observed_total::text as indexer_observed_total,
           drift::text as drift,
           status
      from reconciliation_runs order by started_at desc limit 1
  `
  return rows[0]!
}

async function frozen(): Promise<boolean> {
  const rows = await ledgerSql<{ n: string }[]>`
    select count(*)::text as n from asset_freezes where asset_code = 'EMBER'
  `
  return rows[0]!.n !== '0'
}

/* ------------------------------------------------------------------ the loop closes */

test('THE LOOP: a chain-backed reconciliation completes, and it is neither vacuous nor fabricated', { skip }, async () => {
  node.balances.set(CUSTODY_ADDRESSES[0]!, 4n * ONE)
  node.balances.set(CUSTODY_ADDRESSES[1]!, 2n * ONE)
  node.balances.set(CUSTODY_ADDRESSES[2]!, 1n * ONE)
  await credit(7n * ONE)

  const { observed, result } = await reconcile()

  assert.equal(observed, 7n * ONE)
  // NOT `liability_sum`. That branch compared this ledger against this ledger and was the only
  // branch any production run had ever taken.
  assert.equal(result.observedSource, 'indexer')
  assert.equal(result.status, 'clean')
  assert.equal(result.drift, '0')
  assert.equal(result.froze, false)
  assert.equal(await frozen(), false)

  const row = await lastRun()
  assert.equal(row.observed_source, 'indexer')
  assert.equal(row.indexer_observed_total, (7n * ONE).toString())
  assert.equal(row.status, 'clean')

  // And it really did read the chain at the confirmed depth, once per address, with the block hash
  // proved on either side of the reads.
  assert.equal(node.requests.filter((m) => m === 'eth_getBalance').length, 3)
  assert.equal(node.requests.filter((m) => m === 'eth_getBlockByNumber').length, 2)
})

test('a drift the chain can see freezes withdrawals, which no run in this service ever did', { skip }, async () => {
  // `convertCoinToEmber` in its observable form: the ledger believes it holds coin the chain does
  // not show. Under `liability_sum` this reported clean, for ever, because the fabrication moved
  // both of the ledger's own sides at once.
  node.balances.set(CUSTODY_ADDRESSES[0]!, 4n * ONE)
  await credit(7n * ONE)

  const { observed, result } = await reconcile()
  assert.equal(observed, 4n * ONE)
  assert.equal(result.observedSource, 'indexer')
  assert.equal(result.drift, (3n * ONE).toString())
  assert.equal(result.status, 'drift_exceeded')
  assert.equal(result.froze, true)
  assert.equal(await frozen(), true)
})

/* ------------------------------------------------------------------ breaking each guard */

test('BREAK 1 — one unreadable address withholds the total, and the ledger records it as unknown', { skip }, async () => {
  node.balances.set(CUSTODY_ADDRESSES[0]!, 4n * ONE)
  node.balances.set(CUSTODY_ADDRESSES[1]!, 2n * ONE)
  node.balances.set(CUSTODY_ADDRESSES[2]!, 1n * ONE)
  node.refuse.add(CUSTODY_ADDRESSES[2]!)
  await credit(7n * ONE)

  const { observed, result } = await reconcile()

  // The tempting answer was 6 EMBER — the two that answered. It is low, low is positive drift, and
  // positive drift freezes the asset on the strength of one RPC failure while asserting a number
  // that was never true.
  assert.equal(observed, undefined)
  assert.equal(result.observedSource, 'unavailable')
  assert.equal(result.status, 'failed')
  // NULL, not 0, in the column the database now constrains.
  assert.equal(result.indexerObservedTotal, null)
  assert.equal(result.drift, null)
  const row = await lastRun()
  assert.equal(row.indexer_observed_total, null)
  assert.equal(row.drift, null)
  assert.equal(row.status, 'failed')
  assert.equal(await frozen(), true)
})

test('BREAK 2 — an unreachable indexer arrives as undefined, never as 0n', { skip }, async () => {
  node.balances.set(CUSTODY_ADDRESSES[0]!, 7n * ONE)
  await credit(7n * ONE)

  // A port nothing listens on: the transport failure `micro-deploy`'s URL and timeout exist to
  // survive. If this returned `0n`, the ledger would record an observation of an empty chain and
  // a drift of the entire custody position — a fabricated number produced by a network fault.
  const dead = await observedTotalFor({
    baseUrl: 'http://127.0.0.1:1',
    chain: 'ember',
    network: 'testnet',
    timeoutMs: 1_000,
    token: 'ledger',
  })
  assert.equal(dead, undefined)
  assert.notEqual(dead, 0n)

  // A URL that resolves but never answers, so the DEADLINE is what ends the call rather than a
  // refused connection. Without an absolute ceiling this holds the job's lease open.
  const stalled = createHttpServer(() => {})
  await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', () => resolve()))
  const timedOut = await observedTotalFor({
    baseUrl: `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`,
    chain: 'ember',
    network: 'testnet',
    timeoutMs: 250,
    token: 'ledger',
  })
  stalled.closeAllConnections()
  await new Promise<void>((resolve) => stalled.close(() => resolve()))
  assert.equal(timedOut, undefined)

  // And a present credential that does not carry the grant. A 403 is a deploy mistake, and it must
  // freeze rather than report a number.
  const unauthorised = await observedTotalFor({
    baseUrl: indexerBase,
    chain: 'ember',
    network: 'testnet',
    timeoutMs: 2_000,
  })
  assert.equal(unauthorised, undefined)

  // Fed to the ledger, every one of those is the same recorded fact: nobody looked.
  const result = await ledger.reconcileAsset(ledgerSql, { assetCode: 'EMBER', chain: 'Hearth', network: 'testnet', tolerance: {}, producer: 'ledger' },
  )
  assert.equal(result.observedSource, 'unavailable')
  assert.equal(result.status, 'failed')
  assert.equal(result.indexerObservedTotal, null)
})

test('BREAK 3 — a 200 that is not a total is refused by the client, including a bare zero', { skip }, async () => {
  // An impostor on the far end of the URL: the right status, the wrong body. Each of these is a
  // shape that `BigInt(...)` or `Number(...)` would have accepted somewhere, and each would have
  // become an observation.
  const bodies: unknown[] = [
    { total: 0 },
    { total: 7000000000000000000 },
    { total: '' },
    { total: null },
    { total: '0x1a' },
    { total: '-1' },
    { total: '7e18' },
    { addresses: 3 },
    'not an object',
  ]
  for (const body of bodies) {
    const impostor = createHttpServer((_req, res) => {
      const payload = JSON.stringify(body)
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', () => resolve()))
    const observed = await observedTotalFor({
      baseUrl: `http://127.0.0.1:${(impostor.address() as AddressInfo).port}`,
      chain: 'ember',
      network: 'testnet',
      timeoutMs: 2_000,
    })
    await new Promise<void>((resolve) => impostor.close(() => resolve()))
    assert.equal(observed, undefined, `${JSON.stringify(body)} must not become a total`)
  }

  // And the one that IS a total still is, so the guard above is not simply refusing everything.
  const honest = createHttpServer((_req, res) => {
    const payload = JSON.stringify({ total: '7000000000000000000' })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  })
  await new Promise<void>((resolve) => honest.listen(0, '127.0.0.1', () => resolve()))
  const observed = await observedTotalFor({
    baseUrl: `http://127.0.0.1:${(honest.address() as AddressInfo).port}`,
    chain: 'ember',
    network: 'testnet',
    timeoutMs: 2_000,
  })
  await new Promise<void>((resolve) => honest.close(() => resolve()))
  assert.equal(observed, 7n * ONE)
})

test('BREAK 4 — a MEASURED zero is an observation, and it fails loudly instead of passing quietly', { skip }, async () => {
  // The distinction the whole release turns on. Every custody address answers, and every one holds
  // nothing: that is a real reading of a real chain and the ledger must accept it AS a reading —
  // then fail on it, because the ledger claims seven EMBER that the chain does not show.
  for (const address of CUSTODY_ADDRESSES) node.balances.set(address, 0n)
  await credit(7n * ONE)

  const { observed, result } = await reconcile()
  assert.equal(observed, 0n)
  assert.equal(result.observedSource, 'indexer')
  assert.equal(result.indexerObservedTotal, '0')
  assert.equal(result.drift, (7n * ONE).toString())
  assert.equal(result.status, 'drift_exceeded')
  assert.equal(await frozen(), true)

  // The row an operator reads distinguishes it from BREAK 1 at a glance: an observed zero and a
  // drift, versus two NULLs. Those are different mornings, and the schema keeps them different.
  const row = await lastRun()
  assert.equal(row.observed_source, 'indexer')
  assert.equal(row.indexer_observed_total, '0')
  assert.notEqual(row.drift, null)
})

test('BREAK 5 — an unobserved run can never LIFT a freeze a real observation set', { skip }, async () => {
  // The half of the original defect that did the damage. `clean` lifts a freeze, and a vacuous run
  // could always be clean, so the check that could not fail outranked the one that could.
  node.balances.set(CUSTODY_ADDRESSES[0]!, 4n * ONE)
  await credit(7n * ONE)
  assert.equal((await reconcile()).result.froze, true)
  assert.equal(await frozen(), true)

  // Now the indexer goes dark. The freeze must survive it.
  for (const address of CUSTODY_ADDRESSES) node.refuse.add(address)
  const dark = await reconcile()
  assert.equal(dark.observed, undefined)
  assert.equal(dark.result.status, 'failed')
  assert.equal(dark.result.unfroze, false)
  assert.equal(await frozen(), true)

  // Only an exactly-clean OBSERVED run lifts it.
  node.refuse.clear()
  node.balances.set(CUSTODY_ADDRESSES[0]!, 7n * ONE)
  const lifted = await reconcile()
  assert.equal(lifted.result.observedSource, 'indexer')
  assert.equal(lifted.result.status, 'clean')
  assert.equal(lifted.result.unfroze, true)
  assert.equal(await frozen(), false)
})
