import { zeroHash, type Hex } from "viem";
import { db, hasDatabase, type MatchStatus } from "@oddra/db";
import {
  ENGINE_VERSION,
  buildConfig,
  canonicalJson,
  configHash,
  eventLogHash,
  firstScorerCode,
  keccakHex,
  resultHash,
  simulate,
  type MatchResult,
} from "@oddra/engine";
import {
  ETH_ADDRESS,
  MATCH_STATUS,
  SELECTIONS,
  ST,
  fixtureFor,
  hasResult,
  isRevealed,
  oddraBookAbi,
  oddraMatchRegistryAbi,
  oddraTreasuryAbi,
  skewForExposure,
  slot,
  slotAt,
  winMask,
} from "@oddra/shared";
import type { Chain } from "./chain";
import type { Env } from "./env";
import { errMsg, log } from "./log";
import { priceFixture } from "./pricing";
import { seedCommit, serverSeed } from "./seeds";

export const STATUS = MATCH_STATUS;
const DB_STATUS: MatchStatus[] = [
  "NONE",
  "SCHEDULED",
  "LOCKED",
  "REVEALED",
  "PROPOSED",
  "DISPUTED",
  "SETTLED",
  "VOIDED",
];

const REVEAL_WINDOW = 600;
const SETTLE_WINDOW = 6 * 3600;
const ARBITRATION_WINDOW = 24 * 3600;
const LIVE = 900;
const ENTROPY_HORIZON = 240; // L2 blocks a hash stays readable (256) minus margin
const SKEW_EVERY = 45;

export interface OnchainMatch {
  openTime: bigint;
  kickoff: bigint;
  homeTeam: number;
  awayTeam: number;
  status: number;
  homeGoals: number;
  awayGoals: number;
  firstScorer: number;
  entropyBlock: bigint;
  configHash: Hex;
  rulesetHash: Hex;
  seedCommit: Hex;
  entropy: Hex;
  serverSeed: Hex;
  finalSeed: Hex;
  resultHash: Hex;
  proposedAt: bigint;
}

export interface SchedulerStatus {
  chainTime: number;
  lastTickAt: number;
  currentMatchId: string;
  safeState: string | null;
  matches: Record<string, { status: string; home: number; away: number }>;
  errors: { at: number; matchId: string; step: string; error: string }[];
  pricing: string[];
}

export const rulesetHash = () => keccakHex(ENGINE_VERSION);

export class Scheduler {
  readonly sims = new Map<string, MatchResult>();
  readonly onchain = new Map<string, OnchainMatch>();
  private readonly pricing = new Map<string, Promise<void>>();
  private readonly baseOdds = new Map<string, number[]>();
  private readonly lastSkew = new Map<string, number>();
  private readonly inflight = new Set<string>();
  readonly status: SchedulerStatus = {
    chainTime: 0,
    lastTickAt: 0,
    currentMatchId: "0",
    safeState: null,
    matches: {},
    errors: [],
    pricing: [],
  };

  constructor(
    private readonly env: Env,
    private readonly chain: Chain,
  ) {}

  /** Resolves when every in-flight pricing run has finished (tests and graceful shutdown). */
  async idle() {
    await Promise.all(this.pricing.values());
  }

  private blockSource: Hex | null = null;

  /** The L2 block number as the registry sees it (ArbSys on Robinhood Chain), so reveal timing matches the contract. */
  async blockHead(): Promise<bigint> {
    this.blockSource ??= (await this.chain.pub.readContract({
      address: this.d.registry,
      abi: oddraMatchRegistryAbi,
      functionName: "blocks",
    })) as Hex;
    return (await this.chain.pub.readContract({
      address: this.blockSource,
      abi: [
        {
          type: "function",
          name: "arbBlockNumber",
          inputs: [],
          outputs: [{ type: "uint256" }],
          stateMutability: "view",
        },
      ] as const,
      functionName: "arbBlockNumber",
    })) as bigint;
  }

  private windowCache: { at: number; value: number } | null = null;

