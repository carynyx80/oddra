# Verified network facts

Checked on 2026-10-21. Nothing in Oddra uses an address that is not listed here or written by our own deploy script.

## Robinhood Chain testnet

| Fact              | Value                                                                | Source                                                                   |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Chain id          | 46630                                                                | `eth_chainId` on the RPC; viem `robinhoodTestnet`                        |
| RPC               | `https://rpc.testnet.chain.robinhood.com`                            | viem chain definition; queried directly                                  |
| Explorer          | `https://explorer.testnet.chain.robinhood.com` (Blockscout)          | viem chain definition                                                    |
| Multicall3        | `0xca11bde05977b3631167028862be2a173976ca11`                         | viem chain definition                                                    |
| ArbSys            | `0x…64`; `arbBlockHash(n)` equals the RPC's block hash for block `n` | checked with `cast`                                                      |
| Block time        | ≈ 7 blocks per second (≈ 35 s per 256 blocks)                        | measured                                                                 |
| Gas price         | 0.01 gwei                                                            | `eth_gasPrice`                                                           |
| Real USDG (Paxos) | `0x7E955252E15c84f5768B83c41a71F9eba181802F`, 6 decimals             | Paxos "USDG on Test Networks"; on-chain `name()`/`symbol()`/`decimals()` |

Real testnet USDG cannot be minted freely, so the testnet deployment uses `OddraTestUSDG` ("Oddra Test USDG (no
value)", symbol `tUSDG`, 6 decimals, public faucet). It is never presented as USDG. To use real testnet USDG instead,
deploy with `USDG_ADDRESS=0x7E95…802F` and fund the treasury yourself.

## Robinhood Chain mainnet (reference only; Oddra does not deploy here)

| Fact               | Value                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Chain id           | 4663                                                                                                                   |
| USDG               | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (Paxos "USDG on Main Networks"; several impostor tokens named USDG exist) |
| Pons V2 fee escrow | `0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e` (verified source; `claim()` pays the caller's creator fees in ETH)        |

## Not available

- **Verifiable randomness**: no Chainlink VRF, Pyth Entropy or Gelato VRF deployment on Robinhood Chain could be
  confirmed. Oddra uses commit-reveal plus L2 block-hash entropy and documents the trust assumptions.
- **ETH → USDG conversion route for creator fees**: not configured. The fee collector accepts an adapter only once one
  is written against a verified, liquid route and audited.
