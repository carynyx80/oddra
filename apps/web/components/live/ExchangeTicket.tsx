"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Hash } from "viem";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import {
  MARKETS,
  SELECTIONS,
  formatOdds,
  oddraExchangeAbi,
  oddraTestUSDGAbi,
  parseAmount,
  type AssetKey,
} from "@oddra/shared";
import { explain } from "@/components/live/BetSlip";
import { Button, Card, CardHeader, ExtLink } from "@/components/ui/primitives";
import { chain, deployment, isMainnet, txUrl, usdgSymbol } from "@/lib/config";
import { assetAddress, planOrder, useExchangeSettings, useOrderBook, type Side } from "@/lib/exchange";
import { useUsdg } from "@/lib/hooks";
import { useSlip } from "@/lib/slip";
import { cn, fmtAsset } from "@/lib/utils";

type Step = "idle" | "approving" | "matching" | "posting" | "done" | "error";

const QUICK: Record<AssetKey, string[]> = { USDG: ["5", "25", "100"], ETH: ["0.001", "0.005", "0.01"] };
const GAS_RESERVE = 2n * 10n ** 14n;

/** The usual exchange price ladder: finer steps at short odds. */
const LADDER: [number, number][] = [
  [200, 1],
  [300, 2],
  [400, 5],
  [600, 10],
  [1000, 20],
  [2000, 50],
  [3000, 100],
  [5000, 200],
  [10000, 500],
  [100000, 1000],
];
export function stepOdds(odds: number, dir: 1 | -1): number {
  const at = dir === 1 ? odds : odds - 1;
  const inc = LADDER.find(([max]) => at < max)?.[1] ?? 1000;
  const next = odds + dir * inc;
  return Math.min(100_000, Math.max(101, Math.round(next / inc) * inc));
}
const parseOdds = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

/**
 * Back/lay ticket. The stake is always the backer's stake (as on any betting exchange): backing risks it, laying
 * risks the liability stake × (odds − 1). The order first takes the best matching offers, then posts the rest at
 * the chosen odds for someone else to take; unmatched offers are returned at kickoff.
 */
