# @crowdstake/relay

Cross-chain vote relay for Crowdstake families. A voter signs **one** EIP-712
message; that signature is valid on every family instance across chains. This
service delivers it everywhere.

It is a **standalone npm package** (its own `package-lock.json`), not a pnpm
workspace member — mirrors the `e2e/onchain-journey` precedent. Runs on Node 20+.

## Trust model

The relay can **censor, never forge**. Signatures are verified by ECDSA on-chain,
per chain — the relay only pays gas to deliver a signed vote. Because
`castCrossChainVote` is permissionless and `CrossChainVoteCast` re-emits the full
signature, anyone can run a listener and deliver a censored vote from public data.
The relay key is therefore **low-value**: fund it with a small native balance on
each enabled chain and watch `/healthz`. It is never logged.

## Architecture

**API persists intent → per-chain workers own delivery.** These are decoupled by a
durable SQLite store (WAL), which is the correctness boundary — a vote+jobs row set
is written _before_ any submission, so double-POSTs, listener replays and nonce
races collapse onto `UNIQUE` constraints, never onto in-memory pre-checks.

- **HTTP API** (`hono`): validates a vote (local `verifyTypedData` pre-check with
  the pinned domain/types), resolves the family's siblings, and upserts a vote plus
  one job per sibling chain. Never sends a transaction itself.
- **Per-chain worker** (one serialized loop per chain, the _only_ sender for its
  chain): local account-nonce manager, skip-checks, `castCrossChainVote` simulate +
  send, receipt confirmation, stuck-tx fee-bump reaper, exponential backoff, and a
  per-chain circuit breaker when the RPC is down. Jobs are never silently dropped.
- **Listener** (`--watch`, same binary/store): tails `CrossChainVoteCast` on known
  family voting modules and `FamilyDeployed` on the pinned deployers, using bounded
  `getLogs` windows (bisect on provider range errors), a cursor that lags the head
  by per-chain `confirmations`, and `(txHash, logIndex)` + `(voter, nonce)` dedup.
  Ingested votes feed the same store/workers, covering votes submitted without the
  API.

### Job states

`pending → submitted → confirmed`, plus terminal/side states:

| state                | meaning                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `pending`            | queued; not yet submitted (also the transient/deferred state)                         |
| `submitted`          | tx broadcast, awaiting a receipt                                                      |
| `confirmed`          | receipt succeeded                                                                     |
| `superseded`         | this or a newer ballot already landed (incl. `StaleNonce` revert) — **success-class** |
| `skipped_no_power`   | voter has no stake here; re-queued with backoff while the deadline is valid           |
| `recipient_mismatch` | the local recipient set drifted; retryable with a long backoff                        |
| `expired`            | past the signature deadline                                                           |
| `failed`             | an undecoded/unexpected revert                                                        |

## Configuration

Precedence: committed `relay.config.json` → environment overrides.

- `relay.config.json` — per-chain `chainId`, `name`, `rpcUrl` default, **pinned**
  `deployer` address, `confirmations`, `maxLogRange`, `dailyGasBudgetWei`. Deployer
  addresses are pinned here on purpose: the mutable `addresses` manifest branch is
  **not trusted** as a signing target. A chain with a `null` deployer is **disabled**
  (fail closed, loudly logged).
- `RELAY_RPC_URL_<chainId>` / `RELAY_DEPLOYER_<chainId>` — per-chain overrides.
- `RELAY_PRIVATE_KEY` — the hot key (required). `RELAY_PORT`, `RELAY_DB_PATH`
  optional. See `.env.example`.

> The pinned addresses in `relay.config.json` are the **v1** deployers; they predate
> `familyInstances`, so family resolution returns `none` on them until the v2
> deployers ship. Update the config (or set `RELAY_DEPLOYER_<id>`) once they do.

## Run modes

```sh
npm install
npm run build          # tsc -> dist/

RELAY_PRIVATE_KEY=0x... npm start           # HTTP API only
RELAY_PRIVATE_KEY=0x... npm run watch       # API + on-chain listener
npm run dev                                 # tsx watch (local dev)
npm test                                    # vitest
```

## HTTP API (CORS `*`)

- `POST /v1/vote` `{familyId, voter, points[], recipients[], nonce, deadline, signature}`
  (numbers as decimal strings) → `202 {chains: [{chainId, votingModule?, state, txHash?, ...}]}`.
  Idempotent: re-POSTing the same vote returns the current state.
- `GET /v1/vote-status?familyId&voter&nonce` → same shape. On a store miss it
  reconstructs from chain truth (`lastCrossChainNonce(voter) >= nonce` → `landed`),
  never a UI dead-end.
- `GET /v1/family/:familyId` → resolved siblings (the 8-address instance per chain).
- `GET /healthz` → `{ok, chains: [{chainId, rpcOk, balanceWei, queueDepth, listenerBlock, headBlock}]}`.

A light in-memory per-IP token bucket rate-limits `/v1/*` (documented limitation:
per-process, resets on restart — front with a real limiter for multiple replicas).
A per-chain daily gas-budget circuit breaker defers sends once the budget is spent.

## Deployment & observability

Any Node 20+ host works. The only state is the SQLite file (`RELAY_DB_PATH`,
default `relay.db` in the package root) — mount it on a persistent volume. Run one
process; the per-chain nonce managers assume a single sender per key. Monitor
`/healthz`: `rpcOk`, per-chain `balanceWei` (refill the hot key), `queueDepth`, and
listener lag (`headBlock - listenerBlock`). Logs are one greppable line per event
(`[scope]`), and never contain the private key or full RPC bodies.

## Tests

`vitest` (`npm test`) covers: digest parity against the pinned forge vector
(`../.context/crosschain-vector.json`), store idempotency + state persistence, the
worker state machine (every transition in the table above), nonce-manager
serialization, and `getLogs` windowing/bisect. An optional two-anvil integration is
gated behind `ANVIL=1` (not run in CI).
