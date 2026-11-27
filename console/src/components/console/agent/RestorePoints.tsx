"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  downloadReport,
  listRestorePoints,
  previewRestore,
  restoreTo,
  saveRestorePoint,
  type RestorePoint,
  type RestorePreview,
  type RestoreResult,
} from "@/lib/agent";

/**
 * Restore points in the Sayes panel: the Undo under a reply, and the list
 * of every saved network. Both ask before they change anything, with the
 * server's own account of what a restore would do. Called restore points,
 * never checkpoints: checkpoints are cameras.
 */

export const RestoreContext = createContext<{ projectId: number; apiKey: string; busy: boolean }>({
  projectId: 0,
  apiKey: "",
  busy: false,
});

function outcome(result: RestoreResult): string {
  if (!result.restored) return result.lines?.[0] ?? "Nothing to restore.";
  const parts: string[] = [];
  const n = (count: number | undefined, word: string) => (count ? `${count} ${word}${count === 1 ? "" : "s"}` : "");
  if (result.deleted_cameras?.length) parts.push(`removed ${n(result.deleted_cameras.length, "camera")}`);
  if (result.brought_back_cameras?.length) parts.push(`brought back ${n(result.brought_back_cameras.length, "camera")}`);
  if (result.brought_back_edges) parts.push(`brought back ${n(result.brought_back_edges, "edge")}`);
  if (result.moved) parts.push(`moved ${n(result.moved, "camera")} back`);
  if (result.created_cameras?.length) {
    parts.push(`brought back ${result.created_cameras.map((c) => `camera ${c.was} as ${c.now}`).join(", ")}`);
  }
  if (result.deleted_edges) parts.push(`removed ${n(result.deleted_edges, "edge")}`);
  if (result.created_edges) parts.push(`re-created ${n(result.created_edges, "edge")}`);
  if (result.limits) parts.push(`put back ${n(result.limits, "limit")}`);
  let text = parts.length ? `Restored: ${parts.join(", ")}.` : "Restored.";
  if (result.deleted_cameras?.length || result.deleted_edges) text += " Anything with violations was retired; the violations stay on record.";
  if (result.failed?.length) text += ` Did not work: ${result.failed.join("; ")}.`;
  return text;
}

