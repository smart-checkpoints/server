"use client";

import { useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import ProjectThumbnail from "@/components/console/ProjectThumbnail";
import { getThumbnailData, type ProjectSummary, type ThumbnailData } from "@/lib/api";
import { pluralise } from "@/lib/format";

type ProjectCardProps = {
  project: ProjectSummary;
  onOpen: (project: ProjectSummary) => void;
};

/**
 * One project on the dashboard: its shape, its name, and how big it is.
 *
 * The card is a button, not a link. Opening a project needs the project's API
 * key, which the operator supplies in the dialog this raises. There is no URL
 * that opens a project on its own, and there is no href to leak a key into.
 */
export default function ProjectCard({ project, onOpen }: ProjectCardProps) {
  const [thumbnail, setThumbnail] = useState<ThumbnailData | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    getThumbnailData(project.project_id, controller.signal)
      .then(setThumbnail)
      .catch(() => {
        // A thumbnail is decoration. If the shape cannot be fetched the card
        // still names the project and still opens it.
      });

    return () => controller.abort();
  }, [project.project_id]);

  return (
    <button
      type="button"
      onClick={() => onOpen(project)}
      className="group block w-full overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-md transition-colors duration-200 hover:border-cyan"
    >
      <div className="h-44 w-full border-b border-border">
        <ProjectThumbnail data={thumbnail} loading={thumbnail === null} />
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-bold text-text">
            {project.project_name}
          </h3>
          <p className="mt-1 font-mono text-xs text-text-dim">
            {pluralise(project.node_count ?? 0, "checkpoint")} ·{" "}
            {pluralise(project.connection_count ?? 0, "edge")}
          </p>
        </div>
        <Badge tone="neutral" mono className="shrink-0">
          #{project.project_id}
        </Badge>
      </div>
    </button>
  );
}
