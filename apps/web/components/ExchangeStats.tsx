"use client";

import { Badge, Card, ExtLink, Stat } from "@/components/ui/primitives";
import { addressUrl, deployment, usdgSymbol } from "@/lib/config";
import { useExchangeTotals } from "@/lib/exchange";
import { fmtAsset, short } from "@/lib/utils";

const ROWS = [
  { key: "matched", label: "Matched volume", sub: "backers' stakes matched with a layer" },
  { key: "escrowed", label: "Held for players", sub: "open positions and unmatched offers" },
  { key: "fees", label: "Commission collected", sub: "on net winnings, not yet withdrawn" },
] as const;

/** Exchange-wide totals: there is no house treasury, every bet is backed by another player's funds. */
export function ExchangeStats() {
  const t = useExchangeTotals();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold">Exchange</h1>
        <span className="text-[12px] text-muted">
          Live from <ExtLink href={addressUrl(deployment.exchange!)}>{short(deployment.exchange)}</ExtLink>
        </span>
      </div>
      <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label="Offers posted" value={t.data ? t.data.offers.toString() : "–"} />
        <Stat label="Bets matched" value={t.data ? t.data.positions.toString() : "–"} />
        <Stat label="Commission" value={t.data ? `${t.data.commissionBps / 100}%` : "–"} sub="of net winnings" />
        <Stat
          label="Status"
          value={t.data ? t.data.paused ? <Badge tone="warn">Paused</Badge> : <Badge tone="pos">Open</Badge> : "–"}
        />
      </Card>
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
                  <td key={a} className="num px-4 py-3 text-right">
                    {t.data ? fmtAsset(t.data[a][r.key], a, false) : "–"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="space-y-2 p-4 text-[13px] text-muted">
        <p className="text-fg">How the exchange works</p>
        <p>
          Oddra holds no house money. A backer bets that something happens; a layer bets that it does not and puts up
          the backer&apos;s winnings. Both sides&apos; funds are locked in the contract until the result is final.
        </p>
        <p>
          The guide odds come from simulating each fixture before betting opens. They are only a starting point: every
          price on the board is one another player has offered.
        </p>
        <p>
          Unmatched offers are returned at kickoff. A voided match refunds both sides. The commission is charged only on
          the winner&apos;s net winnings and can never touch players&apos; funds held in the contract.
        </p>
      </Card>
    </div>
  );
}
