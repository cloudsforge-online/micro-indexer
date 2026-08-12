/**
 * The EVM worker. It serves Ethereum and, with a different chain id and a depth of 60, Hearth.
 *
 * AD-07: "Hearth is a first-class family, not a special case. Hearth exposes Ethereum JSON-RPC on
 * 8545, so the EVM worker serves it with a different chain id and a different confirmation depth
 * (60). This is a direct dividend of Hearth's EVM migration." Everything that differs between the
 * two chains is a value read from `@cloudsforge/contracts-chain`; there is not one branch in this
 * file on which chain it is following.
 *
 * ## What this replaces
 *
 * 00-current-state §3.4. Today deposit detection loads every address row with no pagination every
 * thirty seconds, calls `eth_getBalance` at `latest - confirmations`, and compares against a
 * high-water mark. The consequences it lists are each a line of this file:
 *
 *   - *Synthetic txids* — every `address_activity` row here carries the real transaction hash, and
 *     `contracts-chain.txUrn` and `explorerTxUrl` turn it into a cross-service reference and a
 *     link. This is the first real transaction hash on a deposit anywhere in the estate.
 *   - *No history, no token transfers* — `transactions`, `logs`, and ERC-20 `Transfer` extraction.
 *   - *No failed-transaction visibility* — a reverted transaction is stored with `status='failed'`
 *     and produces no activity, because a reverted transfer moved nothing.
 *   - *No reorg detection* — the whole of `#handleReorg` below.
 *   - *A balance regression freezes crediting permanently* — there is no high-water mark here at
 *     all. Movements are additive facts with a real hash; a retraction is an orphan, not a freeze.
 *
 * ## The reorg algorithm, which is the most important behaviour in the service
 *
 * Every tick does two checks before it indexes anything:
 *
 *   1. **The stored head still exists on the chain, with the same hash.** This catches a
 *      replacement at the head and a chain that has become shorter, neither of which the parent
 *      check below can see.
 *   2. **The next block's `parentHash` equals the stored block at `height - 1`.** This is the
 *      cheap check that catches the ordinary case on the way forward.
 *
 * Either failing walks backwards comparing stored hashes against the chain's until they agree —
 * the common ancestor — then, in **one transaction**: marks every block, transaction, log and
 * movement above it orphaned, writes a `reorgs` row, and rewinds the checkpoint to the ancestor.
 * The next pass re-indexes forward from there. One transaction matters: a rewind that commits
 * without the orphaning is a chain that re-indexes into rows that still claim the old history, and
 * `blocks_canonical_height_uniq` would then reject the replacement block at 23505.
 *
 * `isReorgAlarming` from `contracts-chain` decides whether that is merely recorded or halts the
 * chain. Note what the depths make true: EMBER alarms at 5 and credits at 60, ETH alarms at 3 and
 * credits at 12. A reorg deep enough to retract a *confirmed* movement is therefore always deep
 * enough to have halted the chain first. That is not a coincidence, it is what setting the alarm
 * below the credit depth is for, and `evm.test.ts` asserts it.
 */

import { explorerTxUrl, txUrn } from '@cloudsforge/contracts-chain'
import type { ChainFamily } from '@cloudsforge/contracts-chain'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import {
  alarming,
  assetOf,
  confirmationsAt,
  creditable,
  declaredChainId,
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
  DIFFICULTY,
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
  nextUnfinishedBackfill,
  orphanAbove,
  pendingConfirmations,
  recordTip,
  setCheckpoint,
  upsertActivity,
  upsertBlock,
  upsertLog,
  upsertProviderHealth,
  upsertTransaction,
  type ActivityInput,
  type BlockInput,
  type LogInput,
  type TransactionInput,
} from './store.ts'
import type { BackfillOutcome, ChainWorker, FollowOutcome, ReorgOutcome } from './worker.ts'

/* ------------------------------------------------------------------ JSON-RPC shapes */

interface RawTx {
  readonly hash: string
  readonly from?: string | null
  readonly to?: string | null
  readonly value?: string
  readonly nonce?: string
  readonly transactionIndex?: string
  readonly gas?: string
  readonly gasPrice?: string
  readonly type?: string
  readonly input?: string
}

