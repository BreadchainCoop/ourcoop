# O.U.R.COOP

O.U.R.COOP is an international artists' cooperative headquartered in former
Yugoslavia, built through the "Shared Visions" program (Kulturni sklop,
Belgrade; co-funded by the European Union). The cooperative funds art projects
from shared yield: members stake together, the principal stays theirs, and
100-point ballots decide which projects the interest funds.

This repo is a fork of
[BreadchainCoop/crowdstake.fun](https://github.com/BreadchainCoop/crowdstake.fun)
that tracks the open-source crowdstake protocol and adds the cooperative's
brand (purple theme, Archivo type, ✳ mark) plus its own on-chain modules.

## Monorepo layout

| Path         | What                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (root)   | **Next.js frontend** — landing page + dapp (App Router, React 19, Tailwind v4, [`@breadcoop/ui`](https://github.com/BreadchainCoop/bread-ui-kit) design system). |
| `contracts/` | **Foundry smart contracts** — the on-chain protocol (distribution, voting, automation, registries) and the cooperative's modules under `src/examples/cova`.      |

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

## Cooperative modules

The cooperative's own contracts live in
[`contracts/src/examples/cova`](./contracts/src/examples/cova):

- **cUSD yield token** — deposits WXDAI, routes it into sDAI so the principal
  earns while staying redeemable 1:1.
- **Project registry** — art projects with full and minimum-viable budgets.
- **100-point voting module** — one person, one vote: every member allocates
  exactly 100 points across projects per cycle.
- **Top-N art-fund strategy** — the accrued yield funds the top-voted projects
  each cycle.
- **Membership voting power** — voting weight comes from membership, not stake
  size.

They are deployed on Gnosis and wired through the deploy wizard's
**"Custom modules"** section. The complete click-by-click guide is the
[custom-modules runbook](./docs/runbook.html) (live at `/docs/runbook.html`),
and there is a guided demo at `/demo/`.

## Every instance gets its own page

The dapp is one static bundle that resolves any instance client-side, so every
deployed instance has a standalone shareable link:

```
https://<host>/app/?i=<distributionManager>&c=<chainId>
```

Opening it resolves the instance on-chain (wiring + artwork + governance kind)
and boots straight into it — no registry, no backend. The page white-labels to
that instance (its banner + ticker), and the deploy-success screen shows a
copyable link plus a QR code.

## Credits

**Shared Visions · Kulturni sklop · Co-funded by the European Union.**
Built on the open-source [crowdstake.fun](https://github.com/BreadchainCoop/crowdstake.fun)
protocol by Breadchain Cooperative.
