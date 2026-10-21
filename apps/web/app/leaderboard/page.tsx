"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, Empty, ExtLink } from "@/components/ui/primitives";
import { addressUrl } from "@/lib/config";
import { short } from "@/lib/utils";

export default function LeaderboardPage() {
  const q = useQuery({
    queryKey: ["leaderboard"],
    queryFn: () => fetch("/api/leaderboard").then((r) => r.json()),
    refetchInterval: 60_000,
  });
  const rows = (q.data?.rows ?? []) as {
    bettor: string;
    settled: number;
    correct: number;
    accuracy: number;
    matches: number;
  }[];
  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">Leaderboard</h1>
      <Card>
        <CardHeader
          title="Prediction accuracy"
          right={<span className="text-[12px] text-muted">ranked by correct predictions, not by money</span>}
        />
        {q.isLoading ? (
          <Empty>Loading…</Empty>
        ) : !q.data?.available ? (
          <Empty>The leaderboard needs the indexer database.</Empty>
        ) : rows.length === 0 ? (
          <Empty>No settled predictions yet. Be the first.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="text-left">
                  {["#", "Wallet", "Correct", "Settled", "Accuracy", "Matches played"].map((h) => (
                    <th key={h} className="label px-4 py-2.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r, i) => (
                  <tr key={r.bettor}>
                    <td className="num px-4 py-3 text-muted">{i + 1}</td>
                    <td className="px-4 py-3">
                      <ExtLink href={addressUrl(r.bettor)}>{short(r.bettor)}</ExtLink>
                    </td>
                    <td className="num px-4 py-3 font-semibold">{r.correct}</td>
                    <td className="num px-4 py-3">{r.settled}</td>
                    <td className="num px-4 py-3">{(r.accuracy * 100).toFixed(1)}%</td>
                    <td className="num px-4 py-3">{r.matches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-[12px] text-muted">
        Every row is derived from verified, settled on-chain bets. Nothing on this page is seeded or simulated.
      </p>
    </div>
  );
}
