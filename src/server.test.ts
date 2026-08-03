import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo, Server } from 'node:net'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import type { ChainScope } from './chains.ts'
import { registerServiceMetrics } from './metrics.ts'
import type {
  ActivityPageView,
  BlockView,
  ChainStatus,
  ConfirmationView,
  ReadStore,
  TokenBalancesView,
  TransactionView,
} from './reads.ts'
import {
  CustodyTotalUnavailableError,
  type CustodyObserver,
  type CustodyTotalFault,
  type CustodyTotalObservation,
} from './custody.ts'
import { READ_SCOPE, ROUTE_PATTERNS, WRITE_SCOPE, createServer } from './server.ts'
import {
  TokenStateUnavailableError,
  type TokenObservation,
  type TokenObserver,
  type TokenStateFault,
} from './tokenstate.ts'

/** What the fake store was asked, so a test can assert the normalisation that happened first. */
const asked: Array<{ what: string; scope: ChainScope; arg?: string | number }> = []

const HASH = `0x${'a'.repeat(64)}`
const ADDRESS = `0x${'b'.repeat(40)}`
const TOKEN = `0x${'c'.repeat(40)}`

const reads: ReadStore = {
  async status(scope) {
    asked.push({ what: 'status', scope })
    return {
      chain: scope.chain,
      network: scope.network,
      family: 'ember',
      asset: 'EMBER',
      chainId: 7412,
      requiredConfirmations: 60,
      reorgAlarmDepth: 5,
      tipHeight: 100,
      tipSeenAt: '2026-01-01T00:00:00.000Z',
      indexedHeight: 98,
      indexedHash: HASH,
      lagBlocks: 2,
      halted: false,
      haltReason: null,
      providers: [],
      recentReorgs: [],
    } satisfies ChainStatus
  },
  async activity(scope, address, limit, cursor) {
    asked.push({ what: 'activity', scope, arg: address })
    return {
      chain: scope.chain,
      network: scope.network,
      address,
      tipHeight: 100,
      requiredConfirmations: 60,
      items: [],
      nextCursor: cursor === null ? `${limit}:x` : null,
    } satisfies ActivityPageView
  },
  async transaction(scope, hash) {
    asked.push({ what: 'transaction', scope, arg: hash })
    if (hash !== HASH) return null
    return { chain: scope.chain, hash } as unknown as TransactionView
  },
  async confirmation(scope, hash) {
    asked.push({ what: 'confirmation', scope, arg: hash })
    // Null is "never seen", which the route must turn into a 404 carrying its own code rather than
    // into a 200 saying `confirmed: false`.
    if (hash !== HASH) return null
    return {
      chain: scope.chain,
      network: scope.network,
      hash,
      txUrn: `cf:chain:ember:${scope.network}:${hash}`,
      explorerUrl: null,
      status: 'success',
      blockHash: HASH,
      blockHeight: 40,
      canonical: true,
      confirmations: 61,
      requiredConfirmations: 60,
      confirmed: true,
      indexedHeight: 100,
      tipHeight: 100,
      halted: false,
    } satisfies ConfirmationView
  },
  async tokenBalances(scope, address, contract, atBlock) {
    asked.push({ what: 'token-balances', scope, arg: `${address}|${contract ?? '*'}|${atBlock ?? '-'}` })
    return {
      chain: scope.chain,
      network: scope.network,
      address,
      atBlock: atBlock ?? 100,
      indexedHeight: 100,
      tipHeight: 100,
      halted: false,
      coverage: { fromHeight: 0, toHeight: atBlock ?? 100, blocks: (atBlock ?? 100) + 1, complete: true },
      balances: [{ contract: contract ?? TOKEN, balance: '5000' }],
      ...(contract === null ? {} : { balance: '5000' }),
    } satisfies TokenBalancesView
  },
  async block(scope, height) {
    asked.push({ what: 'block', scope, arg: height })
    if (height !== 98) return null
    return { chain: scope.chain, height, hash: HASH } as unknown as BlockView
  },
  async watch(scope, address) {
    asked.push({ what: 'watch', scope, arg: address })
  },
  async requestBackfill(scope, from, to) {
    asked.push({ what: 'backfill', scope, arg: from })
    return `backfill:${from}-${to}`
  },
}

