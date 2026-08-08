import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { PARTIAL_DETAIL_KEY } from './btcsource.ts'
import type { ChainScope } from './chains.ts'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import type { Db } from './outbox.ts'
import {
  TIP_STREAM,
  activityEntryKey,
  activityForAddress,
  blockAtHeight,
  custodyAddressHistory,
  ensureBackfill,
  filterWatched,
  getCheckpoint,
  haltChain,
  headBlock,
  isHalted,
  markConfirmed,
  nextUnfinishedBackfill,
  orphanAbove,
  parseCursor,
  pendingConfirmations,
  recordTip,
  setCheckpoint,
  upsertActivity,
  upsertBlock,
  upsertTransaction,
  watchAddress,
} from './store.ts'

/* ------------------------------------------------------------------ the scoping invariant */

/**
 * Strip comments so an assertion about SQL cannot be satisfied — or defeated — by prose.
 *
 * `store.ts` documents its own statements with backticked fragments in the surrounding comments,
 * and those fragments are not statements.
 */
function code(source: string): string {
  const lines: string[] = []
  let inBlock = false
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*' + '/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*' + '/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//')) continue
    lines.push(line)
  }
  return lines.join('\n')
}

test('every statement that touches a chain table interpolates both halves of the scope', () => {
  // The invariant of 04-domain-model §4.1, checked against the source rather than trusted to
  // review — because review is what let the XRP testnet/mainnet address collision into the estate.
  // The schema makes a cross-network REFERENCE impossible; this is what makes a cross-network READ
  // impossible.
  const source = code(readFileSync(new URL('./store.ts', import.meta.url), 'utf8'))
  const literals = source.match(/`[^`]*`/g) ?? []
  const statements = literals.filter((literal) =>
    CHAIN_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(literal)),
  )
  assert.ok(statements.length >= 15, `expected the store's statements, found ${statements.length}`)
  for (const statement of statements) {
    const first = statement.split('\n')[1]?.trim() ?? statement.slice(0, 60)
    assert.ok(statement.includes('scope.chain'), `statement does not scope the chain: ${first}`)
    assert.ok(statement.includes('scope.network'), `statement does not scope the network: ${first}`)
  }
})

