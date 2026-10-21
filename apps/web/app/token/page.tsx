"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { oddraFeeCollectorAbi } from "@oddra/shared";
import { Mark } from "@/components/Logo";
import { explain } from "@/components/live/BetSlip";
import { Badge, Button, Card, CardHeader, Empty, ExtLink, Stat } from "@/components/ui/primitives";
import { addressUrl, deployment, odraToken, txUrl } from "@/lib/config";
import { useTreasury } from "@/lib/hooks";
import { fmtUsdg, short } from "@/lib/utils";

export default function TokenPage() {
  const t = useTreasury();
  const q = useQuery({
    queryKey: ["token-hist"],
    queryFn: () => fetch("/api/token").then((r) => r.json()),
    refetchInterval: 60_000,
  });
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const [msg, setMsg] = useState<string | null>(null);

  async function forward() {
    setMsg(null);
    try {
      const hash = await writeContractAsync({
        address: deployment.feeCollector,
        abi: oddraFeeCollectorAbi,
        functionName: "forward",
      });
      await client!.waitForTransactionReceipt({ hash });
      setMsg("Forwarded any USDG held by the collector to the treasury.");
    } catch (e) {
      setMsg(explain(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Mark size={36} />
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">$ODRA</h1>
          <p className="text-[13px] text-muted">
            The Oddra ecosystem token. Not the betting currency: every bet is in USDG.
          </p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Token"
            right={odraToken ? <Badge tone="pos">Verified address</Badge> : <Badge tone="warn">Not launched</Badge>}
          />
          <div className="space-y-3 p-4 text-[13px]">
            {odraToken ? (
              <p>
                Contract: <ExtLink href={addressUrl(odraToken)}>{odraToken}</ExtLink>
              </p>
            ) : (
              <p className="text-muted">
                $ODRA has not launched. No contract address is shown until a real, verified one exists, and Oddra never
                displays a price or market capitalisation it has not read from a verified source.
              </p>
            )}
            <p className="text-muted">
              Launch platform: Pons V2 on Robinhood Chain, whose fee escrow pays a token&apos;s creator fees to its
              recipient. Oddra&apos;s recipient is the fee collector below.
            </p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Creator-fee model" />
          <ol className="list-decimal space-y-2 py-4 pl-9 pr-4 text-[13px] text-muted">
            <li>100% of net creator fees the project receives are allocated to the betting treasury.</li>
            <li>The fee collector claims accrued fees from the launch platform&apos;s escrow (permissionless).</li>
            <li>Fees paid in ETH are converted to USDG only through an audited adapter with a minimum-output check.</li>
            <li>USDG is forwarded to the treasury and recorded on-chain as a creator-fee contribution.</li>
            <li>Fees that have not arrived as USDG are never counted as betting liquidity.</li>
          </ol>
        </Card>
      </div>
      <Card className="grid grid-cols-2 gap-5 p-4 md:grid-cols-4">
        <Stat label="Creator fees to treasury" value={t.data ? fmtUsdg(t.data.totalCreatorFees, 0) : "–"} sub="USDG" />
        <Stat
          label="Fee collector"
          value={deployment.feeCollector ? short(deployment.feeCollector) : "–"}
          sub={deployment.feeCollector ? <ExtLink href={addressUrl(deployment.feeCollector)}>explorer</ExtLink> : null}
        />
        <Stat label="Conversion adapter" value="None" sub="ETH stays in the collector until one is audited" />
        <Stat label="Utility" value="Ecosystem" sub="no wagering use" />
      </Card>
      <Card>
        <CardHeader
          title="Contribution history"
          right={
            deployment.feeCollector ? (
              <Button size="sm" onClick={forward}>
                Forward collected USDG
              </Button>
            ) : null
          }
        />
        {msg ? <p className="px-4 pt-3 text-[13px] text-muted">{msg}</p> : null}
        {!q.data?.available || (q.data.receipts ?? []).length === 0 ? (
          <Empty>No creator fees have been received yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {(
              q.data.receipts as { id: number; asset: string; amount: string; txHash: string; createdAt: string }[]
            ).map((r) => (
              <li key={r.id} className="flex items-center gap-4 px-4 py-2.5 text-[13px]">
                <Badge>{r.asset === "USDG" ? "To treasury" : "Received"}</Badge>
                <span className="num flex-1">
                  {r.asset === "USDG" ? `${fmtUsdg(r.amount)} USDG` : `${(Number(r.amount) / 1e18).toFixed(6)} ETH`}
                </span>
                <span className="num hidden text-muted sm:block">{new Date(r.createdAt).toLocaleString()}</span>
                <ExtLink href={txUrl(r.txHash)}>tx</ExtLink>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
