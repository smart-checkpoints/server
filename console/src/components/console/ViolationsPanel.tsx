"use client";

import { useMemo, useState } from "react";
import EmptyState from "@/components/ui/EmptyState";
import Panel from "@/components/ui/Panel";
import type { Connection, Violation } from "@/lib/api";
import { formatSpeed, pluralise } from "@/lib/format";
import { sectionLabel, type CameraOf } from "./shell/model";
import { Segmented } from "./shell/parts";

type ViolationsPanelProps = {
  open: boolean;
  onClose: () => void;
  violations: Violation[];
  /** How many arrived while this session has been watching. */
  liveCount: number;
  connections: Connection[];
  cameraOf: CameraOf;
};

type Range = "24h" | "7d" | "30d" | "all";

const RANGE_MS: Record<Range, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
};

const RANGE_WORDS: Record<Range, string> = {
  "24h": "in the last 24 hours",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  all: "on this project",
};

/** "Today 06:44", "Yesterday 23:25", "26 Nov 03:48": a week of rows needs the day. */
function when(timestamp: string, now: number): string {
  const at = new Date(timestamp);
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(at)) / 86400000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

const HEAD = "py-2.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-text-dim";

/**
 * Violations, newest first, filtered by time and section.
 *
 * A row is a car that averaged over the limit across a whole edge, not a car
 * that was briefly fast under one camera. The newest row announces itself once
 * in the status red and then settles, so a live arrival is noticed without the
 * table ever becoming a field of red.
 */
export default function ViolationsPanel({ open, onClose, violations, liveCount, connections, cameraOf }: ViolationsPanelProps) {
  const [range, setRange] = useState<Range>("7d");
  const [section, setSection] = useState<string>("all");

  const byId = useMemo(() => new Map(connections.map((edge) => [edge.connection_id, edge])), [connections]);

  // Rendering is the clock here: the list is re-read whenever it changes.
  const [now] = useState(() => Date.now());
  const rows = useMemo(() => {
    const since = now - RANGE_MS[range];
    return violations
      .map((violation, index) => ({ violation, index }))
      .filter(({ violation }) => (range === "all" || new Date(violation.timestamp).getTime() >= since) && (section === "all" || String(violation.connection_id) === section))
      // Newest first by when the car was seen, not by when the row was written.
      .sort((a, b) => new Date(b.violation.timestamp).getTime() - new Date(a.violation.timestamp).getTime());
  }, [violations, range, section, now]);

  const label = (violation: Violation) => {
    const edge = violation.connection_id != null ? byId.get(violation.connection_id) : undefined;
    return edge ? sectionLabel(edge, cameraOf) : violation.connection_id != null ? "Retired" : "—";
  };

  return (
    <Panel open={open} onClose={onClose} title="Violations">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <Segmented<Range>
          label="Time range"
          value={range}
          onChange={setRange}
          options={[
            { id: "24h", label: "24 h" },
            { id: "7d", label: "7 days" },
            { id: "30d", label: "30 days" },
            { id: "all", label: "All" },
          ]}
        />
        <select value={section} onChange={(event) => setSection(event.target.value)} aria-label="Section" className="field py-1.5 text-sm">
          <option value="all">All sections</option>
          {connections.map((edge) => (
            <option key={edge.connection_id} value={String(edge.connection_id)}>
              {sectionLabel(edge, cameraOf)} · {edge.speed_limit} km/h
            </option>
          ))}
        </select>
      </div>

      {violations.length === 0 ? (
        <EmptyState
          title="Nothing recorded"
          body="A violation appears here when a plate is seen at two checkpoints and the average speed between them exceeds the edge's limit."
        />
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-text-dim">No violations {RANGE_WORDS[range]}{section === "all" ? "" : " on this section"}.</p>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-border">
              <th className={`pl-5 pr-2 ${HEAD}`}>Time</th>
              <th className={`px-2 ${HEAD}`}>Plate</th>
              <th className={`px-2 ${HEAD}`}>Edge</th>
              <th className={`pl-2 pr-5 text-right ${HEAD}`}>Average</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ violation, index }) => (
              <tr
                key={violation.violation_id ?? `${violation.timestamp}-${index}`}
                className={index < liveCount ? "row-arrive border-b border-border last:border-0" : "border-b border-border last:border-0"}
              >
                <td className="whitespace-nowrap py-2.5 pl-5 pr-2 text-xs text-text-dim">{when(violation.timestamp, now)}</td>
                <td className="px-2 py-2.5 font-mono text-sm font-medium text-text">{violation.car_plate}</td>
                <td className="px-2 py-2.5 font-mono text-xs text-cyan-dark">{label(violation)}</td>
                <td className="py-2.5 pl-2 pr-5 text-right font-mono text-sm font-semibold text-red">{formatSpeed(violation.car_speed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rows.length > 0 ? (
        <p className="px-5 py-4 font-mono text-xs text-text-dim">
          {pluralise(rows.length, "violation")} {RANGE_WORDS[range]} · newest first · live
        </p>
      ) : null}
    </Panel>
  );
}
