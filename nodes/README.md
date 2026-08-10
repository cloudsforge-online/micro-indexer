# The chain daemons: what they are for, and what they are deliberately not allowed to do

The estate observes Bitcoin, Litecoin and Dogecoin through daemons it runs **itself**, on its own
hardware. There is no third party between this estate and the ledgers it credits from, which is
the constraint the owner set and the reason this directory exists.

The configuration in `bitcoin.conf`, `litecoin.conf` and `dogecoin.conf` is the source of truth for
that posture. Every non-default setting is there because of something that goes wrong without it.
**If you are about to change one of these, the reasoning is below — please read it first.** Each of
these looks like a tightening that could be relaxed, and each is load-bearing.

## First: these three files are the ones actually running

Each was read back off the daemon on the chain host on 2026-08-11 and matches it, with the
`rpcauth` placeholder as the only difference. That is a new property, not a standing one.

Before micro-org#373 item 8 it was false and had been for weeks: `bitcoin.conf` here said
`txindex=0`, `dbcache=450`, `par=1` and "loopback only" while the daemon ran `txindex=1`,
`dbcache=3000`, `par=0` and four binds; `litecoin.conf` was wrong on four settings; and
`dogecoin.conf` did not exist at all although the daemon had run since 2026-08-09. A review then
read this directory as ground truth and reasoned from it, which is exactly the failure a file like
this is supposed to prevent rather than cause.

So: **if you change a daemon, change the file in the same hour.** A config nobody reads is
harmless. A config that is trusted and wrong sends the next person somewhere real.

---

## `listen=0` — never accept inbound connections

Ingress to this estate is a Cloudflare Tunnel. There is no static IP and no reachable inbound port,
so this node **cannot** serve other peers no matter what it advertises.

Leaving `listen=1` would have the node gossip an address it cannot be reached at, which is a lie
told to the whole network and invites connection attempts that can only time out. Outbound-dialled
peers sync perfectly well through NAT — the node simply gets fewer peers and serves none. That is
the correct trade here, not a limitation being worked around.

## `blocksonly=1` — do not accept transaction relay

**A deposit is credited at a confirmation depth and never at zero.** `contracts-chain` sets that
depth and `wallet` re-checks it independently; nothing in this estate acts on an unconfirmed
transaction. So the mempool answers a question nobody asks, while costing bandwidth and CPU that is
shared with the EMBER miner — and the miner's block production secures Hearth, which outranks this
node absolutely.

Our own outgoing transactions are unaffected: `sendrawtransaction` still relays a transaction the
node itself submits. Turning this off buys zero-confirmation visibility that the estate has decided
it does not want, and pays for it in the one resource that is genuinely scarce on this box.

## `txindex=1` — maintain a transaction index, on all three

**This section used to argue the opposite, and the argument was wrong on two chains out of three.**
It is kept here in corrected form rather than deleted, because the reasoning that failed is the
part worth reading.

The old case was: the index costs about 17 GB and answers exactly one question this service asks —
resolving a *prevout* for an input, which affects **outbound** movement attribution only. Deposits
are unaffected, because a deposit is an output and outputs are in the block. `getblock` verbosity 3
carries prevouts directly, so the common path does not need the index at all. Where a prevout
genuinely cannot be resolved, `bitcoin.ts` records `unresolvedInputs` rather than guessing.

Every sentence of that is true **of Bitcoin Core 27**, and verbosity 3 is a Bitcoin Core 25
feature. Litecoin Core 0.21.x and Dogecoin 1.14.9 predate it. What they do not do is *reject* it:
measured against both daemons on 2026-08-11, `getblock <hash> 3` answers 200 with verbosity-2
shaped data and **zero `prevout` keys**, where the same call on bitcoind returns thousands.

That makes the failure invisible. `#blockByHash` probes for verbosity 3 and latches the answer on
`hash` and `tx` being present, so on those two chains it latches *supported*, the "node does not
serve getblock verbosity 3" log line never prints, and every block silently takes the
`getrawtransaction` path — which needs the index. With `txindex=0` those calls return -5,
`unresolvedInputs` fills up, nothing errors, and nobody finds out. On LTC, the one chain this
estate moves money on today, that is a live gap and not a theoretical one.

So the index is on everywhere. On bitcoind it is a genuine fallback and could arguably come off; it
stays because it is already built and the day something needs it is not a day to start building.
On litecoind and dogecoind it is the only path there is.

## `disablewallet=1` — there are no keys here

This is the setting that bounds the blast radius of everything else, and it is the one most likely
to be removed by somebody who wants to "just test a send".

Every container on the app host can reach this RPC — roughly a hundred of them, not only the
indexer, and since micro-org#338 they arrive over WireGuard rather than a local bridge, which
narrows *which machine* may speak to the daemon and not *which container on it*. With no wallet
loaded there are no keys to use and no `sendtoaddress` to call, so
the reachable surface is *reading chain data* and *relaying a transaction that was signed somewhere
else*. **`custody` holds every private key and always will**; this node must never be given one.
Without `disablewallet`, RPC reachability changes from an inconvenience into a way to spend money.

