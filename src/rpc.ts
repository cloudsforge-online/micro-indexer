/**
 * A JSON-RPC pool with health tracking, failover and rate-limit backoff.
 *
 * The transport is `@cloudsforge/http`, which already has the three things a hand-rolled RPC
 * client always lacks: an absolute deadline across retries, a retry policy that refuses to retry
 * what must not be retried, and a per-upstream circuit breaker. The estate's current chain code
 * calls `fetchJson` with no breaker and no failover at all, so one slow provider is one stalled
 * deposit watcher for every user — see forge-pay `chains.ts`, which this service supersedes.
 *
 * What this file adds on top is the part that is specific to running against N providers for one
 * chain:
 *
 *   - **Ordering by health.** A provider that has just failed is tried last, not first, so a
 *     recovering endpoint does not cost every call a timeout before the working one is reached.
 *   - **Failover per call.** One `call` walks the ordered providers until one answers. A caller
 *     never sees which provider served it, because a follower that behaved differently depending
 *     on the provider would be a follower whose output depends on the weather.
 *   - **Rate-limit backoff is per provider, not per pool.** Being throttled by one endpoint says
 *     nothing about the others, and treating it as a general failure is how a pool with a healthy
 *     spare still stops indexing.
 *
 * ## Why `call` distinguishes two failures and the caller must too
 *
 * `RpcError` means a provider answered and said no — a bad parameter, an unknown method, a block
 * that does not exist. Retrying it against another provider produces the same answer.
 * `RpcUnavailableError` means nobody answered. The follower treats the second as "no progress this
 * tick" rather than as a job failure, deliberately: a recurring job that throws on an unreachable
 * provider burns its attempt budget and dead-letters, and then nothing follows the chain at all
 * even after the provider comes back. The durable record of the outage is `provider_health` and
 * `indexer_provider_failures_total`, not a dead job row.
 */

import { CircuitOpenError, HttpClient, HttpError, TimeoutError } from '@cloudsforge/http'
import type { ChainScope } from './chains.ts'
import type { ProviderHealthInput } from './store.ts'

export interface RpcEndpoint {
  readonly name: string
  readonly url: string
}

/** A provider answered and refused. Carries the JSON-RPC error code verbatim. */
export class RpcError extends Error {
  readonly code: number
  readonly rpcMethod: string
  readonly provider: string
  constructor(args: { code: number; message: string; method: string; provider: string }) {
    super(`${args.method} → ${args.code} ${args.message}`)
    this.name = 'RpcError'
    this.code = args.code
    this.rpcMethod = args.method
    this.provider = args.provider
  }
}

/** Nobody answered. Not a domain failure; the caller makes no progress and tries again later. */
export class RpcUnavailableError extends Error {
  readonly rpcMethod: string
  readonly attempted: readonly string[]
  constructor(method: string, attempted: readonly string[], cause: string) {
    super(
      attempted.length === 0
        ? `${method}: every provider is in rate-limit backoff`
        : `${method}: all ${attempted.length} provider(s) failed — last: ${cause}`,
    )
    this.name = 'RpcUnavailableError'
    this.rpcMethod = method
    this.attempted = attempted
  }
}

export type ProviderState = 'healthy' | 'degraded' | 'down'

interface Health {
  readonly name: string
  readonly urlHost: string
  consecutiveFailures: number
  totalRequests: number
  totalFailures: number
  latencyMs: number | null
  lastOkAt: Date | null
  lastFailureAt: Date | null
  lastError: string | null
  rateLimitedUntil: Date | null
  rateLimitHits: number
}

export interface RpcPoolOptions {
  readonly scope: ChainScope
  readonly endpoints: readonly RpcEndpoint[]
  readonly deadlineMs?: number
  /**
   * Consecutive failures before a provider is called `down`.
   *
   * Below `@cloudsforge/http`'s own circuit threshold of 5 on purpose: the pool should stop
   * *preferring* a provider well before the breaker stops *allowing* it, so the demotion is
   * visible in `provider_health` while calls are still succeeding elsewhere.
   */
  readonly downThreshold?: number
  readonly now?: () => number
  /** Test seam. Production builds one `HttpClient` per endpoint and keeps it for the process. */
  readonly clientFor?: (endpoint: RpcEndpoint) => Pick<HttpClient, 'request'>
  /** Fires once per failed attempt, per provider. Wired to the failure counter. */
  readonly onFailure?: (provider: string, err: unknown) => void
}

interface JsonRpcResponse<T> {
  readonly jsonrpc?: string
  readonly id?: number | string | null
  readonly result?: T
  readonly error?: { code?: number; message?: string; data?: unknown }
}

/** Codes and phrasings providers use for throttling. `-32005` is Infura's; the rest are common. */
const RATE_LIMIT_CODES = new Set([-32005, -32029, 429])
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|request limit|throttl/i

