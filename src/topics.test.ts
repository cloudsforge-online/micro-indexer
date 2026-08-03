/**
 * The producer half of the bus contract, checked against the source rather than against a list.
 *
 * Three families of check, for the three shapes one defect class takes — and this repository was
 * the last in the estate carrying two of them at once, which is why nothing it emitted could be
 * read by a contract-following consumer:
 *
 *   1. **The name.** Reconciling the emitted set with the registry in BOTH directions is what
 *      catches a producer using a name the estate does not know (`custody.export.completed`,
 *      `settlement.outbound.stuck`, `mint.token.deployed`) and a registry name no producer emits
 *      (`settlement.withdrawal.stuck`, `custody.key.exported`). Reading the literals back out of
 *      `src/` is what stops the check agreeing with itself while the emit sites drift.
 *   2. **The envelope.** `version` went out as the integer `1` where the contract types it
 *      "major.minor", and `actor` and `correlationId` went out as `null` on EVERY event this
 *      service has ever written. All three are refused by `validateEnvelope`. This suite was green
 *      throughout, because both sides tested against imagined counterparts. The only check that
 *      could have caught it is the one below: build an envelope with the relay's own
 *      `buildEnvelope` and hand it to the contract's own `classifyEnvelope`.
 *   3. **The signature.** A local `sha256=` under a local header, where the contract signs
 *      `t=…,v1=…` under `cf-signature`. This repository held the last copy of that scheme in the
 *      estate.
 *
 * No database. Pure text, set arithmetic and a few function calls, so it runs in CI even when the
 * database-backed suite skips. The end-to-end half — a REAL outbox row, written by the real chain
 * worker, through `buildEnvelope` into the contract's classifier — is in `evm.test.ts`, because
 * that is where a real row exists.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TOPIC_HEADER,
  TOPIC_NAMES,
  isRegisteredTopic,
  parseVersion,
  topicsProducedBy,
  verifyDelivery,
} from '@cloudsforge/contracts-events'
import { buildEnvelope, signEvent, verifyEventSignature } from './outbox.ts'
import {
  AWAITING_REGISTRATION,
  EMITTED_TOPICS,
  KEYED_BY,
  SERVICE,
  adoptedProposals,
  envelopeDefects,
  malformedProposals,
  undeclaredTopics,
  unemittedOwnedTopics,
} from './topics.ts'

const SRC = dirname(fileURLToPath(import.meta.url))

function sourceFiles(): readonly string[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => join(SRC, file))
}

/**
 * The files a topic literal may legitimately appear in.
 *
 * `topics.ts` is excluded, and that exclusion is the whole check rather than a convenience: it is
 * the file holding `EMITTED_TOPICS` and the quarantine, and it is the thing being checked. Scanning
 * it would let a quarantine entry justify its own existence — a topic could be declared,
 * quarantined and never emitted, and every assertion below would still agree.
 */
function emitSourceFiles(): readonly string[] {
  return sourceFiles().filter((file) => !file.endsWith('/topics.ts'))
}

/**
 * Every topic literal in this service's namespace that appears anywhere in `src/`.
 *
 * Not `topic: '<name>'`: this service names its topics through exported constants
 * (`DEPOSIT_OBSERVED = 'indexer.deposit.observed'`) and the emit sites reference the constant, so a
 * scan for the emit-site shape would find nothing at all and pass vacuously. Matching every
 * well-formed `indexer.*.*` string literal finds both spellings, and it is the one that also catches
 * a CONSTANT that no emit site uses — a name a consumer could subscribe to for ever and never hear
 * from.
 *
 * Comment lines are skipped, and that is load-bearing rather than tidy: `outbox.ts` discusses both
 * topics in prose while explaining what they mean, and counting a sentence about a topic as an
 * emission is precisely the failure this estate found when a guard passed because its own prose
 * naming a function counted as a reference.
 */
function topicsInSource(): readonly string[] {
  const found = new Set<string>()
  const literal = new RegExp(`'(${SERVICE}\\.[a-z0-9_]+\\.[a-z0-9_]+)'`, 'g')
  for (const file of emitSourceFiles()) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (/\b(?:action|scope|resource|permission)\s*:/.test(line)) continue
      for (const match of line.matchAll(literal)) if (match[1]) found.add(match[1])
    }
  }
  return [...found].sort()
}

/* ------------------------------------------------------------------ the names */

