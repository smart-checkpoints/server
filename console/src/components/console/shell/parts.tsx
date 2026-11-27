"use client";

/*
 * The console shell's small parts: icon buttons, rail buttons, status chips,
 * menus and the confirmation card. Text buttons are the shared `Button`
 * (primary, secondary, ghost); everything with only an icon is `IconButton`.
 * Green, yellow and red mean status here and nothing else.
 */

import {
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import Button from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export type Tone = "ok" | "warn" | "bad" | "off";

export function Dot({ tone, title, className }: { tone: Tone; title?: string; className?: string }) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        tone === "ok" ? "bg-green" : tone === "warn" ? "bg-yellow" : tone === "bad" ? "bg-red" : "bg-border-strong",
        className,
      )}
    />
  );
}

/** An outlined chip with a status dot: who is attached, and whether it works. */
export function StatusChip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-text-dim"
    >
      <Dot tone={tone} />
      {children}
    </span>
  );
}

/** A tooltip that shows on hover and keyboard focus of its group. */
export function Tip({ children, side = "below" }: { children: ReactNode; side?: "below" | "right" | "above" }) {
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-[60] whitespace-nowrap rounded-lg bg-text px-2.5 py-1 text-xs font-medium text-surface opacity-0 shadow-md",
        "transition-opacity duration-150 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
        side === "below" && "right-0 top-full mt-1.5",
        side === "above" && "bottom-full right-0 mb-1.5",
        side === "right" && "left-full top-1/2 ml-2 -translate-y-1/2",
      )}
    >
      {children}
    </span>
  );
}

type IconButtonProps = {
  label: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  active?: boolean;
  tip?: "below" | "right" | "above" | false;
  className?: string;
  "data-agent-target"?: string;
};

/** 36 px, rounded, icon only; the label is its tooltip and its accessible name. */
export function IconButton({ label, onClick, children, active, tip = "below", className, ...rest }: IconButtonProps) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        data-agent-target={rest["data-agent-target"]}
        className={cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-150",
          active ? "bg-cyan-glow text-cyan-dark" : "text-text-dim hover:bg-surface-hover hover:text-text",
          className,
        )}
      >
        <svg viewBox="0 0 20 20" className="h-[1.1rem] w-[1.1rem]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {children}
        </svg>
      </button>
      {tip ? <Tip side={tip}>{label}</Tip> : null}
    </span>
  );
}

type RailButtonProps = {
  label: string;
  shortcut?: string;
  active: boolean;
  badge?: number;
  /** A count that means something is wrong, rather than just a count. */
  badgeTone?: "count" | "warn";
  onClick: () => void;
  children: ReactNode;
  "data-agent-target"?: string;
};

export function RailButton({ label, shortcut, active, badge, badgeTone = "count", onClick, children, ...rest }: RailButtonProps) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={badge ? `${label}, ${badge}` : label}
        aria-pressed={active}
        data-agent-target={rest["data-agent-target"]}
        className={cn(
          "relative inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors duration-150",
          active ? "bg-cyan-glow text-cyan-dark" : "text-text-dim hover:bg-surface-hover hover:text-text",
        )}
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {children}
        </svg>
        {badge ? (
          <span
            className={cn(
              "absolute -right-1 -top-1 min-w-[1.15rem] rounded-full px-1 text-center font-mono text-[0.625rem] font-semibold leading-[1.15rem]",
              badgeTone === "warn" ? "bg-yellow text-text" : "bg-text text-surface",
            )}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </button>
      <Tip side="right">
        {label}
        {shortcut ? <span className="ml-2 font-mono opacity-70">{shortcut}</span> : null}
      </Tip>
    </span>
  );
}

/** Two to four options, one chosen. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; disabled?: boolean; title?: string; target?: string }[];
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-lg border border-border bg-bg-subtle p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={option.disabled}
          title={option.title}
          data-agent-target={option.target}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded-md px-3 py-1 text-xs font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45",
            value === option.id ? "bg-surface text-text shadow-sm" : "text-text-dim hover:text-text",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Menus
   ------------------------------------------------------------------------- */

