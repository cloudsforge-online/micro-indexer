/**
 * The differential harness: our protocol stack against a fully-validating node, block for block.
 *
 * ## Why this exists and what it is worth
 *
 * A BIP157 light client's characteristic failure is **silence**. A peer that leaves a script out of
 * a filter produces a filter that is well-formed, decodes cleanly, and hides a deposit — and no
 * block header commits to a filter, because BIP157 declined to add one rather than require a
 * consensus change. So the client cannot tell, on its own, that it has been lied to. Normally you
 * find out when a user asks where their money went.
 *
 * The estate happens to own the one thing that removes this: a node that validated every block
 * itself. Run both over the same range and every disagreement becomes a **failing assertion**
 * instead of a lost deposit. That is the whole argument for having synced the node at all — not to
 * serve deposits forever, but to be the oracle that makes the portable client trustworthy.
 *
 * ## What is compared, and why each one
 *
 * Every check below corresponds to a way a deposit can be silently lost or invented:
 *
 *   - **txids** — if our decoder disagrees with Core about a transaction's identity, we file the
 *     deposit under a hash no explorer and no other service in the estate can find.
 *   - **merkle root** — the binding between the amounts and the proof of work. If ours differs
 *     from Core's, our decode is not the block the miners signed.
 *   - **addresses, for every output** — a wrong version byte is not an error, it is a valid-looking
 *     address on the wrong chain, and it silently fails to match the address a user was given.
 *   - **the filter contains every output script** — the check that catches an omission, which is
 *     the failure that costs a user money.
 *   - **the filter header chain** — BIP157's whole authentication. If our arithmetic is wrong,
 *     honest peers appear to disagree and the client bans the network.
 *   - **every paid address matches the filter** — the end-to-end question: had this address been
 *     watched, would this block have been downloaded at all?
 *
 * ## Loudness is the point
 *
 * `runRange` accumulates disagreements and returns them; the CLI exits non-zero on the first
 * non-empty result and names the block, the field and both values. A harness that logged a warning
 * and carried on would be a harness whose failures are discovered in the same way the bug it exists
 * to catch would be — by a user, later.
 */

import { CompactFilter, verifyOutputScripts } from './btcgcs.ts'
import { decodeBlock } from './btcblock.ts'
import { addressToScript, AddressError, paramsFor, type AddressParams } from './btcaddress.ts'
import { filterHash, filterHeader } from './btcwire.ts'

/** One thing the two sides said differently. Carries both values; a bare "mismatch" is useless. */
export interface Disagreement {
  readonly height: number
  readonly blockHash: string
  readonly field: string
  readonly ours: string
  readonly theirs: string
  readonly detail?: string
}

/**
 * What the node said about one block. Exactly the fields the comparison needs.
 *
 * `outputAddresses` is nullable per entry on purpose: Core answers null for an OP_RETURN and for a
 * bare multisig, and so must we. An implementation that invented an address for either would be
 * attributing money to somebody who cannot spend it.
 */
export interface NodeBlockAnswer {
  readonly height: number
  readonly blockHash: string
  readonly previousBlockHash: string
  readonly merkleRoot: string
  readonly nTx: number
  readonly txids: readonly string[]
  readonly outputScripts: readonly string[]
  readonly outputAddresses: readonly (string | null)[]
  /** Raw block, hex. The bytes our decoder is given; everything else is what it must reproduce. */
  readonly rawBlock: string
  /** Serialised BIP158 basic filter, hex. */
  readonly filter: string
  readonly filterHeader: string
  readonly previousFilterHeader: string
}

/**
 * Compare one block. Pure, so the whole harness is testable without a node.
 *
 * Returns every disagreement rather than the first: knowing that the txids matched but the
 * addresses did not is a completely different diagnosis from both failing, and stopping at the
 * first would hide the difference.
 */