/**
 * The token observer, faked at the interface rather than at the socket.
 *
 * `TOKEN` is observable, `0xd…` is an address with nothing at it, and a fault can be armed to check
 * that a chain this replica cannot ask is never reported as an address with no token on it.
 */
let fault: TokenStateFault | null = null

const tokens: TokenObserver = {
  async observe(scope, address) {
    asked.push({ what: 'token', scope, arg: address })
    if (fault) throw new TokenStateUnavailableError(fault, `armed: ${fault}`)
    if (address !== TOKEN) return null
    return {
      chain: scope.chain,
      network: scope.network,
      contractAddress: address,
      name: 'Forge',
      symbol: 'FRG',
      decimals: 18,
      totalSupply: '12000000000000000000000000',
      cap: null,
      owner: `0x${'e'.repeat(40)}`,
      mintAuthority: true,
      paused: false,
      observedAtBlock: 98,
      observedAtBlockHash: HASH,
      tipHeight: 100,
      halted: false,
    } satisfies TokenObservation
  },
}

/**
 * The custody aggregate, with an armable refusal.
 *
 * The refusal is the half that matters at this layer: `custody.ts` is where the decision to
 * withhold is taken, and this file's job is to prove the decision survives the transport — that a
 * refusal leaves as a non-200 with its code, and never as a 200 carrying a zero.
 */
let custodyFault: CustodyTotalFault | null = null

const custody: CustodyObserver = {
  async total(scope) {
    asked.push({ what: 'custody', scope })
    if (custodyFault) throw new CustodyTotalUnavailableError(custodyFault, `armed: ${custodyFault}`)
    return {
      chain: scope.chain,
      network: scope.network,
      assetCode: 'EMBER',
      decimals: 18,
      total: '7000000000000000000',
      addresses: 3,
      labelPrefixes: ['deposit:', 'treasury:'],
      requiredConfirmations: 60,
      observedAtBlock: 39,
      observedAtBlockHash: HASH,
      headHeight: 98,
      tipHeight: 100,
      observedAt: '2026-01-01T00:00:00.000Z',
    } satisfies CustodyTotalObservation
  },
}

const service = (scopes: readonly string[]): Principal => ({
  kind: 'service',
  service: 'wallet',
  scopes,
})

const TOKENS: Record<string, Principal> = {
  reader: service([READ_SCOPE]),
  writer: service([READ_SCOPE, WRITE_SCOPE]),
  wildcard: service(['indexer:*']),
  unscoped: service(['ledger:post']),
  admin: { kind: 'user', userId: 'u-1', handle: 'ops', roles: ['admin'] },
  player: { kind: 'user', userId: 'u-2', handle: 'player', roles: ['player'] },
}

let server: Server
let base: string

before(async () => {
  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 })
  server = createServer({
    lifecycle,
    logger: new Logger({ service: 'indexer-test', sink: () => {} }),
    metrics: registerServiceMetrics(registerHttpMetrics(new Metrics())),
    verifier: {
      async principal(token) {
        if (token === 'unavailable') throw new VerifierUnavailableError('jwks unreachable')
        const found = TOKENS[token]
        if (!found) throw new TokenError('unknown token', 'invalid')
        return found
      },
    },
    reads,
    tokens,
    custody,
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  lifecycle.markReady()
})

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
})