test('the source emits exactly the topics this service declares', () => {
  // Both halves of the drift: a literal in `src/` that EMITTED_TOPICS does not list, and an entry
  // in EMITTED_TOPICS that no literal backs. The second half is what stops the list being repaired
  // by editing the list.
  assert.deepEqual(
    topicsInSource(),
    [...EMITTED_TOPICS].sort(),
    'src/ and EMITTED_TOPICS disagree about what this service puts on the bus',
  )
})

test('the literal scanner does not count a topic named in prose', () => {
  // The scanner is exercised before it is trusted, because it is the input to every assertion above
  // and below. A scanner that silently matched nothing would make all of them pass.
  assert.ok(topicsInSource().length >= 2, 'the scanner found nothing — it is broken, not the source')
  assert.ok(topicsInSource().includes('indexer.deposit.confirmed'))
})

test('every topic this service emits is one the estate has a name for', () => {
  assert.deepEqual(
    undeclaredTopics(topicsInSource()),
    [],
    'emitted, but in neither the registry nor AWAITING_REGISTRATION — decide which, then say so',
  )
})

test('every registry topic this service owns is actually emitted', () => {
  assert.deepEqual(
    unemittedOwnedTopics(topicsInSource()),
    [],
    'the registry says indexer produces these and no emit site does — every consumer of each is dead code',
  )
  // **And the registry is being read rather than the check passing by accident.** It passes
  // VACUOUSLY today: `indexer` is a permitted producer with zero registered topics, so there is
  // nothing for the loop to miss. That is the finding recorded in `AWAITING_REGISTRATION`, not a
  // clean bill of health, and this assertion says so out loud so that a future reader does not
  // mistake an empty list for a checked one.
  assert.equal(topicsProducedBy(SERVICE).length, 0, 'contracts has adopted an indexer topic — delete the quarantine entry and re-read this test')
  assert.ok(TOPIC_NAMES.length >= 40, 'the registry itself is being read')
})

test('a pending proposal disappears once contracts adopts it', () => {
  // Without this the quarantine becomes a permanent allow-list: the topic gets registered, the
  // entry stays, and the next reader believes the topic is still unregistered.
  assert.deepEqual(
    adoptedProposals(),
    [],
    'the registry now names these — delete them from AWAITING_REGISTRATION',
  )
  // Not vacuous: the quarantine is non-empty and every entry is genuinely absent from the registry.
  assert.equal(Object.keys(AWAITING_REGISTRATION).length, 2)
  for (const topic of Object.keys(AWAITING_REGISTRATION)) {
    assert.equal(isRegisteredTopic(topic), false, `${topic} is registered now`)
  }
})

test('every pending proposal carries a spec that could be pasted into the registry', () => {
  assert.deepEqual(
    malformedProposals(),
    [],
    'a proposal needs a well-formed indexer topic, a real ordering key, and a reason worth reading',
  )
  // The ordering key is stated in one place and read in two, so the two may not disagree.
  for (const [topic, proposal] of Object.entries(AWAITING_REGISTRATION)) {
    assert.equal(KEYED_BY[topic], proposal.spec.keyedBy, `${topic} keys disagree`)
  }
})

/* ------------------------------------------------------------------ the envelope */

/**
 * A stored outbox row exactly as this service writes one.
 *
 * **`actor` and `correlation_id` are null, and that is the COMMON case here rather than the rare
 * one.** All six emit sites are reached from a chain worker woken by a block — there is no inbound
 * request and no principal — so every event this service has ever written stored nulls in both.
 * A fixture that supplied them would be testing an envelope this service does not produce.
 */
const ROW = {
  id: '018f0000-0000-7000-8000-0000000000a1',
  topic: 'indexer.deposit.confirmed',
  key: 'ember:testnet:0xaa',
  occurred_at: new Date('2026-08-03T10:00:00.000Z'),
  producer: SERVICE,
  version: 1,
  actor: null,
  correlation_id: null,
  payload: { address: '0xaa', amount: '9', confirmations: 60 },
}

/**
 * **THE TRAP, STATED FIRST: prove the reader can fail before trusting that it passed.**
 *
 * A test in this estate stayed green with the logic deliberately broken because the payload lacked
 * the field being read and an absent field is null to every reader — null being the expected answer.
 * The same shape of vacuity is available here: `envelopeDefects` returning `[]` proves nothing
 * unless something is known to make it return a non-empty list.
 *
 * So YESTERDAY'S ENVELOPE is built by hand first — the exact object the relay used to construct,
 * with the integer version and the nulls passed straight through — and every one of its three
 * defects is named. If this test ever goes green, the classifier has stopped classifying and every
 * assertion below it is worthless.
 */
