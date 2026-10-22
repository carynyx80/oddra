"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "./Logo";
import { AgeGate } from "./AgeGate";
import { LiveTicker } from "./LiveTicker";
import { chain, deployed, isMainnet } from "@/lib/config";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Live" },
  { href: "/matches", label: "Matches" },
  { href: "/bets", label: "My Bets" },
  { href: "/treasury", label: "Treasury" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/token", label: "$ODRA" },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="min-h-dvh">
      <div className="border-b border-line bg-bg-2 px-4 py-1.5 text-center text-[11px] text-muted">
        {isMainnet
          ? `${chain.name} · real funds · bets in USDG or ETH · 18+ · play responsibly`
          : `${chain.name} · test tokens only, no real money`}
      </div>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-6 px-4">
          <Link href="/" aria-label="Oddra home">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-1 lg:flex">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[13px] transition-colors",
                  (n.href === "/" ? path === "/" : path.startsWith(n.href))
                    ? "bg-raised text-fg"
                    : "text-muted hover:text-fg",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LiveTicker />
            <Link href="/profile" className="hidden text-[13px] text-muted hover:text-fg sm:block">
              Profile
            </Link>
            <ConnectButton chainStatus="icon" accountStatus="address" showBalance={false} />
            <button
              className="rounded-md border border-line px-2.5 py-1.5 text-[13px] lg:hidden"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label="Menu"
            >
              Menu
            </button>
          </div>
        </div>
        {open ? (
          <nav className="grid gap-1 border-t border-line px-4 py-3 lg:hidden">
            {[...NAV, { href: "/profile", label: "Profile" }].map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded-md px-3 py-2 text-[14px] text-muted hover:bg-raised hover:text-fg"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>
      {!deployed ? (
        <div className="border-b border-warn/30 bg-warn/5 px-4 py-2 text-center text-[12px] text-warn">
          Contracts are not configured for this deployment. Matches, betting and the treasury are unavailable until they
          are.
        </div>
      ) : null}
      <main className="mx-auto max-w-[1440px] px-4 py-5">{children}</main>
      <footer className="mx-auto max-w-[1440px] px-4 pb-10 pt-6 text-[12px] text-muted">
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <span>Oddra · Every Match. Every Moment. Onchain.</span>
          <span className="flex gap-4">
            <Link href="/admin" className="hover:text-fg">
              Operations
            </Link>
            <Link href="/profile#responsible" className="hover:text-fg">
              Responsible play
            </Link>
            <a href="https://github.com/carynyx80/oddra" target="_blank" rel="noreferrer" className="hover:text-fg">
              Source
            </a>
          </span>
        </div>
      </footer>
      <AgeGate />
    </div>
  );
}
