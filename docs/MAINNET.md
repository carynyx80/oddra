# Mainnet deployment (Robinhood Chain, 4663)

> **Mainnet runs as a peer-to-peer exchange (`MODE=exchange`, the default).** There is no house treasury and no
> liquidity to fund: players back (bet for) or lay (bet against) each other's offers. Unmatched offers are returned at
> kickoff, a voided match refunds both sides, and winners are paid after the dispute window minus a 2% commission on
> net winnings (max 5%, set by the admin). The operator only publishes guide odds from the simulator.
>
> Exchange deploy: `cd contracts && DEPLOYER_PRIVATE_KEY=0x... ADMIN_ADDRESS=0x... ARBITER_ADDRESS=0x... USDG_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 ./deploy.sh https://rpc.mainnet.chain.robinhood.com`
> deploys only the registry and `OddraExchange` (≈ 0.0003 ETH of gas). Skip step 3 below. Minimum offer/fill: 1 USDG
> or 0.0003 ETH. Commission accrues in the exchange and only the TREASURER role can withdraw it; it can never touch
> players' escrow. The house-mode text below applies only with `MODE=house`.
>
> Exchange verification: 18 Foundry tests including a fuzz test that every unit of escrow is returned or paid out, and
> `apps/worker/test/exchange.e2e.test.ts` (back/lay in USDG and ETH, partial fills, unmatched refunds at kickoff,
> dispute window, payouts minus commission), passing locally and on a fork of Robinhood mainnet with real Paxos USDG.

Bets on mainnet are real: **USDG** (Paxos, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals) and **native
ETH**. Each is its own book: a bet is reserved, settled and paid in the asset it was staked in.

## What was verified before mainnet

- 61 Foundry tests: every market, correlated reservation, mixed-asset solvency fuzzing, failed ETH payouts staying
  claimable, withdrawal limits, every dispute path (upheld, overturned, timed out).
- The full cycle (commit → price → USDG and ETH bets → lock → worker restart → reveal → propose → dispute window →
  finalise → automatic payouts in both assets → next match) on **a fork of Robinhood mainnet using Paxos's real USDG
  contract**: `E2E=1 FORK_URL=https://rpc.mainnet.chain.robinhood.com npm test -w @oddra/worker`.
- The same cycle live on Robinhood testnet with the v2 contracts.

Fork-test findings that matter on mainnet:

- On Robinhood mainnet, anvil's well-known test accounts carry EIP-7702 delegations to a sweeper contract that refuses
  plain ETH. Any user whose wallet delegate refuses ETH gets a `PayoutFailed` instead of a payout; the bet stays
  claimable and nothing is lost. Normal wallets are unaffected.
- `block.number` inside scripts on Arbitrum-style chains is the L1 block: `deploy.sh` records the L2 deployment block
  from receipts; always deploy with `deploy.sh`.

## Keys and roles (use different keys)

| Role                          | Holds                                                                     | Recommended                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Admin (`ADMIN_ADDRESS`)       | all admin roles, pause, risk limits, treasury withdrawals of _free_ funds | multisig                                                                     |
| Operator (`OPERATOR_ADDRESS`) | commit matches, publish odds, reveal, propose results                     | hot key on the worker host                                                   |
| Keeper (`KEEPER_ADDRESS`)     | automatic payouts (anyone can also do this)                               | hot key, may equal operator                                                  |
| Arbiter (`ARBITER_ADDRESS`)   | rule on disputed results                                                  | a different person or multisig; **must differ from the operator** (enforced) |

## Steps

1. Fund the deployer with mainnet ETH for gas (deployment ≈ 0.0002 ETH at current gas).
2. Deploy:

```bash
cd contracts && DEPLOYER_PRIVATE_KEY=0x... ADMIN_ADDRESS=0x... OPERATOR_ADDRESS=0x... ARBITER_ADDRESS=0x... USDG_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 ./deploy.sh https://rpc.mainnet.chain.robinhood.com
```

The script refuses mainnet unless USDG is Paxos's address, the arbiter differs from the operator, and entropy
comes from ArbSys. If `ADMIN_ADDRESS` differs from the deployer, the new admin must call `acceptDefaultAdminTransfer`
on each contract after 1 day. 3. Fund the treasury (anyone can contribute; it is recorded on-chain):

- USDG: `approve(treasury, amount)` then `treasury.contribute(USDG, amount, "house")`.
- ETH: `treasury.contribute{value: amount}(0x0, amount, "house")`.
  Launch limits (raise with `RiskManager.setLimits` as liquidity grows): USDG 1–100 per bet, payout ≤ 2,000,
  ≤ 10% of free liquidity per bet; ETH 0.0003–0.03 per bet, payout ≤ 0.6 ETH.

4. Start the worker with `CHAIN_ID=4663`, the operator key, a fresh database and `MIN_FREE_LIQUIDITY_USDG` /
   `MIN_FREE_LIQUIDITY_ETH_WEI` matching your treasury. Run it on a host that never sleeps.
5. Web: set `NEXT_PUBLIC_CHAIN_ID=4663` in Vercel (addresses come from `contracts/deployments/4663.json`) and redeploy.
