"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoLockup } from "@/components/LogoMark";
import Container from "@/components/ui/Container";
import { cn } from "@/lib/cn";
import { navLinks, site } from "@/lib/site";

type NavProps = {
  /** Sits beside the lockup: which project is open, and how it is doing. */
  context?: ReactNode;
  /** The one action this page offers, on the right of the links. */
  action?: ReactNode;
  /** The graph console owns the full viewport, so its header does not scroll. */
  sticky?: boolean;
};

/**
 * The console header, built to the same specification as the one on
 * smartcheckpoints.xyz: 4rem tall, hairline bottom border, translucent surface
 * over a blur, links that only change colour.
 */
export default function Nav({ context, action, sticky = true }: NavProps) {
  const pathname = usePathname();
  // `trailingSlash` is on, so the live path is "/admin/" while the link is
  // written "/admin". Compare them without it.
  const here = pathname.replace(/\/+$/, "") || "/";

  return (
    <header
      className={cn(
        "z-50 border-b border-border bg-surface/80 backdrop-blur-md",
        sticky && "sticky top-0",
      )}
    >
      <Container className="flex h-16 items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/" aria-label={`${site.name} console, all projects`}>
            <LogoLockup className="h-9 w-auto shrink-0" />
          </Link>
          {context ? (
            <div className="hidden min-w-0 items-center gap-3 border-l border-border pl-4 sm:flex">
              {context}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <nav className="hidden items-center gap-1 md:flex">
            {navLinks.map((link) => {
              const isActive = !link.external && here === link.href;
              const className = cn(
                "rounded-full px-4 py-2 text-sm font-medium transition-colors duration-200",
                "hover:bg-surface-hover hover:text-cyan-dark",
                isActive ? "text-cyan-dark" : "text-text-dim",
              );

              // Console pages route client side; everything else leaves.
              return link.external ? (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className={className}
                >
                  {link.label}
                </a>
              ) : (
                <Link key={link.label} href={link.href} className={className}>
                  {link.label}
                </Link>
              );
            })}
          </nav>
          {action}
        </div>
      </Container>
    </header>
  );
}
