"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Panel from "@/components/ui/Panel";
import type { CameraPlace, CheckpointNode, Connection } from "@/lib/api";
import { isEnforced } from "@/lib/api";
import { formatDistance, pluralise } from "@/lib/format";
import { isValidLatLng } from "@/lib/geo";
import { cameraStatus, coordinates, placeOf, sectionLabel, sectionStatus, streetOf, type CameraOf, type SectionCounts } from "./model";
import { ConfirmCard, Dot, IconButton, Icons, Row, SectionLabel } from "./parts";

export type Selection = { kind: "camera"; nodeId: number } | { kind: "section"; connectionId: number };

type InspectorProps = {
  selection: Selection | null;
  onClose: () => void;
  onSelect: (selection: Selection) => void;
  nodes: CheckpointNode[];
  connections: Connection[];
  places: Record<string, CameraPlace>;
  counts: Map<number, SectionCounts>;
  warnings: Record<number, string>;
  cameraOf: CameraOf;
  driverConnected: boolean;
  /** Proposes a move; the move dialog confirms it, as a drag would. */
  onMove: (node: CheckpointNode, to: { lat: number; lng: number }) => void;
  onRemoveCamera: (node: CheckpointNode) => Promise<void>;
  onRemoveSection: (edge: Connection) => Promise<void>;
  onSaveSection: (edge: Connection, change: { distanceMeters?: number; speedLimitKmh: number }) => void;
};

/**
 * The selected camera or section: what it is, and the few things that can be
 * done to it. Anything that removes, or that changes a limit with violations
 * already recorded against it, is confirmed first, in the words Sayes uses.
 */
