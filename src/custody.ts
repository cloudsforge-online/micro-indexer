/**
 * Σ confirmed native balance over the custody set — the chain half of the platform's solvency
 * invariant, and the number `micro-ledger` has never once had.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## Why this exists
 *
 * 04-domain-model §2.4: for each asset the ledger's custody total must equal what the indexer
 * observes on chain, and drift beyond tolerance freezes withdrawals. `ledger/src/reconcile.ts`
 * takes an optional `indexerObservedTotal` for that comparison, and until this file existed
 * **nothing in the estate could supply one**. `grep -rn indexerObservedTotal ledger/src` found it
 * passed in exactly one place: a test. The scheduled sweep at `ledger/src/jobs.ts` never
 * passed it, so every reconciliation the platform has ever run took the `liability_sum` branch and
 * compared the ledger against the ledger. A fabricated deposit moves custody and liability
 * together, so those runs reported `clean` about coin that does not exist — and because `clean` is
 * the status that LIFTS a freeze, a vacuous run could delete a freeze a real observation had set.
 *
 * Ledger has since made an unobserved chain asset a hard failure at the database. That closed the
 * lie and opened this: reconciliation now fails until something supplies a real reading. This is
 * that something.
 *
 * ## The three properties the caller depends on, in the order they matter
 *
 * **1. It is an AGGREGATE, and the address set never leaves this service.** Ledger does not know
 * which addresses are custody's and must not learn them — it has no business holding a map from
 * money to people, and the set changes under a caller mid-sweep. The route answers one number.
 *
 * **2. It is CONFIRMED-ONLY, at the chain's own depth.** The balance is read at
 * `head − chainSpec().confirmations + 1`, which is the highest block that has reached the depth
 * `contracts-chain` publishes — 60 for EMBER, ~15 minutes at a 15-second block time. Reading at
 * the head would let a reorg-eligible block become a drift, and a drift freezes withdrawals.
 *
 * **3. IT REFUSES RATHER THAN RETURNING A PARTIAL SUM. This is the sharp one.** A total that is
 * missing one unreadable address is LOW, and low reads at the ledger as *positive* drift — "the
 * ledger claims coin the chain does not show" — which is the reading that freezes withdrawals for
 * the whole asset. So an RPC timeout on one address out of four hundred would stop the estate
 * paying anybody, on the strength of a network blip. There is no partial answer here: every
 * address is read or the whole observation is withheld, and a withheld observation reaches the
 * ledger as `undefined`, which records `unavailable`/`failed` and freezes — the same outcome, but
 * for a reason an operator can act on, and without a number that was never true.
 *
 * This is the same line `reads.tokenBalances` already holds one route over: "a missing balance is
 * missing, never zero, because zero is what evicts a token-gated member" (`server.ts`). Zero
 * here does not evict a member; it says the chain holds nothing, which for a solvency check is the
 * most dangerous sentence in the estate.
 *
 * ## Why the balance is read from the chain and NOT derived from `address_activity`
 *
 * The obvious implementation — sum `in` minus `out` over the custody addresses, as
 * `store.tokenBalancesAt` does for tokens — is wrong for a native asset on an EVM family, and
 * `store.tokenBalancesAt` says so itself:
 *
 *     "Native movements are excluded deliberately. A native balance would also have to account for
 *      gas paid, which `address_activity` does not record as a movement, so the sum would be short
 *      by every fee this address has ever paid — a plausible number and a wrong one."
 *
 * It is worse than short. `evm.ts` records the transaction's `value` as a movement and nothing
 * else, so a derived native balance would be *over*-stated by every gas fee the address has paid
 * (the fee left the account with no `out` row) and *under*-stated by every internal transfer a
 * contract made to it (no top-level value, no row). Two errors in opposite directions, neither
 * bounded. A number built that way is a claim, and claims are what this release removes.
 *
 * `eth_getBalance` at the confirmed height is the account's actual balance including every fee and
 * every internal transfer, as the chain itself computes it. It costs one call per address, which
 * is the price of the answer being true.
 *
 * (Bitcoin and Solana derive movements differently — Bitcoin's inputs are recorded at full value
 * so the fee falls out of inputs-minus-outputs, and Solana's movements come from pre/post balance
 * deltas which already include the fee. Both could in principle be summed from rows. Neither is
 * built here; see `family_not_supported` below, which refuses rather than guessing.)
 *
 * ## The reorg argument, which is two checks and not one
 *
 * `tokenstate.ts` established the rule: this service asks a third party a question about a height,
 * and the third party may have a different block at that height, so the node's block hash at that
 * height is compared with the hash this service walked before any state is read.
 *
 * That check is made **twice here — before the balances and again after** — and the second one is
 * not belt-and-braces. `eth_getBalance` takes a height, not a hash. A reorg landing halfway through
 * four hundred sequential calls would have the first half answered from one chain and the second
 * half from another, and the sum of those two halves is a number that was never true of any state
 * the chain was ever in. It would also look completely ordinary. The closing check is the only
 * thing that can see it.
 *
 * ## The honest boundary
 *
 * **This service cannot audit the completeness of the custody set.** It sums the watched addresses
 * whose label marks them as platform-held; whether that is all of them is asserted by whoever
 * registers addresses — `micro-wallet` for `deposit:`, and nothing at all today for `treasury:`
 * (`micro-settlement` sweeps deposits to a pinned treasury address but holds no `indexer:write`
 * grant, so treasury addresses are not registered here). A swept deployment would therefore
 * under-report, which reads as positive drift and freezes: the safe direction, and a real defect
 * that belongs to whoever owns the sweep. The answer carries `addresses` and `labelPrefixes` so
 * the set that was actually summed is visible to the operator reading the freeze, rather than
 * being an assumption buried in this file.
 *
 * That boundary is the same one `ledger/src/reconcile.ts` states about its own input: "the database
 * can refuse a run that never had evidence, and it cannot audit evidence it is handed."
 *
 * ## Correction, 2026-08-08: treasury addresses ARE registered, and the drift went the other way
 *
 * Two claims above have expired, and the second expired in the direction the first did not predict.
 *
 * `micro-settlement` holds `indexer:write` today (`IDENTITY_SERVICE_TOKEN_GRANTS` in
 * `deploy/compose/docker-compose.estate.yml`), and it uses it: `settlement/src/migrations.ts:367`
 * registers `treasury:${chain}:${network}` at the moment it pins a treasury, which it did on
 * mainnet on 2026-08-05. So `treasury:` is no longer watched by nobody — it is watched by default,
 * and `INDEXER_CUSTODY_LABEL_PREFIXES` has carried `deposit:,treasury:` all along.
 *
 * The passage above reasoned that the gap would make this service **under**-report, "which reads as
 * positive drift and freezes: the safe direction". What actually happened on mainnet was the
 * reverse. A treasury holds the platform's own float — coin owed to nobody, with no liability and
 * therefore no custody position behind it. Summing it here adds to one side of the reconciliation
 * and nothing to the other, so the drift is **negative**: `-25.000021 EMBER`, EMBER frozen,
 * withdrawals refused estate-wide from 2026-08-05 until the float was given a ledger position on
 * 2026-08-08. `deploy/scripts/ember-seed.js:415` had named this exact failure in advance — "an
 * invented insolvency" — and warned that a faucet float must therefore not be registered.
 *
 * Nothing in this file was wrong to sum. An address the platform controls IS platform-held, which
 * is what the label asserts, and this service is right to count it. The defect is one level up: an
 * address may be registered here without anything guaranteeing it has a ledger position, and the
 * reconciliation then compares a total over both kinds of coin with a total over one. That is why
 * the answer carries `addresses` and `labelPrefixes` — on 2026-08-08 those two fields were what
 * showed the operator that the sum included a treasury nobody had booked. The boundary stated
 * above is real; what needed correcting is the assumption about which direction crossing it hurts.
 *
 * ## Correction, 2026-08-08: Bitcoin IS built here now, and it is derived rather than read
 *
 * The section above — "Why the balance is read from the chain and NOT derived from
 * `address_activity`" — is still the whole argument for the EVM families and is unchanged for them.
 * It also said of Bitcoin and Solana that "both could in principle be summed from rows. Neither is
 * built here." Bitcoin now is, because `family_not_supported` had become the thing blocking G6:
 * `LTC` is in the ledger's `chain_assets` (migration 14), which makes `liability_sum` illegal for
 * it, so naming LTC in `LEDGER_RECONCILE_ASSETS` against a build that cannot observe it does not
 * check Litecoin — it freezes Litecoin for ever, since only a clean OBSERVED run lifts a freeze.
 * micro-org#252.
 *
 * What is derived is NOT `in − out`. That formulation is the one the section above rejects, and it
 * is wrong here for a reason specific to this worker: `bitcoin.ts` writes an outbound movement only
 * when the input's prevout RESOLVES, while it records the spend unconditionally. So `in − out` is
 * over-stated by every unresolved spend — negative drift, a freeze while solvent. The derivation
 * used instead is *outputs paying us that nothing has spent*, which asks only for rows that exist
 * whether or not a prevout ever resolved. `store.unspentOutputTotal` carries the full argument.
 *
 * The honest boundary moves rather than disappearing: a derived balance is only as complete as the
 * record it is derived from, so `deriveTotal` proves contiguous coverage and requires that nothing
 * in the set could have had activity below where the record starts. Solana stays unbuilt and stays
 * `family_not_supported`, because its movements are pre/post balance deltas and this derivation
 * does not describe them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { chainSpec } from '@cloudsforge/contracts-chain'
import { assetOf, familyOf, requiredConfirmations, scopeKey, type ChainScope } from './chains.ts'
import type { Db } from './outbox.ts'
import { RpcError, RpcUnavailableError } from './rpc.ts'
import {
  TIP_STREAM,
  blockAtHeight,
  canonicalCoverage,
  custodyAddressHistory,
  custodyAddresses,
  getCheckpoint,
  headBlock,
  nextUnfinishedBackfill,
  partialFromHeight,
  unspentOutputTotals,
  type AddressHistory,
  type CustodyAddress,
} from './store.ts'
import { toBlockParam, type RpcCaller } from './tokenstate.ts'

/**
 * Every reason this service will decline to state a total.
 *
 * There is no `partial` and no `degraded`: the answer is a number that may be believed or it is
 * not an answer. Each of these becomes a distinct code on the wire so that the operator reading a
 * withdrawal freeze is sent to the right place — a node that is behind, a chain that is halted, a
 * custody set nobody registered, and a provider that timed out are four different mornings.
 */
