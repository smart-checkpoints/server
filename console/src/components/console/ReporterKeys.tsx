"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import CopyButton from "@/components/ui/CopyButton";
import Field from "@/components/ui/Field";
import {
  ApiError,
  issueReporterKey,
  listReporterKeys,
  revokeReporterKey,
  type ReporterKey,
} from "@/lib/api";
import { formatDate } from "@/lib/format";

type ReporterKeysProps = {
  projectId: number;
  /** The project's operator key: issuing and revoking are operator actions. */
  apiKey: string;
  /** Keys are only fetched while the panel holding this is open. */
  active: boolean;
};

/**
 * The keys held by the cameras in the field.
 *
 * A camera only ever reports a sighting, so it gets a key that can only report
 * one - not the project key, which also rewrites the graph and reads every
 * violation. One key per camera means a camera found open on its pole costs
 * one revocation rather than a new key on every camera in the fleet.
 *
 * An issued key is shown once. There is nowhere to read it back from, which is
 * the point: the server keeps enough to list and revoke it and nothing an
 * attacker could lift.
 */
export default function ReporterKeys({
  projectId,
  apiKey,
  active,
}: ReporterKeysProps) {
  const [keys, setKeys] = useState<ReporterKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<{
    keyId: number;
    label: string;
    key: string;
  } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  /** Re-reads the list after issuing or revoking. */
  const refresh = useCallback(async () => {
    try {
      setKeys(await listReporterKeys(projectId, apiKey));
    } catch {
      setError("Could not read the camera keys for this project.");
    }
  }, [projectId, apiKey]);

  useEffect(() => {
    if (!active) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await listReporterKeys(projectId, apiKey, controller.signal);
        if (controller.signal.aborted) return;
        setKeys(rows);
        setError(null);
      } catch {
        if (controller.signal.aborted) return;
        setError("Could not read the camera keys for this project.");
      }
    })();

    return () => controller.abort();
  }, [active, projectId, apiKey]);

  async function issue() {
    const name = label.trim();
    if (issuing) return;

    setIssuing(true);
    setError(null);
    try {
      const created = await issueReporterKey(projectId, apiKey, name);
      setIssued({ keyId: created.key_id, label: name, key: created.api_key });
      setLabel("");
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not issue a key. Try again.",
      );
    } finally {
      setIssuing(false);
    }
  }

  async function revoke(keyId: number) {
    setError(null);
    try {
      await revokeReporterKey(projectId, apiKey, keyId);
      setConfirming(null);
      // Revoking the key that is still showing leaves a copy button for a
      // credential that no longer works. Take the card away with it.
      setIssued((current) => (current?.keyId === keyId ? null : current));
      await refresh();
    } catch {
      setError("Could not revoke that key.");
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-border bg-bg-subtle p-4">
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
        Camera keys
      </p>
      <p className="mt-2 text-xs text-text-dim">
        A camera reports sightings and does nothing else, so give each one its
        own key. It cannot read the graph, edit an edge, or read violations, and
        revoking one leaves the rest of the fleet alone.
      </p>

      {issued ? (
        <div className="mt-4 rounded-lg border border-cyan/40 bg-bg p-3">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
            {issued.label || "New camera key"}
          </p>
          <p className="mt-2 break-all font-mono text-xs text-text">
            {issued.key}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <CopyButton value={issued.key} label="Copy key" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIssued(null)}
              type="button"
            >
              Done
            </Button>
          </div>
          <p className="mt-3 text-xs text-yellow">
            Copy it into the camera now. It is not stored anywhere it can be
            read back - if it is lost, revoke this key and issue another.
          </p>
        </div>
      ) : null}

      <div className="mt-4">
        {keys === null ? (
          <p className="text-xs text-text-dim">Reading keys...</p>
        ) : keys.length === 0 ? (
          <p className="text-xs text-text-dim">
            No camera keys yet. Every camera on this project is reporting with
            the project key above.
          </p>
        ) : (
          <ul>
            {keys.map((key) => (
              <li
                key={key.key_id}
                className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-text">
                    {key.label ?? "Unlabelled camera"}
                  </p>
                  <p className="font-mono text-xs text-text-dim">
                    {key.key_prefix}... - {formatDate(key.created_at)}
                  </p>
                </div>
                {confirming === key.key_id ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => void revoke(key.key_id)}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    className="shrink-0"
                    onClick={() => setConfirming(key.key_id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4">
        <Field
          label="Issue a key"
          mono
          autoComplete="off"
          spellCheck={false}
          placeholder="Which camera is it for?"
          value={label}
          error={error}
          hint="A name for your own use, so this key can be matched to a pole."
          onChange={(event) => {
            setLabel(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void issue();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          type="button"
          className="mt-3"
          disabled={issuing}
          onClick={() => void issue()}
        >
          {issuing ? "Issuing..." : "Issue camera key"}
        </Button>
      </div>
    </div>
  );
}
