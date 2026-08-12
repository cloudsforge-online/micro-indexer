import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '@cloudsforge/db'
import { BASELINE_VERSION, CHAIN_TABLES, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { CHAIN_IDS, NETWORKS } from './chains.ts'

const ALL_SQL = MIGRATIONS.map((m) => m.up).join('\n')

/** The DDL with `--` comments removed, so an assertion about columns cannot be fooled by prose. */
const DDL = ALL_SQL.replace(/--[^\n]*/g, '')

test('versions are unique and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length, 'a duplicate version makes the run refuse')
})

test('SCHEMA_VERSION is the highest migration, so a new one raises the boot assertion', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('the runtime tables are present and carry the constraints their packages assume', () => {
  for (const table of ['jobs', 'outbox', 'event_subscriptions', 'outbox_deliveries', 'inbox']) {
    assert.match(ALL_SQL, new RegExp(`create table if not exists ${table}\\b`), `${table} missing`)
  }
  // Without this every recurring enqueue duplicates instead of collapsing.
  assert.match(ALL_SQL, /jobs_kind_key_uniq unique \(kind, key\)/)
  // The consumer dedupe key — AD-10.
  assert.match(ALL_SQL, /primary key \(topic, event_id\)/)
})

test('every chain table exists', () => {
  for (const table of CHAIN_TABLES) {
    assert.match(ALL_SQL, new RegExp(`create table if not exists ${table}\\b`), `${table} missing`)
  }
})

test('every chain table pins the domain of both chain and network', () => {
  // The invariant of 04-domain-model §4.1, enforced by the database rather than by review. A
  // table that forgets one of these is a table where a typo mints a sixth chain nothing follows,
  // or where an XRP row exists on neither network in particular.
  for (const table of CHAIN_TABLES) {
    assert.match(
      ALL_SQL,
      new RegExp(`${table}_chain_ck check \\(chain in`),
      `${table} does not pin the chain domain`,
    )
    assert.match(
      ALL_SQL,
      new RegExp(`${table}_network_ck check \\(network in \\('mainnet','testnet'\\)\\)`),
      `${table} does not pin the network domain`,
    )
  }
})

test('every foreign key between chain tables is composite and carries chain and network', () => {
  // A single-column reference would let a log on testnet point at a transaction on mainnet, which
  // is exactly the XRP class of defect this schema exists to make impossible.
  const foreignKeys = ALL_SQL.match(/foreign key \([^)]*\)/g) ?? []
  assert.ok(foreignKeys.length >= 3, 'expected the transaction, log and activity references')
  for (const key of foreignKeys) {
    assert.match(key, /chain/, `${key} does not carry chain`)
    assert.match(key, /network/, `${key} does not carry network`)
  }
})

test('the canonical chain can hold exactly one block per height', () => {
  // The constraint that makes a wrong reorg loud instead of silently corrupting history.
  assert.match(
    ALL_SQL,
    /create unique index if not exists blocks_canonical_height_uniq\s+on blocks \(chain, network, height\)\s+where status <> 'orphaned'/,
  )
})

test('a transaction is unique on (chain, network, hash)', () => {
  assert.match(ALL_SQL, /constraint transactions_pk primary key \(chain, network, hash\)/)
})

test('address activity is unique per movement, which is what makes re-indexing a no-op', () => {
  assert.match(
    ALL_SQL,
    /constraint address_activity_uniq unique \(chain, network, tx_hash, entry_key\)/,
  )
})

test('no table stores a confirmation count', () => {
  // Derived from tip_height at read time. A stored count is stale the moment the next block is
  // mined, and a crediting decision taken against a stale one is the failure depth exists to stop.
  assert.equal(
    /\bconfirmations\b/.test(DDL),
    false,
    'a confirmations column has appeared — it must be derived, never stored',
  )
})

test('provider health stores a host and never a URL', () => {
  assert.match(DDL, /url_host\s+text\s+not null/)
  assert.equal(/provider_health[\s\S]*?\burl\s+text/.test(DDL), false)
})

test('a new service baselines nothing', () => {
  assert.equal(
    BASELINE_VERSION,
    0,
    'a non-zero baseline records migrations as applied without running them',
  )
})

test('checksums are stable, which is what makes an edited migration refuse to run', () => {
  for (const m of MIGRATIONS) {
    assert.equal(
      checksumOf(m),
      checksumOf({ ...m, up: `\n  ${m.up}  \n` }),
      `${m.name} is whitespace-sensitive`,
    )
  }
})

/**
 * The domain a column ACTUALLY ends up with: the last `check (<column> in (...))` any migration
 * applies to `<table>_<column>_ck`, in migration order.
 *
 * Reading the last one rather than searching the whole file is the substance of the two tests
 * below. An earlier spelling is history and is allowed to be narrow — migration 4's five chains
 * still sit in `ALL_SQL` and always will — so "does this string appear anywhere" is a question that
 * a widening migration answers for a table it never touched.
 */
