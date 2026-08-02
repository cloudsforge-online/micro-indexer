/**
 * The Bitcoin worker. Bitcoin Core JSON-RPC, UTXO extraction, and a reorg repair that knows what
 * a replace-by-fee is.
 *
 * ## What is ported from `evm.ts` and what is emphatically not
 *
 * The *rigour* is ported: one transaction per block so a restart leaves neither gap nor duplicate,
 * two reorg checks rather than one, a walk to a common ancestor, retraction rather than deletion,
 * and a depth policy read from `@cloudsforge/contracts-chain` and never restated. The *semantics*
 * are not, because three things about Bitcoin have no EVM analogue:
 *
 *   1. **A transaction credits an address once per output paying it, not once.** There is no
 *      single `to`. `transactions.to_address` is therefore null for every Bitcoin row and the
 *      movements carry the truth, one per output. `worker.ts`'s FAMILY_NOTES says this and it is
 *      the first thing an EVM-shaped implementation gets wrong.
 *
 *   2. **There is no sender either.** A transaction's inputs are other people's outputs, and which
 *      address funded which output is only knowable by resolving each prevout. So `from_address`
 *      is null too, and outbound movements are produced per *input*, from the resolved prevout.
 *
 *   3. **An orphaned transaction may be permanently dead.** This is the one that matters for
 *      money, and it is the whole reason `spent_outpoints` exists. On an account chain a
 *      transaction that leaves the chain in a reorg comes back or is superseded by nonce, and
 *      `evm.ts` needs no word for the difference. On Bitcoin a replace-by-fee — ordinary traffic,
 *      not an attack — means the transaction that left may have had its coins spent by a
 *      different txid on the chain that won. It can never be re-mined. A consumer told only
 *      "orphaned" waits for a confirmation that cannot arrive. `markConflictedSpends` is where
 *      that is decided, and migration 5's partial unique index is what makes getting it wrong
 *      loud rather than silent.
 *
 * ## Two things Bitcoin gives us that Ethereum does not
 *
 *   * **A real identity check.** `chains.declaredChainId` returns undefined for BTC and `evm.ts`
 *     concludes that Bitcoin's identity cannot be verified. That is true of chain ids and false of
 *     the chain: `getblockchaininfo.chain` reports `main`, `test`, `testnet4`, `signet` or
 *     `regtest`, and indexing mainnet into the rows labelled `btc:testnet` is exactly as silent a
 *     disaster here as indexing Sepolia into `ember:testnet`. So it is checked.
 *
 *   * **A coinbase with a real transaction hash.** `evm.ts` declines to index the block reward
 *     because an EVM coinbase credit has no transaction and therefore no hash, and this service's
 *     contract is that every movement it reports can be pointed at on an explorer. Bitcoin's block
 *     reward *is* a transaction, with a txid. So it is indexed, and it produces inbound movements
 *     like any other. It produces no outbound ones: a coinbase input spends nothing.
 */

import { explorerTxUrl, txUrn } from '@cloudsforge/contracts-chain'
import type { ChainFamily, Network } from '@cloudsforge/contracts-chain'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import {
  alarming,
  assetOf,
  confirmationsAt,
  creditable,
  requiredConfirmations,
  scopeKey,
  type ChainScope,
} from './chains.ts'
import {
  ACTIVITY_TOTAL,
  BLOCKS_INDEXED_TOTAL,
  CHAIN_HALTED,
  DEPOSITS_CONFIRMED_TOTAL,
  DEPOSITS_OBSERVED_TOTAL,
  LAG_BLOCKS,
  REORGS_TOTAL,
  TIP_HEIGHT,
  TRANSACTIONS_INDEXED_TOTAL,
  depthBucket,
} from './metrics.ts'
import { DEPOSIT_CONFIRMED, DEPOSIT_OBSERVED, withOutbox, type Db } from './outbox.ts'
import { RpcError, RpcUnavailableError, type RpcPool } from './rpc.ts'
import {
  TIP_STREAM,
  activityEntryKey,
  blockAtHeight,
  filterWatched,
  getCheckpoint,
  haltChain,
  headBlock,
  insertReorg,
  isHalted,
  markConfirmed,
  markConflictedSpends,
  nextUnfinishedBackfill,
  orphanAbove,
  pendingConfirmations,
  recordSpends,
  recordTip,
  setCheckpoint,
  upsertActivity,
  upsertBlock,
  upsertProviderHealth,
  upsertTransaction,
  type ActivityInput,
  type BlockInput,
  type SpendInput,
  type TransactionInput,
} from './store.ts'
import type { BackfillOutcome, ChainWorker, FollowOutcome, ReorgOutcome } from './worker.ts'

/* ------------------------------------------------------------------ JSON-RPC shapes */

export interface RawScriptPubKey {
  readonly address?: string | null
  /** Pre-22.0 Core returned a list. Read only when `address` is absent, and only when it holds one. */
  readonly addresses?: readonly string[] | null
  readonly type?: string
  readonly hex?: string
}

export interface RawVout {
  /** BTC, as a JSON number. `btcToSats` is the only thing allowed to look at it. */
  readonly value: number
  readonly n: number
  readonly scriptPubKey?: RawScriptPubKey
}

