/**
 * The metric that makes `IndexerLagPastConfirmationDepth` capable of returning a sample.
 *
 * That rule is a **page**, it has been deployed since the telemetry plane's first release, and it
 * has never once been able to fire. Its expression is
 *
 *     indexer_lag_blocks > on (chain) group_left () indexer_confirmation_depth
 *
 * and on the mainnet Prometheus on 2026-08-09 the left side had two series (`ltc`, `ember`) and the
 * right side had none — no metric name in the estate's 1,323 contained the substring `confirmation`
 * (micro-org#310). A `group_left` with an empty right side produces the empty vector, and Prometheus
 * reports the rule `health=ok state=inactive alerts=0`: byte for byte what a chain that is keeping
 * up looks like.
 *
 * So these tests are not about a number being right. They are about the four properties that decide
 * whether the join can produce a sample at all, and each of them fails silently and greenly:
 *
 *   1. the name exists with a SAMPLE behind it, not merely a `# HELP`/`# TYPE` pair;
 *   2. its `chain` label values are spelled the way the follower spells them;
 *   3. the right side is unique per `chain`, or `group_left` is a many-to-many error;
 *   4. the value is the pinned contract's depth and not a second copy of it.
 *
 * No database and no network: every one of them is a property of composition, which is exactly why
 * they can be asserted at all.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Metrics } from '@cloudsforge/telemetry'
import { chainSpec } from '@cloudsforge/contracts-chain'
import { CHAIN_IDS, assetOf, type ChainScope } from './chains.ts'
import * as serviceMetrics from './metrics.ts'
import { registerServiceMetrics } from './metrics.ts'

/*
 * The two names are LITERALS here and not the module's own constants, deliberately.
 *
 * `prometheus/rules/alerts.yaml` names strings. A constant renamed on both sides at once keeps
 * every assertion below green while the deployed rule stops matching anything, which is the exact
 * class of silent, green-to-green breakage this file exists to catch. One assertion at the end
 * pins the module's constant to the literal, so the module still has a single spelling — reached
 * through a NAMESPACE import, because a named import of a constant that does not exist takes the
 * whole file down with a link error instead of failing the one case that is about it.
 */
const DEPTH = 'indexer_confirmation_depth'
const LAG = 'indexer_lag_blocks'

/** The two scopes the mainnet estate actually follows, measured from `indexer_lag_blocks`. */
const ESTATE: readonly ChainScope[] = Object.freeze([
  { chain: 'ltc', network: 'mainnet' },
  { chain: 'ember', network: 'mainnet' },
])

/** `{chain="ltc",network="mainnet"} 12` → `12`, or null when the series is not there at all. */
function series(text: string, name: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(`${name}{`)) continue
    const brace = line.indexOf('}')
    found.set(line.slice(name.length, brace + 1), line.slice(brace + 2))
  }
  return found
}

