/**
 * The source backed by a Bitcoin Core or Litecoin Core daemon **we run ourselves**.
 *
 * ## What "native" means here, since the word has been used for two different things
 *
 * The owner refused *intermediate* access to a chain: no Blockstream, no Alchemy, no third party
 * between the estate and the ledger it credits from. A daemon running on the estate's own hardware,
 * reached over loopback, is not an intermediary — it is the most authoritative answer obtainable,
 * because it validates every block itself rather than believing anybody. So this source satisfies
 * the constraint completely, and it is strictly *stronger* than the light client that follows it:
 * a full node cannot be lied to about a deposit, and a compact-filter client can.
 *
 * What it is not is portable. The chain is hundreds of gigabytes and it does not follow the estate
 * to a VPS or a second environment. That is the whole reason `btclightsource.ts` exists, and the
 * reason this file is best understood as **the oracle that proves the light client correct** rather
 * than as the destination.
 *
 * ## Nothing here is new behaviour
 *
 * Every method is the code that was previously inline in `bitcoin.ts`, moved behind the seam
 * unchanged — the verbosity-3 probe, the prevout fallback, the "out of range is an answer" reading
 * of `getblockhash`. That is deliberate: the refactor that introduced the seam must not also change
 * what the follower does, or a regression in deposit detection would be indistinguishable from the
 * refactor. The only genuinely new method is `broadcast`, which had no caller before because this
 * service never sent anything.
 */

import type { Prevout, RawBtcBlock, RawBtcTx } from './bitcoin.ts'
import { addressOf, outpointKey } from './bitcoin.ts'
import type { ChainScope } from './chains.ts'
import { RpcError, RpcUnavailableError, type RpcPool } from './rpc.ts'
import type { ProviderHealthInput } from './store.ts'
import {
  SourceIdentityError,
  SourceUnavailableError,
  type BitcoinSource,
  type SourcedBlock,
  type WatchedSet,
} from './btcsource.ts'
import type { Logger } from '@cloudsforge/telemetry'

/** Core's error codes, as `bitcoin.ts` already named them. */
const RPC_INVALID_PARAMETER = -8
const RPC_INVALID_ADDRESS_OR_KEY = -5
const RPC_METHOD_NOT_FOUND = -32601
/** `sendrawtransaction` when the node already holds these exact bytes. A success, not a failure. */
const RPC_VERIFY_ALREADY_IN_CHAIN = -27
const RPC_TRANSACTION_ALREADY_IN_CHAIN = -5

/**
 * What `getblockchaininfo.chain` must say for each of the estate's two networks.
 *
 * `testnet` maps to a SET rather than a string, and that is not laziness. Bitcoin has four distinct
 * test networks and Core reports each by its own name; the estate's `Network` type has one value
 * for all of them. Accepting any of them means an operator may point `btc:testnet` at signet — the
 * right choice today, since testnet3 is unusable and testnet4 is young — without this check
 * refusing a correct configuration. What it still refuses, which is the only thing that matters, is
 * `main` appearing under `testnet` or the reverse.
 */
const EXPECTED_CHAIN: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  mainnet: new Set(['main']),
  testnet: new Set(['test', 'testnet4', 'signet', 'regtest']),
})

export interface NodeSourceDeps {
  readonly scope: ChainScope
  readonly rpc: RpcPool
  readonly logger: Logger
}

