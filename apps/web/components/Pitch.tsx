"use client";

import { useEffect, useRef } from "react";
import { FRAME_COUNT, FRAME_EVERY, FRAME_STRIDE, DT, PITCH, type MatchConfig, type MatchResult } from "@oddra/engine";

const PAD = 3.5; // metres of surround
const W = PITCH.L + PAD * 2;
const H = PITCH.W + PAD * 2;

/** Perceived-brightness distance, to keep the two kits distinguishable. */
function colourDistance(a: string, b: string) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  return (
    Math.abs(r1 - r2) * 0.3 + Math.abs(g1 - g2) * 0.59 + Math.abs(b1 - b2) * 0.11 + Math.abs(r1 - r2 + b1 - b2) * 0.2
  );
}

export function kits(cfg: MatchConfig): [string, string] {
  const home = cfg.home.kit[0];
  const away = colourDistance(home, cfg.away.kit[0]) > 70 ? cfg.away.kit[0] : cfg.away.kit[1];
  return [home, away];
}

const GK_CANDIDATES = ["#F2D14B", "#C77DFF", "#00E0FF", "#FF7AC6", "#FF8A3D", "#9BE15D"];

/** Goalkeeper shirts: the candidates that differ most from both outfield kits (and from each other). */
export function keeperKits(kitsUsed: [string, string]): [string, string] {
  const pickFar = (avoid: string[]) =>
    GK_CANDIDATES.reduce((best, c) => {
      const d = Math.min(...avoid.map((a) => colourDistance(a, c)));
      const bd = Math.min(...avoid.map((a) => colourDistance(a, best)));
      return d > bd ? c : best;
    }, GK_CANDIDATES[0]);
  const home = pickFar(kitsUsed);
  return [home, pickFar([...kitsUsed, home])];
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114;
};

const textOn = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "#050505" : "#ffffff";
};

/**
 * Canvas renderer. Positions come from recorded frames (every 0.5 game seconds) and are interpolated, so movement is
 * smooth at any refresh rate. `gameSeconds()` decides what to show: chain time for live play, a slider for replays.
 */