export type CustodyTotalFault =
  | 'family_not_supported'
  | 'chain_not_followed'
  | 'nothing_indexed'
  | 'below_confirmation_depth'
  | 'depth_not_walked'
  | 'head_diverged'
  | 'chain_halted'
  | 'no_custody_addresses'
  | 'custody_set_too_large'
  | 'address_unreadable'
  | 'rpc_unavailable'
  // The two the derived families add. Both mean "this build cannot see far enough back", and they
  // are separate codes because one is repaired by an operator stating a fact and the other by a
  // backfill, which are different mornings.
  | 'history_unknown'
  | 'history_not_walked'
  // A backfill is running over blocks this total is summed from. Its own code because the morning
  // it names is the only one where the answer is "wait": nothing is broken, nothing needs an
  // operator, and the record is being repaired as the freeze is read.
  | 'backfill_in_flight'
  // The breakdown and the total disagree. Unreachable by construction — see `groupByPrefix` — and
  // given its own code anyway, because the other codes all name something an operator can go and
  // look at, and this one names a defect in this file. Reusing `address_unreadable` for it would
  // send whoever read the freeze to the node, which is the one place the answer would not be.
  | 'breakdown_inconsistent'

/**
 * The observation could not be made, and it says which of the reasons applied.
 *
 * **Never a zero and never a partial.** Every construction site of this error is a place where the
 * alternative was to return a number that would have been smaller than the truth, and a smaller
 * number is a positive drift, and a positive drift freezes an asset's withdrawals.
 */
