"use client";

import Link from "next/link";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount, useBalance, usePublicClient, useWriteContract } from "wagmi";
import { oddraBookAbi } from "@oddra/shared";
import { explain } from "@/components/live/BetSlip";
import { Badge, Button, Card, CardHeader, Empty, ExtLink, Stat } from "@/components/ui/primitives";
import { addressUrl, chain, deployment } from "@/lib/config";
import { useChainNow, useMyBets, useUsdg } from "@/lib/hooks";
import { fmtUsdg, parseUsdg, short } from "@/lib/utils";

const DURATIONS = [
  { label: "24 hours", s: 86_400 },
  { label: "7 days", s: 7 * 86_400 },
  { label: "30 days", s: 30 * 86_400 },
  { label: "6 months", s: 182 * 86_400 },
];

export default function ProfilePage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const now = useChainNow(1000);
  const usdg = useUsdg(address);
  const eth = useBalance({ address });
  const bets = useMyBets(address);
  const client = usePublicClient();
  const qc = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const [limit, setLimit] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const rg = useQuery({
    queryKey: ["rg", address],
    enabled: !!address && !!client,
    refetchInterval: 15_000,
    queryFn: async () => {
      const read = (functionName: "excludedUntil" | "dailyLimit" | "pendingDailyLimit" | "pendingDailyLimitAt") =>
        client!.readContract({
          address: deployment.book,
          abi: oddraBookAbi,
          functionName,
          args: [address!],
        }) as Promise<bigint>;
      const [excludedUntil, dailyLimit, pendingLimit, pendingAt] = await Promise.all([
        read("excludedUntil"),
        read("dailyLimit"),
        read("pendingDailyLimit"),
        read("pendingDailyLimitAt"),
      ]);
      return { excludedUntil: Number(excludedUntil), dailyLimit, pendingLimit, pendingAt: Number(pendingAt) };
    },
  });

  async function send(fn: () => Promise<`0x${string}`>, done: string) {
    setMsg(null);
    try {
      await client!.waitForTransactionReceipt({ hash: await fn() });
      setMsg(done);
      await qc.invalidateQueries({ queryKey: ["rg"] });
    } catch (e) {
      setMsg(explain(e));
    }
  }

  if (!isConnected || !address)
    return (
      <Card>
        <Empty>
          <p className="mb-4">Connect a wallet to see your profile.</p>
          <Button variant="primary" onClick={openConnectModal}>
            Connect wallet
          </Button>
        </Empty>
      </Card>
    );

  const rows = bets.data ?? [];
  const excluded = rg.data && now !== null && rg.data.excludedUntil > now;

  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">Profile</h1>
      <Card className="grid grid-cols-2 gap-5 p-4 md:grid-cols-4">
        <Stat label="Wallet" value={short(address)} sub={<ExtLink href={addressUrl(address)}>explorer</ExtLink>} />
        <Stat
          label="USDG balance"
          value={usdg.data ? fmtUsdg(usdg.data.balance) : "–"}
          sub={deployment.testToken ? "test token, no value" : "USDG"}
        />
        <Stat
          label={`${chain.nativeCurrency.symbol} for gas`}
          value={eth.data ? Number(eth.data.formatted).toFixed(5) : "–"}
          sub={chain.name}
        />
        <Stat
          label="Bets"
          value={String(rows.length)}
          sub={
            <Link href="/bets" className="underline">
              history and claims
            </Link>
          }
        />
      </Card>

      <Card id="responsible">
        <CardHeader title="Responsible play" right={<Badge tone="muted">enforced by the contract</Badge>} />
        <div className="grid gap-6 p-4 md:grid-cols-2">
          <div className="space-y-3">
            <div className="label">Self-exclusion</div>
            {excluded ? (
              <p className="text-[13px] text-warn">
                You are excluded from betting until {new Date(rg.data!.excludedUntil * 1000).toLocaleString()}. This
                cannot be shortened.
              </p>
            ) : (
              <p className="text-[13px] text-muted">
                Block this wallet from placing bets. You can extend an exclusion but never shorten it.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {DURATIONS.map((d) => (
                <Button
                  key={d.s}
                  size="sm"
                  onClick={() => {
                    if (!confirm(`Exclude this wallet from betting for ${d.label}? This cannot be undone.`)) return;
                    void send(
                      () =>
                        writeContractAsync({
                          address: deployment.book,
                          abi: oddraBookAbi,
                          functionName: "selfExclude",
                          args: [BigInt(d.s)],
                        }),
                      `Excluded for ${d.label}.`,
                    );
                  }}
                >
                  {d.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div className="label">Daily stake limit</div>
            <p className="text-[13px] text-muted">
              Current:{" "}
              <span className="num text-fg">
                {rg.data ? (rg.data.dailyLimit === 0n ? "none" : `${fmtUsdg(rg.data.dailyLimit)} USDG`) : "–"}
              </span>
              {rg.data && rg.data.pendingAt > 0 ? (
                <>
                  {" "}
                  · changing to {rg.data.pendingLimit === 0n ? "none" : `${fmtUsdg(rg.data.pendingLimit)} USDG`} on{" "}
                  {new Date(rg.data.pendingAt * 1000).toLocaleString()}
                </>
              ) : null}
            </p>
            <p className="text-[12px] text-muted">Lowering applies immediately. Raising or removing waits 24 hours.</p>
            <div className="flex gap-2">
              <input
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder="USDG per day (0 = none)"
                inputMode="decimal"
                className="num h-8 flex-1 rounded-md border border-line bg-bg px-3 text-[13px] outline-none focus:border-accent/60"
              />
              <Button
                size="sm"
                disabled={parseUsdg(limit) === null}
                onClick={() =>
                  void send(
                    () =>
                      writeContractAsync({
                        address: deployment.book,
                        abi: oddraBookAbi,
                        functionName: "setDailyLimit",
                        args: [parseUsdg(limit)!],
                      }),
                    "Limit updated.",
                  )
                }
              >
                Set limit
              </Button>
            </div>
          </div>
        </div>
        {msg ? <p className="border-t border-line px-4 py-3 text-[13px] text-muted">{msg}</p> : null}
        <p className="border-t border-line px-4 py-3 text-[12px] text-muted">
          Need help? <ExtLink href="https://www.begambleaware.org">BeGambleAware</ExtLink> ·{" "}
          <ExtLink href="https://www.ncpgambling.org">NCPG (US)</ExtLink>. Age and jurisdiction checks, KYC and deposit
          limits for real money are integration points documented in docs/COMPLIANCE.md; real-money play is disabled.
        </p>
      </Card>

      <Card>
        <CardHeader title="Account" />
        <dl className="grid gap-y-2 p-4 text-[13px] sm:grid-cols-[200px_1fr]">
          <dt className="text-muted">Network</dt>
          <dd>
            {chain.name} ({chain.id})
          </dd>
          <dt className="text-muted">Betting asset</dt>
          <dd>
            <ExtLink href={addressUrl(deployment.usdg)}>{short(deployment.usdg)}</ExtLink>{" "}
            {deployment.testToken ? "· Oddra test USDG (no value)" : "· USDG"}
          </dd>
          <dt className="text-muted">Allowance to the book</dt>
          <dd className="num">{usdg.data ? fmtUsdg(usdg.data.allowance) : "–"} USDG</dd>
          <dt className="text-muted">Age confirmation</dt>
          <dd>Self-declared on this device</dd>
        </dl>
      </Card>
    </div>
  );
}
