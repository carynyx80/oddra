"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatEther } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { ST, formatClock, oddraMatchRegistryAbi } from "@oddra/shared";
import { explain } from "@/components/live/BetSlip";
import { Badge, Button, Card, CardHeader } from "@/components/ui/primitives";
import { deployment } from "@/lib/config";
import type { MatchView } from "@/lib/hooks";

/**
 * A proposed result is final only after the dispute window. Anyone whose replay disagrees can dispute it by posting
 * the ETH bond; an independent arbiter then rules, and the bond is returned if the result is changed.
 */
export function DisputePanel({
  match,
  replayAgrees,
  now,
}: {
  match: MatchView;
  replayAgrees: boolean | null;
  now: number;
}) {
  const client = usePublicClient();
  const qc = useQueryClient();
  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [msg, setMsg] = useState<string | null>(null);
  const params = useQuery({
    queryKey: ["dispute-params"],
    enabled: !!client,
    staleTime: 60_000,
    queryFn: async () => {
      const [window, bond] = await Promise.all([
        client!.readContract({
          address: deployment.registry,
          abi: oddraMatchRegistryAbi,
          functionName: "disputeWindow",
        }) as Promise<bigint>,
        client!.readContract({
          address: deployment.registry,
          abi: oddraMatchRegistryAbi,
          functionName: "disputeBond",
        }) as Promise<bigint>,
      ]);
      return { window: Number(window), bond };
    },
  });
  const s = match.m.status;
  if (s !== ST.Proposed && s !== ST.Disputed) return null;
  const finalAt = Number(match.m.proposedAt) + (params.data?.window ?? 600);
  const open = s === ST.Proposed && now < finalAt;

  async function dispute() {
    setMsg(null);
    if (!params.data) return;
    if (
      !confirm(
        `Dispute this result by posting ${formatEther(params.data.bond)} ETH? It is returned only if the arbiter changes the result.`,
      )
    )
      return;
    try {
      const hash = await writeContractAsync({
        address: deployment.registry,
        abi: oddraMatchRegistryAbi,
        functionName: "dispute",
        args: [match.id],
        value: params.data.bond,
      });
      await client!.waitForTransactionReceipt({ hash });
      setMsg(
        "Dispute filed. The arbiter will rule; if no ruling comes within 24 hours, the match is voided and every stake refunded.",
      );
      await qc.invalidateQueries({ queryKey: ["match"] });
    } catch (e) {
      setMsg(explain(e));
    }
  }

  return (
    <Card className={replayAgrees === false ? "border-neg/50" : s === ST.Disputed ? "border-warn/50" : ""}>
      <CardHeader
        title="Result status"
        right={
          s === ST.Disputed ? <Badge tone="warn">Disputed</Badge> : <Badge tone="accent">Dispute window open</Badge>
        }
      />
      <div className="space-y-3 p-4 text-[13px] text-muted">
        {s === ST.Disputed ? (
          <p>
            This result is disputed. The arbiter rules on it; if there is no ruling within 24 hours the match is voided
            and every stake is refundable.
          </p>
        ) : (
          <p>
            Proposed result {match.m.homeGoals}–{match.m.awayGoals}. It becomes final{" "}
            {open ? (
              <>
                in <span className="num text-fg">{formatClock(finalAt - now)}</span>
              </>
            ) : (
              "as soon as it is finalised"
            )}
            {replayAgrees === true ? ", and your browser's replay agrees with it." : replayAgrees === false ? "." : "."}
          </p>
        )}
        {replayAgrees === false ? (
          <p className="text-neg">Your browser&apos;s replay does not match this result.</p>
        ) : null}
        {open ? (
          <Button
            variant={replayAgrees === false ? "danger" : "outline"}
            size="sm"
            disabled={!isConnected || !params.data}
            onClick={dispute}
          >
            Dispute ({params.data ? `${formatEther(params.data.bond)} ETH bond` : "…"})
          </Button>
        ) : null}
        {msg ? <p>{msg}</p> : null}
      </div>
    </Card>
  );
}
