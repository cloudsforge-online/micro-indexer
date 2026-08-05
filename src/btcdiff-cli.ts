/**
 * Run the differential harness against a real, fully-validating node.
 *
 * ```
 * BTCDIFF_RPC_URL=http://user:pass@127.0.0.1:50002/ \
 *   node --import tsx src/btcdiff-cli.ts ltc mainnet 2000000 2001000
 * ```
 *
 * Exits **non-zero on the first disagreement**, printing the block, the field and both values.
 * That is deliberate and is the whole point: the failure this harness exists to catch — a filter
 * that silently omits a script — is invisible unless something refuses to continue past it.
 *
 * The URL carries the node's credentials, so it is read from the environment and **never logged**,
 * not even on failure. `hostOnly` is what any diagnostic prints.
 */

import { runRange, describeDisagreement, type NodeBlockAnswer } from './btcdiff.ts'
import { paramsFor, type BtcChain, type BtcNetwork } from './btcaddress.ts'

const [chainArg, networkArg, fromArg, toArg] = process.argv.slice(2)

if (!chainArg || !networkArg || !fromArg || !toArg) {
  console.error('usage: btcdiff-cli <btc|ltc> <mainnet|testnet> <fromHeight> <toHeight>')
  process.exit(2)
}
if (chainArg !== 'btc' && chainArg !== 'ltc') {
  console.error(`chain must be btc or ltc, got ${chainArg}`)
  process.exit(2)
}
if (networkArg !== 'mainnet' && networkArg !== 'testnet') {
  console.error(`network must be mainnet or testnet, got ${networkArg}`)
  process.exit(2)
}

const chain: BtcChain = chainArg
const network: BtcNetwork = networkArg
const from = Number(fromArg)
const to = Number(toArg)

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is not set`)
    process.exit(2)
  }
  return value
}

const url = requireEnv('BTCDIFF_RPC_URL')

/** The host, for diagnostics. An RPC URL's userinfo is a credential and never reaches a log. */
function hostOnly(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return 'unknown'
  }
}

const endpoint = new URL(url)
const auth = Buffer.from(`${endpoint.username}:${decodeURIComponent(endpoint.password)}`).toString(
  'base64',
)
endpoint.username = ''
endpoint.password = ''

let nextId = 1
async function call<T>(method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: nextId++, method, params }),
  })
  if (!response.ok) {
    throw new Error(`${method}: node at ${hostOnly(url)} answered HTTP ${response.status}`)
  }
  const body = (await response.json()) as { result?: T; error?: { message?: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'unknown RPC error'}`)
  return body.result as T
}

interface RawScriptPubKey {
  readonly hex: string
  readonly address?: string
  readonly addresses?: readonly string[]
}

/**
 * The address the node attributes to an output.
 *
 * Litecoin Core 0.21 predates Bitcoin Core 22.0's singular `address` and emits the plural
 * `addresses`. The plural is read only when it holds exactly ONE entry, because the plural form was
 * also used for bare multisig — and picking the first of several would credit one key holder for
 * coins that require several. `bitcoin.ts` makes the same choice for the same reason.
 */
function addressOf(spk: RawScriptPubKey): string | null {
  if (spk.address !== undefined) return spk.address
  const list = spk.addresses
  return list && list.length === 1 ? (list[0] as string) : null
}

interface VerboseBlock {
  readonly hash: string
  readonly height: number
  readonly previousblockhash: string
  readonly merkleroot: string
  readonly nTx: number
  readonly tx: readonly { readonly txid: string; readonly vout: readonly { readonly scriptPubKey: RawScriptPubKey }[] }[]
}

const filterHeaderCache = new Map<number, string>()

async function filterHeaderAt(height: number): Promise<string> {
  const cached = filterHeaderCache.get(height)
  if (cached !== undefined) return cached
  const hash = await call<string>('getblockhash', [height])
  const got = await call<{ header: string }>('getblockfilter', [hash, 'basic'])
  filterHeaderCache.set(height, got.header)
  return got.header
}

async function read(height: number): Promise<NodeBlockAnswer> {
  const hash = await call<string>('getblockhash', [height])
  const [verbose, raw, filter] = await Promise.all([
    call<VerboseBlock>('getblock', [hash, 2]),
    call<string>('getblock', [hash, 0]),
    call<{ filter: string; header: string }>('getblockfilter', [hash, 'basic']),
  ])
  const previousFilterHeader = await filterHeaderAt(height - 1)
  // Bounded: the cache only ever needs the immediately preceding height once the range is walking
  // forward, so it must not grow with the range length.
  filterHeaderCache.delete(height - 2)
  filterHeaderCache.set(height, filter.header)

  return {
    height,
    blockHash: hash,
    previousBlockHash: verbose.previousblockhash,
    merkleRoot: verbose.merkleroot,
    nTx: verbose.nTx,
    txids: verbose.tx.map((t) => t.txid),
    outputScripts: verbose.tx.flatMap((t) => t.vout.map((o) => o.scriptPubKey.hex)),
    outputAddresses: verbose.tx.flatMap((t) => t.vout.map((o) => addressOf(o.scriptPubKey))),
    rawBlock: raw,
    filter: filter.filter,
    filterHeader: filter.header,
    previousFilterHeader,
  }
}

const startedAt = Date.now()
console.log(`differential ${chain}:${network} ${from}..${to} against ${hostOnly(url)}`)

const result = await runRange(from, to, read, paramsFor(chain, network), (height, found) => {
  if ((height - from) % 250 === 0 && height !== from) {
    const rate = ((height - from) / ((Date.now() - startedAt) / 1000)).toFixed(1)
    console.log(`  ... height ${height}, ${rate} blocks/s, ${found} disagreement(s)`)
  }
})

if (result.disagreements.length > 0) {
  console.error(`\nFAILED: ${result.disagreements.length} disagreement(s) over ${result.blocksCompared} blocks`)
  for (const d of result.disagreements.slice(0, 50)) console.error(`  ${describeDisagreement(d)}`)
  if (result.disagreements.length > 50) {
    console.error(`  ... and ${result.disagreements.length - 50} more`)
  }
  process.exit(1)
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(
  `\nOK: ${result.blocksCompared} blocks, zero disagreements, ${seconds}s. ` +
    `Every txid, merkle root, output address and compact filter matched the node.`,
)
