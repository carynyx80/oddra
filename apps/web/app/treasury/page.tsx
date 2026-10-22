"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { AssetKey } from "@oddra/shared";
import { LineChart } from "@/components/Chart";
import { Card, CardHeader, Empty, ExtLink, Tabs } from "@/components/ui/primitives";
import { ExchangeStats } from "@/components/ExchangeStats";
import { addressUrl, deployment, exchangeMode, txUrl, usdgSymbol } from "@/lib/config";
import { useTreasury, type TreasuryTotals } from "@/lib/hooks";
import { fmtAsset, short } from "@/lib/utils";

const ROWS: { key: keyof TreasuryTotals | "net" | "other"; label: string; sub: string }[] = [
  { key: "balance", label: "Total reserves", sub: "held by the treasury" },
  { key: "freeBalance", label: "Available", sub: "unreserved liquidity" },
  { key: "totalReserved", label: "Locked liabilities", sub: "worst-case payouts + unclaimed" },
  { key: "totalStakes", label: "Betting volume", sub: "total stakes" },
  { key: "totalPayouts", label: "Total payouts", sub: "winnings and refunds" },
  { key: "net", label: "Net house result", sub: "stakes minus payouts (incl. open bets)" },
  { key: "totalCreatorFees", label: "Creator fees", sub: "contributed by $ODRA" },
  { key: "other", label: "Other contributions", sub: "house liquidity, forfeited dispute bonds" },
];

function value(t: TreasuryTotals, key: (typeof ROWS)[number]["key"]): bigint {
  if (key === "net") return t.totalStakes - t.totalPayouts;
  if (key === "other") return t.totalContributed - t.totalCreatorFees;
  return t[key];
}

const signed = (v: bigint, asset: AssetKey) => (v < 0n ? `−${fmtAsset(-v, asset, false)}` : fmtAsset(v, asset, false));

export default function TreasuryPage() {
  return exchangeMode ? <ExchangeStats /> : <HouseTreasury />;
}

function HouseTreasury() {
  const t = useTreasury();
  const [chartAsset, setChartAsset] = useState<AssetKey>("USDG");
  const hist = useQuery({
    queryKey: ["treasury-hist"],
    queryFn: () => fetch("/api/treasury").then((r) => r.json()),
    refetchInterval: 60_000,
  });
  const snaps = ((hist.data?.snapshots ?? []) as Record<string, string>[]).filter(
    (s) => (s.asset ?? "USDG") === chartAsset,
  );
  const dec = chartAsset === "ETH" ? 1e18 : 1e6;
  const labels = snaps.map((s) =>
    new Date(s.takenAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  );
  const series = (k: string) => snaps.map((s) => Number(s[k]) / dec);
  const fmt = (v: number) =>
    chartAsset === "ETH"
      ? v.toFixed(2)
      : v >= 1e6
        ? `${(v / 1e6).toFixed(2)}M`
        : v >= 1e3
          ? `${(v / 1e3).toFixed(1)}k`
          : v.toFixed(0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">Treasury</h1>
        <span className="text-[12px] text-muted">
          Live from <ExtLink href={addressUrl(deployment.treasury)}>{short(deployment.treasury)}</ExtLink>
        </span>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="text-left">
              <th className="label px-4 py-3 font-normal" />
              <th className="label px-4 py-3 text-right font-normal">{usdgSymbol}</th>
              <th className="label px-4 py-3 text-right font-normal">ETH</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ROWS.map((r) => (
              <tr key={r.key}>
                <td className="px-4 py-3">
                  <div>{r.label}</div>
                  <div className="text-[11px] text-muted">{r.sub}</div>
                </td>
                {(["USDG", "ETH"] as const).map((a) => (
                  <td
                    key={a}
                    className="num px-4 py-3 text-right font-[family-name:var(--font-display)] text-[16px] font-semibold"
                  >
                    {t.data ? signed(value(t.data[a], r.key), a) : "–"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card>
        <div className="flex items-center justify-between pr-3">
          <Tabs
            value={chartAsset}
            onChange={setChartAsset}
            tabs={[
              { key: "USDG", label: `${usdgSymbol} over time` },
              { key: "ETH", label: "ETH over time" },
            ]}
          />
        </div>
        <div className="p-4">
          {!hist.data?.available ? (
            <Empty>Charts need the indexer database. The figures above are always live from the contract.</Empty>
          ) : (
            <LineChart
              labels={labels}
              format={fmt}
              series={[
                { name: "Reserves", color: "#ffffff", values: series("balance") },
                { name: "Locked", color: "#F5BE55", values: series("reserved") },
                { name: "Volume", color: "#B8FF65", values: series("totalStakes") },
                { name: "Payouts", color: "#39D98A", values: series("totalPayouts") },
              ]}
            />
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="Contributions" />
        {!hist.data?.available || (hist.data.contributions ?? []).length === 0 ? (
          <Empty>No contributions indexed yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {(
              hist.data.contributions as {
                id: number;
                asset: AssetKey;
                source: string;
                amount: string;
                txHash: string;
                createdAt: string;
              }[]
            ).map((c) => (
              <li key={c.id} className="flex items-center gap-4 px-4 py-2.5 text-[13px]">
                <span className="w-32 text-muted">
                  {c.source === "creator-fees"
                    ? "Creator fees"
                    : c.source === "house"
                      ? "House liquidity"
                      : c.source === "dispute-bond"
                        ? "Dispute bond"
                        : c.source}
                </span>
                <span className="num flex-1">{fmtAsset(c.amount, c.asset ?? "USDG")}</span>
                <span className="num hidden text-muted sm:block">{new Date(c.createdAt).toLocaleString()}</span>
                <ExtLink href={txUrl(c.txHash)}>tx</ExtLink>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-4 text-[13px] leading-relaxed text-muted">
        USDG and ETH are separate books: a bet is reserved, settled and paid in the asset it was staked in. Every
        accepted bet reserves the largest amount its asset book on that match could pay across all 33 result scenarios,
        so correlated selections are covered together. Reserved funds can only leave the treasury as a payout to a
        bettor; the operator can withdraw only the unreserved balance. Unrealised creator fees are never counted as
        liquidity.
      </Card>
    </div>
  );
}