/**
 * A block as `eth_getBlockByNumber` returns it.
 *
 * The named fields are the ones this file reads and reasons about. The index signature is the
 * other half of the type and it is deliberate: an EVM header carries whatever the chain's rules
 * put in it — `stateRoot`, `receiptsRoot`, `logsBloom`, `extraData`, `mixHash`, `nonce`,
 * `baseFeePerGas` on a London chain, `withdrawalsRoot` after Shanghai — and this service does not
 * get to decide which of them a reader is allowed to see. Naming a subset here is what made
 * `extractBlock` narrow the header down to four fields for a year; see `headerDetail`.
 */
interface RawBlock {
  readonly number: string
  readonly hash: string
  readonly parentHash: string
  readonly timestamp: string
  readonly transactions?: readonly RawTx[]
  readonly miner?: string
  readonly gasUsed?: string
  readonly gasLimit?: string
  readonly difficulty?: string
  readonly [field: string]: unknown
}

interface RawLog {
  readonly address: string
  readonly topics?: readonly string[]
  readonly data?: string
  readonly logIndex?: string
  readonly transactionHash?: string
  readonly removed?: boolean
}

interface RawReceipt {
  readonly transactionHash: string
  readonly status?: string
  readonly gasUsed?: string
  readonly effectiveGasPrice?: string
  readonly contractAddress?: string | null
  readonly logs?: readonly RawLog[]
}

/* ------------------------------------------------------------------ hex */

/** A JSON-RPC quantity. Tolerates the odd provider that omits the `0x`. */
export function hexToBigInt(value: string | undefined | null): bigint {
  if (value === undefined || value === null || value === '') return 0n
  return BigInt(value.startsWith('0x') || value.startsWith('0X') ? value : `0x${value}`)
}

/**
 * A quantity that must fit a JavaScript number: a height, an index, a nonce.
 *
 * It throws above `Number.MAX_SAFE_INTEGER` rather than silently rounding. A block height that
 * has quietly lost its low bits is a checkpoint that resumes in the wrong place, which is exactly
 * the failure this service exists to make impossible.
 */
export function hexToNumber(value: string | undefined | null): number {
  const big = hexToBigInt(value)
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`quantity ${value} exceeds the safe integer range`)
  }
  return Number(big)
}

export function toHexQuantity(value: number): string {
  return `0x${value.toString(16)}`
}

/**
 * A block's proof-of-work difficulty as a gauge value, or `null` when this chain has none.
 *
 * ## `null` rather than `0`, and this is the whole point of the function
 *
 * Three different states arrive at this function as "no useful difficulty", and every one of them
 * would become the number `0` if the caller just parsed the field:
 *
 *   - the provider omitted `difficulty` entirely;
 *   - the chain is proof-of-STAKE and reports `0x0` for ever, which is what every post-merge
 *     Ethereum block says;
 *   - the block is Hearth's genesis, which also reports `0x0` (measured 2026-08-10 against
 *     `cf-hearth-seed`: `eth_getBlockByNumber("0x0")` returns `difficulty: "0x0"`, while block
 *     `0x2af6` returns `"0x100"` — the floor — and `0x2bea` returns `"0x1fd2"`, the 8,146 that
 *     micro-org#363 measured by hand).
 *
 * A `0` published for any of those is a chain that reads as broken on a dashboard and as "not at
 * the floor" to an alert. `null` publishes nothing, which is the same answer `solana.ts` gives and
 * for the same reason: a gauge is allowed to have no series, and is not allowed to invent one.
 *
 * ## Why `Number` here, when `hexToNumber` throws
 *
 * `hexToNumber` refuses to round because a height that lost its low bits is a checkpoint that
 * resumes in the wrong place. A difficulty is never used to address anything — it is read as a
 * magnitude, and Prometheus stores every gauge as a float64 regardless, so the 53-bit mantissa is
 * imposed by the exposition format and not by this line. Throwing above 2^53 would cost the estate
 * the metric on exactly the chains whose difficulty is worth watching (pre-merge Ethereum ran at
 * ~1.5e16) in exchange for precision no scrape could have carried.
 */
export function difficultyGaugeValue(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  let parsed: bigint
  try {
    parsed = hexToBigInt(raw)
  } catch {
    // A provider that answered with something that is not a quantity has told us nothing about the
    // difficulty. Nothing is what gets published.
    return null
  }
  if (parsed <= 0n) return null
  return Number(parsed)
}

/** keccak256("Transfer(address,address,uint256)"). The one event every fungible token emits. */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * The low 20 bytes of an indexed address topic.
 *
 * Lower-cased on the way out. EIP-55 checksum casing is a display convention; storing it would
 * make `where address = $1` miss for any caller that sent the address in a different case, and a
 * deposit that is invisible because of letter case is indistinguishable from a deposit that never
 * arrived.
 */
