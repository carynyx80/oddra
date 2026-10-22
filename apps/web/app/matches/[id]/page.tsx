"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { keccak256, zeroHash } from "viem";
import {
  ENGINE_VERSION,
  GAME_SECONDS_PER_REAL_SECOND,
  configHash,
  finalSeed,
  keccakHex,
  resultHash,
} from "@oddra/engine";
import { hasResult, phaseOf, slot } from "@oddra/shared";
import { DisputePanel } from "@/components/live/DisputePanel";
import { Pitch } from "@/components/Pitch";
import { Markets } from "@/components/live/Markets";
import { EventToast, MatchTabs, Momentum, PossessionBar } from "@/components/live/MatchCentre";
import { Scoreboard } from "@/components/live/Scoreboard";
import { Badge, Button, Card, CardHeader, Empty, ExtLink } from "@/components/ui/primitives";
import { addressUrl, deployment, explorer } from "@/lib/config";
import { chainNowSync, useChainNow, useMatch, useSimulation } from "@/lib/hooks";
import { configFor, previewFrame, statsAt } from "@/lib/match";
import { cn } from "@/lib/utils";

function Check({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        className={cn(
          "mt-0.5 w-12 shrink-0 text-[11px] font-semibold",
          ok === null ? "text-muted" : ok ? "text-pos" : "text-neg",
        )}
      >
        {ok === null ? "WAIT" : ok ? "PASS" : "FAIL"}
      </span>
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        <div className="mt-0.5 break-all font-[family-name:var(--font-mono)] text-[11px] text-muted">{detail}</div>
      </div>
    </li>
  );
}

