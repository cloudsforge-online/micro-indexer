/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step below carries the reason it must precede the next; the ordering is the substance of
 * this file, and getting it wrong reproduces a defect the estate already has.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { familyOf, scopeKey } from './chains.ts'
import { SERVICE, env } from './env.ts'
import { BitcoinNetworkError, BitcoinWorker } from './bitcoin.ts'
import { SolanaClusterError, SolanaWorker } from './solana.ts'
import { ChainIdentityError, EvmWorker } from './evm.ts'
import { rpcCustodyObserver } from './custody.ts'
import { registerHandlers, recurringFor, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { CHAIN_HALTED, PROVIDER_FAILURES_TOTAL, registerServiceMetrics } from './metrics.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { postgresReadStore } from './reads.ts'
import { RpcPool } from './rpc.ts'
import { RpcUnavailableError } from './rpc.ts'
import { createServer } from './server.ts'
import { TIP_STREAM, getCheckpoint } from './store.ts'
import { rpcTokenObserver } from './tokenstate.ts'
import { stubWorker, type ChainWorker } from './worker.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable. Nothing below may run first, because every
//    step after this reads configuration and a half-built service that then exits is harder to
//    diagnose than one that never started.

// 2. Telemetry, before anything that can fail. The estate's boot failures are currently bare V8
//    stacks that the collector drops, so the only symptom is a container that exits instantly. A
//    logger that exists before the pool means the pool's failure is a structured, searchable,
//    redacted line.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  chains: env.chains.map((c) => scopeKey(c.scope)),
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does **not** migrate — the migrator job does, and it has already run
//    by the time a container starts. Failing here rather than serving is the point: a replica of
//    the new code answering requests against the old schema corrupts data quietly, whereas a
//    container that refuses to start is a deploy that visibly stops.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The workers, one per configured chain, before the Lifecycle because the readiness report and
//    the metric sampler both close over the set.
//
//    A family that is not built gets a `stubWorker` rather than being absent from the map. The
//    difference matters at three in the morning: an absent entry fails as `undefined is not a
//    function` on the first tick, whereas the stub fails with the family, the capability and the
//    phase it is waiting on.
const workers = new Map<string, ChainWorker>()
//    The same pools the workers follow with, kept so the read side can make a contract-state call.
//    ONE pool per chain, not two: a second pool would keep its own health, its own backoff and its
//    own breaker, so a provider this process had already demoted for the follower would still be
//    tried first by a page render — and `provider_health` would describe only half the traffic.
const pools = new Map<string, RpcPool>()
for (const chain of env.chains) {
  const family = familyOf(chain.scope.chain)
  const key = scopeKey(chain.scope)
  if (family !== 'evm' && family !== 'ember' && family !== 'bitcoin' && family !== 'solana') {
    workers.set(key, stubWorker(chain.scope, family))
    logger.warn('this family is stubbed in this build', { scope: key, family })
    continue
  }
  const pool = new RpcPool({
    scope: chain.scope,
    endpoints: chain.endpoints,
    deadlineMs: env.rpcDeadlineMs,
    onFailure: (provider) =>
      metrics.increment(PROVIDER_FAILURES_TOTAL, {
        chain: chain.scope.chain,
        network: chain.scope.network,
        provider,
      }),
  })
  pools.set(key, pool)
  //    One shared shape, four families, and the differences live inside the workers rather than
  //    here — `jobs.ts` and the read API still do not know which family they are driving.
  const common = {
    sql,
    scope: chain.scope,
    rpc: pool,
    logger: logger.child({ scope: key }),
    metrics,
    producer: SERVICE,
    followBatchBlocks: env.followBatchBlocks,
    backfillBatchBlocks: env.backfillBatchBlocks,
    startHeight: chain.startHeight,
  }
  workers.set(
    key,
    family === 'bitcoin'
      ? // Bitcoin-family only, and the asymmetry is the point: this is where the bytes are, and it
        // is the family whose read consumers are the platform's own money paths rather than
        // arbitrary-address lookups. See `env.ts` for the full argument.
        new BitcoinWorker({ ...common, watchedAddressesOnly: env.watchedAddressesOnly })
      : family === 'solana'
        ? new SolanaWorker(common)
        : new EvmWorker({ ...common, family }),
  )
}

// 6. Verify chain identity before anything is written.
//
//    Indexing Sepolia into the rows labelled `ember:testnet` is a mistake that is silent for as
//    long as nobody looks, so a mismatch is fatal at boot rather than a warning. A provider that
//    is merely unreachable is not: the worker verifies again on its first tick, and refusing to
//    start because a third party is having a bad minute is a self-inflicted outage.
for (const [key, worker] of workers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  timer.unref?.()
  try {
    await worker.verifyIdentity(controller.signal)
  } catch (err) {
    // Three errors, one meaning: the endpoint is not the chain this scope claims. EVM proves it
    // with a chain id, Bitcoin with `getblockchaininfo.chain` and Solana with a genesis hash, and
    // all three are fatal at boot rather than a warning — indexing one chain into another chain's
    // rows is silent for as long as nobody looks.
    if (
      err instanceof ChainIdentityError ||
      err instanceof BitcoinNetworkError ||
      err instanceof SolanaClusterError
    ) {
      logger.fatal('configured provider serves a different chain', { scope: key, err })
      await sql.end({ timeout: 5 }).catch(() => {})
      process.exit(1)
    }
    if (err instanceof RpcUnavailableError) {
      logger.warn('could not verify chain identity at boot; the worker will retry', {
        scope: key,
        err,
      })
    } else {
      logger.warn('chain identity check did not complete', { scope: key, err })
    }
  } finally {
    clearTimeout(timer)
  }
}

// 7. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`, so a balancer
//    that probes during boot is told the truth rather than a static `{ok:true}`.
//
//    A halted chain is deliberately NOT a readiness failure. Reads still answer, and the halt is
//    reported by `indexer_chain_halted` and by `/chains/:chain/:network/status`. Taking the
//    replica out of rotation would remove the only interface an operator has for looking at the
//    incident.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores
      // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
      // database is not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(
    // Soft. If identity is down this service still serves everything that does not need a fresh
    // key — and marking it hard means one identity blip removes every service in the estate from
    // its balancer at once, which is a cascade, not a safety measure.
    httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
  )

