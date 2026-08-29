/**
 * What the colours on the canvas mean.
 *
 * The accent draws structure; the status colours mean something is measured or
 * something is wrong. Saying so once, on the canvas, is cheaper than an
 * operator guessing.
 *
 * The two unenforced states are listed separately because they are not the
 * same problem. One is waiting on a driver and will fix itself; the other is
 * an edge drawn where there is no road, and only a person can fix that. They
 * are also drawn with a broken stroke on the canvas, so the swatch is broken
 * here too - a legend that looks unlike the thing it explains is a puzzle.
 */
const entries = [
  {
    swatch: "bg-cyan-dark/55",
    label: "Enforced edge",
    detail: "Distance resolved, limit set",
  },
  {
    swatch: "bg-yellow",
    label: "No distance yet",
    detail: "Waiting on a distance driver. Nothing is enforced",
    broken: true,
  },
  {
    swatch: "bg-red",
    label: "No road found",
    detail: "A driver says these two are not connected",
    broken: true,
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
            {entry.broken ? (
              <span
                aria-hidden="true"
                className="mt-1 flex w-4 shrink-0 items-center gap-[2px]"
              >
                <span className={`h-2 w-[7px] rounded-full ${entry.swatch}`} />
                <span className={`h-2 w-[7px] rounded-full ${entry.swatch}`} />
              </span>
            ) : (
              <span
                aria-hidden="true"
                className={`mt-1 h-2 w-4 shrink-0 rounded-full ${entry.swatch}`}
              />
            )}
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
