"use client";

import { useQuery } from "@tanstack/react-query";
import { LineChart } from "@/components/Chart";
import { Card, CardHeader, Empty, ExtLink, Stat } from "@/components/ui/primitives";
import { addressUrl, deployment, txUrl } from "@/lib/config";
import { useTreasury } from "@/lib/hooks";
import { fmtUsdg, short } from "@/lib/utils";

const usd = (v: number) =>
  v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0);

export default function TreasuryPage() {
  const t = useTreasury();
  const hist = useQuery({
    queryKey: ["treasury-hist"],
    queryFn: () => fetch("/api/treasury").then((r) => r.json()),
    refetchInterval: 60_000,
  });
  const d = t.data;
  const net = d ? d.totalStakes - d.totalPayouts : null;
  const snaps = (hist.data?.snapshots ?? []) as Record<string, string>[];
  const labels = snaps.map((s) =>
    new Date(s.takenAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  );
  const series = (k: string) => snaps.map((s) => Number(s[k]) / 1e6);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">Treasury</h1>
        <span className="text-[12px] text-muted">
          Live from <ExtLink href={addressUrl(deployment.treasury)}>{short(deployment.treasury)}</ExtLink> · test USDG
        </span>
      </div>
      <Card className="grid grid-cols-2 gap-5 p-4 md:grid-cols-4">
        <Stat label="Total reserves" value={d ? fmtUsdg(d.balance, 0) : "–"} sub="USDG held" />
        <Stat label="Available" value={d ? fmtUsdg(d.freeBalance, 0) : "–"} sub="unreserved liquidity" />
        <Stat
          label="Locked liabilities"
          value={d ? fmtUsdg(d.totalReserved, 0) : "–"}
          sub="worst-case payouts + unclaimed"
        />
        <Stat label="Creator fees" value={d ? fmtUsdg(d.totalCreatorFees, 0) : "–"} sub="contributed as USDG" />
        <Stat label="Betting volume" value={d ? fmtUsdg(d.totalStakes, 0) : "–"} sub="total stakes" />
        <Stat label="Total payouts" value={d ? fmtUsdg(d.totalPayouts, 0) : "–"} sub="winnings and refunds" />
        <Stat
          label="Net house result"
          value={net === null ? "–" : `${net < 0n ? "−" : ""}${fmtUsdg(net < 0n ? -net : net, 0)}`}
          sub="stakes minus payouts (incl. open bets)"
        />
        <Stat
          label="Other contributions"
          value={d ? fmtUsdg(d.totalContributed - d.totalCreatorFees, 0) : "–"}
          sub="house seed liquidity"
        />
      </Card>
      <Card>
        <CardHeader
          title="Reserves over time"
          right={<span className="text-[12px] text-muted">snapshots of on-chain totals</span>}
        />
        <div className="p-4">
          {!hist.data?.available ? (
            <Empty>Charts need the indexer database. The figures above are always live from the contract.</Empty>
          ) : (
            <LineChart
              labels={labels}
              format={usd}
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
                source: string;
                account: string;
                amount: string;
                txHash: string;
                createdAt: string;
              }[]
            ).map((c) => (
              <li key={c.id} className="flex items-center gap-4 px-4 py-2.5 text-[13px]">
                <span className="w-28 text-muted">
                  {c.source === "creator-fees" ? "Creator fees" : c.source === "house" ? "House seed" : c.source}
                </span>
                <span className="num flex-1">{fmtUsdg(c.amount)} USDG</span>
                <span className="num hidden text-muted sm:block">{new Date(c.createdAt).toLocaleString()}</span>
                <ExtLink href={txUrl(c.txHash)}>tx</ExtLink>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-4 text-[13px] leading-relaxed text-muted">
        Every accepted bet reserves the largest amount the match could pay across all 33 result scenarios, so correlated
        selections are covered together. Reserved USDG can only leave the treasury as a payout to a bettor; the operator
        can withdraw only the unreserved balance. Unrealised creator fees are never counted as liquidity: they count
        only once they arrive here as USDG.
      </Card>
    </div>
  );
}