export default function Inspector(props: InspectorProps) {
  const { selection, onClose, nodes, connections } = props;
  const node = selection?.kind === "camera" ? nodes.find((n) => n.node_id === selection.nodeId) : undefined;
  const edge = selection?.kind === "section" ? connections.find((c) => c.connection_id === selection.connectionId) : undefined;
  const open = Boolean(node || edge);
  const title = node ? `Camera ${node.id_in_project}` : edge ? `Section ${sectionLabel(edge, props.cameraOf)}` : "";

  return (
    <Panel
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <IconButton label="Back" onClick={onClose} tip="below">
          {Icons.back}
        </IconButton>
      }
    >
      {node ? <CameraBody key={`camera-${node.node_id}`} node={node} {...props} /> : null}
      {edge ? <SectionBody key={`section-${edge.connection_id}`} edge={edge} {...props} /> : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------------
   A camera
   ------------------------------------------------------------------------- */

function CameraBody({
  node,
  connections,
  places,
  counts,
  warnings,
  cameraOf,
  onSelect,
  onMove,
  onRemoveCamera,
  onClose,
}: InspectorProps & { node: CheckpointNode }) {
  const [mode, setMode] = useState<"idle" | "move" | "remove">("idle");
  const [lat, setLat] = useState(() => node.latitude.toFixed(6));
  const [lng, setLng] = useState(() => node.longitude.toFixed(6));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const place = placeOf(places, node);
  const touching = connections.filter((edge) => edge.from_node_id === node.node_id || edge.to_node_id === node.node_id);
  const records = touching.reduce((n, edge) => n + (counts.get(edge.connection_id)?.all ?? 0), 0);
  const status = cameraStatus(node, connections, warnings[node.node_id]);

  const reviewMove = () => {
    const to = { lat: Number.parseFloat(lat), lng: Number.parseFloat(lng) };
    if (!isValidLatLng(to.lat, to.lng)) {
      setError("A latitude and longitude in decimal degrees are required.");
      return;
    }
    setError(null);
    onMove(node, to);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRemoveCamera(node);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The camera could not be removed.");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 px-5 py-4 text-sm">
      <section>
        <p className="font-display text-base font-bold text-text">{place?.street ?? "Street not known yet"}</p>
        {place?.near ? <p className="text-text-dim">Near {place.near}</p> : null}
      </section>

      <section>
        <Row k="Status">
          <Dot tone={status.tone} />
          {status.label}
        </Row>
        <Row k="Position" mono>
          {coordinates(node, 6)}
        </Row>
        <Row k="Sections" mono>
          {touching.length === 0 ? (
            <span className="font-sans text-sm">None</span>
          ) : (
            <span className="flex flex-wrap justify-end gap-1">
              {touching.map((edge) => (
                <button
                  key={edge.connection_id}
                  type="button"
                  onClick={() => onSelect({ kind: "section", connectionId: edge.connection_id })}
                  className="rounded-md px-1 text-cyan-dark hover:bg-cyan-glow"
                >
                  {sectionLabel(edge, cameraOf)}
                </button>
              ))}
            </span>
          )}
        </Row>
        <Row k="Violations">{`${records} on record`}</Row>
      </section>

      {mode === "move" ? (
        <section className="rounded-xl border border-border p-4">
          <SectionLabel>Move to</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" className="field py-2 font-mono text-xs" />
            <input aria-label="Longitude" value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" className="field py-2 font-mono text-xs" />
          </div>
          <p className="mt-2 text-xs text-text-dim">Or Shift-drag the camera on the canvas.</p>
          {error ? <p className="mt-2 text-xs text-red">{error}</p> : null}
          <div className="mt-3 flex gap-2">
            <Button size="xs" onClick={reviewMove}>
              Review move
            </Button>
            <Button size="xs" variant="secondary" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </section>
      ) : mode === "remove" ? (
        <ConfirmCard
          title={`Camera ${node.id_in_project}${touching.length ? ` and ${pluralise(touching.length, "section")}` : ""} will be removed.`}
          detail={records > 0 ? `${pluralise(records, "violation")} stay on record.` : "No violations are linked to them."}
          confirmLabel="Remove"
          busy={busy}
          error={error}
          onConfirm={() => void remove()}
          onCancel={() => setMode("idle")}
        />
      ) : (
        <section className="flex gap-2">
          <Button size="xs" variant="secondary" onClick={() => setMode("move")} data-agent-target="inspector-move">
            Move…
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setMode("remove")} data-agent-target="inspector-remove">
            Remove…
          </Button>
        </section>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   A section
   ------------------------------------------------------------------------- */

function SectionBody({
  edge,
  nodes,
  places,
  counts,
  cameraOf,
  driverConnected,
  onSelect,
  onRemoveSection,
  onSaveSection,
  onClose,
}: InspectorProps & { edge: Connection }) {
  const [limit, setLimit] = useState(() => String(edge.speed_limit || ""));
  const [distance, setDistance] = useState(() => (edge.distance ? String(Math.round(edge.distance)) : ""));
  const [confirm, setConfirm] = useState<"limit" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = nodes.find((n) => n.node_id === edge.from_node_id);
  const to = nodes.find((n) => n.node_id === edge.to_node_id);
  const status = sectionStatus(edge);
  const count = counts.get(edge.connection_id) ?? { week: 0, all: 0 };

  const limitValue = Number.parseFloat(limit);
  const distanceValue = Number.parseFloat(distance);
  const limitChanged = Number.isFinite(limitValue) && limitValue !== edge.speed_limit;
  const distanceChanged = !driverConnected && Number.isFinite(distanceValue) && distanceValue !== Math.round(edge.distance ?? 0);

  const change = (): { distanceMeters?: number; speedLimitKmh: number } | null => {
    if (!Number.isFinite(limitValue) || limitValue <= 0) {
      setError("A speed limit above zero is required.");
      return null;
    }
    // With a driver attached the distance is the driver's, so it is not sent.
    if (driverConnected) return { speedLimitKmh: limitValue };
    if (!Number.isFinite(distanceValue) || distanceValue <= 0) {
      setError("A distance in metres above zero is required.");
      return null;
    }
    return { distanceMeters: distanceValue, speedLimitKmh: limitValue };
  };

  const save = () => {
    const next = change();
    if (!next) return;
    setError(null);
    if (limitChanged && count.all > 0 && confirm !== "limit") {
      setConfirm("limit");
      return;
    }
    setConfirm(null);
    onSaveSection(edge, next);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRemoveSection(edge);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The section could not be removed.");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 px-5 py-4 text-sm">
      <section>
        <p className="font-display text-base font-bold text-text">{from ? streetOf(places, from) : "Section"}</p>
        <p className="text-text-dim">
          From{" "}
          <button type="button" className="text-cyan-dark hover:underline" onClick={() => from && onSelect({ kind: "camera", nodeId: from.node_id })}>
            camera {cameraOf(edge.from_node_id)}
          </button>{" "}
          to{" "}
          <button type="button" className="text-cyan-dark hover:underline" onClick={() => to && onSelect({ kind: "camera", nodeId: to.node_id })}>
            camera {cameraOf(edge.to_node_id)}
          </button>
          , one way
        </p>
      </section>

      <section>
        <Row k="Status">
          <Dot tone={status.tone} />
          {status.label}
        </Row>
        {driverConnected ? (
          <Row k="Road distance" mono>
            {isEnforced(edge) ? formatDistance(edge.distance) : "Not resolved"}
          </Row>
        ) : null}
        <Row k="Violations">{`${count.week} this week · ${count.all} in all`}</Row>
      </section>

      <section>
        <div className={driverConnected ? "" : "grid grid-cols-2 gap-3"}>
          {!driverConnected ? (
            <label className="block">
              <SectionLabel>Distance</SectionLabel>
              <span className="flex items-center gap-2">
                <input
                  aria-label="Distance in metres"
                  value={distance}
                  onChange={(e) => {
                    setDistance(e.target.value);
                    setError(null);
                  }}
                  inputMode="decimal"
                  className="field w-full py-2 font-mono text-sm"
                />
                <span className="text-text-dim">m</span>
              </span>
            </label>
          ) : null}
          <label className="block">
            <SectionLabel>Speed limit</SectionLabel>
            <span className="flex items-center gap-2">
              <input
                aria-label="Speed limit in km/h"
                data-agent-target="inspector-limit"
                value={limit}
                onChange={(e) => {
                  setLimit(e.target.value);
                  setError(null);
                  setConfirm(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
                inputMode="numeric"
                className={driverConnected ? "field w-24 py-2 font-mono text-sm" : "field w-full py-2 font-mono text-sm"}
              />
              <span className="text-text-dim">km/h</span>
            </span>
          </label>
        </div>
        <p className="mt-2 text-xs text-text-dim">
          {driverConnected ? "Enforced as an average across the section. The distance driver measures the road." : "No distance driver: the distance is the one typed here."}
        </p>
        {error && confirm !== "remove" ? <p className="mt-2 text-xs text-red">{error}</p> : null}
        {confirm === "limit" ? (
          <div className="mt-3">
            <ConfirmCard
              title={`Change the limit from ${edge.speed_limit} to ${limitValue} km/h on an edge with ${pluralise(count.all, "recorded violation")}?`}
              detail="Recorded violations are not changed. Only cars measured after the change are judged against the new limit."
              confirmLabel="Change limit"
              onConfirm={save}
              onCancel={() => setConfirm(null)}
            />
          </div>
        ) : (
          <div className="mt-3 flex justify-end">
            <Button size="xs" onClick={save} disabled={!limitChanged && !distanceChanged} data-agent-target="inspector-save">
              Save
            </Button>
          </div>
        )}
      </section>

      {confirm === "remove" ? (
        <ConfirmCard
          title={`The section ${sectionLabel(edge, cameraOf)} will be removed.`}
          detail={count.all > 0 ? `${pluralise(count.all, "violation")} stay on record.` : "No violations are linked to it."}
          confirmLabel="Remove"
          busy={busy}
          error={error}
          onConfirm={() => void remove()}
          onCancel={() => setConfirm(null)}
        />
      ) : (
        <section className="flex gap-2 border-t border-border pt-4">
          <Button size="xs" variant="ghost" onClick={() => setConfirm("remove")} data-agent-target="inspector-remove">
            Remove…
          </Button>
        </section>
      )}
    </div>
  );
}
