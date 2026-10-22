<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/oddra-logo-transparent-white.svg">
    <img alt="Oddra" src="brand/oddra-logo-transparent-black.svg" width="360">
  </picture>
</p>

# Oddra

**Every Match. Every Moment. Onchain.**

Oddra is an automated virtual football sportsbook on Robinhood Chain. Every 20 minutes a new match is committed
on-chain, opens for five minutes of betting in USDG, then plays out as a 15-minute 2-D simulation of a full 90 minutes.
The result is reproducible by anyone from on-chain data, the settlement contract resolves every market, and winners
are paid automatically (or claim themselves).

> Bets are placed and paid in **USDG or native ETH**. The contracts deploy to Robinhood Chain **mainnet** (real funds)
> or testnet (labelled no-value test USDG). Licensing, audit and the operator's legal obligations are the operator's
> responsibility; see [docs/COMPLIANCE.md](docs/COMPLIANCE.md) and [docs/MAINNET.md](docs/MAINNET.md).

---

## Contents

1. [Architecture](#1-architecture) · 2. [Repository layout](#2-repository-layout) · 3. [Local setup](#3-local-setup) ·
2. [Environment variables](#4-environment-variables) · 5. [Contracts](#5-smart-contracts) ·
3. [Testnet setup](#6-testnet-setup) · 7. [Worker deployment](#7-worker-deployment) · 8. [Database](#8-database) ·
4. [Vercel](#9-vercel-deployment) · 10. [GitHub and CI](#10-github-and-ci) · 11. [Testing](#11-testing) ·
5. [Security model](#12-security-model) · 13. [Known limitations](#13-known-limitations) · 14. [Status](#14-status)

## 1. Architecture

```
            ┌──────────────────────── Robinhood Chain (testnet 46630) ────────────────────────┐
            │  OddraMatchRegistry   OddraBook ── OddraRiskManager   OddraTreasury   FeeCollector │
            │  commit/lock/reveal   bets, odds,    limits &         USDG reserves   creator fees  │
            │  /settle              claims         solvency          & payouts       → treasury    │
            └──────────▲───────────────────▲──────────────────────────▲────────────────────────┘
                       │ txs (operator)    │ reads/bets (wallets)     │ events
            ┌──────────┴──────────┐   ┌────┴─────────────────┐   ┌────┴──────────────┐
            │  apps/worker        │   │  apps/web (Vercel)   │   │  Postgres          │
            │  scheduler, pricing,│◄──┤  Next.js, wagmi,     │──►│  index of chain    │
            │  replay, settlement,│ WS│  canvas pitch + the  │   │  events, history,  │
            │  payouts, indexer,  │   │  engine in a Web     │   │  jobs, audit log   │
            │  live feed          │──►│  Worker              │   └────────────────────┘
            └─────────────────────┘   └──────────────────────┘
                     both run packages/engine (deterministic) and packages/shared
```

**One clock: the chain.** Slot `n` opens betting at `n × 1200 s` (Unix time), kicks off 300 s later and ends 1,200 s
after opening, exactly when slot `n+1` opens: 72 matches a day, never two live at once. The slot number _is_ the
on-chain match id, so every component knows which match is current from block time alone. Betting deadlines are
enforced by the contract against `block.timestamp`; browsers sync to the latest block, not their own clock.

**A match's life:**

1. During slot `n−1`, the worker derives the server seed for slot `n` (HMAC of a secret), commits `keccak256(seed)` and
   the config hash (teams, players, ruleset), prices the fixture by simulating it a few hundred times with
   pricing-only seeds, and publishes odds. During the window it shortens heavily backed prices (accepted bets keep
   theirs).
2. Bettors approve the exact stake and call `placeBet` with the price they saw as a minimum. The book reserves, in the
   treasury, the worst-case payout of the whole match across all 33 result scenarios, so correlated selections
   (Home + Over 2.5 + 3-1) are covered together; it rejects any bet the treasury cannot cover.
3. At kickoff anyone can `lock`, fixing a future L2 block as entropy; the worker then `reveal`s the seed and the
   registry fixes `finalSeed = keccak256(seed ‖ blockhash ‖ id)`.
4. Every browser replays the match from `finalSeed` in a Web Worker (~150 ms) and draws the frame for the current chain
   time, so all viewers see the same moment; late joiners land on the right minute, refreshes and reconnects are
   harmless. The worker's WebSocket feed adds commentary/events with sequence numbers for de-duplication.
5. At full time the worker proposes the score and `resultHash`. After a 10-minute dispute window (anyone may dispute
   with a bond; an independent arbiter rules) it finalises, closes both asset books (releasing unneeded reserve), and
   pays winners in batches in the asset they staked. A failed transfer leaves the bet claimable; claims never pause.
6. If anything stalls (no reveal, no settlement, low liquidity, paused book), no new market opens and the UI shows a
   safe-state banner; missed reveals/settlements become voids that refund every stake, callable by anyone.

## 2. Repository layout

| Path              | What                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine` | Deterministic football engine, teams, hashing ([rules](docs/SIMULATION.md))                                                                        |
| `packages/shared` | Market definitions, schedule, fixtures, odds engine, commentary, chain config, generated ABIs                                                      |
| `packages/db`     | Prisma schema and migrations, client, seed, throwaway local Postgres                                                                               |
| `contracts`       | Foundry: registry, book, treasury, risk manager, fee collector, test USDG, deploy script, tests                                                    |
| `apps/worker`     | Persistent automation: scheduler, pricing, settlement, payouts, indexer, live feed, health                                                         |
| `apps/web`        | Next.js app: Live, Matches, My Bets, Treasury, Leaderboard, $ODRA, Profile, Operations                                                             |
| `docs`            | [Fairness](docs/FAIRNESS.md), [simulation](docs/SIMULATION.md), [compliance](docs/COMPLIANCE.md), [verified addresses](docs/VERIFIED_ADDRESSES.md) |

## 3. Local setup

Requires Node 22+, npm 10+, and [Foundry](https://getfoundry.sh) for contracts.

```bash
git clone --recurse-submodules https://github.com/carynyx80/oddra.git
```

```bash
cd oddra && npm install
```

Run everything locally (four terminals):

```bash
anvil --block-time 1
```

```bash
cd contracts && DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

(That key is anvil's published development key; never use it anywhere else.)

```bash
npm run pg:local -w @oddra/db
```

```bash
DATABASE_URL=postgresql://oddra:oddra@127.0.0.1:54329/oddra npm run migrate -w @oddra/db && DATABASE_URL=postgresql://oddra:oddra@127.0.0.1:54329/oddra npm run seed -w @oddra/db
```

Start the worker (`.env` in `apps/worker` or exported variables):

```bash
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 OPERATOR_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 SERVER_SEED_SECRET=0x$(openssl rand -hex 32) DATABASE_URL=postgresql://oddra:oddra@127.0.0.1:54329/oddra npm run start -w @oddra/worker
```

Start the web app against the local chain (addresses from `contracts/deployments/31337.json`; see
[.claude/launch.json](.claude/launch.json) for a ready-made command):

```bash
npm run dev
```

To skip waiting for the next slot locally, move anvil's clock: `cast rpc evm_increaseTime <seconds>`.

## 4. Environment variables

Every variable, what it does and where to get it: [.env.example](.env.example). The essentials:

| Where       | Variable                                  | Source                                                                           |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| worker      | `OPERATOR_PRIVATE_KEY`                    | `cast wallet new`; holds only `OPERATOR_ROLE`; fund with testnet ETH             |
| worker      | `SERVER_SEED_SECRET`                      | `openssl rand -hex 32` (prefix `0x`); keep in a secret manager                   |
| worker, web | `DATABASE_URL`                            | any managed Postgres (Neon, Supabase, Railway…)                                  |
| worker      | `RPC_URLS`                                | comma-separated; Robinhood's public RPC is rate-limited, add a provider endpoint |
| web         | `NEXT_PUBLIC_LIVE_URL`, `WORKER_URL`      | your worker host (`wss://…/live`, `https://…`)                                   |
| web         | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`    | cloud.reown.com (optional; without it, extension wallets only)                   |
| web         | `ADMIN_ADDRESSES`, `ADMIN_SESSION_SECRET` | operator wallets; `openssl rand -hex 32`                                         |

No private key is ever read by the web app, and nothing secret is prefixed `NEXT_PUBLIC_`.

## 5. Smart contracts

| Contract             | Responsibility                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OddraMatchRegistry` | Match records: commitments, entropy, final seed, result; immutable once settled. Anyone may `lock`, and void after a missed deadline.                                                                                                                                        |
| `OddraBook`          | Odds publication, bets, worst-case reservation, settlement, pull claims, keeper batch payouts, self-exclusion and daily limits, pause. Covers the brief's _betting, settlement, claims and market factory_ roles in one contract to avoid cross-contract trust between them. |
| `OddraTreasury`      | Holds USDG; reserved funds leave only as payouts; admin withdraws only the free balance; tracks stakes, payouts, creator fees.                                                                                                                                               |
| `OddraRiskManager`   | Stake, payout, per-selection, per-match and total liability limits; minimum free reserve; exposure-scaled payout cap.                                                                                                                                                        |
| `OddraFeeCollector`  | $ODRA creator-fee recipient: claims from the Pons V2 escrow, converts ETH→USDG only via an audited adapter with `minOut`, forwards to the treasury.                                                                                                                          |
| `OddraTestUSDG`      | Testnet faucet token, refuses mainnet.                                                                                                                                                                                                                                       |

Access control is OpenZeppelin `AccessControlDefaultAdminRules` (admin transfer has a 1-day delay). Roles:
`OPERATOR_ROLE` (matches, odds), `PAUSER_ROLE`, `RISK_ROLE`, `TREASURER_ROLE`, `KEEPER_ROLE`, `BOOK_ROLE` (only the
book). Contracts are **not upgradeable**: a new version is a new deployment, and old books stay claimable forever.

```bash
cd contracts && forge test
```

```bash
cd contracts && forge build && node export-abis.mjs
```

## 6. Testnet setup

1. Create a testnet-only deployer/operator key: `cast wallet new`. Fund it with Robinhood Chain testnet ETH from the
   official faucet (gas is 0.01 gwei; a deployment costs well under 0.001 ETH).
2. Deploy (writes `contracts/deployments/46630.json`, which the worker and web app read):

```bash
cd contracts && DEPLOYER_PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.chain.robinhood.com --broadcast
```

3. Optionally verify sources on Blockscout: `forge verify-contract --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api <address> <Contract>`.
4. Commit the deployment file, start the worker (section 7), deploy the web app (section 9).
5. Users get test USDG from the faucet button in the bet slip (1,000 per hour) and testnet ETH from the chain faucet.

## 7. Worker deployment

The worker must run on a **persistent** host (Railway, Fly.io, Render, a VM, Kubernetes), never on Vercel
functions. It is stateless apart from Postgres: every step is re-derived from chain state and idempotent, and leader
election uses a database lease timed by the database clock, so you can run two replicas for failover.

```bash
docker build -f apps/worker/Dockerfile -t oddra-worker .
```

The image applies migrations and seeds the league on start. Expose port 8787 (`/health`, `/state`, `wss /live`), set
the worker variables from `.env.example`, and point your uptime monitor at `/health` (HTTP 503 when unhealthy).

## 8. Database

PostgreSQL via Prisma ([schema](packages/db/prisma/schema.prisma)). The chain is authoritative for money: financial
rows are an index of contract events keyed by `(txHash, logIndex)`, rebuilt by the indexer from the deployment block if
needed. Migrations:

```bash
npm run migrate -w @oddra/db
```

For schema changes during development: `npm run migrate:dev -w @oddra/db -- --name <change>`.

## 9. Vercel deployment

Import the GitHub repository in Vercel with **Root Directory = `apps/web`** (the included
[apps/web/vercel.json](apps/web/vercel.json) installs from the monorepo root). Set the web variables from
`.env.example` for Production and Preview. Pull requests get preview deployments; `main` deploys to production after
CI passes (enable "Required checks" on the branch in GitHub). Security headers are set in `next.config.ts`; API routes
are rate limited in `middleware.ts`. The site works without a database (chain-only views); history, charts, the
leaderboard and the operations dashboard need `DATABASE_URL`.

## 10. GitHub and CI

`.github/workflows/ci.yml` runs on every push and PR: contract format/build/tests; formatting, type checks, lint,
engine and shared tests, and the production web build; then the end-to-end match cycle against anvil and a Postgres
service. Protect `main` with these checks.

## 11. Testing

| Suite          | Command                                          | Covers                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts (44) | `cd contracts && forge test`                     | every market settles correctly, correlated reservation, solvency fuzzing, failed payouts keep claims, double-claim prevention, withdrawal restrictions, voids/refunds, limits, self-exclusion, fee contributions, registry lifecycle and fairness checks |
| Engine (16)    | `npm test -w @oddra/engine`                      | determinism, legal formations, positions, possession, the full event range, score/stat consistency, completion, league realism                                                                                                                           |
| Shared (8)     | `npm test -w @oddra/shared`                      | Solidity parity of markets, 20-minute slots, fair fixtures, odds margins, exposure skew                                                                                                                                                                  |
| End to end     | `E2E=1 DATABASE_URL=… npm test -w @oddra/worker` | real transactions on anvil: commit → price → bets → late bet rejected → lock → **worker restart** → reveal → independent replay → settle → automatic payout of exactly stake × odds → treasury back to zero reserve → next match scheduled               |

## 12. Security model

- **Funds**: stakes go straight to the treasury; each bet reserves the match's worst-case payout; reserved USDG can only
  leave as a payout to the bettor. Admins can withdraw only unreserved funds, cannot change accepted odds, cannot
  edit or re-settle a result, and cannot void a match once betting has opened (only a missed deadline voids, and
  anyone can trigger it). Pausing stops new bets only; claims always work.
- **Contracts**: OpenZeppelin AccessControl with delayed admin transfer, ReentrancyGuard, SafeERC20, checks-effects-
  interactions, custom errors, events for every state change; pull-based claims with try/catch batch payouts.
- **Fairness**: commit-reveal with post-betting L2 entropy and public replay; trust assumptions in
  [docs/FAIRNESS.md](docs/FAIRNESS.md).
- **Operations**: the worker key holds only operator/keeper roles. Admin dashboard access requires a wallet signature
  over a single-use nonce, an allowlist and an HMAC-signed httpOnly cookie; every view is audit-logged.
- **Not done yet** (required before real money): external audit, multisig for every admin role, bonded operator,
  on-chain verification of results, a VRF, production KYC/geo-fencing.

## 13. Known limitations

- The engine runs off-chain; the registry accepts the operator's score (provable, not enforced). See FAIRNESS.md.
- Robinhood Chain has no confirmed VRF; entropy is an L2 block hash.
- No ETH→USDG conversion adapter is configured, so creator fees in ETH stay in the collector until one is audited;
  $ODRA has not launched and the site shows no token address or price.
- Engine simplifications: no offside calls, cards, substitutions or stoppage time; high pass counts, few corners.
- In-memory API rate limiting is per serverless instance.

## 14. Status

See the latest section of [docs/STATUS.md](docs/STATUS.md) for what is deployed and verified, and what is blocked.
