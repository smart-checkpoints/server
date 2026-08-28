"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";
import { ease } from "@/lib/motion";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the title saying what this dialog is about to do. */
  subtitle?: ReactNode;
  children: ReactNode;
  /** The buttons. Primary action last, the way the rest of the system reads. */
  footer?: ReactNode;
  className?: string;
};

/**
 * A dialog on the console's one card surface.
 *
 * The gesture is the site's: a short fade and rise on the same curve as every
 * other motion here, and nothing at all when the reader has asked for
 * stillness. Escape closes it, the backdrop closes it, and focus moves to the
 * first control inside so a keyboard never has to find it.
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    // The first field, or the first button if the dialog only confirms.
    const focusTarget = panelRef.current?.querySelector<HTMLElement>(
      "input:not([disabled]), textarea, select, button",
    );
    focusTarget?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-100 flex items-center justify-center p-6"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease }}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-text/25 backdrop-blur-[2px]"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={reduceMotion ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: 0.28, ease }}
            className={cn(
              "relative w-full max-w-md rounded-2xl border border-border bg-surface p-7 shadow-lg",
              className,
            )}
          >
            <h2 className="font-display text-2xl font-bold text-text">{title}</h2>
            {subtitle ? (
              <p className="mt-2 text-sm text-text-dim">{subtitle}</p>
            ) : null}

            <div className="mt-6 space-y-4">{children}</div>

            {footer ? (
              <div className="mt-7 flex items-center justify-end gap-3">{footer}</div>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
