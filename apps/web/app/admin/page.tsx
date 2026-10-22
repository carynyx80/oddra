"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, usePublicClient, useReadContract, useSignMessage, useWriteContract } from "wagmi";
import { oddraBookAbi } from "@oddra/shared";
import { explain } from "@/components/live/BetSlip";
import { Badge, Button, Card, CardHeader, Empty, ExtLink, Stat } from "@/components/ui/primitives";
import { deployment, exchangeMode, txUrl } from "@/lib/config";
import { useExchangeTotals } from "@/lib/exchange";
import { useTreasury } from "@/lib/hooks";
import { fmtAsset, fmtUsdg, short } from "@/lib/utils";

/** Pause/unpause the contract that takes bets (both expose the same Pausable functions). */
const BETS = (exchangeMode ? { address: deployment.exchange! } : { address: deployment.book }) as {
  address: `0x${string}`;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AdminPage() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [authError, setAuthError] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["admin-status"],
    queryFn: async () => {
      const r = await fetch("/api/admin/status", { cache: "no-store" });
      if (r.status === 401) return { unauthorised: true };
      return r.json();
    },
    refetchInterval: 10_000,
  });
  const treasury = useTreasury();
  const totals = useExchangeTotals();
  const paused = useReadContract({
    ...BETS,
    abi: oddraBookAbi,
    functionName: "paused",
    query: { refetchInterval: 10_000 },
  });
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const [msg, setMsg] = useState<string | null>(null);

  async function signIn() {
    setAuthError(null);
    try {
      const n = await fetch("/api/admin/nonce", { method: "POST", body: JSON.stringify({ address }) }).then((r) =>
        r.json(),
      );
      if (!n.message) throw new Error(n.reason ?? n.error ?? "unavailable");
      const signature = await signMessageAsync({ message: n.message });
      const r = await fetch("/api/admin/session", {
        method: "POST",
        body: JSON.stringify({ address, nonce: n.nonce, signature }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error ?? "denied");
      await status.refetch();
    } catch (e) {
      setAuthError(explain(e));
    }
  }

  async function togglePause() {
    setMsg(null);
    try {
      const fn = paused.data ? "unpause" : "pause";
      if (!confirm(`${fn === "pause" ? "Pause" : "Resume"} all new betting? Claims are never paused.`)) return;
      const hash = await writeContractAsync({ ...BETS, abi: oddraBookAbi, functionName: fn });
      await client!.waitForTransactionReceipt({ hash });
      await paused.refetch();
      setMsg(`Betting ${fn === "pause" ? "paused" : "resumed"}.`);
    } catch (e) {
      setMsg(explain(e));
    }
  }

  const s = status.data as any;
  if (!s || s.available === false || s.unauthorised) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader title="Operations" />
        <div className="space-y-3 p-4 text-[13px] text-muted">
          {s?.available === false ? (
            <p>The operations dashboard needs the database and admin configuration.</p>
          ) : (
            <p>Sign in with an operator wallet. The signature is free and moves no funds.</p>
          )}
          {address ? (
            <Button variant="primary" onClick={signIn}>
              Sign in as {short(address)}
            </Button>
          ) : (
            <p>Connect a wallet first.</p>
          )}
          {authError ? <p className="text-neg">{authError}</p> : null}
        </div>
      </Card>
    );
  }

  const w = s.worker ?? {};
  const matches = Object.entries((w.matches ?? {}) as Record<string, { status: string }>);
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">Operations</h1>
        <span className="text-[12px] text-muted">signed in as {short(s.admin)}</span>
      </div>
      {(s.alerts ?? []).length || w.safeState ? (
        <Card className="border-warn/40">
          <CardHeader title="Alerts" />
          <ul className="divide-y divide-line text-[13px]">
            {w.safeState ? <li className="px-4 py-2.5 text-warn">{w.safeState}</li> : null}
            {(s.alerts ?? []).map((a: any) => (
              <li key={a.id} className="flex gap-3 px-4 py-2.5">
                <Badge tone={a.level === "critical" ? "neg" : "warn"}>{a.level}</Badge>
                <span className="flex-1">{a.message}</span>
                <span className="text-muted">{new Date(a.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card className="grid grid-cols-2 gap-5 p-4 md:grid-cols-5">
        <Stat
          label="Scheduler"
          value={w.ok ? "Healthy" : w.error ? "Unreachable" : "Degraded"}
          sub={w.leader ? "leader" : "no leader"}
        />
        <Stat
          label="Chain time"
          value={w.chainTime ? new Date(w.chainTime * 1000).toLocaleTimeString() : "–"}
          sub={`indexed to ${s.cursor?.block ?? "–"}`}
        />
        {exchangeMode ? (
          <Stat
            label="Held for players"
            value={totals.data ? fmtAsset(totals.data.USDG.escrowed, "USDG") : "–"}
            sub={
              totals.data ? `${fmtAsset(totals.data.ETH.escrowed, "ETH")} · ${totals.data.positions} matched bets` : ""
            }
          />
        ) : (
          <Stat
            label="Treasury free"
            value={treasury.data ? `${fmtUsdg(treasury.data.USDG.freeBalance, 0)} USDG` : "–"}
            sub={
              treasury.data
                ? `${fmtAsset(treasury.data.ETH.freeBalance, "ETH")} free · reserved ${fmtUsdg(treasury.data.USDG.totalReserved, 0)} USDG / ${fmtAsset(treasury.data.ETH.totalReserved, "ETH")}`
                : ""
            }
          />
        )}
        <Stat label="Settlement queue" value={String(s.pendingPayouts ?? 0)} sub="winning or refund bets unpaid" />
        <Stat label="Failed jobs" value={String((s.failedJobs ?? []).length)} sub="retried automatically" />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Match engine" />
          {matches.length === 0 ? (
            <Empty>No worker data.</Empty>
          ) : (
            <ul className="divide-y divide-line text-[13px]">
              {matches.map(([id, m]) => (
                <li key={id} className="flex justify-between px-4 py-2.5">
                  <span className="num">#{id}</span>
                  <Badge>{m.status}</Badge>
                </li>
              ))}
              <li className="px-4 py-2.5 text-muted">Pricing in progress: {(w.pricing ?? []).join(", ") || "none"}</li>
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Emergency controls" />
          <div className="space-y-3 p-4 text-[13px] text-muted">
            <p>
              Betting is{" "}
              <span className={paused.data ? "text-warn" : "text-pos"}>{paused.data ? "paused" : "open"}</span>. Pausing
              stops new bets only: claims, payouts, settlement and refunds keep working. No control here can change a
              committed match, an accepted price, or reserved funds.
            </p>
            <Button variant={paused.data ? "primary" : "danger"} onClick={togglePause}>
              {paused.data ? "Resume betting" : "Pause betting"}
            </Button>
            {msg ? <p>{msg}</p> : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent jobs" />
          <ul className="max-h-80 divide-y divide-line overflow-y-auto text-[12px]">
            {(s.recentJobs ?? []).map((j: any) => (
              <li key={j.id} className="flex items-center gap-3 px-4 py-2">
                <span className="num w-20 text-muted">#{j.matchId}</span>
                <span className="w-24">{j.step}</span>
                <Badge tone={j.status === "DONE" ? "pos" : j.status === "FAILED" ? "neg" : "muted"}>{j.status}</Badge>
                <span className="flex-1 truncate text-muted" title={j.lastError ?? ""}>
                  {j.lastError ?? `attempts ${j.attempts}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Contract events" />
          <ul className="max-h-80 divide-y divide-line overflow-y-auto text-[12px]">
            {(s.events ?? []).map((e: any) => (
              <li key={`${e.txHash}-${e.logIndex}`} className="flex items-center gap-3 px-4 py-2">
                <span className="w-20 text-muted">{e.contract}</span>
                <span className="flex-1">{e.name}</span>
                <span className="num text-muted">{e.blockNumber}</span>
                <ExtLink href={txUrl(e.txHash)}>tx</ExtLink>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
