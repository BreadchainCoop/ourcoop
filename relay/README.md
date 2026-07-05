# @crowdstake/relay

Cross-chain governance relay for Crowdstake families. A signer signs **one**
EIP-712 message; that signature is valid on every family instance across chains.
This service delivers it everywhere.

It relays four **action kinds**, all under the same chain-agnostic family domain
(`{name:"CrowdstakingVoting", version:"2", salt:familyId}`) and all through one
store → worker → listener pipeline:

| kind              | signer   | target contract | dedup key     | settlement read               |
| ----------------- | -------- | --------------- | ------------- | ----------------------------- |
| `vote`            | voter    | voting module   | `nonce`       | `lastCrossChainNonce`         |
| `registry-update` | admin    | registry        | `nonce`       | `lastRegistryUpdateNonce`     |
| `proposal`        | proposer | registry        | `proposalKey` | `getCrossChainProposal`       |
| `proposal-vote`   | voter    | registry        | `proposalKey` | `hasVotedCrossChain`/executed |

`proposalKey` is the EIP-712 struct hash itself (content-addressed and
chain-agnostic), so the same proposal exists under the same key on every sibling.

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
durable SQLite store (WAL), which is the correctness boundary — an action+jobs row
set is written _before_ any submission, so double-POSTs, listener replays and nonce
races collapse onto `UNIQUE` constraints, never onto in-memory pre-checks. Actions
live in one `actions` table (`kind IN ('vote','registry-update','proposal',
'proposal-vote')`) keyed `UNIQUE(family_id, kind, signer, dedup_key)`; jobs are
keyed `(action_id, chain_id)`.

- **HTTP API** (`hono`): validates an action (local `verifyTypedData` pre-check with
  the pinned per-kind domain/types), resolves the family's siblings, and upserts the
  action plus one job per sibling chain. Never sends a transaction itself.
- **Per-chain worker** (one serialized loop per chain, the _only_ sender for its
  chain): local account-nonce manager, kind-dispatched skip-checks + simulate + send
  (to the voting module for votes, the registry for the three registry-governance
  kinds), receipt confirmation, stuck-tx fee-bump reaper, exponential backoff, and a
  per-chain circuit breaker when the RPC is down. Jobs are never silently dropped.
  Proposal-votes whose proposal has not yet landed on a chain **defer with backoff**
  (never terminal) — the creation job may still be in flight.
- **Listener** (`--watch`, same binary/store): tails `CrossChainVoteCast` on known
  voting modules, the three `CrossChain*` registry events on known registries, and
  `FamilyDeployed` on the pinned deployers, using bounded `getLogs` windows (bisect
  on provider range errors), a cursor that lags the head by per-chain
  `confirmations`, and `(txHash, logIndex)` + the actions `UNIQUE` constraint for
  dedup. An event from an unknown module/registry falls back to a `familyId()` read.
  Ingested actions feed the same store/workers, covering actions submitted without
  the API.

### Job states

`pending → submitted → confirmed`, plus terminal/side states:

| state                | meaning                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`            | queued; not yet submitted (also the transient/deferred state)                                                                                                                |
| `submitted`          | tx broadcast, awaiting a receipt                                                                                                                                             |
| `confirmed`          | receipt succeeded                                                                                                                                                            |
| `superseded`         | this action or an equivalent one already landed here (e.g. a newer ballot / burned registry nonce / `ProposalAlreadyExists` / `AlreadyVoted` / executed) — **success-class** |
| `skipped_no_power`   | voter has no stake here; re-queued with backoff while the deadline is valid                                                                                                  |
| `recipient_mismatch` | the local recipient/electorate set drifted (`RecipientSetMismatch`); retryable with a long backoff                                                                           |
| `expired`            | past the signed deadline / absolute `expiresAt`                                                                                                                              |
| `failed`             | an undecoded/unexpected revert                                                                                                                                               |

A proposal-vote whose proposal is not yet on-chain stays `pending` (deferred with
backoff), not `failed` — the creation job may land shortly after.

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

Numbers are decimal strings; addresses/bytes32 are hex. Every POST is idempotent —
re-POSTing the same action returns the current per-chain state. Responses are
`202 {kind, familyId, signer, dedupKey, chains: [{chainId, target?, state, txHash?, ...}]}`
(`target` is the voting module for votes, the registry otherwise).

- `POST /v1/action` — any kind (zod discriminated union on `kind`):
  - `{kind:"vote"?, familyId, voter, points[], recipients[], nonce, deadline, signature}`
    (`kind` may be omitted for a vote).
  - `{kind:"registry-update", familyId, admin, recipients[] (≤100, ascending),
nonce, deadline, signature}`.
  - `{kind:"proposal", familyId, proposer, candidate, isAddition, electorate[],
expiresAt, nonce, signature}` — the relay derives `proposalKey` = the EIP-712
    struct hash and uses it as the dedup key.
  - `{kind:"proposal-vote", familyId, voter, proposalKey, deadline, signature}`.
- `POST /v1/vote` — vote-shaped alias for `POST /v1/action` (kind `vote` only).
- `GET /v1/action-status?familyId&kind&signer&dedupKey` — `dedupKey` is the `nonce`
  (vote / registry-update) or the `proposalKey` (proposal / proposal-vote). On a
  store miss it reconstructs from chain truth per kind (nonce ≥ / proposal exists /
  hasVoted / executed → `landed`), never a UI dead-end.
- `GET /v1/vote-status?familyId&voter&nonce` — vote-shaped alias for the above.
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

`vitest` (`npm test`) covers: per-kind digest + `proposalKey` parity against the
pinned forge vector (`test/crosschain-vector.json`, HARD assert; a regenerated
`../.context/crosschain-vector.json` takes precedence), store idempotency +
per-kind dedup + the `votes → actions` migration, the worker state machine (every
transition in the table above plus each kind's skip-checks and the proposal-vote
defer), server per-kind validation + the vote aliases, listener three-event
ingestion + fan-out, nonce-manager serialization, and `getLogs` windowing/bisect.
An optional two-anvil integration is gated behind `ANVIL=1` (not run in CI).
