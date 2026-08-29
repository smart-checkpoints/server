"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import {
  ApiError,
  approveMapDriver,
  rejectMapDriver,
  revokeMapDriver,
  type MapDriverState,
} from "@/lib/api";

type MapDriverSettingsProps = {
  projectId: number;
  apiKey: string;
  state: MapDriverState;
  /** The server broadcasts the new state; this applies it locally too. */
  onChange: (state: MapDriverState) => void;
};

/** The origin, spelled out, because the origin is what is being trusted. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Approving where the map view comes from.
 *
 * A map driver announces the address of its own UI when it connects, and an
 * approved address is put in an iframe inside the console's own chrome.
 * Whoever holds the project API key would otherwise be choosing what renders
 * there - a cross-origin frame cannot read this page, but it is handed every
 * piece of project state and can paint a convincing console around it.
 *
 * So an announcement is a proposal. This is where somebody reads it and
 * decides, once. The address is shown in full, and the origin separately,
 * because the origin is the part that is actually being trusted: everything
 * the bridge sends goes to it and everything it accepts is checked against it.
 */
export default function MapDriverSettings({
  projectId,
  apiKey,
  state,
  onChange,
}: MapDriverSettingsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<MapDriverState>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "That did not go through. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const pending = state.pending_url;

  return (
    <div className="mt-6 rounded-xl border border-border bg-bg-subtle p-4">
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
        Map view
      </p>

      {state.status === "none" && !pending ? (
        <p className="mt-2 text-xs text-text-dim">
          No map driver has offered one. The graph view draws the same geometry
          on a blank background and needs no driver at all.
        </p>
      ) : null}

      {pending ? (
        <div className="mt-3 rounded-lg border border-yellow/40 bg-bg p-3">
          <p className="text-xs text-text-dim">
            A map driver is offering to render this project at:
          </p>
          <p className="mt-2 break-all font-mono text-xs text-text">{pending}</p>
          <p className="mt-2 font-mono text-xs text-text-dim">
            origin {originOf(pending)}
          </p>
          <p className="mt-3 text-xs text-yellow">
            Approving puts that page inside this console. It cannot read this
            page, but it is sent every checkpoint, every distance and every
            violation this project has, and it will be drawn in the console&apos;s
            own frame. Approve it only if you run it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(() => approveMapDriver(projectId, apiKey, pending))
              }
            >
              Approve
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => void act(() => rejectMapDriver(projectId, apiKey))}
            >
              Not this one
            </Button>
          </div>
        </div>
      ) : null}

      {state.status === "approved" && state.url ? (
        <div className="mt-3">
          <p className="break-all font-mono text-xs text-text">{state.url}</p>
          <p className="mt-2 font-mono text-xs text-text-dim">
            origin {state.origin} -{" "}
            <span className={state.connected ? "text-text" : "text-yellow"}>
              {state.connected ? "driver attached" : "driver not running"}
            </span>
          </p>
          <p className="mt-2 text-xs text-text-dim">
            Approved. The map view renders this address, and the console will
            only ever exchange messages with that origin. Without the driver
            running there is nothing serving the page, so the graph view is
            what you get.
          </p>
          <div className="mt-3">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => void act(() => revokeMapDriver(projectId, apiKey))}
            >
              Withdraw approval
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-xs text-red">{error}</p> : null}
    </div>
  );
}
