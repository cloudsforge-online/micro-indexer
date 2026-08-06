/**
 * A token's own state, read from the contract at a block this service has walked.
 *
 * ## Why this is here at all, when `reads.ts` is the read API
 *
 * Everything in `reads.ts` is a question about rows this service wrote: blocks, transactions, logs
 * and address movements. Supply and authorities are none of those. They are the contract's own
 * storage, and the only way to learn them is to ask the chain — `eth_call`.
 *
 * **That is a deliberate widening of what this service does, and it is recorded rather than
 * slipped in.** `micro-market`'s client argues, correctly, that token *facts* are not this
 * service's to serve: they are keyed by a `micro-mint` item URN this service has no registry for,
 * and they need holder history a follower that cold-starts at `tip − 2 × depth` does not have. None
 * of that applies here. This route is keyed by a **contract address**, needs **no registry**, needs
 * **no history**, and every field is one `eth_call` against one contract. What made token facts
 * un-serveable was the registry and the history, not the transport.
 *
 * The alternative was for `micro-mint` to read the chain itself, and AD-07 rules it out in one
 * line: incoming on-chain reality is this service's. A second service probing an RPC endpoint is a
 * second, disagreeing source of truth about the chain, and a project page would then be able to
 * show a supply the indexer would deny.
 *
 * ## Reorg safety: the HEAD, and then proof that the head is still the head
 *
 * `reads.ts` scopes the estate's rule: confirmations are counted against the stored canonical
 * **head** — what this service has actually walked and would have detected a reorg in — and never
 * against `checkpoints.tip_height`, which is only what a provider last claimed. `/confirmations`
 * (`reads.ts`) and `/token-balances` (`reads.ts`) follow it; `/activity`
 * (`reads.ts`) and `/transactions/:hash` (`reads.ts`) deliberately do not, because they
 * report a record rather than feed a decision.
 *
 * **This read follows the head, with the two head-based reads, and it is not a close call.** The
 * fields here are the inputs to `micro-mint`'s risk indicators — "can anybody still mint this",
 * "has the owner renounced", "is it paused" — which is a decision a buyer takes about money. A
 * state read at the provider's tip is a state read at blocks nobody here has looked at, which is
 * precisely what over-reports depth for a confirmation and, here, would report a supply from a
 * block this service could not have detected a reorg in.
 *
 * Counting against the head is not by itself enough, though, and this is the part that has no
 * equivalent in the two database reads. Those answer out of rows this service owns; this one asks a
 * third party a question about a height, and the third party may have a different block at that
 * height. So before any state is read, the node's block at the head height is fetched and its hash
 * is compared with the hash this service stored — the same check `evm.ts` makes first on every
 * follow tick (see its header, check 1). If they disagree, the node's chain is not the chain this
 * service walked and **no observation is returned at all**: `head_diverged` is an honest "ask me
 * again in a moment", and a supply figure attributed to a block we did not walk is not.
 *
 * EIP-1898 would let the block hash itself be the `eth_call` block parameter and make that check
 * atomic rather than a second round trip. It is not used because it is not universally implemented
 * by the providers this pool fails over between, and a read that works on one provider and 404s on
 * the next is a read whose answer depends on the weather.
 *
 * A **halted** chain is reported, not refused. `tokenBalances` refuses one (`reads.ts`)
 * because a balance derived from movements depends on the whole history the halt says cannot be
 * vouched for. This observation depends on exactly one block, and the hash check above has just
 * proved that block is on the node's canonical chain — so the halt is a fact that travels with the
 * answer rather than a reason to withhold it.
 */

import { familyOf, scopeKey, type ChainScope } from './chains.ts'
import type { Db } from './outbox.ts'
import { RpcError, RpcUnavailableError } from './rpc.ts'
import { TIP_STREAM, getCheckpoint, headBlock } from './store.ts'

/**
 * The four-byte selectors, as literals.
 *
 * Hardcoded with their preimages for the same reason `evm.ts` hardcodes `ERC20_TRANSFER_TOPIC`:
 * this repository has no keccak, and adding one to derive seven constants that can never change
 * would be a hash function on the path where a wrong answer is a wrong supply on a project page.
 * Each was computed from the signature in the comment.
 */
const SELECTORS = Object.freeze({
  /** keccak256("name()")[0:4] */
  name: '0x06fdde03',
  /** keccak256("symbol()")[0:4] */
  symbol: '0x95d89b41',
  /** keccak256("decimals()")[0:4] */
  decimals: '0x313ce567',
  /** keccak256("totalSupply()")[0:4] */
  totalSupply: '0x18160ddd',
  /** keccak256("cap()")[0:4] — ERC20Capped, which only the Foundry tier of ForgeMint has. */
  cap: '0x355274ea',
  /** keccak256("owner()")[0:4] — Ownable. Absent on a fixed-supply token. */
  owner: '0x8da5cb5b',
  /** keccak256("paused()")[0:4] — ERC20Pausable. */
  paused: '0x5c975abb',
})

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

