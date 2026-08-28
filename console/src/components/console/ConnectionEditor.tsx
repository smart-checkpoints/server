"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import type { CheckpointNode, Connection } from "@/lib/api";
import { formatDistance } from "@/lib/format";

type ConnectionEditorProps = {
  connection: Connection | null;
  nodes: CheckpointNode[];
  driverConnected: boolean;
  onCancel: () => void;
  onSave: (edge: { distanceMeters: number; speedLimitKmh: number }) => void;
};

/**
 * A stored number as text for its field. Zero means "not set yet" for both
 * distance and speed limit, because an edge with either at zero enforces
 * nothing, so it shows as an empty field rather than as a value someone chose.
 */
function fieldValue(value: number | undefined): string {
  return value ? String(value) : "";
}

/**
 * The edge inspector: what an edge is, and the two numbers enforcement runs on.
 *
 * Distance is read-only while a driver is attached. The driver resolves it from
 * real road routing and the server overwrites anything typed here the next time
 * that driver reconnects, so offering the field would be offering a lie.
 */
export default function ConnectionEditor({
  connection,
  nodes,
  driverConnected,
  onCancel,
  onSave,
}: ConnectionEditorProps) {
  /* The editor is mounted with an edge already selected, so the fields are
     seeded from it rather than starting empty and waiting for a change. */
  const [distance, setDistance] = useState(() => fieldValue(connection?.distance));
  const [speedLimit, setSpeedLimit] = useState(() =>
    fieldValue(connection?.speed_limit),
  );
  const [error, setError] = useState<string | null>(null);

  /* Selecting a different edge without closing the editor loads that edge. */
  const [lastConnection, setLastConnection] = useState(connection);
  if (connection !== lastConnection) {
    setLastConnection(connection);
    setDistance(fieldValue(connection?.distance));
    setSpeedLimit(fieldValue(connection?.speed_limit));
    setError(null);
  }

  if (!connection) return null;

  const from = nodes.find((node) => node.node_id === connection.from_node_id);
  const to = nodes.find((node) => node.node_id === connection.to_node_id);

  function save() {
    if (!connection) return;

    const speedValue = Number.parseFloat(speedLimit);
    if (!Number.isFinite(speedValue) || speedValue <= 0) {
      setError("A speed limit above zero is required.");
      return;
    }

    const distanceValue = driverConnected
      ? connection.distance
      : Number.parseFloat(distance);
    if (!Number.isFinite(distanceValue) || distanceValue < 0) {
      setError("A distance in metres is required.");
      return;
    }

    onSave({ distanceMeters: distanceValue, speedLimitKmh: speedValue });
  }

  return (
    <div className="pointer-events-auto w-[20rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface p-5 shadow-lg">
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-cyan-dark">
        Edge
      </p>
      <h2 className="mt-2 font-display text-lg font-bold text-text">
        Checkpoint {from?.id_in_project ?? "?"} to {to?.id_in_project ?? "?"}
      </h2>

      <div className="mt-5 space-y-4">
        <Field
          label="Distance"
          mono
          type="number"
          min={0}
          step={0.1}
          inputMode="decimal"
          value={driverConnected ? String(connection.distance ?? 0) : distance}
          disabled={driverConnected}
          hint={
            driverConnected
              ? `Metres, resolved by the distance driver (${formatDistance(connection.distance)})`
              : "Metres of real driving distance between the two checkpoints"
          }
          onChange={(event) => {
            setDistance(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />

        <Field
          label="Speed limit"
          mono
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={speedLimit}
          hint="km/h enforced as an average across this edge"
          error={error}
          onChange={(event) => {
            setSpeedLimit(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" arrow onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
