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

    const drawPitch = () => {
      ctx.fillStyle = "#08100b";
      ctx.fillRect(0, 0, el.width, el.height);
      // mowing stripes
      const stripe = PITCH.L / 14;
      for (let i = 0; i < 14; i++) {
        if (i % 2) continue;
        ctx.fillStyle = "#0b1610";
        ctx.fillRect(X(i * stripe), Y(0), stripe * scale, PITCH.W * scale);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.34)";
      ctx.lineWidth = Math.max(1, 0.14 * scale);
      ctx.strokeRect(X(0), Y(0), PITCH.L * scale, PITCH.W * scale);
      ctx.beginPath();
      ctx.moveTo(X(PITCH.L / 2), Y(0));
      ctx.lineTo(X(PITCH.L / 2), Y(PITCH.W));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X(PITCH.L / 2), Y(PITCH.cy), PITCH.centreR * scale, 0, Math.PI * 2);
      ctx.stroke();
      const spot = (x: number, y: number) => {
        ctx.beginPath();
        ctx.arc(X(x), Y(y), 0.3 * scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fill();
      };
      spot(PITCH.L / 2, PITCH.cy);
      for (const side of [0, 1]) {
        const gx = side ? PITCH.L : 0;
        const d = side ? -1 : 1;
        ctx.strokeRect(
          X(side ? gx - PITCH.boxDepth : gx),
          Y(PITCH.cy - PITCH.boxHalfW),
          PITCH.boxDepth * scale,
          PITCH.boxHalfW * 2 * scale,
        );
        ctx.strokeRect(
          X(side ? gx - PITCH.sixDepth : gx),
          Y(PITCH.cy - PITCH.sixHalfW),
          PITCH.sixDepth * scale,
          PITCH.sixHalfW * 2 * scale,
        );
        spot(gx + d * PITCH.penSpot, PITCH.cy);
        // penalty arc: the part of the 9.15 m circle outside the box
        ctx.beginPath();
        const a = Math.acos((PITCH.boxDepth - PITCH.penSpot) / PITCH.centreR);
        if (side) ctx.arc(X(gx - PITCH.penSpot), Y(PITCH.cy), PITCH.centreR * scale, Math.PI - a, Math.PI + a);
        else ctx.arc(X(gx + PITCH.penSpot), Y(PITCH.cy), PITCH.centreR * scale, -a, a);
        ctx.stroke();
        // goal
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = Math.max(1.5, 0.25 * scale);
        ctx.strokeRect(
          X(side ? gx : gx - 1.6),
          Y(PITCH.cy - PITCH.goalHalfW),
          1.6 * scale,
          PITCH.goalHalfW * 2 * scale,
        );
        ctx.restore();
        // corner arcs
        for (const cy of [0, PITCH.W]) {
          ctx.beginPath();
          const start = side ? (cy ? Math.PI : Math.PI / 2) : cy ? -Math.PI / 2 : 0;
          ctx.arc(X(gx), Y(cy), PITCH.cornerR * scale, start, start + Math.PI / 2);
          ctx.stroke();
        }
      }
    };

    const frame = () => {
      const { config: cfg, result: res, preview: pre, gameSeconds: gs } = live.current;
      drawPitch();
      if (cfg) {
        const [homeKit, awayKit] = kits(cfg);
        const GK = keeperKits([homeKit, awayKit]);
        let get: (k: number) => number;
        let owner = -1;
        if (res) {
          const f = Math.max(0, Math.min(FRAME_COUNT - 1.0001, gs() / (DT * FRAME_EVERY)));
          const i = Math.floor(f);
          const t = f - i;
          const a = i * FRAME_STRIDE;
          const b = Math.min(FRAME_COUNT - 1, i + 1) * FRAME_STRIDE;
          get = (k) => (res.frames[a + k] * (1 - t) + res.frames[b + k] * t) / 10;
          owner = res.owners[t < 0.5 ? i : Math.min(FRAME_COUNT - 1, i + 1)];
        } else if (pre) {
          get = (k) => pre[k] / 10;
        } else {
          rafLoop();
          return;
        }
        const r = Math.max(4, 1.05 * scale);
        for (let k = 0; k < 22; k++) {
          const x = X(get(k * 2));
          const y = Y(get(k * 2 + 1));
          const kit = k < 11 ? homeKit : awayKit;
          const isGk = k % 11 === 0;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = isGk ? GK[k < 11 ? 0 : 1] : kit;
          ctx.fill();
          ctx.lineWidth = Math.max(1, 0.18 * scale);
          // dark shirts get a light outline so they stand out on the dark pitch
          ctx.strokeStyle =
            luminance(isGk ? GK[k < 11 ? 0 : 1] : kit) < 95 ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.65)";
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
            ctx.fillStyle = textOn(isGk ? GK[k < 11 ? 0 : 1] : kit);
            ctx.font = `600 ${Math.round(r * 0.95)}px var(--font-geist-sans), system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(team.players[k % 11].number), x, y + 0.5);
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
        ctx.fill();
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
      className={`block w-full ${className}`}
      style={{ aspectRatio: `${W} / ${H}` }}
      role="img"
      aria-label="Top-down view of the pitch with all 22 players and the ball"
    />
  );
}
