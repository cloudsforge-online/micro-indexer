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
  // 32 BYTES of key material, not 32 characters — the old fixture was 32 mixed-alphabet chars
  // carrying 24 bytes, so it pinned the length floor rather than the entropy bar.
  OUTBOX_SIGNING_SECRET: 'AYJA6kVxSWfFdSIATMrBpu/KnKg4hZmGAkXb0WjBi6Y=',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

const {
  EnvError,
  SERVICE,
  env,
  loadEnv,
  parseChainList,
  parseCustodyPrefixes,
  parseEndpoints,
  rpcVarFor,
} = await import('./env.ts')

const { slugOutsideTheUnion } = await import('./chains.ts')

/** Derived, never typed — `chains.ts` carries the two rounds of edits that argue for it. */
const notAChain = slugOutsideTheUnion()

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
  // `doge:mainnet` stood here as the unknown chain until DOGE became one, and `bnb:mainnet` after
  // it. The slug is derived now: the assertion is that the list is checked against the union rather
  // than parsed for shape, and a fixture that can age out of the union cannot make that assertion.
  assert.throws(() => parseChainList(`${notAChain}:mainnet`), EnvError)
  assert.throws(() => parseChainList('ember:devnet'), EnvError)
  assert.throws(() => parseChainList('ember:testnet,ember:testnet'), EnvError)
})

test('doge and etc are configurable chains, which is the point of adding them to the union', () => {
  // `parseChainList` validates against `isChainId`, so widening the type is the whole of what makes
  // an operator able to name either one. Nothing beyond this is wired: the estate runs no Dogecoin
  // or Ethereum Classic node, so a deployment that set these would also have to set
  // INDEXER_RPC_DOGE_MAINNET and INDEXER_RPC_ETC_MAINNET — and `loadEnv` refuses a chain with no
  // endpoint, which is what stops this from being followable by accident.
  assert.deepEqual(parseChainList('doge:mainnet,etc:mainnet'), [
    { chain: 'doge', network: 'mainnet' },
    { chain: 'etc', network: 'mainnet' },
  ])
  assert.throws(
    () => loadEnv({ ...BASE, INDEXER_CHAINS: 'etc:mainnet' }),
    (err: unknown) => err instanceof EnvError && /INDEXER_RPC_ETC_MAINNET is required/.test(err.message),
  )
})

test('a signing secret is measured in key material, not in characters', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'changeme' }),
    (err: unknown) => err instanceof EnvError && /placeholder/.test(err.message),
  )

  // This assertion used to read `/at least 24 characters/`, and that was the defect rather than
  // the check: it pinned CHARACTERS as the unit, which is the bar the real leak walked through.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }),
    (err: unknown) => err instanceof EnvError && /bytes of key material/.test(err.message),
  )

  // The value that actually ran as a live signing key across 44 containers on both networks. It is
  // 40 characters, so every length floor of 24 accepted it, and it was not among the eight strings
  // the old deny-list happened to name. Both of the old checks passed it; this one does not.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: `estate-only-outbox-secret-${'0'.repeat(14)}` }),
    EnvError,
  )

  // 24 characters of one repeated character clears any 24-char floor and carries almost nothing.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'x'.repeat(24) }), EnvError)

  // And the control that makes the four refusals meaningful: a genuine key still boots. Without
  // this, a guard that refused everything would pass every assertion above.
  assert.ok(loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: BASE.OUTBOX_SIGNING_SECRET }))
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

test('the narrowed address record defaults ON, and a typo cannot silently turn it off', () => {
  assert.equal(loadEnv(BASE).watchedAddressesOnly, true, 'the disk arithmetic is the default')
  assert.equal(loadEnv({ ...BASE, INDEXER_WATCHED_ADDRESSES_ONLY: 'false' }).watchedAddressesOnly, false)
  assert.equal(loadEnv({ ...BASE, INDEXER_WATCHED_ADDRESSES_ONLY: ' TRUE ' }).watchedAddressesOnly, true)
  // The usual `raw !== 'false'` would read every one of these as ON while the operator believed
  // otherwise, and the difference between those two beliefs is which addresses get recorded.
  for (const typo of ['0', '1', 'no', 'yes', 'off', 'ture']) {
    assert.throws(
      () => loadEnv({ ...BASE, INDEXER_WATCHED_ADDRESSES_ONLY: typo }),
      EnvError,
      `${typo} was guessed at rather than refused`,
    )
  }
})

test('the custody set has a default, and an empty definition of it is refused', () => {
  // The default is the prefix micro-wallet actually writes plus the one micro-settlement will need.
  assert.deepEqual([...loadEnv(BASE).custodyLabelPrefixes], ['deposit:', 'treasury:'])
  assert.deepEqual([...parseCustodyPrefixes(' a: , b: ')], ['a:', 'b:'])

  // AN EMPTY SET IS NOT "EVERYTHING" AND IT IS NOT "NOTHING". It matches no address, so the total
  // would be zero over zero addresses — "we did not look" reported as "the chain holds nothing",
  // which is the exact defect this whole path removes.
  assert.throws(() => parseCustodyPrefixes(''), EnvError)
  assert.throws(() => parseCustodyPrefixes('  ,  '), EnvError)
  // A variable set to whitespace is UNSET as far as `optional` is concerned, so it takes the
  // default rather than producing an empty set. Stated here because the two look alike in a
  // compose file and only one of them is a configuration mistake.
  assert.deepEqual(
    [...loadEnv({ ...BASE, INDEXER_CUSTODY_LABEL_PREFIXES: '  ' }).custodyLabelPrefixes],
    ['deposit:', 'treasury:'],
  )
  // And a value that is present but matches nothing IS refused, at the variable rather than at the
  // first reconciliation.
  assert.throws(() => loadEnv({ ...BASE, INDEXER_CUSTODY_LABEL_PREFIXES: ',,' }), EnvError)
  assert.throws(() => parseCustodyPrefixes('dep%'), EnvError)
  assert.throws(() => parseCustodyPrefixes('a:,a:'), EnvError)
})

test('the custody bounds are bounded, because the alternative to a bound is a partial sum', () => {
  assert.equal(loadEnv(BASE).custodyMaxAddresses, 2_000)
  assert.equal(loadEnv(BASE).custodyConcurrency, 8)
  assert.throws(() => loadEnv({ ...BASE, INDEXER_CUSTODY_MAX_ADDRESSES: '0' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, INDEXER_CUSTODY_CONCURRENCY: '0' }), EnvError)
  assert.equal(loadEnv({ ...BASE, INDEXER_CUSTODY_MAX_ADDRESSES: '50' }).custodyMaxAddresses, 50)
})
