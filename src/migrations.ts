/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **Expand/contract is not advice.** A rolling deploy always runs two versions of this service
 * against one schema, so every change is four releases: add a column, deploy code that writes
 * both, backfill, deploy code that reads the new one, then drop the old one. A migration that
 * renames or drops in one step takes the previous replica down with it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 4" means. The fix for a wrong migration is always a new migration.
 *
 * ## The three invariants this schema enforces in the database rather than in review
 *
 * 1. **One schema across all five families.** A Bitcoin transaction and an EVM transaction land in
 *    `transactions`, with what differs held in typed columns that may be null or in `raw_ref`.
 *    Five tables would be five reorg implementations and five sets of joins for every consumer;
 *    AD-07 rejects that shape for the service and this rejects it for the storage.
 *
 * 2. **No query may span networks.** Every chain table carries `chain` and `network`, both are the
 *    leading columns of the primary key, every foreign key is composite and includes both, and
 *    every check constraint pins the domain of both. A `log` therefore cannot reference a
 *    `transaction` on another network even if someone writes the join wrongly, because the
 *    reference itself carries the network. This is the class of mistake 00-current-state §3.5
 *    records as live: XRP shares one address across testnet and mainnet, and a signed Payment is
 *    submittable on either.
 *
 * 3. **The canonical chain has exactly one block per height.** `blocks_canonical_height_uniq` is a
 *    partial unique index over the non-orphaned rows. A reorg that inserts a replacement block
 *    without first marking the old one orphaned raises 23505 rather than quietly leaving two
 *    blocks claiming height N. That is the single most valuable constraint in this file: it makes
 *    a wrong reorg implementation fail loudly instead of corrupting history.
 *
 * ## What is deliberately absent
 *
 * There is **no `confirmations` column** anywhere, although 04-domain-model §4.2 lists the field.
 * A stored confirmation count is stale the moment the next block is mined, and a crediting
 * decision taken against a stale count is the failure the depth exists to prevent. It is derived
 * at read time from `checkpoints.tip_height` — see `chains.confirmationsAt`, which also carries
 * the argument for the off-by-one.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

/**
 * The chain and network domains as SQL, **pinned once per migration and never derived.**
 *
 * Repeating the domain on every chain table is what stops a typo minting a chain nothing follows.
 * Getting the repetition RIGHT has now failed twice, in opposite directions, and both failures are
 * the reason these are literals:
 *
 *   1. **Hand-written and drifted.** The list was typed out here while `chains.ts` kept its own, and
 *      when LTC was added to the type nobody added it to the schema, so `watched_addresses_chain_ck`
 *      rejected every Litecoin address — an indexer that cannot be told what to watch. Both estates
 *      were patched live, which fixed the databases that existed and left every database created
 *      afterwards wrong.
 *   2. **Derived, and rewrote history.** The repair for (1) interpolated `CHAIN_IDS` into the SQL.
 *      `@cloudsforge/db` hashes each migration's text and refuses the whole run when an applied one
 *      has changed, so adding `ltc` to the type silently edited SQL that Postgres had already
 *      executed and every existing estate refused to migrate. Migrations 4 and 5 were pinned in
 *      response — and migration 6 was left derived, with a comment saying that was fine "for
 *      migrations written from version 6 onward". It was not fine. Adding DOGE and ETC to the type
 *      would have rewritten migration 6 and reproduced the outage exactly, three migrations later.
 *
 * So the rule has no exception left in it: **a checksummed artefact contains no value that can
 * change.** Each of these is the domain as it shipped in the migration named, frozen at that
 * moment, and a new chain gets a NEW constant and a NEW migration rather than an edit to one above.
 *
 * The agreement with `chains.ts` that derivation was reaching for is kept by `migrations.test.ts`
 * instead, which reads the LAST chain check each table receives and asserts it is `CHAIN_IDS`
 * exactly — both directions, so a chain in the type with no migration behind it and a chain in the
 * schema that the type does not know are each a red build rather than a broken deploy. A test can
 * do that safely because a test is not hashed.
 */
const CHAIN_CK_AS_APPLIED_4_5 = `check (chain in ('ember','eth','btc','sol','xrp'))`
const CHAIN_CK_AS_APPLIED_6 = `check (chain in ('ember','eth','btc','sol','xrp','ltc'))`
const CHAIN_CK_AS_APPLIED_9 = `check (chain in ('ember','eth','etc','btc','sol','xrp','ltc','doge'))`