test('the reader and the index look for the marker under the name the writer writes it', () => {
  // `markPartial` in btcsource.ts writes the key; `partialFromHeight` and the partial index in
  // migration 8 both look for it as a SQL literal, because a bind parameter would stop Postgres
  // proving the query implies the index predicate and the whole point of that index is to find
  // these blocks without a table scan. Two hardcoded spellings against one constant is exactly the
  // divergence that would answer "every block is complete" for a record full of narrow ones — and
  // the migration's copy cannot be corrected later, since a released migration's text is frozen.
  const literal = `detail->>'${PARTIAL_DETAIL_KEY}'`
  for (const file of ['./store.ts', './migrations.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.ok(source.includes(literal), `${file} does not read the marker as ${literal}`)
  }
})

test('an entry key names the movement, so one transaction paying itself produces two', () => {
  assert.equal(activityEntryKey(null, 'in', '0xaa'), 'native:in:0xaa')
  assert.equal(activityEntryKey(3, 'out', '0xaa'), '3:out:0xaa')
  assert.notEqual(activityEntryKey(null, 'in', '0xaa'), activityEntryKey(null, 'out', '0xaa'))
})

test('a cursor round-trips and a malformed one is refused rather than coerced', () => {
  assert.deepEqual(parseCursor('42:2b3c4d5e-0000-4000-8000-000000000001'), {
    height: 42,
    id: '2b3c4d5e-0000-4000-8000-000000000001',
  })
  assert.equal(parseCursor('42'), null)
  assert.equal(parseCursor('nope:nope'), null)
})

/* ------------------------------------------------------------------ database-backed */

const url = process.env['INDEXER_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'

const TESTNET: ChainScope = { chain: 'xrp', network: 'testnet' }
const MAINNET: ChainScope = { chain: 'xrp', network: 'mainnet' }
/**
 * One address, both networks.
 *
 * This is not a contrived case. 00-current-state §3.5: XRP has no network binding, so custody
 * generates the same seed and the same address on testnet and mainnet, and a signed Payment is
 * submittable on either. These tests are the proof that the same collision cannot produce a
 * cross-network read here.
 */
const SHARED = 'rPdvC6ccq8hCdPKSPJkPmyZ4Mi1oG2FFkT'

let sql: postgres.Sql
const db = (): Db => sql

async function seedBlock(scope: ChainScope, height: number, suffix: string): Promise<string> {
  const hash = `0x${suffix.padStart(64, '0')}`
  await upsertBlock(db(), scope, {
    height,
    hash,
    parentHash: `0x${'0'.repeat(64)}`,
    blockTime: new Date('2026-01-01T00:00:00Z'),
    txCount: 1,
    detail: { ledgerIndex: height, closed: true },
  })
  return hash
}

async function seedMovement(
  scope: ChainScope,
  height: number,
  suffix: string,
  amount: bigint,
): Promise<{ txHash: string; id: string }> {
  const blockHash = await seedBlock(scope, height, suffix)
  const txHash = `0xtx${suffix.padStart(61, '0')}`
  await upsertTransaction(db(), scope, {
    hash: txHash,
    blockHash,
    blockHeight: height,
    txIndex: 0,
    from: 'rSender',
    to: SHARED,
    value: amount,
    fee: 12n,
    status: 'success',
    nonceOrSequence: 1,
    rawRef: {},
  })
  const { id } = await upsertActivity(db(), scope, {
    address: SHARED,
    direction: 'in',
    assetCode: 'XRP',
    assetKind: 'native',
    tokenAddress: null,
    amount,
    txHash,
    entryKey: activityEntryKey(null, 'in', SHARED),
    logIndex: null,
    blockHeight: height,
    blockHash,
  })
  return { txHash, id }
}

before(async () => {
  if (!enabled) return
  sql = postgres(url!, { max: 4, onnotice: () => {} })
  await sql.unsafe(
    `drop table if exists ${CHAIN_TABLES.join(', ')}, outbox_deliveries, event_subscriptions,
     outbox, inbox, jobs, schema_migrations cascade`,
  )
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'indexer-test' })
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await sql.unsafe(`truncate ${CHAIN_TABLES.join(', ')}, outbox, inbox restart identity cascade`)
})

test('one XRP address on two networks stays two records', { skip }, async () => {
  await seedMovement(TESTNET, 10, 'aa', 1_000_000n)
  await seedMovement(MAINNET, 10, 'bb', 9_999_999n)

  const onTestnet = await activityForAddress(db(), TESTNET, SHARED, 10, null)
  const onMainnet = await activityForAddress(db(), MAINNET, SHARED, 10, null)

  assert.equal(onTestnet.items.length, 1)
  assert.equal(onMainnet.items.length, 1)
  assert.equal(onTestnet.items[0]?.amount, 1_000_000n)
  assert.equal(onMainnet.items[0]?.amount, 9_999_999n)
  // The defect in the estate today is that these two are indistinguishable. Here they cannot be
  // confused, because there is no query in the service that can reach one from the other.
  assert.notEqual(onTestnet.items[0]?.txHash, onMainnet.items[0]?.txHash)
})

test('a watch on one network does not watch the other', { skip }, async () => {
  await watchAddress(db(), TESTNET, SHARED, 'testnet only')
  assert.deepEqual([...(await filterWatched(db(), TESTNET, [SHARED]))], [SHARED])
  assert.deepEqual([...(await filterWatched(db(), MAINNET, [SHARED]))], [])
})