**dogecoind does not have it, and that is a known gap rather than a decision.** `dogecoin.conf`
carries `disablewallet=0`. Measured on 2026-08-11 the wallet holds nothing — `getbalance`
0.00000000, `txcount` 0, a keypool dating from 2025-01-10 — so it is inherited, not funded, and
`custody` still holds every key that matters. It is recorded instead of flipped because flipping it
is a restart and wants a check first: the obvious reason to keep a wallet is merge mining, and
`auxtemplate.ts` calls `createauxblock(payoutAddress)` with the pool's own address rather than the
wallet-backed `getauxblock()`, which suggests it is not needed — but that is read from code and not
proved against a wallet-less daemon. The conf file says the same thing at the line itself.

## `rpcbind` scoped to bridge gateways, never `0.0.0.0`

The daemons run on the host; the indexer runs in a container, so loopback alone means the seam has
nothing to talk to (tracked as **#215**). The fix is *not* `0.0.0.0` — this box also serves public
traffic through a tunnel, and a chain daemon listening on every interface is a poor trade for a
configuration convenience.

Instead the bind is scoped to the Docker bridge gateway of each network an indexer replica actually
sits on:

| bind | what it is | reaches |
|---|---|---|
| `127.0.0.1` | loopback | anything on the chain host itself |
| `172.20.0.1` | `cloudsforge-estate_default` gateway | `cloudsforge-estate-indexer-1`, when the app ran here |
| `172.31.0.1` | `cf-testnet_default` gateway | `cf-testnet-indexer-1`, when the app ran here |
| `10.10.0.1` | WireGuard, `rpcallowip=10.10.0.2/32` | the app host, since 2026-08-10 |

Those addresses are host-local: they are not routable from the LAN, and the tunnel forwards to
named service ports and never to these. Verified from off-host — both the LAN address and the
bridge addresses refuse the connection — and verified reachable from inside both indexer
containers.

The last row is micro-org#338. The application stack moved to a second machine on 2026-08-10, and
the docker bridge left with it, so the address the app arrives on is now a WireGuard interface
built for the split. Chain RPC is HTTP Basic over plain HTTP with no TLS option anywhere in this
family of daemons, so the alternative was the credential in base64 crossing the LAN on every poll.
A `/32`, never a `/24`: exactly one host may speak to these nodes. The `127.0.0.1` and `172.x`
lines are all kept on purpose, so undoing that move needs no edit to any of these files.

If a Docker network is ever recreated with a different subnet, the daemon **fails to start** rather
than falling back to a broader bind. That is intended: a loud failure is better than a node that
quietly begins listening somewhere else.

## Credentials

`rpcauth=` stores a salted HMAC-SHA256 of the password, so the daemon never holds the password
itself. The password lives in a `0600` file on the host and is injected into the indexer's
environment. **It is never printed, never logged, and never committed** — the `rpcauth` lines in the
committed configs are placeholders, and the real ones are generated on the host.

Who uses which, measured off the running containers on 2026-08-11:

| daemon | user | used by |
|---|---|---|
| bitcoind | `cfindexer` | `BTC_RPC_URL` — micro-indexer |
| litecoind | `cfindexer2` | `INDEXER_RPC_LTC_MAINNET` **and** `SETTLEMENT_RPC_URLS` |
| litecoind | `cfindexer` | nothing. Residue from before the second user existed. |
| dogecoind | `cfindexer` | nothing yet |

The second row is the one to notice. Two users on litecoind reads like one credential per service,
and it is not: micro-indexer and micro-settlement share `cfindexer2`, so rotating it takes deposit
observation and withdrawal broadcast down together, and the daemon's access log cannot say which
service made a call. Splitting them is cheap — a second `rpcauth` line and one env var — and has
not been done.

---

## Why a light client is still the destination

None of the above makes the node portable. Measured on 2026-08-11: bitcoind alone holds 866 GB and
the three chains together fill 943 GB of a 2 TB disk. That does not follow the estate to a VPS or a
second environment, and the catch-up cost is measured in days — the earlier figure in this section
was 428 GB, which gives the rate as much as the size.

The BIP157/158 light client in `btcwire.ts`, `btcgcs.ts`, `btcaddress.ts` and `btcblock.ts` speaks
the peer protocol directly and **needs no RPC at all** — so it is unaffected by #215 entirely, which
is a small but genuine piece of evidence for the light-client-as-destination design. It persists
about 110 MB and roughly 2.7 MB a day.

What the node is really for is the **oracle** role: it validated every block itself, so it is ground
truth, and `btcdiff.ts` compares the light client against it block for block. A compact-filter
client's characteristic failure is silence — a peer that omits a script from a filter hides a
deposit, and no block header commits to a filter — and the only way to catch that before a user
does is to have something that already knows the answer. That is this node's lasting job.

**The oracle is not ready yet on Bitcoin.** `blockfilterindex` is what serves those filters, and on
bitcoind it is still building: 918,038 of 961,930 on 2026-08-11, moving at roughly 280 blocks a
minute, so a few hours out. Until it reaches tip `btcdiff` can only compare below its height. On
litecoind the same index is at tip and the comparison is available today.
