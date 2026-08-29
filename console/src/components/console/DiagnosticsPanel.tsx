"use client";

import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Panel from "@/components/ui/Panel";
import type {
  Diagnostics,
  DiagnosticsThresholds,
  EdgeDiagnostics,
  NodeDiagnostics,
} from "@/lib/api";
import { formatDistance, formatTime, pluralise } from "@/lib/format";

type DiagnosticsPanelProps = {
  open: boolean;
  onClose: () => void;
  diagnostics: Diagnostics | null;
  /** Epoch milliseconds of the last successful check, or null before one. */
  checkedAt: number | null;
  busy: boolean;
  error: string | null;
  onRecheck: () => void;
};

/** A ratio the operator reads, not one they difference: "3.1x". */
function ratio(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}x`;
}

/**
 * The one-line version, for the canvas tooltip and the row heading.
 *
 * Kept next to the long version so the two cannot drift apart into saying
 * different things about the same checkpoint.
 */
export function summariseNode(node: NodeDiagnostics): string {
  const parts: string[] = [];
  if (node.flags.includes("off-network")) {
    parts.push(`${formatDistance(node.endpoint_offset)} from the nearest road`);
  }
  if (node.flags.includes("suspect-position")) {
    parts.push(
      `${node.circuitous_edges} of ${node.evaluated_edges} roads ${ratio(
        node.typical_circuity,
      )} too long`,
    );
  }
  return parts.join(" · ");
}

/**
 * "all 4 of its connections", or "3 of its 4 connections", or - when some of
 * this checkpoint's edges were too short to judge - which 4 those were.
 */
function describeShare(node: NodeDiagnostics): string {
  const every = node.circuitous_edges === node.evaluated_edges;
  const judged = node.evaluated_edges === node.edge_count;
  if (every && judged) return `all ${node.evaluated_edges} of its connections`;
  if (every) {
    return `all ${node.evaluated_edges} of the connections long enough to judge`;
  }
  if (judged) {
    return `${node.circuitous_edges} of its ${node.evaluated_edges} connections`;
  }
  return `${node.circuitous_edges} of the ${node.evaluated_edges} connections long enough to judge`;
}

/**
 * Why this checkpoint is flagged, in the words an operator would use.
 *
 * Each sentence names the measurement and then what it usually means, in that
 * order: the operator can disagree with the conclusion and still have the
 * number. "Usually" is doing real work - a checkpoint on a genuine island of
 * one-way streets will read exactly like a bad fix, and only a person who
 * knows the junction can tell the two apart.
 */
function explainNode(node: NodeDiagnostics): string[] {
  const lines: string[] = [];

  if (node.flags.includes("off-network")) {
    lines.push(
      `The nearest road a driver could route from is ${formatDistance(
        node.endpoint_offset,
      )} away from where this checkpoint says it is. A camera is on a road, so this position is almost certainly wrong.`,
    );
  }

  if (node.flags.includes("suspect-position")) {
    lines.push(
      `This checkpoint's roads are ${ratio(
        node.typical_circuity,
      )} longer than the straight-line distance on ${describeShare(
        node,
      )}, which usually means its GPS position is wrong.`,
    );
  }

  return lines;
}

function explainEdge(edge: EdgeDiagnostics): string {
  return (
    `The road between these two checkpoints is ${formatDistance(
      edge.distance,
    )}, shorter than the ${formatDistance(
      edge.displacement,
    )} straight line between them. That is not a place; it is swapped coordinates, the wrong units, or a driver returning something it should not.`
  );
}

function Thresholds({ thresholds }: { thresholds: DiagnosticsThresholds }) {
  return (
    <p className="text-xs leading-relaxed text-text-dim">
      Flagged above {thresholds.circuity_flag}x on connections over{" "}
      {thresholds.min_displacement_m} m, when at least{" "}
      {Math.round(thresholds.node_flag_fraction * 100)}% of a checkpoint&rsquo;s{" "}
      {thresholds.node_min_edges} or more such connections are over it, or when
      a driver reports a coordinate more than {thresholds.endpoint_offset_flag_m}{" "}
      m from the nearest road. These are starting points, not tuned values.
    </p>
  );
}

/**
 * What is wrong with this project's data.
 *
 * A camera reports where it thinks it is and nothing downstream questions it,
 * so a bad GPS fix does not fail: it produces enforcement measured between the
 * wrong two points, and the violation that comes out looks exactly like a real
 * one. This panel is the only place that difference is visible.
 *
 * Checkpoints come first and edges second, deliberately. A single circuitous
 * edge is usually a river; a checkpoint whose edges are nearly all circuitous
 * is a camera in the wrong place, and it is the camera the operator can fix.
 */
export default function DiagnosticsPanel({
  open,
  onClose,
  diagnostics,
  checkedAt,
  busy,
  error,
  onRecheck,
}: DiagnosticsPanelProps) {
  const flaggedNodes = diagnostics
    ? diagnostics.nodes.filter((node) => node.flags.length > 0)
    : [];
  const impossibleEdges = diagnostics
    ? diagnostics.connections.filter((edge) => edge.flags.includes("impossible"))
    : [];
  const circuitousEdges = diagnostics
    ? diagnostics.connections.filter((edge) => edge.flags.includes("circuitous"))
    : [];

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Data quality"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-xs text-text-dim">
            {checkedAt === null ? "Not checked yet" : `Checked ${formatTime(checkedAt)}`}
          </span>
          <Button variant="secondary" size="sm" onClick={onRecheck} disabled={busy}>
            {busy ? "Checking" : "Recheck"}
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="px-5 py-4">
          <p className="text-sm text-red">{error}</p>
        </div>
      ) : null}

      {diagnostics === null ? (
        error ? null : (
          <p className="px-5 py-6 font-mono text-xs text-text-dim">Checking…</p>
        )
      ) : flaggedNodes.length === 0 && impossibleEdges.length === 0 ? (
        <EmptyState
          title="Nothing looks wrong"
          body={`${pluralise(
            diagnostics.nodes.length,
            "checkpoint",
          )} and ${pluralise(
            diagnostics.connections.length,
            "connection",
          )} checked. No checkpoint's roads are long enough, often enough, to suggest it is in the wrong place.`}
        />
      ) : (
        <div className="divide-y divide-border">
          {flaggedNodes.map((node) => (
            <article key={node.node_id} className="px-5 py-4">
              <header className="flex items-center justify-between gap-3">
                <h3 className="font-display text-sm font-bold text-text">
                  Checkpoint {node.id_in_project}
                </h3>
                <div className="flex shrink-0 gap-1.5">
                  {node.flags.map((flag) => (
                    <Badge key={flag} tone="yellow" mono className="px-2.5 py-1">
                      {flag === "off-network" ? "Off network" : "Suspect"}
                    </Badge>
                  ))}
                </div>
              </header>

              {explainNode(node).map((line) => (
                <p key={line} className="mt-2 text-sm leading-relaxed text-text-dim">
                  {line}
                </p>
              ))}

              <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-xs">
                <div>
                  <dt className="text-text-dim">Circuitous</dt>
                  <dd className="text-text">
                    {node.circuitous_edges}/{node.evaluated_edges}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-dim">Typical</dt>
                  <dd className="text-text">{ratio(node.typical_circuity)}</dd>
                </div>
                <div>
                  <dt className="text-text-dim">To road</dt>
                  <dd className="text-text">
                    {node.endpoint_offset === null
                      ? "-"
                      : formatDistance(node.endpoint_offset)}
                  </dd>
                </div>
              </dl>

              <p className="mt-2 font-mono text-[0.6875rem] text-text-dim">
                {node.latitude.toFixed(5)}, {node.longitude.toFixed(5)}
              </p>
            </article>
          ))}

          {impossibleEdges.map((edge) => (
            <article key={edge.connection_id} className="px-5 py-4">
              <header className="flex items-center justify-between gap-3">
                <h3 className="font-display text-sm font-bold text-text">
                  Checkpoint {edge.from_id_in_project} to {edge.to_id_in_project}
                </h3>
                <Badge tone="red" mono className="shrink-0 px-2.5 py-1">
                  Impossible
                </Badge>
              </header>
              <p className="mt-2 text-sm leading-relaxed text-text-dim">
                {explainEdge(edge)}
              </p>
              <p className="mt-2 font-mono text-xs text-text-dim">
                {ratio(edge.circuity)} · road {formatDistance(edge.distance)} ·
                straight {formatDistance(edge.displacement)}
              </p>
            </article>
          ))}
        </div>
      )}

      {diagnostics !== null &&
      circuitousEdges.length > 0 &&
      flaggedNodes.length === 0 ? (
        <p className="border-t border-border px-5 py-4 text-xs leading-relaxed text-text-dim">
          {pluralise(circuitousEdges.length, "connection")} took a long way
          round, but no checkpoint has enough of them to blame. That is normally
          real geography: a river with a distant bridge, a rail corridor, or a
          one-way system.
        </p>
      ) : null}

      {diagnostics !== null ? (
        <div className="border-t border-border px-5 py-4">
          <Thresholds thresholds={diagnostics.thresholds} />
          <p className="mt-2 text-xs leading-relaxed text-text-dim">
            Recomputed from the current positions every time this is opened.
            Nothing here is stored.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
