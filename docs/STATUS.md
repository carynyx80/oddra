# Status

## 2026-10-21

### Live on Robinhood Chain testnet (46630)

All contracts deployed from the testnet-only wallet `0x64D3521F1F848F2EEFe1CB12ACcD4Aa52B8e291e` (admin, operator and
keeper on testnet) and source-verified on [Blockscout](https://explorer.testnet.chain.robinhood.com).

| Contract                                  | Address                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OddraTestUSDG (tUSDG, no value, faucet)   | [`0x4c3cA12F31D0567FF8Dba635E8Be74CD6619B4D2`](https://explorer.testnet.chain.robinhood.com/address/0x4c3cA12F31D0567FF8Dba635E8Be74CD6619B4D2) |
| OddraMatchRegistry                        | [`0xD648E387916081f56854aA00586714b0f89449F6`](https://explorer.testnet.chain.robinhood.com/address/0xD648E387916081f56854aA00586714b0f89449F6) |
| OddraTreasury (seeded with 250,000 tUSDG) | [`0x547DC3269127EB4AB6B967F70eaD7f646C7FBd4A`](https://explorer.testnet.chain.robinhood.com/address/0x547DC3269127EB4AB6B967F70eaD7f646C7FBd4A) |
| OddraRiskManager                          | [`0x545B7Ed1aA9e79A02BFc2Ebe990059202037c150`](https://explorer.testnet.chain.robinhood.com/address/0x545B7Ed1aA9e79A02BFc2Ebe990059202037c150) |
| OddraBook                                 | [`0x2d6840403ad57B5385eD66D5D0E63088B07b8AAC`](https://explorer.testnet.chain.robinhood.com/address/0x2d6840403ad57B5385eD66D5D0E63088B07b8AAC) |
| OddraFeeCollector                         | [`0xf7E61e7Af587d0C40ABe7Bc758b1e7013EEF0Ff8`](https://explorer.testnet.chain.robinhood.com/address/0xf7E61e7Af587d0C40ABe7Bc758b1e7013EEF0Ff8) |

- **Worker**: running on the developer's Mac (local Postgres), committing and pricing a match every 20 minutes. It
  stops when that machine sleeps or shuts down; move it to a persistent host for real uptime.
- **Web**: Vercel project `oddra` (team Carynyx), production deployments from `main` at `oddra-two.vercel.app`.
  The team's default Vercel Authentication protects it, so it is not yet public. No database or live-feed URL is
  configured there yet, so it runs in chain-only mode.

### Built and verified

| Area            | Evidence                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Football engine | 16 tests; 60-match calibration (2.6 goals, 20.5 shots, 85% pass accuracy); full match in ~140 ms                                                                                                                               |
| Contracts       | 44 Foundry tests incl. fuzzed solvency and a fuzz proof that the 33 scenarios cover every result                                                                                                                               |
| Worker + DB     | E2E on anvil + Postgres with real transactions: full cycle incl. worker restart between lock and reveal, automatic payout of exactly stake × odds, next match scheduled                                                        |
| Web app         | Production build passes; checked in a browser against a local chain with the real worker (betting, live replay, settlement, all five verification checks passing) and against testnet (real committed match and on-chain odds) |
| Testnet         | Contracts deployed and verified; first matches committed and priced by the worker                                                                                                                                              |

### Not yet done

| Item                        | What is needed                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| CI workflow on GitHub       | The `gh` token lacks the `workflow` scope; `.github/workflows/ci.yml` is ready locally               |
| Persistent worker host      | An account on Railway / Fly.io / Render (or a VM) and the worker secrets                             |
| Managed Postgres for Vercel | A `DATABASE_URL` (history, charts, leaderboard, operations dashboard)                                |
| Public site                 | Turn off Vercel Authentication for production, or add a custom domain                                |
| $ODRA                       | Not launched; no address shown until a verified one exists                                           |
| ETH → USDG fee conversion   | A verified liquid route and an audited adapter                                                       |
| Real money                  | Licensing, audit, multisig admin, on-chain result verification, VRF (see FAIRNESS.md, COMPLIANCE.md) |