  /** The registry's dispute window in seconds (cached for a minute). */
  async disputeWindow(): Promise<number> {
    if (!this.windowCache || Date.now() - this.windowCache.at > 60_000) {
      const v = (await this.chain.pub.readContract({
        address: this.d.registry,
        abi: oddraMatchRegistryAbi,
        functionName: "disputeWindow",
      })) as bigint;
      this.windowCache = { at: Date.now(), value: Number(v) };
    }
    return this.windowCache.value;
  }

  private get d() {
    return this.env.deployment;
  }

  async readMatch(id: bigint): Promise<OnchainMatch> {
    const m = (await this.chain.pub.readContract({
      address: this.d.registry,
      abi: oddraMatchRegistryAbi,
      functionName: "getMatch",
      args: [id],
    })) as unknown as OnchainMatch;
    this.onchain.set(id.toString(), m);
    return m;
  }

  /** One pass over the matches around now. Every step is idempotent and decided from on-chain state. */
  async tick(leader: boolean) {
    const now = await this.chain.refreshTime();
    const cur = slotAt(now).matchId;
    this.status.chainTime = now;
    this.status.currentMatchId = cur.toString();
    for (const id of [cur - 2n, cur - 1n, cur, cur + 1n]) {
      try {
        const m = await this.readMatch(id);
        this.status.matches[id.toString()] = { status: STATUS[m.status], home: m.homeTeam, away: m.awayTeam };
        if (isRevealed(m.status)) this.ensureSimulated(id, m);
        if (leader) await this.step(id, m, now, cur);
        if (hasDatabase() && m.status > 0) await this.syncRow(id, m);
      } catch (e) {
        this.recordError(id, "tick", e);
      }
    }
    for (const k of Object.keys(this.status.matches)) if (BigInt(k) < cur - 3n) delete this.status.matches[k];
    for (const k of this.sims.keys()) if (BigInt(k) < cur - 3n) this.sims.delete(k);
    this.status.lastTickAt = now;
    this.status.pricing = [...this.pricing.keys()];
  }