async function call(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

test('the three probes every service must serve are unauthenticated', async () => {
  assert.equal((await call('/livez')).status, 200)
  assert.equal((await call('/readyz')).status, 200)
  const metrics = await fetch(`${base}/metrics`)
  assert.equal(metrics.status, 200)
  assert.match(metrics.headers.get('content-type') ?? '', /text\/plain/)
  assert.match(await metrics.text(), /indexer_lag_blocks/)
})

test('a read needs no token at all, because what it returns is already public', async () => {
  // These routes answer with chain facts anyone can obtain by running a Hearth node, and this
  // service stores nothing linking an address to a person. There was no privacy for the old check
  // to protect - only micro-explorer-web, which could not render a single panel to the public.
  assert.equal((await call('/chains/ember/testnet/status')).status, 200)
  assert.equal((await call('/chains/ember/testnet/status', { token: 'player' })).status, 200)
  assert.equal((await call('/chains/ember/testnet/status', { token: 'reader' })).status, 200)
  assert.equal((await call('/chains/ember/testnet/status', { token: 'admin' })).status, 200)
  // One level of wildcard, which `indexer:*` is.
  assert.equal((await call('/chains/ember/testnet/status', { token: 'wildcard' })).status, 200)
})

test('a token that IS presented is still verified, and never silently downgraded', async () => {
  // The relaxation is "no token is fine", NOT "any token is fine". A broken token is an operator's
  // misconfiguration and must surface as one; treating it as anonymous would hide the very fault
  // it signals, and the caller would see a 200 that quietly ignored its credential.
  assert.equal((await call('/chains/ember/testnet/status', { token: 'nope' })).status, 401)
  // A SERVICE that presents a credential not granting this route has been misconfigured. Silently
  // downgrading it to anonymous would turn a deployment mistake into a mystery.
  assert.equal((await call('/chains/ember/testnet/status', { token: 'unscoped' })).status, 403)
})

test('writes are untouched by the read relaxation', async () => {
  // /watch and /backfills spend money - a backfill is provider calls - and change what this
  // service does rather than reporting what it knows. Anonymous must not reach either.
  assert.equal((await call('/watch/ember/testnet/0x0000000000000000000000000000000000000001', { method: 'POST' })).status, 401)
  assert.equal((await call('/backfills/ember/testnet', { method: 'POST' })).status, 401)
  assert.equal((await call('/watch/ember/testnet/0x0000000000000000000000000000000000000001', { method: 'POST', token: 'reader' })).status, 403)
})

test('every answer carries the public-read CORS headers, or a browser cannot use the anonymity', async () => {
  // The reads went anonymous and stayed browser-unreachable: public to curl, blocked by CORS to
  // every page on another host — which is why micro-network-site's chain panel fetched nothing.
  // `*` is the point, not a shortcut: an allowlist here would re-paywall the chain for origins
  // nobody predicted, and wildcard origin carries no credentials semantics by construction.
  const answer = await fetch(`${base}/chains/ember/testnet/status`)
  assert.equal(answer.headers.get('access-control-allow-origin'), '*')
  // A browser may read the body but not the request id without this — the one thing support asks
  // a reporter to quote.
  assert.match(answer.headers.get('access-control-expose-headers') ?? '', /x-request-id/)
  await answer.arrayBuffer()
})

test('a preflight is answered before routing, and a bare OPTIONS is not', async () => {
  // A browser sends OPTIONS before any request carrying `authorization` or `x-request-id`. The
  // route table has no OPTIONS entries, so before this the preflight 404'd and blocked the real
  // request as surely as refusing it.
  const preflight = await fetch(`${base}/chains/ember/testnet/status`, {
    method: 'OPTIONS',
    headers: { 'access-control-request-method': 'GET', origin: 'http://localhost:5190' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/)
  await preflight.arrayBuffer()

  // Only a genuine preflight is short-circuited — it names the method it asks about. A bare
  // OPTIONS is a prober and gets the 404 an unmatched request deserves.
  const bare = await fetch(`${base}/chains/ember/testnet/status`, { method: 'OPTIONS' })
  assert.equal(bare.status, 404)
  await bare.arrayBuffer()
})

test('a verifier that cannot reach the JWKS is 503, never 401', async () => {
  // Answering 401 there signs every user in the estate out because identity had a bad minute.
  const answer = await call('/chains/ember/testnet/status', { token: 'unavailable' })
  assert.equal(answer.status, 503)
  assert.equal((answer.body['error'] as Record<string, string>)['code'], 'verifier_unavailable')
})

test('both spellings of a route are served', async () => {
  assert.equal((await call('/chains/ember/testnet/status', { token: 'reader' })).status, 200)
  assert.equal((await call('/v1/chains/ember/testnet/status', { token: 'reader' })).status, 200)
})

test('the status route answers with the depth the pinned contract publishes', async () => {
  const answer = await call('/chains/ember/testnet/status', { token: 'reader' })
  assert.equal(answer.body['requiredConfirmations'], 60)
  assert.equal(answer.body['chainId'], 7412)
  assert.equal(answer.body['lagBlocks'], 2)
})

test('a chain or network this estate does not run is 404, not 400', async () => {
  const chain = await call('/chains/doge/mainnet/status', { token: 'reader' })
  assert.equal(chain.status, 404)
  assert.equal((chain.body['error'] as Record<string, string>)['code'], 'unknown_chain')
  const network = await call('/chains/ember/devnet/status', { token: 'reader' })
  assert.equal(network.status, 404)
  assert.equal((network.body['error'] as Record<string, string>)['code'], 'unknown_network')
})

test('an EIP-55 checksummed address is normalised before it reaches a query', async () => {
  // Stored lower-cased, and every wallet and explorer displays the checksum form. Returning an
  // empty page for it is indistinguishable from "this address has never been paid", which is the
  // worst wrong answer this endpoint could give.
  asked.length = 0
  const mixed = `0x${'B'.repeat(40)}`
  const answer = await call(`/addresses/ember/testnet/${mixed}/activity`, { token: 'reader' })
  assert.equal(answer.status, 200)
  assert.equal(asked.at(-1)?.arg, ADDRESS)
})

test('a malformed address, hash, height or limit is a 400 with a code', async () => {
  const cases: Array<[string, string]> = [
    ['/addresses/ember/testnet/0xnothex/activity', 'bad_address'],
    [`/transactions/ember/testnet/0xshort`, 'bad_hash'],
    ['/blocks/ember/testnet/notanumber', 'bad_height'],
    [`/addresses/ember/testnet/${ADDRESS}/activity?limit=0`, 'bad_limit'],
    [`/addresses/ember/testnet/${ADDRESS}/activity?limit=5000`, 'bad_limit'],
  ]
  for (const [path, code] of cases) {
    const answer = await call(path, { token: 'reader' })
    assert.equal(answer.status, 400, path)
    assert.equal((answer.body['error'] as Record<string, string>)['code'], code, path)
  }
})

test('every error carries the request id the caller will quote back', async () => {
  // A write, because reads no longer 401 — an anonymous read is a 200 now, so the old request
  // here stopped producing the error body this test is about.
  const response = await fetch(`${base}/backfills/ember/testnet`, {
    method: 'POST',
    headers: { 'x-request-id': 'my-own-id' },
  })
  assert.equal(response.headers.get('x-request-id'), 'my-own-id')
  const body = (await response.json()) as { error: { requestId: string } }
  assert.equal(body.error.requestId, 'my-own-id')
})

test('an unsafe inbound request id is replaced rather than echoed', async () => {
  // Otherwise this is a header-injection and a log-forgery primitive at once.
  const response = await fetch(`${base}/livez`, { headers: { 'x-request-id': 'bad id; x' } })
  assert.notEqual(response.headers.get('x-request-id'), 'bad id; x')
  assert.match(response.headers.get('x-request-id') ?? '', /^[a-z0-9]{16}$/)
})

test('a missing transaction or block is 404 rather than an empty 200', async () => {
  assert.equal((await call(`/transactions/ember/testnet/${HASH}`, { token: 'reader' })).status, 200)
  const missing = `0x${'c'.repeat(64)}`
  assert.equal((await call(`/transactions/ember/testnet/${missing}`, { token: 'reader' })).status, 404)
  assert.equal((await call('/blocks/ember/testnet/98', { token: 'reader' })).status, 200)
  assert.equal((await call('/blocks/ember/testnet/99', { token: 'reader' })).status, 404)
})

/* --------------------------------------- the two capabilities two services were blocked on */

test('a never-seen transaction and an unconfirmed one are different answers', async () => {
  // THE DEFECT THIS ROUTE EXISTS TO END. `micro-market` reported "the on-chain escrow is not
  // confirmed yet" on every activation, because a 404 from a route that did not exist and a
  // genuine negative had been collapsed into one value. They are separated here by the STATUS —
  // 404 versus 200 — and, within the 404s, by the CODE, so a caller can tell "I have never seen
  // this transaction" from "you asked for a path I do not serve".
  const seen = await call(`/transactions/ember/testnet/${HASH}/confirmations`, { token: 'reader' })
  assert.equal(seen.status, 200)
  assert.equal(seen.body['confirmed'], true)
  assert.equal(seen.body['confirmations'], 61)
  assert.equal(seen.body['requiredConfirmations'], 60, 'the depth travels with the answer')

  const never = `0x${'d'.repeat(64)}`
  const unseen = await call(`/transactions/ember/testnet/${never}/confirmations`, { token: 'reader' })
  assert.equal(unseen.status, 404)
  assert.equal(
    (unseen.body['error'] as Record<string, string>)['code'],
    'transaction_not_found',
    'a code a caller can branch on, not a bare 404',
  )

  // And the route-level 404 a caller must treat as an outage carries a different code entirely.
  const noRoute = await call('/transactions/ember/testnet/nope/escrow', { token: 'reader' })
  assert.equal(noRoute.status, 404)
  assert.equal((noRoute.body['error'] as Record<string, string>)['code'], 'not_found')
})

test('the confirmations route does not shadow the transaction record route', async () => {
  // Four segments and three segments are different patterns; a greedy matcher would have made one
  // of these unreachable and the failure would have been a silent 404 on a money path.
  assert.equal((await call(`/transactions/ember/testnet/${HASH}`, { token: 'reader' })).status, 200)
  assert.equal(
    (await call(`/v1/transactions/ember/testnet/${HASH}/confirmations`, { token: 'reader' })).status,
    200,
  )
})

test('the balance route normalises the contract as well as the address', async () => {
  // Both are stored lower-cased and both are displayed checksummed. Accepting one and not the
  // other answers "this member holds nothing", which demotes them.
  asked.length = 0
  const answer = await call(
    `/addresses/ember/testnet/0x${'B'.repeat(40)}/token-balances?contract=0x${'C'.repeat(40)}&block=42`,
    { token: 'reader' },
  )
  assert.equal(answer.status, 200)
  assert.equal(asked.at(-1)?.arg, `${ADDRESS}|${TOKEN}|42`)
  assert.equal(answer.body['balance'], '5000', 'a decimal string; a JSON number loses a uint256')
  assert.equal(typeof answer.body['balance'], 'string')
})

test('a malformed contract or block bound is a 400 with a code, never an empty answer', async () => {
  for (const [path, code] of [
    [`/addresses/ember/testnet/${ADDRESS}/token-balances?contract=0xnothex`, 'bad_contract'],
    [`/addresses/ember/testnet/${ADDRESS}/token-balances?block=-1`, 'bad_block'],
    [`/addresses/ember/testnet/${ADDRESS}/token-balances?block=abc`, 'bad_block'],
  ] as const) {
    const answer = await call(path, { token: 'reader' })
    assert.equal(answer.status, 400, path)
    assert.equal((answer.body['error'] as Record<string, string>)['code'], code, path)
  }
})

test('both new routes are anonymous like every other read', async () => {
  for (const path of [
    `/transactions/ember/testnet/${HASH}/confirmations`,
    `/addresses/ember/testnet/${ADDRESS}/token-balances`,
  ]) {
    assert.equal((await call(path)).status, 200, path)
    assert.equal((await call(path, { token: 'player' })).status, 200, path)
    assert.equal((await call(path, { token: 'reader' })).status, 200, path)
    // Presented-but-insufficient is still refused: see the note on authoriseRead.
    assert.equal((await call(path, { token: 'unscoped' })).status, 403, path)
  }
})

test('the write routes need indexer:write and validate their input', async () => {
  const watchPath = `/watch/ember/testnet/${ADDRESS}`
  assert.equal((await call(watchPath, { token: 'reader', method: 'POST', body: {} })).status, 403)
  const watched = await call(watchPath, { token: 'writer', method: 'POST', body: { label: 'a' } })
  assert.equal(watched.status, 202)
  assert.equal(watched.body['address'], ADDRESS)

  const bad = await call('/backfills/ember/testnet', {
    token: 'writer',
    method: 'POST',
    body: { from: 10, to: 5 },
  })
  assert.equal(bad.status, 400)
  assert.equal((bad.body['error'] as Record<string, string>)['code'], 'bad_range')

  const good = await call('/backfills/ember/testnet', {
    token: 'writer',
    method: 'POST',
    body: { from: 0, to: 100 },
  })
  assert.equal(good.status, 202)
  assert.equal(good.body['stream'], 'backfill:0-100')
})

test('the metrics route label is the pattern, never the resolved path', async () => {
  // Otherwise any caller can mint unbounded time series by requesting a million addresses, and the
  // scrape target is the thing that falls over.
  await call(`/addresses/ember/testnet/${ADDRESS}/activity`, { token: 'reader' })
  const rendered = await (await fetch(`${base}/metrics`)).text()
  assert.match(rendered, /route="\/addresses\/:chain\/:network\/:address\/activity"/)
  assert.equal(rendered.includes(ADDRESS), false, 'an address has leaked into a metric label')
  // And an unmatched path collapses to one series rather than one per path.
  await call('/no/such/route')
  assert.match(rendered.includes('unmatched') ? rendered : await (await fetch(`${base}/metrics`)).text(), /route="unmatched"/)
})

test('an empty path segment does not match and become an empty query parameter', async () => {
  assert.equal((await call('/addresses/ember/testnet//activity', { token: 'reader' })).status, 404)
})

/* --------------------------------------- the capability micro-mint was blocked on */

test('a token this service can observe answers with the contract state, not with a record', async () => {
  // 04-domain-model §5.3: a project page renders supply and authorities from the INDEXER, "the
  // on-chain reality, not the intent". Everything below is a fact about the contract; not one of
  // these fields exists in any row this service writes.
  const answer = await call(`/tokens/ember/testnet/${TOKEN}`, { token: 'reader' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body['symbol'], 'FRG')
  assert.equal(answer.body['mintAuthority'], true)
  // Smallest units as a decimal STRING. A JSON number silently loses the low digits of any
  // 18-decimal value above about 9 tokens, which on a supply figure is a wrong page.
  assert.equal(typeof answer.body['totalSupply'], 'string')
  assert.equal(answer.body['totalSupply'], '12000000000000000000000000')
  // The answer says which block it is as at, so a stale page can say how stale it is.
  assert.equal(answer.body['observedAtBlock'], 98)
  assert.equal(answer.body['observedAtBlockHash'], HASH)
})

test('an address with no observable token is 404 token_not_found, never a bare 404', async () => {
  // THE SPLIT THAT ENDS THE DEFECT. `micro-mint` read every 404 as "not indexed yet" and rendered
  // that on every project page for ever, because the path it asked for did not exist. A caller
  // branches on the CODE: `token_not_found` is this service's answer about a chain, `not_found` is
  // this service saying it does not serve the path — which is the caller's own misconfiguration.
  const empty = await call(`/tokens/ember/testnet/0x${'d'.repeat(40)}`, { token: 'reader' })
  assert.equal(empty.status, 404)
  assert.equal((empty.body['error'] as Record<string, string>)['code'], 'token_not_found')

  const wrongPath = await call(`/chains/ember/testnet/tokens/${TOKEN}`, { token: 'reader' })
  assert.equal(wrongPath.status, 404)
  assert.equal(
    (wrongPath.body['error'] as Record<string, string>)['code'],
    'not_found',
    'the exact path micro-mint used to request, and it must not look like an answer about a token',
  )
})

test('a chain this replica cannot ask is 503 with its reason, never "no token there"', async () => {
  // Every one of these is "we could not ask". Answering 404 would let a project page report a
  // renounced-nothing token because a provider was rate-limiting us.
  for (const [armed, status] of [
    ['chain_not_followed', 503],
    ['nothing_indexed', 503],
    ['head_diverged', 503],
    ['rpc_unavailable', 503],
    // A family whose contract state this build cannot read will not start working on retry.
    ['family_not_supported', 501],
  ] as const) {
    fault = armed
    const answer = await call(`/tokens/ember/testnet/${TOKEN}`, { token: 'reader' })
    assert.equal(answer.status, status, armed)
    assert.equal((answer.body['error'] as Record<string, string>)['code'], armed)
  }
  fault = null
})

test('the token route authorises and normalises exactly as every other read does', async () => {
  const path = `/tokens/ember/testnet/${TOKEN}`
  assert.equal((await call(path)).status, 200, 'a token\'s on-chain state is a public fact')
  assert.equal((await call(path, { token: 'player' })).status, 200)
  assert.equal((await call(path, { token: 'unscoped' })).status, 403)
  assert.equal((await call(path, { token: 'admin' })).status, 200)
  assert.equal((await call(`/v1/tokens/ember/testnet/${TOKEN}`, { token: 'reader' })).status, 200)

  // Checksummed in every explorer, stored lower-cased here. Accepting one spelling and not the
  // other would render "not yet indexed" for the address the customer actually holds.
  asked.length = 0
  const mixed = await call(`/tokens/ember/testnet/0x${'C'.repeat(40)}`, { token: 'reader' })
  assert.equal(mixed.status, 200)
  assert.equal(asked.at(-1)?.arg, TOKEN)

  const malformed = await call('/tokens/ember/testnet/0xnothex', { token: 'reader' })
  assert.equal(malformed.status, 400)
  assert.equal((malformed.body['error'] as Record<string, string>)['code'], 'bad_address')
  assert.equal((await call(`/tokens/doge/mainnet/${TOKEN}`, { token: 'reader' })).status, 404)
})

/* --------------------------------------- the custody aggregate */

test('the custody total is the one read that demands a token, and it says so with 401 not 200', async () => {
  // Every other read went anonymous because what it returns is already public — anyone may obtain
  // it by running a Hearth node. This one is Σ over a set only the platform knows, so running a
  // node does not tell you it. Anonymous must be refused, and refused in the direction that makes
  // the ledger record "no observation" rather than a number.
  assert.equal((await call('/custody/ember/testnet/total')).status, 401)
  assert.equal((await call('/custody/ember/testnet/total', { token: 'unscoped' })).status, 403)
  assert.equal((await call('/custody/ember/testnet/total', { token: 'player' })).status, 403)
  assert.equal((await call('/custody/ember/testnet/total', { token: 'reader' })).status, 200)
  assert.equal((await call('/custody/ember/testnet/total', { token: 'admin' })).status, 200)
})

test('a total answers with the number and the evidence, and never with an address', async () => {
  const answer = await call('/v1/custody/ember/testnet/total', { token: 'reader' })
  assert.equal(answer.status, 200)
  // A STRING. An 18-decimal balance does not survive a JSON number, and the digits a float would
  // drop are exactly where a reconciliation drift lives.
  assert.equal(answer.body['total'], '7000000000000000000')
  assert.equal(typeof answer.body['total'], 'string')
  // The evidence a caller needs to judge the number: how many addresses were in the sum, what
  // defined the set, and which block it is as at.
  assert.equal(answer.body['addresses'], 3)
  assert.deepEqual(answer.body['labelPrefixes'], ['deposit:', 'treasury:'])
  assert.equal(answer.body['observedAtBlock'], 39)
  assert.equal(answer.body['requiredConfirmations'], 60)
  // And NOT the members. The ledger must not learn which addresses are custody's, so no field of
  // this answer may carry one.
  assert.ok(!JSON.stringify(answer.body).includes(ADDRESS))
})

test('every refusal leaves as a non-200 carrying its code — never a 200, never a zero', async () => {
  // THE GUARD THE WHOLE ROUTE EXISTS FOR. A partial or defaulted total reads at the ledger as
  // positive drift, and positive drift freezes withdrawals for the asset. So there is no status
  // code on this route that means "some of it": either a number that may be believed, or a refusal
  // the client turns into `undefined`.
  const faults: Array<[CustodyTotalFault, number]> = [
    ['family_not_supported', 501],
    ['chain_not_followed', 503],
    ['nothing_indexed', 503],
    ['below_confirmation_depth', 503],
    ['depth_not_walked', 503],
    ['head_diverged', 503],
    ['chain_halted', 503],
    ['no_custody_addresses', 503],
    ['custody_set_too_large', 503],
    ['address_unreadable', 503],
    ['rpc_unavailable', 503],
  ]
  for (const [code, expected] of faults) {
    custodyFault = code
    const answer = await call('/custody/ember/testnet/total', { token: 'reader' })
    assert.equal(answer.status, expected, `${code} must answer ${expected}`)
    assert.equal((answer.body['error'] as Record<string, string>)['code'], code)
    // The two failures that would be read as an answer: a 200 with a total, and a 404 that a
    // consumer files as "no custody here" — which is a zero wearing a status code.
    assert.equal(answer.body['total'], undefined)
    assert.notEqual(answer.status, 404)
  }
  custodyFault = null
  assert.equal((await call('/custody/ember/testnet/total', { token: 'reader' })).status, 200)
})

/* --------------------------------------- the table two other repositories read */

test('the served route table is exactly this, in both spellings', () => {
  // A GOLDEN LIST, and its value is that it is annoying to change. `micro-mint`'s CI parses these
  // same paths out of `server.ts` and asserts its client asks for one of them, so a rename here is
  // a consumer 404 there. Renaming a route means editing this list, which means noticing.
  assert.deepEqual(
    [...ROUTE_PATTERNS],
    [
      'GET /v1/chains/:chain/:network/status',
      'GET /v1/addresses/:chain/:network/:address/activity',
      'GET /v1/addresses/:chain/:network/:address/token-balances',
      'GET /v1/transactions/:chain/:network/:hash',
      'GET /v1/transactions/:chain/:network/:hash/confirmations',
      'GET /v1/tokens/:chain/:network/:address',
      'GET /v1/custody/:chain/:network/total',
      'GET /v1/blocks/:chain/:network/:height',
      'POST /v1/watch/:chain/:network/:address',
      'POST /v1/backfills/:chain/:network',
      'GET /chains/:chain/:network/status',
      'GET /addresses/:chain/:network/:address/activity',
      'GET /addresses/:chain/:network/:address/token-balances',
      'GET /transactions/:chain/:network/:hash',
      'GET /transactions/:chain/:network/:hash/confirmations',
      'GET /tokens/:chain/:network/:address',
      'GET /custody/:chain/:network/total',
      'GET /blocks/:chain/:network/:height',
      'POST /watch/:chain/:network/:address',
      'POST /backfills/:chain/:network',
    ],
  )
})
