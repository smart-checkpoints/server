"use client";

import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import GraphLegend from "@/components/console/GraphLegend";
import type { GraphCanvasHandle } from "@/components/console/GraphCanvas";
import { cn } from "@/lib/cn";
import { pluralise } from "@/lib/format";
import { Dot, Menu, type Tone } from "./parts";

type StatusBarProps = {
  canvas: RefObject<GraphCanvasHandle | null>;
  cameras: number;
  sections: number;
  /** Sections whose distance is not resolved, so they enforce nothing. */
  unmeasured: number;
  violationsThisWeek: number;
  /** Graph controls only make sense on the graph. */
  graph: boolean;
  basemap: boolean;
  onBasemap: (on: boolean) => void;
  hints: boolean;
};

/** A distance that reads cleanly on a scale bar: 1, 2 or 5 times a power of ten. */
function niceMetres(target: number): number {
  const power = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2, 5, 10]) if (power * step >= target) return power * step;
  return power * 10;
}

const BAR_PX = 64;

/**
 * The bottom bar: what the network is, whether it enforces, and the graph's
 * own controls (scale, zoom, fit, legend, basemap).
 */
export default function StatusBar({ canvas, cameras, sections, unmeasured, violationsThisWeek, graph, basemap, onBasemap, hints }: StatusBarProps) {
  const [legend, setLegend] = useState(false);
  const closeLegend = useCallback(() => setLegend(false), []);
  const [scale, setScale] = useState<{ metres: number; px: number } | null>(null);

  // The scale bar follows every repaint of the canvas.
  useEffect(() => {
    const handle = canvas.current;
    if (!handle || !graph) return;
    const update = () => {
      const mpp = handle.metresPerPixel();
      if (!Number.isFinite(mpp) || mpp <= 0) return;
      const metres = niceMetres(mpp * BAR_PX);
      const px = Math.round(metres / mpp);
      setScale((current) => (current && current.metres === metres && current.px === px ? current : { metres, px }));
    };
    update();
    return handle.subscribe(update);
  }, [canvas, graph]);

  const tone: Tone = sections === 0 ? "off" : unmeasured === 0 ? "ok" : "warn";
  const measured =
    sections === 0 ? "No sections" : unmeasured === 0 ? `All ${pluralise(sections, "section")} measured` : `${unmeasured} of ${pluralise(sections, "section")} not measured`;

  return (
    <footer
      data-cursor-avoid
      className="relative z-40 flex h-8 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 font-mono text-[0.6875rem] text-text-dim"
    >
      <span className="whitespace-nowrap">
        {pluralise(cameras, "camera")} · {pluralise(sections, "section")}
      </span>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <Dot tone={tone} />
        {measured}
      </span>
      <Bar />
      <span className="whitespace-nowrap">{pluralise(violationsThisWeek, "violation")} this week</span>

      <span className="flex-1" />

      {graph && hints ? (
        <span className="hidden truncate 2xl:inline">Drag between cameras to link · Shift-drag to move · Right-click to add · F to fit · Esc to close</span>
      ) : null}

      {graph ? (
        <>
          <Bar />
          <BarButton label="Basemap" pressed={basemap} onClick={() => onBasemap(!basemap)}>
            Basemap
          </BarButton>
          <div className="relative">
            <BarButton label="Legend" pressed={legend} onClick={() => setLegend((open) => !open)}>
              Legend
            </BarButton>
            {legend ? (
              <Menu onClose={closeLegend} className="bottom-full right-0 mb-2 w-60 p-1 font-sans">
                <GraphLegend className="p-3" />
              </Menu>
            ) : null}
          </div>
          <Bar />
          {scale ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap" title="Scale">
              <span className="inline-block h-1.5 border-x border-b border-text-dim" style={{ width: scale.px }} aria-hidden="true" />
              {scale.metres >= 1000 ? `${scale.metres / 1000} km` : `${scale.metres} m`}
            </span>
          ) : null}
          <div className="flex items-center gap-0.5">
            <BarButton label="Zoom out (−)" onClick={() => canvas.current?.zoomBy(1 / 1.2)}>
              −
            </BarButton>
            <BarButton label="Zoom in (+)" onClick={() => canvas.current?.zoomBy(1.2)}>
              +
            </BarButton>
            <BarButton label="Fit the network (F)" onClick={() => canvas.current?.fit()} target="frame">
              Fit
            </BarButton>
          </div>
        </>
      ) : null}
    </footer>
  );
}

function Bar() {
  return <span className="h-3 w-px shrink-0 bg-border-strong" aria-hidden="true" />;
}

function BarButton({
  label,
  pressed,
  onClick,
  children,
  target,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
  target?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-agent-target={target}
      onClick={onClick}
      className={cn(
        "rounded px-1.5 py-0.5 transition-colors duration-150 hover:bg-surface-hover hover:text-text",
        pressed && "bg-cyan-glow text-cyan-dark",
      )}
    >
      {children}
    </button>
  );
}
