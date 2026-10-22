"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useAccount } from "wagmi";
import type { MatchConfig } from "@oddra/engine";
import { SELECTIONS, ST, formatClock, formatOdds, hasResult, isRevealed } from "@oddra/shared";
import { BetSlip } from "@/components/live/BetSlip";
import { ExchangeTicket } from "@/components/live/ExchangeTicket";
import { Markets } from "@/components/live/Markets";
import { Crest } from "@/components/live/Scoreboard";
import { Badge, Card } from "@/components/ui/primitives";
import { exchangeMode } from "@/lib/config";
import { bestPrices, useMyExchange, useOrderBook } from "@/lib/exchange";
import { useMyBets, type MatchView } from "@/lib/hooks";
import { useSlip } from "@/lib/slip";
import { fmtAsset } from "@/lib/utils";

const TONE = { Open: "muted", Won: "pos", Lost: "neg", Refund: "warn", Paid: "accent" } as const;

export function BettingRail({
  match,
  cfg,
  betting,
  closesIn,
  phaseNote,
}: {
  match: MatchView;
  cfg: MatchConfig;
  betting: boolean;
  closesIn: number | null;
  phaseNote: string;
}) {
  const pick = useSlip((s) => s.pick);
  const asset = useSlip((s) => s.asset);
  const { address } = useAccount();
  const bets = useMyBets(address);
  const xbets = useMyExchange(address);
  const orderBook = useOrderBook(exchangeMode ? match.id : null);
  const prices = exchangeMode ? bestPrices(orderBook.data ?? [], asset, SELECTIONS.length) : undefined;
  const mine = exchangeMode
    ? (xbets.data?.positions ?? [])
        .filter((p) => p.matchId === match.id)
        .map((p) => ({
          id: p.id,
          selection: p.selection,
          text: `${p.side === "back" ? "Back" : "Lay"} ${fmtAsset(p.stake, p.asset)} @ ${formatOdds(p.odds)}`,
          status: (p.status === "Void"
            ? "Refund"
            : p.paid && p.status === "Won"
              ? "Paid"
              : p.status) as keyof typeof TONE,
        }))
    : (bets.data ?? [])
        .filter((b) => b.matchId === match.id)
        .map((b) => ({
          id: b.id,
          selection: b.selection,
          text: `${fmtAsset(b.stake, b.asset)} @ ${formatOdds(b.odds)}`,
          status: (b.status === "Paid" && !b.won ? "Refund" : b.status) as keyof typeof TONE,
        }));
  const myOffers = (xbets.data?.offers ?? []).filter((o) => o.matchId === match.id && !o.closed && o.remaining > 0n);
  const urgent = closesIn !== null && closesIn < 30;
  return (
    <div className="space-y-3">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-[13px] font-medium">{betting ? "Place a bet" : "Betting closed"}</div>
            <div className="text-[11px] text-muted">
              {cfg.home.short} v {cfg.away.short} ·{" "}
              {exchangeMode ? "back or lay against other players, USDG or ETH" : "single bets in USDG or ETH"}
            </div>
          </div>
          {betting && closesIn !== null ? (
            <div
              className={`num rounded-md px-2 py-1 text-[13px] font-semibold ${urgent ? "bg-neg/15 text-neg" : "bg-accent/10 text-accent"}`}
            >
              {formatClock(closesIn)}
            </div>
          ) : (
            <Badge>{phaseNote}</Badge>
          )}
        </div>
        <AnimatePresence initial={false}>
          {betting && pick && pick.matchId === match.id ? (
            <motion.div
              key="slip"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden border-b border-line"
            >
              <div className="[&>div]:rounded-none [&>div]:border-0">
                {exchangeMode ? (
                  <ExchangeTicket
                    open={betting}
                    referenceOdds={match.odds}
                    homeName={cfg.home.name}
                    awayName={cfg.away.name}
                  />
                ) : (
                  <BetSlip open={betting} currentOdds={match.odds} homeName={cfg.home.name} awayName={cfg.away.name} />
                )}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {betting && !pick ? (
          <div className="border-b border-line bg-accent/[0.04] px-4 py-2.5 text-[12px] text-muted">
            {exchangeMode
              ? "Back to bet for an outcome, Lay to bet against it. Grey prices are a guide: nobody has offered them yet."
              : "Tap a price to build your bet slip."}
          </div>
        ) : null}
        {!betting ? (
          <div className="border-b border-line px-4 py-2.5 text-[12px] text-muted">
            {exchangeMode
              ? "Matched bets are locked in; unmatched offers were returned at kickoff. Betting reopens for the next match when this one ends."
              : "Prices below are the ones that applied. Betting reopens for the next match when this one ends."}
          </div>
        ) : null}
        <Markets
          matchId={match.id}
          odds={match.odds}
          open={betting}
          winMask={match.book.settled ? match.book.winMask : null}
          homeShort={cfg.home.short}
          awayShort={cfg.away.short}
          prices={prices}
        />
      </Card>
      {mine.length > 0 || myOffers.length > 0 ? (
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-[13px] font-medium">Your bets on this match</span>
            <Link href="/bets" className="text-[12px] text-muted hover:text-fg">
              My Bets →
            </Link>
          </div>
          <ul className="divide-y divide-line">
            {mine.map((b) => (
              <li key={b.id.toString()} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                <span className="flex-1 truncate">{selName(b.selection, cfg)}</span>
                <span className="num text-muted">{b.text}</span>
                <Badge tone={TONE[b.status]}>{b.status === "Refund" ? "Refunded" : b.status}</Badge>
              </li>
            ))}
            {myOffers.map((o) => (
              <li key={`o${o.id}`} className="flex items-center gap-3 px-4 py-2 text-[12px]">
                <span className="flex-1 truncate">{selName(o.selection, cfg)}</span>
                <span className="num text-muted">
                  {o.side === "back" ? "Back" : "Lay"} {fmtAsset(o.remaining, o.asset)} @ {formatOdds(o.odds)}
                </span>
                <Badge tone="warn">Unmatched</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

const selName = (id: number, cfg: MatchConfig) =>
  SELECTIONS[id].label === "Home"
    ? cfg.home.short
    : SELECTIONS[id].label === "Away"
      ? cfg.away.short
      : SELECTIONS[id].label;

export function NextUp({ cfg, openTime, now }: { cfg: MatchConfig; openTime: number; now: number }) {
  return (
    <Card className="p-4">
      <div className="label mb-3">Next match</div>
      <div className="flex items-center gap-3">
        <Crest team={cfg.home} size={30} />
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="truncate font-medium">{cfg.home.name}</div>
          <div className="truncate font-medium">{cfg.away.name}</div>
        </div>
        <Crest team={cfg.away} size={30} />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[12px] text-muted">
        <span>Betting opens in</span>
        <span className="num text-[14px] font-semibold text-fg">{formatClock(Math.max(0, openTime - now))}</span>
      </div>
    </Card>
  );
}

/** Where this match stands in the commit → entropy → reveal → settle sequence, with a link to the full check. */
export function ProofCard({ match }: { match: MatchView }) {
  const m = match.m;
  const steps = [
    { label: "Seed committed before betting", done: m.status >= 1 },
    { label: `Entropy block ${m.entropyBlock > 0n ? `#${m.entropyBlock}` : "chosen at kickoff"}`, done: m.status >= 2 },
    { label: "Seed revealed, final seed fixed", done: isRevealed(m.status) },
    { label: "Result proposed, open to disputes", done: hasResult(m.status) },
    {
      label: m.status === ST.Disputed ? "Disputed: awaiting the arbiter" : "Result final on-chain",
      done: m.status === ST.Settled,
    },
  ];
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="label">Provably fair</span>
        <Link href={`/matches/${match.id}`} className="text-[12px] text-muted hover:text-fg">
          Verify →
        </Link>
      </div>
      <ol className="space-y-2">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-2.5 text-[12px]">
            <span
              className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${s.done ? "bg-accent text-black" : "border border-line text-muted"}`}
            >
              {s.done ? "✓" : ""}
            </span>
            <span className={s.done ? "text-fg" : "text-muted"}>{s.label}</span>
          </li>
        ))}
      </ol>
      <div
        className="mt-3 truncate border-t border-line pt-3 font-[family-name:var(--font-mono)] text-[10px] text-muted"
        title={m.seedCommit}
      >
        commit {m.seedCommit}
      </div>
    </Card>
  );
}
