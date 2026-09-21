import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export function LoaderMark({ size = 56, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("rl-mark", className)}
    >
      <rect width="64" height="64" rx="14" fill="#0F1719" />
      <circle className="rl-sun" cx="30" cy="28" r="11" fill="#F4B23E" />
      <path d="M43 45 L24 52 C20.5 53.2 17.5 51 18.5 47.5 L23 33.5 L43 45 Z" fill="#2DD4BF" />
      <path
        d="M23 33.5 L37.5 41.7 L27.5 49.9 C24.9 51.9 21.6 50.3 22.3 47.1 L23 33.5 Z"
        fill="#14B8A6"
        opacity="0.55"
      />
      <circle className="rl-spark-a" cx="51" cy="14" r="2.5" fill="#F4B23E" />
      <circle className="rl-spark-b" cx="13" cy="51" r="2" fill="#2DD4BF" />
      <clipPath id="rl-clip">
        <rect width="64" height="64" rx="14" />
      </clipPath>
      <g clipPath="url(#rl-clip)">
        <rect className="rl-sweep" x="-64" y="0" width="64" height="64" fill="url(#rl-sweep-grad)" />
      </g>
      <defs>
        <linearGradient id="rl-sweep-grad" x1="0" y1="0" x2="64" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export type LoaderStep = { label: string; state: "done" | "active" | "pending" };

export function RelightLoader({
  label = "Loading…",
  steps,
  fullScreen = false,
  compact = false,
  className,
}: {
  label?: string;
  steps?: LoaderStep[];
  fullScreen?: boolean;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-4 text-center",
        fullScreen ? "min-h-[60vh] bg-background px-6" : "px-6 py-10",
        className,
      )}
    >
      <LoaderMark size={compact ? 40 : 56} />

      {steps && steps.length > 0 && (
        <ol className="mt-1 flex items-center gap-1.5" aria-label="Pipeline progress">
          {steps.map((s, i) => (
            <li key={s.label} className="flex items-center gap-1.5">
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-px w-4 sm:w-6",
                    s.state === "pending" ? "bg-border" : "bg-primary/50",
                  )}
                />
              )}
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                  s.state === "done" && "border-primary/40 bg-primary/10 text-primary",
                  s.state === "active" && "rl-chip-active border-primary/50 bg-primary/10 text-primary",
                  s.state === "pending" && "border-border/60 bg-muted/40 text-muted-foreground",
                )}
              >
                {s.state === "done" ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : s.state === "active" ? (
                  <span className="relative flex size-2" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary" />
                  </span>
                ) : (
                  <span className="size-2 rounded-full bg-muted-foreground/40" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">{s.label}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className={cn("font-medium text-muted-foreground", compact ? "text-xs" : "text-sm")}>
        {label}
      </p>

      {!steps && (
        <span className="rl-bar" aria-hidden="true">
          <span className="rl-bar-fill" />
        </span>
      )}
    </div>
  );
}