const MAX_BACKOFF_MS = 60_000

/**
 * The `Authorization` value for an RPC url that carries credentials, or `undefined` when it does
 * not.
 *
 * Exported so it can be tested directly. `URL.origin` — which is what the client is built from —
 * DISCARDS USERINFO, so `http://user:pass@host:port` loses its credential silently and the node
 * answers **401**. That is the same reply a wrong password produces, which is why the defect
 * survived: every diagnosis pointed at the credential, and none at the client that declined to
 * send it.
 *
 * Bitcoin Core and its forks authenticate RPC with HTTP Basic and offer no alternative, so this is
 * the only way to reach a self-hosted `litecoind` or `bitcoind`.
 */
export function basicAuthFor(url: string): string | undefined {
  const parsed = new URL(url)
  if (parsed.username === '') return undefined
  const user = decodeURIComponent(parsed.username)
  const pass = decodeURIComponent(parsed.password)
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

export class RpcPool {
  readonly #scope: ChainScope
  readonly #endpoints: readonly RpcEndpoint[]
  readonly #health = new Map<string, Health>()
  readonly #clients = new Map<string, Pick<HttpClient, 'request'>>()
  readonly #clientFor: (endpoint: RpcEndpoint) => Pick<HttpClient, 'request'>
  readonly #deadlineMs: number
  readonly #downThreshold: number
  readonly #now: () => number
  readonly #onFailure: ((provider: string, err: unknown) => void) | undefined
  #nextId = 1

  constructor(options: RpcPoolOptions) {
    if (options.endpoints.length === 0) {
      throw new Error('an RpcPool needs at least one endpoint')
    }
    this.#scope = options.scope
    this.#endpoints = options.endpoints
    this.#deadlineMs = options.deadlineMs ?? 8_000
    this.#downThreshold = options.downThreshold ?? 3
    this.#now = options.now ?? (() => Date.now())
    this.#onFailure = options.onFailure
    this.#clientFor =
      options.clientFor ??
      ((endpoint) => {
        const existing = this.#clients.get(endpoint.name)
        if (existing) return existing
        const parsed = new URL(endpoint.url)
        // `URL.origin` DISCARDS USERINFO. `http://user:pass@host:port` has an origin of
        // `http://host:port`, so a credential written into an RPC URL was dropped here silently
        // and the node answered 401 — which reads as "wrong password" when the password was
        // never sent at all.
        //
        // Bitcoin Core and its forks authenticate RPC with HTTP Basic and offer no alternative,
        // so a self-hosted `litecoind` or `bitcoind` is unreachable without this. It is carried
        // as a default header rather than left in the URL because the URL is also what `hostOf`
        // reports into `provider_health` and into the failure metric, and a password belongs in
        // neither.
        const basic = basicAuthFor(endpoint.url)
        const client = new HttpClient({
          baseUrl: parsed.origin,
          ...(basic === undefined ? {} : { headers: { authorization: basic } }),
          // The breaker and the metrics are keyed on this, so it is the operator's name for the
          // endpoint and never the URL — an RPC URL's query string holds the API key.
          name: `rpc:${this.#scope.chain}:${this.#scope.network}:${endpoint.name}`,
          // One retry inside the client for a transient blip; anything worse is a failover, which
          // is strictly better than retrying an endpoint that has stopped answering.
          defaultRetries: 1,
          defaultDeadlineMs: this.#deadlineMs,
        })
        this.#clients.set(endpoint.name, client)
        return client
      })

    for (const endpoint of options.endpoints) {
      this.#health.set(endpoint.name, {
        name: endpoint.name,
        urlHost: hostOf(endpoint.url),
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        latencyMs: null,
        lastOkAt: null,
        lastFailureAt: null,
        lastError: null,
        rateLimitedUntil: null,
        rateLimitHits: 0,
      })
    }
  }

  get scope(): ChainScope {
    return this.#scope
  }

  /**
   * Call one method, failing over across providers.
   *
   * Every JSON-RPC method this service issues is a read, so the request is safe to retry — and the
   * idempotency key is what tells `@cloudsforge/http` that. Without it a POST is attempted exactly
   * once whatever `retries` says, which is the correct default for a payment and the wrong one
   * here.
   */
  async call<T>(
    method: string,
    params: readonly unknown[] = [],
    options: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const attempted: string[] = []
    let lastError: unknown

    for (const endpoint of this.#ordered()) {
      const health = this.#health.get(endpoint.name)
      if (!health) continue
      attempted.push(endpoint.name)

      const id = this.#nextId++
      const startedAt = this.#now()
      health.totalRequests += 1

      try {
        const parsed = new URL(endpoint.url)
        const response = await this.#clientFor(endpoint).request<JsonRpcResponse<T>>(
          `${parsed.pathname}${parsed.search}`,
          {
            method: 'POST',
            body: { jsonrpc: '2.0', id, method, params },
            idempotencyKey: `${method}:${id}`,
            deadlineMs: options.deadlineMs ?? this.#deadlineMs,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        )

        if (response.error) {
          const code = response.error.code ?? -32000
          const message = response.error.message ?? 'unknown JSON-RPC error'
          if (isRateLimit(code, message)) {
            this.#recordFailure(health, `rate limited: ${message}`, true)
            this.#onFailure?.(endpoint.name, new Error(message))
            lastError = new Error(message)
            continue
          }
          // A provider that answered is a healthy provider even when the answer is "no". Counting
          // an unknown-method error as a failure would demote every endpoint the first time this
          // service asked for something one of them does not implement.
          this.#recordSuccess(health, this.#now() - startedAt)
          throw new RpcError({ code, message, method, provider: endpoint.name })
        }

        this.#recordSuccess(health, this.#now() - startedAt)
        return response.result as T
      } catch (err) {
        if (err instanceof RpcError) throw err
        const rateLimited = err instanceof HttpError && err.status === 429
        this.#recordFailure(health, describe(err), rateLimited)
        this.#onFailure?.(endpoint.name, err)
        lastError = err
        // The caller gave up. Failing over would ignore a cancellation that was already decided.
        if (options.signal?.aborted) break
      }
    }

    throw new RpcUnavailableError(method, attempted, describe(lastError))
  }

  /** Health as the store wants it. Written once per tick rather than once per call. */
  snapshot(): ProviderHealthInput[] {
    return this.#endpoints.map((endpoint) => {
      const health = this.#health.get(endpoint.name)
      if (!health) throw new Error(`no health record for ${endpoint.name}`)
      return {
        provider: health.name,
        urlHost: health.urlHost,
        state: this.#stateOf(health),
        consecutiveFailures: health.consecutiveFailures,
        totalRequests: health.totalRequests,
        totalFailures: health.totalFailures,
        latencyMs: health.latencyMs,
        lastOkAt: health.lastOkAt,
        lastFailureAt: health.lastFailureAt,
        lastError: health.lastError,
        rateLimitedUntil: health.rateLimitedUntil,
      }
    })
  }

  #stateOf(health: Health): ProviderState {
    if (health.consecutiveFailures >= this.#downThreshold) return 'down'
    if (health.consecutiveFailures > 0) return 'degraded'
    return 'healthy'
  }

  /**
   * Preference order: not throttled, then healthiest, then fewest recent failures, then declared
   * order. A provider still inside its backoff window is dropped entirely rather than sorted last,
   * because calling it is what extends the throttle.
   */
  #ordered(): readonly RpcEndpoint[] {
    const now = this.#now()
    const rank: Record<ProviderState, number> = { healthy: 0, degraded: 1, down: 2 }
    return this.#endpoints
      .map((endpoint, index) => ({ endpoint, index, health: this.#health.get(endpoint.name) }))
      .filter((entry) => {
        const until = entry.health?.rateLimitedUntil
        return !until || until.getTime() <= now
      })
      .sort((a, b) => {
        const ha = a.health
        const hb = b.health
        if (!ha || !hb) return a.index - b.index
        const byState = rank[this.#stateOf(ha)] - rank[this.#stateOf(hb)]
        if (byState !== 0) return byState
        const byFailures = ha.consecutiveFailures - hb.consecutiveFailures
        if (byFailures !== 0) return byFailures
        return a.index - b.index
      })
      .map((entry) => entry.endpoint)
  }

  #recordSuccess(health: Health, latencyMs: number): void {
    health.consecutiveFailures = 0
    health.rateLimitHits = 0
    health.rateLimitedUntil = null
    health.latencyMs = Math.round(latencyMs)
    health.lastOkAt = new Date(this.#now())
    health.lastError = null
  }

  #recordFailure(health: Health, message: string, rateLimited: boolean): void {
    health.consecutiveFailures += 1
    health.totalFailures += 1
    health.lastFailureAt = new Date(this.#now())
    health.lastError = message
    if (rateLimited) {
      health.rateLimitHits += 1
      // Exponential from one second, capped. Uncapped backoff on a provider that throttles
      // aggressively is a provider this service never speaks to again.
      const wait = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (health.rateLimitHits - 1))
      health.rateLimitedUntil = new Date(this.#now() + wait)
    }
  }
}

function isRateLimit(code: number, message: string): boolean {
  return RATE_LIMIT_CODES.has(code) || RATE_LIMIT_TEXT.test(message)
}

function describe(err: unknown): string {
  if (err instanceof CircuitOpenError) return `circuit open (${err.upstream})`
  if (err instanceof TimeoutError) return 'timeout'
  if (err instanceof HttpError) return `http ${err.status}`
  if (err instanceof Error) return err.message
  return String(err)
}

/** Host only. The URL itself never reaches a log, a metric label or a database column. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}
