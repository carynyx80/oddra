"use client";

import Link from "next/link";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { MARKETS, SELECTIONS, formatOdds, oddraBookAbi } from "@oddra/shared";
import { explain } from "@/components/live/BetSlip";
import { Badge, Button, Card, CardHeader, Empty, ExtLink, Stat, Tabs } from "@/components/ui/primitives";
import { deployment, txUrl } from "@/lib/config";
import { useMyBets, type BetRow } from "@/lib/hooks";
import { fmtUsdg } from "@/lib/utils";

type Tab = "open" | "won" | "lost" | "claimable" | "history";
const TONE = { Open: "muted", Won: "pos", Lost: "neg", Refund: "warn", Paid: "accent" } as const;

export default function BetsPage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const bets = useMyBets(address);
  const extra = useQuery({
    queryKey: ["bets-db", address],
    enabled: !!address,
    queryFn: () => fetch(`/api/bets?address=${address}`).then((r) => r.json()),
  });
  const [tab, setTab] = useState<Tab>("open");
  const rows = bets.data ?? [];
  const groups: Record<Tab, BetRow[]> = {
    open: rows.filter((b) => b.status === "Open"),
    won: rows.filter((b) => b.won === true),
    lost: rows.filter((b) => b.status === "Lost"),
    claimable: rows.filter((b) => b.claimable > 0n),
    history: rows,
  };
  const claimableTotal = groups.claimable.reduce((t, b) => t + b.claimable, 0n);
  const staked = rows.reduce((t, b) => t + b.stake, 0n);
  const pending = groups.open.reduce((t, b) => t + b.payout, 0n);

  if (!isConnected)
    return (
      <Card>
        <Empty>
          <p className="mb-4">Connect a wallet to see your bets.</p>
          <Button variant="primary" onClick={openConnectModal}>
            Connect wallet
          </Button>
        </Empty>
      </Card>
    );

  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">My Bets</h1>
      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label="Claimable" value={`${fmtUsdg(claimableTotal)}`} sub="USDG" />
        <Stat label="Pending winnings" value={fmtUsdg(pending)} sub="if open bets win" />
        <Stat label="Total staked" value={fmtUsdg(staked)} sub={`${rows.length} bets`} />
        <Stat label="Settled" value={String(rows.filter((b) => b.status !== "Open").length)} sub="bets" />
      </Card>
      <Card>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "open", label: "Open", count: groups.open.length },
            { key: "won", label: "Won", count: groups.won.length },
            { key: "lost", label: "Lost", count: groups.lost.length },
            { key: "claimable", label: "Claimable", count: groups.claimable.length },
            { key: "history", label: "History", count: rows.length },
          ]}
        />
        {bets.isLoading ? (
          <Empty>Reading your bets from the contract…</Empty>
        ) : groups[tab].length === 0 ? (
          <Empty>Nothing here yet.</Empty>
        ) : (
          <BetTable rows={groups[tab]} txByBet={extra.data?.txByBet ?? {}} />
        )}
      </Card>
      <ClaimHistory claims={extra.data?.claims ?? []} available={extra.data?.available} />
    </div>
  );
}

function BetTable({ rows, txByBet }: { rows: BetRow[]; txByBet: Record<string, string> }) {
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function claim(id: bigint) {
    setBusy(id.toString());
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: deployment.book,
        abi: oddraBookAbi,
        functionName: "claim",
        args: [id],
      });
      await client!.waitForTransactionReceipt({ hash });
      await qc.invalidateQueries({ queryKey: ["bets"] });
      await qc.invalidateQueries({ queryKey: ["usdg"] });
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="overflow-x-auto">
      {error ? <p className="px-4 pt-3 text-[13px] text-neg">{error}</p> : null}
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="text-left text-muted">
            {["Match", "Market", "Selection", "Stake", "Odds", "Payout", "Status", "Transaction", ""].map((h) => (
              <th key={h} className="label px-4 py-2.5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((b) => {
            const sel = SELECTIONS[b.selection];
            return (
              <tr key={b.id.toString()}>
                <td className="px-4 py-3">
                  <Link href={`/matches/${b.matchId}`} className="hover:text-accent">
                    <span className="num text-muted">#{b.matchId.toString()}</span>
                  </Link>
                </td>
                <td className="px-4 py-3 text-muted">{MARKETS.find((m) => m.key === sel.market)?.title}</td>
                <td className="px-4 py-3">{sel.label}</td>
                <td className="num px-4 py-3">{fmtUsdg(b.stake)}</td>
                <td className="num px-4 py-3">{formatOdds(b.odds)}</td>
                <td className="num px-4 py-3">
                  {fmtUsdg(b.status === "Refund" || (b.status === "Paid" && !b.won) ? b.stake : b.payout)}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={TONE[b.status]}>
                    {b.status === "Paid" ? (b.won ? "Won · paid" : "Refunded") : b.status}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {txByBet[b.id.toString()] ? (
                    <ExtLink href={txUrl(txByBet[b.id.toString()])}>{txByBet[b.id.toString()].slice(0, 10)}…</ExtLink>
                  ) : (
                    <span className="text-muted">bet #{b.id.toString()}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {b.claimable > 0n ? (
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => claim(b.id)}>
                      {busy === b.id.toString() ? "Claiming…" : `Claim ${fmtUsdg(b.claimable)}`}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClaimHistory({
  claims,
  available,
}: {
  claims: { id: number; betId: string; amount: string; automatic: boolean; txHash: string; createdAt: string }[];
  available?: boolean;
}) {
  return (
    <Card>
      <CardHeader
        title="Claim history"
        right={<span className="text-[12px] text-muted">automatic payouts and manual claims</span>}
      />
      {!available ? (
        <Empty>
          Claim history needs the indexer database. Your claimable balance above is always read from the contract.
        </Empty>
      ) : claims.length === 0 ? (
        <Empty>No payouts yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {claims.map((c) => (
            <li key={c.id} className="flex items-center gap-4 px-4 py-2.5 text-[13px]">
              <span className="num w-24 text-muted">bet #{c.betId}</span>
              <span className="num flex-1">{fmtUsdg(c.amount)} USDG</span>
              <Badge>{c.automatic ? "Automatic" : "Claimed"}</Badge>
              <span className="num hidden text-muted sm:block">{new Date(c.createdAt).toLocaleString()}</span>
              <ExtLink href={txUrl(c.txHash)}>tx</ExtLink>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