export function Pitch({
  config,
  result,
  preview,
  gameSeconds,
  className = "",
}: {
  config: MatchConfig | null;
  result: MatchResult | null;
  /** Kickoff-shape frame shown before the seed is revealed. */
  preview?: Int16Array | null;
  gameSeconds: () => number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ config, result, preview, gameSeconds });
  live.current = { config, result, preview, gameSeconds };

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    let raf = 0;
    let scale = 1;
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.round(r.width * dpr);
      el.height = Math.round(r.height * dpr);
      scale = el.width / W;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const X = (x: number) => (x + PAD) * scale;
    const Y = (y: number) => (y + PAD) * scale;

    // the pitch is drawn once per size into an offscreen canvas, then blitted every frame
    let turf: HTMLCanvasElement | null = null;
    const paintTurf = () => {
      const c = document.createElement("canvas");
      c.width = el.width;
      c.height = el.height;
      const g = c.getContext("2d")!;
      g.fillStyle = "#070d09";
      g.fillRect(0, 0, c.width, c.height);
      const stripe = PITCH.L / 14;
      for (let i = 0; i < 14; i++) {
        g.fillStyle = i % 2 ? "#0a140e" : "#0c1811";
        g.fillRect(X(i * stripe), Y(0), stripe * scale + 1, PITCH.W * scale);
      }
      // floodlight vignette
      const v = g.createRadialGradient(
        c.width / 2,
        c.height / 2,
        c.height * 0.2,
        c.width / 2,
        c.height / 2,
        c.width * 0.62,
      );
      v.addColorStop(0, "rgba(0,0,0,0)");
      v.addColorStop(1, "rgba(0,0,0,0.38)");
      g.fillStyle = v;
      g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = "rgba(255,255,255,0.38)";
      g.lineWidth = Math.max(1, 0.14 * scale);
      g.strokeRect(X(0), Y(0), PITCH.L * scale, PITCH.W * scale);
      g.beginPath();
      g.moveTo(X(PITCH.L / 2), Y(0));
      g.lineTo(X(PITCH.L / 2), Y(PITCH.W));
      g.stroke();
      g.beginPath();
      g.arc(X(PITCH.L / 2), Y(PITCH.cy), PITCH.centreR * scale, 0, Math.PI * 2);
      g.stroke();
      const spot = (x: number, y: number) => {
        g.beginPath();
        g.arc(X(x), Y(y), 0.3 * scale, 0, Math.PI * 2);
        g.fillStyle = "rgba(255,255,255,0.55)";
        g.fill();
      };
      spot(PITCH.L / 2, PITCH.cy);
      for (const side of [0, 1]) {
        const gx = side ? PITCH.L : 0;
        const d = side ? -1 : 1;
        g.strokeRect(
          X(side ? gx - PITCH.boxDepth : gx),
          Y(PITCH.cy - PITCH.boxHalfW),
          PITCH.boxDepth * scale,
          PITCH.boxHalfW * 2 * scale,
        );
        g.strokeRect(
          X(side ? gx - PITCH.sixDepth : gx),
          Y(PITCH.cy - PITCH.sixHalfW),
          PITCH.sixDepth * scale,
          PITCH.sixHalfW * 2 * scale,
        );
        spot(gx + d * PITCH.penSpot, PITCH.cy);
        g.beginPath();
        const a = Math.acos((PITCH.boxDepth - PITCH.penSpot) / PITCH.centreR);
        if (side) g.arc(X(gx - PITCH.penSpot), Y(PITCH.cy), PITCH.centreR * scale, Math.PI - a, Math.PI + a);
        else g.arc(X(gx + PITCH.penSpot), Y(PITCH.cy), PITCH.centreR * scale, -a, a);
        g.stroke();
        // goal frame and net
        const nx = X(side ? gx : gx - 1.8);
        const ny = Y(PITCH.cy - PITCH.goalHalfW);
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(nx, ny, 1.8 * scale, PITCH.goalHalfW * 2 * scale);
        g.save();
        g.strokeStyle = "rgba(255,255,255,0.12)";
        g.lineWidth = 1;
        for (let k = 1; k < 8; k++) {
          g.beginPath();
          g.moveTo(nx, ny + (k * PITCH.goalHalfW * 2 * scale) / 8);
          g.lineTo(nx + 1.8 * scale, ny + (k * PITCH.goalHalfW * 2 * scale) / 8);
          g.stroke();
        }
        g.strokeStyle = "rgba(255,255,255,0.85)";
        g.lineWidth = Math.max(1.5, 0.25 * scale);
        g.strokeRect(nx, ny, 1.8 * scale, PITCH.goalHalfW * 2 * scale);
        g.restore();
        for (const cy of [0, PITCH.W]) {
          g.beginPath();
          const start = side ? (cy ? Math.PI : Math.PI / 2) : cy ? -Math.PI / 2 : 0;
          g.arc(X(gx), Y(cy), PITCH.cornerR * scale, start, start + Math.PI / 2);
          g.stroke();
        }
      }
      turf = c;
    };

    /** First event index with tick >= t (events are sorted by tick). */
    const firstAt = (events: MatchResult["events"], t: number) => {
      let lo = 0;
      let hi = events.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (events[mid].tick < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    const frame = () => {
      const { config: cfg, result: res, preview: pre, gameSeconds: gs } = live.current;
      if (!turf || turf.width !== el.width || turf.height !== el.height) paintTurf();
      ctx.drawImage(turf!, 0, 0);
      if (cfg) {
        const [homeKit, awayKit] = kits(cfg);
        const GK = keeperKits([homeKit, awayKit]);
        let get: (k: number) => number;
        let ballAt: ((sec: number) => [number, number, number]) | null = null;
        let owner = -1;
        const now = res ? Math.max(0, Math.min(5400, gs())) : 0;
        if (res) {
          const sample = (sec: number) => {
            const f = Math.max(0, Math.min(FRAME_COUNT - 1.0001, sec / (DT * FRAME_EVERY)));
            const i = Math.floor(f);
            return { a: i * FRAME_STRIDE, b: Math.min(FRAME_COUNT - 1, i + 1) * FRAME_STRIDE, t: f - i, i };
          };
          const cur = sample(now);
          get = (k) => (res.frames[cur.a + k] * (1 - cur.t) + res.frames[cur.b + k] * cur.t) / 10;
          owner = res.owners[cur.t < 0.5 ? cur.i : Math.min(FRAME_COUNT - 1, cur.i + 1)];
          ballAt = (sec) => {
            const s = sample(sec);
            const v = (k: number) => (res.frames[s.a + k] * (1 - s.t) + res.frames[s.b + k] * s.t) / 10;
            return [v(44), v(45), v(46)];
          };
        } else if (pre) {
          get = (k) => pre[k] / 10;
        } else {
          rafLoop();
          return;
        }

        // shot trajectories and goal flashes from the last few game seconds
        if (res) {
          const tick = now / DT;
          for (let j = firstAt(res.events, tick - 40); j < res.events.length && res.events[j].tick <= tick; j++) {
            const e = res.events[j];
            if (e.type !== "shot" && e.type !== "goal") continue;
            const age = (tick - e.tick) * DT;
            const half = e.tick < 27_000 ? 0 : 1;
            const attacksRight = (e.team === 0) === (half === 0);
            const gx = attacksRight ? PITCH.L : 0;
            if (e.type === "shot" && age < 2.5) {
              ctx.save();
              ctx.globalAlpha = 1 - age / 2.5;
              ctx.strokeStyle = e.ok ? "#B8FF65" : "rgba(255,255,255,0.7)";
              ctx.setLineDash([0.6 * scale, 0.5 * scale]);
              ctx.lineWidth = Math.max(1, 0.2 * scale);
              ctx.beginPath();
              ctx.moveTo(X(e.x), Y(e.y));
              ctx.lineTo(X(gx), Y(PITCH.cy));
              ctx.stroke();
              ctx.restore();
            }
            if (e.type === "goal" && age < 4) {
              const p = age / 4;
              ctx.save();
              ctx.globalAlpha = 1 - p;
              ctx.strokeStyle = "#B8FF65";
              ctx.lineWidth = Math.max(2, 0.35 * scale);
              ctx.beginPath();
              ctx.arc(X(gx), Y(PITCH.cy), (2 + p * 14) * scale, 0, Math.PI * 2);
              ctx.stroke();
              ctx.fillStyle = "rgba(184,255,101,0.25)";
              ctx.fillRect(
                X(attacksRight ? gx : gx - 1.8),
                Y(PITCH.cy - PITCH.goalHalfW),
                1.8 * scale,
                PITCH.goalHalfW * 2 * scale,
              );
              ctx.restore();
            }
          }
        }

        const r = Math.max(4, 1.05 * scale);
        ctx.globalAlpha = res ? 1 : 0.85;
        for (let k = 0; k < 22; k++) {
          const x = X(get(k * 2));
          const y = Y(get(k * 2 + 1));
          const kit = k < 11 ? homeKit : awayKit;
          const isGk = k % 11 === 0;
          const fill = isGk ? GK[k < 11 ? 0 : 1] : kit;
          // shadow
          ctx.beginPath();
          ctx.ellipse(x + r * 0.25, y + r * 0.45, r * 0.95, r * 0.55, 0, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fill();
          // shirt with a soft highlight
          const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
          grad.addColorStop(0, "rgba(255,255,255,0.35)");
          grad.addColorStop(0.45, fill);
          grad.addColorStop(1, fill);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.lineWidth = Math.max(1, 0.18 * scale);
          // dark shirts get a light outline so they stand out on the dark pitch
          ctx.strokeStyle = luminance(fill) < 95 ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.65)";
          ctx.stroke();
          if (k === owner) {
            ctx.beginPath();
            ctx.arc(x, y, r + Math.max(2, 0.45 * scale), 0, Math.PI * 2);
            ctx.strokeStyle = "#B8FF65";
            ctx.lineWidth = Math.max(1.5, 0.22 * scale);
            ctx.stroke();
          }
          if (r >= 7) {
            const team = k < 11 ? cfg.home : cfg.away;
            ctx.fillStyle = textOn(fill);
            ctx.font = `600 ${Math.round(r * 0.95)}px var(--font-geist-sans), system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(team.players[k % 11].number), x, y + 0.5);
          }
        }
        ctx.globalAlpha = 1;

        // the ball carrier's name
        if (owner >= 0 && r >= 5) {
          const team = owner < 11 ? cfg.home : cfg.away;
          const name = team.players[owner % 11].name.split(" ").slice(-1)[0];
          const x = X(get(owner * 2));
          const y = Y(get(owner * 2 + 1)) - r - Math.max(9, 1.6 * scale);
          ctx.font = `600 ${Math.max(10, Math.round(r * 0.9))}px var(--font-geist-sans), system-ui, sans-serif`;
          const w = ctx.measureText(name).width + 10;
          const h = Math.max(14, r * 1.4);
          ctx.fillStyle = "rgba(5,5,5,0.78)";
          ctx.beginPath();
          ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(name, x, y + 0.5);
        }

        // ball trail from the recorded path (deterministic, so it is also right when scrubbing)
        if (ballAt) {
          for (let k = 8; k >= 1; k--) {
            const [tx, ty, tz] = ballAt(now - k * 0.12);
            ctx.beginPath();
            ctx.arc(X(tx), Y(ty) - tz * scale * 0.55, Math.max(1.2, 0.32 * scale * (1 - k / 10)), 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,255,255,${0.32 * (1 - k / 9)})`;
            ctx.fill();
          }
        }
        // ball and its shadow
        const bx = get(44);
        const by = get(45);
        const bz = Math.max(0, get(46));
        ctx.beginPath();
        ctx.ellipse(X(bx) + bz * scale * 0.25, Y(by) + bz * scale * 0.15, 0.5 * scale, 0.32 * scale, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(X(bx), Y(by) - bz * scale * 0.55, Math.max(2.5, (0.48 + bz * 0.06) * scale), 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "rgba(255,255,255,0.6)";
        ctx.shadowBlur = Math.max(2, 0.6 * scale);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      rafLoop();
    };
    const rafLoop = () => {
      raf = requestAnimationFrame(frame);
    };
    rafLoop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvas}
      className={`mx-auto block w-full ${className}`}
      style={{ aspectRatio: `${W} / ${H}`, maxWidth: `calc(60vh * ${W} / ${H})` }}
      role="img"
      aria-label="Top-down view of the pitch with all 22 players and the ball"
    />
  );
}
