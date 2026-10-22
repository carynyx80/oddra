"use client";

import { useEffect, useState } from "react";
import { isMainnet } from "@/lib/config";
import { Button } from "./ui/primitives";

const KEY = "oddra.age-confirmed.v1";

/** Shown once per browser. A self-declaration only; the KYC/age-verification hook for real money is in docs/COMPLIANCE.md. */
export function AgeGate() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(localStorage.getItem(KEY) !== "yes");
    } catch {
      setShow(true);
    }
  }, []);
  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-title"
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-card p-5">
        <h2 id="age-title" className="font-[family-name:var(--font-display)] text-[18px] font-semibold">
          Before you continue
        </h2>
        <ul className="mt-3 space-y-2 text-[13px] text-muted">
          {isMainnet ? (
            <>
              <li>Oddra uses real funds: bets are placed and paid in USDG or ETH on Robinhood Chain.</li>
              <li>Only bet what you can afford to lose. Self-exclusion and daily limits are on your Profile page.</li>
            </>
          ) : (
            <li>Oddra runs on a test network. Test USDG has no value and cannot be bought or sold.</li>
          )}
          <li>You must be of legal age to gamble where you live, and online gambling must be legal there.</li>
        </ul>
        <div className="mt-5 flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => {
              try {
                localStorage.setItem(KEY, "yes");
              } catch {}
              setShow(false);
            }}
          >
            I am 18+ and understand
          </Button>
          <a
            href="https://www.begambleaware.org"
            className="inline-flex h-10 items-center rounded-md border border-line px-4 text-[13px] text-muted hover:text-fg"
          >
            Leave
          </a>
        </div>
      </div>
    </div>
  );
}