export function addressFromTopic(topic: string | undefined): string | null {
  if (!topic) return null
  const body = topic.startsWith('0x') ? topic.slice(2) : topic
  if (body.length !== 64) return null
  // An indexed address is left-padded with twelve zero bytes. Anything else is not an address.
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(body)) return null
  return `0x${body.slice(24).toLowerCase()}`
}

export function normaliseAddress(value: string | null | undefined): string | null {
  if (!value) return null
  return value.toLowerCase()
}

/* ------------------------------------------------------------------ extraction */

/**
 * The key holding the block body, and the only key the header record drops.
 *
 * `eth_getBlockByNumber(height, true)` returns the transactions inline. They are not header
 * fields, they are already rows in `transactions` with their receipts resolved, and a copy of them
 * inside `blocks.detail` would put the largest object this service handles into a jsonb column
 * twice.
 */
const BLOCK_BODY_KEY = 'transactions'

/**
 * The header, as the node gave it.
 *
 * ## What this replaces, and why the replacement is a whole-object copy rather than a longer list
 *
 * Until micro-org#395 this was four hand-picked keys: `miner`, `gasUsed`, `gasLimit`,
 * `difficulty`. Everything else the node sent was discarded at the point of extraction and never
 * reached the database, so no consumer could recover it and no read route could serve it.
 *
 * The field that made the omission matter is **`stateRoot`**. On an account-model chain a premine
 * lives in the genesis *allocation* — in state — and the header commits to it, so `stateRoot` on
 * block 0 is the only cryptographic evidence that nobody was funded before the first block was
 * mined (`hearth/node/src/chain/genesis.js` says exactly this at the alloc). EMBER's genesis
 * answers `0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421`, the canonical
 * empty-trie root. `micro-explorer-web` renders `detail` verbatim under a heading reading "the
 * header, exactly as the node gave it" — so a curated list here was that page's promise being
 * broken one service away from the page making it.
 *
 * A LONGER hand-picked list would have been the same defect with a later expiry date. Every field
 * added to the EVM header since this file was written — `baseFeePerGas`, `withdrawalsRoot`,
 * `blobGasUsed`, `excessBlobGas`, `parentBeaconBlockRoot` — arrived after somebody had already
 * decided what the interesting fields were, and the same is true of whatever a chain adds next.
 * The only list that cannot go stale is the node's own.
 *
 * ## Insertion order is the node's, and that is load-bearing
 *
 * `JSON.parse` preserves object key order for non-numeric keys and `postgres` serialises this
 * object as it stands, so the order the node used survives as far as the INSERT. It does not
 * survive the column: `blocks.detail` is `jsonb` (migration 3), and jsonb stores keys sorted by
 * length and then bytewise. **So the order a reader gets back is jsonb's, not the node's**, and no
 * amount of care in this function changes that — a `json` column would preserve it and would also
 * cost migration 8's `detail->>'partial'` index, which is a working guarantee traded for a
 * cosmetic one.
 *
 * What this function guarantees is the property that was actually broken: no field is dropped,
 * renamed or reinterpreted. Restoring a readable order is a display concern and is done in
 * `micro-explorer-web`, by SORTING the keys it is given — never by selecting from them, which is
 * the mistake this change exists to undo.
 *
 * ## Nothing is normalised, including `miner`
 *
 * The old code lower-cased `miner` through `normaliseAddress`. That is correct for the columns
 * this service matches on — `where address = $1` must not miss because of EIP-55 casing — and it
 * is wrong here, because this record's entire value is that it can be held up against `curl`
 * output and compared. `address_activity` and `transactions` still normalise; that is where
 * matching happens. This is the record, not the index.
 *
 * ## What it costs
 *
 * A full EVM header is ~1.4 kB of JSON against ~150 B for the four fields, and `logsBloom` alone
 * is 514 of those bytes. On EMBER mainnet's 13,946 blocks that is ~20 MB. On a chain with millions
 * of indexed blocks it is gigabytes, and an operator who follows one should know that before
 * turning it on rather than from a disk alert — the same cost argument migration 8 makes for
 * `address_activity`.
 */
export function headerDetail(raw: RawBlock): Record<string, unknown> {
  const detail: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === BLOCK_BODY_KEY) continue
    detail[key] = value
  }
  return detail
}

export interface ExtractedBlock {
  readonly block: BlockInput
  readonly transactions: readonly TransactionInput[]
  readonly logs: readonly LogInput[]
  readonly activity: readonly ActivityInput[]
}

