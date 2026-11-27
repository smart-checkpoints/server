"use client";

import { createContext, useContext, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { ease } from "@/lib/motion";

type PanelProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: "left" | "right";
  children: ReactNode;
  /** Sits at the bottom of the panel, outside the scrolling body. */
  footer?: ReactNode;
  className?: string;
  /**
   * The console's drawer: full height beside the rail, square, over the
   * canvas. Only one is open at a time, so it swaps rather than slides.
   */
  docked?: boolean;
  /** Extra controls in the header, before the close button. */
  actions?: ReactNode;
};

/**
 * Panels inside this provider are the console drawer beside the rail, unless
 * a panel says otherwise.
 */
export const PanelDock = createContext(false);

/**
 * A drawer over the graph.
 *
 * It slides in from the edge it is anchored to and never covers the whole
 * canvas: the operator keeps watching the graph while reading what came off
 * it. Unlike a modal it takes no focus and blocks nothing: the graph stays
 * live and clickable underneath.
 */
export default function Panel({
  open,
  onClose,
  title,
  side = "right",
  children,
  footer,
  className,
  docked: dockedProp,
  actions,
}: PanelProps) {
  const inDock = useContext(PanelDock);
  const docked = dockedProp ?? inDock;
  const reduceMotion = useReducedMotion();
  const offset = docked ? -10 : side === "right" ? 24 : -24;

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          aria-label={title}
          // The agent's cursors do not park under an open panel.
          data-cursor-avoid
          initial={reduceMotion ? false : { opacity: 0, x: offset }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: offset }}
          transition={{ duration: docked ? 0.18 : 0.28, ease }}
          className={cn(
            docked
              ? "pointer-events-auto absolute inset-y-0 left-0 z-30 flex w-[360px] flex-col border-r border-border bg-surface shadow-lg"
              : cn(
                  "pointer-events-auto absolute top-4 bottom-4 z-30 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col",
                  "overflow-hidden rounded-2xl border border-border bg-surface shadow-lg",
                  side === "right" ? "sayes-clear" : "left-4",
                ),
            className,
          )}
          // A right-hand panel sits beside Sayes's floating panel, not under it.
          style={!docked && side === "right" ? { right: "calc(1rem + var(--sayes-inset, 0px))" } : undefined}
        >
          <header className={cn("flex items-center gap-2 border-b border-border", docked ? "h-14 px-4" : "justify-between gap-4 px-5 py-4")}>
            <h2 className={cn("font-display text-base font-bold text-text", docked && "min-w-0 flex-1 truncate")}>{title}</h2>
            {actions}
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title.toLowerCase()}`}
              title="Close · Esc"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-dim transition-colors duration-200 hover:bg-surface-hover hover:text-text"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path
                  d="M6 6 L18 18 M18 6 L6 18"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

          {footer ? (
            <div className="border-t border-border px-5 py-4">{footer}</div>
          ) : null}
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
