"use client";

import { useState } from "react";
import type { EdgeDraft } from "@/components/console/GraphCanvas";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import Modal from "@/components/ui/Modal";

type NewConnectionDialogProps = {
  draft: EdgeDraft | null;
  driverConnected: boolean;
  onClose: () => void;
  onCreate: (edge: { speedLimitKmh: number; distanceMeters?: number }) => void;
};

const DEFAULT_SPEED_LIMIT = "60";
const DEFAULT_DISTANCE = "100";

/**
 * Linking two checkpoints.
 *
 * Edges are directed: this creates the one from the checkpoint the drag
 * started at to the one it ended on. Driving the other way is a second edge,
 * with its own distance and its own limit, because the road usually is.
 */
export default function NewConnectionDialog({
  draft,
  driverConnected,
  onClose,
  onCreate,
}: NewConnectionDialogProps) {
  const [distance, setDistance] = useState(DEFAULT_DISTANCE);
  const [speedLimit, setSpeedLimit] = useState(DEFAULT_SPEED_LIMIT);
  const [error, setError] = useState<string | null>(null);

  /* A new pair of checkpoints is a new edge, so the form starts from its
     defaults rather than from whatever the last edge happened to be. */
  const [lastDraft, setLastDraft] = useState(draft);
  if (draft !== lastDraft) {
    setLastDraft(draft);
    setDistance(DEFAULT_DISTANCE);
    setSpeedLimit(DEFAULT_SPEED_LIMIT);
    setError(null);
  }

  function submit() {
    const speedValue = Number.parseFloat(speedLimit);
    if (!Number.isFinite(speedValue) || speedValue <= 0) {
      setError("A speed limit above zero is required.");
      return;
    }

    if (driverConnected) {
      // Omitting the distance is what tells the server to ask the driver.
      onCreate({ speedLimitKmh: speedValue });
      return;
    }

    const distanceValue = Number.parseFloat(distance);
    if (!Number.isFinite(distanceValue) || distanceValue <= 0) {
      setError("A distance in metres is required when no driver is attached.");
      return;
    }

    onCreate({ speedLimitKmh: speedValue, distanceMeters: distanceValue });
  }

  return (
    <Modal
      open={draft !== null}
      onClose={onClose}
      title="New edge"
      subtitle={
        draft ? (
          <>
            From checkpoint{" "}
            <span className="font-semibold text-text">
              {draft.from.id_in_project}
            </span>{" "}
            to checkpoint{" "}
            <span className="font-semibold text-text">{draft.to.id_in_project}</span>.
            Enforcement runs on the average speed across it.
          </>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" arrow onClick={submit}>
            Create edge
          </Button>
        </>
      }
    >
      <Field
        label="Distance"
        mono
        type="number"
        min={0}
        step={0.1}
        inputMode="decimal"
        value={driverConnected ? "" : distance}
        disabled={driverConnected}
        placeholder={driverConnected ? "Resolved by the distance driver" : "100"}
        hint={
          driverConnected
            ? "A driver is attached, so the server will route this edge and fill the distance in."
            : "Metres of real driving distance between the two checkpoints"
        }
        onChange={(event) => {
          setDistance(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
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
          if (event.key === "Enter") submit();
        }}
      />
    </Modal>
  );
}