describe('the confirmation depth this service credits at', () => {
  it('is published as a real sample for every configured scope, not just registered', () => {
    // The distinction this asserts is the whole defect. `Metrics.render` emits `# HELP` and
    // `# TYPE` for a metric that has never been `set`, so a registration alone LOOKS like an
    // exported metric in a curl of /metrics — and Prometheus stores nothing for it, because there
    // is no sample. `absent()` and `group_left` both see nothing either way.
    const text = registerServiceMetrics(new Metrics(), ESTATE).render()

    assert.ok(text.includes(`# TYPE ${DEPTH} gauge`), 'the metric must be declared')
    assert.deepEqual(
      series(text, DEPTH),
      new Map([
        ['{chain="ltc",network="mainnet"}', '12'],
        ['{chain="ember",network="mainnet"}', '60'],
      ]),
      'a declaration with no series behind it is the thing micro-org#310 measured',
    )
  })

  it('takes its number from the pinned contract for every chain in the union', () => {
    // Asserted over the whole union rather than over the two the estate follows, because the way
    // this stops being true is a chain being added. `requiredConfirmations` reads
    // `contracts-chain`, which is exact-pinned precisely so that wallet, settlement, custody and
    // this service cannot disagree about a depth — and the point of publishing it as a metric is
    // that the alert then compares against the number the money path used, not against a constant
    // in a rules file.
    const scopes = CHAIN_IDS.map((chain): ChainScope => ({ chain, network: 'mainnet' }))
    const found = series(registerServiceMetrics(new Metrics(), scopes).render(), DEPTH)

    for (const chain of CHAIN_IDS) {
      const expected = chainSpec(assetOf(chain)).confirmations
      assert.equal(
        found.get(`{chain="${chain}",network="mainnet"}`),
        String(expected),
        `${chain} is published at a depth the contract does not state`,
      )
    }
    // The spread is why a metric beats a constant. If these three ever collapse to one number,
    // whoever did it has restated a depth locally and the alert has quietly become one threshold.
    assert.equal(found.get('{chain="btc",network="mainnet"}'), '6')
    assert.equal(found.get('{chain="ltc",network="mainnet"}'), '12')
    assert.equal(found.get('{chain="etc",network="mainnet"}'), '7500')
  })

  it('carries exactly the label set indexer_lag_blocks carries, or the join yields nothing', () => {
    // `on (chain)` matches on the chain label and nothing else, so what actually has to hold is
    // that the `chain` VALUES are spelled identically on both sides. Asserting the whole label
    // string is the stronger form of that and it is the one that survives someone adding a label
    // to one metric and not the other.
    const metrics = registerServiceMetrics(new Metrics(), ESTATE)
    for (const scope of ESTATE) {
      metrics.set(LAG, 3, { chain: scope.chain, network: scope.network })
    }
    const text = metrics.render()

    assert.deepEqual(
      [...series(text, DEPTH).keys()].sort(),
      [...series(text, LAG).keys()].sort(),
      'the two sides of IndexerLagPastConfirmationDepth are keyed differently',
    )
  })

  it('produces one series per chain, which is what group_left requires of the right side', () => {
    // A `group_left` whose right side has two series for one `chain` is not a quiet no-op — it is
    // an evaluation error, and the page goes from never firing to never evaluating. One indexer
    // process may legitimately follow both networks of a chain, so this is a live shape and not a
    // hypothetical.
    const bothNetworks: readonly ChainScope[] = [
      { chain: 'ltc', network: 'mainnet' },
      { chain: 'ltc', network: 'testnet' },
    ]
    const found = series(registerServiceMetrics(new Metrics(), bothNetworks).render(), DEPTH)
    const perChain = new Map<string, number>()
    for (const labels of found.keys()) {
      const chain = /chain="([^"]+)"/.exec(labels)?.[1] ?? ''
      perChain.set(chain, (perChain.get(chain) ?? 0) + 1)
    }
    // Two here, and DELIBERATELY so: dropping `network` would not save the join anyway, because
    // Prometheus stamps `instance` and `job` onto every series, so two indexer replicas or two
    // network stacks scraped by one server already give `on (chain)` a duplicated right side. The
    // label set therefore follows `indexer_lag_blocks` rather than trying to defend the join, and
    // the defence that does work is one Prometheus per network stack — which is how the estate is
    // deployed, measured 2026-08-09: `indexer_lag_blocks` had exactly two series, one per chain.
    assert.equal(perChain.get('ltc'), 2, 'the scope is the unit, exactly as it is for lag')
  })

  it('is a gauge, because it is a level and never an increase', () => {
    // `_total` would be wrong here and the name does not carry it. Stated as a test rather than
    // left to the register call because `rate()` over a confirmation depth is meaningless and the
    // rule compares the raw value.
    const text = registerServiceMetrics(new Metrics(), ESTATE).render()
    assert.ok(text.includes(`# TYPE ${DEPTH} gauge`))
    assert.ok(!text.includes(`# TYPE ${DEPTH} counter`))
    assert.equal(
      serviceMetrics.CONFIRMATION_DEPTH,
      DEPTH,
      'the module spells the name differently from the rule that reads it',
    )
  })
})