export class CustodyTotalUnavailableError extends Error {
  readonly code: CustodyTotalFault
  constructor(code: CustodyTotalFault, message: string) {
    super(message)
    this.name = 'CustodyTotalUnavailableError'
    this.code = code
  }
}

/**
 * What the chain says the custody set holds, and every input that makes it believable.
 *
 * `total` is a decimal STRING in smallest units. `JSON.stringify` cannot serialise a `bigint`, and
 * `Number()` on an 18-decimal balance silently loses the low digits — which is precisely where a
 * reconciliation drift shows up. The whole point of the number is the digits a float would drop.
 */
/** One bucket of the custody set: everything whose label matched this prefix. */
export interface CustodyBucket {
  /** The configured prefix, verbatim — `deposit:`, `treasury:`. */
  readonly prefix: string
  /** How many custody addresses fell in this bucket. Zero is a legitimate, reportable answer. */
  readonly addresses: number
  /** Smallest units, decimal string, for the same reason `total` is. */
  readonly total: string
}

export interface CustodyTotalObservation {
  readonly chain: string
  readonly network: string
  /** The chain's native asset. The ledger reconciles this asset code, not the chain slug. */
  readonly assetCode: string
  readonly decimals: number
  /** Smallest units, decimal string. Never absent, never zero-by-default. */
  readonly total: string
  /** How many addresses were summed. Every one of them was read, or there would be no total. */
  readonly addresses: number
  /** The label prefixes that defined the set. The definition travels with the answer. */
  readonly labelPrefixes: readonly string[]
  /**
   * The same total, split by which prefix each address's label matched.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **THIS EXISTS SO THAT A FREEZE CAN NAME ITS OWN CAUSE.** A drift beyond tolerance stops
   * withdrawals, and the message an operator reads first used to be two numbers — the ledger's
   * custody total and this one. Two numbers say the estate and the chain disagree. They do not say
   * WHERE, and "where" is the whole of the next hour's work: deposits and treasury float are
   * different money, held by different code, and a drift in one is a different incident from a
   * drift in the other. The 2026-08-05 freeze was a treasury registration and read, from the
   * message, exactly like a deposit-sweep shortfall.
   *
   * One entry per CONFIGURED prefix, in configured order, including prefixes that matched nothing
   * — `treasury:` at zero over zero addresses is a fact worth printing, and an operator should not
   * have to know whether an absent bucket means empty or means the definition changed underneath
   * them. Each address is counted under exactly one prefix (the first it matches), so these sum
   * to `total` and to `addresses` exactly; that is asserted rather than assumed.
   *
   * **No address appears here.** The route's whole disclosure argument is that the SET is what the
   * caller must not learn, and two aggregates disclose no more of the set than one did.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly byLabelPrefix: readonly CustodyBucket[]
  readonly requiredConfirmations: number
  /** The height every balance was read at: `head − confirmations + 1`. */
  readonly observedAtBlock: number
  /** The hash this service walked there, proved to be the node's before AND after the reads. */
  readonly observedAtBlockHash: string
  /** The canonical head this service has walked. The depth is counted against this, never the tip. */
  readonly headHeight: number
  /** What a provider last claimed the tip was. Reported for staleness, never counted against. */
  readonly tipHeight: number | null
  readonly observedAt: string
}

/**
 * What the chain says ONE NAMED address holds, measured exactly the way `total` measures the set.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS EXISTS SO THAT AN ADDRESS CAN BE BOOKED AT THE MOMENT IT STARTS BEING WATCHED.**
 *
 * `total` has a property its own header advertises as a feature: registering an address that has
 * been accumulating coin for months makes its **entire** balance visible on the very next
 * observation, because the balance is read from the chain rather than replayed from movements.
 * That is what makes the aggregate self-healing, and on 2026-08-05 it is also what froze EMBER
 * withdrawals estate-wide for three days: `micro-settlement` registered a treasury holding
 * 25.000021 EMBER of platform float, the aggregate rose by all of it, the ledger's custody total
 * did not move because nothing had ever booked it, and a zero-tolerance asset froze on a drift of
 * −25000020999999996000 while the platform held MORE coin than it owed. An invented insolvency.
 *
 * The repair is that a service registering an address must also give the ledger a position for it,
 * and the amount it books has to be *the same measurement the reconciler will make* — not the
 * drift (booking the drift would paper over a genuine shortfall, which is the one thing the check
 * exists to find) and not the caller's own `eth_getBalance` at `latest` (which counts coin that
 * has not reached the confirmation depth this file reads at, so the book would be high by whatever
 * arrived in the last 60 blocks and the asset would freeze for exactly that).
 *
 * So the caller does not measure. It asks the service that will do the measuring, at the depth it
 * will do it, against a block hash it has proved twice. What remains is a genuine race — coin
 * arriving between this reading and the next aggregate — which is the same race any external
 * transfer into a watched address already is, and it is not narrowable further from here.
 *
 * **`address` is echoed back.** The caller named it, so there is no set to disclose, and echoing
 * it is what lets an operator reading a booked opening entry beside a freeze confirm that the
 * number was measured about the address they think it was.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface CustodyAddressObservation {
  readonly chain: string
  readonly network: string
  readonly assetCode: string
  readonly decimals: number
  /** Canonical for the family, as the caller sent it. */
  readonly address: string
  /** Smallest units, decimal string — a `bigint` for the same reason `total` is. */
  readonly balance: string
  readonly requiredConfirmations: number
  readonly observedAtBlock: number
  readonly observedAtBlockHash: string
  readonly headHeight: number
  readonly tipHeight: number | null
  readonly observedAt: string
}