/**
 * A cap on how much of a name or symbol is believed.
 *
 * A contract answers `symbol()` with whatever it likes, including a megabyte of it. Every consumer
 * of this route renders the value on a page, so an uncapped string is a denial of service one
 * hostile deployer can point at every service downstream of this one.
 */
const MAX_TEXT = 128

/**
 * One token as its contract reports it, at one block.
 *
 * Every field is an OBSERVATION and every one of them is nullable, because a null here means
 * something specific and useful: **the contract does not implement that function**. A fixed-supply
 * ForgeMint token has no `owner()`, no `cap()` and no `paused()`, and reporting `false` for those
 * would be inventing three facts. A null caused by an unreachable provider never gets this far —
 * that is `TokenStateUnavailableError`, and it is a 503.
 */
export interface TokenObservation {
  readonly chain: string
  readonly network: string
  readonly contractAddress: string
  readonly name: string | null
  readonly symbol: string | null
  readonly decimals: number | null
  /** Smallest units, as a decimal STRING. A JSON number does not survive 18 decimals. */
  readonly totalSupply: string | null
  /** The hard cap, where the contract has one. Null means uncapped OR not implemented. */
  readonly cap: string | null
  /** Whoever `owner()` returns now — the zero address once ownership is renounced. */
  readonly owner: string | null
  /** Whether anything can still increase the supply. See `mintAuthorityFrom` for the reasoning. */
  readonly mintAuthority: boolean | null
  readonly paused: boolean | null
  /** The stored canonical head the call was made at. The whole answer is as at this block. */
  readonly observedAtBlock: number
  /** The hash this service walked at that height, and proved the node still serves. */
  readonly observedAtBlockHash: string
  /** What a provider last claimed the tip was. Reported for staleness, never read against. */
  readonly tipHeight: number | null
  /** True when this service has stopped vouching for the chain after an alarming reorg. */
  readonly halted: boolean
}

export type TokenStateFault =
  | 'family_not_supported'
  | 'chain_not_followed'
  | 'nothing_indexed'
  | 'head_diverged'
  | 'rpc_unavailable'

/**
 * This service cannot make the observation right now, and says which of the five reasons applies.
 *
 * Never confused with "there is no token there", which is a 404 and a real answer. That split is
 * the defect `micro-market` spent an outage on: a caller that cannot tell "we could not ask" from
 * "we asked and the answer is no" will render the second when it means the first, for ever.
 */
export class TokenStateUnavailableError extends Error {
  readonly code: TokenStateFault
  constructor(code: TokenStateFault, message: string) {
    super(message)
    this.name = 'TokenStateUnavailableError'
    this.code = code
  }
}

/** The pool as this file needs it. An interface, so a test needs no socket. */
export interface RpcCaller {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>
}

export interface TokenObserver {
  /** Null means there is no observable token at that address, which is a 404 and an ANSWER. */
  observe(scope: ChainScope, address: string): Promise<TokenObservation | null>
}

export interface TokenObserverDeps {
  readonly sql: Db
  /** Keyed by `scopeKey`. A scope with no caller is a chain this replica does not follow. */
  readonly callers: ReadonlyMap<string, RpcCaller>
}