test("a 'head' history claim is resolved here, against this network's own head", { skip }, async () => {
  // The caller that can make the claim truthfully — one that has just derived the key — is the one
  // that cannot know a height. So it says `freshlyDerived` and the height is stamped here, from
  // the record of the network being watched. Stamping it in the caller would mean trusting a
  // number produced by a service with no view of this chain at all.
  await upsertBlock(db(), TESTNET, {
    height: 77,
    hash: '0x77',
    parentHash: '0x76',
    blockTime: new Date(1_700_000_000_000),
    txCount: 0,
    detail: {},
  })
  await watchAddress(db(), TESTNET, SHARED, 'deposit:u-1', 'head')
  assert.equal((await custodyAddressHistory(db(), TESTNET, [SHARED]))[0]?.historyFromHeight, 77)

  // The same claim on a network with nothing walked is 0, not null: "no activity below block 0" is
  // true of every address, and it is the WEAKEST claim available rather than a licence. It lets a
  // genesis-walked chain proceed and still refuses a cold-started one, which is exactly right —
  // an indexer with no blocks cannot have missed any.
  await watchAddress(db(), MAINNET, SHARED, 'deposit:u-1', 'head')
  assert.equal((await custodyAddressHistory(db(), MAINNET, [SHARED]))[0]?.historyFromHeight, 0)

  // And an address watched with no claim at all keeps the null, which is the refusal.
  await watchAddress(db(), TESTNET, `${SHARED}-x`, 'deposit:u-2')
  assert.equal(
    (await custodyAddressHistory(db(), TESTNET, [`${SHARED}-x`]))[0]?.historyFromHeight,
    null,
  )

  // The TIP wins when it is higher, and that is not a rounding-up of the claim — it is the only
  // version of it that survives a record which no longer holds every address. A block between the
  // head and the observed tip may be mid-flight, having already asked which addresses were watched
  // and been told this one was not. Claiming the head leaves that block inside the range a balance
  // is derived over and outside the range this address was recorded in; claiming the tip does not,
  // and "nothing has paid it below the tip" is exactly as true for a key derived a moment ago.
  await recordTip(db(), TESTNET, 90)
  await watchAddress(db(), TESTNET, `${SHARED}-y`, 'deposit:u-3', 'head')
  assert.equal(
    (await custodyAddressHistory(db(), TESTNET, [`${SHARED}-y`]))[0]?.historyFromHeight,
    90,
    'the head is 77 and the tip is 90 — the higher of the two is the only safe claim',
  )
})

test('a re-watch is free, and a lower claim is not', { skip }, async () => {
  // `micro-wallet` re-registers every unwatched deposit address on a blunt retry pass, so the
  // difference between "this address is watched" and "this address is watched further back than it
  // was" has to be reported. The second means blocks already walked were walked without it; the
  // first means nothing at all, and treating them alike is a rescan per address per sweep.
  const first = await watchAddress(db(), TESTNET, SHARED, 'deposit:u-1', 500)
  assert.deepEqual(first, { historyFromHeight: 500, firstWatch: true, claimLowered: false })

  const again = await watchAddress(db(), TESTNET, SHARED, 'deposit:u-1', 500)
  assert.deepEqual(again, { historyFromHeight: 500, firstWatch: false, claimLowered: false })

  // A HIGHER claim is ignored by `least` and is therefore not a lowering either — the row still
  // says 500, and nothing needs redoing.
  const higher = await watchAddress(db(), TESTNET, SHARED, 'deposit:u-1', 900)
  assert.deepEqual(higher, { historyFromHeight: 500, firstWatch: false, claimLowered: false })

  const lower = await watchAddress(db(), TESTNET, SHARED, 'deposit:u-1', 200)
  assert.deepEqual(lower, { historyFromHeight: 200, firstWatch: false, claimLowered: true })

  // Null is not a low claim, it is no claim — so a row that had none and now has one has reached
  // further back than it did, whatever the number is.
  await watchAddress(db(), TESTNET, `${SHARED}-z`, 'deposit:u-4')
  const stated = await watchAddress(db(), TESTNET, `${SHARED}-z`, 'deposit:u-4', 4_000_000)
  assert.deepEqual(stated, {
    historyFromHeight: 4_000_000,
    firstWatch: false,
    claimLowered: true,
  })
})

