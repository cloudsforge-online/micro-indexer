import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS, chainSpec } from '@cloudsforge/contracts-chain'
import {
  CHAIN_IDS,
  alarming,
  assetOf,
  confirmationsAt,
  creditable,
  declaredChainId,
  familyOf,
  isChainId,
  isNetwork,
  parseScope,
  requiredConfirmations,
  sameScope,
  scopeKey,
} from './chains.ts'

test('every chain slug maps to an on-chain asset, and SHARD is not one of them', () => {
  for (const chain of CHAIN_IDS) {
    const asset = assetOf(chain)
    assert.equal(asset.toLowerCase(), chain, `${chain} must be its asset code lowercased`)
    assert.ok(CHAINS[asset], `${asset} must exist in the pinned contract`)
  }
  assert.equal(isChainId('shard'), false, 'SHARD never exists on a chain')
  assert.equal(isChainId('doge'), false)
})

test('depths are read from the pinned contract and never restated here', () => {
  // If this file ever hardcodes a depth, this fails — which is the whole point of the pin.
  assert.equal(requiredConfirmations('ember'), chainSpec('EMBER').confirmations)
  assert.equal(requiredConfirmations('ember'), 60)
  assert.equal(requiredConfirmations('eth'), chainSpec('ETH').confirmations)
  assert.equal(requiredConfirmations('btc'), chainSpec('BTC').confirmations)
})

test('Hearth is 7411 on mainnet and 7412 on testnet; Bitcoin and XRP have no chain id', () => {
  assert.equal(declaredChainId('ember', 'mainnet'), 7411)
  assert.equal(declaredChainId('ember', 'testnet'), 7412)
  assert.equal(declaredChainId('btc', 'mainnet'), undefined)
  assert.equal(declaredChainId('xrp', 'testnet'), undefined)
})

test('the containing block is the first confirmation', () => {
  // The off-by-one forge-pay's sweepMaturityConfirmations carries a paragraph about. A block
  // mined at the tip has one confirmation, not zero.
  assert.equal(confirmationsAt(100, 100), 1)
  assert.equal(confirmationsAt(100, 99), 2)
  assert.equal(confirmationsAt(159, 100), 60)
  // Never negative: a block above a stale tip reads as zero, because a negative count passes
  // `>=` comparisons in the wrong direction.
  assert.equal(confirmationsAt(100, 105), 0)
})

test('creditability is exactly the pinned contract, at the boundary', () => {
  assert.equal(creditable('ember', 59), false)
  assert.equal(creditable('ember', 60), true)
  // A block at tip - 59 has 60 confirmations and is the first creditable one.
  assert.equal(creditable('ember', confirmationsAt(1_000, 941)), true)
  assert.equal(creditable('ember', confirmationsAt(1_000, 942)), false)
})

test('the alarm depth sits below the credit depth on every on-chain asset', () => {
  // This is the property that makes the reorg design safe: a reorg deep enough to retract a
  // CONFIRMED movement is always deep enough to have halted the chain first.
  for (const chain of CHAIN_IDS) {
    const spec = chainSpec(assetOf(chain))
    assert.ok(
      spec.reorgAlarmDepth <= spec.confirmations,
      `${chain} alarms at ${spec.reorgAlarmDepth} but credits at ${spec.confirmations}`,
    )
  }
  assert.equal(alarming('ember', 4), false)
  assert.equal(alarming('ember', 5), true)
  assert.equal(alarming('eth', 2), false)
  assert.equal(alarming('eth', 3), true)
})

test('families are read from the contract, and Hearth is served by the ember family', () => {
  assert.equal(familyOf('ember'), 'ember')
  assert.equal(familyOf('eth'), 'evm')
  assert.equal(familyOf('btc'), 'bitcoin')
})

test('a scope round-trips, and a malformed one is refused rather than guessed at', () => {
  assert.deepEqual(parseScope('ember:testnet'), { chain: 'ember', network: 'testnet' })
  assert.equal(scopeKey({ chain: 'ember', network: 'testnet' }), 'ember:testnet')
  assert.equal(parseScope('ember'), null)
  assert.equal(parseScope('ember:testnet:extra'), null)
  // The defect this scoping exists to prevent: a chain without a network is not a scope.
  assert.equal(parseScope('xrp'), null)
  assert.equal(parseScope('xrp:devnet'), null)
  assert.equal(isNetwork('devnet'), false)
})

/* ------------------------------------------- LTC: Bitcoin's family, its own numbers */

test('ltc is a chain this indexer follows, and it resolves to the LTC asset', () => {
  assert.ok(isChainId('ltc'))
  assert.equal(assetOf('ltc'), 'LTC')
  assert.ok(CHAIN_IDS.includes('ltc'))
})

test('ltc is served by the BITCOIN family, which is what saves a second worker', () => {
  // `index.ts` selects a worker by family. If this ever stops being 'bitcoin', Litecoin silently
  // falls through to the EVM worker rather than failing, so it is asserted rather than assumed.
  assert.equal(familyOf('ltc'), 'bitcoin')
  assert.equal(familyOf('ltc'), familyOf('btc'))
})

test('sharing Bitcoin\'s code must not mean sharing Bitcoin\'s depth', () => {
  // The exact mistake the family reuse invites. LTC's blocks are ~2.5 minutes against Bitcoin's
  // ~10, so an equal depth is a quarter of the work — these numbers must not converge.
  assert.equal(requiredConfirmations('ltc'), 12)
  assert.equal(requiredConfirmations('btc'), 6)
  assert.notEqual(requiredConfirmations('ltc'), requiredConfirmations('btc'))
})

test('ltc has no declared chain id, exactly like btc', () => {
  // A Bitcoin-family transaction carries no chain id; the network binding comes from the node's own
  // getblockchaininfo and from the WIF. A number appearing here would mean the spec had been given
  // an EVM-shaped binding it cannot enforce.
  assert.equal(declaredChainId('ltc', 'mainnet'), undefined)
  assert.equal(declaredChainId('ltc', 'testnet'), undefined)
})

test('an ltc scope parses on both networks and cannot span them', () => {
  assert.deepEqual(parseScope('ltc:mainnet'), { chain: 'ltc', network: 'mainnet' })
  assert.deepEqual(parseScope('ltc:testnet'), { chain: 'ltc', network: 'testnet' })
  assert.equal(scopeKey({ chain: 'ltc', network: 'mainnet' }), 'ltc:mainnet')
  assert.ok(!sameScope({ chain: 'ltc', network: 'mainnet' }, { chain: 'ltc', network: 'testnet' }))
  // The confusion that would actually cost money: LTC and BTC rows must never be one scope.
  assert.ok(!sameScope({ chain: 'ltc', network: 'mainnet' }, { chain: 'btc', network: 'mainnet' }))
})
