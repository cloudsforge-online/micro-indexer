import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAMILY_NOTES, NotImplementedError, STUB_PHASE, stubWorker } from './worker.ts'

const SCOPE = { chain: 'btc', network: 'testnet' } as const

test('a stubbed family refuses every capability, and names the phase it lands in', async () => {
  const worker = stubWorker(SCOPE, 'bitcoin')
  for (const capability of ['verifyIdentity', 'follow', 'backfill', 'persistHealth'] as const) {
    await assert.rejects(
      async () => {
        // The signature differs per method but none of them read the argument before refusing.
        await (worker[capability] as (signal: AbortSignal) => Promise<unknown>)(
          new AbortController().signal,
        )
      },
      (err: unknown) => {
        assert.ok(err instanceof NotImplementedError, `${capability} threw the wrong type`)
        assert.equal(err.family, 'bitcoin')
        assert.equal(err.capability, capability)
        assert.equal(err.phase, STUB_PHASE)
        return true
      },
    )
  }
})

test('the stub is a real object on the real interface, not an absent map entry', () => {
  // An absent entry fails as "undefined is not a function" on the first tick. A stub fails with
  // the family, the capability and the phase — which is the difference at three in the morning.
  const worker = stubWorker(SCOPE, 'xrp')
  assert.equal(worker.family, 'xrp')
  assert.deepEqual(worker.scope, SCOPE)
  assert.equal(typeof worker.follow, 'function')
})

test('each family carries the domain knowledge its worker needed', () => {
  // These notes are forge-pay chains.ts distilled. Losing them costs the same three bugs twice.
  // They are kept after a worker is built, because they are the reason it looks the way it does.
  assert.match(FAMILY_NOTES.bitcoin, /UTXO/)
  assert.match(FAMILY_NOTES.bitcoin, /CUMULATIVE received counter/)
  assert.match(FAMILY_NOTES.solana, /skipped/)
  assert.match(FAMILY_NOTES.solana, /finalized/)
  assert.match(FAMILY_NOTES.xrp, /BASE RESERVE/)
  assert.match(FAMILY_NOTES.xrp, /no network binding/)
  assert.match(FAMILY_NOTES.ember, /7412/)
  assert.match(FAMILY_NOTES.ember, /60/)
})

test('the note says which families have a worker and which are still stubbed', () => {
  // XRP is the only family left on stubWorker. When its worker lands this assertion is what makes
  // a stale "not built yet" note fail rather than quietly mislead the next reader.
  for (const family of ['evm', 'bitcoin', 'solana'] as const) {
    assert.match(FAMILY_NOTES[family], /^Built/, `${family} has a worker and the note must say so`)
  }
  assert.doesNotMatch(FAMILY_NOTES.xrp, /^Built/, 'XRP is still served by stubWorker')
})

test('the phase names the backlog item that funds the work', () => {
  assert.match(STUB_PHASE, /P5/)
  assert.match(STUB_PHASE, /EPC-14/)
})
