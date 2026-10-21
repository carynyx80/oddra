# Compliance and responsible play

**Status: real-money wagering is disabled.** Oddra runs on Robinhood Chain testnet with a no-value test token. Moving to
real money requires, at minimum, a gambling licence for every jurisdiction served, legal review of the token and fee
model, an independent smart-contract audit, an independently tested RNG/fairness model (see [FAIRNESS.md](FAIRNESS.md)
for the open gaps), and a multisig holding every admin role.

## What is enforced today

| Control                                                                                                                         | Where                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Testnet only: deploy script refuses any chain but 46630/31337; worker and web refuse mainnet (4663); test token refuses mainnet | `Deploy.s.sol`, `apps/worker/src/env.ts`, `packages/shared/src/chain.ts`, `OddraTestUSDG` |
| Self-exclusion (24 h – 6 months, extend-only)                                                                                   | `OddraBook.selfExclude`, Profile page                                                     |
| Daily stake limit (lowering immediate, raising after 24 h)                                                                      | `OddraBook.setDailyLimit`, Profile page                                                   |
| Per-bet, per-selection, per-match and total liability limits; solvency reserve                                                  | `OddraRiskManager`, `OddraBook`                                                           |
| Age / jurisdiction notice before use                                                                                            | `components/AgeGate.tsx` (self-declaration only)                                          |
| No admin path to edit results, prices of accepted bets, or reserved funds                                                       | contracts (see README → Security)                                                         |
| Admin access by wallet signature with single-use nonces; audit log                                                              | `app/api/admin/*`, `AdminAuditLog`                                                        |

## Integration points for a licensed launch

- **Age and identity (KYC/AML)**: gate `placeBet` behind an attestation. Recommended design: an `IEligibility` contract
  the book checks per bettor, fed by a KYC provider's on-chain attestation (e.g. an EAS schema). `Wallet.kycReference`,
  `ageConfirmedAt` and `jurisdiction` exist in the database for the off-chain side; no documents are ever stored.
- **Geo-restriction**: enforce at the edge (Vercel middleware on `x-vercel-ip-country`) _and_ in the eligibility
  attestation, since the contract is callable directly.
- **Deposit limits**: Oddra has no deposits (bets are paid from the wallet); daily stake limits play that role.
- **Reality checks / cool-off**: the daily limit and exclusion functions are the primitives; add session reminders in
  the UI.
- **Sanctions screening**: screen addresses at the eligibility layer.
