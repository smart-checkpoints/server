"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import Modal from "@/components/ui/Modal";
import { ApiError, authenticate, type ProjectSummary } from "@/lib/api";
import { writeSession } from "@/lib/session";

type OpenProjectDialogProps = {
  project: ProjectSummary | null;
  onClose: () => void;
};

/**
 * The key exchange that opens a project.
 *
 * The dashboard is unauthenticated, because the project list is public, so
 * this is where a session begins. The key is verified against the server before
 * anything is stored, and it is stored for the tab rather than pushed into
 * the URL of the page it opens.
 */
export default function OpenProjectDialog({
  project,
  onClose,
}: OpenProjectDialogProps) {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Reset when a different project is asked for. Adjusting state during the
     render that already knows about the change beats an effect that reacts to
     it one paint later, which is a frame of the previous project's error. */
  const [lastProject, setLastProject] = useState(project);
  if (project !== lastProject) {
    setLastProject(project);
    setApiKey("");
    setError(null);
    setBusy(false);
  }

  async function submit() {
    const key = apiKey.trim();
    if (!key || busy) return;

    setBusy(true);
    setError(null);
    try {
      const authenticated = await authenticate(key);

      if (project && authenticated.project_id !== project.project_id) {
        setError(
          `That key opens ${authenticated.project_name}, not ${project.project_name}.`,
        );
        return;
      }

      writeSession({ ...authenticated, apiKey: key });
      router.push("/project");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That key does not open any project on this server."
          : "The server could not be reached. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={project !== null}
      onClose={onClose}
      title="Open project"
      subtitle={
        project ? (
          <>
            Paste the API key for{" "}
            <span className="font-semibold text-text">{project.project_name}</span>.
            The key stays in this tab and is never put in a link.
          </>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" arrow onClick={submit} disabled={busy || !apiKey.trim()}>
            {busy ? "Checking" : "Open"}
          </Button>
        </>
      }
    >
      <Field
        label="API key"
        mono
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste the project API key"
        value={apiKey}
        error={error}
        onChange={(event) => {
          setApiKey(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
      />
    </Modal>
  );
}