export interface RawVin {
  readonly txid?: string
  readonly vout?: number
  /** Present on, and only on, the coinbase input. */
  readonly coinbase?: string
  readonly sequence?: number
  /** Verbosity 3 only. When absent the worker resolves the prevout itself. */
  readonly prevout?: { readonly value: number; readonly scriptPubKey?: RawScriptPubKey }
}

export interface RawBtcTx {
  readonly txid: string
  readonly hash?: string
  readonly version?: number
  readonly size?: number
  readonly vsize?: number
  readonly weight?: number
  readonly locktime?: number
  readonly vin: readonly RawVin[]
  readonly vout: readonly RawVout[]
}

export interface RawBtcBlock {
  readonly hash: string
  readonly height: number
  readonly previousblockhash?: string
  readonly time: number
  readonly nTx?: number
  readonly merkleroot?: string
  readonly bits?: string
  readonly size?: number
  readonly weight?: number
  readonly version?: number
  readonly tx: readonly RawBtcTx[]
}

/* ------------------------------------------------------------------ amounts */

/** 21 million BTC, in satoshis. Nothing valid exceeds it, and a value that does is a bad decode. */
export const MAX_SATOSHIS = 2_100_000_000_000_000n

/**
 * BTC (as Core serialises it) → satoshis.
 *
 * Core reports amounts in BTC as a JSON number, so by the time any of this code runs the decimal
 * has already been through an IEEE-754 double. That sounds fatal for money and is not, but the
 * reason is worth writing down rather than trusting:
 *
 *   the largest valid amount is 21e6 BTC; the ULP of a double near 21e6 is about 3.7e-9; scaled by
 *   1e8 that is an error of about 0.37 satoshis, and the true value is an exact multiple of one
 *   satoshi. So the nearest integer to `value * 1e8` is the exact amount, for every amount Bitcoin
 *   can represent. `Math.round` recovers it exactly; it does not merely get close.
 *
 * That argument holds only inside the valid range, so the range is checked rather than assumed —
 * a `value` outside it means the field was not a Bitcoin amount, and the honest response to a
 * number this function cannot vouch for is to throw. Crediting a wrong amount silently is the one
 * outcome that must not be available.
 */
export function btcToSats(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new RangeError(`bitcoin amount ${value} is not a finite number`)
  }
  if (value < 0) throw new RangeError(`bitcoin amount ${value} is negative`)
  const sats = BigInt(Math.round(value * 1e8))
  if (sats > MAX_SATOSHIS) {
    throw new RangeError(`bitcoin amount ${value} exceeds the 21,000,000 BTC supply cap`)
  }
  return sats
}

/**
 * The address an output pays, or null.
 *
 * Null is a normal answer, not a failure: an OP_RETURN pays nobody, and a bare multisig or an
 * unrecognised script has no single address. Those outputs move value that this service cannot
 * attribute, so it attributes none rather than guessing — an unattributable output credited to a
 * plausible address is worse than one credited to nobody.
 *
 * `addresses` is read only when it holds exactly one entry. Core before 22.0 used the plural form
 * for bare multisig too, and picking the first of several would credit one key holder for coins
 * that require several.
 */
export function addressOf(script: RawScriptPubKey | undefined): string | null {
  if (!script) return null
  if (typeof script.address === 'string' && script.address.length > 0) return script.address
  const list = script.addresses
  if (list && list.length === 1 && typeof list[0] === 'string' && list[0].length > 0) return list[0]
  return null
}

/**
 * Bitcoin addresses are NOT case-normalised, unlike EVM's.
 *
 * base58check (`1…`, `3…`, `m…`, `n…`, `2…`) is case-SIGNIFICANT — lower-casing one produces a
 * string that is not the same address and fails its own checksum. bech32 (`bc1…`, `tb1…`) is
 * case-insensitive but is canonically lower-case and Core emits it that way. So the correct
 * normalisation for Bitcoin is none at all, and `evm.ts`'s `normaliseAddress` must not be reused
 * here. This function exists to say so somewhere the next person will look.
 */
export function canonicalBitcoinAddress(address: string): string {
  return address
}

/** RBF: BIP-125 signals opt-in replaceability with any input sequence below 0xfffffffe. */
export function signalsRbf(tx: RawBtcTx): boolean {
  return tx.vin.some((vin) => vin.coinbase === undefined && (vin.sequence ?? 0xffffffff) < 0xfffffffe)
}

export function isCoinbase(tx: RawBtcTx): boolean {
  return tx.vin.length > 0 && tx.vin[0]?.coinbase !== undefined
}

/* ------------------------------------------------------------------ extraction */

/** A resolved prevout: what the input being spent was worth, and who it paid. */
export interface Prevout {
  readonly value: number
  readonly address: string | null
}

