"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import Modal from "@/components/ui/Modal";
import { isValidLatLng, parseCoordinate } from "@/lib/geo";
import { docsLinks } from "@/lib/site";

type AddCheckpointDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreate: (position: { lat: number; lng: number }) => Promise<void>;
};

/**
 * Placing a checkpoint by coordinate.
 *
 * A checkpoint is a camera at a real position, so it is created from a real
 * WGS84 coordinate rather than by clicking somewhere on an empty plane. The
 * pair is validated here with the same rules the server applies on the way in:
 * a missing coordinate must fail, not quietly become a position in the
 * Atlantic.
 */
export default function AddCheckpointDialog({
  open,
  onClose,
  onCreate,
}: AddCheckpointDialogProps) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLatitude("");
      setLongitude("");
      setError(null);
      setBusy(false);
    }
  }

  async function submit() {
    if (busy) return;

    const lat = parseCoordinate(latitude);
    const lng = parseCoordinate(longitude);
    if (!isValidLatLng(lat, lng)) {
      setError(
        "Latitude must be a number within ±90 and longitude within ±180, in degrees.",
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onCreate({ lat, lng });
      onClose();
    } catch {
      setError("The checkpoint could not be created.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New checkpoint"
      subtitle={
        <>
          A checkpoint is one camera position. Cameras normally create their own
          over the REST API; this is for laying out a graph by hand.{" "}
          <a
            href={docsLinks.restApi}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-cyan-dark underline decoration-border-strong underline-offset-4 transition-colors duration-200 hover:decoration-cyan"
          >
            REST API
          </a>
        </>
      }
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" arrow onClick={submit} disabled={busy}>
            {busy ? "Creating" : "Create"}
          </Button>
        </>
      }
    >
      <Field
        label="Latitude"
        mono
        inputMode="decimal"
        placeholder="51.50735"
        value={latitude}
        onChange={(event) => {
          setLatitude(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
      <Field
        label="Longitude"
        mono
        inputMode="decimal"
        placeholder="-0.12776"
        value={longitude}
        error={error}
        hint="WGS84 degrees, the same pair a GPS gives"
        onChange={(event) => {
          setLongitude(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
    </Modal>
  );
}
