"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { LogoLockup } from "@/components/LogoMark";
import OpenProjectDialog from "@/components/console/OpenProjectDialog";
import type { ConsoleView } from "@/components/console/ViewToggle";
import Badge from "@/components/ui/Badge";
import { listProjects, type MapDriverState, type ProjectSummary } from "@/lib/api";
import type { ConsoleSession } from "@/lib/session";
import { site } from "@/lib/site";
import { Chevron, IconButton, Icons, Menu, MenuDivider, MenuItem, MenuLabel, Segmented, StatusChip, type Tone } from "./parts";

type TopBarProps = {
  session: ConsoleSession;
  isDemo: boolean;
  driverConnected: boolean;
  realtimeConnected: boolean;
  mapDriver: MapDriverState;
  view: ConsoleView;
  mapAvailable: boolean;
  mapUnavailableReason: string;
  onView: (view: ConsoleView) => void;
  presentation: boolean;
  onTogglePresentation: () => void;
  onSignOut: () => void;
};

function mapChip(map: MapDriverState): { tone: Tone; label: string; title: string } {
  if (map.status === "approved" && map.connected) return { tone: "ok", label: "Map driver", title: "An approved map driver is serving the map view." };
  if (map.status === "approved") return { tone: "warn", label: "Map driver offline", title: "The approved map driver is not running." };
  if (map.pending_url) return { tone: "warn", label: "Map driver waiting", title: "A map driver is waiting to be approved, under Settings." };
  return { tone: "off", label: "No map driver", title: "No map driver has offered a map view for this project." };
}

/**
 * The console's one bar: which project this is, what is attached to it, the
 * view, and everything that leaves the console behind a single menu.
 */
export default function TopBar({
  session,
  isDemo,
  driverConnected,
  realtimeConnected,
  mapDriver,
  view,
  mapAvailable,
  mapUnavailableReason,
  onView,
  presentation,
  onTogglePresentation,
  onSignOut,
}: TopBarProps) {
  const [menu, setMenu] = useState<"project" | "more" | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [opening, setOpening] = useState<ProjectSummary | null>(null);
  const close = useCallback(() => setMenu(null), []);

  const openProjects = () => {
    if (menu === "project") return setMenu(null);
    setMenu("project");
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  };

  const map = mapChip(mapDriver);

  return (
    <header data-cursor-avoid className="relative z-40 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface pl-3 pr-2">
      <Link href="/" aria-label="All projects" className="shrink-0 text-text">
        <LogoLockup className="h-7 w-auto" />
      </Link>
      <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />

      <div className="relative min-w-0">
        <button
          type="button"
          onClick={openProjects}
          aria-haspopup="menu"
          aria-expanded={menu === "project"}
          className="inline-flex h-8 min-w-0 max-w-[18rem] items-center gap-2 rounded-lg px-2.5 text-sm font-semibold text-text hover:bg-surface-hover"
        >
          <span className="truncate font-display">{session.project_name}</span>
          <Chevron />
        </button>
        {menu === "project" ? (
          <Menu onClose={close} className="left-0 top-full mt-1 w-72">
            <MenuLabel>Projects</MenuLabel>
            {projects === null ? (
              <p className="px-3.5 py-1.5 text-sm text-text-dim">Loading…</p>
            ) : (
              projects.map((project) => (
                <MenuItem
                  key={project.project_id}
                  active={project.project_id === session.project_id}
                  hint={`${project.node_count} cam`}
                  onClick={() => {
                    setMenu(null);
                    if (project.project_id !== session.project_id) setOpening(project);
                  }}
                >
                  {project.project_name}
                </MenuItem>
              ))
            )}
            <MenuDivider />
            <MenuItem href="/">All projects…</MenuItem>
            <MenuItem onClick={onSignOut}>Close this project</MenuItem>
          </Menu>
        ) : null}
      </div>

      {isDemo ? (
        <Badge tone="accent" mono>
          Demo
        </Badge>
      ) : null}
      <StatusChip
        tone={driverConnected ? "ok" : "warn"}
        title={driverConnected ? "Edge distances come from real road routing." : "No distance driver: distances are typed in by hand."}
      >
        {driverConnected ? "Distance driver" : "No distance driver"}
      </StatusChip>
      <span className="hidden lg:inline-flex">
        <StatusChip tone={map.tone} title={map.title}>
          {map.label}
        </StatusChip>
      </span>
      {!realtimeConnected ? (
        <StatusChip tone="bad" title="Live updates are not arriving; the page reconnects by itself.">
          Offline
        </StatusChip>
      ) : null}

      <span className="flex-1" />

      <Segmented<ConsoleView>
        label="View"
        value={view}
        onChange={onView}
        options={[
          { id: "graph", label: "Graph", target: "view-graph" },
          { id: "map", label: "Map", target: "view-map", disabled: !mapAvailable, title: mapAvailable ? undefined : mapUnavailableReason },
        ]}
      />

      <div className="relative">
        <IconButton label="More" active={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>
          {Icons.more}
        </IconButton>
        {menu === "more" ? (
          <Menu onClose={close} className="right-0 top-full mt-1 w-60">
            <MenuItem href={site.docs} external>
              Docs
            </MenuItem>
            <MenuItem href={site.github} external>
              GitHub
            </MenuItem>
            <MenuItem href="/admin">Admin</MenuItem>
            <MenuDivider />
            <MenuItem
              hint="Ctrl ⇧ ."
              onClick={() => {
                setMenu(null);
                onTogglePresentation();
              }}
            >
              {presentation ? "Leave presentation mode" : "Presentation mode"}
            </MenuItem>
          </Menu>
        ) : null}
      </div>

      <OpenProjectDialog project={opening} onClose={() => setOpening(null)} />
    </header>
  );
}
