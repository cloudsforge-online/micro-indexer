/**
 * Chain identity, scoping, and the two derived numbers this service is allowed to compute.
 *
 * **Nothing in `@cloudsforge/contracts-chain` is redefined here.** Confirmation depths, reorg
 * alarm depths, decimals, chain ids and `isConfirmed` / `isReorgAlarming` are read from that
 * package and never restated, because the whole reason it is exact-pinned is that `wallet`,
 * `settlement`, `custody` and `indexer` disagreeing about a depth is money credited at the wrong
 * one. What this file adds is the indexer's own vocabulary: the URL-safe chain slug, the
 * `(chain, network)` scope that every query in this repository is forced to carry, and the
 * arithmetic that turns a stored height into a confirmation count.
 *
 * ## Why `ChainScope` is a type rather than two loose arguments
 *
 * 00-current-state §3.5 records a live defect: XRP has no network binding, so the same seed and
 * the same address exist on testnet and mainnet, and a signed Payment is submittable on either.
 * 04-domain-model §4.1 turns that into an invariant — every record carries `chain` and `network`
 * and no query may span networks. A scope object is how that invariant is made cheap to obey: a
 * store function that takes `ChainScope` cannot be called without deciding which network it means,
 * and `store.test.ts` asserts that every statement in `store.ts` filters on both columns.
 */

import {
  chainSpec,
  isConfirmed,
  isReorgAlarming,
  type AssetCode,
  type ChainFamily,
  type Network,
} from '@cloudsforge/contracts-chain'

/**
 * The URL-safe slug for a chain. It is the asset code lowercased, which is also what
 * `txUrn` uses, so a path segment and a cross-service URN cannot drift apart.
 *
 * `shard` is deliberately absent: SHARD is present in `CHAINS` only so that record is total, it
 * never exists on a chain, and an indexer that accepted it would be advertising an endpoint that
 * can only ever answer empty.
 *
 * `ltc` IS PRESENT AND NEEDS NO WORKER OF ITS OWN. Litecoin's spec carries `family: 'bitcoin'`, and
 * `index.ts` selects a worker by FAMILY, so `BitcoinWorker` follows it unchanged. That is not an
 * optimism about the two chains being similar — it is a statement about the seam actually used:
 * this repository reads Litecoin Core over the same JSON-RPC methods it reads Bitcoin Core with,
 * and it never encodes an address, only reads the one `scriptPubKey.address` the node emits. The
 * parts of Litecoin that genuinely differ — version bytes, the bech32 HRP, the WIF byte — are all
 * on the SIGNING side, and live in custody and settlement rather than here.
 *
 * The depth is not shared, only the code: `requiredConfirmations('ltc')` reads LTC's own 12 out of
 * `contracts-chain`, exactly as it reads Bitcoin's 6, because no number in this file is restated.
 */
export type ChainId = 'ember' | 'eth' | 'btc' | 'sol' | 'xrp' | 'ltc'

export const CHAIN_IDS: readonly ChainId[] = Object.freeze(['ember', 'eth', 'btc', 'sol', 'xrp', 'ltc'])

export const NETWORKS: readonly Network[] = Object.freeze(['mainnet', 'testnet'])

const ASSET_FOR_CHAIN: Readonly<Record<ChainId, AssetCode>> = Object.freeze({
  ember: 'EMBER',
  eth: 'ETH',
  btc: 'BTC',
  sol: 'SOL',
  xrp: 'XRP',
  ltc: 'LTC',
})

export function isChainId(value: string): value is ChainId {
  return (CHAIN_IDS as readonly string[]).includes(value)
}

export function isNetwork(value: string): value is Network {
  return (NETWORKS as readonly string[]).includes(value)
}

export function assetOf(chain: ChainId): AssetCode {
  return ASSET_FOR_CHAIN[chain]
}

export function familyOf(chain: ChainId): ChainFamily {
  return chainSpec(assetOf(chain)).family
}

/** Blocks (or ledgers) before a deposit may be credited. Read, never restated. */
export function requiredConfirmations(chain: ChainId): number {
  return chainSpec(assetOf(chain)).confirmations
}

/** The chain id a family with one publishes, per network. `undefined` for Bitcoin and XRP. */
export function declaredChainId(chain: ChainId, network: Network): number | undefined {
  return chainSpec(assetOf(chain)).chainId?.[network]
}

/** Is a deposit at this depth creditable? Delegates, so there is one answer in the estate. */
export function creditable(chain: ChainId, confirmations: number): boolean {
  return isConfirmed(assetOf(chain), confirmations)
}

/** Does a reorg of this depth halt the chain rather than merely being recorded? Delegates. */
export function alarming(chain: ChainId, depth: number): boolean {
  return isReorgAlarming(assetOf(chain), depth)
}

/**
 * Confirmations for a block at `blockHeight` given an observed tip.
 *
 * **The block that contains a transaction is its first confirmation**, so this is
 * `tip - height + 1` and not `tip - height`. The off-by-one is not cosmetic: forge-pay's
 * `chains.sweepMaturityConfirmations` carries a long comment about exactly this boundary, where
 * settling for `>= depth` instead of `>= depth + 1` left one block in which a sweep's funds were
 * counted on both sides of the arithmetic and the depositor was credited twice. One block is the
 * same bug as sixty.
 *
 * Clamped at zero so a block observed above a stale tip reads as zero rather than negative — a
 * negative confirmation count silently passes `>=` comparisons in the wrong direction.
 */
export function confirmationsAt(tipHeight: number, blockHeight: number): number {
  return Math.max(0, tipHeight - blockHeight + 1)
}

/**
 * The unit of work, of leasing, of checkpointing and of every query.
 *
 * There is no function in this repository that takes a chain without a network.
 */
export interface ChainScope {
  readonly chain: ChainId
  readonly network: Network
}

/** `ember:testnet`. The job lease key, the metric label pair, and the log field. */
export function scopeKey(scope: ChainScope): string {
  return `${scope.chain}:${scope.network}`
}

export function parseScope(value: string): ChainScope | null {
  const [chain, network, ...rest] = value.trim().toLowerCase().split(':')
  if (rest.length > 0) return null
  if (!chain || !network) return null
  if (!isChainId(chain) || !isNetwork(network)) return null
  return { chain, network }
}

export function sameScope(a: ChainScope, b: ChainScope): boolean {
  return a.chain === b.chain && a.network === b.network
}
