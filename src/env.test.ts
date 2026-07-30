import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const BASE: Record<string, string> = {
  INDEXER_DATABASE_URL: 'postgres://cloudsforge@127.0.0.1:5432/indexer',
  IDENTITY_JWKS_URL: 'https://id.example/.well-known/jwks.json',
  IDENTITY_ISSUER: 'https://id.example',
  OUTBOX_SIGNING_SECRET: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv, parseChainList, parseEndpoints, rpcVarFor } =
  await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, BASE['INDEXER_DATABASE_URL'])
  assert.equal(SERVICE, 'indexer')
})

test('a service with no chains configured still loads — it may serve reads only', () => {
  const loaded = loadEnv(BASE, 'host-1')
  assert.deepEqual(loaded.chains, [])
  assert.equal(loaded.port, 4008)
  assert.equal(loaded.instanceId, 'host-1')
})

test('a configured chain without an endpoint is refused at boot, not at the first tick', () => {
  // A follower with no provider reports healthy and indexes nothing, which is the failure mode of
  // the thing this service replaces.
  assert.throws(
    () => loadEnv({ ...BASE, INDEXER_CHAINS: 'ember:testnet' }),
    (err: unknown) => err instanceof EnvError && /INDEXER_RPC_EMBER_TESTNET is required/.test(err.message),
  )
})

test('an endpoint configured for a chain nobody follows is refused', () => {
  assert.throws(
    () =>
      loadEnv({
        ...BASE,
        INDEXER_CHAINS: 'ember:testnet',
        INDEXER_RPC_EMBER_TESTNET: 'local=http://127.0.0.1:8545',
        INDEXER_RPC_ETH_MAINNET: 'infura=https://mainnet.example',
      }),
    (err: unknown) =>
      err instanceof EnvError && /INDEXER_CHAINS does not list eth:mainnet/.test(err.message),
  )
})

test('the happy path produces a scoped chain with named endpoints', () => {
  const loaded = loadEnv({
    ...BASE,
    INDEXER_CHAINS: 'ember:testnet,eth:testnet',
    INDEXER_RPC_EMBER_TESTNET: 'hearth-local=http://127.0.0.1:8545',
    INDEXER_RPC_ETH_TESTNET: 'a=https://a.example/rpc,b=https://b.example/rpc',
    INDEXER_START_HEIGHT_EMBER_TESTNET: '5000',
  })
  assert.equal(loaded.chains.length, 2)
  const ember = loaded.chains[0]
  assert.ok(ember)
  assert.deepEqual(ember.scope, { chain: 'ember', network: 'testnet' })
  assert.deepEqual([...ember.endpoints], [{ name: 'hearth-local', url: 'http://127.0.0.1:8545' }])
  assert.equal(ember.startHeight, 5_000)
  assert.equal(loaded.chains[1]?.endpoints.length, 2)
  assert.equal(rpcVarFor({ chain: 'eth', network: 'testnet' }), 'INDEXER_RPC_ETH_TESTNET')
})

test('an endpoint name defaults to the host, and a duplicate name is refused', () => {
  const parsed = parseEndpoints('X', 'https://a.example/rpc, named=https://b.example/rpc')
  assert.deepEqual([...parsed], [
    { name: 'a.example', url: 'https://a.example/rpc' },
    { name: 'named', url: 'https://b.example/rpc' },
  ])
  // Health is keyed on the name, so two endpoints sharing one would average a working provider
  // with a broken one into a single row that describes neither.
  assert.throws(
    () => parseEndpoints('X', 'same=https://a.example, same=https://b.example'),
    (err: unknown) => err instanceof EnvError && /names same twice/.test(err.message),
  )
})

test('an API key in the query string survives parsing and never reaches the error message', () => {
  const parsed = parseEndpoints('X', 'infura=https://mainnet.example/v3?key=SUPERSECRETVALUE')
  assert.equal(parsed[0]?.url, 'https://mainnet.example/v3?key=SUPERSECRETVALUE')
  assert.equal(parsed[0]?.name, 'infura')
  try {
    parseEndpoints('X', 'infura=not-a-url?key=SUPERSECRETVALUE')
    assert.fail('expected a throw')
  } catch (err) {
    assert.ok(err instanceof EnvError)
    assert.equal(/SUPERSECRETVALUE/.test(err.message), false, 'the value must never be echoed')
  }
})

test('a non-http endpoint is refused', () => {
  assert.throws(() => parseEndpoints('X', 'ws=wss://a.example'), EnvError)
})

test('the chain list refuses an unknown chain, an unknown network and a duplicate', () => {
  assert.deepEqual(parseChainList('ember:testnet'), [{ chain: 'ember', network: 'testnet' }])
  assert.throws(() => parseChainList('doge:mainnet'), EnvError)
  assert.throws(() => parseChainList('ember:devnet'), EnvError)
  assert.throws(() => parseChainList('ember:testnet,ember:testnet'), EnvError)
})

test('a placeholder signing secret is refused outright', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'changeme' }),
    (err: unknown) => err instanceof EnvError && /placeholder/.test(err.message),
  )
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }),
    (err: unknown) => err instanceof EnvError && /at least 24 characters/.test(err.message),
  )
})

test('exactly one connection-string variable is declared', () => {
  // Rule 1 of docs/ecosystem/03 §2. A second one here is what CI greps for.
  assert.equal(loadEnv(BASE).databaseUrl, BASE['INDEXER_DATABASE_URL'])
})

test('batch sizes and deadlines are bounded, because an unbounded tick outlives its lease', () => {
  assert.throws(() => loadEnv({ ...BASE, INDEXER_FOLLOW_BATCH_BLOCKS: '0' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, INDEXER_FOLLOW_BATCH_BLOCKS: '10000' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, INDEXER_RPC_DEADLINE_MS: '10' }), EnvError)
  assert.equal(loadEnv({ ...BASE, INDEXER_FOLLOW_BATCH_BLOCKS: '100' }).followBatchBlocks, 100)
})
