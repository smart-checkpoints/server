"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";
import type { MoveDraft } from "@/components/console/GraphCanvas";
import type { Connection } from "@/lib/api";
import { formatDistance } from "@/lib/format";

type MoveCheckpointDialogProps = {
  draft: MoveDraft | null;
  /** Every edge in the project, to count the ones this move invalidates. */
  connections: Connection[];
  onClose: () => void;
  onConfirm: (draft: MoveDraft) => Promise<void>;
};

/**
 * What moving this checkpoint costs, in edges.
 *
 * Spelled out rather than counted, because the count is the whole warning: an
 * operator who reads "4 connections stop enforcing" and does not mean to stop
 * enforcing four roads has been given the chance to cancel.
 */
function consequence(affected: number): string {
  if (affected === 0) {
    return "Nothing connects to this checkpoint yet, so no distances change.";
  }
  if (affected === 1) {
    return (
      "The one connection to this checkpoint loses its distance and stops " +
      "enforcing until a driver measures it again. That is deliberate: the " +
      "stored distance was measured from where the camera used to be."
    );
  }
  return (
    `All ${affected} connections to this checkpoint lose their distances and ` +
    "stop enforcing until a driver measures them again. That is deliberate: " +
    "they were measured from where the camera used to be."
  );
}

/**
 * Confirming that a checkpoint really has moved.
 *
 * The graph is geometrically faithful, so dragging a checkpoint across it
 * moves a camera in the real world, and every distance measured to that camera
 * stops being true. An accidental drag must not quietly change what counts as
 * speeding - so the drop is a proposal, and this is where it becomes a fact.
 *
 * The number that matters is the distance in metres. A drag of four metres is
 * a slip; a drag of four hundred is a correction to a bad GPS fix, and they
 * look identical on a canvas whose scale the operator has been zooming in and
 * out of all afternoon.
 */
export default function MoveCheckpointDialog({
  draft,
  connections,
  onClose,
  onConfirm,
}: MoveCheckpointDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [previous, setPrevious] = useState<MoveDraft | null>(draft);
  if (draft !== previous) {
    setPrevious(draft);
    setError(null);
    setBusy(false);
  }

  const affected = draft
    ? connections.filter(
        (edge) =>
          edge.from_node_id === draft.node.node_id ||
          edge.to_node_id === draft.node.node_id,
      ).length
    : 0;

  async function submit() {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(draft);
    } catch {
      setError("The checkpoint could not be moved.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={draft !== null}
      onClose={onClose}
      title="Move this checkpoint?"
      subtitle={
        draft
          ? `Checkpoint ${draft.node.id_in_project} would move ${formatDistance(
              draft.metres,
            )}. This is a camera's real position, and every distance measured to it is measured from here.`
          : ""
      }
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" arrow onClick={submit} disabled={busy}>
            {busy ? "Moving" : "Move it"}
          </Button>
        </>
      }
    >
      {draft ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 font-mono text-xs">
            <dt className="text-text-dim">From</dt>
            <dd className="text-text">
              {draft.node.latitude.toFixed(5)}, {draft.node.longitude.toFixed(5)}
            </dd>
            <dt className="text-text-dim">To</dt>
            <dd className="text-text">
              {draft.to.lat.toFixed(5)}, {draft.to.lng.toFixed(5)}
            </dd>
            <dt className="text-text-dim">Distance</dt>
            <dd className="text-text">{formatDistance(draft.metres)}</dd>
          </dl>

          <p className="text-sm leading-relaxed text-text-dim">{consequence(affected)}</p>
        </div>
      ) : null}

      {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}
    </Modal>
  );
}
