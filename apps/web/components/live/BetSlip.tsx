"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Hash } from "viem";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import {
  SELECTIONS,
  MARKETS,
  formatOdds,
  oddraBookAbi,
  oddraTestUSDGAbi,
  parseAmount,
  type AssetKey,
} from "@oddra/shared";
import { Button, Card, CardHeader, ExtLink } from "@/components/ui/primitives";
import { chain, deployment, isMainnet, txUrl, usdgSymbol } from "@/lib/config";
import { useLimits, useUsdg } from "@/lib/hooks";
import { useSlip } from "@/lib/slip";
import { cn, fmtAsset } from "@/lib/utils";

const FRIENDLY: Record<string, string> = {
  MarketClosed: "Betting on this match has closed.",
  OddsChanged: "The price moved. Re-select the market to take the new odds.",
  OddsUnavailable: "This selection is suspended.",
  StakeOutOfRange: "Stake is outside the allowed range.",
  BadStake: "Enter a stake.",
  PayoutTooHigh: "Potential payout is above the current limit. Try a smaller stake.",
  SelectionLiabilityTooHigh: "This selection has reached its liability limit.",
  MatchLiabilityTooHigh: "This match has reached its liability limit.",
  TotalLiabilityTooHigh: "The treasury cannot take more risk right now.",
  ReserveBreached: "The treasury cannot cover this bet right now.",
  AssetNotEnabled: "Betting in this asset is not enabled.",
  Excluded: "You have self-excluded from betting.",
  NotEligible: "This wallet is not eligible to bet.",
  DailyLimitExceeded: "This bet would exceed your daily stake limit.",
  EnforcedPause: "Betting is paused.",
  FaucetCooldown: "The faucet can be used once per hour.",
  BadBond: "The dispute bond amount is wrong.",
  TooLate: "The dispute window has closed.",
  OfferUnavailable: "Someone else took that offer first. Refresh the prices and try again.",
  SelfMatch: "You cannot take your own offer.",
  BadOdds: "Odds must be between 1.01 and 1000.",
  BadAmount: "That amount is below the minimum for this asset.",
  BadValue: "The ETH amount sent did not match. Refresh and try again.",
  NothingToClaim: "Nothing to claim on this position yet.",
  NotMaker: "Only the maker can cancel an offer before kickoff.",
  UnsupportedAsset: "Betting in this asset is not enabled.",
};

export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name && FRIENDLY[name]) return FRIENDLY[name];
    if (/User rejected|denied/i.test(e.shortMessage ?? e.message)) return "You rejected the request in your wallet.";
    if (/insufficient funds/i.test(e.message))
      return `Not enough ${chain.nativeCurrency.symbol} for this transaction and its gas.`;
    return e.shortMessage || e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

type Step = "idle" | "approving" | "placing" | "done" | "error";

const QUICK: Record<AssetKey, string[]> = { USDG: ["5", "25", "100"], ETH: ["0.001", "0.005", "0.01"] };
/** ETH kept back for gas when betting "max". */
const GAS_RESERVE = 2n * 10n ** 14n;

