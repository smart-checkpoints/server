"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Container from "@/components/ui/Container";
import Field from "@/components/ui/Field";
import GraphMark from "@/components/LogoMark";
import { ApiError, authenticate } from "@/lib/api";
import { writeSession } from "@/lib/session";

/**
 * The console asking which project it is looking at.
 *
 * Reached by opening `/project` directly, or by coming back to a tab whose
 * session has been cleared. It asks rather than bouncing to the dashboard: the
 * operator already knows which project they want, and the key is all that is
 * missing.
 */
export default function ProjectGate() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const key = apiKey.trim();
    if (!key || busy) return;

    setBusy(true);
    setError(null);
    try {
      const project = await authenticate(key);
      // Storing the session notifies every reader of it, this page included,
      // so there is nothing to hand back to the caller.
      writeSession({ ...project, apiKey: key });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "That key does not open any project on this server."
          : "The server could not be reached. Try again.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[calc(100dvh-4rem)] items-center bg-bg py-16">
      <Container size="narrow" className="flex justify-center">
        <Card padding="md" className="w-full max-w-md">
          <GraphMark className="h-7 w-auto text-cyan" />
          <h1 className="mt-5 font-display text-2xl font-bold text-text">
            Open a project
          </h1>
          <p className="mt-2 text-sm text-text-dim">
            The console needs the project&apos;s API key to read its checkpoint
            graph. It is held for this tab and never put in a link.
          </p>

          <div className="mt-6">
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
          </div>

          <div className="mt-6 flex items-center justify-between gap-3">
            <Button href="/" variant="ghost" size="md">
              All projects
            </Button>
            <Button size="md" arrow onClick={submit} disabled={busy || !apiKey.trim()}>
              {busy ? "Checking" : "Open"}
            </Button>
          </div>
        </Card>
      </Container>
    </main>
  );
}