export interface CustodyObserver {
  /** Resolves with a total, or throws. It never resolves with an incomplete one. */
  total(scope: ChainScope): Promise<CustodyTotalObservation>
  /**
   * One named address's balance at the same confirmed height `total` reads at.
   *
   * Deliberately does NOT require the address to be watched. The caller that needs this is
   * booking an address it is *about* to register, and demanding registration first would force
   * the exact ordering — watch, then measure — whose window this call exists to close.
   */
  balance(scope: ChainScope, address: string): Promise<CustodyAddressObservation>
}

export interface CustodyObserverDeps {
  readonly sql: Db
  /** Keyed by `scopeKey`, exactly as `rpcTokenObserver` takes them. One pool per chain. */
  readonly callers: ReadonlyMap<string, RpcCaller>
  /**
   * Which watched addresses count as custody's, by label prefix.
   *
   * Configuration rather than a constant, because the taxonomy belongs to the platform and not to
   * the indexer — but an EMPTY set is refused at `env.ts` rather than defaulted, since a set that
   * matches nothing produces a total of zero over zero addresses, which is the same lie in a new
   * costume.
   */
  readonly labelPrefixes: readonly string[]
  /**
   * The largest custody set this observation will attempt.
   *
   * One `eth_getBalance` per address, sequentially bounded, all inside the caller's request
   * deadline. A set above this is refused rather than truncated: a truncated set is a partial sum,
   * and the whole of this file is about not producing one. Raising the bound is a deploy decision
   * an operator makes with the cost in front of them.
   */
  readonly maxAddresses: number
  /**
   * How many balance reads are in flight at once. Bounded because a provider that is rate-limiting
   * us answers a burst of four hundred with 429s, and every 429 is an `address_unreadable` and a
   * refusal — so unbounded concurrency turns a working provider into a frozen asset.
   */
  readonly concurrency?: number
}

const DEFAULT_CONCURRENCY = 8

/**
 * The height every balance in an observation is read at, and the proof the node still serves it.
 *
 * Factored out because there are now TWO readings that must be taken at the same depth against the
 * same proved block — the aggregate, and one named address — and the whole value of the second is
 * that it is the first one's measurement narrowed to a single account. Two copies of this sequence
 * would be two copies that could drift apart, and the failure mode of drifting apart here is that
 * a service books an opening balance the reconciler then disagrees with, which is the incident
 * this call was added to prevent, reproduced by the fix for it.
 *
 * Every branch throws. There is no anchor-shaped answer that means "approximately".
 */
interface ConfirmedAnchor {
  readonly caller: RpcCaller
  /** Decides how a balance is obtained and how the node's block hash is asked for. */
  readonly family: string
  readonly confirmations: number
  /** `head − confirmations + 1`. */
  readonly at: number
  /** The hash this service walked at `at`, already proved to be the node's once. */
  readonly hash: string
  readonly headHeight: number
  readonly tipHeight: number | null
}

/**
 * Families whose balance is READ FROM THE CHAIN, one call per address at the confirmed height.
 *
 * The account model makes this possible: an account has a balance the node will state, including
 * every fee it ever paid and every internal transfer it ever received, whatever this service
 * walked. Nothing here depends on our own record being complete.
 */
const CHAIN_READ_FAMILIES: ReadonlySet<string> = new Set(['evm', 'ember'])

/**
 * Families whose balance is DERIVED from this service's own walked record.
 *
 * Bitcoin — and Litecoin, which `bitcoin.ts` serves — has no counterpart to `eth_getBalance`.
 * Stock Core keeps no address index, so an address the node's own wallet does not own has no
 * balance the node will state at all, at any height. What exists instead is the UTXO definition of
 * a balance: the outputs paying the address that nothing has spent. Both halves of that are facts
 * this service recorded while following, so the balance is derivable — but ONLY over a range it
 * actually walked, which is why `store.canonicalCoverage` and the per-address history claim are
 * checked before a single satoshi is summed. See `deriveTotal`.
 *
 * Solana is deliberately absent. Its movements come from pre/post balance deltas rather than from
 * outputs, so the same derivation does not apply to it, and `getBalance` at a historical slot needs
 * an archive node. It stays `family_not_supported` until someone writes its own argument.
 */
const DERIVED_FAMILIES: ReadonlySet<string> = new Set(['bitcoin'])

