"use client";

import type { ReactNode } from "react";

type CanvasControlsProps = {
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
};

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-10 w-10 items-center justify-center text-text-dim transition-colors duration-200 hover:bg-surface-hover hover:text-cyan-dark"
    >
      {children}
    </button>
  );
}

/**
 * Zoom and framing, for the operators who would rather press a button than
 * find the right wheel gesture. Everything here has a keyboard equivalent on
 * the page: plus, minus, and F to frame the graph.
 */
export default function CanvasControls({
  onFit,
  onZoomIn,
  onZoomOut,
}: CanvasControlsProps) {
  return (
    <div className="pointer-events-auto flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-md">
      <ControlButton label="Zoom in" onClick={onZoomIn}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </ControlButton>

      <ControlButton label="Zoom out" onClick={onZoomOut}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
          <path
            d="M5 12h14"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </ControlButton>

      <ControlButton label="Frame the graph" onClick={onFit}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
          <path
            d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </ControlButton>
    </div>
  );
}
