import { describe, expect, it } from "vitest";
import { bestPrices, liabilityFor, planOrder, type OfferRow } from "./exchange";

const ME = "0x00000000000000000000000000000000000000aa" as const;
const OTHER = "0x00000000000000000000000000000000000000bb" as const;
const U = 1_000_000n;
let next = 0n;
const offer = (p: Partial<OfferRow>): OfferRow => ({
  id: next++,
  maker: OTHER,
  matchId: 1n,
  selection: 0,
  side: "lay",
  odds: 250,
  closed: false,
  asset: "USDG",
  amount: 10n * U,
  remaining: 10n * U,
  escrow: 0n,
  ...p,
});
const base = { me: ME, selection: 0, asset: "USDG" as const, minAmount: U, postRemainder: true };

describe("exchange order planning", () => {
  it("rounds liability up like the contract", () => {
    expect(liabilityFor(1n, 250)).toBe(2n);
    expect(liabilityFor(10n * U, 250)).toBe(15n * U);
  });

  it("backs into the best lay offers first and posts the rest at the asked odds", () => {
    const offers = [offer({ odds: 240 }), offer({ odds: 260, remaining: 4n * U }), offer({ odds: 230 })];
    const p = planOrder({ ...base, offers, side: "back", odds: 240, stake: 20n * U });
    expect(p.fills.map((f) => [f.offer.odds, f.amount])).toEqual([
      [260, 4n * U],
      [240, 10n * U],
    ]);
    expect(p.matched).toBe(14n * U);
    expect(p.remainder).toBe(6n * U);
    expect(p.total).toBe(20n * U); // backing pays the stake, matched or not
    expect(p.winGross).toBe((4n * U * 160n) / 100n + 10n * U * 140n / 100n + (6n * U * 140n) / 100n);
  });

  it("lays into the lowest back offers and pays liability at each offer's odds", () => {
    const offers = [offer({ side: "back", odds: 300 }), offer({ side: "back", odds: 280, remaining: 5n * U })];
    const p = planOrder({ ...base, offers, side: "lay", odds: 300, stake: 8n * U, postRemainder: false });
    expect(p.fills.map((f) => [f.offer.odds, f.amount, f.cost])).toEqual([
      [280, 5n * U, 9n * U],
      [300, 3n * U, 6n * U],
    ]);
    expect(p.remainder).toBe(0n);
    expect(p.winGross).toBe(8n * U);
  });

  it("never takes its own offers, the wrong side, or worse odds", () => {
    const offers = [
      offer({ maker: ME }),
      offer({ side: "back" }),
      offer({ odds: 200 }),
      offer({ asset: "ETH" }),
      offer({ selection: 3 }),
    ];
    const p = planOrder({ ...base, offers, side: "back", odds: 250, stake: 5n * U });
    expect(p.fills).toEqual([]);
    expect(p.remainder).toBe(5n * U);
  });

  it("skips dust partial fills and flags a remainder below the minimum", () => {
    const offers = [offer({ remaining: 10n * U })];
    const p = planOrder({ ...base, offers, side: "back", odds: 250, stake: U / 2n });
    expect(p.fills).toEqual([]);
    expect(p.dust).toBe(U / 2n);
    expect(p.remainder).toBe(0n);
    // a dust amount that exactly finishes an offer is allowed
    const q = planOrder({ ...base, offers: [offer({ remaining: U / 2n })], side: "back", odds: 250, stake: U / 2n });
    expect(q.matched).toBe(U / 2n);
  });

  it("aggregates best prices per side", () => {
    const b = bestPrices(
      [offer({ odds: 240 }), offer({ odds: 240, remaining: 3n * U }), offer({ side: "back", odds: 260 })],
      "USDG",
      30,
    );
    expect(b[0].back).toEqual({ odds: 240, available: 13n * U });
    expect(b[0].lay).toEqual({ odds: 260, available: 10n * U });
    expect(b[1]).toEqual({ back: null, lay: null });
  });
});
