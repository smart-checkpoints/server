"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AddCheckpointDialog from "@/components/console/AddCheckpointDialog";
import CanvasControls from "@/components/console/CanvasControls";
import ConnectionEditor from "@/components/console/ConnectionEditor";
import DriverStatus from "@/components/console/DriverStatus";
import GraphCanvas, {
  type EdgeDraft,
  type FlashSignal,
  type GraphCanvasHandle,
} from "@/components/console/GraphCanvas";
import GraphLegend from "@/components/console/GraphLegend";
import NewConnectionDialog from "@/components/console/NewConnectionDialog";
import ProjectGate from "@/components/console/ProjectGate";
import SettingsPanel from "@/components/console/SettingsPanel";
import ViolationsPanel from "@/components/console/ViolationsPanel";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Nav from "@/components/ui/Nav";
import {
  createNode,
  getConnections,
  getDistanceDriverStatus,
  getNodes,
  getViolations,
  type CheckpointNode,
  type Connection,
  type Violation,
} from "@/lib/api";
import { pluralise } from "@/lib/format";
import type { ConsoleSocket } from "@/lib/realtime";
import { connectProject } from "@/lib/realtime";
import { clearSession, useConsoleSession } from "@/lib/session";

export default function ProjectConsolePage() {
  /* `undefined` is "not read yet", `null` is "read, and there is none". The
     difference matters: this page is prerendered at build time, where there is
     no storage, and it must not flash the unlock card at an operator who is
     already signed in. */
  const session = useConsoleSession();

  const [nodes, setNodes] = useState<CheckpointNode[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [liveViolations, setLiveViolations] = useState(0);
  const [congestion, setCongestion] = useState<Record<number, number>>({});
  const [flash, setFlash] = useState<FlashSignal | null>(null);

  const [driverConnected, setDriverConnected] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [selected, setSelected] = useState<Connection | null>(null);
  const [draft, setDraft] = useState<EdgeDraft | null>(null);
  const [showViolations, setShowViolations] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [addingCheckpoint, setAddingCheckpoint] = useState(false);

  const router = useRouter();
  const canvas = useRef<GraphCanvasHandle>(null);
  const socket = useRef<ConsoleSocket | null>(null);
  const flashSeq = useRef(0);

  /* ---------------------------------------------------------------------
     The first read, then the live channel
     --------------------------------------------------------------------- */

  useEffect(() => {
    if (!session) return;

    const controller = new AbortController();
    const { project_id: projectId, apiKey } = session;

    void (async () => {
      const [nodeRows, edgeRows, violationRows, driver] = await Promise.all([
        getNodes(projectId, apiKey, controller.signal).catch(() => []),
        getConnections(projectId, apiKey, controller.signal).catch(() => []),
        getViolations(projectId, apiKey, controller.signal).catch(() => []),
        getDistanceDriverStatus(projectId, apiKey, controller.signal).catch(() => ({
          connected: false,
        })),
      ]);

      if (controller.signal.aborted) return;
      setNodes(nodeRows);
      setConnections(edgeRows);
      setViolations(violationRows);
      setDriverConnected(driver.connected);
      setLoaded(true);
    })();

    return () => controller.abort();
  }, [session]);

  useEffect(() => {
    if (!session) return;

    const channel = connectProject(session.apiKey);
    socket.current = channel;

    channel.on("connect", () => setRealtimeConnected(true));
    channel.on("disconnect", () => setRealtimeConnected(false));

    channel.on("node-added", (data) => {
      setNodes((current) =>
        current.some((node) => node.node_id === data.node_id)
          ? current
          : [
              ...current,
              {
                node_id: data.node_id,
                id_in_project: data.id_in_project,
                latitude: data.latitude,
                longitude: data.longitude,
              },
            ],
      );
    });

    channel.on("connection-added", (data) => {
      setConnections((current) =>
        current.some((edge) => edge.connection_id === data.connection_id)
          ? current
          : [
              ...current,
              {
                connection_id: data.connection_id,
                from_node_id: data.from_node_id,
                to_node_id: data.to_node_id,
                distance: data.distance,
                speed_limit: data.speed_limit,
              },
            ],
      );
    });

    channel.on("connection-updated", (data) => {
      setConnections((current) =>
        current.map((edge) =>
          edge.connection_id === data.connection_id
            ? { ...edge, distance: data.distance, speed_limit: data.speed_limit }
            : edge,
        ),
      );
    });

    channel.on("node-triggered", (data) => {
      flashSeq.current += 1;
      setFlash({ idInProject: data.id_in_project, seq: flashSeq.current });
    });

    channel.on("violation-added", (data) => {
      setViolations((current) => [data, ...current]);
      setLiveViolations((count) => count + 1);
    });

    channel.on("congestion-update", (data) => {
      setCongestion((current) => {
        const next = { ...current };
        for (const [id, ratio] of Object.entries(data)) next[Number(id)] = ratio;
        return next;
      });
    });

    channel.on("distance-driver-status", (data) => {
      setDriverConnected(data.connected);
    });

    return () => {
      channel.removeAllListeners();
      channel.disconnect();
      socket.current = null;
    };
  }, [session]);

  /* ---------------------------------------------------------------------
     Writes
     --------------------------------------------------------------------- */

  const createEdge = useCallback(
    (edge: { speedLimitKmh: number; distanceMeters?: number }) => {
      if (!draft) return;
      socket.current?.emit("create-connection", {
        from_node_id: draft.from.node_id,
        to_node_id: draft.to.node_id,
        speed_limit: edge.speedLimitKmh,
        ...(edge.distanceMeters === undefined
          ? {}
          : { distance: edge.distanceMeters }),
      });
      setDraft(null);
    },
    [draft],
  );

  const saveEdge = useCallback(
    (edge: { distanceMeters: number; speedLimitKmh: number }) => {
      if (!selected) return;
      socket.current?.emit("update-connection", {
        connection_id: selected.connection_id,
        distance: edge.distanceMeters,
        speed_limit: edge.speedLimitKmh,
      });

      // The server echoes `connection-updated` to the room, this tab included,
      // but the panel should not sit on a stale value while that round trip
      // happens.
      setConnections((current) =>
        current.map((row) =>
          row.connection_id === selected.connection_id
            ? {
                ...row,
                distance: edge.distanceMeters,
                speed_limit: edge.speedLimitKmh,
              }
            : row,
        ),
      );
      setSelected(null);
    },
    [selected],
  );

  const addCheckpoint = useCallback(
    async (position: { lat: number; lng: number }) => {
      if (!session) return;
      await createNode(session.apiKey, position);
      // The node arrives back over the realtime channel like any other.
    },
    [session],
  );

  const signOut = useCallback(() => {
    clearSession();
    router.push("/");
  }, [router]);

  /* ---------------------------------------------------------------------
     Keyboard
     --------------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === "Escape") {
        setSelected(null);
        setShowViolations(false);
        setShowSettings(false);
        return;
      }
      if (event.key === "+" || event.key === "=") canvas.current?.zoomBy(1.2);
      if (event.key === "-" || event.key === "_") canvas.current?.zoomBy(1 / 1.2);
      if (event.key === "f" || event.key === "F") canvas.current?.fit();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */

  if (session === undefined) {
    return (
      <>
        <Nav sticky={false} />
        <div className="console-shell bg-bg" />
      </>
    );
  }

  if (session === null) {
    return (
      <>
        <Nav sticky={false} />
        <ProjectGate />
      </>
    );
  }

  return (
    <>
      <Nav
        sticky={false}
        context={
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate font-display text-sm font-bold text-text">
              {session.project_name}
            </span>
            <DriverStatus connected={driverConnected} />
          </div>
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowSettings((open) => !open);
                setShowViolations(false);
              }}
            >
              Project
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setShowViolations((open) => !open);
                setShowSettings(false);
              }}
            >
              Violations
              {violations.length > 0 ? (
                <span className="ml-2 font-mono text-xs opacity-80">
                  {violations.length}
                </span>
              ) : null}
            </Button>
          </div>
        }
      />

      <div className="console-shell relative bg-bg">
        <GraphCanvas
          ref={canvas}
          nodes={nodes}
          connections={connections}
          congestionTargets={congestion}
          flash={flash}
          selectedConnectionId={selected?.connection_id ?? null}
          onSelectConnection={setSelected}
          onDraftEdge={setDraft}
        />

        {/* The overlay does not take pointer events; each control opts back in. */}
        <div className="pointer-events-none absolute inset-0 p-4">
          <div className="flex h-full flex-col justify-between">
            <div className="flex items-start justify-between gap-4">
              <div className="pointer-events-auto flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setAddingCheckpoint(true)}>
                  Add checkpoint
                </Button>
                <span className="hidden rounded-full border border-border bg-surface px-3.5 py-1.5 font-mono text-xs text-text-dim shadow-sm sm:inline">
                  {pluralise(nodes.length, "checkpoint")} ·{" "}
                  {pluralise(connections.length, "edge")}
                </span>
              </div>

              <CanvasControls
                onFit={() => canvas.current?.fit()}
                onZoomIn={() => canvas.current?.zoomBy(1.2)}
                onZoomOut={() => canvas.current?.zoomBy(1 / 1.2)}
              />
            </div>

            <div className="flex items-end justify-between gap-4">
              <GraphLegend />
              {selected ? (
                <ConnectionEditor
                  connection={selected}
                  nodes={nodes}
                  driverConnected={driverConnected}
                  onCancel={() => setSelected(null)}
                  onSave={saveEdge}
                />
              ) : (
                <p className="pointer-events-none hidden rounded-full border border-border bg-surface px-3.5 py-1.5 font-mono text-xs text-text-dim shadow-sm lg:inline">
                  Drag between checkpoints to link · click an edge to edit · F to frame
                </p>
              )}
            </div>
          </div>
        </div>

        {loaded && nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div className="pointer-events-auto max-w-md rounded-2xl border border-border bg-surface shadow-lg">
              <EmptyState
                title="No checkpoints yet"
                body="Cameras create checkpoints as they come online, over the REST API. You can also place one by coordinate to lay the graph out ahead of them."
                action={
                  <Button size="md" arrow onClick={() => setAddingCheckpoint(true)}>
                    Add checkpoint
                  </Button>
                }
              />
            </div>
          </div>
        ) : null}

        <SettingsPanel
          open={showSettings}
          onClose={() => setShowSettings(false)}
          session={session}
          nodeCount={nodes.length}
          connectionCount={connections.length}
          driverConnected={driverConnected}
          realtimeConnected={realtimeConnected}
          onSignOut={signOut}
        />

        <ViolationsPanel
          open={showViolations}
          onClose={() => setShowViolations(false)}
          violations={violations}
          liveCount={liveViolations}
        />
      </div>

      <NewConnectionDialog
        draft={draft}
        driverConnected={driverConnected}
        onClose={() => setDraft(null)}
        onCreate={createEdge}
      />

      <AddCheckpointDialog
        open={addingCheckpoint}
        onClose={() => setAddingCheckpoint(false)}
        onCreate={addCheckpoint}
      />
    </>
  );
}