/**
 * Turn one block plus its receipts into rows. Pure, so the interesting cases are unit-testable
 * without a chain and without a database.
 *
 * Two decisions worth stating:
 *
 * **A reverted transaction produces no activity.** Its `value` was not transferred and its logs
 * were not emitted. The transaction row is still written, with `status='failed'`, because "no
 * failed-transaction visibility" is one of the defects listed in 00-current-state §3.4 and the
 * user asking why their transfer did not arrive is entitled to the answer.
 *
 * **A block reward is not indexed.** In an account-model EVM the coinbase credit has no
 * transaction and therefore no hash, and this service's entire contract is that every movement it
 * reports can be pointed at on a block explorer. A miner's balance is a question for
 * `eth_getBalance`, which is precisely the interface being retired.
 */
export function extractBlock(
  raw: RawBlock,
  receipts: ReadonlyMap<string, RawReceipt>,
  nativeAssetCode: string,
): ExtractedBlock {
  const height = hexToNumber(raw.number)
  const rawTxs = raw.transactions ?? []

  const block: BlockInput = {
    height,
    hash: raw.hash,
    parentHash: raw.parentHash,
    // EVM timestamps are seconds. Milliseconds would put every block in 1970.
    blockTime: new Date(hexToNumber(raw.timestamp) * 1_000),
    txCount: rawTxs.length,
    detail: headerDetail(raw),
  }

  const transactions: TransactionInput[] = []
  const logs: LogInput[] = []
  const activity: ActivityInput[] = []

  for (let i = 0; i < rawTxs.length; i++) {
    const tx = rawTxs[i]
    if (!tx) continue
    const receipt = receipts.get(tx.hash.toLowerCase()) ?? receipts.get(tx.hash)
    // No receipt means we could not establish the outcome. `pending` is the honest word for that
    // and it keeps the row out of every "this succeeded" query until a later pass fills it in.
    const status = receipt === undefined ? 'pending' : receipt.status === '0x0' ? 'failed' : 'success'
    const fee =
      receipt === undefined
        ? null
        : hexToBigInt(receipt.gasUsed) * hexToBigInt(receipt.effectiveGasPrice ?? tx.gasPrice)
    const from = normaliseAddress(tx.from)
    const to = normaliseAddress(tx.to)
    const value = hexToBigInt(tx.value)

    transactions.push({
      hash: tx.hash,
      blockHash: raw.hash,
      blockHeight: height,
      txIndex: tx.transactionIndex === undefined ? i : hexToNumber(tx.transactionIndex),
      from,
      to,
      value,
      fee,
      status,
      nonceOrSequence: tx.nonce === undefined ? null : hexToNumber(tx.nonce),
      rawRef: {
        gas: tx.gas ?? null,
        gasPrice: tx.gasPrice ?? null,
        type: tx.type ?? null,
        inputBytes: tx.input && tx.input.length > 2 ? (tx.input.length - 2) / 2 : 0,
        // A contract deployment. One of the capabilities 00-current-state lists as absent, and it
        // costs one field because the receipt already carries it.
        contractAddress: normaliseAddress(receipt?.contractAddress ?? null),
      },
    })

    if (status !== 'success') continue

    if (value > 0n) {
      if (from) {
        activity.push(
          native(from, 'out', value, tx.hash, height, raw.hash, nativeAssetCode),
        )
      }
      if (to) {
        activity.push(native(to, 'in', value, tx.hash, height, raw.hash, nativeAssetCode))
      }
    }

    for (const log of receipt?.logs ?? []) {
      const logIndex = log.logIndex === undefined ? logs.length : hexToNumber(log.logIndex)
      const address = normaliseAddress(log.address)
      if (!address) continue
      const topics = (log.topics ?? []).map((t) => t.toLowerCase())
      logs.push({
        txHash: tx.hash,
        logIndex,
        blockHash: raw.hash,
        blockHeight: height,
        address,
        topics,
        data: log.data ?? '0x',
      })

      // ERC-20 Transfer: topic0, from, to, and the amount in data. A Transfer with two topics is
      // ERC-721's, whose third topic is a token id rather than an amount; treating it as a value
      // would report a deposit of the token id, so it is skipped rather than guessed at.
      if (topics[0] !== ERC20_TRANSFER_TOPIC || topics.length !== 3) continue
      const tokenFrom = addressFromTopic(topics[1])
      const tokenTo = addressFromTopic(topics[2])
      const amount = hexToBigInt(log.data ?? '0x0')
      if (amount === 0n) continue
      if (tokenFrom) {
        activity.push(
          token(tokenFrom, 'out', amount, tx.hash, logIndex, height, raw.hash, address),
        )
      }
      if (tokenTo) {
        activity.push(token(tokenTo, 'in', amount, tx.hash, logIndex, height, raw.hash, address))
      }
    }
  }

  return { block, transactions, logs, activity }
}

