/**
 * The custody aggregate, and every way it must refuse.
 *
 * The happy path is one assertion. **The rest of this file is the refusals**, because the refusals
 * are the correctness: a total that is wrong in the low direction reads at `micro-ledger` as
 * positive drift, and positive drift freezes withdrawals for the asset. So each test below breaks
 * one input and asserts the observation is withheld rather than adjusted, defaulted, or summed
 * over what happened to answer.
 *
 * Against a real Postgres, per the estate's convention — the coverage, head and label predicates
 * are SQL, and a fake store would be testing the fake.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import type { ChainScope } from './chains.ts'
import {
  CustodyTotalUnavailableError,
  hexQuantity,
  rpcCustodyObserver,
  type CustodyObserver,
  type CustodyTotalFault,
} from './custody.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import type { Db } from './outbox.ts'
import { RpcError, RpcUnavailableError } from './rpc.ts'
import type { RpcCaller } from './tokenstate.ts'
import {
  TIP_STREAM,
  activityEntryKey,
  custodyAddressHistory,
  haltChain,
  recordSpends,
  setCheckpoint,
  upsertActivity,
  upsertBlock,
  upsertTransaction,
  watchAddress,
} from './store.ts'

/* ------------------------------------------------------------------ pure */

test('a hex quantity is parsed, and everything that is not one is refused rather than coerced', () => {
  assert.equal(hexQuantity('0x0'), 0n)
  assert.equal(hexQuantity('0x1a'), 26n)
  assert.equal(hexQuantity(`0x${'f'.repeat(64)}`), 2n ** 256n - 1n)
  // The three answers that would otherwise become a zero balance summed into a total. `BigInt('')`
  // is `0n` — the whole defect this release removed, one encoding down.
  assert.equal(hexQuantity(''), null)
  assert.equal(hexQuantity('0x'), null)
  assert.equal(hexQuantity(null), null)
  assert.equal(hexQuantity(undefined), null)
  // A JSON number is not a QUANTITY. Accepting one would silently round any balance above 2^53.
  assert.equal(hexQuantity(26), null)
  // Not decimal, not negative, not padded prose.
  assert.equal(hexQuantity('26'), null)
  assert.equal(hexQuantity('-0x1a'), null)
  assert.equal(hexQuantity('0x1a '), null)
})

/* ------------------------------------------------------------------ database-backed */