/** A button that previews a restore, asks, and carries it out. */
export function RestoreButton({ id, label, onDone }: { id: number; label: string; onDone?: () => void }) {
  const { projectId, apiKey, busy } = useContext(RestoreContext);
  const [state, setState] = useState<
    { step: "idle" } | { step: "loading" } | { step: "ask"; preview: RestorePreview } | { step: "working" } | { step: "done"; text: string } | { step: "error"; text: string }
  >({ step: "idle" });

  const ask = async () => {
    setState({ step: "loading" });
    try {
      const preview = await previewRestore(projectId, apiKey, id);
      setState(preview.empty ? { step: "done", text: preview.lines[0] } : { step: "ask", preview });
    } catch (err) {
      setState({ step: "error", text: err instanceof Error ? err.message : "Could not work out the restore." });
    }
  };
  const go = async () => {
    setState({ step: "working" });
    try {
      const result = await restoreTo(projectId, apiKey, id);
      setState({ step: "done", text: outcome(result) });
      onDone?.();
    } catch (err) {
      setState({ step: "error", text: err instanceof Error ? err.message : "The restore failed." });
    }
  };

  if (state.step === "ask") {
    return (
      <div className="agent-confirm mt-2 rounded-xl border border-cyan bg-surface p-4 shadow-md" role="alertdialog" aria-label="Confirm restore">
        <p className="font-display text-sm font-bold text-text">Restore “{state.preview.name}”?</p>
        <ul className="mt-2 space-y-1">
          {state.preview.lines.map((line) => (
            <li key={line} className="text-xs text-text-dim">
              {line}
            </li>
          ))}
          <li className="text-xs text-text-dim">Violations are never changed. The network as it is now is saved first, so this can be undone too.</li>
        </ul>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => void go()} className="btn btn-primary rounded-full px-4 py-1.5 text-sm font-semibold">
            Restore
          </button>
          <button type="button" onClick={() => setState({ step: "idle" })} className="btn btn-secondary rounded-full px-4 py-1.5 text-sm font-semibold">
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (state.step === "done" || state.step === "error") {
    return <p className="mt-1 text-xs text-text-dim">{state.text}</p>;
  }
  return (
    <button
      type="button"
      disabled={busy || state.step !== "idle"}
      onClick={() => void ask()}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-semibold text-text-dim transition-colors duration-200 hover:border-cyan hover:text-cyan-dark disabled:opacity-50"
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4.5 6.5H10a3 3 0 0 1 0 6H7M4.5 6.5 7 4M4.5 6.5 7 9" />
      </svg>
      {state.step === "loading" ? "Checking…" : state.step === "working" ? "Restoring…" : label}
    </button>
  );
}

/** The download card for a report Sayes wrote. */
export function ReportCard({ report }: { report: { id: string; title: string; filename: string; pages: number } }) {
  const { projectId, apiKey } = useContext(RestoreContext);
  const [state, setState] = useState<"idle" | "working" | string>("idle");
  const get = async () => {
    setState("working");
    try {
      await downloadReport(projectId, apiKey, report.id, report.filename);
      setState("idle");
    } catch (err) {
      setState(err instanceof Error ? err.message : "The download failed.");
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5">
      <span className="inline-flex h-9 w-8 shrink-0 items-center justify-center rounded-md bg-cyan-glow font-mono text-[0.625rem] font-bold text-cyan-dark">
        PDF
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text">{report.title}</span>
        <span className="block font-mono text-[0.6875rem] text-text-dim">
          {state !== "idle" && state !== "working" ? state : `${report.pages} page${report.pages === 1 ? "" : "s"} · kept for an hour`}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void get()}
        disabled={state === "working"}
        className="btn btn-secondary shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
      >
        {state === "working" ? "Downloading…" : "Download"}
      </button>
    </div>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Every restore point of the project, newest first, and saving a new one. */
export function RestorePointList() {
  const { projectId, apiKey, busy } = useContext(RestoreContext);
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const load = useCallback(() => {
    listRestorePoints(projectId, apiKey)
      .then((rows) => {
        setPoints(rows);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load restore points"));
  }, [apiKey, projectId]);
  useEffect(load, [load]);

  const save = async () => {
    const label = name.trim() || `Saved ${when(new Date().toISOString())}`;
    try {
      await saveRestorePoint(projectId, apiKey, label);
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <p className="text-xs text-text-dim">
        Saved copies of the network: cameras, edges and limits, never violations. Sayes saves one before every request that changes something.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void save()}
          placeholder="Name this restore point"
          aria-label="Restore point name"
          className="field min-w-0 flex-1 py-1.5 text-sm"
        />
        <button type="button" onClick={() => void save()} disabled={busy} className="btn btn-secondary shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold disabled:opacity-50">
          Save now
        </button>
      </div>
      {error ? <p className="mt-3 text-sm text-text-dim">{error}</p> : null}
      {points && points.length === 0 ? <p className="mt-4 text-sm text-text-dim">No restore points yet.</p> : null}
      <ol className="mt-3 space-y-2">
        {(points ?? []).map((point) => (
          <li key={point.restore_point_id} className="rounded-xl border border-border px-3 py-2.5">
            <p className="text-sm text-text">{point.name}</p>
            <p className="font-mono text-[0.6875rem] text-text-dim">
              {when(point.created_at)} · {point.cameras} cameras · {point.edges} edges{point.origin === "auto" ? " · automatic" : ""}
            </p>
            <div className="mt-1.5">
              <RestoreButton id={point.restore_point_id} label="Restore" onDone={load} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
