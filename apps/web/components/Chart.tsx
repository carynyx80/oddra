"use client";

import { useMemo, useState } from "react";

export interface Series {
  name: string;
  color: string;
  values: number[];
}

/** Minimal responsive line chart (SVG). x = index into `labels`; hover shows every series at that point. */
export function LineChart({
  labels,
  series,
  height = 220,
  format = (v: number) => v.toLocaleString(),
}: {
  labels: string[];
  series: Series[];
  height?: number;
  format?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = height;
  const pad = { l: 56, r: 12, t: 12, b: 26 };
  const { min, max } = useMemo(() => {
    const all = series.flatMap((s) => s.values);
    const mx = Math.max(1, ...all);
    return { min: Math.min(0, ...all), max: mx * 1.08 };
  }, [series]);
  const n = labels.length;
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
  if (n === 0) return <div className="flex h-40 items-center justify-center text-[13px] text-muted">No data yet.</div>;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={series.map((s) => s.name).join(", ")}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1)))));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#29292f" strokeWidth="1" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#92929d" className="num">
              {format(t)}
            </text>
          </g>
        ))}
        {[0, Math.floor((n - 1) / 2), n - 1].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 6}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            fontSize="11"
            fill="#92929d"
          >
            {labels[i]}
          </text>
        ))}
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          />
        ))}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="#3a3a42" /> : null}
        {hover !== null
          ? series.map((s) => <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r="3.5" fill={s.color} />)
          : null}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-[12px]">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.name}
            {hover !== null ? <span className="num text-fg">{format(s.values[hover])}</span> : null}
          </span>
        ))}
        {hover !== null ? <span className="text-muted">{labels[hover]}</span> : null}
      </div>
    </div>
  );
}
