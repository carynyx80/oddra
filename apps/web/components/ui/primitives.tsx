import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-card", className)} {...p} />;
}

export function CardHeader({ title, right, className }: { title: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 border-b border-line px-4 py-3", className)}>
      <h2 className="text-[13px] font-medium tracking-wide text-fg">{title}</h2>
      {right}
    </div>
  );
}

type Variant = "primary" | "ghost" | "outline" | "danger";
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }
>(function Button({ className, variant = "outline", size = "md", ...p }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
        size === "sm" ? "h-8 px-3 text-[12px]" : "h-10 px-4 text-[13px]",
        variant === "primary" && "bg-accent text-black hover:bg-[#c9ff86]",
        variant === "outline" && "border border-line bg-raised text-fg hover:border-[#3a3a42]",
        variant === "ghost" && "text-muted hover:text-fg",
        variant === "danger" && "border border-neg/40 bg-neg/10 text-neg hover:bg-neg/20",
        className,
      )}
      {...p}
    />
  );
});

export function Badge({
  tone = "muted",
  children,
  className,
}: {
  tone?: "muted" | "accent" | "pos" | "neg" | "warn";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    muted: "border-line text-muted",
    accent: "border-accent/40 text-accent",
    pos: "border-pos/40 text-pos",
    neg: "border-neg/40 text-neg",
    warn: "border-warn/40 text-warn",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function LiveDot({ className }: { className?: string }) {
  return <span className={cn("live-dot inline-block h-1.5 w-1.5 rounded-full bg-accent", className)} />;
}

export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="label">{label}</div>
      <div className="num mt-1 truncate font-[family-name:var(--font-display)] text-[20px] font-semibold">{value}</div>
      {sub ? <div className="num mt-0.5 text-[12px] text-muted">{sub}</div> : null}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (k: T) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line px-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            "relative shrink-0 px-3 py-2.5 text-[13px] transition-colors",
            value === t.key
              ? "text-fg after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-accent"
              : "text-muted hover:text-fg",
          )}
        >
          {t.label}
          {t.count !== undefined ? <span className="num ml-1.5 text-muted">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-muted">{children}</div>;
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn("text-muted underline decoration-line underline-offset-2 hover:text-fg", className)}
    >
      {children}
    </a>
  );
}