export function rpcTokenObserver(deps: TokenObserverDeps): TokenObserver {
  return {
    async observe(scope, address) {
      const family = familyOf(scope.chain)
      if (family !== 'evm' && family !== 'ember') {
        throw new TokenStateUnavailableError(
          'family_not_supported',
          `${family} contract state is not readable by this build`,
        )
      }
      const caller = deps.callers.get(scopeKey(scope))
      if (!caller) {
        // Not 404: the chain exists and the estate runs it, this replica just has no provider for
        // it. Answering "no such token" would be this service's own configuration reported as a
        // fact about somebody's contract.
        throw new TokenStateUnavailableError(
          'chain_not_followed',
          `this replica follows no provider for ${scopeKey(scope)}`,
        )
      }

      const [head, checkpoint] = await Promise.all([
        headBlock(deps.sql, scope),
        getCheckpoint(deps.sql, scope, TIP_STREAM),
      ])
      if (!head) {
        throw new TokenStateUnavailableError(
          'nothing_indexed',
          'no canonical block has been walked for this chain yet',
        )
      }

      const at = toBlockParam(head.height)
      const block = await unwrap(caller.call<{ hash?: string } | null>('eth_getBlockByNumber', [at, false]))
      const served = typeof block?.hash === 'string' ? block.hash.toLowerCase() : null
      if (served === null || served !== head.hash.toLowerCase()) {
        throw new TokenStateUnavailableError(
          'head_diverged',
          `the provider serves ${served ?? 'no block'} at height ${head.height}; this service walked ${head.hash}`,
        )
      }

      // No code at the address, at THIS block, is a real answer: either nothing was ever deployed
      // there, or the deployment is in a block above the head this service has walked. Both render
      // as "not yet observed" and both are true.
      const code = await unwrap(caller.call<string>('eth_getCode', [address, at]))
      if (!hasCode(code)) return null

      // `totalSupply()` is the probe for "is this a token at all". A contract that will not answer
      // it is not one this route can describe, and describing it anyway with eight nulls would be
      // an observation of nothing dressed up as an observation.
      const totalSupplyRaw = await callOrNull(caller, address, SELECTORS.totalSupply, at)
      const totalSupply = totalSupplyRaw === null ? null : decodeUint(totalSupplyRaw)
      if (totalSupply === null) return null

      const [nameRaw, symbolRaw, decimalsRaw, capRaw, ownerRaw, pausedRaw] = await Promise.all([
        callOrNull(caller, address, SELECTORS.name, at),
        callOrNull(caller, address, SELECTORS.symbol, at),
        callOrNull(caller, address, SELECTORS.decimals, at),
        callOrNull(caller, address, SELECTORS.cap, at),
        callOrNull(caller, address, SELECTORS.owner, at),
        callOrNull(caller, address, SELECTORS.paused, at),
      ])

      const cap = capRaw === null ? null : decodeUint(capRaw)
      const owner = ownerRaw === null ? null : decodeAddress(ownerRaw)

      return {
        chain: scope.chain,
        network: scope.network,
        contractAddress: address,
        name: nameRaw === null ? null : decodeText(nameRaw),
        symbol: symbolRaw === null ? null : decodeText(symbolRaw),
        decimals: decimalsRaw === null ? null : decodeDecimals(decimalsRaw),
        totalSupply,
        cap,
        owner,
        mintAuthority: mintAuthorityFrom({ owner, cap, totalSupply }),
        paused: pausedRaw === null ? null : decodeBool(pausedRaw),
        observedAtBlock: head.height,
        observedAtBlockHash: head.hash,
        tipHeight: checkpoint?.tipHeight ?? null,
        halted: checkpoint?.halted ?? false,
      }
    },
  }
}

/**
 * Whether anything can still increase the supply, from what the contract was willing to say.
 *
 * The three answers mean three different things and the middle one is the one that matters:
 *
 *   `null`   the contract has no `owner()`. **Not "nobody can mint".** An absent `Ownable` is not
 *            proof that no function anywhere increases the supply, and this service cannot see a
 *            function it has not been told to call. A missing value stays missing.
 *   `false`  ownership is renounced, so `onlyOwner` can never be satisfied again — or the hard cap
 *            has been reached, at which point `ERC20Capped._update` reverts every further mint.
 *   `true`   there is a live owner and headroom under any cap.
 *
 * **The error direction is chosen, not accidental.** A contract with an owner but no mint function
 * is reported `true` here, which is wrong and which is the safe wrong: it makes a buyer more
 * careful. The opposite mistake — telling somebody nobody can mint, when somebody can — is the one
 * that costs them money, and no input this function has could produce it.
 */
export function mintAuthorityFrom(state: {
  owner: string | null
  cap: string | null
  totalSupply: string | null
}): boolean | null {
  if (state.owner === null) return null
  if (state.owner.toLowerCase() === ZERO_ADDRESS) return false
  if (state.cap !== null && state.totalSupply !== null) {
    if (BigInt(state.totalSupply) >= BigInt(state.cap)) return false
  }
  return true
}

/* ------------------------------------------------------------------ the wire */

/** A height as `eth_call`'s block parameter. Hex, no leading zeros — `0x0` for genesis. */
export function toBlockParam(height: number): string {
  return `0x${height.toString(16)}`
}

/** `0x` and `0x0` are both "no code here"; anything longer is a deployed contract. */
export function hasCode(code: unknown): boolean {
  if (typeof code !== 'string') return false
  const body = code.startsWith('0x') ? code.slice(2) : code
  return body.length > 0 && /[1-9a-fA-F]/.test(body)
}