export function nodeSource(deps: NodeSourceDeps): BitcoinSource {
  // Probed once per process rather than per block. A node that lacks verbosity 3 then costs one
  // wasted round trip for the life of the process instead of one per block.
  let verbosityThree: boolean | undefined

  const call = async <T>(method: string, params: readonly unknown[], signal: AbortSignal): Promise<T> => {
    try {
      return await deps.rpc.call<T>(method, params, { signal })
    } catch (err) {
      if (err instanceof RpcUnavailableError) {
        throw new SourceUnavailableError(deps.scope, err.message)
      }
      throw err
    }
  }

  const blockByHash = async (
    hash: string,
    height: number,
    signal: AbortSignal,
  ): Promise<SourcedBlock | null> => {
    if (verbosityThree !== false) {
      try {
        const raw = await call<RawBtcBlock | null>('getblock', [hash, 3], signal)
        if (raw && raw.hash && raw.tx) {
          verbosityThree = true
          return { raw: withHeight(raw, height), complete: true }
        }
      } catch (err) {
        if (
          err instanceof RpcError &&
          (err.code === RPC_METHOD_NOT_FOUND || err.code === RPC_INVALID_PARAMETER || err.code === -1)
        ) {
          verbosityThree = false
          deps.logger.info('node does not serve getblock verbosity 3; resolving prevouts', {
            chain: deps.scope.chain,
            network: deps.scope.network,
          })
        } else if (err instanceof RpcError && err.code === RPC_INVALID_ADDRESS_OR_KEY) {
          return null
        } else {
          throw err
        }
      }
    }

    try {
      const raw = await call<RawBtcBlock | null>('getblock', [hash, 2], signal)
      return raw && raw.hash && raw.tx ? { raw: withHeight(raw, height), complete: true } : null
    } catch (err) {
      if (err instanceof RpcError && err.code === RPC_INVALID_ADDRESS_OR_KEY) return null
      throw err
    }
  }

  const hashAt = async (height: number, signal: AbortSignal): Promise<string | null> => {
    try {
      const hash = await call<string | null>('getblockhash', [height], signal)
      return hash && hash.length > 0 ? hash : null
    } catch (err) {
      // "out of range" is an answer — the chain is shorter than this — not a provider failing.
      if (err instanceof RpcError && err.code === RPC_INVALID_PARAMETER) return null
      throw err
    }
  }

  return {
    scope: deps.scope,
    kind: 'node',

    async verifyIdentity(signal) {
      const info = await call<{ chain?: string }>('getblockchaininfo', [], signal)
      const reported = info.chain ?? ''
      const allowed = EXPECTED_CHAIN[deps.scope.network]
      if (!allowed || !allowed.has(reported)) {
        throw new SourceIdentityError(deps.scope, reported || '(none)', [...(allowed ?? [])].join('/'))
      }
    },

    async tipHeight(signal) {
      return call<number>('getblockcount', [], signal)
    },

    hashAt,

    async blockAt(height, _watched: WatchedSet, signal) {
      // A node source ignores the watched set entirely and always returns the whole block. That is
      // not an oversight: it is what makes this source ground truth. It has already validated every
      // transaction, so filtering before returning would discard the very completeness that the
      // light client is going to be measured against.
      const hash = await hashAt(height, signal)
      if (!hash) return null
      return blockByHash(hash, height, signal)
    },

    async prevouts(raw, signal) {
      const resolved = new Map<string, Prevout>()

      // Outputs created earlier in the SAME block are resolved from the block and never fetched.
      // Asking the node for a transaction it has not finished connecting is how a correct block
      // reports unresolved inputs.
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
          funding = await call<RawBtcTx | null>('getrawtransaction', [txid, true], signal)
        } catch (err) {
          // A node without a transaction index cannot answer for a historical transaction, and the
          // estate's own nodes are configured `txindex=0` on purpose — the index costs 17 GB and a
          // great deal of write amplification to answer a question that only affects OUTBOUND
          // movement attribution. Deposits are unaffected: they are outputs, and outputs are in the
          // block. `unresolvedInputs` records the gap rather than guessing at it.
          if (err instanceof RpcError) {
            deps.logger.warn('a prevout could not be resolved; outbound movements are incomplete', {
              chain: deps.scope.chain,
              network: deps.scope.network,
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
    },

    async broadcast(rawTxHex, signal) {
      try {
        return await call<string>('sendrawtransaction', [rawTxHex], signal)
      } catch (err) {
        // Already known to this node — because we sent it before and crashed before recording the
        // txid, which `settlement`'s recovery path does deliberately. Re-deriving the txid from the
        // bytes we hold is the honest answer: the transaction IS on the chain, and reporting a
        // failure would make a landed payment look lost and invite a second one.
        if (
          err instanceof RpcError &&
          (err.code === RPC_VERIFY_ALREADY_IN_CHAIN || err.code === RPC_TRANSACTION_ALREADY_IN_CHAIN) &&
          /already in (the )?(block ?chain|mempool)|txn-already/i.test(err.message)
        ) {
          const known = await call<{ txid?: string }>('decoderawtransaction', [rawTxHex], signal)
          if (known.txid) return known.txid
        }
        throw err
      }
    },

    health(): readonly ProviderHealthInput[] {
      return deps.rpc.snapshot()
    },

    async close() {
      // Nothing to close: the RPC pool's HTTP clients are process-lived by design, so that a
      // provider this process already demoted is not tried first by the next caller.
    },
  }
}

/**
 * Core reports the height itself, but the caller asked for a specific one.
 *
 * They agree in every honest case. Preferring the caller's is what makes a node source and a light
 * source produce identical rows: the light source has no choice but to take the height from its own
 * validated header chain, and a differential harness comparing the two must not fail on a field
 * that merely came from a different place.
 */
function withHeight(raw: RawBtcBlock, height: number): RawBtcBlock {
  return raw.height === height ? raw : { ...raw, height }
}