const url = process.env['INDEXER_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'

const SCOPE: ChainScope = { chain: 'ember', network: 'testnet' }
const CONFIRMATIONS = 60
/** A head high enough that `head − 60 + 1` is a real height. */
const HEAD = 100
const AT = HEAD - CONFIRMATIONS + 1

const hashAt = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`

let sql: Db

/**
 * A provider whose every answer is a decision the test makes.
 *
 * `balances` is keyed by address, and an address that is absent is a call the provider REFUSES —
 * not one that answers zero. That distinction is the file under test.
 */
interface FakeChain {
  blockHashAt: (height: number) => string | null
  balances: Map<string, string>
  /** Fires before each `eth_getBalance`, so a test can reorg the chain mid-sweep. */
  onBalance?: (address: string, index: number) => void
  calls: string[]
}

function fakeCaller(chain: FakeChain): RpcCaller {
  let index = 0
  return {
    async call<T>(method: string, params?: readonly unknown[]): Promise<T> {
      chain.calls.push(method)
      if (method === 'eth_getBlockByNumber') {
        const height = Number(String(params?.[0] ?? '0x0'))
        const hash = chain.blockHashAt(height)
        return (hash === null ? null : { hash }) as T
      }
      if (method === 'eth_getBalance') {
        const address = String(params?.[0] ?? '')
        chain.onBalance?.(address, index++)
        const balance = chain.balances.get(address)
        if (balance === undefined) {
          throw new RpcError({
            code: -32000,
            message: 'missing trie node',
            method,
            provider: 'fake',
          })
        }
        return balance as T
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
}

function observer(chain: FakeChain, over: Partial<{ maxAddresses: number }> = {}): CustodyObserver {
  return rpcCustodyObserver({
    sql,
    callers: new Map([['ember:testnet', fakeCaller(chain)]]),
    labelPrefixes: ['deposit:', 'treasury:'],
    maxAddresses: over.maxAddresses ?? 2_000,
    concurrency: 4,
  })
}

/** Assert the observation was withheld, and withheld for the stated reason. */
async function refuses(observe: CustodyObserver, code: CustodyTotalFault): Promise<void> {
  await assertRefusal(() => observe.total(SCOPE), code)
}

/** The same, for the single-address reading. Same decision, same code, different entry point. */
async function refusesBalance(observe: CustodyObserver, code: CustodyTotalFault): Promise<void> {
  await assertRefusal(() => observe.balance(SCOPE, '0xaa'), code)
}

async function assertRefusal(act: () => Promise<unknown>, code: CustodyTotalFault): Promise<void> {
  await assert.rejects(
    act,
    (err: unknown) => {
      assert.ok(
        err instanceof CustodyTotalUnavailableError,
        `expected a refusal, got ${String(err)}`,
      )
      assert.equal(err.code, code)
      return true
    },
  )
}

before(async () => {
  if (!enabled) return
  sql = postgres(url!, { max: 4, onnotice: () => {} }) as unknown as Db
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'indexer-custody-test' })
})

after(async () => {
  if (!enabled) return
  await (sql as unknown as { end: (o: object) => Promise<void> }).end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  for (const table of CHAIN_TABLES) await sql.unsafe(`truncate table ${table} cascade`)
})

/** A canonical chain of `0..HEAD`, and a tip checkpoint that is not halted. */
async function walkChain(upTo = HEAD): Promise<void> {
  for (let height = 0; height <= upTo; height += 1) {
    await upsertBlock(sql, SCOPE, {
      height,
      hash: hashAt(height),
      parentHash: height === 0 ? hashAt(0) : hashAt(height - 1),
      blockTime: new Date(1_700_000_000_000 + height * 15_000),
      txCount: 0,
      detail: {},
    })
  }
  await setCheckpoint(sql, SCOPE, TIP_STREAM, upTo, hashAt(upTo))
}

function honestChain(): FakeChain {
  return { blockHashAt: (h) => hashAt(h), balances: new Map(), calls: [] }
}

/* --------------------------------------- the answer */

test('a complete read of a complete custody set is a total at the confirmed depth', { skip }, async () => {
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await watchAddress(sql, SCOPE, '0xbb', 'deposit:u-2')
  await watchAddress(sql, SCOPE, '0xcc', 'treasury:hot')

  const chain = honestChain()
  chain.balances.set('0xaa', '0x1')
  chain.balances.set('0xbb', '0x2')
  chain.balances.set('0xcc', '0x0')

  const observed = await observer(chain).total(SCOPE)

  assert.equal(observed.total, '3')
  assert.equal(observed.addresses, 3)
  assert.equal(observed.assetCode, 'EMBER')
  // The depth is the chain's own, and the block is `head − confirmations + 1` — the highest block
  // that HAS the depth, because the block containing a transaction is its first confirmation.
  assert.equal(observed.requiredConfirmations, CONFIRMATIONS)
  assert.equal(observed.observedAtBlock, AT)
  assert.equal(observed.headHeight, HEAD)
  assert.equal(observed.observedAtBlockHash, hashAt(AT))
  // Every balance was read at that height, not at the head.
  assert.equal(chain.calls.filter((c) => c === 'eth_getBalance').length, 3)
  // The hash is proved before the reads AND after them. See the header: `eth_getBalance` takes a
  // height, so a reorg mid-sweep would mix two chains into one sum.
  assert.equal(chain.calls.filter((c) => c === 'eth_getBlockByNumber').length, 2)
})

test('the total carries the same total split by bucket, and still discloses no address', { skip }, async () => {
  // Step 5 of micro-org#248: a freeze must name its own cause. Two numbers say the estate and the
  // chain disagree; they do not say WHERE, and deposits and treasury float are different money held
  // by different code. The split is what turns "drift 3" into "drift 3, and it is all in treasury".
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await watchAddress(sql, SCOPE, '0xbb', 'deposit:u-2')
  await watchAddress(sql, SCOPE, '0xcc', 'treasury:hot')
  // Not custody, so it is in neither bucket and in no total. The parts-equal-whole assertion is
  // only worth something if the set it is taken over is the set that was summed.
  await watchAddress(sql, SCOPE, '0xdd', 'member:u-9')

  const chain = honestChain()
  chain.balances.set('0xaa', '0x1')
  chain.balances.set('0xbb', '0x2')
  chain.balances.set('0xcc', '0x4')

  const observed = await observer(chain).total(SCOPE)

  assert.equal(observed.total, '7')
  assert.equal(observed.addresses, 3)
  assert.deepEqual(observed.byLabelPrefix, [
    { prefix: 'deposit:', addresses: 2, total: '3' },
    { prefix: 'treasury:', addresses: 1, total: '4' },
  ])
  // In CONFIGURED order, which is the order the freeze message will read in — not whichever order
  // the rows happened to arrive in.
  assert.deepEqual(
    observed.byLabelPrefix.map((b) => b.prefix),
    [...observed.labelPrefixes],
  )
  // The property the aggregate promises and asserts internally, re-proved from outside: the parts
  // add up to the whole, in both money and cardinality. A breakdown that does not is worse than
  // none, because it is read during an incident by somebody deciding who is wrong.
  assert.equal(
    observed.byLabelPrefix.reduce((sum, b) => sum + BigInt(b.total), 0n).toString(),
    observed.total,
  )
  assert.equal(
    observed.byLabelPrefix.reduce((sum, b) => sum + b.addresses, 0),
    observed.addresses,
  )
  // And no address travels with it. The disclosure argument is unchanged by the split: the caller
  // must not learn the set, and two aggregates disclose no more of it than one did.
  const wire = JSON.stringify(observed)
  for (const address of ['0xaa', '0xbb', '0xcc', '0xdd']) assert.ok(!wire.includes(address))
})

test('a prefix that matched nothing is reported at zero, not left out', { skip }, async () => {
  // An absent bucket is ambiguous — empty, or the definition changed underneath the operator? —
  // and that ambiguity would be read at three in the morning. Every configured prefix answers.
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  const chain = honestChain()
  chain.balances.set('0xaa', '0x5')

  const observed = await observer(chain).total(SCOPE)
  assert.deepEqual(observed.byLabelPrefix, [
    { prefix: 'deposit:', addresses: 1, total: '5' },
    { prefix: 'treasury:', addresses: 0, total: '0' },
  ])
})

test('a balance of zero at every address IS a total, because every address was read', { skip }, async () => {
  // The distinction the whole release turns on: a measured zero is an answer, an unmeasured zero
  // is a lie. This is the first kind, and it must not be refused.
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  const chain = honestChain()
  chain.balances.set('0xaa', '0x0')
  assert.equal((await observer(chain).total(SCOPE)).total, '0')
})

/* --------------------------------------- one address, the same measurement */

test('one address is read at the aggregate’s height, from the same proved block', { skip }, async () => {
  // THE PROPERTY THE CALLER'S CORRECTNESS RESTS ON. A service booking an opening position for an
  // address it is about to register must book what the aggregate will later count for it. If this
  // read were taken at `latest` it would include coin below the confirmation depth, the book would
  // be high by exactly that, and a zero-tolerance asset would freeze — which is the incident of
  // 2026-08-05 reproduced by its own fix.
  await walkChain()
  const chain = honestChain()
  chain.balances.set('0xcc', '0x15c551d03b64e0000') // 25.1e18

  const observed = await observer(chain).balance(SCOPE, '0xcc')

  assert.equal(observed.balance, '25100000000000000000')
  assert.equal(observed.address, '0xcc')
  assert.equal(observed.assetCode, 'EMBER')
  assert.equal(observed.requiredConfirmations, CONFIRMATIONS)
  assert.equal(observed.observedAtBlock, AT)
  assert.equal(observed.observedAtBlockHash, hashAt(AT))
  assert.equal(observed.headHeight, HEAD)
  // Read once, and the hash proved before and after — the same two-sided proof the aggregate makes,
  // because a single balance answered across a reorg is as wrong as a sum answered across one.
  assert.equal(chain.calls.filter((c) => c === 'eth_getBalance').length, 1)
  assert.equal(chain.calls.filter((c) => c === 'eth_getBlockByNumber').length, 2)
})

test('an UNWATCHED address is answered, because the caller measures before it registers', { skip }, async () => {
  // Deliberate, and the whole ordering depends on it. The caller reads the balance, THEN watches,
  // THEN books. Demanding registration first would force the opposite order and reopen the window
  // this route was added to close. Nothing here consults `watched_addresses` at all.
  await walkChain()
  const chain = honestChain()
  chain.balances.set('0xdd', '0x7b')
  assert.equal((await observer(chain).balance(SCOPE, '0xdd')).balance, '123')
})

test('a measured zero is an answer here too, and an unreadable address is still a refusal', { skip }, async () => {
  await walkChain()
  const chain = honestChain()
  chain.balances.set('0xaa', '0x0')
  assert.equal((await observer(chain).balance(SCOPE, '0xaa')).balance, '0')

  // And the address the provider will not answer for. Zero would be booked as a permanent
  // understatement, so it must arrive as a refusal that leaves the row unregistered and retried.
  await assert.rejects(
    () => observer(chain).balance(SCOPE, '0xbb'),
    (err: unknown) => {
      assert.ok(err instanceof CustodyTotalUnavailableError)
      assert.equal(err.code, 'address_unreadable')
      return true
    },
  )
})

test('every refusal the aggregate makes about the CHAIN, one address makes too', { skip }, async () => {
  // The anchor is shared code, so this is really asserting that it stayed shared: a halted chain, a
  // node serving a different block, and a chain with nothing walked are all decisions about the
  // height being read at, and they cannot be true for the set and false for one member of it.
  const chain = honestChain()
  chain.balances.set('0xaa', '0x1')

  // Nothing walked at all.
  await refusesBalance(observer(chain), 'nothing_indexed')

  // A node serving a different block at the confirmed height, refused BEFORE the balance is read.
  await walkChain()
  const liar = honestChain()
  liar.balances.set('0xaa', '0x1')
  liar.blockHashAt = () => hashAt(999)
  await refusesBalance(observer(liar), 'head_diverged')
  assert.equal(liar.calls.filter((c) => c === 'eth_getBalance').length, 0)

  // And a halted chain. `haltChain` is one-way on purpose — a machine deciding a reorg assumption
  // has come back is a machine deciding it is safe to credit money again — so this goes last.
  await haltChain(sql, SCOPE, 'an alarming reorg')
  await refusesBalance(observer(chain), 'chain_halted')
})

/* --------------------------------------- the refusals */

test('one unreadable address withholds the WHOLE total, rather than summing the rest', { skip }, async () => {
  // THE GUARD THIS FILE EXISTS FOR. Three addresses, one provider failure. The tempting answer is
  // 3 — the two that answered — and it would be low, and low reads at the ledger as positive drift,
  // and positive drift freezes every withdrawal of the asset on the strength of one RPC timeout.
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await watchAddress(sql, SCOPE, '0xbb', 'deposit:u-2')
  await watchAddress(sql, SCOPE, '0xcc', 'deposit:u-3')

  const chain = honestChain()
  chain.balances.set('0xaa', '0x1')
  chain.balances.set('0xbb', '0x2')
  // 0xcc absent — the provider refuses it.
  await refuses(observer(chain), 'address_unreadable')
})

test('a provider that answers a balance with something that is not a quantity is refused', { skip }, async () => {
  // `BigInt('')` is `0n`. A provider answering `""` for a balance it could not compute would
  // otherwise contribute a silent zero, and the total would be short by exactly one account with
  // nothing at all to show for it.
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  const chain = honestChain()
  chain.balances.set('0xaa', '')
  await refuses(observer(chain), 'address_unreadable')
})

test('a provider nobody could reach is refused, and named differently from one that refused', { skip }, async () => {
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  const chain = honestChain()
  chain.onBalance = () => {
    throw new RpcUnavailableError('eth_getBalance', ['fake'], 'timeout')
  }
  await refuses(observer(chain), 'rpc_unavailable')
})

test('an empty custody set is refused, because nobody registering an address is not holding nothing', { skip }, async () => {
  await walkChain()
  // Watched, but not custody's. A market this service follows for `micro-foresight` must never be
  // summed into the platform's holdings.
  await watchAddress(sql, SCOPE, '0xff', 'market:stake')
  await watchAddress(sql, SCOPE, '0xfe', null)
  await refuses(observer(honestChain()), 'no_custody_addresses')
})

test('a label prefix is matched literally, so it cannot become a wildcard', { skip }, async () => {
  // `starts_with`, not `like`. Were this a LIKE pattern, a prefix of `deposit:` would still be
  // fine — but the failure mode being closed off is a prefix containing `%`, which under LIKE
  // would pull every watched address on the chain into the custody set and report the total of
  // things the platform does not hold.
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await watchAddress(sql, SCOPE, '0xff', 'xdeposit:u-9')
  const chain = honestChain()
  chain.balances.set('0xaa', '0x5')
  const observed = await observer(chain).total(SCOPE)
  assert.equal(observed.addresses, 1)
  assert.equal(observed.total, '5')
})

test('a custody set above the bound is refused rather than truncated to it', { skip }, async () => {
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await watchAddress(sql, SCOPE, '0xbb', 'deposit:u-2')
  await watchAddress(sql, SCOPE, '0xcc', 'deposit:u-3')
  const chain = honestChain()
  chain.balances.set('0xaa', '0x1')
  chain.balances.set('0xbb', '0x1')
  chain.balances.set('0xcc', '0x1')
  // A page of a custody set is a partial sum. Two of three would answer 2, which is low, which
  // freezes.
  await refuses(observer(chain, { maxAddresses: 2 }), 'custody_set_too_large')
  // Exactly at the bound still answers — the refusal is ABOVE it, not at it.
  assert.equal((await observer(chain, { maxAddresses: 3 }).total(SCOPE)).total, '3')
})

test('a node serving a different block at the confirmed height is refused before any balance is read', { skip }, async () => {
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  const chain: FakeChain = {
    blockHashAt: (h) => (h === AT ? `0x${'9'.repeat(64)}` : hashAt(h)),
    balances: new Map([['0xaa', '0x1']]),
    calls: [],
  }
  await refuses(observer(chain), 'head_diverged')
  assert.equal(chain.calls.filter((c) => c === 'eth_getBalance').length, 0)
})

test('a reorg landing MID-SWEEP is caught by the closing check, not by the opening one', { skip }, async () => {
  // The sharpest case in the file. `eth_getBalance` takes a HEIGHT, so a reorg between the first
  // address and the last has half the sum answered from one chain and half from another. The
  // opening hash check passed. The result would look completely ordinary. Only the closing check
  // can see it.
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await watchAddress(sql, SCOPE, '0xbb', 'deposit:u-2')
  await watchAddress(sql, SCOPE, '0xcc', 'deposit:u-3')

  let reorged = false
  const chain: FakeChain = {
    blockHashAt: (h) => (reorged && h === AT ? `0x${'9'.repeat(64)}` : hashAt(h)),
    balances: new Map([
      ['0xaa', '0x1'],
      ['0xbb', '0x2'],
      ['0xcc', '0x4'],
    ]),
    calls: [],
    onBalance: (_address, index) => {
      if (index >= 1) reorged = true
    },
  }
  await refuses(observer(chain), 'head_diverged')
  // It really did read the balances first — this is the closing check firing, not the opening one.
  assert.equal(chain.calls.filter((c) => c === 'eth_getBalance').length, 3)
})

test('a halted chain is refused, because the depth is all this answer is made of', { skip }, async () => {
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await haltChain(sql, SCOPE, 'an alarming reorg')
  const chain = honestChain()
  chain.balances.set('0xaa', '0x1')
  await refuses(observer(chain), 'chain_halted')
})

test('a chain with nothing walked, or not walked to the depth, is refused rather than read at the head', { skip }, async () => {
  const chain = honestChain()
  chain.balances.set('0xaa', '0x1')
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')

  // Nothing at all.
  await refuses(observer(chain), 'nothing_indexed')

  // A chain shorter than the confirmation depth. Reading at height 0 would report a balance that
  // has not reached the depth EMBER publishes to exchanges.
  await walkChain(10)
  await refuses(observer(chain), 'below_confirmation_depth')
})

test('a head above a record that does not reach the depth is refused, not read anyway', { skip }, async () => {
  // A cold-started follower: a high head, but no block of ours at `head − 60 + 1`, so there is
  // nothing to compare the node's block against. Without that comparison the balance could come
  // from a chain this service never walked.
  await upsertBlock(sql, SCOPE, {
    height: HEAD,
    hash: hashAt(HEAD),
    parentHash: hashAt(HEAD - 1),
    blockTime: new Date(1_700_000_000_000),
    txCount: 0,
    detail: {},
  })
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  await refuses(observer(honestChain()), 'depth_not_walked')
})

test('a chain this replica follows no provider for is refused, never answered from rows', { skip }, async () => {
  await walkChain()
  await watchAddress(sql, SCOPE, '0xaa', 'deposit:u-1')
  const observe = rpcCustodyObserver({
    sql,
    callers: new Map(),
    labelPrefixes: ['deposit:'],
    maxAddresses: 10,
  })
  await refuses(observe, 'chain_not_followed')
})

test('a family this build cannot read is refused rather than derived from movements', () => {
  // Solana. Its movements come from pre/post balance deltas rather than from outputs, so the UTXO
  // derivation `bitcoin` now uses does not apply to it, and `getBalance` at a historical slot needs
  // an archive node — so neither route to its balance is built here. Summing its rows with the
  // wrong derivation would produce a plausible, wrong number, and a plausible wrong number is what
  // this whole file exists to refuse. `btc` was the subject of this test until 2026-08-08, when the
  // derivation landed (micro-org#252); it is now covered by the derivation tests below.
  const observe = rpcCustodyObserver({
    sql,
    callers: new Map([['sol:mainnet', fakeCaller(honestChain())]]),
    labelPrefixes: ['deposit:'],
    maxAddresses: 10,
  })
  return assert.rejects(
    () => observe.total({ chain: 'sol', network: 'mainnet' }),
    (err: unknown) =>
      err instanceof CustodyTotalUnavailableError && err.code === 'family_not_supported',
  )
})

/* --------------------------------------- the derived families (UTXO) */

/**
 * Litecoin, whose balance is not read from anywhere.
 *
 * There is no `eth_getBalance` on this family — stock Core keeps no address index, so an address
 * the node's wallet does not own has no balance the node will state at any height. The balance is
 * therefore DERIVED from this service's own record, and every test below is about the two proofs
 * that entitle the derivation to be called a balance: that the record has no hole in it, and that
 * it reaches back below any activity the addresses could have had. See `custody.deriveTotal` and
 * micro-org#252.
 */
const LTC: ChainScope = { chain: 'ltc', network: 'testnet' }
const LTC_CONFIRMATIONS = 12
const LTC_HEAD = 100
const LTC_AT = LTC_HEAD - LTC_CONFIRMATIONS + 1

/** A node that agrees with everything this service walked. `getblockhash`, not `eth_*`. */
function ltcCaller(over: Partial<{ hashAt: (height: number) => string | null }> = {}): {
  caller: RpcCaller
  calls: string[]
} {
  const calls: string[] = []
  const at = over.hashAt ?? hashAt
  return {
    calls,
    caller: {
      async call<T>(method: string, params?: readonly unknown[]): Promise<T> {
        calls.push(method)
        if (method === 'getblockhash') return at(Number(params?.[0] ?? -1)) as T
        throw new Error(`unexpected method ${method}`)
      },
    },
  }
}

function ltcObserver(caller: RpcCaller): CustodyObserver {
  return rpcCustodyObserver({
    sql,
    callers: new Map([['ltc:testnet', caller]]),
    labelPrefixes: ['deposit:', 'treasury:'],
    maxAddresses: 2_000,
  })
}

/** Canonical blocks `from..to`, and a tip checkpoint at `to`. `from > 0` is a cold start. */
async function walkLtc(from: number, to: number): Promise<void> {
  for (let height = from; height <= to; height += 1) {
    await upsertBlock(sql, LTC, {
      height,
      hash: hashAt(height),
      parentHash: hashAt(height === 0 ? 0 : height - 1),
      blockTime: new Date(1_700_000_000_000 + height * 150_000),
      txCount: 0,
      detail: {},
    })
  }
  await setCheckpoint(sql, LTC, TIP_STREAM, to, hashAt(to))
}

/** An output of `amount` paying `address`, at `height`, as vout `vout` of `txid`. */
async function fund(
  height: number,
  txid: string,
  vout: number,
  address: string,
  amount: bigint,
): Promise<void> {
  await upsertTransaction(sql, LTC, {
    hash: txid,
    blockHash: hashAt(height),
    blockHeight: height,
    txIndex: 0,
    from: null,
    to: address,
    value: amount,
    fee: null,
    status: 'success',
    nonceOrSequence: null,
    rawRef: {},
  })
  await upsertActivity(sql, LTC, {
    address,
    direction: 'in',
    assetCode: 'LTC',
    assetKind: 'native',
    tokenAddress: null,
    amount,
    txHash: txid,
    entryKey: activityEntryKey(vout, 'in', address),
    logIndex: vout,
    blockHeight: height,
    blockHash: hashAt(height),
  })
}

/** `spendingTx` consumes `txid:vout` at `height`. */
async function spend(
  height: number,
  spendingTx: string,
  txid: string,
  vout: number,
): Promise<void> {
  await upsertTransaction(sql, LTC, {
    hash: spendingTx,
    blockHash: hashAt(height),
    blockHeight: height,
    txIndex: 0,
    from: null,
    to: null,
    value: 0n,
    fee: null,
    status: 'success',
    nonceOrSequence: null,
    rawRef: {},
  })
  await recordSpends(sql, LTC, [
    { txid, vout, spendingTxHash: spendingTx, blockHeight: height, blockHash: hashAt(height) },
  ])
}

test('a UTXO total is the outputs nothing has spent, at the confirmed depth', { skip }, async () => {
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await watchAddress(sql, LTC, 'ltc1qbb', 'treasury:hot')

  await fund(10, 'tx-a', 0, 'ltc1qaa', 500n)
  await fund(11, 'tx-b', 1, 'ltc1qaa', 300n)
  await fund(12, 'tx-c', 0, 'ltc1qbb', 200n)
  // Spent, so it is not a balance: 500 leaves, 300 + 200 remain.
  await spend(20, 'tx-spend', 'tx-a', 0)

  const { caller, calls } = ltcCaller()
  const observed = await ltcObserver(caller).total(LTC)

  assert.equal(observed.total, '500')
  assert.equal(observed.addresses, 2)
  assert.equal(observed.assetCode, 'LTC')
  assert.equal(observed.requiredConfirmations, LTC_CONFIRMATIONS)
  assert.equal(observed.observedAtBlock, LTC_AT)
  assert.equal(observed.observedAtBlockHash, hashAt(LTC_AT))
  // Nothing was read from the node — the sum is this service's own record. The only calls are the
  // two `getblockhash` proofs that the node still serves the chain those rows describe.
  assert.deepEqual(calls, ['getblockhash', 'getblockhash'])
})

test('an outbound movement row is not subtracted, because the derivation never looks at one', { skip }, async () => {
  // The defect this formulation exists to make unrepresentable. `bitcoin.ts` records the spend
  // from the txin outpoint UNCONDITIONALLY but writes the outbound MOVEMENT only when the prevout
  // resolves — so `in − out` is over-stated by every spend whose prevout could not be fetched, and
  // an over-stated custody total reads at the ledger as NEGATIVE drift, which freezes a solvent
  // asset. Here the `out` row is present AND the outpoint is unspent: `in − out` would answer 400,
  // outputs-minus-spends answers 1000, and 1000 is the balance.
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(10, 'tx-a', 0, 'ltc1qaa', 1000n)
  await upsertTransaction(sql, LTC, {
    hash: 'tx-out',
    blockHash: hashAt(11),
    blockHeight: 11,
    txIndex: 0,
    from: 'ltc1qaa',
    to: null,
    value: 600n,
    fee: null,
    status: 'success',
    nonceOrSequence: null,
    rawRef: {},
  })
  await upsertActivity(sql, LTC, {
    address: 'ltc1qaa',
    direction: 'out',
    assetCode: 'LTC',
    assetKind: 'native',
    tokenAddress: null,
    amount: 600n,
    txHash: 'tx-out',
    entryKey: activityEntryKey(0, 'out', 'ltc1qaa'),
    logIndex: 0,
    blockHeight: 11,
    blockHash: hashAt(11),
  })

  assert.equal((await ltcObserver(ltcCaller().caller).total(LTC)).total, '1000')
})

test('a spend above the confirmed height has not happened yet, and neither has a credit', { skip }, async () => {
  // Both halves are bounded at the same height, because a total assembled from rows at two
  // different depths is a number no state of the chain ever had.
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(10, 'tx-a', 0, 'ltc1qaa', 700n)
  await fund(LTC_AT + 1, 'tx-late', 0, 'ltc1qaa', 900n)
  await spend(LTC_AT + 2, 'tx-spend', 'tx-a', 0)

  assert.equal((await ltcObserver(ltcCaller().caller).total(LTC)).total, '700')
})

test('an orphaned credit is not money and an orphaned spend did not happen', { skip }, async () => {
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(10, 'tx-a', 0, 'ltc1qaa', 400n)
  await fund(11, 'tx-b', 0, 'ltc1qaa', 250n)
  await spend(12, 'tx-spend', 'tx-a', 0)
  // The reorg: `tx-b`'s credit was retracted, and the spend of `tx-a` went with the block that
  // carried it. Taking either at face value moves the total in the direction of the unrepaired
  // half — 250 too high, or 400 too low.
  await sql`
    update address_activity set status = 'orphaned'
     where chain = 'ltc' and network = 'testnet' and tx_hash = 'tx-b'
  `
  await sql`
    update spent_outpoints set status = 'orphaned'
     where chain = 'ltc' and network = 'testnet' and spending_tx_hash = 'tx-spend'
  `

  assert.equal((await ltcObserver(ltcCaller().caller).total(LTC)).total, '400')
})

test('a hole in the walked record refuses, because it is wrong in both directions at once', { skip }, async () => {
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(10, 'tx-a', 0, 'ltc1qaa', 400n)
  // One block below the confirmed height is gone. It contains receipts that will be missing from
  // the sum AND spends that will be missing from the subtraction, with nothing bounding either.
  await sql`
    delete from blocks where chain = 'ltc' and network = 'testnet' and height = 40
  `

  await assertRefusal(() => ltcObserver(ltcCaller().caller).total(LTC), 'history_not_walked')
})

test('a cold-started record refuses for an address nobody claimed a history for', { skip }, async () => {
  // `ltc:mainnet` is walked from a cold-start height, and the deposit rows registered by earlier
  // builds carry no claim. This is the answer they get, and it is the honest one: coin received
  // before this service started looking is invisible here and would be missing from the total.
  await walkLtc(20, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(30, 'tx-a', 0, 'ltc1qaa', 400n)

  await assertRefusal(() => ltcObserver(ltcCaller().caller).total(LTC), 'history_unknown')
})

test('a claim at or above the walked floor is what makes a cold-started record answerable', { skip }, async () => {
  // The claim only its registrar can make truthfully: nothing can have paid an address that did
  // not exist yet. `micro-wallet` and `micro-settlement` make it at derivation time.
  await walkLtc(20, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1', 25)
  await fund(30, 'tx-a', 0, 'ltc1qaa', 400n)

  assert.equal((await ltcObserver(ltcCaller().caller).total(LTC)).total, '400')
})

test('a claim BELOW the walked floor refuses: the gap is history this service never saw', { skip }, async () => {
  await walkLtc(20, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1', 5)
  await fund(30, 'tx-a', 0, 'ltc1qaa', 400n)

  await assertRefusal(() => ltcObserver(ltcCaller().caller).total(LTC), 'history_not_walked')
})

test('an unclaimed address is answerable on a genesis-walked chain, and that is a theorem', { skip }, async () => {
  // "No activity below block 0" is true of every address on every chain, so the claim reduces to
  // `lo = 0` — which is why EMBER's own chain and a regtest Litecoin need no claim at all.
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(30, 'tx-a', 0, 'ltc1qaa', 400n)

  assert.equal((await ltcObserver(ltcCaller().caller).total(LTC)).total, '400')
})

test('the lowest claim wins when an address is re-registered', { skip }, async () => {
  // `watchAddress` takes `least(existing, incoming)`. A re-registration that arrives after the
  // address has been in use must not be able to RAISE the floor: a higher claim would assert the
  // absence of activity this service may already have recorded below it.
  await walkLtc(20, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1', 25)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1', 60)
  await fund(30, 'tx-a', 0, 'ltc1qaa', 400n)

  const [entry] = await custodyAddressHistory(sql, LTC, ['ltc1qaa'])
  assert.equal(entry?.historyFromHeight, 25)
})

test('a single derived balance is the same derivation, with the same refusals', { skip }, async () => {
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(10, 'tx-a', 0, 'ltc1qaa', 900n)
  await fund(11, 'tx-b', 0, 'ltc1qbb', 100n)
  await spend(12, 'tx-spend', 'tx-a', 0)
  await fund(13, 'tx-c', 2, 'ltc1qaa', 250n)

  const read = await ltcObserver(ltcCaller().caller).balance(LTC, 'ltc1qaa')
  // 900 spent, 250 not; `ltc1qbb` is somebody else's coin and is not in this answer.
  assert.equal(read.balance, '250')
  assert.equal(read.observedAtBlock, LTC_AT)

  // And on a cold-started record the single reading refuses exactly as the total does.
  await sql`delete from blocks where chain = 'ltc' and network = 'testnet' and height < 5`
  await assertRefusal(() => ltcObserver(ltcCaller().caller).balance(LTC, 'ltc1qaa'), 'history_unknown')
})

test('the derived total splits by bucket too, and a fully-spent address is a zero in one', { skip }, async () => {
  // The split has to hold on BOTH summing paths or the freeze message means different things on
  // different chains. This path is the harder of the two: the derivation returns a row only for an
  // address that still has unspent credit, so an address whose coin has all been spent is ABSENT
  // from the measurement — and absent must land in its bucket as a counted zero, not be dropped.
  // Dropping it would leave the parts short of the whole and refuse the whole observation.
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await watchAddress(sql, LTC, 'ltc1qbb', 'deposit:u-2')
  await watchAddress(sql, LTC, 'ltc1qtt', 'treasury:hot')

  await fund(10, 'tx-a', 0, 'ltc1qaa', 500n)
  await fund(11, 'tx-b', 0, 'ltc1qbb', 300n)
  await fund(12, 'tx-t', 0, 'ltc1qtt', 900n)
  // `ltc1qbb` is swept empty: measured zero, still one address of the deposit set.
  await spend(20, 'tx-sweep', 'tx-b', 0)

  const observed = await ltcObserver(ltcCaller().caller).total(LTC)

  assert.equal(observed.total, '1400')
  assert.equal(observed.addresses, 3)
  assert.deepEqual(observed.byLabelPrefix, [
    { prefix: 'deposit:', addresses: 2, total: '500' },
    { prefix: 'treasury:', addresses: 1, total: '900' },
  ])
})

test('a node serving a different chain at the confirmed height is a refusal, not a total', { skip }, async () => {
  // The derivation reads nothing from the node, so this is the ONLY check that asks whether the
  // node still believes in the chain the summed rows describe.
  await walkLtc(0, LTC_HEAD)
  await watchAddress(sql, LTC, 'ltc1qaa', 'deposit:u-1')
  await fund(10, 'tx-a', 0, 'ltc1qaa', 400n)

  const { caller } = ltcCaller({ hashAt: (h) => (h === LTC_AT ? `0x${'e'.repeat(64)}` : hashAt(h)) })
  await assertRefusal(() => ltcObserver(caller).total(LTC), 'head_diverged')
})
