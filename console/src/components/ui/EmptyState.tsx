import type { ReactNode } from "react";
import GraphMark from "@/components/LogoMark";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  className?: string;
};

/**
 * Nothing here yet, said once and in the brand's own mark.
 *
 * Empty is the normal first state of every surface in the console. A new
 * deployment has no projects, a new project has no graph, and a graph under
 * enforcement should have no violations, so it is written as a state, never
 * as a failure.
 */
export default function EmptyState({
  title,
  body,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-14 text-center",
        className,
      )}
    >
      <GraphMark className="h-8 w-auto text-border-strong" />
      <h3 className="mt-5 font-display text-lg font-bold text-text">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-text-dim">{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