test("the pre-migration envelope is refused, and all three reasons are named", () => {
  const yesterday = {
    id: ROW.id,
    topic: ROW.topic,
    key: ROW.key,
    occurredAt: ROW.occurred_at.toISOString(),
    producer: ROW.producer,
    // The integer, as the old `EventEnvelope` in this file typed it and as the relay sent it.
    version: ROW.version as unknown as string,
    actor: ROW.actor,
    correlationId: ROW.correlation_id,
    payload: ROW.payload,
  }
  const defects = envelopeDefects(yesterday)
  assert.ok(defects.some((e) => e.startsWith('version:')), `version must be named: ${defects.join('; ')}`)
  assert.ok(defects.some((e) => e.startsWith('actor:')), `actor must be named: ${defects.join('; ')}`)
  assert.ok(
    defects.some((e) => e.startsWith('correlationId:')),
    `correlationId must be named: ${defects.join('; ')}`,
  )
  // And the unregistered topic is NOT among them: it is proposed, so it is excused, and excusing it
  // must not quietly excuse the three real producer bugs alongside it.
  assert.ok(!defects.some((e) => e.includes('is not in the registry')))
})

test('THE RULE: the envelope this relay builds is one the contract accepts', () => {
  // The check whose absence let this service relay nothing but refusals. `classifyEnvelope` is the
  // contract's own function and is literally what activity's ingest and notify run on a delivered
  // body — not a restatement of it here.
  for (const topic of topicsInSource()) {
    const built = buildEnvelope({ ...ROW, topic })
    assert.ok(built.ok, `${topic}: the relay would refuse its own envelope`)
    assert.deepEqual(
      envelopeDefects(JSON.parse(JSON.stringify(built.value))),
      [],
      `an event on ${topic} would be refused by every consumer in the estate`,
    )
  }
})

test('the version on the wire is "major.minor", never the stored integer', () => {
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  assert.equal(typeof built.value.version, 'string')
  assert.equal(built.value.version, '1.0')
  assert.equal(parseVersion(built.value.version).ok, true)
  assert.equal(parseVersion(String(ROW.version)).ok, false, 'the stored integer is NOT a wire version')
})

test('a row with no actor and no correlation id still makes a readable envelope', () => {
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  // `system` is the contract's own value for "no principal did this", which is exactly what a null
  // actor column means for a worker woken by a block.
  assert.equal(built.value.actor, 'system')
  // An id that ties the event to itself is weaker than one that ties it to a request, but it is
  // never absent — and an absent one is where a cross-service investigation stops.
  assert.equal(built.value.correlationId, ROW.id)
})

test('the relay refuses a malformed row and permits a merely unregistered one', () => {
  // The distinction the whole `classifyEnvelope`-rather-than-`validateEnvelope` choice rests on.
  // Refusing on "unregistered" would relay NOTHING from this service, because neither of its topics
  // is registered; refusing on "malformed" is the check that had to exist.
  const unregisteredOnly = buildEnvelope(ROW)
  assert.ok(unregisteredOnly.ok, 'a proposed-but-unregistered topic must still be delivered')
  assert.equal(unregisteredOnly.unregisteredTopic, ROW.topic)

  const malformed = buildEnvelope({ ...ROW, key: '' })
  assert.equal(malformed.ok, false, 'an empty key leaves ordering undefined and must not be sent')

  // A topic that is neither registered nor proposed is not excused by `envelopeDefects` either.
  const unexplained = { ...ROW, topic: 'indexer.nothing.happened' }
  const built = buildEnvelope(unexplained)
  assert.ok(built.ok)
  assert.ok(envelopeDefects(JSON.parse(JSON.stringify(built.value))).length > 0)
})

/* ------------------------------------------------------------------ the delivery */

const SECRET = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'

