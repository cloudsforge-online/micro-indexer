/**
 * The service's own metrics, declared rather than inferred from a log line.
 *
 * AD-20: the alternative — grepping logs for a message — makes a metric that breaks when someone
 * rewords the message, and it cannot be a Prometheus counter with labels. Declaring them in one
 * module also means the names exist in exactly one place, so the dashboard, the alert rule and the
 * increment cannot drift apart.
 *
 * Three of these are paging signals in 13-operational-model: indexer lag past the confirmation
 * depth, an alarming reorg, and a provider set that has gone quiet.
 *
 * The first of those three needs TWO names, which is what this module was missing. "Lag past the
 * confirmation depth" is a comparison, and a comparison a rules file can only make if both sides
 * are published — see `CONFIRMATION_DEPTH` below.
 */

import { Metrics } from '@cloudsforge/telemetry'
import { requiredConfirmations, type ChainScope } from './chains.ts'

export const LAG_BLOCKS = 'indexer_lag_blocks'
export const CONFIRMATION_DEPTH = 'indexer_confirmation_depth'
export const REORGS_TOTAL = 'indexer_reorgs_total'
export const PROVIDER_FAILURES_TOTAL = 'indexer_provider_failures_total'
export const BLOCKS_INDEXED_TOTAL = 'indexer_blocks_indexed_total'
export const TRANSACTIONS_INDEXED_TOTAL = 'indexer_transactions_indexed_total'
export const ACTIVITY_TOTAL = 'indexer_address_activity_total'
export const DEPOSITS_OBSERVED_TOTAL = 'indexer_deposits_observed_total'
export const DEPOSITS_CONFIRMED_TOTAL = 'indexer_deposits_confirmed_total'
export const CHAIN_HALTED = 'indexer_chain_halted'
export const TIP_HEIGHT = 'indexer_tip_height'
export const DIFFICULTY = 'indexer_chain_difficulty'

/**
 * Reorg depth as a **bucket**, not as the raw number.
 *
 * The brief asks for `indexer_reorgs_total{chain,depth}` and this keeps that label, but a raw
 * depth is unbounded caller-controlled cardinality: a chain that reorganises 300 blocks mints 300
 * time series, and the scrape target is the thing that falls over. The buckets are chosen around
 * the only threshold that matters — `reorgAlarmDepth` is 5 for EMBER, 3 for ETH, 2 for BTC — so
 * every value below the alarm is individually visible and everything above it is one series.
 */
export function depthBucket(depth: number): string {
  if (depth <= 0) return '0'
  if (depth <= 5) return String(depth)
  if (depth <= 10) return '6-10'
  if (depth <= 50) return '11-50'
  return '51+'
}

/**
 * Register every metric this service owns, and publish the ones that are configuration.
 *
 * ── WHY `scopes` IS REQUIRED RATHER THAN DEFAULTED ────────────────────────────────────────────
 *
 * `indexer_confirmation_depth` is the right-hand side of a deployed page, and a registration with
 * no sample behind it is exactly the defect micro-org#310 is about: `Metrics.render` emits `# HELP`
 * and `# TYPE` for a metric with no series, Prometheus stores nothing for it, and the name does not
 * appear in `/api/v1/label/__name__/values` at all. Measured on the mainnet Prometheus on
 * 2026-08-09: 1,323 metric names, none of them containing `confirmation`, while
 * `IndexerLagPastConfirmationDepth` sat `health=ok state=inactive alerts=0` — indistinguishable
 * from a chain that is keeping up.
 *
 * Taking the scopes as a required argument is what makes "registered" and "published" the same act.
 * A caller that adds a chain cannot get the register without the sample.
 */
