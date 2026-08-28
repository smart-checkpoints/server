import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type CardProps = {
  /** `flat` sits quietly, `raised` lifts off the page, `interactive` responds. */
  elevation?: "flat" | "raised" | "interactive";
  accent?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  className?: string;
  children: ReactNode;
};

const elevations = {
  flat: "shadow-sm",
  raised: "shadow-md",
  interactive:
    "shadow-md transition-colors duration-200 ease-out hover:border-cyan",
} as const;

const paddings = {
  none: "",
  sm: "p-5 sm:p-6",
  md: "p-7 sm:p-9",
  lg: "p-8 sm:p-12",
} as const;

/** A white surface lifted off the ground. The layout's main building block. */
export default function Card({
  elevation = "raised",
  accent = false,
  padding = "md",
  className,
  children,
}: CardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-surface",
        accent ? "border-cyan" : "border-border",
        elevations[elevation],
        paddings[padding],
        className,
      )}
    >
      {children}
    </div>
  );
}
