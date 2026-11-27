"use client";

import { useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Panel from "@/components/ui/Panel";
import type { CameraPlace, CheckpointNode, Connection } from "@/lib/api";
import { formatDistance } from "@/lib/format";
import { cameraStatus, coordinates, placeOf, sectionLabel, sectionStatus, streetOf, type CameraOf, type SectionCounts } from "./model";
import { CountBadge, Dot } from "./parts";

/* -------------------------------------------------------------------------
   Cameras
   ------------------------------------------------------------------------- */

type CamerasDrawerProps = {
  open: boolean;
  onClose: () => void;
  nodes: CheckpointNode[];
  connections: Connection[];
  places: Record<string, CameraPlace>;
  warnings: Record<number, string>;
  onPick: (node: CheckpointNode) => void;
  onAdd: () => void;
};

export function CamerasDrawer({ open, onClose, nodes, connections, places, warnings, onPick, onAdd }: CamerasDrawerProps) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => [...nodes].sort((a, b) => a.id_in_project - b.id_in_project), [nodes]);
  const q = query.trim().toLowerCase();
  const list = q
    ? sorted.filter((node) => {
        const place = placeOf(places, node);
        return `${node.id_in_project} ${place?.street ?? ""} ${place?.near ?? ""} ${coordinates(node)}`.toLowerCase().includes(q);
      })
    : sorted;

  return (
    <Panel
      open={open}
      onClose={onClose}
      title="Cameras"
      actions={
        <Button size="xs" variant="secondary" onClick={onAdd} data-agent-target="add-camera">
          Add camera
        </Button>
      }
    >
      {nodes.length === 0 ? (
        <EmptyState
          title="No cameras yet"
          body="Cameras create checkpoints as they come online, over the REST API. You can also place one by coordinate, or right-click the canvas."
        />
      ) : (
        <>
          <div className="px-4 pt-3">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search number, street, landmark"
              aria-label="Search cameras"
              className="field py-2 text-sm"
            />
          </div>
          <ul className="px-2 py-2">
            {list.map((node) => {
              const place = placeOf(places, node);
              const status = cameraStatus(node, connections, warnings[node.node_id]);
              return (
                <li key={node.node_id}>
                  <button
                    type="button"
                    onClick={() => onPick(node)}
                    data-agent-target={`camera-row-${node.node_id}`}
                    className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-cyan font-mono text-xs font-semibold text-cyan-dark">
                      {node.id_in_project}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{place?.street ?? "Street not known yet"}</span>
                      <span className="block truncate text-xs text-text-dim">{place?.near ? `Near ${place.near}` : coordinates(node)}</span>
                    </span>
                    <Dot tone={status.tone} title={status.label} />
                  </button>
                </li>
              );
            })}
            {list.length === 0 ? <li className="px-3 py-4 text-sm text-text-dim">No camera matches “{query}”.</li> : null}
          </ul>
        </>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------
   Sections
   ------------------------------------------------------------------------- */

type SectionsDrawerProps = {
  open: boolean;
  onClose: () => void;
  nodes: CheckpointNode[];
  connections: Connection[];
  places: Record<string, CameraPlace>;
  counts: Map<number, SectionCounts>;
  cameraOf: CameraOf;
  onPick: (edge: Connection) => void;
};

const COLUMNS = "grid grid-cols-[3.75rem_1fr_3rem_3rem] gap-2";

export function SectionsDrawer({ open, onClose, nodes, connections, places, counts, cameraOf, onPick }: SectionsDrawerProps) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.node_id, node])), [nodes]);
  const sorted = useMemo(
    () =>
      [...connections].sort(
        (a, b) => (cameraOf(a.from_node_id) ?? 0) - (cameraOf(b.from_node_id) ?? 0) || (cameraOf(a.to_node_id) ?? 0) - (cameraOf(b.to_node_id) ?? 0),
      ),
    [connections, cameraOf],
  );

  return (
    <Panel open={open} onClose={onClose} title="Sections">
      {connections.length === 0 ? (
        <EmptyState title="No sections yet" body="A section is an enforced stretch of road from one camera to the next. Drag from one camera to another on the canvas to add one." />
      ) : (
        <>
          <div className={`${COLUMNS} px-5 pb-1 pt-3 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-text-dim`}>
            <span>Edge</span>
            <span>Distance · street</span>
            <span className="text-right">Limit</span>
            <span className="text-right" title="Violations in the last seven days">
              Week
            </span>
          </div>
          <ul className="px-2 pb-2">
            {sorted.map((edge) => {
              const from = byId.get(edge.from_node_id);
              const status = sectionStatus(edge);
              return (
                <li key={edge.connection_id}>
                  <button
                    type="button"
                    onClick={() => onPick(edge)}
                    data-agent-target={`section-row-${edge.connection_id}`}
                    className={`${COLUMNS} w-full items-center rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-surface-hover`}
                  >
                    <span className="font-mono text-sm font-semibold text-cyan-dark">{sectionLabel(edge, cameraOf)}</span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm text-text">
                        {status.tone !== "ok" ? <Dot tone={status.tone} title={status.label} /> : null}
                        {status.tone === "ok" ? formatDistance(edge.distance) : status.tone === "bad" ? "No road" : "Not measured"}
                      </span>
                      <span className="block truncate text-xs text-text-dim">{from ? streetOf(places, from) : ""}</span>
                    </span>
                    <span className="text-right font-mono text-sm text-text">{edge.speed_limit}</span>
                    <span className="text-right">
                      <CountBadge n={counts.get(edge.connection_id)?.week ?? 0} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="px-5 pb-4 font-mono text-[0.6875rem] text-text-dim">Limits in km/h · one way, in the direction of the arrow</p>
        </>
      )}
    </Panel>
  );
}