function native(
  address: string,
  direction: 'in' | 'out',
  amount: bigint,
  txHash: string,
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
    entryKey: activityEntryKey(null, direction, address),
    logIndex: null,
    blockHeight,
    blockHash,
  }
}

function token(
  address: string,
  direction: 'in' | 'out',
  amount: bigint,
  txHash: string,
  logIndex: number,
  blockHeight: number,
  blockHash: string,
  tokenAddress: string,
): ActivityInput {
  return {
    address,
    direction,
    // The contract address, not a symbol. A symbol is mutable, spoofable and off-chain; resolving
    // it belongs to a token registry, not to the record of what the chain said.
    assetCode: tokenAddress,
    assetKind: 'token',
    tokenAddress,
    amount,
    txHash,
    entryKey: activityEntryKey(logIndex, direction, address),
    logIndex,
    blockHeight,
    blockHash,
  }
}

/* ------------------------------------------------------------------ errors */

export class ChainIdentityError extends Error {
  constructor(scope: ChainScope, expected: number, actual: number) {
    super(
      `${scopeKey(scope)} expects chain id ${expected} but the provider answered ${actual} — ` +
        'indexing one chain into another chain’s rows is silent until someone looks',
    )
    this.name = 'ChainIdentityError'
  }
}

export class ReorgTooDeepError extends Error {
  readonly walked: number
  constructor(scope: ChainScope, walked: number) {
    super(
      `${scopeKey(scope)} reorganised deeper than the ${walked} blocks this worker will walk ` +
        'back — the chain is halted rather than guessed at',
    )
    this.name = 'ReorgTooDeepError'
    this.walked = walked
  }
}

/* ------------------------------------------------------------------ the worker */

export interface EvmWorkerDeps {
  readonly sql: Db
  readonly scope: ChainScope
  readonly family: ChainFamily
  readonly rpc: RpcPool
  readonly logger: Logger
  readonly metrics: Metrics
  readonly producer: string
  readonly followBatchBlocks: number
  readonly backfillBatchBlocks: number
  /** Where a cold start begins. Undefined means "the tip, less twice the confirmation depth". */
  readonly startHeight: number | undefined
  /** How far back a reorg walk will go before it gives up and halts. */
  readonly maxReorgWalk?: number
  /** Confirmation events emitted per tick. Bounded so one tick cannot outlive its lease. */
  readonly confirmBatch?: number
}

const MAX_REORGS_PER_TICK = 4

export class EvmWorker implements ChainWorker {
  readonly #d: EvmWorkerDeps
  readonly #maxReorgWalk: number
  readonly #confirmBatch: number
  #blockReceiptsSupported: boolean | null = null
  #identityVerified = false

  constructor(deps: EvmWorkerDeps) {
    this.#d = deps
    this.#maxReorgWalk = deps.maxReorgWalk ?? 256
    this.#confirmBatch = deps.confirmBatch ?? 200
  }

  get scope(): ChainScope {
    return this.#d.scope
  }

  get family(): ChainFamily {
    return this.#d.family
  }

  get #labels(): Record<string, string> {
    return { chain: this.#d.scope.chain, network: this.#d.scope.network }
  }

