# crowdstake.fun

Community-powered funding protocol — turn any pool of money into an
interest-generating engine for your group's shared goals.

This is a monorepo:

| Path         | What                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (root)   | **Next.js frontend** — landing page + dapp (App Router, React 19, Tailwind v4, [`@breadcoop/ui`](https://github.com/BreadchainCoop/bread-ui-kit) design system). |
| `contracts/` | **Foundry smart contracts** — the on-chain protocol (distribution, voting, automation, registries).                                                              |

## Quick start

**Frontend** (from repo root):

```bash
pnpm install
pnpm dev            # http://localhost:3001
```

**Contracts** (from `contracts/`):

```bash
forge build
forge test
```

See [AGENTS.md](./AGENTS.md) for architecture, conventions, and the full command list.

## Live deployment (Gnosis Chain)

A full working instance is deployed on Gnosis mainnet (chain 100). The dapp at
`/app` is wired to it out of the box. Addresses are in
[`contracts/deployments/gnosis.json`](./contracts/deployments/gnosis.json) and
default in `src/lib/constants.ts` (override with `NEXT_PUBLIC_*` env vars):

| Contract             | Address                                      |
| -------------------- | -------------------------------------------- |
| Token (`CSTAKE`)     | `0x7E94a840143E3D5C78f367bBe45e6fB6e55098ec` |
| Distribution Manager | `0xB38B15ad418202D3FdC1A139cEc51A8c13f59CB6` |
| Cycle Module         | `0xDfBDa0C7061276C3B8a08aC38fEdeE63c0B63827` |
| Voting Module        | `0xf921AF0C0fCd4A9dE0F6C58b34b05DBCCf0aAc42` |
| Recipient Registry   | `0x8e61175AbBC31A07237367e356833C83204945C2` |

Deploy your own instance with `contracts/script/DeployGnosis.s.sol` (see the env
vars documented at the top of that script).

## Every instance gets its own page

The dapp is one static bundle that resolves any instance client-side, so every
deployed instance has a standalone shareable link:

```
https://<host>/app/?i=<distributionManager>
```

Opening it resolves the instance on-chain (wiring + artwork + governance kind)
and boots straight into it — no registry, no backend. The page white-labels to
that instance (its banner + ticker), and the deploy-success screen shows a
copyable link plus a QR code.

## Multi-chain communities (cross-chain voting)

A community can deploy the **same token on several chains at once** (Gnosis,
Arbitrum, Optimism — Ethereum once its deployer ships). The deploy page lets
you pick multiple chains; the instances are linked on-chain by a deterministic
`familyId`, and the app groups them as one community.

Voting is **sign once, count everywhere**: family instances use a
chain-agnostic EIP-712 signature (`castCrossChainVote`) that is valid on every
sibling chain, delivered by the [relay service](./relay/) (HTTP API + on-chain
listener). The same ballot lands on every chain, weighted by the voter's stake
on that chain. The relay can only censor — never forge — and delivery is
permissionless, so anyone can re-submit a censored vote (the signature is
re-emitted in the `CrossChainVoteCast` event).

Point the frontend at one or more relays with `NEXT_PUBLIC_RELAY_URLS`
(comma-separated). Without a relay the vote page falls back to wallet
submission per chain plus a copyable signed-vote payload.

## Releases

Contracts are released independently — see [GitHub Releases](https://github.com/BreadchainCoop/crowdstake.fun/releases) (latest: `v0.0.2`).
