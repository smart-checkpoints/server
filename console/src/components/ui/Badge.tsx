import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "accent" | "green" | "yellow" | "red";

type BadgeProps = {
  tone?: BadgeTone;
  /** Show the status dot. Status tones carry it by default. */
  dot?: boolean;
  mono?: boolean;
  className?: string;
  children: ReactNode;
};

const tones: Record<BadgeTone, { chip: string; dot: string }> = {
  neutral: { chip: "border-border bg-surface text-text-dim", dot: "bg-text-dim" },
  accent: { chip: "border-cyan bg-cyan-glow text-cyan-dark", dot: "bg-cyan" },
  green: { chip: "border-border bg-surface text-text-dim", dot: "bg-green" },
  yellow: { chip: "border-border bg-surface text-text-dim", dot: "bg-yellow" },
  red: { chip: "border-border bg-surface text-text-dim", dot: "bg-red" },
};

const statusTones: BadgeTone[] = ["green", "yellow", "red"];

export default function Badge({
  tone = "neutral",
  dot,
  mono = false,
  className,
  children,
}: BadgeProps) {
  const showDot = dot ?? statusTones.includes(tone);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5",
        "text-xs font-semibold uppercase tracking-[0.14em]",
        mono && "font-mono",
        tones[tone].chip,
        className,
      )}
    >
      {showDot ? (
        <span
          aria-hidden="true"
          className={cn("h-2 w-2 shrink-0 rounded-full", tones[tone].dot)}
        />
      ) : null}
      {children}
    </span>
  );
}