export function registerServiceMetrics(metrics: Metrics, scopes: readonly ChainScope[]): Metrics {
  const registered = metrics
    .register({
      name: LAG_BLOCKS,
      help: 'Observed tip height minus the height this service has indexed',
      kind: 'gauge',
      labels: ['chain', 'network'],
    })
    .register({
      /*
       * The threshold `LAG_BLOCKS` is judged against, published so the judging is not done against
       * a constant somebody typed into a rules file.
       *
       * ── IT IS THE PINNED CONTRACT'S NUMBER, NOT A SECOND SOURCE OF TRUTH ──────────────────────
       *
       * The value is `requiredConfirmations(chain)`, which is `chainSpec(asset).confirmations` out
       * of the EXACT-PINNED `@cloudsforge/contracts-chain` — the same call `creditable()` makes
       * when it decides whether a deposit may be credited. So the number the alert compares against
       * is the number the money path used, by construction rather than by agreement, and there is
       * no `INDEXER_CONFIRMATION_DEPTH_*` variable to drift away from it. The spread is the whole
       * reason a metric beats a constant: LTC is 12, BTC is 6, EMBER is 60 and ETC is 7,500, so one
       * threshold for all of them is one threshold that is wrong for three.
       *
       * ── THE LABEL SET IS `LAG_BLOCKS`'S, EXACTLY, AND THAT IS THE CONTRACT ────────────────────
       *
       * `IndexerLagPastConfirmationDepth` reads
       * `indexer_lag_blocks > on (chain) group_left () indexer_confirmation_depth`. `on (chain)`
       * matches on that label alone, so the `chain` VALUES here must be spelled exactly as the
       * follower spells them — `ltc`, `ember`, the URL-safe slug from `chains.ts`. Any other
       * spelling is a silent no-op: the join yields nothing and the page reports itself healthy,
       * which is the state micro-org#310 measured on 2026-08-09 with the right side simply absent.
       *
       * ── A GAUGE, AND IT IS SET AT REGISTRATION RATHER THAN ON A SCHEDULE ──────────────────────
       *
       * It cannot change without a redeploy: the depth is a compile-time constant of an exact-pinned
       * package, and re-reading it every scrape would be re-sampling a literal. So it is published
       * once, at composition, for every configured scope. Rule 8 is satisfied trivially rather than
       * by choosing between a timer and a hook.
       */
      name: CONFIRMATION_DEPTH,
      help:
        'Blocks a deposit must be buried by before this service credits it, from the exact-pinned ' +
        'contracts-chain spec. The threshold indexer_lag_blocks is judged against.',
      kind: 'gauge',
      labels: ['chain', 'network'],
    })
    .register({
      name: TIP_HEIGHT,
      help: 'The chain tip as last observed by this service',
      kind: 'gauge',
      labels: ['chain', 'network'],
    })
    .register({
      /*
       * Proof-of-work difficulty at the tip, so that "the retarget has run out of room" can be
       * asked at all (micro-org#363).
       *
       * ── WHY IT LIVES HERE AND NOT IN THE CHAIN ────────────────────────────────────────────────
       *
       * Nothing in the estate published difficulty before this. `hearth/node/src` has no Prometheus
       * surface of any kind, so the alternative was to grow one in a consensus daemon in order to
       * export a number this service already has in hand: the follower reads the whole block on the
       * tip stream and the `chain`/`network` labels are the ones every other rule joins on.
       *
       * ── IT HAS NO BOOT-TIME SAMPLE, AND THAT DOES NOT WEAKEN micro-org#310 ────────────────────
       *
       * `CONFIRMATION_DEPTH` below is published at registration because it is CONFIGURATION — a
       * compile-time constant of an exact-pinned package — and the property `scopes` buys is that a
       * caller cannot register it without publishing it. Difficulty is not configuration; it is an
       * OBSERVATION, and it does not exist until a block has been read, exactly like `TIP_HEIGHT`
       * and `LAG_BLOCKS` above. Publishing a placeholder at boot would be the fabricated sample
       * micro-org#310 is against, arriving from the other direction: a zero on the wire is a chain
       * that reads as broken, and a one is a chain that reads as trivially mineable.
       *
       * So `scopes` stays required, and it stays required for the reason it was made required — it
       * is still the only thing that publishes `CONFIRMATION_DEPTH`. Nothing here relaxes it.
       *
       * ── SOME CHAINS WILL NEVER HAVE A SERIES, DELIBERATELY ────────────────────────────────────
       *
       * `solana.ts` publishes nothing to this gauge and says why at its `TIP_HEIGHT` set. Solana has
       * no proof of work and therefore no difficulty; a 0 or a 1 there would be an invented reading,
       * which is what `beacon_chain_height_spread` was retired for on 2026-08-10. `evm.ts` also
       * declines when a block reports difficulty 0 — that is what a post-merge chain reports for
       * ever, and it is also what Hearth's own genesis header carries (measured 2026-08-10 against
       * `cf-hearth-seed`: block 0x0 returns `difficulty: "0x0"`, block 0x2af6 returns `"0x100"`).
       *
       * A gauge with series for some chains and not others is the honest shape. A gauge with a
       * series for every chain, some of them made up, is the shape that reads the same and lies.
       *
       * ── AND THERE IS DELIBERATELY NO COMPANION `indexer_difficulty_floor` ─────────────────────
       *
       * The obvious move is `CONFIRMATION_DEPTH`'s: publish the threshold so the rule compares two
       * published series. That works for the depth because the value IS
       * `chainSpec(asset).confirmations` out of the exact-pinned contract the money path itself
       * calls — one number, reached by construction. There is no equivalent source for Hearth's
       * difficulty floor. It is `MAX_TARGET` in `hearth/node/src/params.js`, pinned to
       * `GENESIS_TARGET`, in a repository this service does not and should not depend on, and it is
       * on no RPC method this service speaks. Deriving it from the genesis block was checked and
       * does not work: Hearth's block 0 reports difficulty 0, not 256.
       *
       * A floor gauge here would therefore be a SECOND COPY of a consensus constant with nothing
       * keeping it in step — and it would fail silently in the worse direction, because if Hearth
       * ever lowers its floor the gauge would keep asserting the old one and the alert would simply
       * go quiet. `EmberDifficultyAtFloor` compares against a literal 256 with that provenance
       * written beside it, which is falsifiable in one RPC call and cannot pretend to be authority.
       */
      name: DIFFICULTY,
      help:
        'Proof-of-work difficulty of the newest block this service indexed on the tip stream. ' +
        'Absent for chains with no proof of work, and for blocks that report a difficulty of 0.',
      kind: 'gauge',
      labels: ['chain', 'network'],
    })
    .register({
      name: REORGS_TOTAL,
      help: 'Reorganisations detected, by bucketed depth',
      kind: 'counter',
      labels: ['chain', 'network', 'depth', 'alarming'],
    })
    .register({
      name: PROVIDER_FAILURES_TOTAL,
      help: 'RPC calls that failed, by provider',
      kind: 'counter',
      labels: ['chain', 'network', 'provider'],
    })
    .register({
      name: BLOCKS_INDEXED_TOTAL,
      help: 'Blocks written to the canonical chain',
      kind: 'counter',
      labels: ['chain', 'network', 'stream'],
    })
    .register({
      name: TRANSACTIONS_INDEXED_TOTAL,
      help: 'Transactions written',
      kind: 'counter',
      labels: ['chain', 'network'],
    })
    .register({
      name: ACTIVITY_TOTAL,
      help: 'Address movements written, by direction and asset kind',
      kind: 'counter',
      labels: ['chain', 'network', 'direction', 'asset_kind'],
    })
    .register({
      name: DEPOSITS_OBSERVED_TOTAL,
      help: 'indexer.deposit.observed events emitted',
      kind: 'counter',
      labels: ['chain', 'network'],
    })
    .register({
      name: DEPOSITS_CONFIRMED_TOTAL,
      help: 'indexer.deposit.confirmed events emitted',
      kind: 'counter',
      labels: ['chain', 'network'],
    })
    .register({
      name: CHAIN_HALTED,
      help: '1 when an alarming reorg has stopped this chain and an operator has not cleared it',
      kind: 'gauge',
      labels: ['chain', 'network'],
    })

  // The one metric here whose value is known before a single block is read. Published now so the
  // join's right-hand side exists from the first scrape rather than from the first follower tick: a
  // replica that boots and cannot reach its provider is precisely when the lag page has to work.
  for (const scope of scopes) {
    registered.set(CONFIRMATION_DEPTH, requiredConfirmations(scope.chain), {
      chain: scope.chain,
      network: scope.network,
    })
  }
  return registered
}
