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
