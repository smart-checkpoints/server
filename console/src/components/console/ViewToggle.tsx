"use client";

import { cn } from "@/lib/cn";

export type ConsoleView = "graph" | "map";

type ViewToggleProps = {
  view: ConsoleView;
  onChange: (view: ConsoleView) => void;
  /** False when no approved map driver is attached. The graph never is. */
  mapAvailable: boolean;
  /** Why the map is not on offer, for the operator who wonders. */
  mapUnavailableReason: string;
};

const tab =
  "rounded-full px-3.5 py-1.5 font-mono text-xs transition-colors duration-200 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Graph or map.
 *
 * Both views draw the same geometry - the graph as straight lines on a blank
 * background, the map as the road shapes a driver measured, on a basemap - and
 * that is what makes the toggle worth having. A checkpoint that looks fine on
 * the graph and sits inside a building on the map has told you something no
 * amount of looking at either one alone would.
 *
 * The graph is never unavailable. It is core-owned, needs no driver, and is
 * where editing lives; the map is the one that can disappear.
 */
export default function ViewToggle({
  view,
  onChange,
  mapAvailable,
  mapUnavailableReason,
}: ViewToggleProps) {
  return (
    <div
      role="group"
      aria-label="View"
      className="flex items-center gap-1 rounded-full border border-border bg-surface p-1 shadow-sm"
    >
      <button
        type="button"
        onClick={() => onChange("graph")}
        aria-pressed={view === "graph"}
        className={cn(
          tab,
          view === "graph"
            ? "bg-bg-subtle text-text"
            : "text-text-dim hover:text-text",
        )}
      >
        Graph
      </button>
      <button
        type="button"
        onClick={() => onChange("map")}
        disabled={!mapAvailable}
        aria-pressed={view === "map"}
        title={mapAvailable ? undefined : mapUnavailableReason}
        className={cn(
          tab,
          view === "map" ? "bg-bg-subtle text-text" : "text-text-dim hover:text-text",
        )}
      >
        Map
      </button>
    </div>
  );
}