export function BetSlip({
  open,
  currentOdds,
  homeName,
  awayName,
}: {
  open: boolean;
  currentOdds: number[] | null;
  homeName: string;
  awayName: string;
}) {
  const { pick, stake, setStake, setPick } = useSlip();
  const [asset, setAsset] = useState<AssetKey>("USDG");
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const client = usePublicClient();
  const qc = useQueryClient();
  const wallet = useUsdg(address);
  const limits = useLimits();
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hash | null>(null);

  useEffect(() => {
    setStep("idle");
    setError(null);
    setTx(null);
  }, [pick?.matchId, pick?.selection, asset]);

  const decimals = asset === "ETH" ? 18 : 6;
  const sel = pick ? SELECTIONS[pick.selection] : null;
  const live = pick && currentOdds ? currentOdds[pick.selection] : null;
  const moved = pick && live !== null && live !== pick.odds;
  const amount = parseAmount(stake, decimals);
  const payout = amount && pick ? (amount * BigInt(pick.odds)) / 100n : null;
  const balance = asset === "ETH" ? (wallet.data?.eth ?? 0n) : (wallet.data?.balance ?? 0n);
  const lim = limits.data?.[asset];
  const needsApproval = asset === "USDG" && amount !== null && (wallet.data?.allowance ?? 0n) < amount;
  const wrongChain = isConnected && chainId !== chain.id;
  const outOfRange = amount !== null && lim ? amount < lim.minStake || amount > lim.maxStake : false;
  const short = amount !== null && (asset === "ETH" ? balance < amount + GAS_RESERVE / 4n : balance < amount);
  const symbol = asset === "ETH" ? "ETH" : usdgSymbol;

  function switchAsset(a: AssetKey) {
    setAsset(a);
    setStake(QUICK[a][1]);
  }

  async function wait(hash: Hash) {
    setTx(hash);
    const r = await client!.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("Transaction reverted");
  }

  async function faucet() {
    setError(null);
    try {
      await wait(await writeContractAsync({ address: deployment.usdg, abi: oddraTestUSDGAbi, functionName: "faucet" }));
      await qc.invalidateQueries({ queryKey: ["usdg"] });
    } catch (e) {
      setError(explain(e));
    }
  }

  async function place() {
    if (!pick || !amount) return;
    setError(null);
    try {
      if (asset === "ETH") {
        setStep("placing");
        await wait(
          await writeContractAsync({
            address: deployment.book,
            abi: oddraBookAbi,
            functionName: "placeBetETH",
            args: [pick.matchId, pick.selection, pick.odds],
            value: amount,
          }),
        );
      } else {
        if (needsApproval) {
          setStep("approving");
          // approve exactly the stake, never an unlimited allowance
          await wait(
            await writeContractAsync({
              address: deployment.usdg,
              abi: oddraTestUSDGAbi,
              functionName: "approve",
              args: [deployment.book, amount],
            }),
          );
        }
        setStep("placing");
        await wait(
          await writeContractAsync({
            address: deployment.book,
            abi: oddraBookAbi,
            functionName: "placeBet",
            args: [pick.matchId, pick.selection, amount, pick.odds],
          }),
        );
      }
      setStep("done");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["usdg"] }),
        qc.invalidateQueries({ queryKey: ["bets"] }),
        qc.invalidateQueries({ queryKey: ["match"] }),
      ]);
    } catch (e) {
      setStep("error");
      setError(explain(e));
    }
  }

  return (
    <Card>
      <CardHeader
        title="Bet slip"
        right={
          pick ? (
            <button className="text-[12px] text-muted hover:text-fg" onClick={() => setPick(null)}>
              Clear
            </button>
          ) : null
        }
      />
      <div className="space-y-4 p-4">
        {!pick || !sel ? (
          <p className="text-[13px] text-muted">Select odds to add a single bet.</p>
        ) : (
          <>
            <div className="rounded-md border border-line bg-raised p-3">
              <div className="label">
                {MARKETS.find((m) => m.key === sel.market)?.title} · Match #{pick.matchId.toString()}
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-[15px] font-medium">
                  {pick.selection === 0 || pick.selection === 10
                    ? homeName
                    : pick.selection === 2 || pick.selection === 11
                      ? awayName
                      : sel.label}
                </span>
                <span className="num font-[family-name:var(--font-display)] text-[18px] font-semibold text-accent">
                  {formatOdds(pick.odds)}
                </span>
              </div>
              {moved ? (
                <div className="mt-2 flex items-center justify-between text-[12px] text-warn">
                  <span>Price is now {formatOdds(live!)}</span>
                  <button className="underline" onClick={() => setPick({ ...pick, odds: live! })}>
                    Accept
                  </button>
                </div>
              ) : null}
            </div>

            <div
              className="grid grid-cols-2 gap-1 rounded-md border border-line bg-bg p-1"
              role="radiogroup"
              aria-label="Bet with"
            >
              {(["USDG", "ETH"] as const).map((a) => (
                <button
                  key={a}
                  role="radio"
                  aria-checked={asset === a}
                  onClick={() => switchAsset(a)}
                  className={cn(
                    "rounded px-3 py-1.5 text-[13px] font-medium transition-colors",
                    asset === a ? "bg-raised text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {a === "USDG" ? usdgSymbol : "ETH"}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="label">Stake ({symbol})</span>
              <div className="mt-1.5 flex items-center rounded-md border border-line bg-bg focus-within:border-accent/60">
                <input
                  inputMode="decimal"
                  value={stake}
                  onChange={(e) => setStake(e.target.value.replace(",", "."))}
                  className="num h-11 w-full bg-transparent px-3 text-[16px] outline-none"
                  aria-label={`Stake in ${symbol}`}
                />
                <div className="flex gap-1 pr-2">
                  {QUICK[asset].map((v) => (
                    <button
                      key={v}
                      className="num rounded border border-line px-2 py-1 text-[11px] text-muted hover:text-fg"
                      onClick={() => setStake(v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              {lim ? (
                <span className="num mt-1 block text-[11px] text-muted">
                  Limits {fmtAsset(lim.minStake, asset, false)}–{fmtAsset(lim.maxStake, asset, false)} {symbol} per bet
                </span>
              ) : null}
            </label>
            <dl className="num grid grid-cols-2 gap-y-1.5 text-[13px]">
              <dt className="text-muted">Potential payout</dt>
              <dd className="text-right font-medium">{payout ? fmtAsset(payout, asset) : "–"}</dd>
              <dt className="text-muted">Potential profit</dt>
              <dd className="text-right text-pos">{payout && amount ? fmtAsset(payout - amount, asset) : "–"}</dd>
              <dt className="text-muted">Wallet balance</dt>
              <dd className="text-right">{isConnected ? fmtAsset(balance, asset) : "–"}</dd>
              <dt className="text-muted">{asset === "USDG" ? "Approval" : "Paid in"}</dt>
              <dd className="text-right">
                {asset === "ETH" ? (
                  "native ETH"
                ) : !isConnected || amount === null ? (
                  "–"
                ) : needsApproval ? (
                  <span className="text-warn">Needed</span>
                ) : (
                  <span className="text-pos">Ready</span>
                )}
              </dd>
            </dl>
            {!isConnected ? (
              <Button variant="primary" className="w-full" onClick={openConnectModal}>
                Connect wallet
              </Button>
            ) : wrongChain ? (
              <Button
                variant="primary"
                className="w-full"
                disabled={switching}
                onClick={() => switchChain({ chainId: chain.id })}
              >
                Switch to {chain.name}
              </Button>
            ) : !open ? (
              <Button className="w-full" disabled>
                Betting closed
              </Button>
            ) : short ? (
              asset === "USDG" && deployment.testToken ? (
                <Button variant="primary" className="w-full" onClick={faucet}>
                  Get 1,000 test USDG
                </Button>
              ) : (
                <Button className="w-full" disabled>
                  Insufficient {symbol}
                </Button>
              )
            ) : (
              <Button
                variant="primary"
                className="w-full"
                disabled={!amount || outOfRange || step === "approving" || step === "placing" || !!moved}
                onClick={place}
              >
                {step === "approving"
                  ? "Approving USDG…"
                  : step === "placing"
                    ? "Placing bet…"
                    : outOfRange
                      ? "Stake outside limits"
                      : needsApproval
                        ? "Approve and place bet"
                        : `Bet ${stake || "0"} ${symbol}`}
              </Button>
            )}
            {isMainnet ? (
              <p className="text-[11px] text-muted">
                Real funds. Winnings are paid in the asset you stake. Results are final after a 10-minute dispute
                window.
              </p>
            ) : null}
            {step === "done" ? (
              <p className="text-[13px] text-pos">Bet confirmed on-chain. Track it in My Bets.</p>
            ) : null}
            {error ? <p className="text-[13px] text-neg">{error}</p> : null}
            {tx ? (
              <p className="text-[12px]">
                <ExtLink href={txUrl(tx)}>View transaction</ExtLink>
              </p>
            ) : null}
          </>
        )}
        {deployment.testToken && isConnected && !wrongChain ? (
          <button
            className="text-[12px] text-muted underline decoration-line underline-offset-2 hover:text-fg"
            onClick={faucet}
          >
            Faucet: 1,000 test USDG (once an hour, no value)
          </button>
        ) : null}
      </div>
    </Card>
  );
}
