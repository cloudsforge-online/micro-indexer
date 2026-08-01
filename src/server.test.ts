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
import { READ_SCOPE, WRITE_SCOPE, createServer } from './server.ts'

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

test('a read needs a service token carrying indexer:read', async () => {
  assert.equal((await call('/chains/ember/testnet/status')).status, 401)
  assert.equal((await call('/chains/ember/testnet/status', { token: 'nope' })).status, 401)
  assert.equal((await call('/chains/ember/testnet/status', { token: 'unscoped' })).status, 403)
  assert.equal((await call('/chains/ember/testnet/status', { token: 'reader' })).status, 200)
  // One level of wildcard, which `indexer:*` is.
  assert.equal((await call('/chains/ember/testnet/status', { token: 'wildcard' })).status, 200)
})

test('an ordinary user token is refused; an operator is not', async () => {
  // Address ownership is a fact `wallet` holds and this service does not, so the indexer must not
  // be the place that guesses whether a user may read an address.
  assert.equal((await call('/chains/ember/testnet/status', { token: 'player' })).status, 403)
  assert.equal((await call('/chains/ember/testnet/status', { token: 'admin' })).status, 200)
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
  const response = await fetch(`${base}/chains/ember/testnet/status`, {
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

test('both new routes need indexer:read like every other read', async () => {
  for (const path of [
    `/transactions/ember/testnet/${HASH}/confirmations`,
    `/addresses/ember/testnet/${ADDRESS}/token-balances`,
  ]) {
    assert.equal((await call(path)).status, 401, path)
    assert.equal((await call(path, { token: 'unscoped' })).status, 403, path)
    assert.equal((await call(path, { token: 'player' })).status, 403, path)
    assert.equal((await call(path, { token: 'reader' })).status, 200, path)
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