  /**
   * Refuse to index the wrong chain.
   *
   * Bitcoin and XRP have no chain id, so this is a no-op for them by construction — which is one
   * more reason the XRP worker must lean on `(chain, network)` scoping rather than on an identity
   * check it cannot perform.
   */
  async verifyIdentity(signal: AbortSignal): Promise<void> {
    const expected = declaredChainId(this.#d.scope.chain, this.#d.scope.network)
    if (expected === undefined) {
      this.#identityVerified = true
      return
    }
    const actual = hexToNumber(await this.#d.rpc.call<string>('eth_chainId', [], { signal }))
    if (actual !== expected) throw new ChainIdentityError(this.#d.scope, expected, actual)
    this.#identityVerified = true
    this.#d.logger.info('chain identity verified', { ...this.#labels, chainId: actual })
  }

  /**
   * Verify once per process, before the first block is written.
   *
   * The composition root also verifies at boot, but a provider that was unreachable then is a
   * provider whose identity was never checked — and it will start answering later. Doing it here
   * as well means there is no path on which a block is indexed from an endpoint this worker has
   * not confirmed is the chain it claims to be.
   */
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

    try {
      // Check one: the stored head is still on the chain. This is what catches a same-height
      // replacement and a chain that has become shorter, neither of which the parent check can.
      const head = await headBlock(this.#d.sql, this.#d.scope)
      if (head) {
        const onChain = await this.#blockAt(head.height, signal)
        if (!onChain || onChain.hash !== head.hash) {
          const outcome = await this.#handleReorg(head.height, signal)
          reorgs.push(outcome)
          halted = outcome.alarming
        }
      }

      let cursor = halted ? null : await this.#cursor(tip)
      let budget = this.#d.followBatchBlocks

      while (!halted && cursor !== null && budget > 0 && !signal.aborted) {
        const next = cursor + 1
        if (next > tip) break

        const raw = await this.#blockAt(next, signal)
        // The tip moved under us, or a provider is serving a shorter chain than it advertised.
        // Neither is an error; the next tick asks again.
        if (!raw) break

        // Check two: the cheap forward check. `parent` is null on a cold start, which is the only
        // case in which a block is indexed without its predecessor being verified.
        const parent = await blockAtHeight(this.#d.sql, this.#d.scope, cursor)
        if (parent && parent.hash !== raw.parentHash) {
          if (reorgs.length >= MAX_REORGS_PER_TICK) break
          const outcome = await this.#handleReorg(cursor, signal)
          reorgs.push(outcome)
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
        // Partial progress is kept: every block committed its own transaction, so the checkpoint
        // is exactly as far as the rows go. This is the property that makes an outage mid-range a
        // pause rather than a gap.
        this.#d.logger.warn('provider became unavailable mid-tick', { ...this.#labels, err })
        providerUnavailable = true
      } else {
        throw err
      }
    }

    const confirmed = halted ? 0 : await this.#confirm(tip)

    const cursorNow = await this.#storedHeight()
    const lag = cursorNow === null ? tip : Math.max(0, tip - cursorNow)
    this.#d.metrics.set(LAG_BLOCKS, lag, this.#labels)

    return {
      blocksIndexed,
      tipHeight: tip,
      lag,
      reorgs,
      confirmed,
      halted,
      providerUnavailable,
    }
  }

  /**
   * Advance the oldest unfinished historical range.
   *
   * It runs on its own checkpoint stream and its own job lease, so it never blocks the follower —
   * that separation is the whole requirement. It also never runs the reorg machinery: history
   * below the tip is the follower's to correct, and a backfill that disagreed with stored history
   * would be racing it. If it does disagree, `blocks_canonical_height_uniq` raises 23505 and the
   * job fails loudly, which is the right outcome for "this range belongs to a different chain".
   */
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
    return hexToNumber(await this.#d.rpc.call<string>('eth_blockNumber', [], { signal }))
  }

  async #blockAt(height: number, signal: AbortSignal): Promise<RawBlock | null> {
    const raw = await this.#d.rpc.call<RawBlock | null>(
      'eth_getBlockByNumber',
      [toHexQuantity(height), true],
      { signal },
    )
    // A block with no hash is a block still being sealed. Indexing it would store a hash that
    // never becomes canonical and manufacture a reorg on the next pass.
    if (!raw || !raw.hash || !raw.number) return null
    return raw
  }

  /** Where the follower resumes. Null only when the chain has no blocks at all. */
  async #cursor(tip: number): Promise<number | null> {
    const checkpoint = await getCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM)
    if (checkpoint?.height !== null && checkpoint?.height !== undefined) return checkpoint.height
    const head = await headBlock(this.#d.sql, this.#d.scope)
    if (head) return head.height
    if (this.#d.startHeight !== undefined) return this.#d.startHeight - 1
    // Twice the confirmation depth is the smallest window in which a deposit can be watched
    // through its whole confirmation life without a backfill. Anything older is history, and
    // history is a backfill job — a cold start that walks five million blocks before it serves
    // anything is a service that is never ready.
    const window = requiredConfirmations(this.#d.scope.chain) * 2
    return Math.max(0, tip - window) - 1
  }

  async #storedHeight(): Promise<number | null> {
    const checkpoint = await getCheckpoint(this.#d.sql, this.#d.scope, TIP_STREAM)
    return checkpoint?.height ?? null
  }

  /**
   * Receipts for a whole block, preferring the batched method and remembering the answer.
   *
   * The capability is probed once and cached for the life of the process. Probing per block would
   * cost one wasted round trip per block against a provider that lacks the method, and never
   * probing would cost N round trips per block against every provider that has it.
   */
  async #receipts(raw: RawBlock, signal: AbortSignal): Promise<Map<string, RawReceipt>> {
    const out = new Map<string, RawReceipt>()
    const txs = raw.transactions ?? []
    if (txs.length === 0) return out

    if (this.#blockReceiptsSupported !== false) {
      try {
        const list = await this.#d.rpc.call<readonly RawReceipt[] | null>(
          'eth_getBlockReceipts',
          [toHexQuantity(hexToNumber(raw.number))],
          { signal },
        )
        if (list) {
          this.#blockReceiptsSupported = true
          for (const receipt of list) out.set(receipt.transactionHash.toLowerCase(), receipt)
          if (out.size > 0) return out
        }
      } catch (err) {
        // -32601 is "method not found". Anything else is a real failure and must not be swallowed
        // into a silent fallback that hides a broken provider behind N times the traffic.
        if (err instanceof RpcError && err.code === -32601) {
          this.#blockReceiptsSupported = false
          this.#d.logger.info('provider lacks eth_getBlockReceipts; using per-transaction receipts', {
            ...this.#labels,
          })
        } else {
          throw err
        }
      }
    }

    for (const tx of txs) {
      const receipt = await this.#d.rpc.call<RawReceipt | null>(
        'eth_getTransactionReceipt',
        [tx.hash],
        { signal },
      )
      if (receipt) out.set(receipt.transactionHash.toLowerCase(), receipt)
    }
    return out
  }

  /**
   * One block, one transaction.
   *
   * The block row, its transactions, its logs, its movements, the deposit events and the
   * checkpoint advance commit together or not at all. That is what makes a restart mid-range leave
   * neither a gap nor a duplicate, and it is why the checkpoint write lives here rather than in
   * the caller.
   */
  async #indexBlock(raw: RawBlock, stream: string, signal: AbortSignal): Promise<void> {
    const receipts = await this.#receipts(raw, signal)
    const asset = assetOf(this.#d.scope.chain)
    const extracted = extractBlock(raw, receipts, asset)
    const addresses = [...new Set(extracted.activity.map((a) => a.address))]

    let observed = 0
    await withOutbox(this.#d.sql, this.#d.producer, async (tx, emit) => {
      const watched = await filterWatched(tx, this.#d.scope, addresses)

      await upsertBlock(tx, this.#d.scope, extracted.block)
      for (const transaction of extracted.transactions) {
        await upsertTransaction(tx, this.#d.scope, transaction)
      }
      for (const log of extracted.logs) {
        await upsertLog(tx, this.#d.scope, log)
      }
      for (const movement of extracted.activity) {
        const { inserted } = await upsertActivity(tx, this.#d.scope, movement)
        this.#d.metrics.increment(ACTIVITY_TOTAL, {
          ...this.#labels,
          direction: movement.direction,
          asset_kind: movement.assetKind,
        })
        // Only a first sighting, only inbound, only a watched address. A re-index emits nothing,
        // which is the whole of "re-indexing a block must be a no-op, not a duplicate".
        if (!inserted || movement.direction !== 'in' || !watched.has(movement.address)) continue
        observed += 1
        emit({
          topic: DEPOSIT_OBSERVED,
          // Ordering is per (topic, key) only, so the key is the address: two movements on one
          // address stay in order, and two addresses do not serialise against each other.
          key: `${this.#d.scope.chain}:${this.#d.scope.network}:${movement.address}`,
          payload: this.#depositPayload(movement, extracted.block, null),
        })
      }
      await setCheckpoint(tx, this.#d.scope, stream, extracted.block.height, extracted.block.hash)
    })

    // Difficulty is published from the TIP STREAM ONLY (micro-org#363). A backfill walks history,
    // and history's difficulty is not the chain's difficulty — a backfill of the 2,000 blocks
    // EMBER spent pinned at 256 would hold the gauge at the floor while the live chain sat 32x
    // above it, which is the alert firing on a chain state that ended days ago.
    if (stream === TIP_STREAM) {
      const difficulty = difficultyGaugeValue(raw.difficulty)
      if (difficulty !== null) this.#d.metrics.set(DIFFICULTY, difficulty, this.#labels)
    }

    this.#d.metrics.increment(BLOCKS_INDEXED_TOTAL, { ...this.#labels, stream })
    this.#d.metrics.increment(
      TRANSACTIONS_INDEXED_TOTAL,
      this.#labels,
      extracted.transactions.length,
    )
    if (observed > 0) {
      this.#d.metrics.increment(DEPOSITS_OBSERVED_TOTAL, this.#labels, observed)
    }
  }

  /**
   * Walk back to the common ancestor, retract everything above it, and rewind.
   *
   * `forkHeight` is the highest stored height known or suspected to be wrong. The walk stops at
   * the first height where the stored hash and the chain's hash agree; that block is on both
   * histories and is therefore the ancestor.
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
        // Below our own history. Nothing at or under this height can be wrong because nothing at
        // or under it was ever recorded, so this is the boundary.
        ancestorHeight = height
        ancestorHash = ''
        break
      }
      const onChain = await this.#blockAt(height, signal)
      if (onChain && onChain.hash === stored.hash) {
        ancestorHeight = height
        ancestorHash = stored.hash
        break
      }
    }

    if (ancestorHeight < 0) {
      // Deeper than we will verify. Halting is the only honest answer: re-indexing from a height
      // we could not confirm is shared history would be inventing a chain.
      const reason = `reorg deeper than ${this.#maxReorgWalk} blocks below height ${forkHeight}`
      await haltChain(this.#d.sql, scope, reason)
      this.#d.metrics.set(CHAIN_HALTED, 1, this.#labels)
      throw new ReorgTooDeepError(scope, this.#maxReorgWalk)
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
   * The bound is computed here, from `contracts-chain`, and passed to SQL as a height — the depth
   * policy is never re-derived in a query, where it could not be unit tested and would silently
   * disagree with the three other services that read the same package. `creditable` is then
   * asserted per row, so the SQL bound and the pure function cannot drift without a test failing.
   */
  async #confirm(tip: number): Promise<number> {
    const required = requiredConfirmations(this.#d.scope.chain)
    const maxHeight = tip - required + 1
    if (maxHeight < 0) return 0

    return withOutbox(this.#d.sql, this.#d.producer, async (tx, emit) => {
      const pending = await pendingConfirmations(tx, this.#d.scope, maxHeight, this.#confirmBatch)
      const confirmedIds: string[] = []
      for (const movement of pending) {
        const confirmations = confirmationsAt(tip, movement.blockHeight)
        if (!creditable(this.#d.scope.chain, confirmations)) continue
        confirmedIds.push(movement.id)
        emit({
          topic: DEPOSIT_CONFIRMED,
          key: `${this.#d.scope.chain}:${this.#d.scope.network}:${movement.address}`,
          payload: this.#depositPayload(
            {
              address: movement.address,
              direction: movement.direction,
              assetCode: movement.assetCode,
              assetKind: movement.assetKind,
              tokenAddress: movement.tokenAddress,
              amount: movement.amount,
              txHash: movement.txHash,
              entryKey: '',
              logIndex: movement.logIndex,
              blockHeight: movement.blockHeight,
              blockHash: movement.blockHash,
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

  /**
   * The event payload.
   *
   * Amounts are decimal strings in smallest units. JSON has no integer type wide enough for a
   * uint256 and a float loses the low digits, which is where a reconciliation drift shows up.
   *
   * `txUrn` and `explorerUrl` come from `contracts-chain`, and they are the point: this is the
   * first place in the estate where a deposit event carries a reference a human can follow.
   */
  #depositPayload(
    movement: ActivityInput,
    block: BlockInput | null,
    confirmations: number | null,
  ): Record<string, unknown> {
    const asset = assetOf(this.#d.scope.chain)
    return {
      chain: this.#d.scope.chain,
      network: this.#d.scope.network,
      address: movement.address,
      direction: movement.direction,
      assetCode: movement.assetCode,
      assetKind: movement.assetKind,
      tokenAddress: movement.tokenAddress,
      amount: movement.amount.toString(),
      txHash: movement.txHash,
      txUrn: txUrn(asset, this.#d.scope.network, movement.txHash),
      explorerUrl: explorerTxUrl(asset, this.#d.scope.network, movement.txHash),
      logIndex: movement.logIndex,
      blockHeight: movement.blockHeight,
      blockHash: movement.blockHash,
      blockTime: block ? block.blockTime.toISOString() : null,
      confirmations,
      requiredConfirmations: requiredConfirmations(this.#d.scope.chain),
    }
  }
}