/** Keyed `${txid}:${vout}`. */
export function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`
}

export interface ExtractedBitcoinBlock {
  readonly block: BlockInput
  readonly transactions: readonly TransactionInput[]
  readonly activity: readonly ActivityInput[]
  readonly spends: readonly SpendInput[]
  /** Inputs whose prevout could not be resolved. Reported, never guessed at. */
  readonly unresolvedInputs: number
}

/**
 * One Bitcoin block into rows. Pure, so every interesting case is testable without a node.
 *
 * **Every transaction in a block succeeded.** Bitcoin has no revert and no failed-but-mined state:
 * an invalid transaction does not get into a block at all. So there is no `status !== 'success'`
 * branch here, and its absence is correct rather than an omission — the EVM worker's equivalent
 * branch exists because a receipt can say `0x0`, and no Bitcoin equivalent can.
 *
 * **`value` is the total paid out**, which for Bitcoin is the only sensible reading of a single
 * transaction-level amount: there is no one recipient to attribute it to. The per-recipient truth
 * is in `activity`, one row per output.
 *
 * **`fee` is inputs minus outputs**, and it is null unless *every* input resolved. A fee computed
 * from a partial input set is not a small error, it is the whole of the missing input reported as
 * miner revenue.
 */
export function extractBitcoinBlock(
  raw: RawBtcBlock,
  prevouts: ReadonlyMap<string, Prevout>,
  nativeAssetCode: string,
): ExtractedBitcoinBlock {
  const height = raw.height
  const blockHash = raw.hash

  const block: BlockInput = {
    height,
    hash: blockHash,
    // Genesis has no parent. The 32 zero bytes are what Core itself uses for it, and the follower's
    // parent check never reaches height 0 anyway.
    parentHash: raw.previousblockhash ?? '0'.repeat(64),
    // Core reports seconds. Milliseconds would put every block in 1970.
    blockTime: new Date(raw.time * 1_000),
    txCount: raw.nTx ?? raw.tx.length,
    detail: {
      merkleroot: raw.merkleroot ?? null,
      bits: raw.bits ?? null,
      size: raw.size ?? null,
      weight: raw.weight ?? null,
      version: raw.version ?? null,
    },
  }

  const transactions: TransactionInput[] = []
  const activity: ActivityInput[] = []
  const spends: SpendInput[] = []
  let unresolvedInputs = 0

  for (let index = 0; index < raw.tx.length; index++) {
    const tx = raw.tx[index]
    if (!tx) continue
    const coinbase = isCoinbase(tx)

    let outputTotal = 0n
    for (const vout of tx.vout) {
      outputTotal += btcToSats(vout.value)
    }

    // ---- inputs: outbound movements, the fee, and the spend records
    let inputTotal = 0n
    let allInputsResolved = true
    for (let vinIndex = 0; vinIndex < tx.vin.length; vinIndex++) {
      const vin = tx.vin[vinIndex]
      if (!vin) continue
      // A coinbase input spends nothing and has no prevout. It is not an unresolved input and it
      // must not be counted as one, or every block would report the reward as a missing fee.
      if (vin.coinbase !== undefined) continue
      if (vin.txid === undefined || vin.vout === undefined) {
        allInputsResolved = false
        unresolvedInputs += 1
        continue
      }

      spends.push({
        txid: vin.txid,
        vout: vin.vout,
        spendingTxHash: tx.txid,
        blockHeight: height,
        blockHash,
      })

      const resolved =
        vin.prevout !== undefined
          ? { value: vin.prevout.value, address: addressOf(vin.prevout.scriptPubKey) }
          : prevouts.get(outpointKey(vin.txid, vin.vout))
      if (!resolved) {
        allInputsResolved = false
        unresolvedInputs += 1
        continue
      }

      const amount = btcToSats(resolved.value)
      inputTotal += amount
      if (resolved.address && amount > 0n) {
        activity.push(
          movement(
            canonicalBitcoinAddress(resolved.address),
            'out',
            amount,
            tx.txid,
            vinIndex,
            height,
            blockHash,
            nativeAssetCode,
          ),
        )
      }
    }

    // ---- outputs: inbound movements, one per output, which is the UTXO rule
    for (const vout of tx.vout) {
      const amount = btcToSats(vout.value)
      // A zero-value output is a data carrier (OP_RETURN) or dust convention. It credits nobody.
      if (amount === 0n) continue
      const address = addressOf(vout.scriptPubKey)
      if (!address) continue
      activity.push(
        movement(
          canonicalBitcoinAddress(address),
          'in',
          amount,
          tx.txid,
          vout.n,
          height,
          blockHash,
          nativeAssetCode,
        ),
      )
    }

    transactions.push({
      // `txid`, never `hash`. On a segwit transaction the two differ: `hash` is the wtxid, which
      // commits to the witness and is NOT what an explorer, a block header's merkle tree, or any
      // other service in this estate keys a transaction by.
      hash: tx.txid,
      blockHash,
      blockHeight: height,
      txIndex: index,
      // Null, and deliberately. A UTXO transaction has no single sender and no single recipient;
      // inventing one from `vin[0]` or `vout[0]` would be a plausible, wrong answer that every
      // consumer would then believe. The movements carry the real attribution.
      from: null,
      to: null,
      value: outputTotal,
      fee: coinbase ? null : allInputsResolved ? inputTotal - outputTotal : null,
      status: 'success',
      // Bitcoin has no nonce and no sequence number at transaction scope. `locktime` is not one:
      // it is a height or a timestamp, and putting it here would make it comparable with an EVM
      // nonce by any consumer reading the shared column.
      nonceOrSequence: null,
      rawRef: {
        version: tx.version ?? null,
        size: tx.size ?? null,
        vsize: tx.vsize ?? null,
        weight: tx.weight ?? null,
        locktime: tx.locktime ?? null,
        coinbase,
        rbf: signalsRbf(tx),
        inputCount: tx.vin.length,
        outputCount: tx.vout.length,
        wtxid: tx.hash ?? null,
      },
    })
  }

  return { block, transactions, activity, spends, unresolvedInputs }
}

function movement(
  address: string,
  direction: 'in' | 'out',
  amount: bigint,
  txHash: string,
  index: number,
  blockHeight: number,
  blockHash: string,
  assetCode: string,
): ActivityInput {
  return {
    address,
    direction,
    assetCode,
    assetKind: 'native',
    tokenAddress: null,
    amount,
    txHash,
    // The index is the OUTPUT index for an inbound movement and the INPUT index for an outbound
    // one, and the direction in the key is what keeps those two numbering schemes apart. Passing
    // null here — the EVM spelling for a native movement — would collapse two outputs of one
    // transaction paying one address into a single row, which is precisely the UTXO mistake
    // FAMILY_NOTES warns about: a transaction credits an address once per output paying it.
    entryKey: activityEntryKey(index, direction, address),
    logIndex: index,
    blockHeight,
    blockHash,
  }
}

/* ------------------------------------------------------------------ errors */

export class BitcoinNetworkError extends Error {
  constructor(scope: ChainScope, expected: readonly string[], actual: string) {
    super(
      `${scopeKey(scope)} expects a node on ${expected.join(' or ')} but getblockchaininfo said ` +
        `'${actual}' — indexing one network into another network's rows is silent until someone ` +
        'looks, and for Bitcoin it is the difference between real money and test coins',
    )
    this.name = 'BitcoinNetworkError'
  }
}

