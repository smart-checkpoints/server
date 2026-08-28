"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import CopyButton from "@/components/ui/CopyButton";
import Field from "@/components/ui/Field";
import Modal from "@/components/ui/Modal";
import { authenticate, createProject } from "@/lib/api";
import { writeSession } from "@/lib/session";

type NewProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Fired once the project exists, so the dashboard can refresh its list. */
  onCreated: () => void;
};

type Created = {
  projectId: number;
  apiKey: string;
  name: string;
};

/**
 * Creating a project, and the one time its API key is ever displayed.
 *
 * The server generates the key and stores it; there is no endpoint that shows
 * it again to someone who does not already hold it. So the second step of this
 * dialog is deliberately a hard stop: it does not close on the backdrop, and
 * it says plainly that this is the only showing.
 */
export default function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: NewProjectDialogProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Each opening starts clean, including the key reveal: a dialog that
     remembers the last project's key is a dialog that shows it to whoever
     opens it next. */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setCreated(null);
      setError(null);
      setBusy(false);
    }
  }

  async function submit() {
    const projectName = name.trim();
    if (!projectName || busy) return;

    setBusy(true);
    setError(null);
    try {
      const result = await createProject(projectName);
      setCreated({
        projectId: result.project_id,
        apiKey: result.api_key,
        name: projectName,
      });
      onCreated();
    } catch {
      setError("The project could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function openCreated() {
    if (!created) return;
    setBusy(true);
    try {
      const project = await authenticate(created.apiKey);
      writeSession({ ...project, apiKey: created.apiKey });
      router.push("/project");
    } catch {
      setError("The project was created, but the console could not open it.");
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Modal
        open={open}
        // The key is on screen and shown only once; the backdrop must not
        // dismiss it by accident.
        onClose={() => undefined}
        title="Save this key"
        subtitle={
          <>
            This is the only time{" "}
            <span className="font-semibold text-text">{created.name}</span> shows
            its API key. It authenticates every camera, driver and console
            session on the project.
          </>
        }
        footer={
          <>
            <Button variant="ghost" size="md" onClick={onClose}>
              Done
            </Button>
            <Button size="md" arrow onClick={openCreated} disabled={busy}>
              Open project
            </Button>
          </>
        }
      >
        <div className="rounded-xl border border-border bg-bg-subtle p-4">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
            API key
          </p>
          <p className="mt-2 break-all font-mono text-sm text-text">
            {created.apiKey}
          </p>
          <div className="mt-4">
            <CopyButton value={created.apiKey} label="Copy key" />
          </div>
        </div>
        {error ? <p className="text-xs text-red">{error}</p> : null}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      subtitle="A project is one checkpoint graph: its cameras, the edges between them, and the violations they produce."
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" arrow onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Creating" : "Create"}
          </Button>
        </>
      }
    >
      <Field
        label="Project name"
        placeholder="City centre corridor"
        autoComplete="off"
        maxLength={120}
        value={name}
        error={error}
        onChange={(event) => {
          setName(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
    </Modal>
  );
}
