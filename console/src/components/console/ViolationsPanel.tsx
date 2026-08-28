"use client";

import EmptyState from "@/components/ui/EmptyState";
import Panel from "@/components/ui/Panel";
import type { Violation } from "@/lib/api";
import { formatSpeed, formatTime, pluralise } from "@/lib/format";

type ViolationsPanelProps = {
  open: boolean;
  onClose: () => void;
  violations: Violation[];
  /** How many arrived while this session has been watching. */
  liveCount: number;
};

/**
 * Violations, newest first.
 *
 * A row is a car that averaged over the limit across a whole edge, not a car
 * that was briefly fast under one camera. The newest row announces itself once
 * in the status red and then settles, so a live arrival is noticed without the
 * table ever becoming a field of red.
 */
export default function ViolationsPanel({
  open,
  onClose,
  violations,
  liveCount,
}: ViolationsPanelProps) {
  return (
    <Panel open={open} onClose={onClose} title="Violations">
      {violations.length === 0 ? (
        <EmptyState
          title="Nothing recorded"
          body="A violation appears here when a plate is seen at two checkpoints and the average speed between them exceeds the edge's limit."
        />
      ) : (
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-border">
              <th className="px-5 py-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
                Time
              </th>
              <th className="px-2 py-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
                Plate
              </th>
              <th className="px-5 py-3 text-right font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
                Average
              </th>
            </tr>
          </thead>
          <tbody>
            {violations.map((violation, index) => (
              <tr
                key={violation.violation_id ?? `${violation.timestamp}-${index}`}
                className={
                  index < liveCount
                    ? "row-arrive border-b border-border last:border-0"
                    : "border-b border-border last:border-0"
                }
              >
                <td className="px-5 py-3 font-mono text-xs text-text-dim">
                  {formatTime(violation.timestamp)}
                </td>
                <td className="px-2 py-3 font-mono text-sm font-medium text-text">
                  {violation.car_plate}
                </td>
                <td className="px-5 py-3 text-right font-mono text-sm font-semibold text-red">
                  {formatSpeed(violation.car_speed)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {violations.length > 0 ? (
        <p className="px-5 py-4 font-mono text-xs text-text-dim">
          {pluralise(violations.length, "violation")} on this project
        </p>
      ) : null}
    </Panel>
  );
}