// 8. Routes. Constructed after the Lifecycle so the health handlers report real state, and after
//    the pool so the read store is real rather than a lazily-connected surprise on first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  reads: postgresReadStore(sql),
  // A chain in `INDEXER_CHAINS` whose family has no worker has no pool either, so the token route
  // answers 503 `chain_not_followed` for it rather than pretending. That is the same choice
  // `stubWorker` makes above and for the same reason: an absent map entry fails as `undefined is
  // not a function`, a present one fails with the chain it was asked about.
  tokens: rpcTokenObserver({ sql, callers: pools }),
  // The same pool map, for the same reason: one pool per chain, so a provider this process has
  // already demoted for the follower is not tried first by a solvency read. A scope with no pool
  // answers 503 `chain_not_followed`, which reaches the ledger as no observation at all — and an
  // asset with no observation freezes. That is the intended behaviour of an indexer replica that
  // does not follow the chain it was asked about; see `custody.ts`.
  custody: rpcCustodyObserver({
    sql,
    callers: pools,
    labelPrefixes: env.custodyLabelPrefixes,
    maxAddresses: env.custodyMaxAddresses,
    concurrency: env.custodyConcurrency,
  }),
  // Sampled at scrape time rather than on a timer. There is no `setInterval` in this repository,
  // and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
    for (const chain of env.chains) {
      const checkpoint = await getCheckpoint(sql, chain.scope, TIP_STREAM)
      metrics.set(CHAIN_HALTED, checkpoint?.halted ? 1 : 0, {
        chain: chain.scope.chain,
        network: chain.scope.network,
      })
    }
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that. Starting it after `listen()` would leave a window in which
//    the service takes requests it cannot follow up with background work.
const queue = new JobQueue(sql as unknown as JobsSql, {
  owner: env.instanceId,
  // A follow tick may index a whole batch of blocks, each with its own receipts round trip. The
  // default 60s lease is comfortable for the default batch of 25; raising the batch without
  // raising this is how two replicas end up following one chain.
  leaseMs: 120_000,
})
const recurring = recurringFor(env.chains.map((c) => c.scope))
const reschedule = rescheduleRecurring(queue, logger, recurring)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 500,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql,
  logger,
  metrics,
  signingSecret: env.outboxSigningSecret,
  workers,
})
await seedRecurring(queue, recurring)
runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//     balancer is allowed to send traffic. Flipping this before `listen()` would advertise a
//     replica that has no socket.
lifecycle.markReady()

// 12. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready, and the drain races the construction above.
//     Hooks run in reverse registration order, so the server closes first, then the runner stops
//     claiming and drains, then the pool closes with nothing left to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  // Twenty seconds is above one follow tick's worst case, so a drain lets the current batch
  // finish and commit rather than aborting it. Aborting would be safe — every block is its own
  // transaction — but it would leave the lease held until it expires.
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