async function confirmedAnchor(
  deps: CustodyObserverDeps,
  scope: ChainScope,
): Promise<ConfirmedAnchor> {
  const family = familyOf(scope.chain)
  if (!CHAIN_READ_FAMILIES.has(family) && !DERIVED_FAMILIES.has(family)) {
    throw new CustodyTotalUnavailableError(
      'family_not_supported',
      `${family} custody balances are not readable by this build`,
    )
  }
  const caller = deps.callers.get(scopeKey(scope))
  if (!caller) {
    throw new CustodyTotalUnavailableError(
      'chain_not_followed',
      `this replica follows no provider for ${scopeKey(scope)}`,
    )
  }

  const [head, checkpoint] = await Promise.all([
    headBlock(deps.sql, scope),
    getCheckpoint(deps.sql, scope, TIP_STREAM),
  ])
  if (!head) {
    throw new CustodyTotalUnavailableError(
      'nothing_indexed',
      'no canonical block has been walked for this chain yet',
    )
  }
  // A halt means an alarming reorg went past the depth this observation is entirely made of.
  // `tokenstate` reports a halt and answers anyway, because its answer depends on one block it
  // has just proved the node still serves; this one is an input to a solvency decision whose
  // only defence is that depth, so it refuses — as `reads.tokenBalances` does, and for the same
  // reason.
  if (checkpoint?.halted === true) {
    throw new CustodyTotalUnavailableError(
      'chain_halted',
      `this service has stopped vouching for ${scopeKey(scope)}: ${checkpoint.haltReason ?? 'halted'}`,
    )
  }

  const confirmations = requiredConfirmations(scope.chain)
  // `head − confirmations + 1`, because the block containing a transaction is its first
  // confirmation — the same off-by-one `chains.confirmationsAt` carries the argument for. At
  // this height `confirmationsAt(head, at)` is exactly `confirmations`.
  const at = head.height - confirmations + 1
  if (at < 0) {
    throw new CustodyTotalUnavailableError(
      'below_confirmation_depth',
      `the chain has ${head.height + 1} blocks and ${confirmations} confirmations are required`,
    )
  }
  const anchor = await blockAtHeight(deps.sql, scope, at)
  if (!anchor) {
    // The follower cold-starts at `tip − 2 × depth`, so this is reachable on a fresh replica
    // whose head is high but whose record does not reach back to the confirmed height yet.
    // Without our own block there we cannot prove the node's chain is the chain we walked.
    throw new CustodyTotalUnavailableError(
      'depth_not_walked',
      `this service has not walked height ${at}, so it cannot vouch for the node's block there`,
    )
  }

  await assertNodeAgrees(caller, family, at, anchor.hash)

  return {
    caller,
    family,
    confirmations,
    at,
    hash: anchor.hash,
    headHeight: head.height,
    tipHeight: checkpoint?.tipHeight ?? null,
  }
}

export function rpcCustodyObserver(deps: CustodyObserverDeps): CustodyObserver {
  return {
    async total(scope) {
      const anchor = await confirmedAnchor(deps, scope)
      const { caller, at } = anchor

      const found = await custodyAddresses(
        deps.sql,
        scope,
        deps.labelPrefixes,
        // One over the bound, so "exactly at the limit" and "more than the limit" are
        // distinguishable. A `limit maxAddresses` would silently truncate at the boundary, which
        // is the partial sum wearing a configuration value's clothes.
        deps.maxAddresses + 1,
      )
      if (found.length === 0) {
        // **Not a total of zero.** An empty custody set far more often means nobody registered the
        // addresses than that the platform holds none — `micro-wallet` writes them on a retry job
        // that can be behind, and a renamed label prefix would empty this set without touching a
        // line of code. Zero here would report a perfectly balanced chain holding nothing, which
        // is the exact shape of the defect this release removed one service downstream.
        throw new CustodyTotalUnavailableError(
          'no_custody_addresses',
          `no watched address on ${scopeKey(scope)} carries a custody label ` +
            `(${deps.labelPrefixes.join(', ')}) — which is not the same as holding nothing`,
        )
      }
      if (found.length > deps.maxAddresses) {
        throw new CustodyTotalUnavailableError(
          'custody_set_too_large',
          `more than ${deps.maxAddresses} custody addresses on ${scopeKey(scope)}; ` +
            'raise INDEXER_CUSTODY_MAX_ADDRESSES rather than accepting a partial sum',
        )
      }

      // Per address, not a single number, and the total is the sum of it below. Measuring once and
      // dividing cannot disagree with itself; measuring the whole and then the parts can, and the
      // parts exist precisely to be believed when a freeze is being diagnosed.
      const balances = DERIVED_FAMILIES.has(anchor.family)
        ? await deriveBalances(deps, scope, anchor, found)
        : await sumFromChain(
            caller,
            found.map((entry) => entry.address),
            at,
            deps.concurrency ?? DEFAULT_CONCURRENCY,
          )

      // The closing hash check. See the header: `eth_getBalance` takes a height, so a reorg during
      // the sweep would have some balances answered from a chain that no longer exists, and the
      // sum of two chains is a number no state ever had. Refusing here costs one call and is the
      // only place that difference is visible.
      //
      // It is made on the derived families too, where the argument is not the same one and is just
      // as necessary. Nothing is read from the node there, so nothing can be answered from two
      // chains — but the sum is taken from rows this service wrote about a chain it believed in,
      // and this is the one check that asks whether the node still believes in it. A deep reorg
      // that arrived between the opening proof and the query would otherwise produce a confident
      // total about a fork.
      await assertNodeAgrees(caller, anchor.family, at, anchor.hash)

      const { total, byLabelPrefix } = groupByPrefix(found, balances, deps.labelPrefixes)

      const asset = assetOf(scope.chain)
      return {
        chain: scope.chain,
        network: scope.network,
        assetCode: asset,
        decimals: chainSpec(asset).decimals,
        total: total.toString(),
        addresses: found.length,
        labelPrefixes: deps.labelPrefixes,
        byLabelPrefix,
        requiredConfirmations: anchor.confirmations,
        observedAtBlock: at,
        observedAtBlockHash: anchor.hash,
        headHeight: anchor.headHeight,
        tipHeight: anchor.tipHeight,
        observedAt: new Date().toISOString(),
      }
    },

    async balance(scope, address) {
      const anchor = await confirmedAnchor(deps, scope)
      const { caller, at } = anchor

      let value: bigint
      if (DERIVED_FAMILIES.has(anchor.family)) {
        // The claim this address carries, if it is watched at all. An address nobody has registered
        // has made no claim, and `deriveBalances` treats an absent claim as the weakest TRUE
        // statement available — "no activity below height 0" — rather than as a licence. On a chain
        // walked from genesis that is a theorem and the derivation proceeds; on one walked from a
        // cold-start height it is refused, which is the honest answer for an address whose history
        // this service has never seen.
        //
        // No bucket is supplied and none is needed: `deriveBalances` takes an `AddressHistory`,
        // which is the half of a custody entry the derivation actually reads. Grouping is the
        // aggregate's business, and this route answers ONE named address, so there is nothing to
        // group. The narrower parameter is what makes that structural rather than a convention —
        // there is no field here to fill in wrongly.
        const [watched] = await custodyAddressHistory(deps.sql, scope, [address])
        const derived = await deriveBalances(deps, scope, anchor, [
          { address, historyFromHeight: watched?.historyFromHeight ?? null },
        ])
        // Absent means no unspent credit at this height, which for one address is a measured zero
        // — the same reading `total` takes, and the reason this is not `?? undefined`.
        value = derived.get(address) ?? 0n
      } else {
        // `sumFromChain` rather than `balanceOf` directly, so the single-address reading goes
        // through the identical failure mapping: every RPC fault is a refusal and none of them is a
        // zero. A caller booking an opening balance from a zero that meant "the provider would not
        // say" would write a permanent understatement into the ledger and freeze the asset for ever
        // after.
        // `sumFromChain` fills every requested address or throws, so this key is present.
        value = (await sumFromChain(caller, [address], at, 1)).get(address)!
      }

      // The closing hash check, for the same reason `total` makes it: the balance was answered at a
      // height, and a reorg between the two proofs means it was answered about a chain that no
      // longer exists. One call, and it is the only place that difference is visible.
      await assertNodeAgrees(caller, anchor.family, at, anchor.hash)

      const asset = assetOf(scope.chain)
      return {
        chain: scope.chain,
        network: scope.network,
        assetCode: asset,
        decimals: chainSpec(asset).decimals,
        address,
        balance: value.toString(),
        requiredConfirmations: anchor.confirmations,
        observedAtBlock: at,
        observedAtBlockHash: anchor.hash,
        headHeight: anchor.headHeight,
        tipHeight: anchor.tipHeight,
        observedAt: new Date().toISOString(),
      }
    },
  }
}