test('checkpoints, halts and backfill ranges are per network', { skip }, async () => {
  await setCheckpoint(db(), TESTNET, TIP_STREAM, 100, '0xdead')
  await recordTip(db(), TESTNET, 140)
  await haltChain(db(), TESTNET, 'a reorg past the alarm depth')

  assert.equal((await getCheckpoint(db(), TESTNET, TIP_STREAM))?.height, 100)
  assert.equal((await getCheckpoint(db(), TESTNET, TIP_STREAM))?.tipHeight, 140)
  assert.equal(await isHalted(db(), TESTNET), true)
  // A halted testnet must not stop mainnet, which is the whole reason the flag is scoped.
  assert.equal(await isHalted(db(), MAINNET), false)
  assert.equal(await getCheckpoint(db(), MAINNET, TIP_STREAM), null)

  await ensureBackfill(db(), TESTNET, 0, 50)
  assert.equal((await nextUnfinishedBackfill(db(), TESTNET))?.rangeTo, 50)
  assert.equal(await nextUnfinishedBackfill(db(), MAINNET), null)
})

test('two blocks may not claim one height without the first being orphaned', { skip }, async () => {
  await seedBlock(TESTNET, 7, 'aa')
  // The constraint that turns a reorg implementation which forgot to orphan into a loud 23505
  // rather than a history in which two blocks silently claim height seven.
  await assert.rejects(
    () => seedBlock(TESTNET, 7, 'bb'),
    (err: unknown) => (err as { code?: string }).code === '23505',
  )

  await orphanAbove(db(), TESTNET, 6, 1)
  await seedBlock(TESTNET, 7, 'bb')
  assert.equal((await blockAtHeight(db(), TESTNET, 7))?.hash, `0x${'bb'.padStart(64, '0')}`)
  assert.equal((await headBlock(db(), TESTNET))?.height, 7)
})

test('family-specific detail lands as an object, not as a quoted blob', { skip }, async () => {
  // The failure this catches is silent: bind the value as a stringified string and the column
  // holds a JSON string, `detail->>'ledgerIndex'` returns null, and the read API hands a caller a
  // quoted blob where it promised a field.
  await seedMovement(TESTNET, 4, 'aa', 1n)
  const block = await blockAtHeight(db(), TESTNET, 4)
  assert.equal(typeof block?.detail, 'object')
  assert.equal(block?.detail['ledgerIndex'], 4)
  const typed = await sql<{ kind: string; value: string }[]>`
    select jsonb_typeof(detail) as kind, detail->>'ledgerIndex' as value
      from blocks where chain = ${TESTNET.chain} and network = ${TESTNET.network} and height = 4
  `
  assert.equal(typed[0]?.kind, 'object')
  assert.equal(typed[0]?.value, '4')

  const tx = await sql<{ kind: string }[]>`
    select jsonb_typeof(raw_ref) as kind from transactions
     where chain = ${TESTNET.chain} and network = ${TESTNET.network}
  `
  assert.equal(tx[0]?.kind, 'object')
})

test('re-recording a movement is an update, and the insert flag says so', { skip }, async () => {
  const seeded = await seedMovement(TESTNET, 3, 'aa', 500n)
  const again = await upsertActivity(db(), TESTNET, {
    address: SHARED,
    direction: 'in',
    assetCode: 'XRP',
    assetKind: 'native',
    tokenAddress: null,
    amount: 500n,
    txHash: seeded.txHash,
    entryKey: activityEntryKey(null, 'in', SHARED),
    logIndex: null,
    blockHeight: 3,
    blockHash: `0x${'aa'.padStart(64, '0')}`,
  })
  assert.equal(again.id, seeded.id, 'the same row')
  assert.equal(again.inserted, false, 'which is what stops a re-index announcing a second deposit')
})

