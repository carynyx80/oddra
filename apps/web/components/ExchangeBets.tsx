"use client";

import Link from "next/link";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { MARKETS, SELECTIONS, formatOdds, oddraExchangeAbi, type AssetKey } from "@oddra/shared";
import { explain } from "@/components/live/BetSlip";
import { Badge, Button, Card, Empty, Stat, Tabs } from "@/components/ui/primitives";
import { deployment } from "@/lib/config";
import { useMyExchange, type OfferRow, type PositionRow } from "@/lib/exchange";
import { fmtAsset } from "@/lib/utils";

type Tab = "open" | "unmatched" | "claimable" | "settled";
const TONE = { Open: "muted", Won: "pos", Lost: "neg", Void: "warn" } as const;

/** My Bets on the exchange: matched positions (claim) and unmatched offers (cancel). */
export function ExchangeBets() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const data = useMyExchange(address);
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const positions = data.data?.positions ?? [];
  const offers = (data.data?.offers ?? []).filter((o) => !o.closed && o.remaining > 0n);
  const groups = {
    open: positions.filter((p) => p.status === "Open"),
    claimable: positions.filter((p) => p.claimable > 0n),
    settled: positions.filter((p) => p.status !== "Open"),
  };
  const sum = (list: PositionRow[], pick: (p: PositionRow) => bigint, asset: AssetKey) =>
    list.filter((p) => p.asset === asset).reduce((t, p) => t + pick(p), 0n);
  const escrowed = (asset: AssetKey) => offers.filter((o) => o.asset === asset).reduce((t, o) => t + o.escrow, 0n);

  async function run(key: string, fn: () => Promise<`0x${string}`>) {
    setBusy(key);
    setError(null);
    try {
      await client!.waitForTransactionReceipt({ hash: await fn() });
      await Promise.all(["xbets", "usdg", "orderbook"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }
  const X = { address: deployment.exchange!, abi: oddraExchangeAbi } as const;
  const claim = (p: PositionRow) =>
    run(`p${p.id}`, () => writeContractAsync({ ...X, functionName: "claim", args: [p.id, address!] }));
  const cancel = (o: OfferRow) =>
    run(`o${o.id}`, () => writeContractAsync({ ...X, functionName: "cancel", args: [o.id] }));

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
        <Stat
          label="Claimable"
          value={fmtAsset(
            sum(groups.claimable, (p) => p.claimable, "USDG"),
            "USDG",
          )}
          sub={fmtAsset(
            sum(groups.claimable, (p) => p.claimable, "ETH"),
            "ETH",
          )}
        />
        <Stat
          label="At risk in matched bets"
          value={fmtAsset(
            sum(groups.open, (p) => p.risked, "USDG"),
            "USDG",
          )}
          sub={`${fmtAsset(
            sum(groups.open, (p) => p.risked, "ETH"),
            "ETH",
          )} · ${groups.open.length} open`}
        />
        <Stat
          label="Held in unmatched offers"
          value={fmtAsset(escrowed("USDG"), "USDG")}
          sub={`${fmtAsset(escrowed("ETH"), "ETH")} · returned at kickoff`}
        />
        <Stat label="Settled" value={String(groups.settled.length)} sub="positions" />
      </Card>
      <Card>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "open", label: "Matched", count: groups.open.length },
            { key: "unmatched", label: "Unmatched", count: offers.length },
            { key: "claimable", label: "Claimable", count: groups.claimable.length },
            { key: "settled", label: "Settled", count: groups.settled.length },
          ]}
        />
        {error ? <p className="px-4 pt-3 text-[13px] text-neg">{error}</p> : null}
        {data.isLoading ? (
          <Empty>Reading your bets from the contract…</Empty>
        ) : tab === "unmatched" ? (
          offers.length === 0 ? (
            <Empty>No unmatched offers.</Empty>
          ) : (
            <Table head={["Match", "Market", "Selection", "Side", "Odds", "Unmatched", "Held", ""]}>
              {offers.map((o) => (
                <tr key={o.id.toString()}>
                  <MatchCell id={o.matchId} />
                  <SelectionCells id={o.selection} />
                  <SideCell side={o.side} />
                  <td className="num px-4 py-3">{formatOdds(o.odds)}</td>
                  <td className="num px-4 py-3">
                    {fmtAsset(o.remaining, o.asset)}
                    {o.remaining < o.amount ? (
                      <span className="block text-[11px] text-muted">of {fmtAsset(o.amount, o.asset, false)}</span>
                    ) : null}
                  </td>
                  <td className="num px-4 py-3">{fmtAsset(o.escrow, o.asset)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" disabled={busy !== null} onClick={() => cancel(o)}>
                      {busy === `o${o.id}` ? "Cancelling…" : "Cancel"}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )
        ) : groups[tab].length === 0 ? (
          <Empty>Nothing here yet.</Empty>
        ) : (
          <Table head={["Match", "Market", "Selection", "Side", "Odds", "Stake", "At risk", "Status", ""]}>
            {groups[tab].map((p) => (
              <tr key={p.id.toString()}>
                <MatchCell id={p.matchId} />
                <SelectionCells id={p.selection} />
                <SideCell side={p.side} />
                <td className="num px-4 py-3">{formatOdds(p.odds)}</td>
                <td className="num px-4 py-3">{fmtAsset(p.stake, p.asset)}</td>
                <td className="num px-4 py-3">{fmtAsset(p.risked, p.asset)}</td>
                <td className="px-4 py-3">
                  <Badge tone={TONE[p.status]}>
                    {p.status === "Void"
                      ? p.paid
                        ? "Refunded"
                        : "Void"
                      : p.status === "Won" && p.paid
                        ? "Won · paid"
                        : p.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  {p.claimable > 0n ? (
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => claim(p)}>
                      {busy === `p${p.id}` ? "Claiming…" : `Claim ${fmtAsset(p.claimable, p.asset)}`}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="text-[12px] text-muted">
        Winnings are paid automatically after the dispute window; Claim is only needed if an automatic payout failed.
        Unmatched offers are returned automatically at kickoff.
      </p>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead>
          <tr className="text-left text-muted">
            {head.map((h, i) => (
              <th key={i} className="label px-4 py-2.5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

const MatchCell = ({ id }: { id: bigint }) => (
  <td className="px-4 py-3">
    <Link href={`/matches/${id}`} className="num text-muted hover:text-accent">
      #{id.toString()}
    </Link>
  </td>
);

function SelectionCells({ id }: { id: number }) {
  const sel = SELECTIONS[id];
  return (
    <>
      <td className="px-4 py-3 text-muted">{MARKETS.find((m) => m.key === sel.market)?.title}</td>
      <td className="px-4 py-3">{sel.label}</td>
    </>
  );
}

const SideCell = ({ side }: { side: "back" | "lay" }) => (
  <td className={`px-4 py-3 font-medium ${side === "back" ? "text-back" : "text-lay"}`}>
    {side === "back" ? "Back" : "Lay"}
  </td>
);
