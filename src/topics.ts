/**
 * The producer half of the bus contract: what this service puts on the wire, and whether the estate
 * can read it.
 *
 * ## The defect this file exists to close
 *
 * Every consumer in the estate is pinned to `@cloudsforge/contracts-events`. `activity` declares its
 * classifier table `satisfies Readonly<Record<TopicName, _>>`; `notify` asserts it has a rule for
 * every registry topic. **The producer was pinned to nothing at all** — not to the topic names and,
 * worse, not to the shape of the envelope it wrote them into.
 *
 * Two instances of that one class were live in this repository, and either alone means nothing this
 * service emits can be read by a contract-following consumer:
 *
 *   - **A signature scheme drifted from the contract.** A local `sha256=<hmac>` under a local
 *     `x-cloudsforge-signature`, where the contract signs `t=…,v1=…` under `cf-signature`. This was
 *     the LAST copy of that scheme still producing deliveries in the estate; `settlement` was
 *     carrying a second inbound arm on its account, and `wallet` a second outbound expectation.
 *   - **An envelope the contract refuses.** `version` went out as the integer `1` where the contract
 *     types it "major.minor", and `actor` and `correlation_id` went out as NULL — which they are on
 *     every event this service has ever written, because all six emit sites (`evm.ts`,
 *     `bitcoin.ts`, `solana.ts`) are woken by a block rather than by a
 *     request and name neither. `validateEnvelope` refuses all three.
 *
 * These are one defect wearing two hats: **the producer is free and the consumer is pinned.** So
 * this file pins the producer, in both directions and two ways:
 *
 *   1. **At compile time.** `EventEnvelope` in `outbox.ts` is the contract's, imported rather than
 *      restated, so its `version` is `EventVersion` and assigning the stored integer to it is a type
 *      error — which is `pnpm typecheck`, which is the build.
 *   2. **At test time, against the source rather than against this list.** `topics.test.ts` reads
 *      every topic literal out of `src/` and reconciles that set with the registry, and it builds a
 *      real envelope through the relay's own `buildEnvelope` and hands it to the contract's own
 *      `classifyEnvelope`. A test that compared this list with the registry would agree with itself
 *      for ever while the emit sites drifted underneath it — which is exactly what happened
 *      elsewhere in the estate.
 */

