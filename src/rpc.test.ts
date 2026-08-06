import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HttpClient } from '@cloudsforge/http'
import { FakeChain, deadClient, fakeClient, throttledClient } from './fakechain.ts'
import { RpcError, RpcPool, RpcUnavailableError, basicAuthFor } from './rpc.ts'

const SCOPE = { chain: 'ember', network: 'testnet' } as const

function poolOf(
  clients: Record<string, Pick<HttpClient, 'request'>>,
  now: () => number = () => 1_700_000_000_000,
  onFailure?: (provider: string, err: unknown) => void,
): RpcPool {
  return new RpcPool({
    scope: SCOPE,
    endpoints: Object.keys(clients).map((name) => ({
      name,
      url: `http://${name}.invalid:8545/rpc`,
    })),
    now,
    clientFor: (endpoint) => {
      const client = clients[endpoint.name]
      if (!client) throw new Error(`no client for ${endpoint.name}`)
      return client
    },
    ...(onFailure ? { onFailure } : {}),
  })
}

test('a pool with no endpoints is refused at construction', () => {
  assert.throws(
    () => new RpcPool({ scope: SCOPE, endpoints: [] }),
    /at least one endpoint/,
  )
})

test('the primary fails, the secondary serves, and both facts are recorded', async () => {
  const chain = new FakeChain()
  chain.appendMany(3)
  const failures: string[] = []
  const pool = poolOf(
    { primary: deadClient(), secondary: fakeClient(chain) },
    () => 1_700_000_000_000,
    (provider) => failures.push(provider),
  )

  const tip = await pool.call<string>('eth_blockNumber')
  assert.equal(Number(BigInt(tip)), 3)
  assert.deepEqual(failures, ['primary'], 'the failure metric fires once, naming the provider')

  const [primary, secondary] = pool.snapshot()
  assert.ok(primary && secondary)
  assert.equal(primary.provider, 'primary')
  assert.equal(primary.state, 'degraded')
  assert.equal(primary.totalFailures, 1)
  assert.equal(primary.consecutiveFailures, 1)
  assert.match(primary.lastError ?? '', /http 502/)
  // Never the URL: an RPC endpoint's query string is where the API key lives.
  assert.equal(primary.urlHost, 'primary.invalid:8545')
  assert.equal(secondary.state, 'healthy')
  assert.equal(secondary.totalFailures, 0)
  assert.ok(secondary.lastOkAt instanceof Date)
})

test('a provider that has failed is tried last, so recovery does not cost every call a timeout', async () => {
  const chain = new FakeChain()
  const attempts: string[] = []
  const watch = (name: string, inner: Pick<HttpClient, 'request'>): Pick<HttpClient, 'request'> => ({
    async request(path, options) {
      attempts.push(name)
      return inner.request(path, options)
    },
  })
  const pool = poolOf({
    primary: watch('primary', deadClient()),
    secondary: watch('secondary', fakeClient(chain)),
  })

  await pool.call('eth_blockNumber')
  attempts.length = 0
  await pool.call('eth_blockNumber')
  assert.deepEqual(attempts, ['secondary'], 'the healthy provider is now first and answers alone')
})

test('a provider that is down for every endpoint surfaces as unavailable, not as a domain error', async () => {
  const pool = poolOf({ a: deadClient(), b: deadClient(503) })
  await assert.rejects(
    () => pool.call('eth_blockNumber'),
    (err: unknown) => {
      assert.ok(err instanceof RpcUnavailableError)
      assert.deepEqual([...err.attempted], ['a', 'b'])
      return true
    },
  )
  // The follower treats this as "no progress this tick" rather than as a job failure, so a
  // recurring job does not burn its attempt budget on a provider outage and dead-letter.
  for (const health of pool.snapshot()) {
    assert.equal(health.state, 'degraded')
  }
})

test('a JSON-RPC refusal is a domain error: it does not fail over and it does not demote', async () => {
  const chain = new FakeChain()
  const pool = poolOf({ only: fakeClient(chain) })
  await assert.rejects(
    () => pool.call('eth_notAMethod'),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, -32601)
      assert.equal(err.provider, 'only')
      return true
    },
  )
  // A provider that answered is a healthy provider even when the answer is "no". Counting this as
  // a failure would demote every endpoint the first time we asked for something one of them lacks.
  assert.equal(pool.snapshot()[0]?.state, 'healthy')
})