export function differentialBlock(
  answer: NodeBlockAnswer,
  params: AddressParams,
): readonly Disagreement[] {
  const out: Disagreement[] = []
  const at = (field: string, ours: string, theirs: string, detail?: string): void => {
    out.push({
      height: answer.height,
      blockHash: answer.blockHash,
      field,
      ours,
      theirs,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  // ---- the block decoder against Core's own reading of the same bytes
  let decoded: ReturnType<typeof decodeBlock>
  try {
    decoded = decodeBlock(
      Buffer.from(answer.rawBlock, 'hex'),
      { hash: answer.blockHash, height: answer.height },
      params,
    )
  } catch (err) {
    at('decode', err instanceof Error ? err.message : String(err), 'decoded cleanly')
    return out
  }

  if (decoded.raw.merkleroot !== answer.merkleRoot) {
    at('merkleRoot', decoded.raw.merkleroot ?? '(none)', answer.merkleRoot)
  }
  if (decoded.raw.previousblockhash !== answer.previousBlockHash) {
    at('previousBlockHash', decoded.raw.previousblockhash ?? '(none)', answer.previousBlockHash)
  }
  if (decoded.raw.tx.length !== answer.nTx) {
    at('nTx', String(decoded.raw.tx.length), String(answer.nTx))
  }

  const ourTxids = decoded.raw.tx.map((t) => t.txid)
  for (let i = 0; i < Math.max(ourTxids.length, answer.txids.length); i++) {
    const ours = ourTxids[i] ?? '(absent)'
    const theirs = answer.txids[i] ?? '(absent)'
    if (ours !== theirs) at('txid', ours, theirs, `index ${i}`)
  }

  const ourAddresses = decoded.raw.tx.flatMap((t) =>
    t.vout.map((o) => o.scriptPubKey?.address ?? null),
  )
  for (let i = 0; i < Math.max(ourAddresses.length, answer.outputAddresses.length); i++) {
    const ours = ourAddresses[i] ?? null
    const theirs = answer.outputAddresses[i] ?? null
    if (ours !== theirs) {
      at('outputAddress', ours ?? '(null)', theirs ?? '(null)', `output ${i}`)
    }
  }

  // ---- BIP158, against the filter the node itself computed
  const serialised = Buffer.from(answer.filter, 'hex')
  const chained = filterHeader(filterHash(serialised), answer.previousFilterHeader)
  if (chained !== answer.filterHeader) {
    at('filterHeader', chained, answer.filterHeader)
  }

  let filter: CompactFilter
  try {
    filter = CompactFilter.decode(answer.blockHash, serialised)
  } catch (err) {
    at('filterDecode', err instanceof Error ? err.message : String(err), 'decoded cleanly')
    return out
  }

  const scripts = answer.outputScripts.map((hex) => Buffer.from(hex, 'hex'))
  const audit = verifyOutputScripts(filter, scripts)
  if (!audit.ok) {
    // The one that would cost a user money. A script the block paid but the filter omits is a
    // block a light client would never download, for a deposit it would never report.
    at('filterOmission', `${audit.missing} script(s) absent from the filter`, 'all present')
  }

  // ---- the end-to-end question: would this block have been fetched at all?
  for (const address of new Set(answer.outputAddresses.filter((a): a is string => a !== null))) {
    let script: Buffer
    try {
      script = addressToScript(address, params).script
    } catch (err) {
      // An address Core produced that we cannot turn back into a script is a watch we could never
      // have registered — exactly as bad as a missed filter match, and reported as loudly.
      at(
        'addressNotWatchable',
        err instanceof AddressError ? err.reason : String(err),
        'round-trips to a script',
        address,
      )
      continue
    }
    if (!filter.matchAny([script])) {
      at('filterMiss', 'no match', 'paid in this block', address)
    }
  }

  return out
}

export type BlockAnswerReader = (height: number) => Promise<NodeBlockAnswer>

export interface RangeResult {
  readonly from: number
  readonly to: number
  readonly blocksCompared: number
  readonly disagreements: readonly Disagreement[]
}

/**
 * Compare a contiguous range.
 *
 * Contiguous, and not a sample. The filter header chain is only meaningful as a chain — checking
 * isolated blocks verifies the hash of each filter but never that they link, and linking is the
 * property a peer has to defeat in order to lie consistently.
 *
 * `onProgress` exists so a long run over tens of thousands of blocks is visibly alive. It does not
 * decide anything.
 */
export async function runRange(
  from: number,
  to: number,
  read: BlockAnswerReader,
  params: AddressParams,
  onProgress?: (height: number, disagreements: number) => void,
): Promise<RangeResult> {
  if (to < from) throw new RangeError(`range ${from}..${to} runs backwards`)
  const disagreements: Disagreement[] = []
  let compared = 0

  let expectedPreviousFilterHeader: string | null = null
  for (let height = from; height <= to; height++) {
    const answer = await read(height)

    // Chain continuity across the range, which a per-block check cannot see: the previous block's
    // filter header must be the one this block claims to build on. A peer that rewrote history
    // mid-range has to break this to stay self-consistent.
    if (
      expectedPreviousFilterHeader !== null &&
      answer.previousFilterHeader !== expectedPreviousFilterHeader
    ) {
      disagreements.push({
        height,
        blockHash: answer.blockHash,
        field: 'filterHeaderChain',
        ours: expectedPreviousFilterHeader,
        theirs: answer.previousFilterHeader,
        detail: 'the filter header chain is broken between consecutive blocks',
      })
    }
    expectedPreviousFilterHeader = answer.filterHeader

    disagreements.push(...differentialBlock(answer, params))
    compared += 1
    onProgress?.(height, disagreements.length)
  }

  return { from, to, blocksCompared: compared, disagreements }
}

/** Formats a disagreement for an operator. One line, both values, never just "mismatch". */
export function describeDisagreement(d: Disagreement): string {
  const where = d.detail ? ` (${d.detail})` : ''
  return `height ${d.height} ${d.blockHash} ${d.field}${where}: ours=${d.ours} node=${d.theirs}`
}

export { paramsFor }
