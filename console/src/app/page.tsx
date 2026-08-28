"use client";

import { useCallback, useEffect, useState } from "react";
import NewProjectDialog from "@/components/console/NewProjectDialog";
import OpenProjectDialog from "@/components/console/OpenProjectDialog";
import ProjectCard from "@/components/console/ProjectCard";
import Button from "@/components/ui/Button";
import Container from "@/components/ui/Container";
import EmptyState from "@/components/ui/EmptyState";
import Footer from "@/components/ui/Footer";
import Nav from "@/components/ui/Nav";
import Reveal from "@/components/ui/Reveal";
import SectionHeading from "@/components/ui/SectionHeading";
import { listProjects, type ProjectSummary } from "@/lib/api";
import { pluralise } from "@/lib/format";
import { docsLinks } from "@/lib/site";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState<ProjectSummary | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const rows = await listProjects(signal);
      setProjects(rows);
      setFailed(false);
    } catch {
      if (signal?.aborted) return;
      setProjects([]);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await load(controller.signal);
    })();
    return () => controller.abort();
  }, [load]);

  const count = projects?.length ?? 0;

  return (
    <>
      <Nav
        action={
          <Button size="sm" arrow onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      />

      <main className="min-h-[calc(100dvh-4rem)] bg-bg py-16 lg:py-20">
        <Container>
          <SectionHeading
            eyebrow="Console"
            title="Projects on this server"
            lead={
              <>
                Every project is one checkpoint graph. Opening one needs its API
                key: the same key its cameras and its distance driver
                authenticate with.{" "}
                <a
                  href={docsLinks.graphModel}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-cyan-dark underline decoration-border-strong underline-offset-4 transition-colors duration-200 hover:decoration-cyan"
                >
                  How the graph is modelled
                </a>
                .
              </>
            }
          />

          {projects === null ? (
            <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="h-[17.5rem] animate-pulse rounded-2xl border border-border bg-surface shadow-md"
                />
              ))}
            </div>
          ) : failed ? (
            <div className="mt-14 rounded-2xl border border-border bg-surface shadow-md">
              <EmptyState
                title="The server did not answer"
                body="The project list could not be read. The console is served by the same process that serves the API, so this usually means the server is restarting."
                action={
                  <Button size="md" variant="secondary" onClick={() => void load()}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : count === 0 ? (
            <div className="mt-14 rounded-2xl border border-border bg-surface shadow-md">
              <EmptyState
                title="No projects yet"
                body="Create one to get an API key, then point your cameras and a distance driver at it."
                action={
                  <Button size="md" arrow onClick={() => setCreating(true)}>
                    New project
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <Reveal className="mt-12">
                <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-text-dim">
                  {pluralise(count, "project")}
                </p>
              </Reveal>

              <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project, index) => (
                  <Reveal
                    key={project.project_id}
                    delay={Math.min(index, 5) * 0.05}
                  >
                    <ProjectCard project={project} onOpen={setOpening} />
                  </Reveal>
                ))}
              </div>
            </>
          )}
        </Container>
      </main>

      <Footer />

      <OpenProjectDialog project={opening} onClose={() => setOpening(null)} />
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => void load()}
      />
    </>
  );
}