/**
 * One spelling so far, and it is pinned for the same reason rather than because it has burned
 * anybody: `Network` is a closed pair in `contracts-chain` and widening it is an estate-wide event,
 * but "unlikely to change" is exactly the argument that left migration 6 derived.
 */
const NETWORK_CK_AS_APPLIED = `check (network in ('mainnet','testnet'))`

/**
 * Every table this service owns, in an order that is safe to truncate.
 *
 * Declared here, above `MIGRATIONS`, rather than at the foot of the file where it used to sit —
 * migrations 6 and 9 build their DDL from this list at module-evaluation time, so a definition
 * below the array would still be in its temporal dead zone. Moving it is also the point: this is
 * the ONE list of chain-scoped tables, used by every migration that repairs or widens their
 * constraints and by the database tests that truncate them. Writing a second one is how the chain
 * check drifted in the first place — and it is why a widening migration cannot cover eight tables
 * and quietly miss the ninth.
 */
export const CHAIN_TABLES: readonly string[] = Object.freeze([
  'spent_outpoints',
  'address_activity',
  'logs',
  'transactions',
  'blocks',
  'reorgs',
  'checkpoints',
  'provider_health',
  'watched_addresses',
])

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs
    // table missing the (kind, key) unique constraint, which silently turns every recurring
    // enqueue into a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'chain',
    up: `
      -- ------------------------------------------------------------------ blocks
      create table if not exists blocks (
        chain       text        not null,
        network     text        not null,
        height      bigint      not null,
        hash        text        not null,
        parent_hash text        not null,
        block_time  timestamptz not null,
        status      text        not null default 'included',
        -- Set on an orphaned block to the depth of the reorg that orphaned it, so the row itself
        -- says why it left the canonical chain rather than only the reorgs table saying so.
        reorg_depth integer,
        tx_count    integer     not null default 0,
        -- Family-specific header detail. EVM keeps miner, gas and difficulty here; Bitcoin will
        -- keep the merkle root and the bits. It is jsonb rather than five nullable column groups
        -- because none of it is ever a query predicate.
        detail      jsonb       not null default '{}'::jsonb,
        indexed_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),
        constraint blocks_pk primary key (chain, network, hash),
        constraint blocks_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint blocks_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint blocks_status_ck check (status in ('pending','included','finalised','orphaned')),
        constraint blocks_height_ck check (height >= 0)
      );

      -- THE CONSTRAINT THAT MAKES A WRONG REORG LOUD. Exactly one non-orphaned block may claim a
      -- height. Inserting a replacement without first orphaning the incumbent raises 23505.
      create unique index if not exists blocks_canonical_height_uniq
        on blocks (chain, network, height)
        where status <> 'orphaned';

      create index if not exists blocks_scope_height_idx
        on blocks (chain, network, height desc);

      -- ------------------------------------------------------------------ transactions
      -- One table for five families. What an EVM transaction calls a nonce and XRP calls a
      -- sequence is one column, because every consumer asks the same question of it: is this the
      -- next one from this account.
      create table if not exists transactions (
        chain             text          not null,
        network           text          not null,
        hash              text          not null,
        block_hash        text,
        block_height      bigint,
        tx_index          integer,
        from_address      text,
        to_address        text,
        -- numeric(78,0) holds a uint256 exactly. A float loses the least significant digits,
        -- which is precisely where a reconciliation drift shows up, and bigint overflows at 19.
        value             numeric(78,0) not null default 0,
        fee               numeric(78,0),
        status            text          not null,
        nonce_or_sequence bigint,
        raw_ref           jsonb         not null default '{}'::jsonb,
        first_seen_at     timestamptz   not null default now(),
        updated_at        timestamptz   not null default now(),
        -- THE UNIQUENESS THE BRIEF NAMES. It is also what makes re-indexing idempotent: a
        -- transaction re-included in a different block after a reorg updates this row in place
        -- rather than producing a second one.
        constraint transactions_pk primary key (chain, network, hash),
        constraint transactions_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint transactions_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint transactions_status_ck
          check (status in ('pending','success','failed','dropped','orphaned')),
        -- Mempool-only rows have neither. MATCH SIMPLE means the composite key below is simply
        -- not checked while block_hash is null, which is the behaviour a pending row needs.
        constraint transactions_block_ck check ((block_hash is null) = (block_height is null)),
        constraint transactions_block_fk foreign key (chain, network, block_hash)
          references blocks (chain, network, hash) on delete cascade
      );

      create index if not exists transactions_scope_block_idx
        on transactions (chain, network, block_height desc, tx_index);
      create index if not exists transactions_from_idx
        on transactions (chain, network, from_address, block_height desc);
      create index if not exists transactions_to_idx
        on transactions (chain, network, to_address, block_height desc);

      -- ------------------------------------------------------------------ logs
      create table if not exists logs (
        chain        text    not null,
        network      text    not null,
        tx_hash      text    not null,
        log_index    integer not null,
        block_hash   text    not null,
        block_height bigint  not null,
        address      text    not null,
        topics       text[]  not null default '{}',
        data         text    not null default '0x',
        status       text    not null default 'included',
        constraint logs_pk primary key (chain, network, tx_hash, log_index),
        constraint logs_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint logs_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint logs_status_ck check (status in ('included','orphaned')),
        constraint logs_index_ck check (log_index >= 0),
        constraint logs_tx_fk foreign key (chain, network, tx_hash)
          references transactions (chain, network, hash) on delete cascade
      );

      create index if not exists logs_scope_address_idx
        on logs (chain, network, address, block_height desc);
      -- topic0 is the event signature and the only topic anyone filters on first.
      create index if not exists logs_scope_topic0_idx
        on logs (chain, network, (topics[1]), block_height desc);

      -- ------------------------------------------------------------------ address_activity
      -- The join between chain data and platform concepts (04-domain-model §4.2), and the thing
      -- that replaces balance-probing: it is why a deposit gets a real transaction hash and an
      -- explorer link for the first time.
      --
      -- There is no confirmations column. See this file's header.
      create table if not exists address_activity (
        id            uuid          primary key default gen_random_uuid(),
        chain         text          not null,
        network       text          not null,
        address       text          not null,
        direction     text          not null,
        -- The native asset code for a native movement, and the token contract address for a token
        -- one. A symbol is a mutable, spoofable, off-chain fact; resolving it belongs to a token
        -- registry, not to the record of what the chain said.
        asset_code    text          not null,
        asset_kind    text          not null,
        token_address text,
        amount        numeric(78,0) not null,
        tx_hash       text          not null,
        -- Deterministic within a transaction, which is what makes re-indexing a no-op rather than
        -- a duplicate: the same movement always computes the same key.
        entry_key     text          not null,
        log_index     integer,
        block_height  bigint        not null,
        block_hash    text          not null,
        status        text          not null default 'included',
        first_seen_at timestamptz   not null default now(),
        confirmed_at  timestamptz,
        reorged_at    timestamptz,
        updated_at    timestamptz   not null default now(),
        constraint address_activity_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint address_activity_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint address_activity_direction_ck check (direction in ('in','out')),
        constraint address_activity_kind_ck check (asset_kind in ('native','token')),
        constraint address_activity_status_ck check (status in ('included','orphaned')),
        constraint address_activity_token_ck
          check ((asset_kind = 'token') = (token_address is not null)),
        constraint address_activity_amount_ck check (amount >= 0),
        constraint address_activity_uniq unique (chain, network, tx_hash, entry_key),
        constraint address_activity_tx_fk foreign key (chain, network, tx_hash)
          references transactions (chain, network, hash) on delete cascade
      );

      create index if not exists address_activity_lookup_idx
        on address_activity (chain, network, address, block_height desc, id desc);
      -- The confirmation sweep's access path: inbound, still included, not yet reported confirmed.
      create index if not exists address_activity_unconfirmed_idx
        on address_activity (chain, network, block_height)
        where status = 'included' and confirmed_at is null and direction = 'in';

      -- ------------------------------------------------------------------ checkpoints
      -- Progress, per (chain, network, stream). 'tip' is the follower; 'backfill:<from>-<to>' is
      -- one historical range. Separate streams are what let a backfill run without blocking the
      -- follower, and the lease keys in jobs.ts match them one for one.
      --
      -- The halt flag lives on the 'tip' row and is a property of the CHAIN, not of the stream:
      -- store.isHalted reads it there and both workers consult it. An alarming reorg sets it, and
      -- only an operator clears it, because the whole point of the alarm is that an assumption
      -- the confirmation depth encodes has failed and a machine cannot decide it has stopped.
      create table if not exists checkpoints (
        chain       text        not null,
        network     text        not null,
        stream      text        not null,
        -- Nullable, and null means "nothing indexed on this stream yet". A zero sentinel would be
        -- indistinguishable from having indexed the genesis block, which on a chain whose genesis
        -- carries an allocation is a real and different statement.
        height      bigint,
        block_hash  text,
        range_from  bigint,
        range_to    bigint,
        tip_height  bigint,
        tip_seen_at timestamptz,
        halted      boolean     not null default false,
        halt_reason text,
        updated_at  timestamptz not null default now(),
        constraint checkpoints_pk primary key (chain, network, stream),
        constraint checkpoints_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint checkpoints_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint checkpoints_range_ck check ((range_from is null) = (range_to is null)),
        constraint checkpoints_range_order_ck
          check (range_from is null or range_to >= range_from)
      );

      -- ------------------------------------------------------------------ reorgs
      create table if not exists reorgs (
        id                     uuid        primary key default gen_random_uuid(),
        chain                  text        not null,
        network                text        not null,
        detected_at            timestamptz not null default now(),
        common_ancestor_height bigint      not null,
        common_ancestor_hash   text        not null,
        previous_tip_height    bigint      not null,
        previous_tip_hash      text        not null,
        depth                  integer     not null,
        -- isReorgAlarming from contracts-chain decided this. Recorded rather than recomputed, so
        -- the row still says what the policy was on the day, after the policy changes.
        alarming               boolean     not null default false,
        orphaned_blocks        integer     not null default 0,
        orphaned_transactions  integer     not null default 0,
        orphaned_activity      integer     not null default 0,
        orphaned_block_hashes  text[]      not null default '{}',
        constraint reorgs_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint reorgs_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint reorgs_depth_ck check (depth > 0)
      );

      create index if not exists reorgs_scope_idx on reorgs (chain, network, detected_at desc);

      -- ------------------------------------------------------------------ provider_health
      -- Only the host is stored, never the URL. An RPC provider's API key lives in the query
      -- string, and a table an operator reads over the shoulder of a screen share is not where it
      -- belongs. redactUrl in @cloudsforge/http exists for the same reason.
      create table if not exists provider_health (
        chain                text        not null,
        network              text        not null,
        provider             text        not null,
        url_host             text        not null,
        state                text        not null default 'healthy',
        consecutive_failures integer     not null default 0,
        total_requests       bigint      not null default 0,
        total_failures       bigint      not null default 0,
        latency_ms           integer,
        last_ok_at           timestamptz,
        last_failure_at      timestamptz,
        last_error           text,
        rate_limited_until   timestamptz,
        updated_at           timestamptz not null default now(),
        constraint provider_health_pk primary key (chain, network, provider),
        constraint provider_health_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint provider_health_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint provider_health_state_ck check (state in ('healthy','degraded','down'))
      );

      -- ------------------------------------------------------------------ watched_addresses
      -- Which addresses are worth a deposit event.
      --
      -- address_activity is written for EVERY address a block touches, because six products need
      -- the general record. Deposit EVENTS are a different thing: a topic every wallet replica
      -- subscribes to cannot be every transfer on the chain. The registration is a write route
      -- scoped to indexer:write, called by the wallet service when it hands a user an address.
      --
      -- This does not make the indexer decide a credit. It decides who is worth telling.
      create table if not exists watched_addresses (
        chain    text        not null,
        network  text        not null,
        address  text        not null,
        label    text,
        added_at timestamptz not null default now(),
        constraint watched_addresses_pk primary key (chain, network, address),
        constraint watched_addresses_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint watched_addresses_network_ck ${NETWORK_CK_AS_APPLIED}
      );
    `,
  },
  {
    version: 5,
    name: 'utxo',
    // ------------------------------------------------------------------------------------------
    // What a UTXO chain needs that an account chain does not, and why it is schema rather than
    // handler code.
    //
    // On an account chain a transaction is identified by (sender, nonce), so a transaction that
    // leaves the canonical chain in a reorg either comes back with the same hash or is superseded
    // by one whose nonce makes the first unminable. Either way the indexer's `hash` primary key
    // and its `orphaned` status describe the whole of it, and `evm.ts` needs nothing more.
    //
    // Bitcoin has no nonce. A transaction is a set of *outpoint* spends, and two different txids
    // may spend the same outpoint — that is what a replace-by-fee is, and it is ordinary traffic
    // rather than an attack. It creates a state the EVM worker has no word for: an orphaned
    // transaction that can NEVER be re-mined, because the coins it spent have been spent by
    // somebody else on the chain that won. A deposit consumer told only "orphaned" will wait for
    // a confirmation that is never coming; it has to be told "conflicted".
    //
    // Deciding that needs the spends recorded, so they are recorded here — and the invariant that
    // matters rides a partial unique index rather than a check in the worker:
    //
    //     at most ONE canonical transaction may spend a given outpoint.
    //
    // That is the double-spend rule itself, held by the database. It is the exact analogue of
    // `blocks_canonical_height_uniq` in migration 4, and it earns its place the same way: a reorg
    // repair that re-indexes a replacement without first orphaning the transaction it displaced
    // raises 23505 and fails the job loudly, instead of quietly leaving two included transactions
    // that both claim to have spent one coin. A guard in the worker could not do this, because
    // the worker is exactly the thing that would be wrong.
    up: `
      create table if not exists spent_outpoints (
        chain            text    not null,
        network          text    not null,
        -- The outpoint being spent: the funding transaction and its output index.
        txid             text    not null,
        vout             integer not null,
        -- The transaction doing the spending.
        spending_tx_hash text    not null,
        block_height     bigint  not null,
        block_hash       text    not null,
        status           text    not null default 'included',
        constraint spent_outpoints_pk
          primary key (chain, network, spending_tx_hash, txid, vout),
        constraint spent_outpoints_chain_ck ${CHAIN_CK_AS_APPLIED_4_5},
        constraint spent_outpoints_network_ck ${NETWORK_CK_AS_APPLIED},
        constraint spent_outpoints_status_ck check (status in ('included','orphaned')),
        constraint spent_outpoints_vout_ck check (vout >= 0),
        constraint spent_outpoints_tx_fk foreign key (chain, network, spending_tx_hash)
          references transactions (chain, network, hash) on delete cascade
      );

      -- THE DOUBLE-SPEND INVARIANT. One canonical spender per outpoint, enforced by the database.
      create unique index if not exists spent_outpoints_canonical_uniq
        on spent_outpoints (chain, network, txid, vout)
        where status = 'included';

      -- The conflict lookup: given the outpoints an orphaned transaction spent, who spends them
      -- now. Leading on the outpoint because that is the predicate.
      create index if not exists spent_outpoints_outpoint_idx
        on spent_outpoints (chain, network, txid, vout);

      -- Widening a CHECK is an expand-only change: the previous release never writes the new
      -- value, so a replica still running it is unaffected, and this may therefore ship in one
      -- migration rather than four.
      alter table address_activity drop constraint if exists address_activity_status_ck;
      alter table address_activity add constraint address_activity_status_ck
        check (status in ('included','orphaned','conflicted'));
    `,
  },
  {
    version: 6,
    name: 'chain-check-converge',
    // ------------------------------------------------------------------------------------------
    // Bring every database's chain constraint back to ONE definition, whenever it was created.
    //
    // The defect this repairs: migration 1 spelled the chain list out by hand, `chains.ts` spelled
    // it out separately, and the two drifted when LTC was added to the type and not to the schema.
    // Every Litecoin address was refused by `watched_addresses_chain_ck` — an indexer that cannot
    // be told what to watch, which is the whole of its job.
    //
    // Both running estates were patched live. That is precisely why this migration is needed
    // rather than optional: a live `ALTER` fixes the databases that exist and nothing else, so
    // every environment provisioned afterwards would come up broken, and it would present as a
    // code bug rather than a schema one. This makes the two converge for good.
    //
    // Widening a CHECK is expand-only: the previous release never writes a value the new
    // constraint would reject, so a replica still running it is unaffected and this may ship in
    // one migration. Dropping first with `if exists` makes it idempotent and makes it work on a
    // database that was already patched by hand.
    //
    // THE DOMAIN BELOW IS FROZEN AT THE SIX CHAINS THIS SHIPPED WITH and is not `CHAIN_IDS`. It was
    // interpolated when it was written, which was the same mistake migrations 4 and 5 had just been
    // pinned to escape — see the constants at the head of this file. Migration 9 is where `etc` and
    // `doge` are allowed; this one is history and says what it said on the day.
    up: CHAIN_TABLES.map(
      (table) => `
      alter table ${table} drop constraint if exists ${table}_chain_ck;
      alter table ${table} add constraint ${table}_chain_ck ${CHAIN_CK_AS_APPLIED_6};
      alter table ${table} drop constraint if exists ${table}_network_ck;
      alter table ${table} add constraint ${table}_network_ck ${NETWORK_CK_AS_APPLIED};
    `,
    ).join('\n'),
  },
  {
    version: 7,
    name: 'utxo-custody-history',
    // ------------------------------------------------------------------------------------------
    // ONE NULLABLE COLUMN, AND IT IS THE WHOLE OF WHY A UTXO CUSTODY TOTAL MAY BE BELIEVED.
    //
    // `custody.ts` reads an EVM balance from the chain — `eth_getBalance` at the confirmed height,
    // which is the account's real balance whatever this service did or did not walk. Litecoin has
    // no such call. Stock Litecoin Core keeps no address index, so the only balance available for
    // an address the node's wallet does not own is one DERIVED from the outputs paying it minus the
    // outpoints spent from it, both of which are facts this service recorded while following.
    //
    // A derivation is exact only over a range that was actually walked, and it has two failure
    // modes with opposite signs:
    //
    //   * a gap in the walked record loses receipts (understates, positive drift, freeze) and loses
    //     spends (overstates, negative drift, freeze while solvent — the 2026-08-05 shape);
    //   * activity BELOW the earliest block this service ever walked is invisible entirely, and no
    //     amount of care inside the query can see it.
    //
    // The first is checkable here and is checked: contiguous canonical coverage from `lo` to the
    // confirmed height. The second is not knowable by this service at all, and the honest thing is
    // to be told rather than to assume. So an address may carry a CLAIM:
    //
    //     history_from_height = "this address had no chain activity below this height"
    //
    // That is a claim only its registrar can make, and it can make it truthfully in exactly one
    // situation: it has just derived the key, so nothing can have paid the address before now.
    // `micro-custody` derives, `micro-wallet` and `micro-settlement` register, and the watch route
    // takes `freshlyDerived: true` and stamps this service's own canonical head — a height it has
    // walked, so the coverage half of the proof is satisfied by construction.
    //
    // NULL means UNKNOWN, and unknown means the observation is refused (`history_unknown`). That is
    // not a migration that leaves work behind; it is the correct answer for every row that exists
    // today. Both `ltc:mainnet` deposit addresses on the live estate were registered by a build
    // that made no such claim, and no back-fill could invent one — the whole content of the column
    // is a statement about a moment that has passed. An operator who knows the funding history of a
    // specific address can state it deliberately, per address, and that is the only way it is ever
    // set retroactively.
    //
    // Nullable and defaulted to nothing, so this is expand-only: the previous release neither reads
    // nor writes the column, and a replica still running it is unaffected.
    up: `
      alter table watched_addresses
        add column if not exists history_from_height bigint;

      alter table watched_addresses drop constraint if exists watched_addresses_history_ck;
      alter table watched_addresses add constraint watched_addresses_history_ck
        check (history_from_height is null or history_from_height >= 0);

      -- The derivation's access path: every canonical inbound native movement for one address at
      -- or below a height. 'address_activity_lookup_idx' leads on the same three columns and would
      -- serve it, but it carries every direction and every status, so on a deposit address with a
      -- long outbound history the planner reads rows it then throws away. This one is the predicate
      -- exactly, and it is partial, so it costs almost nothing to keep.
      create index if not exists address_activity_utxo_credit_idx
        on address_activity (chain, network, address, block_height)
        where direction = 'in' and status = 'included' and asset_kind = 'native';
    `,
  },
  {
    version: 8,
    name: 'partial-block-index',
    // ------------------------------------------------------------------------------------------
    // ONE PARTIAL INDEX, AND IT IS WHAT MAKES A NARROWED ADDRESS RECORD RECOVERABLE INSTEAD OF LOST.
    //
    // Following one Litecoin block costs about 2 MB with indexes, and the largest part of it is
    // `address_activity` — written for every address the block touched, on purpose, because six
    // products wanted the general record. That cost tracks the chain's transaction volume and not
    // the number of customers: the watched set did not move across the measurement that produced
    // the number. A second UTXO chain on the same disk fills it, and an indexer out of disk stops
    // observing deposits on every chain at once.
    //
    // So a block may now be walked with only the watched addresses recorded, and when it is, it
    // says so in `blocks.detail` under the key `btcsource.ts` names. That marker is the difference
    // between a decision that can be revisited and one that cannot: a block written this way is
    // finished for the address set that was watched at the time, and adding an address later means
    // rescanning it. Without a way to FIND those blocks, "rescan them" is a full table scan of
    // every block this service has ever walked, which is the kind of answer that means the rescan
    // never happens.
    //
    // Partial, so it indexes only the blocks that need redoing and costs nothing on a deployment
    // that never turns the switch on. Leading on (chain, network, height) so that the question the
    // read API actually asks — the LOWEST height from which the record narrows, which is where an
    // answer about an unwatched address stops being trustworthy — is the first row of a scan rather
    // than an aggregate over the table.
    //
    // **The `watched_addresses` comment in migration 4 is now conditional, and it stays as written.**
    // It says `address_activity` is written for EVERY address a block touches. That is still the
    // behaviour with the switch off and is no longer the behaviour with it on, but the text of a
    // released migration is part of its checksum — editing it would make `migrate()` refuse the
    // whole set on every replica that has already applied it. The correction lives here, where a
    // reader walking the migrations in order reaches it after the claim it qualifies.
    //
    // Index-only and additive: the previous release neither writes the marker nor reads the index,
    // so a replica still running it is unaffected.
    up: `
      create index if not exists blocks_partial_idx
        on blocks (chain, network, height)
        where detail->>'partial' is not null;
    `,
  },
  {
    version: 9,
    name: 'chain-check-doge-etc',
    // ------------------------------------------------------------------------------------------
    // ADMIT `etc` AND `doge` TO THE CHAIN DOMAIN ON EVERY CHAIN-SCOPED TABLE.
    //
    // `contracts-chain` gained both assets, and `chains.ts` gained both slugs in the same change.
    // Neither of those touches the database. The domain the database actually enforces is whatever
    // the last migration wrote, which as of 2026-08-09 is migration 6's six chains — on the live
    // mainnet estate `blocks_chain_ck` reads
    //
    //     check (chain = any (array['ember','eth','btc','sol','xrp','ltc']))
    //
    // so a follower pointed at either new chain would authenticate, verify identity, fetch a block,
    // and then raise 23514 on the very first insert. Forever, on every tick, with the failure
    // arriving as a job error rather than as a configuration one — a shape that reads as "the
    // indexer is broken" rather than "the schema was never widened".
    //
    // ALL NINE TABLES, NOT JUST `blocks`. One follow tick writes the block, its transactions, its
    // logs or address activity, its spent outpoints, its checkpoint and its provider health inside
    // ONE transaction. Widening a subset does not buy a partial success, it buys the same 23514 one
    // statement later — and if the tables ever did commit separately, a block admitted while the
    // movement inside it was refused is the worst answer this service can give: a chain that looks
    // walked and is silently missing deposits. `CHAIN_TABLES` is the list, and it is the same list
    // migration 6 repaired, so "every table" cannot drift from "every table this service owns".
    //
    // Expand-only and therefore one migration rather than four: widening a CHECK cannot reject
    // anything the previous release writes, because the previous release has no slug for either
    // chain to write. Dropping first with `if exists` keeps it idempotent and lets it land on a
    // database an operator has already patched by hand, which is exactly how the LTC repair went.
    //
    // WHAT THIS DOES NOT DO. It does not follow either chain. `INDEXER_CHAINS` names neither, no
    // `INDEXER_RPC_DOGE_*` or `INDEXER_RPC_ETC_*` exists, and the estate runs no Dogecoin or
    // Ethereum Classic node — `env.ts` refuses a chain with no endpoint at boot, so the schema
    // widening cannot start anything on its own. It removes the reason following them would fail;
    // deciding to follow them is a deploy change, and a deliberate one.
    up: CHAIN_TABLES.map(
      (table) => `
      alter table ${table} drop constraint if exists ${table}_chain_ck;
      alter table ${table} add constraint ${table}_chain_ck ${CHAIN_CK_AS_APPLIED_9};
    `,
    ).join('\n'),
  },
  {
    version: 10,
    name: 'rewalk-narrowed-evm-headers',
    // ------------------------------------------------------------------------------------------
    // ENQUEUE A RE-WALK OF EVERY EVM BLOCK WHOSE HEADER WAS STORED AS FOUR HAND-PICKED FIELDS.
    //
    // Until micro-org#395 `evm.ts` reduced every header to `miner`, `gasUsed`, `gasLimit` and
    // `difficulty` before it reached `blocks.detail`. Everything else the node sent — `stateRoot`,
    // `parentHash`, `receiptsRoot`, `transactionsRoot`, `logsBloom`, `extraData`, `nonce`,
    // `mixHash` — was discarded at extraction, so it is not merely unqueried, it is NOT IN THIS
    // DATABASE. `micro-explorer-web` renders `detail` under a heading reading "the header, exactly
    // as the node gave it", which made a curated list a promise this schema could not keep.
    //
    // The field that makes it worth a migration rather than a note is `stateRoot`. On an
    // account-model chain a premine lives in the genesis allocation, the genesis header commits to
    // that state root, and so block 0's `stateRoot` is the ONLY cryptographic evidence that nobody
    // held a balance before the first block was mined. EMBER's is the canonical empty-trie root.
    // The code fix serves it for every block walked from now on and can do nothing at all for
    // 13,946 blocks already stored, which includes the one block anybody would come to check.
    //
    // NO SQL CAN INVENT THE MISSING BYTES. They only exist on the node, so the repair is to walk
    // those heights again — and the machinery for walking a range again already exists and is
    // driven by a row in this table. `store.ts:ensureBackfill` writes exactly the row below, the
    // `indexer.backfill` job drains it on its own lease and its own checkpoint stream, and
    // `upsertBlock`'s `on conflict (chain, network, hash) do update set detail = excluded.detail`
    // is what makes a second walk rewrite the header rather than collide with it. So this migration
    // enqueues work rather than doing any, which is also what keeps it off the deploy's critical
    // path: a one-shot migrator that walked a chain would hold the advisory lock for hours.
    //
    // Re-indexing emits NOTHING. `#indexBlock` publishes `deposit.observed` only for a movement
    // whose `address_activity` insert actually inserted, so a re-walk of 13,946 blocks produces
    // zero duplicate events for `micro-wallet` or `micro-settlement` to reconcile. That property is
    // the reason a blanket re-walk is a safe repair and not a customer-visible one.
    //
    // ── BOUNDED, AND THE BOUND IS 20,000 BLOCKS PER SCOPE ───────────────────────────────────────
    //
    // Sized to cover EMBER whole and nothing else whole. Mainnet stood at 13,946 blocks and testnet
    // at 7,970 on 2026-08-11, so both re-walk from genesis, which is the case the ticket is about.
    // An `eth` or `etc` follower has no such luck: those chains are in the tens of millions of
    // blocks, one `eth_getBlockByNumber` plus receipts each, and an unbounded range would be a
    // months-long re-walk enqueued by a schema migration that nobody asked for. The most recent
    // 20,000 blocks is the window in which a header is still being looked at.
    //
    // The bound is a LITERAL and this migration will not grow with the chain. A scope past 20,000
    // blocks when it lands keeps narrow headers below the window, permanently, until somebody
    // enqueues more — `POST /v1/backfills/:chain/:network` takes an explicit range and is the
    // supported way to say so. `not jsonb_exists(detail, 'stateRoot')` is what finds them:
    //
    //     select chain, network, min(height), max(height), count(*) from blocks
    //      where chain in ('ember','eth','etc') and not jsonb_exists(detail, 'stateRoot')
    //      group by chain, network;
    //
    // `jsonb_exists(detail, 'stateRoot')` rather than `detail ? 'stateRoot'` because the operator
    // spelling is a question mark inside a string that several drivers rewrite as a placeholder,
    // and a migration is not the place to find out which.
    //
    // EVM CHAINS ONLY, PINNED AS A LITERAL, for the reason every domain in this file is a literal:
    // a checksummed artefact contains no value that can change. Bitcoin-family and Solana headers
    // were never narrowed — `bitcoin.ts` and `solana.ts` pick fields deliberately from formats that
    // are not one flat header — so re-walking them would be cost with no repair behind it.
    //
    // ── THIS IS THE ONE MIGRATION HERE THAT IS NOT INDIFFERENT TO RELEASE ORDER ─────────────────
    //
    // It adds no column and drops none, so a replica on the previous release cannot fail on it. It
    // can, however, DRAIN the range with the narrowing code still in it: the blocks would be
    // rewritten exactly as narrow as they are now and the checkpoint would reach `range_to`, after
    // which nothing re-enqueues it and the repair is silently spent. The estate's migrator is a
    // one-shot job from the same image tag as the service, so in practice the code that drains this
    // is the code that shipped it — and if that assumption ever fails, the recovery is the `select`
    // above followed by the backfill route, not another migration.
    up: `
      insert into checkpoints (chain, network, stream, height, range_from, range_to)
      select scope.chain,
             scope.network,
             'backfill:' || greatest(scope.lowest, scope.highest - 19999) || '-' || scope.highest,
             null,
             greatest(scope.lowest, scope.highest - 19999),
             scope.highest
        from (
          select chain, network, min(height) as lowest, max(height) as highest
            from blocks
           where chain in ('ember','eth','etc')
             and status <> 'orphaned'
             and not jsonb_exists(detail, 'stateRoot')
           group by chain, network
        ) as scope
      on conflict (chain, network, stream) do nothing;
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the
 * old schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted.
 *
 * Every service in the estate today creates its tables with inline `CREATE TABLE IF NOT EXISTS`
 * at boot and has no `schema_migrations` table at all. Setting `BASELINE_VERSION` to the migration
 * that describes what is already there records those migrations as applied without running them,
 * and only ever does so on a database with no migration rows.
 *
 * The indexer is a new service against a new database, so it is zero and stays zero. There is
 * nothing to adopt: balance-probing kept no chain data to inherit — that absence is the whole of
 * 00-current-state §3.4.
 */
export const BASELINE_VERSION = 0

