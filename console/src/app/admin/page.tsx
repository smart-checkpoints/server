"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Container from "@/components/ui/Container";
import CopyButton from "@/components/ui/CopyButton";
import EmptyState from "@/components/ui/EmptyState";
import Field from "@/components/ui/Field";
import Footer from "@/components/ui/Footer";
import GraphMark from "@/components/LogoMark";
import Nav from "@/components/ui/Nav";
import Reveal from "@/components/ui/Reveal";
import SectionHeading from "@/components/ui/SectionHeading";
import {
  adminAuthenticate,
  adminListProjects,
  ApiError,
  type AdminProject,
} from "@/lib/api";
import { maskKey, pluralise } from "@/lib/format";

export default function AdminPage() {
  /* The password is held here and nowhere else: not in storage, not in a URL,
     not in a cookie. Reloading the page asks for it again, which is correct
     for a credential that lists every project's API key. */
  const [password, setPassword] = useState("");
  const [authorised, setAuthorised] = useState(false);
  const [projects, setProjects] = useState<AdminProject[] | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (secret: string, signal?: AbortSignal) => {
      try {
        setProjects(await adminListProjects(secret, signal));
        setError(null);
      } catch {
        if (signal?.aborted) return;
        setError("The project list could not be read.");
      }
    },
    [],
  );

  useEffect(() => {
    if (!authorised) return;
    const controller = new AbortController();
    void (async () => {
      await load(password, controller.signal);
    })();
    return () => controller.abort();
  }, [authorised, password, load]);

  async function signIn() {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await adminAuthenticate(password);
      setAuthorised(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("That is not the admin password for this server.");
      } else if (err instanceof ApiError && err.status === 503) {
        // The server says administration is switched off. It knows why, so it
        // gets to say so rather than being paraphrased here.
        setError(err.message);
      } else {
        setError("The server could not be reached. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  function toggleReveal(projectId: number) {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  if (!authorised) {
    return (
      <>
        <Nav />
        <main className="flex min-h-[calc(100dvh-4rem)] items-center bg-bg py-16">
          <Container size="narrow" className="flex justify-center">
            <Card padding="md" className="w-full max-w-md">
              <GraphMark className="h-7 w-auto text-cyan" />
              <h1 className="mt-5 font-display text-2xl font-bold text-text">
                Server administration
              </h1>
              <p className="mt-2 text-sm text-text-dim">
                Lists every project on this server together with its API key.
                The password is the one set as <code className="font-mono">
                  ADMIN_PASSWORD
                </code>{" "}
                in the server&apos;s environment.
              </p>

              <div className="mt-6">
                <Field
                  label="Admin password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  error={error}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void signIn();
                  }}
                />
              </div>

              <div className="mt-6 flex justify-end">
                <Button size="md" arrow onClick={signIn} disabled={busy || !password}>
                  {busy ? "Checking" : "Sign in"}
                </Button>
              </div>
            </Card>
          </Container>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void load(password)}
          >
            Refresh
          </Button>
        }
      />

      <main className="min-h-[calc(100dvh-4rem)] bg-bg py-16 lg:py-20">
        <Container>
          <SectionHeading
            eyebrow="Administration"
            title="Every project on this server"
            lead="One row per checkpoint graph, with the key that opens it. Keys are masked until you ask for one."
          />

          {projects === null ? (
            <div className="mt-12 h-64 animate-pulse rounded-2xl border border-border bg-surface shadow-md" />
          ) : projects.length === 0 ? (
            <div className="mt-12 rounded-2xl border border-border bg-surface shadow-md">
              <EmptyState
                title="No projects"
                body="Nothing has been created on this server yet."
                action={
                  <Button href="/" size="md" variant="secondary">
                    Go to projects
                  </Button>
                }
              />
            </div>
          ) : (
            <Reveal className="mt-12">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-text-dim">
                {pluralise(projects.length, "project")}
              </p>

              <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-surface shadow-md">
                <table className="w-full min-w-[46rem] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-border">
                      {["ID", "Project", "API key", "Checkpoints", "Edges", ""].map(
                        (heading, index) => (
                          <th
                            key={heading || index}
                            className="px-5 py-4 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-text-dim"
                          >
                            {heading}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => (
                      <tr
                        key={project.project_id}
                        className="border-b border-border last:border-0"
                      >
                        <td className="px-5 py-4 font-mono text-sm text-text-dim">
                          {project.project_id}
                        </td>
                        <td className="px-5 py-4 text-sm font-medium text-text">
                          {project.project_name}
                        </td>
                        <td className="px-5 py-4 font-mono text-xs text-text-dim">
                          <button
                            type="button"
                            onClick={() => toggleReveal(project.project_id)}
                            title={
                              revealed.has(project.project_id)
                                ? "Hide this key"
                                : "Reveal this key"
                            }
                            className="break-all text-left transition-colors duration-200 hover:text-cyan-dark"
                          >
                            {revealed.has(project.project_id)
                              ? project.api_key
                              : maskKey(project.api_key)}
                          </button>
                        </td>
                        <td className="px-5 py-4 font-mono text-sm text-text">
                          {project.node_count ?? 0}
                        </td>
                        <td className="px-5 py-4 font-mono text-sm text-text">
                          {project.connection_count ?? 0}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <CopyButton value={project.api_key} label="Copy key" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}
            </Reveal>
          )}
        </Container>
      </main>

      <Footer />
    </>
  );
}
