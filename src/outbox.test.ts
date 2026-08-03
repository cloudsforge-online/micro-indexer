import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { CHAIN_TABLES, MIGRATIONS } from './migrations.ts'
import {
  DEPOSIT_CONFIRMED,
  DEPOSIT_OBSERVED,
  signEvent,
  verifyEventSignature,
  withInbox,
  withOutbox,
  type Db,
} from './outbox.ts'

const SECRET = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'

/* ------------------------------------------------------------------ no database */

test('both topics obey the registry’s shape rule, so registering them later is not a rename', () => {
  // `<service>.<aggregate>.<past-tense-verb>`, three lowercase segments — the pattern
  // @cloudsforge/contracts-events enforces. Neither topic is in its TOPICS map yet; `src/topics.ts`
  // carries the proposal for each, and `topics.test.ts` fails the day contracts adopts one and the
  // quarantine entry is not deleted. The shape rule is what makes that addition additive.
  const shape = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*){2}$/
  for (const topic of [DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED]) {
    assert.match(topic, shape, topic)
    assert.equal(topic.split('.')[0], 'indexer', 'the first segment must be the producer')
  }
})

test('a signature verifies, and one byte of tampering does not', () => {
  const body = JSON.stringify({ id: 'e-1', topic: DEPOSIT_OBSERVED })
  const signature = signEvent(body, SECRET)
  // The CONTRACT's scheme — `t=<seconds>,v1=<hmac over "<seconds>.<body>">`. This asserted
  // `/^sha256=[0-9a-f]{64}$/` for the life of the service, which is the drifted local copy the
  // migration removed; `topics.test.ts` holds the full comparison against the contract's verifier.
  assert.match(signature, /^t=\d+,v1=[0-9a-f]{64}$/)
  assert.equal(verifyEventSignature(body, SECRET, signature), true)
  assert.equal(verifyEventSignature(`${body} `, SECRET, signature), false)
  assert.equal(verifyEventSignature(body, 'a different secret entirely!!', signature), false)
  // A malformed header must be refused rather than throw out of the comparison.
  assert.equal(verifyEventSignature(body, SECRET, 'sha256=short'), false)
  assert.equal(verifyEventSignature(body, SECRET, 't=1,v1=short'), false)
})

/* ------------------------------------------------------------------ database-backed */

const url = process.env['INDEXER_TEST_DATABASE_URL']
const enabled = Boolean(url && /test/i.test(url))
const skip = enabled ? false : 'set INDEXER_TEST_DATABASE_URL (name must contain "test")'

let sql: postgres.Sql
const db = (): Db => sql

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

test('a state change and its event commit together, or neither does', { skip }, async () => {
  await withOutbox(db(), 'indexer', async (tx, emit) => {
    await tx`
      insert into watched_addresses (chain, network, address) values ('ember','testnet','0xaa')
    `
    emit({ topic: DEPOSIT_OBSERVED, key: 'ember:testnet:0xaa', payload: { address: '0xaa' } })
  })
  assert.equal((await sql`select 1 from watched_addresses`).length, 1)
  assert.equal((await sql`select 1 from outbox`).length, 1)

  // The half that matters: a failure after the change leaves no event AND no change. A publish
  // after commit is a publish that is skipped when the process dies in the gap; a publish before
  // commit is a publish of something that never happened.
  await assert.rejects(
    () =>
      withOutbox(db(), 'indexer', async (tx, emit) => {
        await tx`
          insert into watched_addresses (chain, network, address) values ('ember','testnet','0xbb')
        `
        emit({ topic: DEPOSIT_OBSERVED, key: 'ember:testnet:0xbb', payload: {} })
        throw new Error('the block could not be written')
      }),
    /could not be written/,
  )
  assert.equal((await sql`select 1 from watched_addresses`).length, 1, 'the change rolled back')
  assert.equal((await sql`select 1 from outbox`).length, 1, 'and so did its event')
})

test('the envelope carries the producer and the ordering key', { skip }, async () => {
  await withOutbox(db(), 'indexer', async (_tx, emit) => {
    emit({
      topic: DEPOSIT_CONFIRMED,
      key: 'ember:testnet:0xaa',
      payload: { amount: '1000' },
      correlationId: 'req-1',
    })
  })
  const rows = await sql<
    { topic: string; key: string; producer: string; correlation_id: string | null; payload: Record<string, unknown> }[]
  >`select topic, key, producer, correlation_id, payload from outbox`
  assert.equal(rows[0]?.producer, 'indexer')
  // Ordering is per (topic, key) only, so the key is the address: two movements on one address
  // stay in order and two addresses do not serialise against each other.
  assert.equal(rows[0]?.key, 'ember:testnet:0xaa')
  assert.equal(rows[0]?.payload['amount'], '1000', 'an amount is a string, never a float')
  assert.equal(rows[0]?.correlation_id, 'req-1')
})

test('a redelivered event runs its handler once, and a failed one is not swallowed', { skip }, async () => {
  const eventId = '11111111-1111-4111-8111-111111111111'
  let runs = 0
  const first = await withInbox(db(), DEPOSIT_OBSERVED, eventId, async () => {
    runs += 1
    return 'done'
  })
  assert.deepEqual(first, { status: 'processed', value: 'done' })

  const second = await withInbox(db(), DEPOSIT_OBSERVED, eventId, async () => {
    runs += 1
    return 'done'
  })
  assert.deepEqual(second, { status: 'duplicate' })
  assert.equal(runs, 1)

  // A handler that fails leaves no inbox row, so the redelivery is processed rather than lost —
  // the mistake a naive "record then handle" dedupe makes.
  const other = '22222222-2222-4222-8222-222222222222'
  await assert.rejects(
    () => withInbox(db(), DEPOSIT_OBSERVED, other, async () => Promise.reject(new Error('nope'))),
    /nope/,
  )
  assert.equal((await sql`select 1 from inbox where event_id = ${other}`).length, 0)
})