/**
 * Which `getblockchaininfo.chain` values are acceptable for a scope.
 *
 * `main` is admissible only for `mainnet` and nothing else is, which is the direction that
 * matters: a testnet scope pointed at a mainnet node would index real transactions into rows every
 * consumer believes are test coins.
 */
export const ACCEPTED_CORE_CHAINS: Readonly<Record<Network, readonly string[]>> = Object.freeze({
  mainnet: Object.freeze(['main']),
  testnet: Object.freeze(['test', 'testnet4', 'signet', 'regtest']),
})

/* ------------------------------------------------------------------ the worker */

export interface BitcoinWorkerDeps {
  readonly sql: Db
  readonly scope: ChainScope
  readonly rpc: RpcPool
  readonly logger: Logger
  readonly metrics: Metrics
  readonly producer: string
  readonly followBatchBlocks: number
  readonly backfillBatchBlocks: number
  readonly startHeight: number | undefined
  readonly maxReorgWalk?: number
  readonly confirmBatch?: number
}

const MAX_REORGS_PER_TICK = 4

/** Core's "Block height out of range". A question answered, not a provider failing. */
const RPC_INVALID_PARAMETER = -8
/** Core's "Block not found". Same. */
const RPC_INVALID_ADDRESS_OR_KEY = -5

export class BitcoinWorker implements ChainWorker {
  readonly #d: BitcoinWorkerDeps
  readonly #maxReorgWalk: number
  readonly #confirmBatch: number
  /** Probed once per process, exactly as `evm.ts` probes `eth_getBlockReceipts`. */
  #verbosityThreeSupported: boolean | null = null
  #identityVerified = false

  constructor(deps: BitcoinWorkerDeps) {
    this.#d = deps
    this.#maxReorgWalk = deps.maxReorgWalk ?? 256
    this.#confirmBatch = deps.confirmBatch ?? 200
  }

  get scope(): ChainScope {
    return this.#d.scope
  }

  get family(): ChainFamily {
    return 'bitcoin'
  }

  get #labels(): Record<string, string> {
    return { chain: this.#d.scope.chain, network: this.#d.scope.network }
  }