/** A floating menu. Closes on a click outside it; Esc is the page's. */
export function Menu({
  children,
  className,
  style,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    // Esc closes the menu before anything behind it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    // A tick later, so the click that opened the menu does not close it.
    const timer = setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      data-cursor-avoid
      className={cn("absolute z-50 min-w-[12rem] rounded-xl border border-border bg-surface py-1 shadow-lg", className)}
      style={style}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  href,
  active,
  hint,
  external,
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  active?: boolean;
  hint?: string;
  external?: boolean;
}) {
  const classes = cn(
    "flex w-full items-center gap-3 px-3.5 py-1.5 text-left text-sm text-text hover:bg-surface-hover",
    active && "font-semibold text-cyan-dark",
  );
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="font-mono text-[0.6875rem] text-text-dim">{hint}</span> : null}
    </>
  );
  if (href) {
    return (
      <a role="menuitem" href={href} onClick={onClick} className={classes} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {body}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" onClick={onClick} className={classes}>
      {body}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-3.5 pb-1 pt-1.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-text-dim">{children}</p>;
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-border" />;
}

/* -------------------------------------------------------------------------
   Drawer content
   ------------------------------------------------------------------------- */

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-text-dim">{children}</p>;
}

export function Row({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="shrink-0 text-text-dim">{k}</span>
      <span className={cn("flex min-w-0 items-center justify-end gap-1.5 text-right", mono && "font-mono text-xs leading-5")}>{children}</span>
    </div>
  );
}

export function CountBadge({ n }: { n: number }) {
  return (
    <span className={cn("inline-block min-w-[1.6rem] rounded-full px-1.5 text-center font-mono text-xs font-semibold", n ? "bg-bg-subtle text-text" : "text-text-dim")}>
      {n}
    </span>
  );
}

/**
 * The console's confirmation: what will happen, what will not, and two
 * buttons. The same wording Sayes uses on its cards.
 */
export function ConfirmCard({
  title,
  detail,
  confirmLabel = "Confirm",
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail?: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label={title} className="rounded-xl border border-cyan bg-surface p-4 shadow-md">
      <p className="font-display text-sm font-bold text-text">{title}</p>
      {detail ? <p className="mt-1 text-xs leading-relaxed text-text-dim">{detail}</p> : null}
      {error ? <p className="mt-2 text-xs text-red">{error}</p> : null}
      <div className="mt-3 flex gap-2">
        <Button size="xs" onClick={onConfirm} disabled={busy} data-agent-target="inspector-confirm">
          {busy ? "Working" : confirmLabel}
        </Button>
        <Button size="xs" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Icons (20 px grid, 1.6 stroke)
   ------------------------------------------------------------------------- */

export const Icons = {
  cameras: (
    <>
      <circle cx="10" cy="10" r="3" />
      <circle cx="10" cy="10" r="7" />
    </>
  ),
  sections: (
    <>
      <circle cx="4.5" cy="14.5" r="2" />
      <circle cx="15.5" cy="5.5" r="2" />
      <path d="M6 13l8-6" />
    </>
  ),
  violations: (
    <>
      <path d="M10 3.5 17 16H3Z" />
      <path d="M10 8.5v3.5M10 14.2v.1" />
    </>
  ),
  quality: (
    <>
      <path d="M10 3 16 5.5v4.2c0 3.6-2.5 6-6 7.3-3.5-1.3-6-3.7-6-7.3V5.5Z" />
      <path d="m7.3 10 1.9 1.9 3.6-3.8" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" />
    </>
  ),
  car: (
    <>
      <path d="M4 12.5 5.6 8a1.5 1.5 0 0 1 1.4-1h6a1.5 1.5 0 0 1 1.4 1l1.6 4.5" />
      <rect x="3" y="12" width="14" height="3.5" rx="1.2" />
      <path d="M6 15.5v1.3M14 15.5v1.3" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  back: <path d="M12 5 7 10l5 5" />,
  chevron: <path d="M6 8l4 4 4-4" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="m13 13 3.5 3.5" />
    </>
  ),
};

export function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("h-3.5 w-3.5 text-text-dim", className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  );
}
