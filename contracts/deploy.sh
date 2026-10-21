#!/usr/bin/env bash
# Deploys Oddra and records the deployment in deployments/<chainId>.json.
# On Robinhood Chain (Arbitrum Orbit) `block.number` inside the script is the L1 block, so the L2 deployment block is
# taken from the broadcast receipts instead.
#   DEPLOYER_PRIVATE_KEY=0x... ./deploy.sh https://rpc.testnet.chain.robinhood.com
set -euo pipefail
RPC="${1:?usage: ./deploy.sh <rpc-url>}"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow
python3 - "$CHAIN_ID" <<'PY'
import json, sys
cid = sys.argv[1]
receipts = json.load(open(f"broadcast/Deploy.s.sol/{cid}/run-latest.json"))["receipts"]
path = f"deployments/{cid}.json"
d = json.load(open(path))
d["deployedAtBlock"] = min(int(r["blockNumber"], 16) for r in receipts)
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
print("deployment written to", path, "from block", d["deployedAtBlock"])
PY
