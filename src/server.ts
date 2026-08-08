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
import { CustodyTotalUnavailableError, type CustodyObserver } from './custody.ts'
import type { ReadStore } from './reads.ts'
import { TokenStateUnavailableError, type TokenObserver } from './tokenstate.ts'

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
   * Contract state, read from the chain rather than from this service's own rows.
   *
   * Separate from `reads` deliberately. Everything in `ReadStore` is a question about rows this
   * service wrote and needs a database and nothing else; this one needs an RPC provider, and
   * folding it in would make the read store a thing that cannot be constructed from a connection
   * string. See `tokenstate.ts` for why the capability is here at all.
   */
  readonly tokens: TokenObserver
  /**
   * Σ confirmed native balance over the custody set, for `micro-ledger`'s reconciliation.
   *
   * Separate from `reads` for the reason `tokens` is: it needs an RPC provider, not a connection
   * string. Separate from `tokens` because the failure semantics are opposite — a contract that
   * will not answer `owner()` has no owner, and an account that will not answer `eth_getBalance`
   * has an unknown balance. `custody.ts` carries the argument.
   */
  readonly custody: CustodyObserver
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

type Handler = (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>

/**
 * THE ROUTE TABLE. Every domain path this service serves, once, in one place.
 *
 * It is a module-level constant rather than a local inside `buildRoutes` because it is read from
 * outside this process: `micro-mint`'s CI checks out this repository and parses these lines, then
 * asserts that every path its indexer client requests is one of them. That check exists because
 * two clients have now been written against paths this service has never served — `micro-market`'s
 * escrow gate (18-build-status §3.3i) and `micro-mint`'s `token()`, which asked for
 * `/v1/chains/:chain/:network/tokens/:address` and got a 404 it read as "not indexed yet", so
 * every ForgeMint project page rendered its supply and authorities as unknown, permanently.
 *
 * So the SHAPE of these lines is load-bearing: one entry per line, method and path as single-quoted
 * literals. A path assembled from a variable would still route and would be invisible to the
 * checker, which is worse than a wrong path because nothing would go red.
 */
const DOMAIN: ReadonlyArray<readonly [string, string, Handler]> = [
  ['GET', '/chains/:chain/:network/status', chainStatus],
  ['GET', '/addresses/:chain/:network/:address/activity', addressActivity],
  ['GET', '/addresses/:chain/:network/:address/token-balances', addressTokenBalances],
  ['GET', '/transactions/:chain/:network/:hash', transactionByHash],
  ['GET', '/transactions/:chain/:network/:hash/confirmations', transactionConfirmations],
  ['GET', '/tokens/:chain/:network/:address', tokenObservation],
  ['GET', '/custody/:chain/:network/total', custodyTotal],
  ['GET', '/custody/:chain/:network/addresses/:address', custodyAddressBalance],
  ['GET', '/blocks/:chain/:network/:height', blockByHeight],
  ['POST', '/watch/:chain/:network/:address', watchAddress],
  ['POST', '/backfills/:chain/:network', requestBackfill],
]

/**
 * The same table as `METHOD path` strings, both spellings, for anything that needs to compare
 * against it. `server.test.ts` pins it exactly, so a rename here is a red run in the repository
 * that owns the route rather than a silent 404 in a consumer six weeks later.
 */
export const ROUTE_PATTERNS: readonly string[] = Object.freeze(
  PREFIXES.flatMap((prefix) => DOMAIN.map(([method, path]) => `${method} ${prefix}${path}`)),
)

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

    // A CORS preflight, answered before routing. A browser sends OPTIONS ahead of any request
    // carrying `authorization` or `x-request-id`, and an unanswered preflight blocks the real
    // request as surely as a 403 on it — the route table has no OPTIONS entries, so without this
    // the preflight 404'd and every cross-origin read died before it was made. Only a genuine
    // preflight (it names the method it asks about) is short-circuited; a bare OPTIONS still
    // falls through to the 404 it deserves.
    if (method === 'OPTIONS' && headerOf(req, 'access-control-request-method')) {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-request-id, traceparent, tracestate, baggage',
        'access-control-max-age': '86400',
        'x-request-id': requestId,
      })
      res.end()
      return
    }

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
    if (err instanceof TokenStateUnavailableError) {
      // NEVER a 404. "I could not ask the chain" and "there is no token at that address" are
      // different answers, and a consumer that cannot tell them apart renders the second when it
      // means the first — which is the whole shape of the defect this route was added to close.
      // A family this build cannot read is 501, because no amount of waiting will change it;
      // everything else is 503, because it is a provider, a head or a follower that is behind.
      const status = err.code === 'family_not_supported' ? 501 : 503
      ctx.log.warn('token state could not be observed', { code: err.code, err })
      return errorReply(status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof CustodyTotalUnavailableError) {
      // **NEVER a 200, and never a 404.** A caller reads this route to decide whether the platform
      // is solvent, and the only two honest answers are a total that may be believed and a refusal.
      // A 404 would be read as "no custody here", which is a zero with a status code; a 200 with a
      // partial total is a positive drift that freezes withdrawals on the strength of an RPC
      // timeout. The status split follows the token route's: 501 for a family no amount of waiting
      // will make readable, 503 for everything else — a node behind its depth, a halted chain, a
      // custody set nobody registered, a provider that refused.
      const status = err.code === 'family_not_supported' ? 501 : 503
      ctx.log.warn('custody total could not be observed', { code: err.code, err })
      return errorReply(status, err.code, err.message, ctx.requestId)
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

  const built: Route[] = [...health]
  for (const prefix of PREFIXES) {
    for (const [method, path, handler] of DOMAIN) {
      built.push(route(method, `${prefix}${path}`, handler))
    }
  }
  return built
}

/* ------------------------------------------------------------------ handlers */

async function chainStatus(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authoriseRead(ctx, deps)
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
  await authoriseRead(ctx, deps)
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
  await authoriseRead(ctx, deps)
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
  await authoriseRead(ctx, deps)
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
  await authoriseRead(ctx, deps)
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

/**
 * A token's supply and authorities, as the contract itself reports them.
 *
 * **The 404 is a genuine answer here, exactly as it is on `/confirmations`, and it carries its own
 * code so that a caller can tell it from the router's.** `token_not_found` means this service asked
 * the chain and there is no observable token at that address at the block it has walked — a fresh
 * deployment above the head reads as this, and that is honest. The bare `not_found` a caller gets
 * for an unrouted path means something entirely different: that the caller asked for a path this
 * service does not serve. `micro-mint` conflated the two and rendered "not yet indexed" on every
 * project page, for ever, and `micro-market` did the same to every escrow activation.
 *
 * Everything that is neither of those — no provider for the chain, nothing walked yet, a head the
 * node no longer serves — is a 503 with its own code. See the `TokenStateUnavailableError` branch
 * in `handle`.
 */
async function tokenObservation(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authoriseRead(ctx, deps)
  const scope = scopeFrom(ctx)
  // The same normalisation an address gets everywhere else: a contract address is an address, and
  // a caller pasting the EIP-55 checksum form from an explorer must not get a different answer.
  const address = addressFrom(ctx, scope.chain)
  const done = deps.lifecycle.track()
  try {
    const observed = await deps.tokens.observe(scope, address)
    if (!observed) {
      throw new NotFoundError(
        'token_not_found',
        'no contract answering totalSupply() at that address, at the block this service has walked',
      )
    }
    return { status: 200, body: observed }
  } finally {
    done()
  }
}

/**
 * Σ confirmed native balance over the custody set — the number `micro-ledger` reconciles against.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ONLY DOMAIN READ ON THIS SERVICE THAT REQUIRES A TOKEN, AND THE RULE THAT OPENED THE
 * OTHERS IS WHY.** `authoriseRead`'s argument is not "reads are cheap", it is: *what these routes
 * return is already public — anyone may obtain all of it by running a Hearth node*. Every other
 * route answers a question about a block, a hash or an address the CALLER already named, and
 * naming it is what makes the answer public.
 *
 * This one answers a question about a SET that only the platform knows: the total the estate holds
 * in custody, across addresses the caller cannot enumerate and this route does not disclose.
 * Nobody can obtain it by running a node, because running a node does not tell you which addresses
 * are ours. It is therefore not covered by the rule that opened the other reads, and serving it
 * anonymously would publish the treasury's size to anyone who can reach the port.
 *
 * So: `authorise(…, READ_SCOPE)`, which demands a service token carrying `indexer:read` or an
 * admin. It fails CLOSED in the direction that matters — a caller without the grant gets a 401 or
 * 403, its client maps that to "no observation", and the ledger records `unavailable` and freezes.
 * A misconfigured deploy therefore stops withdrawals rather than quietly reporting a number.
 *
 * The response deliberately carries `addresses` and `labelPrefixes` but no address. The count and
 * the definition are what let an operator judge whether the set was the right set; the members are
 * the part the ledger must not learn.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function custodyTotal(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const done = deps.lifecycle.track()
  try {
    // No `catch` that produces a fallback, on purpose. Every failure inside is a
    // `CustodyTotalUnavailableError` and every one of them must reach `handle` as a non-200 — a
    // 200 carrying a partial or defaulted total is the one outcome this route exists to make
    // impossible.
    const observed = await deps.custody.total(scope)
    return { status: 200, body: observed }
  } finally {
    done()
  }
}

/**
 * One named address's confirmed native balance, at the depth and against the block hash the
 * aggregate above uses.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS A READ ABOUT AN ADDRESS THE CALLER NAMED, AND IT IS STILL BEHIND `indexer:read`.**
 *
 * The rule that opened the other reads applies squarely: the caller supplies the address, so the
 * answer is one anybody can obtain from a node, and no set is disclosed. On that argument alone it
 * could be anonymous like `/addresses/:chain/:network/:address/activity`.
 *
 * It is not, for a reason about use rather than about disclosure. The only caller is a service
 * booking a ledger position for an address it is about to register as the platform's, and that
 * booking is an input to the estate's solvency arithmetic. A route whose answer becomes a journal
 * entry should fail closed the way `/custody/.../total` does — a caller without the grant gets a
 * 403, the booking does not happen, the registration is not marked complete, and the recurring job
 * retries. Anonymous, the same misconfiguration would let anything on the port influence what the
 * platform believes it holds.
 *
 * It deliberately does NOT require the address to be watched. Its caller measures *before* it
 * registers, precisely so that the balance it books is not one already counted by an aggregate.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function custodyAddressBalance(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authorise(ctx, deps, READ_SCOPE)
  const scope = scopeFrom(ctx)
  const address = addressFrom(ctx, scope.chain)
  const done = deps.lifecycle.track()
  try {
    // No fallback, exactly as `custodyTotal` has none. Every failure inside is a
    // `CustodyTotalUnavailableError` and every one must reach `handle` as a non-200, because a 200
    // carrying a defaulted balance is a number that would be journalled.
    return { status: 200, body: await deps.custody.balance(scope, address) }
  } finally {
    done()
  }
}

async function blockByHeight(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  await authoriseRead(ctx, deps)
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

/**
 * Reads are ANONYMOUS, because what they return is already public.
 *
 * Every route here answers with chain facts — a block, a transaction, a confirmation depth, a
 * token's on-chain state, an address's activity and balances. Anyone may obtain all of it by
 * running a Hearth node; Hearth is a public chain. This service also stores **nothing that links
 * an address to a person**: ownership of an address is a fact `wallet` holds, deliberately, so the
 * indexer is not the place that guesses at it. There is therefore no privacy for an auth check
 * here to protect — it was a lock on a public library.
 *
 * It was not a harmless one. `micro-explorer-web` could not render a single panel: no token is a
 * 401 and an ordinary customer is a 403, so the public block explorer showed nothing to the public.
 * `docs/ecosystem/15-monetisation-model.md` states the rule this broke — "A public chain whose
 * explorer is paywalled is not a public chain."
 *
 * What is NOT relaxed:
 *
 *   * `/watch` and `/backfills` still require `indexer:write`. They spend money — a backfill is
 *     provider calls — and they change what this service does rather than reporting what it knows.
 *   * A token that IS presented is still verified. Presenting a broken or expired one is an error
 *     worth surfacing, and treating it as anonymous would hide exactly the auth misconfiguration
 *     an operator needs to see.
 *   * A **service** principal still needs `indexer:read`. A service that presents a credential
 *     which does not grant this route has been misconfigured, and silently downgrading it to
 *     anonymous would turn a deployment mistake into a mystery.
 *
 * Abuse is a rate limit at the edge, not an authentication check. An authentication check does not
 * bound cost — a caller holding one valid service token can spend just as much.
 */
async function authoriseRead(ctx: RequestContext, deps: ServerDeps): Promise<Principal | null> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  if (!token) return null
  const principal = await deps.verifier.principal(token)
  if (principal.kind === 'service') {
    requireScope(principal, READ_SCOPE)
    return principal
  }
  return principal
}

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
    // `*`, deliberately — and this is a DIFFERENT decision from micro-faucet's allowlist, not a
    // sloppier one. The faucet's POST pays out, so it names the one origin allowed to ask; these
    // reads are anonymous public chain facts (see authoriseRead), and an origin allowlist here
    // would re-paywall the chain for every origin nobody predicted — a community dashboard, a
    // wallet, a researcher — which is the rule the anonymity change enforced. Wildcard origin
    // carries no credentials semantics: browsers refuse `*` + credentials outright, so a cookie
    // can never ride on it, and a presented bearer still has to survive verification like any
    // other. Without this header the reads were public to curl and blocked to every browser on
    // another host, which is why micro-network-site's chain panel could fetch nothing.
    'access-control-allow-origin': '*',
    // Without this a browser may read the body but not the request id — the one thing support
    // asks a reporter to quote.
    'access-control-expose-headers': 'x-request-id',
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
