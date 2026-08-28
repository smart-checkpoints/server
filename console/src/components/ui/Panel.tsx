"use client";

import type { ReactNode } from "react";
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
};

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
}: PanelProps) {
  const reduceMotion = useReducedMotion();
  const offset = side === "right" ? 24 : -24;

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          aria-label={title}
          initial={reduceMotion ? false : { opacity: 0, x: offset }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: offset }}
          transition={{ duration: 0.28, ease }}
          className={cn(
            "pointer-events-auto absolute top-4 bottom-4 z-30 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col",
            "overflow-hidden rounded-2xl border border-border bg-surface shadow-lg",
            side === "right" ? "right-4" : "left-4",
            className,
          )}
        >
          <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
            <h2 className="font-display text-base font-bold text-text">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title.toLowerCase()}`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-dim transition-colors duration-200 hover:bg-surface-hover hover:text-cyan-dark"
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
