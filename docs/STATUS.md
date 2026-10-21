# Status

## 2026-10-21

### Built and verified

| Area            | Evidence                                                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Football engine | 16 tests; 60-match calibration (2.6 goals, 20.5 shots, 85% pass accuracy); full match in ~140 ms                                                                                                                                                                                                          |
| Contracts       | 44 Foundry tests incl. fuzzed solvency and a fuzz proof that the 33 scenarios cover every result                                                                                                                                                                                                          |
| Worker + DB     | E2E on anvil + Postgres with real transactions: full cycle incl. worker restart between lock and reveal, automatic payout of exactly stake × odds, next match scheduled                                                                                                                                   |
| Web app         | Production build passes; checked in a browser against a local chain with the real worker: betting window with on-chain odds and bet slip, live replay synchronised to chain time with commentary and live feed, exposure-adjusted prices, settlement, and all five in-browser verification checks passing |

### Not yet done (needs access or decisions outside this repository)

| Item                         | What is needed                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Testnet deployment           | A funded testnet deployer/operator key                                                               |
| Persistent worker host       | An account on Railway / Fly.io / Render (or a VM) and the worker secrets                             |
| Managed Postgres             | A `DATABASE_URL` (Neon, Supabase, …)                                                                 |
| Vercel production deployment | Vercel project linked to the repository, environment variables set                                   |
| $ODRA                        | Not launched; no address shown until a verified one exists                                           |
| ETH → USDG fee conversion    | A verified liquid route and an audited adapter                                                       |
| Real money                   | Licensing, audit, multisig admin, on-chain result verification, VRF (see FAIRNESS.md, COMPLIANCE.md) |