test('a 429 puts one provider into exponential backoff and leaves the others alone', async () => {
  const chain = new FakeChain()
  chain.appendMany(2)
  let now = 1_700_000_000_000
  const pool = poolOf({ throttled: throttledClient(), spare: fakeClient(chain) }, () => now)

  await pool.call('eth_blockNumber')
  const first = pool.snapshot()[0]
  assert.ok(first?.rateLimitedUntil)
  assert.equal(first.rateLimitedUntil.getTime(), now + 1_000)

  // The spare is healthy, so the throttled endpoint is not needed and is not called at all.
  assert.equal(pool.snapshot()[1]?.totalRequests, 1)

  // Inside the window the throttled provider is skipped entirely: calling it is what extends the
  // throttle, so it is dropped from the order rather than merely sorted last. Pairing it with a
  // dead spare is what makes its absence observable — otherwise the healthy provider answers
  // first and nothing can be concluded about the throttled one.
  const attempts: string[] = []
  const pool2 = new RpcPool({
    scope: SCOPE,
    endpoints: [
      { name: 'throttled', url: 'http://t.invalid/' },
      { name: 'spare', url: 'http://s.invalid/' },
    ],
    now: () => now,
    clientFor: (endpoint) => ({
      async request(path, options) {
        attempts.push(endpoint.name)
        return endpoint.name === 'throttled'
          ? throttledClient().request(path, options)
          : deadClient().request(path, options)
      },
    }),
  })
  await assert.rejects(() => pool2.call('eth_blockNumber'), RpcUnavailableError)
  assert.deepEqual(attempts, ['throttled', 'spare'])

  attempts.length = 0
  await assert.rejects(() => pool2.call('eth_blockNumber'), RpcUnavailableError)
  assert.deepEqual(attempts, ['spare'], 'the throttled endpoint is not called inside its window')

  // Once the window passes it is tried again, and a second throttle doubles the wait.
  now += 1_001
  attempts.length = 0
  await assert.rejects(() => pool2.call('eth_blockNumber'), RpcUnavailableError)
  assert.deepEqual([...attempts].sort(), ['spare', 'throttled'])
  assert.equal(pool2.snapshot()[0]?.rateLimitedUntil?.getTime(), now + 2_000)
})

test('every provider in backoff is unavailability, and it names why', async () => {
  let now = 1_700_000_000_000
  const pool = poolOf({ only: throttledClient() }, () => now)
  await assert.rejects(() => pool.call('eth_blockNumber'), RpcUnavailableError)
  await assert.rejects(
    () => pool.call('eth_blockNumber'),
    (err: unknown) => err instanceof RpcUnavailableError && /rate-limit backoff/.test(err.message),
  )
  now += 60_000
})

test('a success clears the failure streak and the backoff', async () => {
  const chain = new FakeChain()
  let broken = true
  const pool = poolOf({
    flaky: {
      async request(path, options) {
        if (broken) return deadClient().request(path, options)
        return fakeClient(chain).request(path, options)
      },
    },
  })
  await assert.rejects(() => pool.call('eth_blockNumber'), RpcUnavailableError)
  await assert.rejects(() => pool.call('eth_blockNumber'), RpcUnavailableError)
  await assert.rejects(() => pool.call('eth_blockNumber'), RpcUnavailableError)
  assert.equal(pool.snapshot()[0]?.state, 'down')

  broken = false
  await pool.call('eth_blockNumber')
  const health = pool.snapshot()[0]
  assert.equal(health?.state, 'healthy')
  assert.equal(health?.consecutiveFailures, 0)
  assert.equal(health?.rateLimitedUntil, null)
  // Totals are cumulative, so the incident is still visible after recovery.
  assert.equal(health?.totalFailures, 3)
  assert.equal(health?.totalRequests, 4)
})

/**
 * Regression. `URL.origin` discards userinfo, so a credential written into an RPC endpoint url was
 * dropped before the request was built.
 *
 * **Why this survived is the point: it fails as a 401**, which is exactly what a wrong password
 * looks like. Every diagnosis therefore pointed at the credential — the node's config, the rpcauth
 * hash, the password itself — and never at the client that silently declined to send it. It cost a
 * Litecoin integration most of a session, and `settlement/src/registry.ts` has the same shape.
 *
 * Bitcoin Core and its forks authenticate RPC with HTTP Basic and offer nothing else, so without
 * this a self-hosted node is unreachable no matter how the credential is configured.
 */
test('a credential in an rpc url survives URL.origin and reaches the request', () => {
  const header = basicAuthFor('http://someuser:s0me-p4ss@127.0.0.1:50002')
  assert.ok(header !== undefined, 'credentials in the url must produce an Authorization header')

  // Decoded rather than compared against a base64 literal, so the assertion states the PROPERTY —
  // the node receives the user and password it was given — instead of pinning one spelling of it.
  const decoded = Buffer.from(header.replace(/^Basic /, ''), 'base64').toString()
  assert.equal(decoded, 'someuser:s0me-p4ss')
})

test('percent-encoded credentials are decoded, because a generated password may contain @ or :', () => {
  const header = basicAuthFor('http://user%40host:p%3Ass%2Fword@127.0.0.1:50002')
  const decoded = Buffer.from(String(header).replace(/^Basic /, ''), 'base64').toString()
  assert.equal(decoded, 'user@host:p:ss/word')
})

test('a url with no credentials sends no header, because an empty one is refused outright', () => {
  // The control. Without it, a helper that returned a header unconditionally would pass both of
  // the assertions above while breaking every anonymous endpoint in the estate.
  assert.equal(basicAuthFor('http://127.0.0.1:8545'), undefined)
})
