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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { chainSpec } from '@cloudsforge/contracts-chain'
import { assetOf, familyOf, requiredConfirmations, scopeKey, type ChainScope } from './chains.ts'
import type { Db } from './outbox.ts'
import { RpcError, RpcUnavailableError } from './rpc.ts'
import { TIP_STREAM, blockAtHeight, custodyAddresses, getCheckpoint, headBlock } from './store.ts'
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

export interface CustodyObserver {
  /** Resolves with a total, or throws. It never resolves with an incomplete one. */
  total(scope: ChainScope): Promise<CustodyTotalObservation>
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

export function rpcCustodyObserver(deps: CustodyObserverDeps): CustodyObserver {
  return {
    async total(scope) {
      const family = familyOf(scope.chain)
      // Bitcoin and Solana are followed by this build and their balances are NOT read here. There
      // is no `getBalance` on a UTXO chain without an address index, and a Solana balance at a
      // historical slot needs an archive node — so both would need a derivation from stored
      // movements, which is a different implementation with a different correctness argument. It
      // is honest to say "this build cannot" and let the ledger freeze, and dishonest to sum the
      // rows with the EVM derivation and call it a balance.
      if (family !== 'evm' && family !== 'ember') {
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

      await assertNodeAgrees(caller, at, anchor.hash)

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

      const balances = await readAll(caller, found, at, deps.concurrency ?? DEFAULT_CONCURRENCY)
      let total = 0n
      for (const balance of balances) total += balance

      // The closing hash check. See the header: `eth_getBalance` takes a height, so a reorg during
      // the sweep would have some balances answered from a chain that no longer exists, and the
      // sum of two chains is a number no state ever had. Refusing here costs one call and is the
      // only place that difference is visible.
      await assertNodeAgrees(caller, at, anchor.hash)

      const asset = assetOf(scope.chain)
      return {
        chain: scope.chain,
        network: scope.network,
        assetCode: asset,
        decimals: chainSpec(asset).decimals,
        total: total.toString(),
        addresses: found.length,
        labelPrefixes: deps.labelPrefixes,
        requiredConfirmations: confirmations,
        observedAtBlock: at,
        observedAtBlockHash: anchor.hash,
        headHeight: head.height,
        tipHeight: checkpoint?.tipHeight ?? null,
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
async function assertNodeAgrees(caller: RpcCaller, height: number, expected: string): Promise<void> {
  const block = await unwrap(
    caller.call<{ hash?: string } | null>('eth_getBlockByNumber', [toBlockParam(height), false]),
  )
  const served = typeof block?.hash === 'string' ? block.hash.toLowerCase() : null
  if (served === null || served !== expected.toLowerCase()) {
    throw new CustodyTotalUnavailableError(
      'head_diverged',
      `the provider serves ${served ?? 'no block'} at height ${height}; this service walked ${expected}`,
    )
  }
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
