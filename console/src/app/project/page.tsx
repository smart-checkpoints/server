"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AddCheckpointDialog from "@/components/console/AddCheckpointDialog";
import CanvasControls from "@/components/console/CanvasControls";
import ConnectionEditor from "@/components/console/ConnectionEditor";
import DiagnosticsPanel, {
  summariseNode,
} from "@/components/console/DiagnosticsPanel";
import DriverStatus from "@/components/console/DriverStatus";
import GraphCanvas, {
  type EdgeDraft,
  type FlashSignal,
  type GraphCanvasHandle,
  type MoveDraft,
} from "@/components/console/GraphCanvas";
import GraphLegend from "@/components/console/GraphLegend";
import MapView from "@/components/console/MapView";
import MoveCheckpointDialog from "@/components/console/MoveCheckpointDialog";
import NewConnectionDialog from "@/components/console/NewConnectionDialog";
import ProjectGate from "@/components/console/ProjectGate";
import SettingsPanel from "@/components/console/SettingsPanel";
import ViewToggle, { type ConsoleView } from "@/components/console/ViewToggle";
import ViolationsPanel from "@/components/console/ViolationsPanel";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Nav from "@/components/ui/Nav";
import {
  createNode,
  getConnections,
  getDiagnostics,
  getDistanceDriverStatus,
  getGeometry,
  getMapDriverState,
  getNodes,
  getViolations,
  moveNode,
  type CheckpointNode,
  type Connection,
  type Diagnostics,
  type MapDriverState,
  type PathGeometry,
  type Violation,
} from "@/lib/api";
import { pluralise } from "@/lib/format";
import { haversineMeters } from "@/lib/geo";
import type { BridgeSelection } from "@/lib/mapbridge";
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

  /* Data quality is derived, never stored, and goes stale the moment a node
     moves - so it is held here for exactly as long as it is being looked at,
     and recomputed rather than updated. */
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const [driverConnected, setDriverConnected] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  /* The map view is a separate process rendering the same geometry in an
     iframe. It only exists when a map driver has announced an address and an
     operator has approved it; the graph view needs none of that and is the
     fallback whenever any part of it is missing. */
  const [mapDriver, setMapDriver] = useState<MapDriverState>({
    connected: false,
    status: "none",
    url: null,
    origin: null,
    pending_url: null,
  });
  const [view, setView] = useState<ConsoleView>("graph");
  const [mapEverOpened, setMapEverOpened] = useState(false);
  const [geometry, setGeometry] = useState<Record<number, PathGeometry>>({});
  /* Bumped whenever an edge changes, to re-read the road shapes once the
     changes stop arriving rather than once per edge. */
  const [geometryVersion, setGeometryVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const [selected, setSelected] = useState<Connection | null>(null);
  const [draft, setDraft] = useState<EdgeDraft | null>(null);
  const [moveDraft, setMoveDraft] = useState<MoveDraft | null>(null);
  const [showViolations, setShowViolations] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
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
      const [nodeRows, edgeRows, violationRows, driver, quality, map] =
        await Promise.all([
          getNodes(projectId, apiKey, controller.signal).catch(() => []),
          getConnections(projectId, apiKey, controller.signal).catch(() => []),
          getViolations(projectId, apiKey, controller.signal).catch(() => []),
          getDistanceDriverStatus(projectId, apiKey, controller.signal).catch(() => ({
            connected: false,
          })),
          getDiagnostics(projectId, apiKey, controller.signal).catch(() => null),
          getMapDriverState(projectId, apiKey, controller.signal).catch(() => null),
        ]);

      if (controller.signal.aborted) return;
      setNodes(nodeRows);
      setConnections(edgeRows);
      setViolations(violationRows);
      setDriverConnected(driver.connected);
      if (map) setMapDriver(map);
      if (quality) {
        setDiagnostics(quality);
        setCheckedAt(Date.now());
      }
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

    channel.on("node-moved", (data) => {
      setNodes((current) =>
        current.map((node) =>
          node.node_id === data.node_id
            ? { ...node, latitude: data.latitude, longitude: data.longitude }
            : node,
        ),
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
                distance_status: data.distance_status,
              },
            ],
      );
    });

    channel.on("connection-updated", (data) => {
      // The geometry lives behind its own endpoint, so an edge changing is
      // notice that the road shape may have changed with it.
      setGeometryVersion((version) => version + 1);
      setConnections((current) =>
        current.map((edge) =>
          edge.connection_id === data.connection_id
            ? {
                ...edge,
                distance: data.distance,
                speed_limit: data.speed_limit,
                distance_status: data.distance_status,
              }
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

    channel.on("map-driver-status", (data) => {
      setMapDriver(data);
    });

    return () => {
      channel.removeAllListeners();
      channel.disconnect();
      socket.current = null;
    };
  }, [session]);

  /* ---------------------------------------------------------------------
     The map view
     --------------------------------------------------------------------- */

  /** An approved address with nothing serving it is not a view. */
  const mapAvailable = mapDriver.status === "approved" && mapDriver.connected;

  /* A view the operator chose, honoured whenever it is actually there. A map
     driver that drops falls back to the graph without anything to dismiss, and
     one that comes back picks up where it was, because falling back was never
     a decision the operator made. */
  const activeView: ConsoleView = view === "map" && mapAvailable ? "map" : "graph";
  const mapMounted = mapAvailable && mapEverOpened;

  /**
   * Road shapes, read only once something is drawing them.
   *
   * Geometry is up to a quarter of a megabyte an edge, the graph view draws
   * none of it, and most sessions never open a map - so it is not part of the
   * project load. Edge changes arrive in bursts (every driver connection
   * recalculates), and the timer coalesces a burst into one read.
   */
  useEffect(() => {
    if (!session || !mapMounted) return;

    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const rows = await getGeometry(
              session.project_id,
              session.apiKey,
              controller.signal,
            );
            if (controller.signal.aborted) return;
            const next: Record<number, PathGeometry> = {};
            for (const row of rows) next[row.connection_id] = row.path;
            setGeometry(next);
          } catch {
            // The map draws what it has. A failed read is not worth a dialog
            // over a layer that is decoration on top of the same graph.
          }
        })();
      },
      geometryVersion === 0 ? 0 : 500,
    );

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session, mapMounted, geometryVersion]);

  const openView = useCallback((next: ConsoleView) => {
    setView(next);
    // The frame is mounted on first use and never unmounted again: hiding it
    // costs nothing, and re-creating it re-downloads every tile.
    if (next === "map") setMapEverOpened(true);
  }, []);

  /** An edge chosen on the map opens the same editor a click on the graph does. */
  const selectFromMap = useCallback(
    (selection: BridgeSelection) => {
      if (selection.kind === "edge") {
        setSelected(
          connections.find((edge) => edge.connection_id === selection.id) ?? null,
        );
        return;
      }
      if (selection.kind === null) setSelected(null);
    },
    [connections],
  );

  /**
   * A checkpoint dragged on the basemap.
   *
   * It goes through the same confirmation and the same endpoint as a drag on
   * the graph: the map is where a bad GPS fix becomes obvious, but it is still
   * a camera's real position and every distance measured to it still stops
   * being true. The map driver proposes; nothing here writes on its say-so.
   */
  const moveFromMap = useCallback(
    (nodeId: number, to: { lat: number; lng: number }) => {
      const node = nodes.find((candidate) => candidate.node_id === nodeId);
      if (!node) return;
      setMoveDraft({
        node,
        to,
        metres: haversineMeters(
          { lat: node.latitude, lng: node.longitude },
          to,
        ),
      });
    },
    [nodes],
  );

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
    (edge: { distanceMeters?: number; speedLimitKmh: number }) => {
      if (!selected) return;
      // An omitted distance means "leave it and its status alone" - the case
      // where a driver owns the number, or where nobody has resolved it yet.
      socket.current?.emit("update-connection", {
        connection_id: selected.connection_id,
        ...(edge.distanceMeters === undefined
          ? {}
          : { distance: edge.distanceMeters }),
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
                speed_limit: edge.speedLimitKmh,
                ...(edge.distanceMeters === undefined
                  ? {}
                  : {
                      distance: edge.distanceMeters,
                      distance_status: "ok" as const,
                    }),
              }
            : row,
        ),
      );
      setSelected(null);
    },
    [selected],
  );

  /* ---------------------------------------------------------------------
     Data quality
     --------------------------------------------------------------------- */

  const recheck = useCallback(async () => {
    if (!session) return;
    setChecking(true);
    try {
      const result = await getDiagnostics(session.project_id, session.apiKey);
      setDiagnostics(result);
      setCheckedAt(Date.now());
      setCheckError(null);
    } catch (err) {
      setCheckError(
        err instanceof Error ? err.message : "The check could not be run",
      );
    } finally {
      setChecking(false);
    }
  }, [session]);

  /** node_id -> the one-line reason, for the mark on the canvas. */
  const nodeWarnings = useMemo(() => {
    const warnings: Record<number, string> = {};
    for (const node of diagnostics?.nodes ?? []) {
      if (node.flags.length > 0) warnings[node.node_id] = summariseNode(node);
    }
    return warnings;
  }, [diagnostics]);

  const flaggedCount = Object.keys(nodeWarnings).length;

  /**
   * Commits a dragged checkpoint.
   *
   * The new position, and every edge that just stopped enforcing because of
   * it, arrive back over the realtime channel; there is nothing to apply
   * optimistically here, and pretending otherwise would show distances that
   * are about to be thrown away. The preview on the canvas is dropped either
   * way, because from here on the canvas is drawing what the server says.
   */
  const commitMove = useCallback(
    async (move: MoveDraft) => {
      if (!session) return;
      await moveNode(session.apiKey, move.node.node_id, move.to);
      canvas.current?.clearMove();
      setMoveDraft(null);
    },
    [session],
  );

  const cancelMove = useCallback(() => {
    canvas.current?.clearMove();
    setMoveDraft(null);
  }, []);

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
        cancelMove();
        setShowViolations(false);
        setShowDiagnostics(false);
        setShowSettings(false);
        return;
      }
      if (event.key === "+" || event.key === "=") canvas.current?.zoomBy(1.2);
      if (event.key === "-" || event.key === "_") canvas.current?.zoomBy(1 / 1.2);
      if (event.key === "f" || event.key === "F") canvas.current?.fit();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelMove]);

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
            <ViewToggle
              view={activeView}
              onChange={openView}
              mapAvailable={mapAvailable}
              mapUnavailableReason={
                mapDriver.status === "approved"
                  ? "The approved map driver is not running."
                  : mapDriver.pending_url
                    ? "A map driver is waiting to be approved, under Project."
                    : "No map driver has offered a map view for this project."
              }
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowSettings((open) => !open);
                setShowViolations(false);
                setShowDiagnostics(false);
              }}
            >
              Project
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                // Opening the panel is the "on demand" in "recompute on
                // demand": what is on screen was true when it was fetched,
                // and a node may have moved since.
                const opening = !showDiagnostics;
                setShowDiagnostics(opening);
                setShowViolations(false);
                setShowSettings(false);
                if (opening) void recheck();
              }}
            >
              Data quality
              {flaggedCount > 0 ? (
                <span className="ml-2 font-mono text-xs opacity-80">
                  {flaggedCount}
                </span>
              ) : null}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setShowViolations((open) => !open);
                setShowSettings(false);
                setShowDiagnostics(false);
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
          nodeWarnings={nodeWarnings}
          selectedConnectionId={selected?.connection_id ?? null}
          onSelectConnection={setSelected}
          onDraftEdge={setDraft}
          onDraftMove={setMoveDraft}
        />

        {mapMounted && mapDriver.url && mapDriver.origin ? (
          <MapView
            active={activeView === "map"}
            projectId={session.project_id}
            url={mapDriver.url}
            origin={mapDriver.origin}
            nodes={nodes}
            connections={connections}
            geometry={geometry}
            congestion={congestion}
            diagnostics={diagnostics}
            selectedConnectionId={selected?.connection_id ?? null}
            onSelect={selectFromMap}
            onNodeMoved={moveFromMap}
          />
        ) : null}

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

              {/* Framing and zooming are the graph's own; the map has its own. */}
              {activeView === "graph" ? (
                <CanvasControls
                  onFit={() => canvas.current?.fit()}
                  onZoomIn={() => canvas.current?.zoomBy(1.2)}
                  onZoomOut={() => canvas.current?.zoomBy(1 / 1.2)}
                />
              ) : null}
            </div>

            <div className="flex items-end justify-between gap-4">
              {activeView === "graph" ? <GraphLegend /> : <span />}
              {selected ? (
                <ConnectionEditor
                  connection={selected}
                  nodes={nodes}
                  driverConnected={driverConnected}
                  onCancel={() => setSelected(null)}
                  onSave={saveEdge}
                />
              ) : activeView === "graph" ? (
                <p className="pointer-events-none hidden rounded-full border border-border bg-surface px-3.5 py-1.5 font-mono text-xs text-text-dim shadow-sm lg:inline">
                  Drag between checkpoints to link · shift-drag to move one · F to frame
                </p>
              ) : null}
            </div>
          </div>
        </div>

        {loaded && nodes.length === 0 && activeView === "graph" ? (
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
          mapDriver={mapDriver}
          onMapDriverChange={setMapDriver}
          onSignOut={signOut}
        />

        <DiagnosticsPanel
          open={showDiagnostics}
          onClose={() => setShowDiagnostics(false)}
          diagnostics={diagnostics}
          checkedAt={checkedAt}
          busy={checking}
          error={checkError}
          onRecheck={() => void recheck()}
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

      <MoveCheckpointDialog
        draft={moveDraft}
        connections={connections}
        onClose={cancelMove}
        onConfirm={commitMove}
      />

      <AddCheckpointDialog
        open={addingCheckpoint}
        onClose={() => setAddingCheckpoint(false)}
        onCreate={addCheckpoint}
      />
    </>
  );
}
