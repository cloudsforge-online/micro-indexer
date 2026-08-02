/**
 * The one interface every chain family implements.
 *
 * AD-07 chose one service with five worker *modules* over five services, because "five services
 * with one normalised output is five deployment units, five sets of retry logic and five reorg
 * implementations". That argument only pays off if the modules genuinely share a shape, so the
 * shape is declared here and the differences are pushed into the implementations rather than into
 * the callers: `jobs.ts` does not know which family it is driving, and neither does the read API.
 *
 * Four capabilities, and nothing else:
 *
 *   - `verifyIdentity` — the endpoint is the chain we think it is. Cheap, and it runs before the
 *     first block is indexed, because indexing Sepolia into the rows labelled `ember:testnet` is a
 *     mistake that is silent for as long as nobody looks.
 *   - `follow`         — advance towards the tip, detect and repair reorgs, report confirmations.
 *   - `backfill`       — index a historical range, on its own checkpoint and its own lease.
 *   - `persistHealth`  — write the provider snapshot down.
 *
 * There is no `credit`, no `balance` and no `sweep`. **The indexer never holds a private key and
 * never decides a credit.** It reports what the chain says.
 */

import type { ChainFamily } from '@cloudsforge/contracts-chain'
import type { ChainScope } from './chains.ts'

export interface ReorgOutcome {
  readonly depth: number
  readonly commonAncestorHeight: number
  readonly previousTipHeight: number
  readonly alarming: boolean
  readonly orphanedBlocks: number
  readonly orphanedTransactions: number
  readonly orphanedActivity: number
}

export interface FollowOutcome {
  readonly blocksIndexed: number
  /** Null when no provider answered this tick — the lag gauge must not be reset to a guess. */
  readonly tipHeight: number | null
  readonly lag: number | null
  readonly reorgs: readonly ReorgOutcome[]
  readonly confirmed: number
  readonly halted: boolean
  readonly providerUnavailable: boolean
}

export interface BackfillOutcome {
  readonly stream: string | null
  readonly blocksIndexed: number
  readonly complete: boolean
  readonly providerUnavailable: boolean
}

export interface ChainWorker {
  readonly scope: ChainScope
  readonly family: ChainFamily
  verifyIdentity(signal: AbortSignal): Promise<void>
  follow(signal: AbortSignal): Promise<FollowOutcome>
  backfill(signal: AbortSignal): Promise<BackfillOutcome>
  persistHealth(): Promise<void>
}

/**
 * Raised by a family that is declared but not built.
 *
 * It names the phase rather than saying "TODO", because a stub whose deadline is written down is a
 * decision and a stub whose deadline is not is an omission. All three land in **phase P5, backlog
 * item EPC-14** — the same item that funds this service. The EVM worker ships first because Hearth
 * is the estate's own chain, it is the one family already running locally against a real node, and
 * it is the family whose reorg behaviour the other four are modelled on.
 */
export class NotImplementedError extends Error {
  readonly family: ChainFamily
  readonly capability: string
  readonly phase: string

  constructor(family: ChainFamily, capability: string, phase: string, note: string) {
    super(`${family}.${capability} is not implemented — it lands in ${phase}. ${note}`)
    this.name = 'NotImplementedError'
    this.family = family
    this.capability = capability
    this.phase = phase
  }
}

export const STUB_PHASE = 'phase P5 (EPC-14)'

/**
 * What each family has to do differently.
 *
 * This is not decoration. It is the domain knowledge in forge-pay's `chains.ts` — which this
 * service supersedes and which will be deleted — written where the person who builds the worker
 * will read it. Losing it costs the same three bugs a second time.
 *
 * A family whose worker now exists keeps its note rather than having it replaced with "Built.":
 * the note is *why* the worker looks the way it does, and it is the thing a reviewer needs when
 * asking whether a change to `bitcoin.ts` or `solana.ts` is still correct. Only the families still
 * served by `stubWorker` are read from here at runtime.
 */
export const FAMILY_NOTES: Readonly<Record<ChainFamily, string>> = Object.freeze({
  evm: 'Built — evm.ts.',
  ember:
    'Served by the EVM worker: Hearth exposes Ethereum JSON-RPC on 8545 with chain id 7411 ' +
    'mainnet and 7412 testnet, and a confirmation depth of 60 rather than 12.',
  bitcoin:
    'Built — bitcoin.ts. UTXO, not accounts: address activity is per output, and a transaction ' +
    'credits an address once per output paying it rather than once. Esplora chain_stats is a ' +
    'CUMULATIVE received counter unaffected by spending, so the reorg repair cannot simply ' +
    're-read a balance — it walks to a common ancestor instead. Confirmations count the mining ' +
    'block as the first. The case with no EVM analogue is replace-by-fee: an orphaned ' +
    'transaction whose outpoints the winning chain has spent can never be re-mined, so it is ' +
    'marked conflicted rather than merely orphaned. See spent_outpoints in migration 5.',
  solana:
    'Built — solana.ts. Slots, not heights, and slots can be skipped — a missing slot is normal ' +
    'and must not be read as a gap, so the follower enumerates with getBlocks rather than ' +
    'counting. The parent is parentSlot, which is usually not slot − 1. The finalized commitment ' +
    'is the chain’s own final view rather than a lagged one, so a fork below it does not occur ' +
    'and is halted rather than repaired if it appears to; above it a fork is ordinary at any ' +
    'slot distance. Crediting requires finality AND the declared depth of 32, never either alone.',
  xrp:
    'Validated ledgers, and one confirmation. Two traps: an account carries a BASE RESERVE, so ' +
    'its balance is not its received total and never was; and XRP has no network binding in the ' +
    'estate today (00-current-state §3.5) — the same address exists on testnet and ' +
    'mainnet. That defect is exactly what this schema’s (chain, network) scoping prevents, ' +
    'and the XRP worker is where it must not be reintroduced.',
})

/**
 * A worker that refuses, loudly and specifically.
 *
 * It is a real object implementing the real interface rather than an absent map entry, so the
 * composition root, the job registration and the read API all exercise the same code path for
 * every family. A family that is missing from a map fails as `undefined is not a function` at the
 * first tick; a family that is present and refuses fails with the phase it is waiting on.
 */
export function stubWorker(scope: ChainScope, family: ChainFamily): ChainWorker {
  const refuse = (capability: string): never => {
    throw new NotImplementedError(family, capability, STUB_PHASE, FAMILY_NOTES[family])
  }
  return {
    scope,
    family,
    verifyIdentity: async () => refuse('verifyIdentity'),
    follow: async () => refuse('follow'),
    backfill: async () => refuse('backfill'),
    persistHealth: async () => refuse('persistHealth'),
  }
}
