import type { ReactNode } from "react";
import GraphMark from "@/components/LogoMark";
import Reveal from "@/components/ui/Reveal";
import { cn } from "@/lib/cn";

type SectionHeadingProps = {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: "left" | "center";
  className?: string;
};

/** The mark, a label, a display heading, an optional lead. Every section
 *  opens the same way so the page has one rhythm. */
export default function SectionHeading({
  eyebrow,
  title,
  lead,
  align = "left",
  className,
}: SectionHeadingProps) {
  const centered = align === "center";

  return (
    <Reveal className={cn(centered && "flex flex-col items-center", className)}>
      <div className="flex items-center gap-2.5">
        <GraphMark className="h-4 w-auto shrink-0 text-cyan" />
        <span className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-cyan-dark">
          {eyebrow}
        </span>
      </div>

      <h2
        className={cn(
          "mt-5 max-w-3xl font-display text-3xl font-bold text-text sm:text-4xl",
          centered && "text-center",
        )}
      >
        {title}
      </h2>

      {lead ? (
        <p
          className={cn(
            "mt-5 max-w-2xl text-base text-text-dim sm:text-lg",
            centered && "text-center",
          )}
        >
          {lead}
        </p>
      ) : null}
    </Reveal>
  );
}
