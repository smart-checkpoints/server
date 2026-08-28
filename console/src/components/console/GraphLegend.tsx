/**
 * What the colours on the canvas mean.
 *
 * The accent draws structure; the three status colours mean something is
 * measured or something is wrong. Saying so once, on the canvas, is cheaper
 * than an operator guessing.
 */
const entries = [
  {
    swatch: "bg-cyan-dark/55",
    label: "Enforced edge",
    detail: "Distance resolved, limit set",
  },
  {
    swatch: "bg-yellow",
    label: "No distance",
    detail: "Cannot enforce until resolved",
  },
  {
    swatch: "bg-green",
    label: "Free flowing",
    detail: "Live congestion at or under expected",
  },
  {
    swatch: "bg-red",
    label: "Congested",
    detail: "Twice the expected travel time",
  },
];

export default function GraphLegend() {
  return (
    <div className="pointer-events-auto w-56 rounded-2xl border border-border bg-surface p-4 shadow-md">
      <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
        Legend
      </p>
      <ul className="mt-3 space-y-2.5">
        {entries.map((entry) => (
          <li key={entry.label} className="flex items-start gap-2.5">
            <span
              aria-hidden="true"
              className={`mt-1 h-2 w-4 shrink-0 rounded-full ${entry.swatch}`}
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-text">
                {entry.label}
              </span>
              <span className="block text-[0.6875rem] text-text-dim">
                {entry.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
