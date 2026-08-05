# The chain daemons: what they are for, and what they are deliberately not allowed to do

The estate observes Bitcoin and Litecoin through daemons it runs **itself**, on its own hardware,
reached over a host-local Docker bridge. There is no third party between this estate and the
ledgers it credits from, which is the constraint the owner set and the reason this directory
exists.

The configuration in `bitcoin.conf` and `litecoin.conf` is the source of truth for that posture.
Every non-default setting is here because of something that goes wrong without it. **If you are
about to change one of these, the reasoning is below — please read it first.** Each of these looks
like a tightening that could be relaxed, and each is load-bearing.

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

## `txindex=0` — do not maintain a transaction index

The index costs about 17 GB and a great deal of write amplification during catch-up, and it answers
exactly one question this service asks: resolving a *prevout* for an input, which affects **outbound**
movement attribution only.

Deposits are unaffected, because a deposit is an output and outputs are in the block. `getblock`
verbosity 3 resolves prevouts from the undo files, which an unpruned node always has, so the common
path does not need the index at all. Where a prevout genuinely cannot be resolved, `bitcoin.ts`
records `unresolvedInputs` rather than guessing — the gap is reported, never invented.

The existing Bitcoin index on disk was **left in place, not deleted**; it is simply no longer
maintained.

## `disablewallet=1` — there are no keys here

This is the setting that bounds the blast radius of everything else, and it is the one most likely
to be removed by somebody who wants to "just test a send".

Any container on the two estate Docker networks can reach this RPC — roughly ninety containers, not
only the indexer. With no wallet loaded there are no keys to use and no `sendtoaddress` to call, so
the reachable surface is *reading chain data* and *relaying a transaction that was signed somewhere
else*. **`custody` holds every private key and always will**; this node must never be given one.
Without `disablewallet`, RPC reachability changes from an inconvenience into a way to spend money.

## `rpcbind` scoped to bridge gateways, never `0.0.0.0`

The daemons run on the host; the indexer runs in a container, so loopback alone means the seam has
nothing to talk to (tracked as **#215**). The fix is *not* `0.0.0.0` — this box also serves public
traffic through a tunnel, and a chain daemon listening on every interface is a poor trade for a
configuration convenience.

Instead the bind is scoped to the Docker bridge gateway of each network an indexer replica actually
sits on:

| network | gateway | replica |
|---|---|---|
| `cloudsforge-estate_default` | `172.20.0.1` | `cloudsforge-estate-indexer-1` |
| `cf-testnet_default` | `172.31.0.1` | `cf-testnet-indexer-1` |

Those addresses are host-local: they are not routable from the LAN, and the tunnel forwards to
named service ports and never to these. Verified from off-host — both the LAN address and the
bridge addresses refuse the connection — and verified reachable from inside both indexer
containers.

If a Docker network is ever recreated with a different subnet, the daemon **fails to start** rather
than falling back to a broader bind. That is intended: a loud failure is better than a node that
quietly begins listening somewhere else.

## Credentials

`rpcauth=` stores a salted HMAC-SHA256 of the password, so the daemon never holds the password
itself. The password lives in a `0600` file on the host and is injected into the indexer's
environment. **It is never printed, never logged, and never committed** — the `rpcauth` line in the
committed configs below is a placeholder, and the real one is generated on the host.

---

## Why a light client is still the destination

None of the above makes the node portable. It is 428 GB of chain data that does not follow the
estate to a VPS or a second environment, and the catch-up cost is measured in days.

The BIP157/158 light client in `btcwire.ts`, `btcgcs.ts`, `btcaddress.ts` and `btcblock.ts` speaks
the peer protocol directly and **needs no RPC at all** — so it is unaffected by #215 entirely, which
is a small but genuine piece of evidence for the light-client-as-destination design. It persists
about 110 MB and roughly 2.7 MB a day.

What the node is really for is the **oracle** role: it validated every block itself, so it is ground
truth, and `btcdiff.ts` compares the light client against it block for block. A compact-filter
client's characteristic failure is silence — a peer that omits a script from a filter hides a
deposit, and no block header commits to a filter — and the only way to catch that before a user
does is to have something that already knows the answer. That is this node's lasting job.