/**
 * Prove the node's block at `height` is the block this service walked there.
 *
 * `tokenstate.ts` carries the full argument, including why EIP-1898's block-hash parameter is not
 * used: it is not universally implemented by the providers this pool fails over between, and a
 * read that works on one provider and 404s on the next is a read whose answer depends on the
 * weather.
 */
async function assertNodeAgrees(
  caller: RpcCaller,
  family: string,
  height: number,
  expected: string,
): Promise<void> {
  const served = DERIVED_FAMILIES.has(family)
    ? // Bitcoin Core's `getblockhash` answers with the hash on the node's ACTIVE chain at that
      // height, which is precisely the question. `getblock` would work too and would transfer a
      // whole block to compare one field.
      await unwrap(caller.call<string | null>('getblockhash', [height]))
    : ((await unwrap(
        caller.call<{ hash?: string } | null>('eth_getBlockByNumber', [toBlockParam(height), false]),
      ))?.hash ?? null)
  const hash = typeof served === 'string' ? served.toLowerCase() : null
  if (hash === null || hash !== expected.toLowerCase()) {
    throw new CustodyTotalUnavailableError(
      'head_diverged',
      `the provider serves ${hash ?? 'no block'} at height ${height}; this service walked ${expected}`,
    )
  }
}

/**
 * Σ balance over a set, DERIVED from this service's own record, and the two proofs that entitle it
 * to be called a balance at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * The sum itself is one query (`store.unspentOutputTotal`) and is the easy part. What makes the
 * number true is what is checked before it:
 *
 * **1. Contiguous canonical coverage from `lo` to the confirmed height.** A hole loses receipts
 * (understates → positive drift) and loses spends (overstates → negative drift), with nothing
 * bounding either, so a gap is not a degradation of the answer — it is a different answer with the
 * same shape. `history_not_walked`.
 *
 * **2. No activity below `lo` for any address in the set.** This service cannot see below its own
 * record, so it cannot establish this and does not try. It is a claim, made by whoever registered
 * the address, at the moment they registered it — and the only party who can make it truthfully is
 * one that has just derived the key, because nothing can have paid an address that did not exist.
 *
 * **An absent claim is treated as height 0, and that is a tautology rather than a default.** "This
 * address had no activity below block 0" is true of every address on every chain, because there is
 * nothing below block 0. So the comparison `claim ≥ lo` reduces, for an unclaimed address, to
 * `lo = 0` — a chain this service walked from genesis, where the record IS the whole history and no
 * claim was ever needed. On a chain walked from a cold-start height the same address refuses with
 * `history_unknown`, which is the honest answer and the one the two `ltc:mainnet` deposit rows
 * registered by earlier builds will get.
 *
 * This is the one place in this file where a null becomes a number, and it is written out at length
 * because everywhere else in it a null becoming a number is the defect.
 *
 * **3. No rescan in flight over the range.** Added when a block became able to record only the
 * addresses that were watched when it was walked. Registering an address late enqueues a walk of
 * blocks that already exist, and a walk that rewrites existing blocks leaves proof 1 satisfied the
 * entire time it is running — the coverage is contiguous, and the rows are half written. That is the
 * one way a hole can hide from a contiguity check, so it is checked separately.
 * `backfill_in_flight`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function deriveBalances(
  deps: CustodyObserverDeps,
  scope: ChainScope,
  anchor: ConfirmedAnchor,
  entries: readonly AddressHistory[],
): Promise<Map<string, bigint>> {
  const coverage = await canonicalCoverage(deps.sql, scope, anchor.at)
  const lo = coverage.lowestHeight
  if (lo === null || coverage.highestHeight === null) {
    // Unreachable: `confirmedAnchor` already proved a canonical block exists at `at`. Written as a
    // refusal rather than a `!` because the alternative to this branch is summing over a record
    // that is not there, which would answer zero.
    throw new CustodyTotalUnavailableError(
      'nothing_indexed',
      `no canonical block at or below height ${anchor.at} on ${scopeKey(scope)}`,
    )
  }
  // One canonical block per height is already enforced by `blocks_canonical_height_uniq`, so the
  // count comparison is the whole contiguity check — a duplicate cannot stand in for a missing
  // neighbour. `highestHeight` is checked too: a record that stops below the confirmed height has
  // no hole in it and is still not evidence about `anchor.at`.
  const needed = anchor.at - lo + 1
  if (coverage.highestHeight !== anchor.at || coverage.blocks !== needed) {
    throw new CustodyTotalUnavailableError(
      'history_not_walked',
      `the canonical record from ${lo} to ${anchor.at} has ${coverage.blocks} blocks up to ` +
        `${coverage.highestHeight} and needs ${needed} up to ${anchor.at} — a derived balance over ` +
        'a record with a hole in it is wrong in both directions at once. Backfill the gap.',
    )
  }
  // Contiguity is necessary and, once a block can be walked for only some addresses, no longer
  // sufficient. A rescan enqueued because an address was registered late walks blocks that ALREADY
  // EXIST, so it puts no hole in the coverage above and the count check passes throughout — while
  // the rows it is there to write are, by definition, not all written yet. Summing across it
  // understates, which is positive drift, which freezes an asset over a repair that was in progress
  // the whole time. Refusing says the same thing without the wrong number attached.
  //
  // The lowest unfinished range is the only one worth testing: `nextUnfinishedBackfill` orders by
  // `range_from`, so if that one starts above the confirmed height every other one does too.
  //
  // And only on a record that can be narrow. Where every address was recorded, a backfill over
  // blocks that already exist rewrites them to what they already say — the writes are idempotent
  // and nothing is deleted first — so it cannot move this number, and refusing over it would
  // freeze an asset for the duration of an operator's deliberate, harmless catch-up. The second
  // query is deliberately behind the first: it is reached only when a backfill is actually
  // pending, which is the rare case.
  const rescan = await nextUnfinishedBackfill(deps.sql, scope)
  if (
    rescan !== null &&
    rescan.rangeFrom !== null &&
    rescan.rangeFrom <= anchor.at &&
    (await partialFromHeight(deps.sql, scope)) !== null
  ) {
    throw new CustodyTotalUnavailableError(
      'backfill_in_flight',
      `${rescan.stream} on ${scopeKey(scope)} has reached ${rescan.height ?? 'nothing'} of ` +
        `${rescan.rangeTo} and covers blocks at or below the confirmed height ${anchor.at} — the ` +
        'record it is rewriting is the record this total sums, so the total is not yet a total',
    )
  }
  for (const entry of entries) {
    const claim = entry.historyFromHeight ?? 0
    if (claim < lo) {
      throw new CustodyTotalUnavailableError(
        entry.historyFromHeight === null ? 'history_unknown' : 'history_not_walked',
        entry.historyFromHeight === null
          ? `nobody has stated from which height ${entry.address} could have had activity, and ` +
            `this service's record on ${scopeKey(scope)} starts at ${lo} — so coin it received ` +
            'before that is invisible here and would be missing from the total'
          : `${entry.address} is claimed to have no activity below ${claim}, but this service's ` +
            `record starts at ${lo}, leaving ${lo - claim} blocks of its possible history unwalked`,
      )
    }
  }
  return await unspentOutputTotals(
    deps.sql,
    scope,
    entries.map((entry) => entry.address),
    anchor.at,
  )
}

/**
 * Every address, or an error. There is no third outcome and that is the whole design.
 *
 * `Promise.all` rather than `allSettled`, deliberately: `allSettled` is the shape that invites a
 * `.filter(ok)` and a sum over what happened to answer. The first rejection ends the observation.
 *
 * Windowed rather than fired at once — see `concurrency` on the deps. A provider throttling a
 * four-hundred-call burst answers with 429s, and every 429 here is a refusal, so unbounded
 * parallelism would convert a healthy provider into a frozen asset.
 */
