/**
 * The token observation, and the two things that make it safe to publish.
 *
 * 1. **It is taken at the stored canonical HEAD**, not at the provider-claimed tip, and not at
 *    `latest`. That is the rule `reads.ts` states for the two reads a money decision goes
 *    through, and this is a third — `micro-mint`'s risk indicators are computed from it.
 * 2. **The node is made to prove the head is still the head** before a single field is read. A
 *    height alone is not an identity: after a reorg the node has a different block at the same
 *    number, and a supply attributed to a block this service never walked is worse than no supply.
 *
 * Everything else here is decoding, and it is tested against the encodings real contracts return —
 * including the `bytes32` symbol, which a decoder that knows only the dynamic form renders blank.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import type { ChainScope } from './chains.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import type { Db } from './outbox.ts'
import { RpcError, RpcUnavailableError } from './rpc.ts'
import { TIP_STREAM, haltChain, recordTip, setCheckpoint, upsertBlock } from './store.ts'
import {
  TokenStateUnavailableError,
  decodeAddress,
  decodeBool,
  decodeDecimals,
  decodeText,
  decodeUint,
  hasCode,
  mintAuthorityFrom,
  rpcTokenObserver,
  toBlockParam,
  type RpcCaller,
} from './tokenstate.ts'

/* ------------------------------------------------------------------ pure, no database */

const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, '0')

test('a uint256 leaves as a decimal string, and a short answer is not one', () => {
  assert.equal(decodeUint(`0x${word(1_000_000n)}`), '1000000')
  // Past 2^53. A JSON number here loses the low digits of every 18-decimal supply.
  assert.equal(decodeUint(`0x${word(12_000_000n * 10n ** 18n)}`), '12000000000000000000000000')
  assert.equal(decodeUint('0x'), null)
  assert.equal(decodeUint('0x1234'), null, 'half a word is not a number')
})

test('decimals is a uint8, and anything wider is refused rather than truncated', () => {
  assert.equal(decodeDecimals(`0x${word(18)}`), 18)
  assert.equal(decodeDecimals(`0x${word(0)}`), 0)
  // Truncating this to 255 would render a six-decimal stablecoin a million times too small — the
  // same failure `reads.ts` refuses to risk by formatting a token amount at all.
  assert.equal(decodeDecimals(`0x${word(1_000)}`), null)
})

test('an address must be left-padded with twelve zero bytes, or it is not one', () => {
  assert.equal(decodeAddress(`0x${'0'.repeat(24)}${'e'.repeat(40)}`), `0x${'e'.repeat(40)}`)
  assert.equal(decodeAddress(`0x${'f'.repeat(64)}`), null, 'not padded: not an address')
  assert.equal(decodeAddress(`0x${'0'.repeat(24)}${'E'.repeat(40)}`), `0x${'e'.repeat(40)}`)
})

test('a bool is 0 or 1 and nothing else is an answer', () => {
  assert.equal(decodeBool(`0x${word(0)}`), false)
  assert.equal(decodeBool(`0x${word(1)}`), true)
  assert.equal(decodeBool(`0x${word(2)}`), null, 'not a canonical bool; null, not "true-ish"')
})

test('a string decodes in both spellings, and a hostile one is bounded', () => {
  const dynamic = (text: string): string => {
    const bytes = Buffer.from(text, 'utf8').toString('hex')
    return `0x${word(32)}${word(text.length)}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')}`
  }
  assert.equal(decodeText(dynamic('Forge')), 'Forge')
  // The bytes32 form. MakerDAO's own token answers symbol() this way and a dynamic-only decoder
  // renders it blank.
  assert.equal(decodeText(`0x${Buffer.from('FRG', 'utf8').toString('hex').padEnd(64, '0')}`), 'FRG')
  // A megabyte symbol is a denial of service pointed at every page that renders it.
  const huge = decodeText(dynamic('z'.repeat(4_000)))
  assert.equal(huge?.length, 128)
  assert.equal(decodeText(`0x${'0'.repeat(64)}`), null, 'all padding is not a name')
})

test('code at an address is code, and 0x is not', () => {
  assert.equal(hasCode('0x60806040'), true)
  assert.equal(hasCode('0x'), false)
  assert.equal(hasCode('0x00'), false, 'a zero word is what a node returns for an EOA')
  assert.equal(hasCode(undefined), false)
})