/**
 * One `eth_call`, where "the contract does not implement this" is null rather than an error.
 *
 * A call to a selector a contract does not have either reverts or falls through to a fallback that
 * returns nothing, and providers report the two differently — some as a JSON-RPC error, some as an
 * empty `0x` result. Both are the same fact, and both are null.
 *
 * `RpcUnavailableError` is emphatically NOT that fact: it means nobody answered, and collapsing it
 * into "the contract has no owner" would render a token as having renounced ownership because a
 * provider was rate-limiting us.
 */
async function callOrNull(
  caller: RpcCaller,
  to: string,
  selector: string,
  at: string,
): Promise<string | null> {
  try {
    const result = await caller.call<string>('eth_call', [{ to, data: selector }, at])
    if (typeof result !== 'string') return null
    const body = result.startsWith('0x') ? result.slice(2) : result
    return body.length === 0 ? null : result
  } catch (err) {
    if (err instanceof RpcUnavailableError) {
      throw new TokenStateUnavailableError('rpc_unavailable', err.message)
    }
    if (err instanceof RpcError) return null
    throw err
  }
}

/** The same unavailability mapping, for the two calls whose absence is never an answer. */
async function unwrap<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (err) {
    if (err instanceof RpcUnavailableError || err instanceof RpcError) {
      throw new TokenStateUnavailableError('rpc_unavailable', err.message)
    }
    throw err
  }
}

/* ------------------------------------------------------------------ ABI decoding */

function words(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex
}

function wordAt(hex: string, index: number): string | null {
  const body = words(hex)
  const start = index * 64
  if (body.length < start + 64) return null
  return body.slice(start, start + 64)
}

/** A `uint256` as a decimal string. Null when the answer is not one word wide. */
export function decodeUint(hex: string): string | null {
  const word = wordAt(hex, 0)
  if (word === null || !/^[0-9a-fA-F]{64}$/.test(word)) return null
  return BigInt(`0x${word}`).toString(10)
}

/** A `uint8`. Anything above 255 is not a decimals and is refused rather than truncated. */
export function decodeDecimals(hex: string): number | null {
  const decimal = decodeUint(hex)
  if (decimal === null) return null
  const value = Number(decimal)
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : null
}

/** An `address`, lower-cased. Null unless the top twelve bytes are zero, as ABI encoding requires. */
export function decodeAddress(hex: string): string | null {
  const word = wordAt(hex, 0)
  if (word === null || !/^[0-9a-fA-F]{64}$/.test(word)) return null
  if (!/^0{24}/.test(word)) return null
  return `0x${word.slice(24).toLowerCase()}`
}

/** A `bool`. Only the canonical 0 and 1 encodings; anything else is not an answer. */
export function decodeBool(hex: string): boolean | null {
  const word = wordAt(hex, 0)
  if (word === null) return null
  if (/^0{64}$/.test(word)) return false
  if (/^0{63}1$/.test(word)) return true
  return null
}

/**
 * A `string`, or the `bytes32` some older tokens return instead.
 *
 * Both spellings are in the wild — MakerDAO's own token answers `symbol()` with a `bytes32` — and a
 * decoder that knew only the dynamic form would render a blank symbol for them. Bounded at
 * `MAX_TEXT`, and control characters are stripped, because this value is rendered on a page by
 * every consumer of this route.
 */
export function decodeText(hex: string): string | null {
  const body = words(hex)
  if (body.length === 64) return clean(fromHex(body))

  const offsetWord = wordAt(hex, 0)
  if (offsetWord === null) return null
  const offset = Number(BigInt(`0x${offsetWord}`))
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0) return null
  const lengthWord = body.slice(offset * 2, offset * 2 + 64)
  if (lengthWord.length !== 64) return null
  const length = Number(BigInt(`0x${lengthWord}`))
  if (!Number.isSafeInteger(length) || length < 0) return null
  const start = offset * 2 + 64
  const taken = body.slice(start, start + Math.min(length, MAX_TEXT * 4) * 2)
  if (taken.length < Math.min(length, MAX_TEXT) * 2) return null
  return clean(fromHex(taken))
}

function fromHex(hex: string): string {
  const even = hex.length % 2 === 0 ? hex : hex.slice(0, hex.length - 1)
  return Buffer.from(even, 'hex').toString('utf8')
}

/**
 * NUL padding is how a `bytes32` name is carried; control characters in a rendered name are either
 * a decoding mistake or an attempt at one, and this value reaches a page in three frontends.
 */
function clean(text: string): string | null {
  const stripped = text.replace(/[\u0000-\u001f\u007f]/gu, '')
  const capped = stripped.slice(0, MAX_TEXT).trim()
  return capped.length === 0 ? null : capped
}