  private async step(id: bigint, m: OnchainMatch, now: number, cur: bigint) {
    const s = slot(id);
    const key = id.toString();
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    try {
      switch (m.status) {
        case 0: {
          if (id === cur + 1n && now < s.openTime - 10) {
            const gate = await this.safetyGate(id, now);
            this.status.safeState = gate;
            if (gate === null) await this.create(id);
          }
          break;
        }
        case 1: {
          if (now < s.kickoff) await this.ensureOdds(id, now, s.kickoff);
          else {
            if (now > s.kickoff + REVEAL_WINDOW) await this.void(id);
            else
              await this.job(id, "lock", () =>
                this.chain.send({
                  purpose: "lock",
                  matchId: id,
                  address: this.d.registry,
                  abi: oddraMatchRegistryAbi,
                  functionName: "lock",
                  args: [id],
                }),
              );
          }
          break;
        }
        case 2: {
          const head = await this.blockHead();
          if (now > s.kickoff + REVEAL_WINDOW) await this.void(id);
          else if (head > m.entropyBlock && head <= m.entropyBlock + BigInt(ENTROPY_HORIZON)) {
            const seed = serverSeed(this.env.seedSecret, this.env.chainId, this.d.registry, id);
            if (seedCommit(seed) !== m.seedCommit) throw new Error("seed derivation does not match the commitment");
            await this.job(id, "reveal", () =>
              this.chain.send({
                purpose: "reveal",
                matchId: id,
                address: this.d.registry,
                abi: oddraMatchRegistryAbi,
                functionName: "reveal",
                args: [id, seed],
              }),
            );
          } else if (head > m.entropyBlock + BigInt(ENTROPY_HORIZON)) {
            this.status.safeState = `match ${id}: entropy block expired before reveal; it will be voided at ${new Date((s.kickoff + REVEAL_WINDOW) * 1000).toISOString()}`;
          }
          break;
        }
        case ST.Revealed: {
          if (now >= s.fullTime) {
            if (now > s.kickoff + LIVE + SETTLE_WINDOW) {
              await this.void(id);
              break;
            }
            const r = this.ensureSimulated(id, m);
            if (!r) break;
            await this.job(id, "propose", () =>
              this.chain.send({
                purpose: "proposeResult",
                matchId: id,
                address: this.d.registry,
                abi: oddraMatchRegistryAbi,
                functionName: "proposeResult",
                args: [id, r.homeGoals, r.awayGoals, firstScorerCode(r.firstScorer), resultHash(r)],
              }),
            );
          }
          break;
        }
        case ST.Proposed: {
          // watcher duty: never finalise a proposal that disagrees with our own replay
          const r = this.ensureSimulated(id, m);
          if (!r) break;
          const agrees =
            r.homeGoals === m.homeGoals &&
            r.awayGoals === m.awayGoals &&
            firstScorerCode(r.firstScorer) === m.firstScorer &&
            resultHash(r) === m.resultHash;
          if (!agrees) {
            this.recordError(
              id,
              "verify",
              new Error(
                `proposed result ${m.homeGoals}-${m.awayGoals} disagrees with the replay ${r.homeGoals}-${r.awayGoals}; dispute it`,
              ),
              "critical",
            );
            break;
          }
          const window = await this.disputeWindow();
          if (now >= Number(m.proposedAt) + window)
            await this.job(id, "finalize", () =>
              this.chain.send({
                purpose: "finalize",
                matchId: id,
                address: this.d.registry,
                abi: oddraMatchRegistryAbi,
                functionName: "finalize",
                args: [id],
              }),
            );
          break;
        }
        case ST.Disputed: {
          this.status.safeState = `The result of match ${id} is under dispute and awaits the arbiter.`;
          const d = (await this.chain.pub.readContract({
            address: this.d.registry,
            abi: oddraMatchRegistryAbi,
            functionName: "disputes",
            args: [id],
          })) as readonly [string, bigint, bigint];
          if (now > Number(d[2]) + ARBITRATION_WINDOW) await this.void(id);
          break;
        }
        case ST.Settled:
        case ST.Voided:
          await this.closeBookAndPay(id);
          break;
      }
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Returns null when it is safe to open the next match, otherwise the reason it is not (shown to users). */
  private async safetyGate(id: bigint, now: number): Promise<string | null> {
    for (const prev of [id - 1n, id - 2n]) {
      const p = this.onchain.get(prev.toString()) ?? (await this.readMatch(prev));
      const ps = slot(prev);
      if ((p.status === ST.Scheduled || p.status === ST.Locked) && now > ps.kickoff + 120)
        return `Paused: match ${prev} has not been revealed. No new bets until it is resolved.`;
      if (p.status === ST.Disputed) return `Paused: the result of match ${prev} is under dispute.`;
      if (
        (p.status === ST.Revealed || p.status === ST.Proposed) &&
        now > ps.fullTime + (await this.disputeWindow()) + 600
      )
        return `Paused: match ${prev} is awaiting settlement.`;
    }
    const [free, freeEth, paused] = await Promise.all([
      this.chain.pub.readContract({
        address: this.d.treasury,
        abi: oddraTreasuryAbi,
        functionName: "freeBalance",
        args: [this.d.usdg],
      }) as Promise<bigint>,
      this.chain.pub.readContract({
        address: this.d.treasury,
        abi: oddraTreasuryAbi,
        functionName: "freeBalance",
        args: [ETH_ADDRESS],
      }) as Promise<bigint>,
      this.chain.pub.readContract({
        address: this.d.book,
        abi: oddraBookAbi,
        functionName: "paused",
      }) as Promise<boolean>,
    ]);
    if (paused) return "Paused: betting is paused by the operator.";
    if (free < this.env.minFreeLiquidity && freeEth < this.env.minFreeLiquidityEth)
      return "Paused: treasury liquidity is below the minimum to open a market.";
    return null;
  }

  private async create(id: bigint) {
    const s = slot(id);
    const { home, away } = fixtureFor(id);
    const cfg = buildConfig(id, home, away);
    const seed = serverSeed(this.env.seedSecret, this.env.chainId, this.d.registry, id);
    const hash = await this.job(id, "create", () =>
      this.chain.send({
        purpose: "createMatch",
        matchId: id,
        address: this.d.registry,
        abi: oddraMatchRegistryAbi,
        functionName: "createMatch",
        args: [id, home, away, configHash(cfg), rulesetHash(), seedCommit(seed), BigInt(s.openTime), BigInt(s.kickoff)],
      }),
    );
    if (hasDatabase()) {
      await db().match.upsert({
        where: { id },
        create: {
          id,
          homeTeamId: home,
          awayTeamId: away,
          openTime: new Date(s.openTime * 1000),
          kickoff: new Date(s.kickoff * 1000),
          fullTime: new Date(s.fullTime * 1000),
          engineVersion: ENGINE_VERSION,
          configHash: configHash(cfg),
          rulesetHash: rulesetHash(),
          seedCommit: seedCommit(seed),
          createdTx: hash ?? null,
          config: { create: { json: JSON.parse(canonicalJson(cfg)) } },
        },
        update: { createdTx: hash ?? undefined },
      });
    }
    log.info("match committed", { matchId: id, home, away, openTime: s.openTime });
  }

  private async ensureOdds(id: bigint, now: number, kickoff: number) {
    const key = id.toString();
    const m = this.onchain.get(key)!;
    if (!this.baseOdds.has(key)) {
      if (!this.pricing.has(key)) {
        const history = await this.history(m.homeTeam, m.awayTeam);
        const p = priceFixture(id, m.homeTeam, m.awayTeam, this.env.pricingSamples, history, this.env.margin)
          .then(async (pr) => {
            this.baseOdds.set(key, pr.odds);
            if (hasDatabase()) {
              await db().$transaction(
                SELECTIONS.map((sel) =>
                  db().bettingMarket.upsert({
                    where: { matchId_selection: { matchId: id, selection: sel.id } },
                    create: {
                      matchId: id,
                      selection: sel.id,
                      market: sel.market,
                      label: sel.label,
                      probability: pr.probabilities[sel.id],
                    },
                    update: { probability: pr.probabilities[sel.id] },
                  }),
                ),
              );
            }
            log.info("priced", {
              matchId: id,
              home: pr.odds[0],
              draw: pr.odds[1],
              away: pr.odds[2],
              samples: pr.samples,
            });
          })
          .catch((e) => this.recordError(id, "pricing", e))
          .finally(() => this.pricing.delete(key));
        this.pricing.set(key, p);
      }
      return;
    }
    const [current, version] = (await this.chain.pub.readContract({
      address: this.d.book,
      abi: oddraBookAbi,
      functionName: "odds",
      args: [id],
    })) as readonly [readonly number[], number];
    const base = this.baseOdds.get(key)!;
    let target = base;
    if (version > 0) {
      // exposure skew, at most every SKEW_EVERY seconds and never in the final 15 seconds
      if (now - (this.lastSkew.get(key) ?? 0) < SKEW_EVERY || kickoff - now < 15) return;
      this.lastSkew.set(key, now);
      // one price for both assets: skew by whichever asset book is more exposed on each selection
      target = base;
      for (const asset of [this.d.usdg, ETH_ADDRESS]) {
        const [[selection], free] = await Promise.all([
          this.chain.pub.readContract({
            address: this.d.book,
            abi: oddraBookAbi,
            functionName: "liabilities",
            args: [id, asset],
          }) as Promise<readonly [readonly bigint[], readonly bigint[]]>,
          this.chain.pub.readContract({
            address: this.d.treasury,
            abi: oddraTreasuryAbi,
            functionName: "freeBalance",
            args: [asset],
          }) as Promise<bigint>,
        ]);
        const skewed = skewForExposure(base, selection, free);
        target = target.map((o, i) => Math.min(o, skewed[i]));
      }
      if (target.every((o, i) => o === current[i])) return;
    }
    const reason = version === 0 ? "initial" : "exposure";
    const hash = await this.chain.send({
      purpose: `publishOdds:${reason}`,
      matchId: id,
      address: this.d.book,
      abi: oddraBookAbi,
      functionName: "publishOdds",
      args: [id, target],
    });
    if (hasDatabase())
      await db()
        .oddsSnapshot.create({ data: { matchId: id, version: version + 1, odds: target, reason, txHash: hash } })
        .catch(() => {});
  }

  private async history(home: number, away: number) {
    if (!hasDatabase()) return [];
    const past = await db().match.findMany({
      where: { homeTeamId: home, awayTeamId: away, status: "SETTLED" },
      select: { homeGoals: true, awayGoals: true, firstScorer: true },
      take: 50,
      orderBy: { id: "desc" },
    });
    return past.map((p) => ({ h: p.homeGoals!, a: p.awayGoals!, first: p.firstScorer! }));
  }

  /** Replays a revealed match. Refuses (and alerts) if the rebuilt config does not match the commitment. */
  ensureSimulated(id: bigint, m: OnchainMatch): MatchResult | null {
    const key = id.toString();
    const have = this.sims.get(key);
    if (have) return have;
    if (m.finalSeed === zeroHash) return null;
    const cfg = buildConfig(id, m.homeTeam, m.awayTeam);
    if (configHash(cfg) !== m.configHash) {
      this.recordError(
        id,
        "simulate",
        new Error("rebuilt config does not match the committed hash; refusing to settle"),
      );
      return null;
    }
    const t0 = performance.now();
    const r = simulate(cfg, m.finalSeed);
    this.sims.set(key, r);
    log.info("simulated", {
      matchId: id,
      score: `${r.homeGoals}-${r.awayGoals}`,
      ms: Math.round(performance.now() - t0),
    });
    if (hasDatabase()) void this.storeSimulation(id, r).catch((e) => this.recordError(id, "store", e));
    return r;
  }

  private async storeSimulation(id: bigint, r: MatchResult) {
    const prisma = db();
    const exists = await prisma.matchReplay.findUnique({ where: { matchId: id }, select: { matchId: true } });
    if (exists) return;
    const key = r.events.filter((e) => e.type !== "pass");
    await prisma.$transaction([
      prisma.matchReplay.create({ data: { matchId: id, events: JSON.parse(JSON.stringify(r.events)) } }),
      prisma.matchEvent.createMany({ data: key.map((e) => ({ matchId: id, ...e })), skipDuplicates: true }),
      prisma.matchStat.createMany({
        data: r.stats.map((s, team) => ({ matchId: id, team, ...s })),
        skipDuplicates: true,
      }),
      prisma.match.update({ where: { id }, data: { eventLogHash: eventLogHash(r), verifiedAt: new Date() } }),
    ]);
  }

  private async closeBookAndPay(id: bigint) {
    const states = await Promise.all(
      [this.d.usdg, ETH_ADDRESS].map(
        (asset) =>
          this.chain.pub.readContract({
            address: this.d.book,
            abi: oddraBookAbi,
            functionName: "bookState",
            args: [id, asset],
          }) as Promise<readonly [boolean, boolean, number, bigint, bigint, bigint]>,
      ),
    );
    // settleBook closes both asset books at once; an empty ETH book closes too
    if (states.some(([settled, voided]) => !settled && !voided)) {
      await this.job(id, "settleBook", () =>
        this.chain.send({
          purpose: "settleBook",
          matchId: id,
          address: this.d.book,
          abi: oddraBookAbi,
          functionName: "settleBook",
          args: [id],
        }),
      );
      return;
    }
    if (!hasDatabase()) return;
    const bets = await db().bet.findMany({
      where: { matchId: id, state: { in: ["OPEN", "WON", "REFUND"] } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 400,
    });
    if (bets.length === 0) return;
    const claimable = await Promise.all(
      bets.map(
        (b) =>
          this.chain.pub.readContract({
            address: this.d.book,
            abi: oddraBookAbi,
            functionName: "claimable",
            args: [b.id],
          }) as Promise<bigint>,
      ),
    );
    const due = bets.filter((_, i) => claimable[i] > 0n).map((b) => b.id);
    for (let i = 0; i < due.length; i += 40) {
      const chunk = due.slice(i, i + 40);
      await this.chain.send({
        purpose: "payoutBatch",
        matchId: id,
        signer: "keeper",
        address: this.d.book,
        abi: oddraBookAbi,
        functionName: "payoutBatch",
        args: [chunk],
      });
    }
  }

  private async void(id: bigint) {
    await this.job(id, "void", () =>
      this.chain.send({
        purpose: "voidMatch",
        matchId: id,
        address: this.d.registry,
        abi: oddraMatchRegistryAbi,
        functionName: "voidMatch",
        args: [id],
      }),
    );
  }

  /** Runs a step, recording it in SchedulerJob so operators can see attempts and failures. */
  private async job<T>(id: bigint, step: string, fn: () => Promise<T>): Promise<T | undefined> {
    const prisma = hasDatabase() ? db() : null;
    if (prisma)
      await prisma.schedulerJob.upsert({
        where: { matchId_step: { matchId: id, step } },
        create: { matchId: id, step, status: "RUNNING", attempts: 1 },
        update: { status: "RUNNING", attempts: { increment: 1 } },
      });
    try {
      const out = await fn();
      if (prisma)
        await prisma.schedulerJob.update({
          where: { matchId_step: { matchId: id, step } },
          data: { status: "DONE", lastError: null, txHash: typeof out === "string" ? out : undefined },
        });
      return out;
    } catch (e) {
      if (prisma)
        await prisma.schedulerJob
          .update({
            where: { matchId_step: { matchId: id, step } },
            data: { status: "FAILED", lastError: errMsg(e).slice(0, 500) },
          })
          .catch(() => {});
      throw e;
    }
  }

  private async syncRow(id: bigint, m: OnchainMatch) {
    const s = slot(id);
    const data = {
      status: DB_STATUS[m.status],
      entropyBlock: m.entropyBlock > 0n ? m.entropyBlock : null,
      entropy: m.entropy !== zeroHash ? m.entropy : null,
      serverSeed: m.serverSeed !== zeroHash ? m.serverSeed : null,
      finalSeed: m.finalSeed !== zeroHash ? m.finalSeed : null,
      homeGoals: hasResult(m.status) ? m.homeGoals : null,
      awayGoals: hasResult(m.status) ? m.awayGoals : null,
      firstScorer: hasResult(m.status) ? m.firstScorer : null,
      resultHash: m.resultHash !== zeroHash ? m.resultHash : null,
    };
    await db().match.upsert({
      where: { id },
      create: {
        id,
        homeTeamId: m.homeTeam,
        awayTeamId: m.awayTeam,
        openTime: new Date(s.openTime * 1000),
        kickoff: new Date(s.kickoff * 1000),
        fullTime: new Date(s.fullTime * 1000),
        engineVersion: ENGINE_VERSION,
        configHash: m.configHash,
        rulesetHash: m.rulesetHash,
        seedCommit: m.seedCommit,
        ...data,
      },
      update: data,
    });
    if (m.status === ST.Settled) {
      const mask = winMask(m.homeGoals, m.awayGoals, m.firstScorer);
      await db().bettingMarket.updateMany({ where: { matchId: id, won: null }, data: { won: false } });
      await db().bettingMarket.updateMany({
        where: { matchId: id, selection: { in: SELECTIONS.filter((x) => (mask >>> x.id) & 1).map((x) => x.id) } },
        data: { won: true },
      });
    }
  }

  private readonly alerted = new Map<string, number>();

  recordError(id: bigint, step: string, e: unknown, severity: "warn" | "critical" = "warn") {
    const error = errMsg(e);
    log.warn("step failed", { matchId: id, step, error });
    this.status.errors.unshift({ at: this.status.chainTime, matchId: id.toString(), step, error: error.slice(0, 300) });
    this.status.errors.length = Math.min(this.status.errors.length, 25);
    // raise an operational alert at most every 5 minutes per (match, step)
    const key = `${id}:${step}`;
    if (Date.now() - (this.alerted.get(key) ?? 0) < 300_000) return;
    this.alerted.set(key, Date.now());
    const message = `match ${id} · ${step}: ${error.slice(0, 300)}`;
    const level = step === "simulate" ? "critical" : severity;
    if (hasDatabase())
      void db()
        .alert.create({ data: { level, source: "scheduler", message } })
        .catch(() => {});
    if (this.env.alertWebhook)
      void fetch(this.env.alertWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[oddra ${level}] ${message}`, level, matchId: id.toString(), step }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
  }
}