test('a height becomes the hex block parameter, with no leading zeros', () => {
  assert.equal(toBlockParam(0), '0x0')
  assert.equal(toBlockParam(7_412), '0x1cf4')
})

test('mint authority errs towards warning, and never towards reassuring', () => {
  const supply = '1000'
  // No `owner()` at all — a fixed-supply token. NOT "nobody can mint": this service cannot see a
  // function it was never told to call, and a missing value stays missing.
  assert.equal(mintAuthorityFrom({ owner: null, cap: null, totalSupply: supply }), null)
  // Renounced. `onlyOwner` can never be satisfied again.
  assert.equal(mintAuthorityFrom({ owner: `0x${'0'.repeat(40)}`, cap: null, totalSupply: supply }), false)
  // Capped out. ERC20Capped reverts every further mint.
  assert.equal(mintAuthorityFrom({ owner: `0x${'e'.repeat(40)}`, cap: '1000', totalSupply: supply }), false)
  assert.equal(mintAuthorityFrom({ owner: `0x${'e'.repeat(40)}`, cap: '2000', totalSupply: supply }), true)
  assert.equal(mintAuthorityFrom({ owner: `0x${'e'.repeat(40)}`, cap: null, totalSupply: supply }), true)
})

/* ------------------------------------------------------------------ against the database */

const url = process.env['INDEXER_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'

const SCOPE: ChainScope = { chain: 'ember', network: 'testnet' }
const XRP: ChainScope = { chain: 'xrp', network: 'testnet' }
const TOKEN = `0x${'c'.repeat(40)}`
const OWNER = `0x${'e'.repeat(40)}`
const HEAD_HASH = `0x${'a'.repeat(64)}`
const OTHER_HASH = `0x${'b'.repeat(64)}`

let sql: postgres.Sql

const db = (): Db => sql as unknown as Db

before(async () => {
  if (!enabled) return
  sql = postgres(url!, { max: 4, onnotice: () => {} })
  await sql.unsafe(
    `drop table if exists ${CHAIN_TABLES.join(', ')}, outbox_deliveries, event_subscriptions,
     outbox, inbox, jobs, schema_migrations cascade`,
  )
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'indexer-tokenstate-test' })
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await sql.unsafe(`truncate ${CHAIN_TABLES.join(', ')} restart identity cascade`)
})

/** A canonical head at `height`, plus a tip the provider claims is further along. */
async function seedHead(height: number, hash: string, tip = height + 3): Promise<void> {
  await upsertBlock(db(), SCOPE, {
    height,
    hash,
    parentHash: `0x${'0'.repeat(64)}`,
    blockTime: new Date('2026-01-01T00:00:00Z'),
    txCount: 0,
    detail: {},
  })
  await setCheckpoint(db(), SCOPE, TIP_STREAM, height, hash)
  await recordTip(db(), SCOPE, tip)
}

interface Asked {
  readonly method: string
  readonly params: readonly unknown[]
}

/**
 * A node that serves one block and one contract.
 *
 * `answers` maps a four-byte selector to the word it returns; a selector that is absent reverts,
 * exactly as a contract without that function does.
 */
function fakeNode(options: {
  blockHash?: string | null
  code?: string
  answers?: Record<string, string>
  unavailable?: boolean
}): { caller: RpcCaller; asked: Asked[] } {
  const asked: Asked[] = []
  const caller: RpcCaller = {
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      asked.push({ method, params })
      if (options.unavailable) throw new RpcUnavailableError(method, ['one'], 'timeout')
      if (method === 'eth_getBlockByNumber') {
        const hash = options.blockHash === undefined ? HEAD_HASH : options.blockHash
        return (hash === null ? null : { hash }) as T
      }
      if (method === 'eth_getCode') return (options.code ?? '0x60806040') as T
      if (method === 'eth_call') {
        const data = String((params[0] as { data?: string }).data ?? '')
        const answer = options.answers?.[data]
        if (answer === undefined) {
          throw new RpcError({ code: 3, message: 'execution reverted', method, provider: 'one' })
        }
        return answer as T
      }
      throw new Error(`unexpected method ${method}`)
    },
  }
  return { caller, asked }
}

const SELECTOR = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  cap: '0x355274ea',
  owner: '0x8da5cb5b',
  paused: '0x5c975abb',
} as const

