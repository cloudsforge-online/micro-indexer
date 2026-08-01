/**
 * The HTTP surface.
 *
 * Plain `node:http`, as the service template is, with one addition it does not need: path
 * parameters. Every route this service serves is scoped by `(chain, network)` and most are then
 * scoped by an address, a hash or a height, so the route table is compiled to patterns rather than
 * matched by string equality. The `route` metric label is the **pattern**, never the resolved
 * path — using the raw path would let any caller mint unbounded time series by requesting a
 * million addresses and take the scrape target down with cardinality.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ## Authority
 *
 * Reads take a **service token carrying `indexer:read`**, or an admin user. Deliberately not an
 * ordinary user token: address ownership is a fact the `wallet` service holds and this service
 * does not, so the indexer cannot tell whether a user is entitled to an address and must not be
 * the place that pretends it can. A user-facing activity feed is `hub-api` calling this with its
 * own service token after it has checked ownership.
 *
 * Two write routes exist and both take `indexer:write`. They are the minimum that makes deposit
 * events reachable: something must be able to say "watch this address" and "index this range".
 * Neither is a decision about money.
 *
 * The one thing that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because the identity service is having a bad minute.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import {
  familyOf,
  isChainId,
  isNetwork,
  requiredConfirmations,
  type ChainId,
  type ChainScope,
} from './chains.ts'
import type { ReadStore } from './reads.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly reads: ReadStore
  /**
   * Refresh sampled gauges immediately before `/metrics` renders.
   *
   * Queue depth is a value that must be read, not counted, and reading it on a timer would be the
   * one `setInterval` in this repository — precisely the shape rule 8 exists to keep out. A scrape
   * is already periodic, so the scrape is when to sample.
   */
  readonly beforeScrape?: () => Promise<void>
}

export const READ_SCOPE = 'indexer:read'
export const WRITE_SCOPE = 'indexer:write'

/**
 * An inbound request id is trusted only if it is safe to put in a log line and echo in a header.
 * Anything else is replaced rather than rejected — the caller does not need a 400 over this, and
 * an unvalidated value here is a header-injection and a log-forgery primitive at once.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

const MAX_BODY_BYTES = 16 * 1024
const MAX_PAGE = 200
const DEFAULT_PAGE = 50

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly requestId: string
  readonly log: Logger
}

interface Route {
  readonly method: string
  /** The declared pattern. Also the metric label, which is why it is stored rather than derived. */
  readonly path: string
  readonly matcher: RegExp
  readonly names: readonly string[]
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Both spellings of every domain route.
 *
 * `/v1/...` is the estate convention and the one to use. The unprefixed form is the spelling in
 * the indexer's own specification and in the operator runbooks written against it, and serving
 * both costs one loop rather than a redirect that every internal caller would have to follow.
 */
const PREFIXES: readonly string[] = ['/v1', '']

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote. This is
    // the workflow Lantern already depends on and it must keep working.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'
    const matched = match(routes, method, url.pathname)
    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.route.path : 'unmatched'

    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, params: matched?.params ?? {}, requestId, log }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(
          res,
          errorReply(500, 'internal', 'the request could not be completed', requestId),
          requestId,
        )
        finish(500)
      })
  })
}