test('the delivery this relay signs is one a contract-following consumer verifies', () => {
  // The other half of the same story: the header name and the signature scheme are the contract's
  // too. This service carried the LAST drifted copy in the estate (`x-cloudsforge-signature`,
  // `sha256=<hmac>`), so every delivery to a contract-following consumer was refused before the
  // body was looked at — first as "signature: missing", then as `malformed_header`.
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  const body = JSON.stringify(built.value)

  assert.equal(SIGNATURE_HEADER, 'cf-signature')
  assert.equal(EVENT_ID_HEADER, 'cf-event-id')
  assert.equal(TOPIC_HEADER, 'cf-topic')

  const verification = verifyDelivery(body, signEvent(body, SECRET), [SECRET])
  assert.equal(verification.ok, true)
  assert.equal(verifyEventSignature(body, SECRET, signEvent(body, SECRET)), true)

  // The old scheme is not what this service produces any more, and a receiver of the old scheme
  // does not accept the new one — the two are genuinely different, not one renamed.
  const legacy = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
  assert.ok(!signEvent(body, SECRET).startsWith('sha256='))
  assert.match(signEvent(body, SECRET), /^t=\d+,v1=[0-9a-f]{64}$/)
  assert.notEqual(signEvent(body, SECRET), legacy)
  assert.equal(verifyDelivery(body, legacy, [SECRET]).ok, false)

  // Tampering, a wrong secret and an absent header are all refused.
  assert.equal(verifyEventSignature(`${body} `, SECRET, signEvent(body, SECRET)), false)
  assert.equal(verifyEventSignature(body, 'a-different-secret-that-is-long-enough', signEvent(body, SECRET)), false)
  assert.equal(verifyEventSignature(body, SECRET, ''), false)
})

test('the signature carries a timestamp, so a captured delivery is not a permanent credential', () => {
  // What the old scheme could not do at all: its MAC covered the body alone, so a delivery captured
  // once was replayable for ever. The contract puts the timestamp INSIDE the signed message, which
  // is what makes a subscriber's freshness window mean anything.
  const built = buildEnvelope(ROW)
  assert.ok(built.ok)
  const body = JSON.stringify(built.value)
  const signature = signEvent(body, SECRET)

  const now = Date.now()
  assert.equal(verifyDelivery(body, signature, [SECRET], { now }).ok, true)
  const stale = verifyDelivery(body, signature, [SECRET], { now: now + 600_000 })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok === false && stale.reason, 'stale')

  // And the timestamp cannot be moved without invalidating the MAC.
  const moved = signature.replace(/^t=\d+/, `t=${Math.floor((now + 600_000) / 1000)}`)
  assert.equal(verifyDelivery(body, moved, [SECRET], { now: now + 600_000 }).ok, false)
})

/* ------------------------------------------------------------------ reachability */

/**
 * A guard that proves a topic name is correct proves nothing about whether the emit is reached.
 *
 * `identity/src/sessions.ts:390` exports `emitSessionRevoked` and NOTHING CALLS IT — so
 * `identity.session.revoked` is produced by dead code while identity's own guard passes, because it
 * scans literals rather than reachability. This is the cheapest check that catches that exact shape.
 *
 * The detector is exercised on a fixture FIRST. This repository emits inline from three chain
 * workers and exports no `emit*` function at all, so without the fixture this would be a scan that
 * finds nothing because there is nothing — indistinguishable from a scan that finds nothing because
 * it is broken, which is precisely the "check that cannot fail" this estate keeps rediscovering.
 */
function unreachedEmitters(files: readonly { name: string; text: string }[]): readonly string[] {
  const declared: { symbol: string; where: string }[] = []
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      const match = /^export (?:async )?function (emit[A-Za-z0-9_]*)/.exec(line)
      if (match?.[1]) declared.push({ symbol: match[1], where: `${file.name}:${index + 1}` })
    })
  }
  return declared
    .filter(({ symbol }) => {
      const reference = new RegExp(`\\b${symbol}\\b`)
      for (const file of files) {
        for (const line of file.text.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
          if (/^export (?:async )?function /.test(trimmed)) continue
          if (reference.test(line)) return false
        }
      }
      return true
    })
    .map(({ symbol, where }) => `${symbol} (${where})`)
    .sort()
}

test('the unreachable-emitter detector can actually fail', () => {
  const dead = [{ name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' }]
  assert.deepEqual(unreachedEmitters(dead), ['emitSessionRevoked (sessions.ts:1)'])

  const alive = [
    { name: 'sessions.ts', text: 'export function emitSessionRevoked(): void {}\n' },
    { name: 'server.ts', text: 'emitSessionRevoked()\n' },
  ]
  assert.deepEqual(unreachedEmitters(alive), [])
})

test('every exported emitter is reached from somewhere', () => {
  assert.deepEqual(
    unreachedEmitters(sourceFiles().map((name) => ({ name, text: readFileSync(name, 'utf8') }))),
    [],
    'exported, emits an event, and no code path reaches it — the topic is produced by dead code',
  )
})
