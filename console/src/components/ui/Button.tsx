import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

/* Pill shape, generous horizontal padding, semibold. The look and the hover
   mechanics live in the components layer of globals.css; sizing stays here.
   No gap: the arrow supplies its own margin as it opens. */
const base =
  "btn inline-flex items-center justify-center rounded-full font-semibold " +
  "select-none disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
};

const sizes: Record<ButtonSize, string> = {
  sm: "px-5 py-2 text-sm",
  md: "px-6 py-2.5 text-sm",
  lg: "px-8 py-3 text-base",
};

type SharedProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Reveals an arrow on hover and focus. That is the entire hover state. */
  arrow?: boolean;
  className?: string;
  children: ReactNode;
};

function Arrow() {
  return (
    <span className="btn-arrow" aria-hidden="true">
      &#8594;
    </span>
  );
}

type ButtonAsLink = SharedProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children"> & {
    href: string;
  };

type ButtonAsButton = SharedProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
    href?: undefined;
  };

export type ButtonProps = ButtonAsLink | ButtonAsButton;

/** Renders an anchor when given `href`, a button otherwise. */
export default function Button({
  variant = "primary",
  size = "md",
  arrow = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = cn(base, variants[variant], sizes[size], className);

  if ("href" in rest && rest.href !== undefined) {
    const { href, ...anchorProps } = rest as ButtonAsLink;
    return (
      <a href={href} className={classes} {...anchorProps}>
        {children}
        {arrow ? <Arrow /> : null}
      </a>
    );
  }

  const buttonProps = rest as ButtonAsButton;
  return (
    <button className={classes} {...buttonProps}>
      {children}
      {arrow ? <Arrow /> : null}
    </button>
  );
}
