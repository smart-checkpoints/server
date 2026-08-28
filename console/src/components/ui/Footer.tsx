import { LogoLockup } from "@/components/LogoMark";
import Container from "@/components/ui/Container";
import { footerColumns, site } from "@/lib/site";

const year = 2026;

/**
 * The same four-column footer the website signs off with, carrying the console's
 * own links. Only the pages that scroll get one: the graph console fills the
 * viewport and has no bottom to reach.
 */
export default function Footer() {
  return (
    <footer className="border-t border-border bg-surface">
      <Container className="py-16 lg:py-20">
        <div className="grid gap-14 lg:grid-cols-[1.2fr_2.8fr] lg:gap-20">
          <div>
            <LogoLockup className="h-10 w-auto" />
            <p className="mt-6 max-w-xs text-base text-text-dim">
              The operator console for a Smart Checkpoints deployment: the
              checkpoint graph, the edges under enforcement, and the violations
              coming off them.
            </p>
          </div>

          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {footerColumns.map((column) => (
              <div key={column.title}>
                <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-text">
                  {column.title}
                </h2>
                <ul className="mt-5 space-y-3.5">
                  {column.links.map((link) => (
                    <li key={`${column.title}-${link.label}`}>
                      <a
                        href={link.href}
                        target={link.external ? "_blank" : undefined}
                        rel={link.external ? "noreferrer" : undefined}
                        className="text-sm text-text-dim transition-colors duration-200 hover:text-cyan-dark"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-4 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-xs text-text-dim">
            &#169; {year} {site.copyrightHolder}
          </p>
          <p className="font-mono text-xs text-text-dim">
            Released under the {site.license} License
          </p>
        </div>
      </Container>
    </footer>
  );
}