function finalDomain(table: string, column: 'chain' | 'network'): readonly string[] | null {
  const matches = [
    ...ALL_SQL.matchAll(new RegExp(`${table}_${column}_ck check \\(${column} in \\(([^)]*)\\)\\)`, 'g')),
  ]
  const last = matches.at(-1)
  if (!last) return null
  return (last[1] ?? '').split(',').map((value) => value.trim().replace(/'/g, ''))
}

test('the chain domain every table ends up with is exactly CHAIN_IDS, in both directions', () => {
  // The regression this locks down: LTC was added to `chains.ts` and not to the schema, so
  // `watched_addresses_chain_ck` rejected every Litecoin address — an indexer that cannot be told
  // what to watch. Both estates were patched live, which fixed the databases that existed and left
  // every database created afterwards broken.
  //
  // The repair for that interpolated `CHAIN_IDS` into the SQL, which cannot stand in a checksummed
  // migration and no longer does — see the constants at the head of `migrations.ts`. This test is
  // what replaces it, and it is stronger than the one it replaces in two ways. It compares SETS, so
  // a chain in the schema that the type does not know fails as loudly as the other direction; and
  // it reads the FINAL constraint per table, so a widening migration that quietly covers `blocks`
  // and forgets `spent_outpoints` fails here rather than at the first insert of a follow tick.
  for (const table of CHAIN_TABLES) {
    const domain = finalDomain(table, 'chain')
    assert.ok(domain, `${table} never has its chain domain pinned by any migration`)
    assert.deepEqual(
      [...domain].sort(),
      [...CHAIN_IDS].sort(),
      `${table} ends up admitting ${domain.join(',')}, which is not CHAIN_IDS`,
    )
  }
})

test('the network domain every table ends up with is exactly NETWORKS', () => {
  // The same shape for the pair that has never changed. It is asserted anyway because the cost of
  // the assertion is nothing and the cost of discovering a third network was never admitted is a
  // whole environment that cannot write a row.
  for (const table of CHAIN_TABLES) {
    const domain = finalDomain(table, 'network')
    assert.ok(domain, `${table} never has its network domain pinned by any migration`)
    assert.deepEqual([...domain].sort(), [...NETWORKS].sort())
  }
})

test('the checksum of every released migration is the one it shipped with', () => {
  // MIGRATIONS ARE APPEND-ONLY, and this is the only place that says so in a way that fails a
  // build. `migrate()` compares each migration's checksum against the row it wrote when it applied
  // it and refuses the WHOLE run on a mismatch, so an edit to released text is not a bad migration
  // — it is every replica in the estate unable to start, discovered at deploy time.
  //
  // It has nearly happened twice and both were invisible in review, because neither was an edit to
  // the SQL: both were edits to a CONSTANT the SQL interpolated. Adding `ltc` to `CHAIN_IDS`
  // rewrote migrations 4 and 5; adding `doge` and `etc` would have rewritten migration 6, which was
  // left derived when 4 and 5 were pinned. A reviewer cannot see that by reading the diff — the
  // changed line is in another file — so it is pinned here as data.
  //
  // ADDING A ROW WHEN YOU ADD A MIGRATION IS THE INTENDED WORK. Changing an existing row is the
  // thing this exists to make you stop and explain, and there is no legitimate reason to.
  const shipped: Readonly<Record<number, string>> = {
    1: 'eb9bd289',
    2: '2479dd84',
    3: '8b24c44e',
    4: '040f74a8',
    5: 'cefc269c',
    6: 'b635fae7',
    7: 'be00dd76',
    8: '28e40f2c',
    9: 'a3b213a5',
    10: '59a363f7',
  }
  for (const m of MIGRATIONS) {
    assert.equal(
      checksumOf(m),
      shipped[m.version],
      `migration ${m.version} (${m.name}) no longer hashes to the text it was applied with`,
    )
  }
  assert.equal(
    Object.keys(shipped).length,
    MIGRATIONS.length,
    'a migration was added without pinning its checksum',
  )
})

test('the converging migration repairs every chain-scoped table, whenever the database was created', () => {
  // A live ALTER fixes only the databases that already exist. Without this, a freshly provisioned
  // environment comes up with the old constraint and the failure looks like a code bug.
  //
  // Found by NAME and not as the last element. It was written last and read as `MIGRATIONS.at(-1)`,
  // which conflated "the migration that converges" with "whatever ran most recently" — so the next
  // unrelated migration (7, `utxo-custody-history`) failed this test while converging nothing and
  // un-converging nothing. The invariant is that the repair is in the list at all; every table's
  // constraint is asserted against the whole DDL by the two tests above regardless of which
  // migration carries it.
  const converge = MIGRATIONS.find((m) => m.name === 'chain-check-converge')
  assert.ok(converge, 'the converging migration is gone; a fresh database no longer gets the repair')
  for (const table of CHAIN_TABLES) {
    assert.match(
      converge.up,
      new RegExp(`alter table ${table} add constraint ${table}_chain_ck`),
      `${table} is chain-scoped but the converging migration does not repair it`,
    )
  }
})
