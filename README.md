# `micro-indexer`

[![ci](https://github.com/cloudsforge-online/micro-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-indexer/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

Follows chains and answers questions about what is on them: blocks, transactions, logs, per-address
movements, token balances at a height, the confirmation depth of one transaction, and one token's
supply and authorities as its contract reports them. It replaces the estate's balance-probing
deposit watcher, whose `let inFlight = false` is the reason two of its ticks can observe different
totals for one address (`src/jobs.ts:6-9`).

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

> **Reads need no token; writes do.** Every read here answers with a chain fact anyone can obtain
> by running a Hearth node, and this service stores nothing linking an address to a person — so
> there was no privacy for an auth check to protect. It used to require `indexer:read` or admin on
> all nine routes, which meant `micro-explorer-web` could render nothing to the public and a public
> chain had a paywalled explorer. `/watch` and `/backfills` still require `indexer:write`: they
> spend provider calls and change what this service does rather than reporting what it knows.
>
> A token that IS presented is still verified — a broken one is a 401 and a service without
> `indexer:read` is a 403, because silently downgrading a bad credential to anonymous would hide
> the misconfiguration it signals. See `authoriseRead` in `src/server.ts`.
>
> **It holds no money and no ownership.** A user token reaches this service as an **operator**:
> `authorise()` accepts a service principal with the right scope, and otherwise requires `admin`
> (`src/server.ts:679-697`). The header states why — "ownership of an address is a fact `wallet`
> holds, so the indexer must not be the place that guesses at it" (`src/server.ts:693-694`).

> **It stores no confirmation count.** There is no `confirmations` column anywhere, although
> 04-domain-model §4.2 lists the field: a stored count is stale the moment the next block is mined,
> and a crediting decision taken against a stale one is the exact failure the depth exists to
> prevent (`src/migrations.ts:38-43`). It is computed at read time, every time.

> **One read, and only one, leaves the database.** Every other answer here is assembled from rows
> this service wrote. `GET /tokens/…` is contract state — supply, cap, owner, paused — which exists
> nowhere but in the contract's own storage, so it is `eth_call`, at the head this service has
> walked, after the node has been made to prove it still serves that block (`src/tokenstate.ts:207-218`).
> It was added because `micro-mint` had no other way to satisfy 04-domain-model §5.3, and the
> alternative — mint reading a chain itself — is what AD-07 exists to prevent. What is still refused
> is `micro-market`'s token *facts*: keyed by a mint item URN this service has no registry for, and
> needing complete holder history a follower that cold-starts at `tip − 2 × depth` does not have.

> **It refuses to answer a balance it cannot prove.** When the canonical chain this service holds
> does not run unbroken from genesis to the asked height, `balances` and `balance` are **absent —
> not zero, not null** (`src/reads.ts:226-233`). An indexer that started following at the tip knows
> nothing about what anybody held, and a zero would be a lie in the shape of an answer.

---

## Reorg safety is the whole job

### 1. Exactly one block per canonical height, enforced by the schema

```sql
create unique index if not exists blocks_canonical_height_uniq
  on blocks (chain, network, height)
  where status <> 'orphaned';
```

A **partial** unique index over the non-orphaned rows (`src/migrations.ts:155-157`). Inserting a
replacement block without first orphaning the incumbent raises 23505 rather than quietly leaving two
blocks claiming height N. The file calls it "the single most valuable constraint in this file: it
makes a wrong reorg implementation fail loudly instead of corrupting history"
(`src/migrations.ts:32-36`).

It is in the schema rather than in the reorg handler for the obvious reason: the handler is the
thing being checked. A guard inside `orphanAbove` would be a reorg implementation checking itself.

### 2. A retraction is one transaction across four tables

`orphanAbove` marks blocks, transactions, logs and `address_activity` orphaned above the common
ancestor in one call, and **clears `confirmed_at`** while doing it (`src/store.ts:345-374`). The
reason is stated at `src/store.ts:342-343`: a confirmation is a statement about depth on the
canonical chain, and the canonical chain no longer contains this movement. A movement that comes
back updates rather than duplicating, and `indexer.deposit.confirmed` fires again once it re-reaches
depth (`src/store.ts:285-288`).

### 3. An alarming reorg halts the chain, and only a human clears it

`halted` lives on the `tip` checkpoint row and is a property of the **chain**, not of the stream
(`src/migrations.ts:288-292`, column at `:306`). `isReorgAlarming` from `contracts-chain` decides,
and the decision is **recorded on the `reorgs` row rather than recomputed**, so the row still says
what the policy was on the day after the policy changes (`src/migrations.ts:328-330`). Only an
operator clears the halt, "because the whole point of the alarm is that an assumption the
confirmation depth encodes has failed and a machine cannot decide it has stopped".

### 4. `confirmed` requires `status = 'success'`, not merely depth

```
confirmed: canonical && record.status === 'success' && !record.halted
           && confirmations !== null && creditable(scope.chain, confirmations)
```

`src/reads.ts:462-472`. The comment above it is the argument: **an EVM transaction that reverted is
mined, sits in a block, and accumulates depth exactly like one that worked** — so a confirmation
test that only counted blocks would tell a marketplace that a failed escrow deposit is confirmed.

### 5. A read that would straddle a reorg takes one snapshot

`confirmation` is a **single statement**, deliberately: two round trips can straddle a reorg and
count a retracted transaction against a head that has already moved past it
(`src/reads.ts:432-434`). `tokenBalances` is a **`REPEATABLE READ` transaction**, because coverage,
head and movements are three statements and under `READ COMMITTED` each gets its own snapshot — a
reorg landing between them yields movements from *after* the retraction summed against a coverage
claim from *before* it. One snapshot makes the answer a statement about one state of the chain,
"which is the only kind of statement worth making about money" (`src/reads.ts:474-480`).

### 6. Head, not tip — but only on two reads, and this matters

`head_height` is **the highest canonical block this indexer has stored**, not
`checkpoints.tip_height`, which is only what a provider last claimed (`src/store.ts:1072`). Counting
against blocks nobody here has looked at over-reports depth, and **over-reporting depth credits
early** (`src/reads.ts:23-27`).

**That rule holds for `confirmation` and `tokenBalances` and not for the other reads**, and the
distinction is easy to lose:

| Read | Counts against | Line |
| --- | --- | --- |
| `GET …/transactions/:hash/confirmations` | stored canonical **head** | `src/reads.ts:443-444` |
| `GET …/token-balances` | stored canonical **head**, in one `REPEATABLE READ` snapshot | `src/reads.ts:474` |
| `GET …/addresses/:address/activity` | `checkpoint.tipHeight` — the **provider-claimed tip** | `src/reads.ts:345`, `:355` |
| `GET …/transactions/:hash` | `checkpoint.tipHeight` — the **provider-claimed tip** | `src/reads.ts:397`, `:415-418` |
| `GET /tokens/…` | stored canonical **head**, *and* the node must still serve that block hash | `src/tokenstate.ts:196-218` |

`src/reads.ts:18-30` scopes its own claim correctly ("Two reads that exist because a consumer was
blocked"). Two other documents state it unqualified, and both are wrong as written — see
[Known gaps](#known-gaps). The two head-based reads are the ones a crediting decision goes through,
which is why they were the ones built that way; a consumer taking a *money* decision should use
`/confirmations`, not the `confirmed` flag on an activity row.

### 7. A state read at the head is not enough; the head has to be proved

`GET /tokens/…` is the only read here that asks a third party a question, and that changes what
"at the head" can mean. The five reads above answer out of rows this service owns, so the head is
whatever this service stored. A contract-state call names a **height** to a node, and after a reorg
the node has a different block at that number — so the height alone would attribute a supply figure
to a block this service never walked.

So the node's block at the head height is fetched first and its hash compared with the stored one
(`src/tokenstate.ts:208-218`) — the same check `src/evm.ts` makes at the start of every follow tick.
A mismatch returns **no observation at all**: 503 `head_diverged`, which is an honest "ask again in
a moment". EIP-1898 would fold that into the call itself by passing the block *hash*; it is not used
because the providers this pool fails over between do not all implement it, and a read that works on
one provider and fails on the next is a read whose answer depends on the weather
(`src/tokenstate.ts:48-51`).

A **halted** chain is reported here rather than refused, unlike `token-balances`
(`src/reads.ts:529-532`). That answer is derived from the whole history a halt says cannot be
vouched for; this one depends on exactly one block, and the hash check has just proved the node
still serves it (`src/tokenstate.ts:53-57`).

---

## Routes

Read out of `src/server.ts`. **Every domain route is served twice — once under `/v1` and once
unprefixed** (`src/server.ts:134`, mounted at `:374-378`). `/v1/…` is the estate convention and the
one to use; the unprefixed form is the spelling in the indexer's own specification and in the
operator runbooks written against it, and serving both costs one loop rather than a redirect every
internal caller would have to follow (`src/server.ts:127-133`).

No route on this service takes an `Idempotency-Key`; the word does not appear in the repository
outside the outbox relay.

| Method | Path (also under `/v1`) | Who | What it does |
| --- | --- | --- | --- |
| `GET` | `/livez` | **no auth** | **static, deliberately** — a liveness probe that consults a dependency restarts a healthy process every time the database blinks, turning a brief outage into a rolling restart of the whole estate (`src/server.ts:340`, reasoning at `:342-347`) |
| `GET` | `/readyz` | **no auth** | 200/503. A **soft** probe failure leaves the report degraded but still ready, because taking a whole product out of rotation over a non-essential upstream is worse than serving without it (`src/server.ts:350`) |
| `GET` | `/metrics` | **no auth** | Prometheus text (`src/server.ts:357`) — see Known gaps |
| `GET` | `/chains/:chain/:network/status` | **anonymous** | checkpoint, lag, provider health, recent reorgs, halt state (`src/server.ts:384`, auth at `:385`) |
| `GET` | `/addresses/:chain/:network/:address/activity` | **anonymous** | paged movements. Confirmations here are against the **tip** (`src/server.ts:396`, auth at `:397`) |
| `GET` | `/addresses/:chain/:network/:address/token-balances` | **anonymous** | balances at a height, **absent unless coverage is complete** (`src/server.ts:463`, auth at `:464`) |
| `GET` | `/transactions/:chain/:network/:hash` | **anonymous** | one transaction with its logs (`src/server.ts:412`, auth at `:413`) |
| `GET` | `/transactions/:chain/:network/:hash/confirmations` | **anonymous** | **the crediting decision input**: `canonical`, `confirmations` against the head, `requiredConfirmations`, `confirmed`, `halted` (`src/server.ts:437`, auth at `:438`) |
| `GET` | `/tokens/:chain/:network/:address` | **anonymous** | **contract state, read from the chain**: `name`, `symbol`, `decimals`, `totalSupply`, `cap`, `owner`, `mintAuthority`, `paused`, and the block it was observed at (`src/server.ts:493`, auth at `:494`) |
| `GET` | `/blocks/:chain/:network/:height` | **anonymous** | one canonical block with its transactions (`src/server.ts:514`, auth at `:515`) |
| `POST` | `/watch/:chain/:network/:address` | `indexer:write` or admin | registers an address to be watched; records who asked (`src/server.ts:531`, auth at `:532`, attribution at `:545`) |
| `POST` | `/backfills/:chain/:network` | `indexer:write` or admin | opens a historical backfill stream (`src/server.ts:553`, auth at `:554`) |

**`GET /tokens/…` answers with five statuses, and the difference between two of them is the whole
point.** A caller that cannot tell "there is no token there" from "I could not ask" will render the
first when it means the second — which is exactly what `micro-mint` did on every project page.

| Status | Code | Means |
| --- | --- | --- |
| 200 | — | the contract answered. Every field is nullable, and a null means **the contract does not implement that function** — a fixed-supply token has no `owner()`, `cap()` or `paused()` (`src/tokenstate.ts:101-109`) |
| 404 | `token_not_found` | this service asked the chain and there is no contract answering `totalSupply()` at the block it has walked. A deployment above the head reads as this, and that is honest (`src/server.ts:503-506`) |
| 404 | `not_found` | **the router's**, not this route's: a path this service does not serve. Nothing to do with any chain (`src/server.ts:234-241`) |
| 503 | `chain_not_followed` · `nothing_indexed` · `head_diverged` · `rpc_unavailable` | we could not ask, and which of the four (`src/server.ts:274-283`) |
| 501 | `family_not_supported` | this build cannot read contract state on that family at all, and retrying will not change it |

**Three routes make no `authorise()` call**: `/livez`, `/readyz`, `/metrics`. They are the only
ones — every domain route authorises on its first line.

`requiredConfirmations` travels with **every** answer, from `contracts-chain`. A consumer must never
have to hardcode a depth to interpret this API (`src/reads.ts:13-16`).

Amounts leave as **decimal strings**. `JSON.stringify` cannot serialise a `bigint`, and the obvious
repair — `Number(amount)` — silently loses the low digits of any 18-decimal value above about 9 ETH
(`src/reads.ts:8-11`). A **token's** amount is deliberately left unformatted, because its decimals is
a call to the contract and a fact a token registry owns; guessing eighteen is how a six-decimal
stablecoin gets displayed a million times too small (`src/reads.ts:366-369`).

---

## Background work

Leased jobs only; no `setInterval` does domain work. **The lease key names the contended resource**
(`src/jobs.ts:11-31`).

| Job | Lease key | Cadence | What two replicas do |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | 1s | one claims; keying on the event id would let two relays deliver one batch twice (`src/jobs.ts:66`) |
| `indexer.follow` | `<chain>:<network>` | 1.5s | one follows that chain. The contended resource is the **checkpoint**, and behind it the canonical-height uniqueness index. Keying on block height would let two followers reorg-repair one chain concurrently, one rewinding while the other indexes forward past the rewind — **the one race in this service that idempotent writes do not save you from** (`src/jobs.ts:68`, reasoning at `:20-26`) |
| `indexer.backfill` | `<chain>:<network>` | 2s | its own key, separate from the follower's, because they write different checkpoint streams and **a backfill must never block the tip** (`src/jobs.ts:69`, reasoning at `:27-31`) |

Both indexer jobs are safe on N replicas: the lease decides which runs and every write underneath is
idempotent, so a lease lost mid-tick costs duplicated RPC traffic and nothing else
(`src/jobs.ts:33-35`). Each tick calls `ctx.heartbeat()` so a long catch-up does not outlive its
lease and hand the same heights to a second replica (`src/jobs.ts:159-160`).

The follower's 1.5s interval is **well under** Hearth's fifteen-second block time on purpose: the
interval bounds how stale the lag gauge can be, not how fast the chain is followed — one tick
indexes up to `INDEXER_FOLLOW_BATCH_BLOCKS` blocks (`src/jobs.ts:61-63`).

Provider health is written **whatever happened**, because the tick that failed is the one whose
provider state an operator wants to see (`src/jobs.ts:143-145`). A `NotImplementedError` from an
unwritten chain family is rethrown so the job **dead-letters** rather than retrying five times a
second: the dead row *is* the record that the deployment configured a chain this build cannot serve
(`src/jobs.ts:161-172`). A dead-lettered recurring job is deliberately not re-armed
(`src/jobs.ts:91-95`).

---

## The database

`blocks`, `transactions`, `logs`, `address_activity`, `checkpoints`, `reorgs`, `provider_health`,
`watched_addresses`, plus `jobs`/`outbox`/`inbox`. Migrations in `src/migrations.ts`, run only by
`src/migrator.ts`.

Three storage decisions carry the design (`src/migrations.ts:14-36`):

1. **One table per concept, not per chain family.** Five tables would be five reorg implementations
   and five sets of joins for every consumer. What an EVM transaction calls a nonce and XRP calls a
   sequence is one column, because every consumer asks the same question of it
   (`src/migrations.ts:163-165`).
2. **No query may span networks.** `chain` and `network` are the leading columns of every primary
   key, every foreign key is composite and includes both, and a check constraint pins the domain of
   both. A `log` cannot reference a `transaction` on another network **even if someone writes the
   join wrongly**, because the reference itself carries the network. This is a live defect class:
   XRP shares one address across testnet and mainnet, and a signed Payment is submittable on either
   (`src/migrations.ts:24-30`).
3. **One block per canonical height** — above.

| Constraint | Refuses | Why it is here rather than in a handler |
| --- | --- | --- |
| `blocks_canonical_height_uniq` (partial, `where status <> 'orphaned'`) | two live blocks at one height | it makes a **wrong reorg implementation** fail loudly. The handler is the thing being checked, so the check cannot live in it (`src/migrations.ts:155`) |
| `${CHAIN_CK}` / `${NETWORK_CK}` on **every** chain table | a sixth chain, or a third network, minted by a typo | one constant applied everywhere, so a new chain is a deliberate edit rather than a value that slips in (`src/migrations.ts:51-52`) |
| composite FKs carrying `(chain, network)` — `transactions_block_fk`, `logs_tx_fk`, `address_activity_tx_fk` | a cross-network reference | the reference itself carries the network, so a mis-written join cannot produce one (`src/migrations.ts:195`, `:223`, `:273`) |
| `transactions_block_ck check ((block_hash is null) = (block_height is null))` | half-known block placement | a transaction is either in a block or pending; "in a block whose height we do not know" is not a state (`src/migrations.ts:194`) |
| `address_activity_token_ck check ((asset_kind = 'token') = (token_address is not null))` | a token movement with no contract, or a native one with a contract | the two columns are one fact and the constraint says so (`src/migrations.ts:269-270`) |
| `address_activity_uniq (chain, network, tx_hash, entry_key)` | a duplicated movement on replay | **this is what makes every write idempotent**, which is what makes a lost lease cost only RPC traffic (`src/migrations.ts:272`) |
| `checkpoints_range_ck` / `checkpoints_range_order_ck` | a half-specified or inverted backfill range | (`src/migrations.ts:312-313`) |
| `reorgs_depth_ck check (depth > 0)` | a zero-depth reorg | a reorg of depth 0 is not a reorg; recording one would inflate the alert (`src/migrations.ts:337`) |
| `checkpoints.height` **nullable**, no zero sentinel | — | null means "nothing indexed on this stream yet". A zero would be indistinguishable from having indexed the genesis block, which on a chain whose genesis carries an allocation is a real and different statement (`src/migrations.ts:297-300`) |
| `provider_health` stores **only the host**, never the URL | — | an RPC provider's API key lives in the query string, and a table an operator reads over the shoulder of a screen share is not where it belongs (`src/migrations.ts:342-345`) |

---

## Configuration

`.env.example` and `src/env.ts` were cross-checked and **agree**: every variable `loadEnv` reads is
present, and the two extra entries in the file (`INDEXER_TEST_DATABASE_URL`,
`INDEXER_HEARTH_RPC_URL`) are commented out and read only by the suite
(`src/hearth.test.ts:36`).

Two validations here have no equivalent in the service template, and both exist because **a follower
with no provider reports healthy and indexes nothing** — the exact failure mode of the
balance-probing this service replaces (`src/env.ts:18-21`):

* a chain named in `INDEXER_CHAINS` **must** have an RPC variable (`src/env.ts:259-264`);
* an `INDEXER_RPC_*` variable whose scope is **not** in `INDEXER_CHAINS` is a boot failure — the
  mirror check, because an operator who sets `INDEXER_RPC_ETH_MAINNET` and forgets to add it to the
  list has configured a chain that is never followed and nothing would say so
  (`src/env.ts:282-292`).

| Variable | Default | If it is wrong or missing |
| --- | --- | --- |
| `PORT` | `4008` | must be a TCP port (`src/env.ts:295`) |
| `NODE_ENV` | `development` | labelling only (`src/env.ts:296`) |
| `LOG_LEVEL` | `info` | outside the four levels, boot fails (`src/env.ts:251`) |
| `CLOUDSFORGE_TAG` | `dev` | the reported version is wrong (`src/env.ts:297`) |
| `INDEXER_DATABASE_URL` | — | **required** (`src/env.ts:299`). Rule 1 — CI greps for a second connection string |
| `INDEXER_DATABASE_POOL_MAX` | `10` | integer 1–200 (`src/env.ts:300`) |
| `IDENTITY_JWKS_URL` | — | **required**. Unreachable at runtime → every domain route answers 503, not 401 (`src/env.ts:301`) |
| `IDENTITY_ISSUER` | — | **required**. Wrong → the whole surface is 401 (`src/env.ts:302`) |
| `OUTBOX_SIGNING_SECRET` | — | **required, ≥24 chars, placeholders refused.** Shipped **empty** in `.env.example`, so a copied file refuses to boot until it is filled — deliberate (`src/env.ts:303`) |
| `INSTANCE_ID` | hostname | names this replica in `jobs.locked_by` (`src/env.ts:304`) |
| `INDEXER_CHAINS` | `` (none) | `<chain>:<network>` pairs. **Empty is legal**: a replica may serve reads and follow nothing (`src/env.ts:222-223`). A duplicate entry is a boot failure |
| `INDEXER_RPC_<CHAIN>_<NETWORK>` | — | **required for each configured chain.** `name=url` pairs in preference order; the pool reorders by health and declaration order breaks ties. **The name is the primary key of `provider_health` and the `provider` metric label**, so two endpoints at one host must be named by hand rather than collapsing into one health row that averages a working provider with a broken one (`src/env.ts:183`, reasoning at `:175-182`). Only the **host** is ever stored or logged |
| `INDEXER_START_HEIGHT_<CHAIN>_<NETWORK>` | tip − 2× the confirmation depth | where a cold start begins. The default is the smallest window that can still watch a deposit through its whole confirmation life; **older history is a backfill job, not a cold start**, because a cold start that walks five million blocks before it serves anything is a service that is never ready (`src/env.ts:265-274`, reasoning at `:118-126`) |
| `INDEXER_FOLLOW_BATCH_BLOCKS` | `25` | 1–500. **A tick must finish inside its lease.** Raising this without raising the lease hands the same heights to a second replica; every write is idempotent, but the duplicated RPC traffic is what gets a provider to rate-limit us (`src/env.ts:306`, reasoning at `:151-157`) |
| `INDEXER_BACKFILL_BATCH_BLOCKS` | `50` | 1–1000; separate because backfill is allowed to be slower (`src/env.ts:307`) |
| `INDEXER_RPC_DEADLINE_MS` | `8000` | 250–120000; the absolute wall-clock ceiling for one RPC call across the transport's own retries (`src/env.ts:308`) |
| `INDEXER_TEST_DATABASE_URL` | — | tests only; unset, every database-backed test skips |
| `INDEXER_HEARTH_RPC_URL` | `http://127.0.0.1:8545` | tests only (`src/hearth.test.ts:36`) |

A configuration failure is one hand-built structured `fatal` line to stderr. Note that
`parseEndpoints` names endpoints, **never URLs**, because an RPC URL's query string is where a
provider API key lives (`src/env.ts:312-321`).

---

## What it talks to

| Upstream | What it calls | When it is down |
| --- | --- | --- |
| the configured **RPC endpoints** | JSON-RPC, through a health-ordered pool with a per-call deadline (`src/rpc.ts`) | **fail closed for indexing, open for reads.** The follower tick fails, `indexer_provider_failures_total{provider}` increments, `provider_health` records it, and `indexer_lag_blocks` climbs — which is a paging signal in 13-operational-model. Already-indexed data keeps being served, correctly: a stale answer with an honest `tipHeight` beats no answer |
| `micro-identity` | its JWKS at `IDENTITY_JWKS_URL` (`src/index.ts:189`) | **soft readiness probe**, so this replica stays in rotation. Domain routes answer 503 rather than 401 while the verifier is unreachable |
| `event_subscriptions` rows | signed HMAC deliveries from the outbox relay | fail open, per subscriber; the undelivered row is the durable record |

Downstream consumers that this service was extended for: `micro-market`'s escrow gate
(`/confirmations`) and `micro-community`'s token-gating job (`/token-balances`) — both recorded at
`docs/ecosystem/18-build-status.md` §3.3j — and now `micro-mint`'s project pages (`/tokens/…`),
which are the §3.3i case: its client asked for `/v1/chains/:chain/:network/tokens/:address`, a route
nothing served, and read the 404 as "not yet indexed" for ever. `micro-mint`'s CI parses the route
table out of `src/server.ts:153-163` and fails if any path it requests is not one this service
serves, so **renaming a route here turns that repository's CI red**. The table's shape — one entry
per line, method and path as single-quoted literals — is load-bearing for that reason
(`src/server.ts:136-152`). `micro-wallet` composes this service with `ledger` and `custody`.

---

## Running it

```bash
pnpm install
pnpm typecheck

# Migrations are a one-shot job and are NEVER run by the service process.
INDEXER_DATABASE_URL=postgres://indexer:indexer@127.0.0.1:55434/indexer pnpm migrate
pnpm start
```

The suite needs a real Postgres whose database name contains `test`:

```bash
docker run -d --rm --name indexer-pg \
  -e POSTGRES_USER=indexer -e POSTGRES_PASSWORD=indexer -e POSTGRES_DB=indexer_test \
  -p 55434:5432 postgres:17-alpine

INDEXER_TEST_DATABASE_URL=postgres://indexer:indexer@127.0.0.1:55434/indexer_test pnpm test
```

**130 `test(` declarations**, `node:test` only. **Three of them are environmental skips**
(`src/hearth.test.ts:113`, `:123`, `:164`) and need a **live Hearth node** at
`INDEXER_HEARTH_RPC_URL` (default `http://127.0.0.1:8545`). They skip cleanly when the node is
unreachable, because a developer without a local chain must get a green run
(`src/hearth.test.ts:16`) — but a green run without a node has **not** exercised the real chain, and
that is worth knowing before treating the suite as complete. Everything else runs against the
database.

CI is the estate's reusable `service-ci.yml` and fails the build if the database-backed suite
skipped.

---

## Known gaps

* **Two documents over-generalise the head-versus-tip rule, and both are wrong as written.**
  * `docs/ecosystem/18-build-status.md:95` says confirmations count against the stored canonical
    head "never the provider-claimed tip", unqualified. True of `/confirmations` and
    `/token-balances`; **false of `/activity` and `/transactions/:hash`**, which read
    `checkpoint.tipHeight` (`src/reads.ts:345`, `:397`).
  * `src/migrations.ts:43` says the reverse — that confirmations are derived "from
    `checkpoints.tip_height`" — which was true before §3.3j added the two head-based reads and is
    now half wrong.

  `src/reads.ts:18-30` is the accurate statement. **Both are reported, not edited**: this task's
  remit is this repository's README, and `src/migrations.ts` is a released migration file whose text
  is checksummed.
* **A token observation is up to nine RPC calls and nothing caches it.** One
  `eth_getBlockByNumber` for the head-identity check, one `eth_getCode`, and one `eth_call` per
  field (`src/tokenstate.ts:207-236`). `cache-control: no-store` is estate-wide and right — a
  cached supply is the lie this route exists to stop telling — but a hot project page multiplies
  that traffic against the provider. Recorded rather than pre-optimised: no measurement exists yet,
  and the honest fix is a short-lived cache keyed by the observed block hash, which is already in
  the answer.
* **`/tokens/…` is the one read that needs a provider**, so a replica configured with no
  `INDEXER_RPC_*` for a chain answers 503 `chain_not_followed` for it while still serving every
  other read from the database (`src/index.ts:212`, `src/tokenstate.ts:185-193`). That is deliberate
  — a read-only replica is a supported deployment — but it means the token route's availability is
  not the same as the service's.
* **`mintAuthority` over-reports rather than under-reports.** A contract with an `owner()` and no
  mint function is reported as having mint authority. The error direction is chosen: a false
  "somebody can still mint" makes a buyer more careful, and the opposite mistake is the one that
  costs them money (`src/tokenstate.ts:274-279`).
* **Three tests need a live chain.** See above. A CI run with no Hearth node reports green having
  skipped every real-chain assertion.
* **Not every chain family is implemented.** `NotImplementedError` carries a `family` and a `phase`
  (`src/jobs.ts:161-169`); a deployment that names an unimplemented chain in `INDEXER_CHAINS` gets a
  dead-lettered follow job rather than a boot failure. The dead row is the record, and
  `jobs_overdue` is what surfaces it.
* **`/metrics` is unauthenticated** (`src/server.ts:357`), unlike `micro-beacon`'s. Anything that
  can reach the port can read `indexer_lag_blocks`, `indexer_tip_height` and the reorg counters.
* **`confirmed` on an activity row is depth-only.** Unlike `/confirmations`, it does not require
  `status = 'success'` and does not consult `halted` (`src/reads.ts:381-382` versus `:462-472`). A
  consumer taking a money decision should use `/confirmations`.
* **The unversioned spelling is permanent.** Both `/v1/…` and bare paths are served
  (`src/server.ts:134`); the estate has no gateway route map, so nothing decides which is public
  (`docs/ecosystem/18-build-status.md` §3.3d, items 2–3).
* **Ledger reconciliation is not wired to this service.** `micro-ledger`'s
  `reconciliation_runs.observed_source` has an `indexer` value and its job never supplies one, so
  every production reconciliation run compares the ledger against itself. Adding this service as the
  observed side is a caller, not a migration.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