async function sumFromChain(
  caller: RpcCaller,
  addresses: readonly string[],
  height: number,
  concurrency: number,
): Promise<Map<string, bigint>> {
  const balances = await readAll(caller, addresses, height, concurrency)
  const out = new Map<string, bigint>()
  // A missing slot is impossible — `readAll` fills every one or throws — and it is read with an
  // explicit refusal rather than a `?? 0n` on purpose: `?? 0n` is exactly the defaulting this file
  // exists to refuse, and a default that is unreachable today is reachable after the next edit.
  for (let index = 0; index < addresses.length; index++) {
    const balance = balances[index]
    if (balance === undefined) {
      throw new CustodyTotalUnavailableError(
        'address_unreadable',
        `no balance was produced for ${addresses[index]} at height ${height}`,
      )
    }
    // `set`, not `+=`: `custodyAddresses` reads one row per address, so a repeat here would mean a
    // duplicate in the watch list, and adding a balance to itself is how a set becomes a total that
    // over-states the chain. Last write wins and the count stays honest.
    out.set(addresses[index]!, balance)
  }
  return out
}

/**
 * The total, and the same total split by bucket, from one measurement.
 *
 * The assertion at the end is the point of the function rather than a guard on it: a breakdown that
 * does not add up to the total it explains is worse than no breakdown, because it will be read
 * during an incident by somebody deciding whether the chain or the ledger is wrong. If the parts and
 * the whole ever disagree, this refuses the whole observation — which freezes the asset, which is
 * the direction this file always fails in.
 */
