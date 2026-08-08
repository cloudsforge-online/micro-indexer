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
import { TIP_STREAM, haltChain, setCheckpoint, upsertBlock, watchAddress } from './store.ts'

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
  chain.balances.set('0xcc', '0x15af1d78b58c400000') // 25.1e18

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
  // Bitcoin's and Solana's native balances are derivable from stored movements and EVM's is not
  // (gas leaves no `out` row, internal transfers leave no row at all). Neither derivation is built
  // here, and summing the rows with the wrong one would produce a plausible, wrong number.
  const observe = rpcCustodyObserver({
    sql,
    callers: new Map([['btc:mainnet', fakeCaller(honestChain())]]),
    labelPrefixes: ['deposit:'],
    maxAddresses: 10,
  })
  return assert.rejects(
    () => observe.total({ chain: 'btc', network: 'mainnet' }),
    (err: unknown) =>
      err instanceof CustodyTotalUnavailableError && err.code === 'family_not_supported',
  )
})