const FOUNDRY_TIER: Record<string, string> = {
  [SELECTOR.name]: `0x${word(32)}${word(5)}${Buffer.from('Forge', 'utf8').toString('hex').padEnd(64, '0')}`,
  [SELECTOR.symbol]: `0x${Buffer.from('FRG', 'utf8').toString('hex').padEnd(64, '0')}`,
  [SELECTOR.decimals]: `0x${word(18)}`,
  [SELECTOR.totalSupply]: `0x${word(1_000n * 10n ** 18n)}`,
  [SELECTOR.cap]: `0x${word(5_000n * 10n ** 18n)}`,
  [SELECTOR.owner]: `0x${'0'.repeat(24)}${OWNER.slice(2)}`,
  [SELECTOR.paused]: `0x${word(0)}`,
}

const observerWith = (caller: RpcCaller, scope: ChainScope = SCOPE): ReturnType<typeof rpcTokenObserver> =>
  rpcTokenObserver({ sql: db(), callers: new Map([[`${scope.chain}:${scope.network}`, caller]]) })

test('the observation is taken at the stored head, not at the tip and not at latest', { skip }, async () => {
  await seedHead(98, HEAD_HASH, 100)
  const { caller, asked } = fakeNode({ answers: FOUNDRY_TIER })
  const observed = await observerWith(caller).observe(SCOPE, TOKEN)

  assert.ok(observed)
  assert.equal(observed.observedAtBlock, 98)
  assert.equal(observed.observedAtBlockHash, HEAD_HASH)
  // The tip travels with the answer so a page can say how stale it is, and is never read against.
  assert.equal(observed.tipHeight, 100)

  // EVERY call carries the head's block parameter. `latest` anywhere here is a read of blocks
  // nobody in this service has walked, which is the mistake the head-versus-tip rule exists to
  // stop — see reads.ts.
  const blockParams = asked
    .filter((a) => a.method === 'eth_call' || a.method === 'eth_getCode')
    .map((a) => a.params.at(-1))
  assert.ok(blockParams.length >= 7, `expected the state calls, saw ${asked.length} calls`)
  assert.deepEqual([...new Set(blockParams)], ['0x62'], '0x62 is 98; nothing asked for latest')
})

test('every field comes back decoded, with supply as a string', { skip }, async () => {
  await seedHead(98, HEAD_HASH)
  const observed = await observerWith(fakeNode({ answers: FOUNDRY_TIER }).caller).observe(SCOPE, TOKEN)
  assert.deepEqual(observed, {
    chain: 'ember',
    network: 'testnet',
    contractAddress: TOKEN,
    name: 'Forge',
    symbol: 'FRG',
    decimals: 18,
    totalSupply: '1000000000000000000000',
    cap: '5000000000000000000000',
    owner: OWNER,
    mintAuthority: true,
    paused: false,
    observedAtBlock: 98,
    observedAtBlockHash: HEAD_HASH,
    tipHeight: 101,
    halted: false,
  })
})

test('a tier without owner, cap or paused reports null, never false', { skip }, async () => {
  // The fixed-supply tier of ForgeMint has none of the three. Reporting `false` for `paused` would
  // be inventing a fact about a contract that cannot be paused at all, and `mintAuthority: false`
  // would be telling a buyer nobody can mint — the one wrong answer that costs them money.
  await seedHead(98, HEAD_HASH)
  const fixed: Record<string, string> = {
    [SELECTOR.name]: FOUNDRY_TIER[SELECTOR.name]!,
    [SELECTOR.symbol]: FOUNDRY_TIER[SELECTOR.symbol]!,
    [SELECTOR.decimals]: FOUNDRY_TIER[SELECTOR.decimals]!,
    [SELECTOR.totalSupply]: FOUNDRY_TIER[SELECTOR.totalSupply]!,
  }
  const observed = await observerWith(fakeNode({ answers: fixed }).caller).observe(SCOPE, TOKEN)
  assert.ok(observed)
  assert.equal(observed.owner, null)
  assert.equal(observed.cap, null)
  assert.equal(observed.paused, null)
  assert.equal(observed.mintAuthority, null)
  assert.equal(observed.totalSupply, '1000000000000000000000')
})

test('a renounced owner is a false mint authority, and it is read from the chain', { skip }, async () => {
  await seedHead(98, HEAD_HASH)
  const renounced = { ...FOUNDRY_TIER, [SELECTOR.owner]: `0x${'0'.repeat(64)}` }
  const observed = await observerWith(fakeNode({ answers: renounced }).caller).observe(SCOPE, TOKEN)
  assert.equal(observed?.owner, `0x${'0'.repeat(40)}`)
  assert.equal(observed?.mintAuthority, false)
})

