import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { DT, GAME_SECONDS_PER_REAL_SECOND, type MatchEvent } from "@oddra/engine";
import { commentary, isRevealed, phaseOf, slot, slotAt } from "@oddra/shared";
import type { Scheduler } from "./scheduler";
import { STATUS } from "./scheduler";
import { log } from "./log";

/** Real (chain) time at which an event happens during the 15-minute broadcast. */
export const eventTime = (kickoff: number, tick: number) => kickoff + (tick * DT) / GAME_SECONDS_PER_REAL_SECOND;

/**
 * Authoritative live feed. Every message carries the match id and the event's sequence number, so clients drop
 * duplicates and reorder late messages; a client that (re)connects gets a snapshot plus every key event so far.
 * Positions are not streamed: clients replay them from the revealed seed with the same engine, so all viewers see the
 * same frame at the same chain time.
 */
export class LiveHub {
  private readonly wss: WebSocketServer;
  private readonly sent = new Map<string, number>(); // matchId -> last broadcast seq
  private readonly server;
  private readonly startedAt = Date.now();

  constructor(
    private readonly scheduler: Scheduler,
    port: number,
    private readonly health: () => Record<string, unknown>,
  ) {
    this.server = createServer((req, res) => this.http(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: "/live" });
    this.wss.on("connection", (ws) => this.welcome(ws));
    this.server.listen(port, () => log.info("live hub listening", { port }));
  }

  private json(res: ServerResponse, code: number, body: unknown) {
    res.writeHead(code, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  }

  private http(req: IncomingMessage, res: ServerResponse) {
    if (req.url === "/health") {
      const h = this.health();
      return this.json(res, h.ok ? 200 : 503, {
        ...h,
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      });
    }
    if (req.url === "/state") return this.json(res, 200, this.snapshot());
    this.json(res, 404, { error: "not found" });
  }

  snapshot() {
    const now = this.scheduler.status.chainTime;
    const cur = slotAt(now).matchId;
    const matches = [cur - 1n, cur, cur + 1n].map((id) => {
      const m = this.scheduler.onchain.get(id.toString());
      const s = slot(id);
      const sim = this.scheduler.sims.get(id.toString());
      const phase = phaseOf(s, now);
      const shown = sim ? sim.events.filter((e) => eventTime(s.kickoff, e.tick) <= now) : [];
      const last = shown[shown.length - 1];
      return {
        matchId: id.toString(),
        status: m ? STATUS[m.status] : "None",
        phase,
        openTime: s.openTime,
        kickoff: s.kickoff,
        fullTime: s.fullTime,
        homeTeam: m?.homeTeam ?? null,
        awayTeam: m?.awayTeam ?? null,
        finalSeed: m && isRevealed(m.status) ? m.finalSeed : null,
        score: last ? [last.home, last.away] : [0, 0],
        minute: last ? Math.min(90, Math.floor(last.tick / 600) + 1) : 0,
      };
    });
    return { type: "state", now, safeState: this.scheduler.status.safeState, matches };
  }

  private send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const c of this.wss.clients) if (c.readyState === c.OPEN) c.send(data);
  }

  private welcome(ws: WebSocket) {
    this.send(ws, { type: "hello", now: this.scheduler.status.chainTime });
    this.send(ws, this.snapshot());
    const now = this.scheduler.status.chainTime;
    const cur = slotAt(now).matchId;
    const s = slot(cur);
    const sim = this.scheduler.sims.get(cur.toString());
    if (sim) {
      const backlog = sim.events.filter((e) => e.type !== "pass" && eventTime(s.kickoff, e.tick) <= now);
      for (const e of backlog) this.send(ws, this.eventMsg(cur, e));
    }
  }

  private eventMsg(matchId: bigint, e: MatchEvent) {
    const sim = this.scheduler.sims.get(matchId.toString());
    return { type: "event", matchId: matchId.toString(), event: e, text: sim ? commentary(sim.config, e) : null };
  }

  /** Called every second: clock, new events, and settlement status changes. */
  pulse() {
    const now = this.scheduler.status.chainTime;
    if (!now) return;
    const cur = slotAt(now).matchId;
    const s = slot(cur);
    const key = cur.toString();
    const sim = this.scheduler.sims.get(key);
    if (sim && now >= s.kickoff) {
      const from = (this.sent.get(key) ?? -1) + 1;
      let last = from - 1;
      for (let i = from; i < sim.events.length; i++) {
        const e = sim.events[i];
        if (eventTime(s.kickoff, e.tick) > now) break;
        if (e.type !== "pass") this.broadcast(this.eventMsg(cur, e));
        last = i;
      }
      this.sent.set(key, last);
    }
    const gameSeconds = Math.max(0, Math.min(5400, (now - s.kickoff) * GAME_SECONDS_PER_REAL_SECOND));
    this.broadcast({ type: "clock", now, matchId: key, phase: phaseOf(s, now), gameSeconds });
    if (Math.floor(now) % 5 === 0) this.broadcast(this.snapshot());
  }

  close() {
    this.wss.close();
    this.server.close();
  }
}