import {
  classifyEnvelope,
  isRegisteredTopic,
  isValidTopicName,
  topicsProducedBy,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { DEPOSIT_CONFIRMED, DEPOSIT_OBSERVED } from './outbox.ts'

/** This service's own name, and the namespace it is the only permitted producer under. */
export const SERVICE = 'indexer'

/**
 * Every topic this service emits.
 *
 * The constants are imported from the module that declares them rather than redeclared, so this
 * list cannot name a topic whose spelling has since changed under it. `topics.test.ts` additionally
 * reads the literals back out of `src/`, so it cannot name one that no emit site produces either.
 */
export const EMITTED_TOPICS = Object.freeze([DEPOSIT_OBSERVED, DEPOSIT_CONFIRMED] as const)

export interface ProposedTopic {
  /** Why the fact belongs on the bus at all. Read by a human reviewing the contracts change. */
  readonly reason: string
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Topics this service emits that the shared registry does not yet name.
 *
 * A quarantine, not an exemption, with three properties that keep it honest:
 *
 *   - An entry carries the exact `TopicSpec` it is asking for, so adopting it into
 *     `contracts/packages/events/src/index.ts` is a copy rather than a fresh design.
 *   - `topics.test.ts` asserts every entry is **genuinely absent** from the registry. The moment
 *     contracts registers one, this file fails until the entry is deleted — so the quarantine
 *     empties itself rather than rotting into a permanent allow-list.
 *   - An emit site whose topic is in neither the registry nor here fails the test.
 *
 * `keyedBy` on each is read off the emit site, never chosen here: the key is the ordering partition,
 * so it is contract rather than a producer's private preference.
 *
 * ## BOTH ENTRIES ARE HERE, AND THAT IS THE MOST EXPOSED STATE IN THE ESTATE
 *
 * `indexer` is a permitted `ProducerService` in the contract and owns **zero** registered topics:
 * `topicsProducedBy('indexer')` returns an empty list. Meanwhile `micro-wallet` subscribes to both
 * of these by name (`wallet/src/outbox.ts`) and credits money off the second. So the deposit
 * path — the one path in the estate where an event moves a balance — runs entirely on two topic
 * names no registry has ever agreed to. Nothing enforces the payload, nothing enforces the key, and
 * a rename on either side is silent on both.
 *
 * That is a `micro-contracts` change, not one this repository can land. Until it does, the relay
 * still delivers them: `buildEnvelope` refuses `malformed` and permits `unregistered_topic`,
 * because refusing an unregistered topic here would relay nothing at all — see its header.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({
  [DEPOSIT_OBSERVED]: {
    reason:
      'The chain contains a transaction paying a watched address, at any depth including zero. It is evidence, not permission: nothing may credit a balance on it. wallet subscribes to it today (wallet/src/outbox.ts:83) to show a pending deposit before it is spendable, which is the difference between a user who waits and a user who files a support ticket.',
    spec: Object.freeze({
      producer: SERVICE,
      payloadType: 'DepositObserved',
      version: '1.0',
      keyedBy: 'chain:network:address',
      description:
        'A watched address was paid, at any depth including zero. Evidence, never permission to credit.',
    }),
  },
  [DEPOSIT_CONFIRMED]: {
    reason:
      'The same movement has reached the depth contracts-chain publishes for the asset. STILL evidence: the indexer never decides whether to credit a balance — it reports what the chain says and wallet decides, because a service that both watches the chain and moves the money is a service where a bug in the first half spends the second half. wallet credits off this event (wallet/src/deposits.ts, via INDEXER_DEPOSIT_CONFIRMED), so it is the highest-consequence unregistered topic in the estate.',
    spec: Object.freeze({
      producer: SERVICE,
      payloadType: 'DepositConfirmed',
      version: '1.0',
      keyedBy: 'chain:network:address',
      description:
        'A watched inbound movement reached its required confirmation depth. wallet decides whether to credit.',
    }),
  },
})

/**
 * The ordering partition each emitted topic uses.
 *
 * **`key` IS THE ORDERING PARTITION, SO IT IS CONTRACT AND NOT A PRODUCER'S PREFERENCE.** Events
 * sharing a `(topic, key)` are delivered in the order they were written and no other pair has any
 * ordering relationship whatsoever. Keying by the ADDRESS is what makes two movements on one
 * address arrive in chain order while two different addresses do not serialise against each other;
 * keying by, say, the transaction hash would make every deposit its own partition and the ordering
 * guarantee would say nothing at all.
 *
 * The chain and network are in the key rather than only in the payload because one address string
 * can exist on two networks — an EVM address is valid on mainnet and testnet alike — and an
 * ordering partition that merged them would interleave two chains' histories.
 */
export const KEYED_BY: Readonly<Record<string, string>> = Object.freeze({
  [DEPOSIT_OBSERVED]: 'chain:network:address',
  [DEPOSIT_CONFIRMED]: 'chain:network:address',
})

/* ------------------------------------------------------------------ reconciliation */

/** Topics this service emits that no registry names and no proposal explains — always a defect. */
export function undeclaredTopics(emitted: readonly string[]): readonly string[] {
  return emitted
    .filter((topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic))
    .sort()
}

/**
 * Registry topics this service owns and never emits — a feature that can never fire.
 *
 * The direction that is easiest to miss, because nothing breaks and nothing logs: consumers
 * classify the topic, the code path renders it, and nothing ever arrives. It is the direction
 * `settlement.withdrawal.stuck`, `custody.key.exported` and `mint.deploy.confirmed` were all wrong
 * in. It is vacuously empty here TODAY only because the registry names no indexer topic at all,
 * which is the finding above rather than a clean bill of health — and it stops being vacuous the
 * instant contracts adopts either proposal.
 */
export function unemittedOwnedTopics(emitted: readonly string[]): readonly TopicName[] {
  const seen = new Set(emitted)
  return topicsProducedBy(SERVICE).filter((topic) => !seen.has(topic))
}

/** Proposals the registry has since adopted. Non-empty means delete the entry from the quarantine. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/** A proposal that could not be pasted into the registry as it stands. */
export function malformedProposals(): readonly string[] {
  return Object.entries(AWAITING_REGISTRATION)
    .filter(([topic, proposal]) => {
      if (!isValidTopicName(topic) || !topic.startsWith(`${SERVICE}.`)) return true
      if (proposal.spec.producer !== SERVICE) return true
      if (proposal.spec.keyedBy.trim() === '') return true
      if (proposal.reason.trim().length < 20) return true
      return false
    })
    .map(([topic]) => topic)
    .sort()
}

/* ------------------------------------------------------------------ the envelope */

/**
 * Every reason a contract-following consumer would refuse this envelope.
 *
 * The check itself is `classifyEnvelope`, and it is the contract's — the exact check `activity`'s
 * ingest and `notify` run on a delivered body. Running it here, on an envelope this service's relay
 * actually built, is the only way a producer finds out it is unreadable without waiting for two
 * services to be composed. Composing two services is how the integer-version defect was found, and
 * it was found months late.
 *
 * `classifyEnvelope` rather than the contract's own `envelopeDefects(value, awaiting)` wrapper, for
 * the reason `settlement/src/topics.ts` records: `unregisteredTopic` is a FIELD on the verdict, not
 * a sentence in a list, so there is nothing here for a future flattening to drop. Five repositories
 * previously matched the contract's error SENTENCE byte for byte and would all have stopped
 * excusing anything the day it was reworded.
 *
 * What this file decides and the contract cannot: **which** unregistered topics are excused — the
 * ones `AWAITING_REGISTRATION` proposes, and nothing else. Everything else the contract found is
 * returned, because each of those is this service emitting the unreadable.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = classifyEnvelope(envelope)
  // Reported FIRST, where `validateEnvelope` has always put it, so a reader of a failure sees the
  // registry question before the envelope's own faults.
  const unexplained =
    verdict.unregisteredTopic !== null &&
    !Object.hasOwn(AWAITING_REGISTRATION, verdict.unregisteredTopic)
      ? [
          `topic: "${verdict.unregisteredTopic}" is not in the registry, and AWAITING_REGISTRATION does not propose it`,
        ]
      : []
  return [...unexplained, ...verdict.defects]
}