test('an address with no code is null — an answer, not a fault', { skip }, async () => {
  // A deployment in a block above the head reads as this, and that is honest: this service has not
  // walked far enough to see it. The route turns it into 404 `token_not_found`.
  await seedHead(98, HEAD_HASH)
  const observed = await observerWith(fakeNode({ code: '0x' }).caller).observe(SCOPE, TOKEN)
  assert.equal(observed, null)
})

test('a contract that will not answer totalSupply is not a token this route describes', { skip }, async () => {
  await seedHead(98, HEAD_HASH)
  const observed = await observerWith(fakeNode({ answers: {} }).caller).observe(SCOPE, TOKEN)
  assert.equal(observed, null, 'eight nulls dressed up as an observation is worse than a 404')
})

test('a head the node no longer serves yields NO observation at all', { skip }, async () => {
  // THE REORG CASE, and the reason a height alone is not an identity. The node has a different
  // block at 98 than the one this service walked, so its state at 98 is state from a chain this
  // service has not followed. `evm.ts` makes exactly this check first on every follow tick.
  await seedHead(98, HEAD_HASH)
  const diverged = fakeNode({ blockHash: OTHER_HASH, answers: FOUNDRY_TIER })
  await assert.rejects(
    () => observerWith(diverged.caller).observe(SCOPE, TOKEN),
    (err: unknown) => err instanceof TokenStateUnavailableError && err.code === 'head_diverged',
  )
  // And it refused BEFORE reading a single field, rather than reading them and labelling them.
  assert.deepEqual(
    [...new Set(diverged.asked.map((a) => a.method))],
    ['eth_getBlockByNumber'],
  )
})

test('a node that has pruned the head answers nothing, and that is not "no token"', { skip }, async () => {
  await seedHead(98, HEAD_HASH)
  const gone = fakeNode({ blockHash: null, answers: FOUNDRY_TIER })
  await assert.rejects(
    () => observerWith(gone.caller).observe(SCOPE, TOKEN),
    (err: unknown) => err instanceof TokenStateUnavailableError && err.code === 'head_diverged',
  )
})

test('an unreachable provider is an outage, never a token with no owner', { skip }, async () => {
  await seedHead(98, HEAD_HASH)
  await assert.rejects(
    () => observerWith(fakeNode({ unavailable: true }).caller).observe(SCOPE, TOKEN),
    (err: unknown) => err instanceof TokenStateUnavailableError && err.code === 'rpc_unavailable',
  )
})

test('a chain with nothing walked yet, and one with no provider, each say which', { skip }, async () => {
  const { caller } = fakeNode({ answers: FOUNDRY_TIER })
  await assert.rejects(
    () => observerWith(caller).observe(SCOPE, TOKEN),
    (err: unknown) => err instanceof TokenStateUnavailableError && err.code === 'nothing_indexed',
  )

  await seedHead(98, HEAD_HASH)
  const noPool = rpcTokenObserver({ sql: db(), callers: new Map() })
  await assert.rejects(
    () => noPool.observe(SCOPE, TOKEN),
    (err: unknown) => err instanceof TokenStateUnavailableError && err.code === 'chain_not_followed',
  )
})

test('a family with no contract state at all refuses before it asks anything', { skip }, async () => {
  const { caller, asked } = fakeNode({ answers: FOUNDRY_TIER })
  await assert.rejects(
    () => observerWith(caller, XRP).observe(XRP, TOKEN),
    (err: unknown) => err instanceof TokenStateUnavailableError && err.code === 'family_not_supported',
  )
  assert.equal(asked.length, 0)
})

test('a halted chain is REPORTED, not refused', { skip }, async () => {
  // Unlike `tokenBalances`, which withholds a balance on a halted chain (reads.ts). That
  // answer is derived from the whole history the halt says cannot be vouched for; this one depends
  // on exactly one block, and the hash check has just proved the node still serves it.
  await seedHead(98, HEAD_HASH)
  await haltChain(db(), SCOPE, 'a reorg past the alarm depth')
  const observed = await observerWith(fakeNode({ answers: FOUNDRY_TIER }).caller).observe(SCOPE, TOKEN)
  assert.equal(observed?.halted, true)
  assert.equal(observed?.totalSupply, '1000000000000000000000')
})