async function handle(
  matched: { route: Route; params: Record<string, string> } | null,
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<Reply> {
  if (!matched) {
    return errorReply(
      404,
      'not_found',
      `no route for ${ctx.req.method} ${ctx.url.pathname}`,
      ctx.requestId,
    )
  }
  try {
    return await matched.route.handle(ctx, deps)
  } catch (err) {
    // `statusFor` is the whole point: it is the one place that decides what an auth failure means,
    // so five services cannot disagree about it again.
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(
        503,
        'verifier_unavailable',
        'authentication is temporarily unavailable',
        ctx.requestId,
      )
    }
    if (err instanceof BadRequestError) {
      return errorReply(400, err.code, err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, err.code, err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

/* ------------------------------------------------------------------ routing */

function compile(path: string): { matcher: RegExp; names: string[] } {
  const names: string[] = []
  const pattern = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return escapeRegex(segment)
      names.push(segment.slice(1))
      // One segment, never empty, and never a slash — so `/addresses//activity` does not match
      // with an empty address and hand an empty string to a query.
      return '([^/]+)'
    })
    .join('/')
  return { matcher: new RegExp(`^${pattern}$`), names }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function match(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const found = route.matcher.exec(pathname)
    if (!found) continue
    const params: Record<string, string> = {}
    route.names.forEach((name, index) => {
      const value = found[index + 1]
      if (value !== undefined) params[name] = decodeURIComponent(value)
    })
    return { route, params }
  }
  return null
}

function route(
  method: string,
  path: string,
  handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
): Route {
  const { matcher, names } = compile(path)
  return { method, path, matcher, names, handle: handler }
}

function buildRoutes(): Route[] {
  const health: Route[] = [
    route('GET', '/livez', async (_ctx, deps) => ({
      status: 200,
      /**
       * Static, deliberately. Liveness answers one question — should this process be killed and
       * restarted — and a liveness probe that consults a dependency restarts a healthy process
       * every time the database blinks, turning a brief outage into a rolling restart of the whole
       * estate. Readiness is where dependencies belong.
       */
      body: deps.lifecycle.livez(),
    })),
    route('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. A soft probe failure leaves the report
      // degraded but still ready, because taking a whole product out of rotation over a
      // non-essential upstream is worse than serving without it.
      return { status: report.ready ? 200 : 503, body: report }
    }),
    route('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would
        // lose every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),
  ]

  const domain: Array<[string, string, (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>]> =
    [
      ['GET', '/chains/:chain/:network/status', chainStatus],
      ['GET', '/addresses/:chain/:network/:address/activity', addressActivity],
      ['GET', '/addresses/:chain/:network/:address/token-balances', addressTokenBalances],
      ['GET', '/transactions/:chain/:network/:hash', transactionByHash],
      ['GET', '/transactions/:chain/:network/:hash/confirmations', transactionConfirmations],
      ['GET', '/blocks/:chain/:network/:height', blockByHeight],
      ['POST', '/watch/:chain/:network/:address', watchAddress],
      ['POST', '/backfills/:chain/:network', requestBackfill],
    ]

  const built: Route[] = [...health]
  for (const prefix of PREFIXES) {
    for (const [method, path, handler] of domain) {
      built.push(route(method, `${prefix}${path}`, handler))
    }
  }
  return built
}

/* ------------------------------------------------------------------ handlers */

async function chainStatus(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const done = deps.lifecycle.track()
  try {
    const status = await deps.reads.status(scope)
    return { status: 200, body: status }
  } finally {
    done()
  }
}

async function addressActivity(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const address = addressFrom(ctx, scope.chain)
  const limit = limitFrom(ctx)
  const cursor = ctx.url.searchParams.get('cursor')

  const done = deps.lifecycle.track()
  try {
    const page = await deps.reads.activity(scope, address, limit, cursor)
    return { status: 200, body: page }
  } finally {
    done()
  }
}

async function transactionByHash(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const hash = hashFrom(ctx, scope.chain)
  const done = deps.lifecycle.track()
  try {
    const transaction = await deps.reads.transaction(scope, hash)
    if (!transaction) throw new NotFoundError('transaction_not_found', 'no such transaction')
    return { status: 200, body: transaction }
  } finally {
    done()
  }
}

/**
 * Has this transaction reached its depth?
 *
 * **The 404 is load-bearing and is a genuine answer.** A transaction this indexer has never seen
 * is 404 `transaction_not_found`; one it has seen and that has not reached its depth is 200 with
 * `confirmed: false`. Those are different facts and a caller taking a money decision must be able
 * to tell them apart — `micro-market` reported "the on-chain escrow is not confirmed yet" for
 * every activation because a route-level 404 and a negative answer had been collapsed into one.
 * A caller distinguishes them by the error CODE, not by the status: a path this service does not
 * serve answers `not_found`, an unrun chain answers `unknown_chain`.
 */
async function transactionConfirmations(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const hash = hashFrom(ctx, scope.chain)
  const done = deps.lifecycle.track()
  try {
    const answer = await deps.reads.confirmation(scope, hash)
    if (!answer) {
      throw new NotFoundError(
        'transaction_not_found',
        'this indexer has never seen that transaction, which is not the same as unconfirmed',
      )
    }
    return { status: 200, body: answer }
  } finally {
    done()
  }
}

/**
 * What an address holds of a token, at a block.
 *
 * Derived from `address_activity`, so the answer carries the coverage it was derived from and
 * withholds the balance entirely when that coverage cannot support one. See `reads.tokenBalances`:
 * a missing balance is missing, never zero, because zero is what evicts a token-gated member.
 */
async function addressTokenBalances(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const address = addressFrom(ctx, scope.chain)
  const contract = contractFrom(ctx, scope.chain)
  const atBlock = blockFrom(ctx)
  const done = deps.lifecycle.track()
  try {
    const answer = await deps.reads.tokenBalances(scope, address, contract, atBlock)
    return { status: 200, body: answer }
  } finally {
    done()
  }
}

async function blockByHeight(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const raw = ctx.params['height'] ?? ''
  if (!/^\d{1,15}$/.test(raw)) {
    throw new BadRequestError('bad_height', 'height must be a non-negative integer')
  }
  const done = deps.lifecycle.track()
  try {
    const block = await deps.reads.block(scope, Number(raw))
    if (!block) throw new NotFoundError('block_not_found', 'no such block on the canonical chain')
    return { status: 200, body: block }
  } finally {
    done()
  }
}

async function watchAddress(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  const principal = await authorise(ctx, deps, WRITE_SCOPE)
  const scope = scopeFrom(ctx)
  const address = addressFrom(ctx, scope.chain)
  const body = await readJson(ctx.req)
  const label = typeof body['label'] === 'string' ? body['label'].slice(0, 200) : null

  const done = deps.lifecycle.track()
  try {
    await deps.reads.watch(scope, address, label)
    ctx.log.info('address watched', {
      chain: scope.chain,
      network: scope.network,
      address,
      by: principal.kind === 'service' ? principal.service : `user:${principal.userId}`,
    })
    return { status: 202, body: { chain: scope.chain, network: scope.network, address, label } }
  } finally {
    done()
  }
}

async function requestBackfill(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, WRITE_SCOPE)
  const scope = scopeFrom(ctx)
  const body = await readJson(ctx.req)
  const from = body['from']
  const to = body['to']
  if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0) {
    throw new BadRequestError('bad_range', 'from must be a non-negative integer')
  }
  if (typeof to !== 'number' || !Number.isSafeInteger(to) || to < from) {
    throw new BadRequestError('bad_range', 'to must be an integer not less than from')
  }

  const done = deps.lifecycle.track()
  try {
    const stream = await deps.reads.requestBackfill(scope, from, to)
    return { status: 202, body: { chain: scope.chain, network: scope.network, stream, from, to } }
  } finally {
    done()
  }
}

/* ------------------------------------------------------------------ parameters */

function scopeFrom(ctx: RequestContext): ChainScope {
  const chain = (ctx.params['chain'] ?? '').toLowerCase()
  const network = (ctx.params['network'] ?? '').toLowerCase()
  // 404 rather than 400: the path names a resource that does not exist, and a caller that asked
  // for `/chains/doge/mainnet/status` has not made a malformed request, it has asked for a chain
  // this estate does not run.
  if (!isChainId(chain)) throw new NotFoundError('unknown_chain', `no such chain: ${chain}`)
  if (!isNetwork(network)) {
    throw new NotFoundError('unknown_network', `no such network: ${network}`)
  }
  return { chain, network }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/

/**
 * Normalise before querying.
 *
 * EVM addresses are stored lower-cased, so a caller that sends the EIP-55 checksum form — which is
 * what every wallet and every block explorer displays — must not silently receive an empty page.
 * That failure is indistinguishable from "this address has never been paid", which is the single
 * worst wrong answer this endpoint could give.
 */
function addressFrom(ctx: RequestContext, chain: ChainId): string {
  const raw = (ctx.params['address'] ?? '').trim()
  const family = familyOf(chain)
  if (family === 'evm' || family === 'ember') {
    if (!EVM_ADDRESS.test(raw)) {
      throw new BadRequestError('bad_address', 'address must be a 20-byte hex address')
    }
    return raw.toLowerCase()
  }
  // Bitcoin, Solana and XRP addresses are base58 or bech32 and case-significant. They are length
  // checked only, because the family that would validate them is not built yet and a wrong
  // validator would reject valid addresses.
  if (raw.length < 16 || raw.length > 128) {
    throw new BadRequestError('bad_address', 'address is not a plausible length')
  }
  return raw
}

function hashFrom(ctx: RequestContext, chain: ChainId): string {
  const raw = (ctx.params['hash'] ?? '').trim()
  const family = familyOf(chain)
  if (family === 'evm' || family === 'ember') {
    if (!EVM_HASH.test(raw)) {
      throw new BadRequestError('bad_hash', 'hash must be a 32-byte hex hash')
    }
    return raw.toLowerCase()
  }
  if (raw.length < 16 || raw.length > 128) {
    throw new BadRequestError('bad_hash', 'hash is not a plausible length')
  }
  return raw
}

/**
 * The optional `contract` filter, normalised exactly as an address is.
 *
 * Same normalisation and the same reason: token addresses are stored lower-cased and every wallet
 * and explorer displays the EIP-55 checksum form, so accepting it verbatim would answer "this
 * address has never held that token" for the spelling users actually have.
 */
function contractFrom(ctx: RequestContext, chain: ChainId): string | null {
  const raw = (ctx.url.searchParams.get('contract') ?? '').trim()
  if (raw === '') return null
  const family = familyOf(chain)
  if (family === 'evm' || family === 'ember') {
    if (!EVM_ADDRESS.test(raw)) {
      throw new BadRequestError('bad_contract', 'contract must be a 20-byte hex address')
    }
    return raw.toLowerCase()
  }
  if (raw.length < 16 || raw.length > 128) {
    throw new BadRequestError('bad_contract', 'contract is not a plausible length')
  }
  return raw
}

/** The optional `block` bound. Absent means "as at the head this service has walked". */
function blockFrom(ctx: RequestContext): number | null {
  const raw = ctx.url.searchParams.get('block')
  if (raw === null) return null
  if (!/^\d{1,15}$/.test(raw)) {
    throw new BadRequestError('bad_block', 'block must be a non-negative integer')
  }
  return Number(raw)
}

function limitFrom(ctx: RequestContext): number {
  const raw = ctx.url.searchParams.get('limit')
  if (raw === null) return DEFAULT_PAGE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new BadRequestError('bad_limit', `limit must be an integer between 1 and ${MAX_PAGE}`)
  }
  return value
}

/* ------------------------------------------------------------------ auth */

async function authorise(
  ctx: RequestContext,
  deps: ServerDeps,
  scope: string,
): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  const principal = await deps.verifier.principal(token)
  if (principal.kind === 'service') {
    requireScope(principal, scope)
    return principal
  }
  // A user token reaches this service only as an operator. See the header: ownership of an
  // address is a fact `wallet` holds, so the indexer must not be the place that guesses at it.
  if (!isAdmin(principal)) throw new ForbiddenError(scope)
  return principal
}

/* ------------------------------------------------------------------ plumbing */

class BadRequestError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BadRequestError'
    this.code = code
  }
}

class NotFoundError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'NotFoundError'
    this.code = code
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('body_too_large', 'request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('bad_body', 'request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('bad_body', 'request body is not valid JSON')
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line, the trace and
 * the Lantern issue.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health, metrics and chain answers are a point-in-time fact. A cached 200 from a replica that
    // has since gone unready — or a cached tip from four minutes ago — is exactly the lie this
    // whole arrangement exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Exported for the status route's benefit and for tests: the depth this chain credits at. */
export function depthFor(chain: ChainId): number {
  return requiredConfirmations(chain)
}
