"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import type { CheckpointNode, Connection } from "@/lib/api";
import { isEnforced } from "@/lib/api";
import { formatDistance } from "@/lib/format";

type ConnectionEditorProps = {
  connection: Connection | null;
  nodes: CheckpointNode[];
  driverConnected: boolean;
  onCancel: () => void;
  onSave: (edge: { distanceMeters?: number; speedLimitKmh: number }) => void;
};

/**
 * A stored number as text for its field. Null, undefined and zero all show as
 * an empty field: an edge with either number at zero enforces nothing, and an
 * unresolved distance is not a number at all, so neither is offered back as a
 * value someone chose.
 */
function fieldValue(value: number | null | undefined): string {
  return value ? String(value) : "";
}

/**
 * The edge inspector: what an edge is, and the two numbers enforcement runs on.
 *
 * Distance is read-only while a driver is attached. The driver resolves it from
 * real road routing and the server overwrites anything typed here the next time
 * that driver reconnects, so offering the field would be offering a lie.
 *
 * An edge whose distance is unresolved shows an empty field and says why. It
 * used to show `0`, which was a number an operator could accept and save - and
 * saving it made the edge look configured while it went on enforcing nothing.
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
  const enforced = isEnforced(connection);

  const distanceHint = !driverConnected
    ? "Metres of real driving distance between the two checkpoints"
    : enforced
      ? `Metres, resolved by the distance driver (${formatDistance(connection.distance)})`
      : connection.distance_status === "no-route"
        ? "The driver found no road between these two checkpoints. Nothing is enforced here until that is corrected."
        : "Not resolved yet. The driver fills this in; nothing is enforced here until it does.";

  function save() {
    if (!connection) return;

    const speedValue = Number.parseFloat(speedLimit);
    if (!Number.isFinite(speedValue) || speedValue <= 0) {
      setError("A speed limit above zero is required.");
      return;
    }

    // With a driver attached the distance is not this panel's to send, so it
    // is left out and the server keeps what it has. That is what lets the
    // limit be edited on an edge the driver has not resolved, instead of
    // demanding a distance the operator has no way to supply.
    if (driverConnected) {
      onSave({ speedLimitKmh: speedValue });
      return;
    }

    const distanceValue = Number.parseFloat(distance);
    if (!Number.isFinite(distanceValue) || distanceValue <= 0) {
      setError("A distance in metres above zero is required.");
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
          value={
            driverConnected
              ? enforced
                ? String(connection.distance)
                : ""
              : distance
          }
          placeholder={driverConnected && !enforced ? "Not resolved" : undefined}
          disabled={driverConnected}
          hint={distanceHint}
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
