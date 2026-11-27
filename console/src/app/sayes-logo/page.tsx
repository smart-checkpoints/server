import SayesMark, { SAYES_MARK_VARIANTS } from "@/components/console/agent/SayesMark";

export const metadata = { title: "Sayes mark · variants" };

const SIZES = [16, 24, 32, 48, 96];

/** A page for choosing the Sayes mark: every variant, at every size it is used at. */
export default function SayesLogoPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="font-display text-2xl font-bold text-text">Sayes mark</h1>
      <p className="mt-2 text-sm text-text-dim">
        A raised hand with two arcs for the wave. The console uses the first one; the others are here to compare.
      </p>
      <div className="mt-10 space-y-8">
        {SAYES_MARK_VARIANTS.map((variant) => (
          <section key={variant.id} className="rounded-2xl border border-border bg-surface p-6">
            <h2 className="font-display text-base font-bold text-text">{variant.name}</h2>
            <p className="mt-1 text-sm text-text-dim">{variant.note}</p>
            <div className="mt-6 flex flex-wrap items-end gap-8">
              {SIZES.map((size) => (
                <figure key={size} className="flex flex-col items-center gap-2">
                  <span
                    className="inline-flex items-center justify-center rounded-full bg-cyan text-surface"
                    style={{ width: size * 1.6, height: size * 1.6 }}
                  >
                    <SayesMark variant={variant.id} size={size} title={`${variant.name}, ${size} px`} />
                  </span>
                  <figcaption className="font-mono text-xs text-text-dim">{size}</figcaption>
                </figure>
              ))}
              {SIZES.slice(0, 3).map((size) => (
                <figure key={`plain-${size}`} className="flex flex-col items-center gap-2">
                  <span className="text-cyan-dark">
                    <SayesMark variant={variant.id} size={size} className="block" title={`${variant.name}, ${size} px, plain`} />
                  </span>
                  <figcaption className="font-mono text-xs text-text-dim">{size} plain</figcaption>
                </figure>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
