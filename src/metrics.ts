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
 */

import { Metrics } from '@cloudsforge/telemetry'

export const LAG_BLOCKS = 'indexer_lag_blocks'
export const REORGS_TOTAL = 'indexer_reorgs_total'
export const PROVIDER_FAILURES_TOTAL = 'indexer_provider_failures_total'
export const BLOCKS_INDEXED_TOTAL = 'indexer_blocks_indexed_total'
export const TRANSACTIONS_INDEXED_TOTAL = 'indexer_transactions_indexed_total'
export const ACTIVITY_TOTAL = 'indexer_address_activity_total'
export const DEPOSITS_OBSERVED_TOTAL = 'indexer_deposits_observed_total'
export const DEPOSITS_CONFIRMED_TOTAL = 'indexer_deposits_confirmed_total'
export const CHAIN_HALTED = 'indexer_chain_halted'
export const TIP_HEIGHT = 'indexer_tip_height'

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

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: LAG_BLOCKS,
      help: 'Observed tip height minus the height this service has indexed',
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
}