function groupByPrefix(
  entries: readonly CustodyAddress[],
  balances: ReadonlyMap<string, bigint>,
  labelPrefixes: readonly string[],
): { total: bigint; byLabelPrefix: readonly CustodyBucket[] } {
  const sums = new Map<string, { addresses: number; total: bigint }>()
  for (const prefix of labelPrefixes) sums.set(prefix, { addresses: 0, total: 0n })

  let total = 0n
  for (const entry of entries) {
    // Absent means "no unspent credit at this height", which is a measured zero on the derived
    // path — `unspentOutputTotals` returns a row only for an address that has one. On the RPC path
    // every address is present or `sumFromChain` has already thrown.
    const balance = balances.get(entry.address) ?? 0n
    total += balance
    const bucket = sums.get(entry.labelPrefix)
    if (bucket === undefined) {
      // Unreachable: `custodyAddresses` assigns `labelPrefix` from this same list. Refused rather
      // than dropped, because dropping it would leave the buckets short of the total.
      throw new CustodyTotalUnavailableError(
        'breakdown_inconsistent',
        `${entry.address} is labelled with a prefix that is not configured — the breakdown cannot ` +
          'be reconciled with the total',
      )
    }
    bucket.addresses += 1
    bucket.total += balance
  }

  const byLabelPrefix = labelPrefixes.map((prefix) => {
    const bucket = sums.get(prefix)!
    return { prefix, addresses: bucket.addresses, total: bucket.total.toString() }
  })

  const parts = byLabelPrefix.reduce((sum, bucket) => sum + BigInt(bucket.total), 0n)
  const counted = byLabelPrefix.reduce((sum, bucket) => sum + bucket.addresses, 0)
  if (parts !== total || counted !== entries.length) {
    throw new CustodyTotalUnavailableError(
      'breakdown_inconsistent',
      `the custody breakdown sums to ${parts} over ${counted} addresses but the set totals ` +
        `${total} over ${entries.length} — refusing to report either`,
    )
  }
  return { total, byLabelPrefix }
}

async function readAll(
  caller: RpcCaller,
  addresses: readonly string[],
  height: number,
  concurrency: number,
): Promise<readonly bigint[]> {
  const at = toBlockParam(height)
  const out = new Array<bigint>(addresses.length)
  const width = Math.max(1, Math.min(concurrency, addresses.length))
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= addresses.length) return
      out[index] = await balanceOf(caller, addresses[index]!, at)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return out
}

/**
 * One address's balance at one block.
 *
 * **Every failure is a refusal.** `callOrNull` in `tokenstate.ts` maps an `RpcError` to null,
 * because a contract that will not answer `owner()` genuinely has no owner. There is no equivalent
 * fact here: an account always has a balance, so a provider that will not state it has told us
 * nothing, and nothing is not zero. A pruned state at that height arrives as an `RpcError` and is
 * refused for the same reason — the answer is unknown, not empty.
 */
async function balanceOf(caller: RpcCaller, address: string, at: string): Promise<bigint> {
  let raw: unknown
  try {
    raw = await caller.call<unknown>('eth_getBalance', [address, at])
  } catch (err) {
    if (err instanceof RpcUnavailableError) {
      throw new CustodyTotalUnavailableError('rpc_unavailable', err.message)
    }
    if (err instanceof RpcError) {
      throw new CustodyTotalUnavailableError(
        'address_unreadable',
        `the provider refused eth_getBalance at this height: ${err.message}`,
      )
    }
    throw err
  }
  const value = hexQuantity(raw)
  if (value === null) {
    throw new CustodyTotalUnavailableError(
      'address_unreadable',
      'eth_getBalance answered something that is not a hex quantity',
    )
  }
  return value
}

/**
 * A JSON-RPC `QUANTITY` as a `bigint`, or null if it is not one.
 *
 * **Not `decodeUint`.** That decodes a 32-byte ABI word, which is what `eth_call` returns;
 * `eth_getBalance` returns a bare hex quantity like `0x1a`, and running it through an ABI decoder
 * would reject every real balance. Two encodings that look alike on the wire.
 *
 * **Not `BigInt(raw)` on whatever arrived.** `BigInt('')` is `0n` — the estate's own convention
 * note names this — and `BigInt('0x')` throws while `Number` would give NaN. A provider answering
 * `""` or `null` for a balance it could not compute would otherwise become a zero balance, summed
 * into the total, and the total would be short by exactly one account with nothing to show for it.
 */
export function hexQuantity(raw: unknown): bigint | null {
  if (typeof raw !== 'string') return null
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) return null
  return BigInt(raw)
}

/** Unavailability mapping for the calls whose absence is never an answer. */
async function unwrap<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (err) {
    if (err instanceof CustodyTotalUnavailableError) throw err
    if (err instanceof RpcUnavailableError || err instanceof RpcError) {
      throw new CustodyTotalUnavailableError('rpc_unavailable', err.message)
    }
    throw err
  }
}