  /**
   * Refuse to index the wrong network.
   *
   * `evm.ts` observes that Bitcoin has no chain id and concludes its identity cannot be verified.
   * That is true of chain ids and false of the chain: Core reports which network it is on, and
   * the failure it prevents here is strictly worse than the EVM one it mirrors — a testnet scope
   * served by a mainnet node indexes real money into rows labelled as test coins.
   */
  async verifyIdentity(signal: AbortSignal): Promise<void> {
    const info = await this.#d.rpc.call<{ chain?: string }>('getblockchaininfo', [], { signal })
    const actual = info?.chain ?? ''
    const accepted = ACCEPTED_CORE_CHAINS[this.#d.scope.network]
    if (!accepted.includes(actual)) {
      throw new BitcoinNetworkError(this.#d.scope, accepted, actual)
    }
    this.#identityVerified = true
    this.#d.logger.info('bitcoin network verified', { ...this.#labels, coreChain: actual })
  }

  async #ensureIdentity(signal: AbortSignal): Promise<void> {
    if (this.#identityVerified) return
    await this.verifyIdentity(signal)
  }

  async persistHealth(): Promise<void> {
    for (const snapshot of this.#d.rpc.snapshot()) {
      await upsertProviderHealth(this.#d.sql, this.#d.scope, snapshot)
    }
  }

  async follow(signal: AbortSignal): Promise<FollowOutcome> {
    const empty: FollowOutcome = {
      blocksIndexed: 0,
      tipHeight: null,
      lag: null,
      reorgs: [],
      confirmed: 0,
      halted: false,
      providerUnavailable: false,
    }

    if (await isHalted(this.#d.sql, this.#d.scope)) {
      this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)
      return { ...empty, halted: true }
    }
    this.#d.metrics.set(CHAIN_HALTED, 0, this.#labels)

    let tip: number
    try {
      await this.#ensureIdentity(signal)
      tip = await this.#tip(signal)
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        this.#d.logger.warn('no provider answered for the tip', { ...this.#labels, err })
        return { ...empty, providerUnavailable: true }
      }
      throw err
    }
    await recordTip(this.#d.sql, this.#d.scope, tip)
    this.#d.metrics.set(TIP_HEIGHT, tip, this.#labels)

    const reorgs: ReorgOutcome[] = []
    let blocksIndexed = 0
    let halted = false
    let providerUnavailable = false
    let reorged = false

    try {
      // Check one: is the stored head still on the chain, with the same hash. Catches a
      // replacement at the head and a chain that has become shorter.
      const head = await headBlock(this.#d.sql, this.#d.scope)
      if (head) {
        const onChainHash = await this.#hashAt(head.height, signal)
        if (onChainHash === null || onChainHash !== head.hash) {
          const outcome = await this.#handleReorg(head.height, signal)
          reorgs.push(outcome)
          reorged = true
          halted = outcome.alarming
        }
      }

      let cursor = halted ? null : await this.#cursor(tip)
      let budget = this.#d.followBatchBlocks

      while (!halted && cursor !== null && budget > 0 && !signal.aborted) {
        const next = cursor + 1
        if (next > tip) break

        const raw = await this.#blockAt(next, signal)
        if (!raw) break

        // Check two: the cheap forward check on the parent hash.
        const parent = await blockAtHeight(this.#d.sql, this.#d.scope, cursor)
        if (parent && parent.hash !== raw.previousblockhash) {
          if (reorgs.length >= MAX_REORGS_PER_TICK) break
          const outcome = await this.#handleReorg(cursor, signal)
          reorgs.push(outcome)
          reorged = true
          if (outcome.alarming) {
            halted = true
            break
          }
          cursor = outcome.commonAncestorHeight
          continue
        }

        await this.#indexBlock(raw, TIP_STREAM, signal)
        blocksIndexed += 1
        cursor = next
        budget -= 1
      }
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        this.#d.logger.warn('provider became unavailable mid-tick', { ...this.#labels, err })
        providerUnavailable = true
      } else {
        throw err
      }
    }

    // The Bitcoin-only step, and it runs AFTER the replacement chain has been indexed rather than
    // inside the reorg transaction — which is the whole point. At the moment a reorg is detected
    // nothing is yet known about what the winning chain spends; that only becomes true once its
    // blocks are in. A transaction is conflicted out by evidence, not by suspicion.
    if (reorged && !halted) {
      const conflicts = await markConflictedSpends(this.#d.sql, this.#d.scope)
      if (conflicts.transactions > 0) {
        this.#d.logger.warn(
          'transactions were conflicted out by the winning chain and can never be re-mined',
          { ...this.#labels, ...conflicts },
        )
      }
    }

    const confirmed = halted ? 0 : await this.#confirm(tip)

    const cursorNow = await this.#storedHeight()
    const lag = cursorNow === null ? tip : Math.max(0, tip - cursorNow)
    this.#d.metrics.set(LAG_BLOCKS, lag, this.#labels)

    return { blocksIndexed, tipHeight: tip, lag, reorgs, confirmed, halted, providerUnavailable }
  }

  async backfill(signal: AbortSignal): Promise<BackfillOutcome> {
    const none: BackfillOutcome = {
      stream: null,
      blocksIndexed: 0,
      complete: true,
      providerUnavailable: false,
    }
    if (await isHalted(this.#d.sql, this.#d.scope)) return none

    const checkpoint = await nextUnfinishedBackfill(this.#d.sql, this.#d.scope)
    if (!checkpoint || checkpoint.rangeFrom === null || checkpoint.rangeTo === null) return none

    const to = checkpoint.rangeTo
    let cursor = checkpoint.height ?? checkpoint.rangeFrom - 1
    let blocksIndexed = 0
    let providerUnavailable = false

    try {
      await this.#ensureIdentity(signal)
      let budget = this.#d.backfillBatchBlocks
      while (budget > 0 && cursor < to && !signal.aborted) {
        const next = cursor + 1
        const raw = await this.#blockAt(next, signal)
        if (!raw) break
        await this.#indexBlock(raw, checkpoint.stream, signal)
        blocksIndexed += 1
        cursor = next
        budget -= 1
      }
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        providerUnavailable = true
      } else {
        throw err
      }
    }

    return {
      stream: checkpoint.stream,
      blocksIndexed,
      complete: cursor >= to,
      providerUnavailable,
    }
  }

  /* ---------------------------------------------------------------- internals */

  async #tip(signal: AbortSignal): Promise<number> {
    return this.#d.rpc.call<number>('getblockcount', [], { signal })
  }

  /**
   * The hash of the ACTIVE chain's block at a height, or null when there is none.
   *
   * `getblockhash` follows the active chain, so a block that has been reorganised out simply
   * stops being the answer at its height. That is the same property `eth_getBlockByNumber` has
   * and it is what makes the reorg walk work identically here.
   */
  async #hashAt(height: number, signal: AbortSignal): Promise<string | null> {
    try {
      const hash = await this.#d.rpc.call<string | null>('getblockhash', [height], { signal })
      return hash && hash.length > 0 ? hash : null
    } catch (err) {
      // "out of range" is an answer — the chain is shorter than this — not a provider failing.
      if (err instanceof RpcError && err.code === RPC_INVALID_PARAMETER) return null
      throw err
    }
  }

  async #blockAt(height: number, signal: AbortSignal): Promise<RawBtcBlock | null> {
    const hash = await this.#hashAt(height, signal)
    if (!hash) return null
    return this.#blockByHash(hash, signal)
  }

  /**
   * A verbose block, preferring verbosity 3 and remembering whether the node has it.
   *
   * Verbosity 3 (Core 25+) includes each input's `prevout`, which is what makes outbound movements
   * and the fee computable from one call. Verbosity 2 does not, and the fallback resolves prevouts
   * with one `getrawtransaction` per distinct funding transaction — the same shape as `evm.ts`'s
   * fallback from `eth_getBlockReceipts` to per-transaction receipts, and probed the same way so
   * a node that lacks it costs one wasted round trip per process rather than per block.
   */
  async #blockByHash(hash: string, signal: AbortSignal): Promise<RawBtcBlock | null> {
    if (this.#verbosityThreeSupported !== false) {
      try {
        const raw = await this.#d.rpc.call<RawBtcBlock | null>('getblock', [hash, 3], { signal })
        if (raw && raw.hash && raw.tx) {
          this.#verbosityThreeSupported = true
          return raw
        }
      } catch (err) {
        if (
          err instanceof RpcError &&
          (err.code === -32601 || err.code === RPC_INVALID_PARAMETER || err.code === -1)
        ) {
          this.#verbosityThreeSupported = false
          this.#d.logger.info('node does not serve getblock verbosity 3; resolving prevouts', {
            ...this.#labels,
          })
        } else if (err instanceof RpcError && err.code === RPC_INVALID_ADDRESS_OR_KEY) {
          return null
        } else {
          throw err
        }
      }
    }

    try {
      const raw = await this.#d.rpc.call<RawBtcBlock | null>('getblock', [hash, 2], { signal })
      return raw && raw.hash && raw.tx ? raw : null
    } catch (err) {
      if (err instanceof RpcError && err.code === RPC_INVALID_ADDRESS_OR_KEY) return null
      throw err
    }
  }

  /**
   * Resolve every prevout a block spends that the block itself did not carry.
   *
   * Outputs created *earlier in the same block* are resolved from the block, not from the node: a
   * chain of transactions inside one block is ordinary, and asking the node for a transaction it
   * has not finished connecting is how a correct block reports unresolved inputs.
   */
  async #prevouts(
    raw: RawBtcBlock,
    signal: AbortSignal,
  ): Promise<Map<string, Prevout>> {
    const resolved = new Map<string, Prevout>()

    // Same-block outputs first, so they are never fetched.
    for (const tx of raw.tx) {
      for (const vout of tx.vout) {
        resolved.set(outpointKey(tx.txid, vout.n), {
          value: vout.value,
          address: addressOf(vout.scriptPubKey),
        })
      }
    }

    const wanted = new Set<string>()
    for (const tx of raw.tx) {
      for (const vin of tx.vin) {
        if (vin.coinbase !== undefined) continue
        if (vin.prevout !== undefined) continue
        if (vin.txid === undefined || vin.vout === undefined) continue
        if (resolved.has(outpointKey(vin.txid, vin.vout))) continue
        wanted.add(vin.txid)
      }
    }
    if (wanted.size === 0) return resolved

    for (const txid of wanted) {
      let funding: RawBtcTx | null = null
      try {
        funding = await this.#d.rpc.call<RawBtcTx | null>('getrawtransaction', [txid, true], {
          signal,
        })
      } catch (err) {
        // A pruned node, or one without a transaction index, cannot answer for a historical
        // transaction. That is a capability gap, not a fault: the block still indexes, its
        // inbound movements — the deposits — are unaffected, and `unresolvedInputs` says so.
        if (err instanceof RpcError) {
          this.#d.logger.warn('a prevout could not be resolved; outbound movements are incomplete', {
            ...this.#labels,
            txid,
            code: err.code,
          })
          continue
        }
        throw err
      }
      if (!funding) continue
      for (const vout of funding.vout) {
        resolved.set(outpointKey(txid, vout.n), {
          value: vout.value,
          address: addressOf(vout.scriptPubKey),
        })
      }
    }
    return resolved
  }

  async #cursor(tip: number): Promise<number | null> {
    const checkpoint = await getCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM)
    if (checkpoint?.height !== null && checkpoint?.height !== undefined) return checkpoint.height
    const head = await headBlock(this.#d.sql, this.#d.scope)
    if (head) return head.height
    if (this.#d.startHeight !== undefined) return this.#d.startHeight - 1
    const window = requiredConfirmations(this.#d.scope.chain) * 2
    return Math.max(0, tip - window) - 1
  }

  async #storedHeight(): Promise<number | null> {
    const checkpoint = await getCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM)
    return checkpoint?.height ?? null
  }

  /** One block, one transaction. Rows, spends, events and the checkpoint commit together. */
  async #indexBlock(raw: RawBtcBlock, stream: string, signal: AbortSignal): Promise<void> {
    const prevouts = await this.#prevouts(raw, signal)
    const asset = assetOf(this.#d.scope.chain)
    const extracted = extractBitcoinBlock(raw, prevouts, asset)
    const addresses = [...new Set(extracted.activity.map((a) => a.address))]

    let observed = 0
    await withOutbox(this.#d.sql, this.#d.producer, async (tx, emit) => {
      const watched = await filterWatched(tx, this.#d.scope, addresses)

      await upsertBlock(tx, this.#d.scope, extracted.block)
      for (const transaction of extracted.transactions) {
        await upsertTransaction(tx, this.#d.scope, transaction)
      }
      // After the transactions, because `spent_outpoints` carries a foreign key to them.
      await recordSpends(tx, this.#d.scope, extracted.spends)
      for (const mv of extracted.activity) {
        const { inserted } = await upsertActivity(tx, this.#d.scope, mv)
        this.#d.metrics.increment(ACTIVITY_TOTAL, {
          ...this.#labels,
          direction: mv.direction,
          asset_kind: mv.assetKind,
        })
        if (!inserted || mv.direction !== 'in' || !watched.has(mv.address)) continue
        observed += 1
        emit({
          topic: DEPOSIT_OBSERVED,
          key: `${this.#d.scope.chain}:${this.#d.scope.network}:${mv.address}`,
          payload: this.#depositPayload(mv, extracted.block, null),
        })
      }
      await setCheckpoint(tx, this.#d.scope, stream, extracted.block.height, extracted.block.hash)
    })

    this.#d.metrics.increment(BLOCKS_INDEXED_TOTAL, { ...this.#labels, stream })
    this.#d.metrics.increment(
      TRANSACTIONS_INDEXED_TOTAL,
      this.#labels,
      extracted.transactions.length,
    )
    if (observed > 0) {
      this.#d.metrics.increment(DEPOSITS_OBSERVED_TOTAL, this.#labels, observed)
    }
    if (extracted.unresolvedInputs > 0) {
      this.#d.logger.warn('some inputs could not be resolved to a prevout', {
        ...this.#labels,
        height: extracted.block.height,
        unresolvedInputs: extracted.unresolvedInputs,
      })
    }
  }

  /**
   * Walk back to the common ancestor, retract everything above it, and rewind.
   *
   * Structurally this is `evm.ts`'s walk, and deliberately so — Bitcoin's reorg *detection* really
   * is depth-based, and inventing a different shape for it would be worse than reusing the right
   * one. What differs is entirely downstream: what "retracted" then means (see
   * `markConflictedSpends`) and the fact that the outpoints must be released here or the
   * replacement chain cannot be written at all.
   */
  async #handleReorg(forkHeight: number, signal: AbortSignal): Promise<ReorgOutcome> {
    const scope = this.#d.scope
    const previousHead = await headBlock(this.#d.sql, scope)
    if (!previousHead) throw new Error('reorg handling reached with no stored head')

    let ancestorHeight = -1
    let ancestorHash = ''
    const floor = Math.max(0, forkHeight - this.#maxReorgWalk)

    for (let height = forkHeight; height >= floor; height--) {
      const stored = await blockAtHeight(this.#d.sql, scope, height)
      if (!stored) {
        ancestorHeight = height
        ancestorHash = ''
        break
      }
      const onChain = await this.#hashAt(height, signal)
      if (onChain && onChain === stored.hash) {
        ancestorHeight = height
        ancestorHash = stored.hash
        break
      }
    }

    if (ancestorHeight < 0) {
      const reason = `reorg deeper than ${this.#maxReorgWalk} blocks below height ${forkHeight}`
      await haltChain(this.#d.sql, scope, reason)
      this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)
      throw new BitcoinReorgTooDeepError(scope, this.#maxReorgWalk)
    }

    const depth = previousHead.height - ancestorHeight
    const isAlarming = alarming(scope.chain, depth)

    const outcome = await withOutbox(this.#d.sql, this.#d.producer, async (tx) => {
      const counts = await orphanAbove(tx, scope, ancestorHeight, depth)
      await insertReorg(tx, scope, {
        commonAncestorHeight: ancestorHeight,
        commonAncestorHash: ancestorHash,
        previousTipHeight: previousHead.height,
        previousTipHash: previousHead.hash,
        depth,
        alarming: isAlarming,
        counts,
      })
      await setCheckpoint(tx, scope, TIP_STREAM, ancestorHeight, ancestorHash || null)
      if (isAlarming) {
        await haltChain(
          tx,
          scope,
          `reorg of depth ${depth} at or past the alarm depth for ${assetOf(scope.chain)}`,
        )
      }
      const result: ReorgOutcome = {
        depth,
        commonAncestorHeight: ancestorHeight,
        previousTipHeight: previousHead.height,
        alarming: isAlarming,
        orphanedBlocks: counts.blockHashes.length,
        orphanedTransactions: counts.transactions,
        orphanedActivity: counts.activity,
      }
      return result
    })

    this.#d.metrics.increment(REORGS_TOTAL, {
      ...this.#labels,
      depth: depthBucket(depth),
      alarming: String(isAlarming),
    })
    if (isAlarming) this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)

    const line = {
      ...this.#labels,
      depth,
      commonAncestorHeight: ancestorHeight,
      previousTipHeight: previousHead.height,
      orphanedBlocks: outcome.orphanedBlocks,
      orphanedTransactions: outcome.orphanedTransactions,
      orphanedActivity: outcome.orphanedActivity,
    }
    if (isAlarming) {
      this.#d.logger.error(
        'reorg at or past the alarm depth — this chain is halted until an operator clears it',
        line,
      )
    } else {
      this.#d.logger.warn('reorg detected and repaired', line)
    }
    return outcome
  }

  /**
   * Report every watched inbound movement that has reached its depth.
   *
   * Identical in policy to `evm.ts` — the depth comes from `contracts-chain` and is applied in one
   * place — because Bitcoin's confirmation model genuinely is depth. `confirmationsAt` counts the
   * mining block as the first, which is the off-by-one FAMILY_NOTES names for this family.
   */
  async #confirm(tip: number): Promise<number> {
    const required = requiredConfirmations(this.#d.scope.chain)
    const maxHeight = tip - required + 1
    if (maxHeight < 0) return 0

    return withOutbox(this.#d.sql, this.#d.producer, async (tx, emit) => {
      const pending = await pendingConfirmations(tx, this.#d.scope, maxHeight, this.#confirmBatch)
      const confirmedIds: string[] = []
      for (const mv of pending) {
        const confirmations = confirmationsAt(tip, mv.blockHeight)
        if (!creditable(this.#d.scope.chain, confirmations)) continue
        confirmedIds.push(mv.id)
        emit({
          topic: DEPOSIT_CONFIRMED,
          key: `${this.#d.scope.chain}:${this.#d.scope.network}:${mv.address}`,
          payload: this.#depositPayload(
            {
              address: mv.address,
              direction: mv.direction,
              assetCode: mv.assetCode,
              assetKind: mv.assetKind,
              tokenAddress: mv.tokenAddress,
              amount: mv.amount,
              txHash: mv.txHash,
              entryKey: '',
              logIndex: mv.logIndex,
              blockHeight: mv.blockHeight,
              blockHash: mv.blockHash,
            },
            null,
            confirmations,
          ),
        })
      }
      await markConfirmed(tx, this.#d.scope, confirmedIds)
      if (confirmedIds.length > 0) {
        this.#d.metrics.increment(DEPOSITS_CONFIRMED_TOTAL, this.#labels, confirmedIds.length)
      }
      return confirmedIds.length
    })
  }

  #depositPayload(
    mv: ActivityInput,
    block: BlockInput | null,
    confirmations: number | null,
  ): Record<string, unknown> {
    const asset = assetOf(this.#d.scope.chain)
    return {
      chain: this.#d.scope.chain,
      network: this.#d.scope.network,
      address: mv.address,
      direction: mv.direction,
      assetCode: mv.assetCode,
      assetKind: mv.assetKind,
      tokenAddress: mv.tokenAddress,
      amount: mv.amount.toString(),
      txHash: mv.txHash,
      txUrn: txUrn(asset, this.#d.scope.network, mv.txHash),
      explorerUrl: explorerTxUrl(asset, this.#d.scope.network, mv.txHash),
      // For Bitcoin this is the OUTPUT index that paid the address, which is the field that makes
      // two credits to one address from one transaction distinguishable by a consumer.
      logIndex: mv.logIndex,
      blockHeight: mv.blockHeight,
      blockHash: mv.blockHash,
      blockTime: block ? block.blockTime.toISOString() : null,
      confirmations,
      requiredConfirmations: requiredConfirmations(this.#d.scope.chain),
    }
  }
}

export class BitcoinReorgTooDeepError extends Error {
  readonly walked: number
  constructor(scope: ChainScope, walked: number) {
    super(
      `${scopeKey(scope)} reorganised deeper than the ${walked} blocks this worker will walk ` +
        'back — the chain is halted rather than guessed at',
    )
    this.name = 'BitcoinReorgTooDeepError'
    this.walked = walked
  }
}