export function ExchangeTicket({
  open,
  referenceOdds,
  homeName,
  awayName,
}: {
  open: boolean;
  referenceOdds: number[] | null;
  homeName: string;
  awayName: string;
}) {
  const { pick, stake, setStake, setPick, asset, setAsset } = useSlip();
  const [oddsText, setOddsText] = useState("");
  const [post, setPost] = useState(true);
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const client = usePublicClient();
  const qc = useQueryClient();
  const wallet = useUsdg(address);
  const book = useOrderBook(pick?.matchId);
  const settings = useExchangeSettings();
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hash | null>(null);

  const side: Side = pick?.side ?? "back";
  useEffect(() => {
    setStep("idle");
    setError(null);
    setTx(null);
    if (pick) setOddsText((pick.odds / 100).toFixed(2));
  }, [pick?.matchId, pick?.selection, pick?.side, pick?.odds, asset]); // eslint-disable-line react-hooks/exhaustive-deps

  const decimals = asset === "ETH" ? 18 : 6;
  const symbol = asset === "ETH" ? "ETH" : usdgSymbol;
  const sel = pick ? SELECTIONS[pick.selection] : null;
  const odds = parseOdds(oddsText);
  const badOdds = odds < 101 || odds > 100_000;
  const amount = parseAmount(stake, decimals);
  const min = settings.data?.minAmount[asset] ?? 0n;
  const bps = settings.data?.commissionBps ?? 200;
  const plan = useMemo(
    () =>
      pick && amount && !badOdds
        ? planOrder({
            offers: book.data ?? [],
            me: address,
            selection: pick.selection,
            side,
            asset,
            odds,
            stake: amount,
            minAmount: min,
            postRemainder: post,
          })
        : null,
    [pick, amount, badOdds, book.data, address, side, asset, odds, min, post],
  );
  const balance = asset === "ETH" ? (wallet.data?.eth ?? 0n) : (wallet.data?.balance ?? 0n);
  const total = plan?.total ?? 0n;
  const needsApproval = asset === "USDG" && total > 0n && (wallet.data?.allowance ?? 0n) < total;
  const wrongChain = isConnected && chainId !== chain.id;
  const short = total > 0n && (asset === "ETH" ? balance < total + GAS_RESERVE / 4n : balance < total);
  const tooSmall = amount !== null && amount > 0n && amount < min;
  const nothing = !plan || (plan.matched === 0n && plan.remainder === 0n);
  const winNet = plan ? plan.winGross - (plan.winGross * BigInt(bps)) / 10_000n : 0n;
  const ref = pick && referenceOdds ? referenceOdds[pick.selection] : 0;
  const name = !pick
    ? ""
    : pick.selection === 0 || pick.selection === 10
      ? homeName
      : pick.selection === 2 || pick.selection === 11
        ? awayName
        : sel!.label;

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

  async function submit() {
    if (!pick || !plan || nothing) return;
    setError(null);
    const X = deployment.exchange!;
    try {
      if (needsApproval) {
        setStep("approving");
        // approve exactly what this order needs, never an unlimited allowance
        await wait(
          await writeContractAsync({
            address: deployment.usdg,
            abi: oddraTestUSDGAbi,
            functionName: "approve",
            args: [X, total],
          }),
        );
      }
      if (plan.fills.length) {
        setStep("matching");
        await wait(
          await writeContractAsync({
            address: X,
            abi: oddraExchangeAbi,
            functionName: "takeMany",
            args: [plan.fills.map((f) => f.offer.id), plan.fills.map((f) => f.amount)],
            value: plan.takeValue,
          }),
        );
      }
      if (plan.remainder > 0n) {
        setStep("posting");
        await wait(
          await writeContractAsync({
            address: X,
            abi: oddraExchangeAbi,
            functionName: "placeOffer",
            args: [pick.matchId, pick.selection, side === "back" ? 0 : 1, odds, plan.remainder, assetAddress(asset)],
            value: asset === "ETH" ? plan.remainderEscrow : 0n,
          }),
        );
      }
      setStep("done");
    } catch (e) {
      setStep("error");
      setError(explain(e));
    } finally {
      await Promise.all(["usdg", "xbets", "orderbook"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    }
  }

  const busy = step === "approving" || step === "matching" || step === "posting";
  const back = side === "back";
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
          <p className="text-[13px] text-muted">Pick Back or Lay on a selection.</p>
        ) : (
          <>
            <div
              className={cn(
                "rounded-md border p-3",
                back ? "border-back/40 bg-back/[0.07]" : "border-lay/40 bg-lay/[0.07]",
              )}
            >
              <div className="label">
                {MARKETS.find((m) => m.key === sel.market)?.title} · Match #{pick.matchId.toString()}
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-[15px] font-medium">
                  <span className={back ? "text-back" : "text-lay"}>{back ? "Back" : "Lay"}</span> {name}
                </span>
                {ref ? <span className="num text-[11px] text-muted">guide {formatOdds(ref)}</span> : null}
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {back ? `You win if ${name} happens.` : `You win if ${name} does not happen.`}
              </p>
            </div>

            <div
              className="grid grid-cols-2 gap-1 rounded-md border border-line bg-bg p-1"
              role="radiogroup"
              aria-label="Side"
            >
              {(["back", "lay"] as const).map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={side === s}
                  onClick={() => setPick({ ...pick, side: s })}
                  className={cn(
                    "rounded px-3 py-1.5 text-[13px] font-medium capitalize transition-colors",
                    side === s
                      ? s === "back"
                        ? "bg-back/20 text-back"
                        : "bg-lay/20 text-lay"
                      : "text-muted hover:text-fg",
                  )}
                >
                  {s}
                </button>
              ))}
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

            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
              <label className="block">
                <span className="label">Odds</span>
                <div className="mt-1.5 flex items-center rounded-md border border-line bg-bg focus-within:border-accent/60">
                  <button
                    className="h-11 px-2 text-muted hover:text-fg"
                    aria-label="Lower odds"
                    onClick={() => setOddsText((stepOdds(odds || 200, -1) / 100).toFixed(2))}
                  >
                    −
                  </button>
                  <input
                    inputMode="decimal"
                    value={oddsText}
                    onChange={(e) => setOddsText(e.target.value)}
                    className="num h-11 w-full min-w-0 bg-transparent text-center text-[16px] outline-none"
                    aria-label="Odds"
                  />
                  <button
                    className="h-11 px-2 text-muted hover:text-fg"
                    aria-label="Raise odds"
                    onClick={() => setOddsText((stepOdds(odds || 200, 1) / 100).toFixed(2))}
                  >
                    +
                  </button>
                </div>
              </label>
              <label className="block">
                <span className="label">
                  {back ? "Stake" : "Backer's stake"} ({symbol})
                </span>
                <input
                  inputMode="decimal"
                  value={stake}
                  onChange={(e) => setStake(e.target.value.replace(",", "."))}
                  className="num mt-1.5 h-11 w-full rounded-md border border-line bg-bg px-3 text-[16px] outline-none focus:border-accent/60"
                  aria-label={`Stake in ${symbol}`}
                />
              </label>
            </div>
            <div className="flex gap-1">
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

            <dl className="num grid grid-cols-2 gap-y-1.5 text-[13px]">
              <dt className="text-muted">Matched now</dt>
              <dd className="text-right">
                {plan ? (plan.matched > 0n ? fmtAsset(plan.matched, asset) : "nothing yet") : "–"}
              </dd>
              <dt className="text-muted">Offered at {badOdds ? "–" : formatOdds(odds)}</dt>
              <dd className="text-right">{plan && plan.remainder > 0n ? fmtAsset(plan.remainder, asset) : "–"}</dd>
              <dt className="text-muted">{back ? "You pay" : "Your liability"}</dt>
              <dd className="text-right font-medium">{plan ? fmtAsset(total, asset) : "–"}</dd>
              <dt className="text-muted">Profit if you win</dt>
              <dd className="text-right text-pos">{plan ? fmtAsset(winNet, asset) : "–"}</dd>
              <dt className="text-muted">Wallet balance</dt>
              <dd className="text-right">{isConnected ? fmtAsset(balance, asset) : "–"}</dd>
            </dl>
            <label className="flex items-start gap-2 text-[12px] text-muted">
              <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} className="mt-0.5" />
              <span>
                Offer any unmatched part at these odds until kickoff (returned automatically if nobody takes it).
              </span>
            </label>
            {plan && plan.dust > 0n ? (
              <p className="text-[12px] text-warn">
                {fmtAsset(plan.dust, asset)} is below the {fmtAsset(min, asset)} minimum offer and will not be posted.
              </p>
            ) : null}

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
                disabled={!amount || badOdds || tooSmall || nothing || busy}
                onClick={submit}
              >
                {step === "approving"
                  ? "Approving USDG…"
                  : step === "matching"
                    ? "Matching…"
                    : step === "posting"
                      ? "Posting offer…"
                      : badOdds
                        ? "Enter odds 1.01–1000"
                        : tooSmall
                          ? `Minimum ${fmtAsset(min, asset)}`
                          : nothing
                            ? "No match at these odds"
                            : `${back ? "Back" : "Lay"} ${stake || "0"} ${symbol}`}
              </Button>
            )}
            <p className="text-[11px] text-muted">
              Peer-to-peer: you bet against other players, not the house. {bps / 100}% commission on net winnings.
              {isMainnet ? " Real funds. Results are final after a 10-minute dispute window." : ""}
            </p>
            {step === "done" ? (
              <p className="text-[13px] text-pos">Done on-chain. Track matched and open orders in My Bets.</p>
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