export default function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = use(params);
  const id = /^\d+$/.test(raw) ? BigInt(raw) : null;
  const now = useChainNow(500);
  const q = useMatch(id, 6_000);
  const v = q.data;
  const s = id !== null ? slot(id) : null;
  const phase = s && now !== null ? phaseOf(s, now) : null;
  const cfg = v && v.status !== "None" ? configFor(v.id, v.m.homeTeam, v.m.awayTeam) : null;
  const revealed = !!v && v.m.finalSeed !== zeroHash;
  const { result, error } = useSimulation(id, v?.m.homeTeam, v?.m.awayTeam, revealed ? v!.m.finalSeed : undefined);

  // replay controls: live matches follow chain time unless the viewer scrubs
  const [manual, setManual] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const pos = useRef(0);
  const isLive = phase === "live";
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      pos.current = Math.min(5400, pos.current + ((t - last) / 1000) * GAME_SECONDS_PER_REAL_SECOND * speed);
      last = t;
      setManual(pos.current);
      if (pos.current >= 5400) setPlaying(false);
      else raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  const liveSeconds =
    s && now !== null ? Math.max(0, Math.min(5400, (now - s.kickoff) * GAME_SECONDS_PER_REAL_SECOND)) : 0;
  const maxSeconds = phase === "finished" ? 5400 : liveSeconds; // never show beyond the live clock
  const shown = Math.min(manual ?? (isLive ? liveSeconds : phase === "finished" ? 5400 : 0), maxSeconds);
  if (manual === null) pos.current = shown;
  const second = Math.floor(shown);
  const events = useMemo(() => (result ? result.events.filter((e) => e.tick * 0.1 <= second) : []), [result, second]);
  const stats = useMemo(
    () => (result && (isLive || phase === "finished") ? statsAt(result, second) : null),
    [result, second, isLive, phase],
  );
  const last = events[events.length - 1];

  const checks = useMemo(() => {
    if (!v || !cfg) return null;
    const m = v.m;
    const commitOk = revealed ? keccak256(m.serverSeed) === m.seedCommit : null;
    const fs = revealed ? finalSeed(m.serverSeed, m.entropy, v.id) : null;
    const rh = result ? resultHash(result) : null;
    return [
      {
        label: "Committed configuration matches teams, players and ruleset",
        ok: configHash(cfg) === m.configHash,
        detail: m.configHash,
      },
      {
        label: `Ruleset hash is ${ENGINE_VERSION}`,
        ok: keccakHex(ENGINE_VERSION) === m.rulesetHash,
        detail: m.rulesetHash,
      },
      {
        label: "Revealed server seed matches the pre-betting commitment",
        ok: commitOk,
        detail: revealed ? `keccak256(${m.serverSeed}) = ${m.seedCommit}` : `commitment ${m.seedCommit}`,
      },
      {
        label: `Final seed = keccak256(serverSeed, entropy of L2 block ${m.entropyBlock}, matchId)`,
        ok: fs === null ? null : fs === m.finalSeed,
        detail: revealed ? m.finalSeed : "awaiting reveal",
      },
      {
        label:
          v.status === "Settled"
            ? "Your browser's replay produces the settled result hash"
            : "Your browser's replay matches the proposed result",
        ok: !hasResult(v.m.status)
          ? null
          : rh === null
            ? null
            : rh === m.resultHash && result!.homeGoals === m.homeGoals && result!.awayGoals === m.awayGoals,
        detail: hasResult(v.m.status)
          ? `${m.resultHash}${rh && rh !== m.resultHash ? ` (replay: ${rh})` : ""}`
          : "awaiting the result",
      },
    ];
  }, [v, cfg, revealed, result]);

  if (id === null)
    return (
      <Card>
        <Empty>Unknown match.</Empty>
      </Card>
    );
  if (q.isLoading || now === null)
    return (
      <Card>
        <Empty>Loading match #{raw}…</Empty>
      </Card>
    );
  if (!v || v.status === "None" || !cfg)
    return (
      <Card>
        <Empty>Match #{raw} was never scheduled on-chain (the slot was skipped).</Empty>
      </Card>
    );

  const score: [number, number] | null =
    phase === "live" || phase === "finished" ? (last ? [last.home, last.away] : [0, 0]) : null;
  return (
    <div className="space-y-4">
      <Scoreboard
        id={v.id}
        cfg={cfg}
        slot={s!}
        now={now}
        phase={phase!}
        score={score}
        gameSeconds={shown}
        revealed={revealed}
        status={v.status}
      />
      {error ? <p className="text-[13px] text-neg">{error}</p> : null}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="relative bg-[#070d09]">
              <Pitch
                config={cfg}
                result={score ? result : null}
                preview={previewFrame(cfg)}
                gameSeconds={() => {
                  if (manual !== null) return pos.current;
                  const n = chainNowSync();
                  if (phase === "finished") return 5400;
                  return s && n !== null
                    ? Math.max(0, Math.min(5400, (n - s.kickoff) * GAME_SECONDS_PER_REAL_SECOND))
                    : 0;
                }}
              />
              {score ? <EventToast cfg={cfg} events={events} gameSeconds={shown} /> : null}
            </div>
            {result && score ? (
              <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                <Button
                  size="sm"
                  variant={playing ? "outline" : "primary"}
                  onClick={() => setPlaying((p) => !p)}
                  disabled={shown >= maxSeconds && !playing}
                >
                  {playing ? "Pause" : shown >= maxSeconds ? "Ended" : "Play"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPlaying(false);
                    pos.current = 0;
                    setManual(0);
                  }}
                >
                  Restart
                </Button>
                <input
                  type="range"
                  min={0}
                  max={maxSeconds}
                  step={1}
                  value={shown}
                  onChange={(e) => {
                    setPlaying(false);
                    pos.current = Number(e.target.value);
                    setManual(pos.current);
                  }}
                  className="min-w-40 flex-1 accent-[#B8FF65]"
                  aria-label="Replay position"
                />
                <span className="num w-10 text-[13px]">{Math.min(90, Math.floor(shown / 60))}&apos;</span>
                <select
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="h-8 rounded border border-line bg-raised px-2 text-[12px]"
                  aria-label="Replay speed"
                >
                  {[1, 4, 16].map((x) => (
                    <option key={x} value={x}>
                      {x}× broadcast
                    </option>
                  ))}
                </select>
                {manual !== null && isLive ? (
                  <Button size="sm" variant="ghost" onClick={() => setManual(null)}>
                    Back to live
                  </Button>
                ) : null}
              </div>
            ) : null}
            {score ? (
              <div className="border-t border-line">
                <PossessionBar cfg={cfg} stats={stats} />
                <div className="border-t border-line">
                  <Momentum cfg={cfg} result={result} gameSeconds={shown} />
                </div>
              </div>
            ) : null}
          </Card>
          <Card className="overflow-hidden">
            <MatchTabs cfg={cfg} events={events} stats={stats} result={score ? result : null} />
          </Card>
        </div>

        <div className="space-y-4">
          <DisputePanel match={v} replayAgrees={checks ? checks[checks.length - 1].ok : null} now={now} />
          <Card>
            <CardHeader title="Verification" right={<Badge tone="muted">computed in your browser</Badge>} />
            <ul className="divide-y divide-line">
              {checks?.map((c) => (
                <Check key={c.label} {...c} />
              ))}
            </ul>
            <p className="border-t border-line px-4 py-3 text-[12px] text-muted">
              The match engine runs off-chain. These checks prove the result follows from a seed fixed before betting
              and a block hash that did not exist until betting closed; the contract itself does not re-run the engine.
              See the{" "}
              <ExtLink href="https://github.com/carynyx80/oddra/blob/main/docs/FAIRNESS.md">fairness model</ExtLink>.{" "}
              {explorer ? <ExtLink href={addressUrl(deployment.registry)}>Registry on the explorer</ExtLink> : null}
            </p>
          </Card>
          <Card className="overflow-hidden">
            <Markets
              matchId={v.id}
              odds={v.odds}
              open={false}
              winMask={v.book.settled ? v.book.winMask : null}
              homeShort={cfg.home.short}
              awayShort={cfg.away.short}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
