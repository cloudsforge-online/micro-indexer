/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from the estate's custody service, which is the only
 * place that gets this right today:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic: everything derived from it is forgeable by anyone who can read the
 *      repository, and a placeholder that boots is a placeholder that reaches production.
 *
 * One thing is validated here that the template has no equivalent of: **a configured chain must
 * have at least one RPC endpoint, and a configured endpoint must belong to a configured chain.**
 * A follower with no provider is a service that reports healthy and indexes nothing, which is the
 * exact failure mode of the thing it replaces — balance-probing silently freezing an address.
 */

import { hostname } from 'node:os'
import { isChainId, isNetwork, scopeKey, type ChainScope } from './chains.ts'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 *
 * It is also the `producer` on every outbox row, and the first segment of every topic this
 * service emits.
 */
export const SERVICE = 'indexer'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * Values that must never be accepted. The list is short on purpose: it holds the strings that
 * actually appear in this repository's own `.env.example` and compose files, because those are
 * the ones that get copied into a deployment by someone in a hurry.
 */
const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function port(source: Source, name: string, fallback: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new EnvError(`${name} must be a TCP port between 1 and 65535 (got ${raw})`)
  }
  return value
}

function bounded(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be an integer between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/** One RPC endpoint. `name` is what appears in `provider_health` and in the failure metric. */
export interface EndpointConfig {
  readonly name: string
  readonly url: string
}

/** Everything the service needs to follow one chain on one network. */
export interface ChainConfig {
  readonly scope: ChainScope
  /** In preference order. The pool reorders by health, but declaration order breaks ties. */
  readonly endpoints: readonly EndpointConfig[]
  /**
   * Where the follower begins when there is no checkpoint at all.
   *
   * `undefined` means "the tip, less twice the confirmation depth", which is the smallest window
   * that can still observe a deposit through its whole confirmation life. Indexing a young chain
   * from genesis is a `backfill` job, not a cold start: a cold start that walks five million
   * blocks before it serves anything is a service that is never ready.
   */
  readonly startHeight: number | undefined
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string
  readonly chains: readonly ChainConfig[]
  /**
   * How many blocks one follower tick may index.
   *
   * Bounded because a tick must finish inside its lease. A follower that runs long enough to lose
   * its lease hands the same heights to a second replica, and while every write in this service is
   * idempotent, the duplicated RPC traffic is what actually gets a provider to rate-limit us.
   */
  readonly followBatchBlocks: number
  /** The same bound for a backfill pass. Separate, because backfill is allowed to be slower. */
  readonly backfillBatchBlocks: number
  readonly rpcDeadlineMs: number
  /**
   * Which watched addresses count as holding platform money, by label prefix.
   *
   * This is the definition of the **custody set** that `GET /custody/:chain/:network/total` sums
   * and that `micro-ledger` reconciles its custody accounts against, so it is configuration rather
   * than a constant in `custody.ts`: the taxonomy belongs to the platform. The default is the two
   * prefixes the estate actually writes and intends to write —
   *
   *   * `deposit:` — `wallet/src/deposits.ts:284` labels every assigned deposit address
   *     `deposit:<userId>`, and a confirmed arrival there is debited to the ledger's `custody`
   *     asset account (`wallet/src/deposits.ts:627`). These ARE the custody position.
   *   * `treasury:` — nothing writes this today. `micro-settlement` sweeps deposits to a pinned
   *     treasury address (`settlement/src/bitcoin.ts:814`) but holds no `indexer:write` grant, so
   *     treasury addresses are not registered here at all. The prefix is carried so that fixing
   *     that is a registration and not another deploy change, and so the gap is visible in this
   *     comment rather than only in a drift six weeks from now. A swept deployment under-reports
   *     until it is fixed, which reads at the ledger as positive drift and FREEZES the asset —
   *     the safe direction, and loud.
   *
   * **An empty list is refused rather than defaulted to "everything".** A set that matches nothing
   * sums to zero over zero addresses, and zero standing in for "we did not look" is the exact
   * defect this whole path exists to remove. `custody.ts` refuses an empty result for the same
   * reason, so this is the second of two locks on one door.
   */
  readonly custodyLabelPrefixes: readonly string[]
  /**
   * The largest custody set an observation will attempt, before it refuses.
   *
   * One `eth_getBalance` per address inside one request. Above this the route answers 503
   * `custody_set_too_large` rather than summing a page — a page of a custody set is a partial sum,
   * and a partial sum reads at the ledger as positive drift and freezes withdrawals. Raising it is
   * a deploy decision taken with the cost visible, which truncation would never have been.
   */
  readonly custodyMaxAddresses: number
  /** How many of those balance reads are in flight at once. See `custody.ts`'s `concurrency`. */
  readonly custodyConcurrency: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/** `INDEXER_RPC_EMBER_TESTNET`. Upper-cased scope, because that is the shape of an env name. */
export function rpcVarFor(scope: ChainScope): string {
  return `INDEXER_RPC_${scope.chain.toUpperCase()}_${scope.network.toUpperCase()}`
}

export function startHeightVarFor(scope: ChainScope): string {
  return `INDEXER_START_HEIGHT_${scope.chain.toUpperCase()}_${scope.network.toUpperCase()}`
}

/**
 * `name=https://a.example,name2=https://b.example`, or bare URLs whose host becomes the name.
 *
 * Names matter more than they look: they are the primary key of `provider_health` and the
 * `provider` label of `indexer_provider_failures_total`. Deriving them from the host by default
 * means two endpoints at one host must be named by hand rather than silently collapsing into one
 * health row that averages a working provider with a broken one.
 */
export function parseEndpoints(varName: string, raw: string): readonly EndpointConfig[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) throw new EnvError(`${varName} lists no endpoints`)

  const endpoints: EndpointConfig[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const eq = part.indexOf('=')
    // A URL contains no '=' before its query string, and a query string in an RPC URL is where an
    // API key lives — so split on the FIRST '=' only, and only when it precedes the scheme.
    const named = eq > 0 && !part.slice(0, eq).includes('://')
    const name = named ? part.slice(0, eq).trim() : ''
    const url = named ? part.slice(eq + 1).trim() : part

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new EnvError(`${varName} contains an entry that is not a URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new EnvError(`${varName} endpoint ${name || parsed.host} must be http or https`)
    }
    const finalName = name || parsed.host
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(finalName)) {
      throw new EnvError(`${varName} endpoint name must be 1-64 characters of [a-z0-9._:-]`)
    }
    if (seen.has(finalName)) {
      throw new EnvError(`${varName} names ${finalName} twice — health is keyed on the name`)
    }
    seen.add(finalName)
    endpoints.push({ name: finalName, url })
  }
  return Object.freeze(endpoints)
}

/** `ember:testnet,eth:testnet`. Empty is legal: a replica may serve reads and follow nothing. */
export function parseChainList(raw: string): readonly ChainScope[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  const scopes: ChainScope[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const [chain, network, ...rest] = part.split(':')
    if (rest.length > 0 || !chain || !network || !isChainId(chain) || !isNetwork(network)) {
      throw new EnvError(`INDEXER_CHAINS entry ${part} must be <chain>:<network>`)
    }
    const scope: ChainScope = { chain, network }
    if (seen.has(scopeKey(scope))) {
      throw new EnvError(`INDEXER_CHAINS lists ${part} twice`)
    }
    seen.add(scopeKey(scope))
    scopes.push(scope)
  }
  return Object.freeze(scopes)
}

/**
 * `deposit:,treasury:`. Comma-separated, trimmed, deduplicated, and never empty.
 *
 * A prefix is taken literally by `store.custodyAddresses`, which uses `starts_with` rather than
 * `like` so that a `%` in a prefix matches a per-cent sign instead of becoming a wildcard that
 * pulls every watched address on the chain into the custody set. This function still refuses one,
 * because a prefix containing a LIKE metacharacter is far more likely to be a mistake than an
 * intention, and the mistake it would have been is "sum every address we watch".
 */
export function parseCustodyPrefixes(raw: string): readonly string[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length === 0) {
    throw new EnvError(
      'INDEXER_CUSTODY_LABEL_PREFIXES must name at least one prefix — an empty set sums to zero ' +
        'over zero addresses, which is "we did not look" reported as "the chain holds nothing"',
    )
  }
  const seen = new Set<string>()
  for (const part of parts) {
    if (/[%_]/.test(part)) {
      throw new EnvError(`INDEXER_CUSTODY_LABEL_PREFIXES entry ${part} must not contain % or _`)
    }
    if (seen.has(part)) {
      throw new EnvError(`INDEXER_CUSTODY_LABEL_PREFIXES lists ${part} twice`)
    }
    seen.add(part)
  }
  return Object.freeze(parts)
}

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const scopes = parseChainList(optional(source, 'INDEXER_CHAINS', ''))
  const chains: ChainConfig[] = scopes.map((scope) => {
    const varName = rpcVarFor(scope)
    const raw = source[varName]?.trim()
    if (!raw) {
      throw new EnvError(
        `${varName} is required because INDEXER_CHAINS names ${scopeKey(scope)} — a follower ` +
          'with no provider reports healthy and indexes nothing',
      )
    }
    const startVar = startHeightVarFor(scope)
    const startRaw = source[startVar]?.trim()
    let startHeight: number | undefined
    if (startRaw) {
      const parsed = Number(startRaw)
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new EnvError(`${startVar} must be a non-negative integer (got ${startRaw})`)
      }
      startHeight = parsed
    }
    return {
      scope,
      endpoints: parseEndpoints(varName, raw),
      startHeight,
    }
  })

  // The mirror check. An operator who sets INDEXER_RPC_ETH_MAINNET and forgets to add it to
  // INDEXER_CHAINS has configured a chain that is never followed, and nothing would say so.
  for (const key of Object.keys(source)) {
    if (!key.startsWith('INDEXER_RPC_')) continue
    const suffix = key.slice('INDEXER_RPC_'.length).toLowerCase()
    const [chain, network] = suffix.split('_')
    if (!chain || !network || !isChainId(chain) || !isNetwork(network)) continue
    if (!scopes.some((s) => s.chain === chain && s.network === network)) {
      throw new EnvError(`${key} is set but INDEXER_CHAINS does not list ${chain}:${network}`)
    }
  }

  return {
    port: port(source, 'PORT', 4008),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'INDEXER_DATABASE_URL'),
    databasePoolMax: bounded(source, 'INDEXER_DATABASE_POOL_MAX', 10, 1, 200),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    chains: Object.freeze(chains),
    followBatchBlocks: bounded(source, 'INDEXER_FOLLOW_BATCH_BLOCKS', 25, 1, 500),
    backfillBatchBlocks: bounded(source, 'INDEXER_BACKFILL_BATCH_BLOCKS', 50, 1, 1_000),
    rpcDeadlineMs: bounded(source, 'INDEXER_RPC_DEADLINE_MS', 8_000, 250, 120_000),
    custodyLabelPrefixes: parseCustodyPrefixes(
      optional(source, 'INDEXER_CUSTODY_LABEL_PREFIXES', 'deposit:,treasury:'),
    ),
    custodyMaxAddresses: bounded(source, 'INDEXER_CUSTODY_MAX_ADDRESSES', 2_000, 1, 100_000),
    custodyConcurrency: bounded(source, 'INDEXER_CUSTODY_CONCURRENCY', 8, 1, 64),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed
 * through the telemetry package: nothing that can itself fail may sit between a configuration
 * error and the report of it. The message is the one `loadEnv` produced, which by construction
 * never contains a value — note that `parseEndpoints` names endpoints, never URLs, because an
 * RPC URL's query string is where a provider API key lives.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