test('orphaning retracts a confirmation as well as the movement', { skip }, async () => {
  const seeded = await seedMovement(TESTNET, 12, 'aa', 700n)
  await watchAddress(db(), TESTNET, SHARED, null)
  await markConfirmed(db(), TESTNET, [seeded.id])

  const before = await sql<{ confirmed_at: Date | null }[]>`
    select confirmed_at from address_activity where id = ${seeded.id}
  `
  assert.ok(before[0]?.confirmed_at instanceof Date)

  const counts = await orphanAbove(db(), TESTNET, 11, 1)
  assert.equal(counts.blockHashes.length, 1)
  assert.equal(counts.transactions, 1)
  assert.equal(counts.activity, 1)

  const after = await sql<{ status: string; confirmed_at: Date | null; reorged_at: Date | null }[]>`
    select status, confirmed_at, reorged_at from address_activity where id = ${seeded.id}
  `
  assert.equal(after[0]?.status, 'orphaned')
  // A confirmation is a statement about depth on the canonical chain, and the canonical chain no
  // longer contains this movement. Leaving it standing would be the wrong credit the alarm exists
  // to prevent.
  assert.equal(after[0]?.confirmed_at, null)
  assert.ok(after[0]?.reorged_at instanceof Date)
  // Retracted, not deleted: the row is the evidence of the incident.
  assert.equal(
    (
      await sql<{ n: number }[]>`select count(*)::int as n from address_activity`
    )[0]?.n,
    1,
  )
})

test('only watched, included, inbound movements are offered for confirmation', { skip }, async () => {
  await seedMovement(TESTNET, 1, 'aa', 100n)
  await seedMovement(TESTNET, 2, 'bb', 200n)

  // Nothing is watched yet, so nothing is offered — the indexer records everything and announces
  // only what a consumer asked to hear about.
  assert.equal((await pendingConfirmations(db(), TESTNET, 10, 50)).length, 0)

  await watchAddress(db(), TESTNET, SHARED, null)
  const pending = await pendingConfirmations(db(), TESTNET, 10, 50)
  assert.equal(pending.length, 2)
  assert.equal(pending[0]?.blockHeight, 1, 'oldest first')
  assert.equal(pending[0]?.amount, 100n, 'amounts survive as bigints, never as floats')

  // The height bound is the depth policy, applied by the caller from contracts-chain.
  assert.equal((await pendingConfirmations(db(), TESTNET, 1, 50)).length, 1)

  await markConfirmed(db(), TESTNET, pending.map((p) => p.id))
  assert.equal((await pendingConfirmations(db(), TESTNET, 10, 50)).length, 0)
})

test('activity pages by keyset, newest first, without repeating or skipping a row', { skip }, async () => {
  for (let height = 1; height <= 5; height++) {
    await seedMovement(TESTNET, height, `${height}${height}`, BigInt(height * 100))
  }
  await watchAddress(db(), TESTNET, SHARED, null)

  const first = await activityForAddress(db(), TESTNET, SHARED, 2, null)
  assert.deepEqual(first.items.map((i) => i.blockHeight), [5, 4])
  assert.ok(first.nextCursor)

  const second = await activityForAddress(db(), TESTNET, SHARED, 2, first.nextCursor)
  assert.deepEqual(second.items.map((i) => i.blockHeight), [3, 2])

  const third = await activityForAddress(db(), TESTNET, SHARED, 2, second.nextCursor)
  assert.deepEqual(third.items.map((i) => i.blockHeight), [1])
  assert.equal(third.nextCursor, null)

  // An offset would shift every page boundary as the head grows; a keyset does not.
  const seen = [...first.items, ...second.items, ...third.items].map((i) => i.id)
  assert.equal(new Set(seen).size, 5)
})
