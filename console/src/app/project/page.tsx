"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AddCheckpointDialog from "@/components/console/AddCheckpointDialog";
import DiagnosticsPanel, {
  summariseNode,
} from "@/components/console/DiagnosticsPanel";
import GraphCanvas, {
  type EdgeDraft,
  type FlashSignal,
  type GraphCanvasHandle,
  type MoveDraft,
} from "@/components/console/GraphCanvas";
import MapView from "@/components/console/MapView";
import MoveCheckpointDialog from "@/components/console/MoveCheckpointDialog";
import NewConnectionDialog from "@/components/console/NewConnectionDialog";
import ProjectGate from "@/components/console/ProjectGate";
import SettingsPanel from "@/components/console/SettingsPanel";
import TestDrivePanel, {
  type TestDriveHandle,
  type VehicleFrame,
} from "@/components/console/TestDrivePanel";
import type { ConsoleView } from "@/components/console/ViewToggle";
import ViolationsPanel from "@/components/console/ViolationsPanel";
import SayesDock from "@/components/console/agent/SayesDock";
import type { ReplayMask } from "@/components/console/agent/cursors/replayMask";
import type { Highlights } from "@/components/console/agent/useAgent";
import { CamerasDrawer, SectionsDrawer } from "@/components/console/shell/Drawers";
import Inspector, { type Selection } from "@/components/console/shell/Inspector";
import { countBySection, countThisWeek } from "@/components/console/shell/model";
import { Menu, MenuDivider, MenuItem } from "@/components/console/shell/parts";
import Rail, { type DrawerId } from "@/components/console/shell/Rail";
import StatusBar from "@/components/console/shell/StatusBar";
import TopBar from "@/components/console/shell/TopBar";
import type { AgentUiControl } from "@/lib/agent";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import Nav from "@/components/ui/Nav";
import { PanelDock } from "@/components/ui/Panel";
import {
  createNode,
  getCameraPlaces,
  getConnections,
  getDemo,
  getDiagnostics,
  getDistanceDriverStatus,
  getGeometry,
  getMapDriverState,
  getNodes,
  getViolations,
  isEnforced,
  moveNode,
  removeConnection,
  removeNode,
  type CameraPlace,
  type CheckpointNode,
  type Connection,
  type Diagnostics,
  type MapDriverState,
  type PathGeometry,
  type Violation,
} from "@/lib/api";
import { haversineMeters, type LatLng } from "@/lib/geo";
import type { BridgeSelection, BridgeVehicle } from "@/lib/mapbridge";
import type { ConsoleSocket } from "@/lib/realtime";
import { connectProject } from "@/lib/realtime";
import { clearSession, useConsoleSession } from "@/lib/session";

/** A stable empty list, so the cursor layer is not re-run on every render. */
const NO_HIGHLIGHTS: Highlights = { connectionIds: [], nodeIds: [], caption: "" };

/** The drawer beside the rail, in px. The canvas frames what it leaves. */
const DRAWER_WIDTH = 360;

const DRAWER_KEYS: Record<string, DrawerId> = {
  "1": "cameras",
  "2": "sections",
  "3": "violations",
  "4": "quality",
  "5": "settings",
};

export default function ProjectConsolePage() {
  /* `undefined` is "not read yet", `null` is "read, and there is none". The
     difference matters: this page is prerendered at build time, where there is
     no storage, and it must not flash the unlock card at an operator who is
     already signed in. */
  const session = useConsoleSession();

  const [nodes, setNodes] = useState<CheckpointNode[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);

  /* A Cursor Lab replay draws the graph as it was before the replayed run,
     each change landing as its cursor clicks. Screen only: `nodes` and
     `connections` stay the real data, and only the canvas sees the mask. */
  const [replayMask, setReplayMask] = useState<ReplayMask | null>(null);
  const shownNodes = useMemo(() => {
    if (!replayMask) return nodes;
    return nodes
      .filter((n) => !replayMask.hiddenNodes.has(n.node_id))
      .map((n) => {
        const at = replayMask.nodeAt.get(n.node_id);
        return at ? { ...n, latitude: at.latitude, longitude: at.longitude } : n;
      });
  }, [nodes, replayMask]);
  const shownConnections = useMemo(() => {
    if (!replayMask) return connections;
    return connections
      .filter(
        (c) =>
          !replayMask.hiddenConnections.has(c.connection_id) &&
          !replayMask.hiddenNodes.has(c.from_node_id) &&
          !replayMask.hiddenNodes.has(c.to_node_id),
      )
      .map((c) => {
        const limit = replayMask.speedLimit.get(c.connection_id);
        return limit === undefined ? c : { ...c, speed_limit: limit };
      });
  }, [connections, replayMask]);

  const [violations, setViolations] = useState<Violation[]>([]);
  const [liveViolations, setLiveViolations] = useState(0);
  const [congestion, setCongestion] = useState<Record<number, number>>({});
  const [flash, setFlash] = useState<FlashSignal | null>(null);

  /* Quality is derived, never stored, and goes stale the moment a node
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

  /* Which street each camera is on, for labels and the drawers. */
  const [places, setPlaces] = useState<Record<string, CameraPlace>>({});
  const [basemap, setBasemap] = useState(true);

  /* A demo project can drive a test car between checkpoints. */
  const [isDemo, setIsDemo] = useState(false);
  const [testDriveOpen, setTestDriveOpen] = useState(false);
  const [picks, setPicks] = useState<{ start: number | null; end: number | null }>(
    { start: null, end: null },
  );
  const testDrive = useRef<TestDriveHandle>(null);
  const mapVehicle = useRef<((vehicle: BridgeVehicle) => void) | null>(null);

  /* One drawer beside the rail at a time. A selection shows the inspector in
     the same place, and closing it goes back to the drawer that was open. */
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [contextMenu, setContextMenu] = useState<{ at: LatLng | null; x: number; y: number } | null>(null);

  const [draft, setDraft] = useState<EdgeDraft | null>(null);
  const [moveDraft, setMoveDraft] = useState<MoveDraft | null>(null);
  const [addingCheckpoint, setAddingCheckpoint] = useState(false);
  const [placeAt, setPlaceAt] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  const router = useRouter();
  const canvas = useRef<GraphCanvasHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  const socket = useRef<ConsoleSocket | null>(null);
  const flashSeq = useRef(0);

  /* Sayes, the agent: one docked module. The page only draws what it highlights. */
  const [agentHighlights, setAgentHighlights] = useState<Highlights>(NO_HIGHLIGHTS);
  const [presentation, setPresentation] = useState(false);
  const togglePresentation = useCallback(() => setPresentation((on) => !on), []);
  /* Once a chat is under way the empty-network prompt would sit over its work. */
  const [agentActive, setAgentActive] = useState(false);
  const cameraOf = useCallback(
    (nodeId: number) => nodes.find((node) => node.node_id === nodeId)?.id_in_project,
    [nodes],
  );

  /* Presentation mode scales the whole page's type, so it lives on <html>. */
  useEffect(() => {
    const root = document.documentElement;
    if (presentation) root.dataset.presentation = "true";
    else delete root.dataset.presentation;
    return () => {
      delete root.dataset.presentation;
    };
  }, [presentation]);

  const selectedConnection =
    selection?.kind === "section"
      ? connections.find((edge) => edge.connection_id === selection.connectionId) ?? null
      : null;
  const selectedNode =
    selection?.kind === "camera"
      ? nodes.find((node) => node.node_id === selection.nodeId) ?? null
      : null;
  /* A selection whose camera or section went away is no selection. */
  const inspecting: Selection | null = selectedNode || selectedConnection ? selection : null;
  const drawerOpen = drawer !== null || inspecting !== null;

  /* The canvas frames only what the drawer leaves; GraphCanvas reads this. */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--drawer-inset", drawerOpen ? `${DRAWER_WIDTH}px` : "0px");
    return () => {
      root.style.removeProperty("--drawer-inset");
    };
  }, [drawerOpen]);

  /* A drawer opening or closing reframes the network into the space left,
     unless a selection is about to frame what it is about. */
  const framedFor = useRef(false);
  useEffect(() => {
    if (framedFor.current === drawerOpen) return;
    framedFor.current = drawerOpen;
    if (!selection) canvas.current?.frame([], 450);
  }, [drawerOpen, selection]);

  /* ---------------------------------------------------------------------
     The first read, then the live channel
     --------------------------------------------------------------------- */

  useEffect(() => {
    if (!session) return;

    const controller = new AbortController();
    const { project_id: projectId, apiKey } = session;

    void (async () => {
      const [nodeRows, edgeRows, violationRows, driver, quality, map, demo] =
        await Promise.all([
          getNodes(projectId, apiKey, controller.signal).catch(() => []),
          getConnections(projectId, apiKey, controller.signal).catch(() => []),
          getViolations(projectId, apiKey, controller.signal).catch(() => []),
          getDistanceDriverStatus(projectId, apiKey, controller.signal).catch(
            () => ({
              connected: false,
            }),
          ),
          getDiagnostics(projectId, apiKey, controller.signal).catch(
            () => null,
          ),
          getMapDriverState(projectId, apiKey, controller.signal).catch(
            () => null,
          ),
          getDemo(projectId, apiKey, controller.signal).catch(() => null),
        ]);

      if (controller.signal.aborted) return;
      setNodes(nodeRows);
      setConnections(edgeRows);
      setViolations(violationRows);
      setDriverConnected(driver.connected);
      if (map) setMapDriver(map);
      setIsDemo(demo?.is_demo === true);
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
      // A driver answers before the edge is created, so a new edge can arrive
      // with its road shape already stored. Only a measured edge can have one.
      if (data.distance_status === "ok") {
        setGeometryVersion((version) => version + 1);
      }
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

    channel.on("connection-removed", (data) => {
      setConnections((current) =>
        current.filter((edge) => edge.connection_id !== data.connection_id),
      );
      setGeometryVersion((version) => version + 1);
    });

    channel.on("node-removed", (data) => {
      setNodes((current) => current.filter((node) => node.node_id !== data.node_id));
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
        for (const [id, ratio] of Object.entries(data))
          next[Number(id)] = ratio;
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
     Street names
     --------------------------------------------------------------------- */

  /* Re-read whenever a camera appears, moves or goes; never per frame. */
  const placesKey = useMemo(
    () => nodes.map((n) => `${n.node_id}:${n.latitude.toFixed(5)},${n.longitude.toFixed(5)}`).join("|"),
    [nodes],
  );

  useEffect(() => {
    if (!session || !placesKey) return;
    const controller = new AbortController();
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;

    const read = async () => {
      try {
        const rows = await getCameraPlaces(session.project_id, session.apiKey, controller.signal);
        if (controller.signal.aborted) return;
        setPlaces(rows);
        // Streets outside the demo list come from OpenStreetMap in the
        // background, so a pending one is asked for again shortly.
        tries += 1;
        if (tries < 6 && Object.values(rows).some((place) => place.source === "pending")) {
          timer = setTimeout(() => void read(), 2500);
        }
      } catch {
        // Labels are a convenience; the graph works without them.
      }
    };
    timer = setTimeout(() => void read(), 300);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session, placesKey]);

  /** node_id -> "Street · near Landmark", for the canvas. */
  const nodeLabels = useMemo(() => {
    const labels: Record<number, string> = {};
    for (const [id, place] of Object.entries(places)) {
      if (place.street) labels[Number(id)] = place.near ? `${place.street} · near ${place.near}` : place.street;
    }
    return labels;
  }, [places]);

  /* ---------------------------------------------------------------------
     The map view
     --------------------------------------------------------------------- */

  /** An approved address with nothing serving it is not a view. */
  const mapAvailable = mapDriver.status === "approved" && mapDriver.connected;

  /* A view the operator chose, honoured whenever it is actually there. A map
     driver that drops falls back to the graph without anything to dismiss, and
     one that comes back picks up where it was, because falling back was never
     a decision the operator made. */
  const activeView: ConsoleView =
    view === "map" && mapAvailable ? "map" : "graph";
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

  /** An edge chosen on the map opens the same inspector a click on the graph does. */
  const selectFromMap = useCallback(
    (picked: BridgeSelection) => {
      if (picked.kind === "node" && testDriveOpen) {
        testDrive.current?.pick(picked.id);
        return;
      }
      if (picked.kind === "edge") setSelection({ kind: "section", connectionId: picked.id });
      else if (picked.kind === "node") setSelection({ kind: "camera", nodeId: picked.id });
      else if (picked.kind === null) setSelection(null);
    },
    [testDriveOpen],
  );

  /** The test car, drawn by whichever views exist. Called every frame. */
  const showVehicle = useCallback((vehicle: VehicleFrame | null) => {
    canvas.current?.setVehicle(
      vehicle
        ? {
            fromNodeId: vehicle.fromNodeId,
            toNodeId: vehicle.toNodeId,
            t: vehicle.t,
            label: vehicle.label,
            violation: vehicle.violation,
          }
        : null,
    );
    mapVehicle.current?.(
      vehicle
        ? {
            position: vehicle.position,
            label: vehicle.label,
            violation: vehicle.violation,
          }
        : { position: null, label: "", violation: false },
    );
  }, []);

  const changeDemo = useCallback((next: boolean) => {
    setIsDemo(next);
    if (!next) setTestDriveOpen(false);
  }, []);

  /** The add dialog, blank from a button or pre-filled from a right-click. */
  const openAddCheckpoint = useCallback(
    (position: { lat: number; lng: number } | null) => {
      setPlaceAt(position);
      setAddingCheckpoint(true);
    },
    [],
  );

  /**
   * A checkpoint dragged on the basemap.
   *
   * It goes through the same confirmation and the same endpoint as a drag on
   * the graph: the map is where a bad GPS fix becomes obvious, but it is still
   * a camera's real position and every distance measured to it still stops
   * being true. The map driver proposes; nothing here writes on its say-so.
   */
  const proposeMove = useCallback(
    (nodeId: number, to: { lat: number; lng: number }) => {
      // A test drive picks checkpoints; it never moves them.
      if (testDriveOpen) return;
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
    [nodes, testDriveOpen],
  );

  /* ---------------------------------------------------------------------
     Quality
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

  /* ---------------------------------------------------------------------
     Selection and drawers
     --------------------------------------------------------------------- */

  /** Brings these cameras into the part of the canvas the drawer leaves. */
  const frameNodes = useCallback(
    (ids: number[]) => {
      const points = nodes
        .filter((node) => ids.includes(node.node_id))
        .map((node) => ({ lat: node.latitude, lng: node.longitude }));
      if (points.length > 0) canvas.current?.focus(points, 600);
    },
    [nodes],
  );

  /** Selects from a list: frames the camera with its neighbours, or the section. */
  const pickFromList = useCallback(
    (next: Selection) => {
      setSelection(next);
      if (next.kind === "section") {
        const edge = connections.find((c) => c.connection_id === next.connectionId);
        if (edge) frameNodes([edge.from_node_id, edge.to_node_id]);
      } else {
        const around = connections
          .filter((c) => c.from_node_id === next.nodeId || c.to_node_id === next.nodeId)
          .flatMap((c) => [c.from_node_id, c.to_node_id]);
        frameNodes([next.nodeId, ...around]);
      }
    },
    [connections, frameNodes],
  );

  /** Selects from the canvas: the view stays put unless the drawer would cover it. */
  const pickOnCanvas = useCallback(
    (next: Selection) => {
      setSelection(next);
      const ids =
        next.kind === "camera"
          ? [next.nodeId]
          : (() => {
              const edge = connections.find((c) => c.connection_id === next.connectionId);
              return edge ? [edge.from_node_id, edge.to_node_id] : [];
            })();
      const left = (stage.current?.getBoundingClientRect().left ?? 0) + DRAWER_WIDTH + 24;
      const hidden = ids.some((id) => {
        const at = canvas.current?.nodeToClient(id);
        return at ? at.x < left : false;
      });
      if (hidden) frameNodes(ids);
    },
    [connections, frameNodes],
  );

  const toggleDrawer = useCallback(
    (next: DrawerId) => {
      setContextMenu(null);
      setSelection(null);
      const opening = !(drawer === next && !inspecting);
      setDrawer(opening ? next : null);
      // Opening Quality is the "on demand" in "recompute on demand": what is
      // on screen was true when it was fetched, and a node may have moved.
      if (opening && next === "quality") void recheck();
    },
    [drawer, inspecting, recheck],
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
    (target: Connection, edge: { distanceMeters?: number; speedLimitKmh: number }) => {
      // An omitted distance means "leave it and its status alone" - the case
      // where a driver owns the number, or where nobody has resolved it yet.
      socket.current?.emit("update-connection", {
        connection_id: target.connection_id,
        ...(edge.distanceMeters === undefined
          ? {}
          : { distance: edge.distanceMeters }),
        speed_limit: edge.speedLimitKmh,
      });

      // The server echoes `connection-updated` to the room, this tab included,
      // but the inspector should not sit on a stale value while that round
      // trip happens.
      setConnections((current) =>
        current.map((row) =>
          row.connection_id === target.connection_id
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
    },
    [],
  );

  /* Removal goes through the same endpoints as Sayes: deleted when nothing was
     ever recorded on it, retired otherwise. The realtime channel echoes it. */
  const removeCamera = useCallback(
    async (node: CheckpointNode) => {
      if (!session) return;
      await removeNode(session.apiKey, node.node_id);
    },
    [session],
  );

  const removeSection = useCallback(
    async (edge: Connection) => {
      if (!session) return;
      await removeConnection(session.apiKey, edge.connection_id);
    },
    [session],
  );

  /* What Sayes asks the console to show. Display only; changes nothing. */
  const agentControl = useCallback(
    (control: AgentUiControl) => {
      if (control.action === "view") {
        openView(control.view);
      } else if (control.action === "panel") {
        setSelection(null);
        setDrawer(control.panel === "none" ? null : control.panel);
        if (control.panel === "quality") void recheck();
      } else if (control.action === "frame") {
        const ids = new Set(control.node_ids);
        for (const edge of connections) {
          if (control.connection_ids.includes(edge.connection_id)) {
            ids.add(edge.from_node_id);
            ids.add(edge.to_node_id);
          }
        }
        const points = nodes
          .filter((node) => ids.has(node.node_id))
          .map((node) => ({ lat: node.latitude, lng: node.longitude }));
        if (points.length > 0) canvas.current?.focus(points, 700);
        else canvas.current?.frame([], 700);
      }
    },
    [connections, nodes, openView, recheck],
  );

  /** node_id -> the one-line reason, for the mark on the canvas. */
  const nodeWarnings = useMemo(() => {
    const warnings: Record<number, string> = {};
    for (const node of diagnostics?.nodes ?? []) {
      if (node.flags.length > 0) warnings[node.node_id] = summariseNode(node);
    }
    return warnings;
  }, [diagnostics]);

  const flaggedCount = Object.keys(nodeWarnings).length;
  const counts = useMemo(() => countBySection(violations), [violations]);
  const violationsThisWeek = useMemo(() => countThisWeek(violations), [violations]);
  const unmeasured = connections.filter((edge) => !isEnforced(edge)).length;

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

  const toggleTestDrive = useCallback(() => {
    setTestDriveOpen((open) => !open);
    setPicks({ start: null, end: null });
    setSelection(null);
  }, []);

  /* ---------------------------------------------------------------------
     Keyboard
     --------------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      // Esc closes the nearest thing first: the menu, then the selection,
      // then the drawer.
      if (event.key === "Escape") {
        if (contextMenu) setContextMenu(null);
        else if (moveDraft) cancelMove();
        else if (inspecting) setSelection(null);
        else setDrawer(null);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const drawerKey = DRAWER_KEYS[event.key];
      if (drawerKey) {
        toggleDrawer(drawerKey);
        return;
      }
      if (event.key === "+" || event.key === "=") canvas.current?.zoomBy(1.2);
      if (event.key === "-" || event.key === "_")
        canvas.current?.zoomBy(1 / 1.2);
      if (event.key === "f" || event.key === "F") canvas.current?.fit();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelMove, contextMenu, inspecting, moveDraft, toggleDrawer]);

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */

  if (session === undefined) {
    return <div className="h-dvh bg-bg" />;
  }

  if (session === null) {
    return (
      <>
        <Nav sticky={false} />
        <ProjectGate />
      </>
    );
  }

  const showingCaption =
    agentHighlights.caption &&
    (agentHighlights.connectionIds.length > 0 || agentHighlights.nodeIds.length > 0);

  return (
    <div className="console-app flex h-dvh flex-col overflow-hidden bg-bg">
      <TopBar
        session={session}
        isDemo={isDemo}
        driverConnected={driverConnected}
        realtimeConnected={realtimeConnected}
        mapDriver={mapDriver}
        view={activeView}
        mapAvailable={mapAvailable}
        mapUnavailableReason={
          mapDriver.status === "approved"
            ? "The approved map driver is not running."
            : mapDriver.pending_url
              ? "A map driver is waiting to be approved, under Settings."
              : "No map driver has offered a map view for this project."
        }
        onView={openView}
        presentation={presentation}
        onTogglePresentation={togglePresentation}
        onSignOut={signOut}
      />

      <div className="relative flex min-h-0 flex-1">
        <Rail
          drawer={inspecting ? null : drawer}
          onDrawer={toggleDrawer}
          violationsThisWeek={violationsThisWeek}
          flagged={flaggedCount}
          isDemo={isDemo}
          testDriveOpen={testDriveOpen}
          onTestDrive={toggleTestDrive}
        />

        <div ref={stage} className="relative min-w-0 flex-1 overflow-hidden" data-cursor-stage>
          <GraphCanvas
            ref={canvas}
            nodes={shownNodes}
            connections={shownConnections}
            congestionTargets={congestion}
            flash={flash}
            nodeWarnings={nodeWarnings}
            selectedConnectionId={selectedConnection?.connection_id ?? null}
            selectedNodeId={selectedNode?.node_id ?? null}
            nodeLabels={nodeLabels}
            basemap={basemap}
            onSelectConnection={(edge) => {
              setContextMenu(null);
              if (edge) pickOnCanvas({ kind: "section", connectionId: edge.connection_id });
              else setSelection(null);
            }}
            onDraftEdge={setDraft}
            onDraftMove={setMoveDraft}
            highlightedConnectionIds={agentHighlights.connectionIds}
            highlightedNodeIds={agentHighlights.nodeIds}
            showHover={!presentation}
            onClickNode={(node) => {
              setContextMenu(null);
              if (testDriveOpen) testDrive.current?.pick(node.node_id);
              else pickOnCanvas({ kind: "camera", nodeId: node.node_id });
            }}
            onContextMenu={(at, client) => {
              if (testDriveOpen) return;
              setContextMenu({ at, x: client.x, y: client.y });
            }}
            pickMode={testDriveOpen}
            picks={testDriveOpen ? picks : undefined}
          />

          {showingCaption ? (
            <div
              className="sayes-clear pointer-events-none absolute top-4 z-10 flex justify-center"
              style={{ left: "var(--drawer-inset, 0px)", right: "var(--sayes-inset, 0px)" }}
            >
              <span data-cursor-avoid className="rounded-full border border-cyan bg-surface px-4 py-1.5 text-sm font-medium text-cyan-dark shadow-sm">
                {agentHighlights.caption}
              </span>
            </div>
          ) : null}

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
              selectedConnectionId={selectedConnection?.connection_id ?? null}
              onSelect={selectFromMap}
              onNodeMoved={proposeMove}
              onPlace={openAddCheckpoint}
              vehicleSinkRef={mapVehicle}
              mode={{
                testDrive: testDriveOpen,
                start: testDriveOpen ? picks.start : null,
                end: testDriveOpen ? picks.end : null,
              }}
            />
          ) : null}

          {testDriveOpen && isDemo ? (
            <div
              className="pointer-events-none absolute inset-0 z-20 flex items-end p-4"
              style={{ paddingLeft: "calc(1rem + var(--drawer-inset, 0px))" }}
            >
              <TestDrivePanel
                ref={testDrive}
                apiKey={session.apiKey}
                nodes={nodes}
                connections={connections}
                geometry={geometry}
                onVehicle={showVehicle}
                onPicks={setPicks}
                onClose={() => setTestDriveOpen(false)}
              />
            </div>
          ) : null}

          {loaded &&
          nodes.length === 0 &&
          activeView === "graph" &&
          !presentation &&
          !agentActive ? (
            <div
              className="sayes-clear pointer-events-none absolute inset-y-0 flex items-center justify-center p-6"
              style={{ left: "var(--drawer-inset, 0px)", right: "var(--sayes-inset, 0px)" }}
            >
              <div className="pointer-events-auto max-w-md rounded-2xl border border-border bg-surface shadow-lg">
                <EmptyState
                  title="No cameras yet"
                  body="Cameras create checkpoints as they come online, over the REST API. You can also place one by coordinate, right-click the canvas, or ask Sayes to lay the network out."
                  action={
                    <Button size="md" arrow onClick={() => openAddCheckpoint(null)}>
                      Add camera
                    </Button>
                  }
                />
              </div>
            </div>
          ) : null}

          <PanelDock.Provider value>
            <CamerasDrawer
              open={drawer === "cameras" && !inspecting}
              onClose={() => setDrawer(null)}
              nodes={nodes}
              connections={connections}
              places={places}
              warnings={nodeWarnings}
              onPick={(node) => pickFromList({ kind: "camera", nodeId: node.node_id })}
              onAdd={() => openAddCheckpoint(null)}
            />
            <SectionsDrawer
              open={drawer === "sections" && !inspecting}
              onClose={() => setDrawer(null)}
              nodes={nodes}
              connections={connections}
              places={places}
              counts={counts}
              cameraOf={cameraOf}
              onPick={(edge) => pickFromList({ kind: "section", connectionId: edge.connection_id })}
            />
            <ViolationsPanel
              open={drawer === "violations" && !inspecting}
              onClose={() => setDrawer(null)}
              violations={violations}
              liveCount={liveViolations}
              connections={connections}
              cameraOf={cameraOf}
            />
            <DiagnosticsPanel
              open={drawer === "quality" && !inspecting}
              onClose={() => setDrawer(null)}
              diagnostics={diagnostics}
              checkedAt={checkedAt}
              busy={checking}
              error={checkError}
              onRecheck={() => void recheck()}
            />
            <SettingsPanel
              open={drawer === "settings" && !inspecting}
              onClose={() => setDrawer(null)}
              session={session}
              nodeCount={nodes.length}
              connectionCount={connections.length}
              driverConnected={driverConnected}
              realtimeConnected={realtimeConnected}
              mapDriver={mapDriver}
              onMapDriverChange={setMapDriver}
              isDemo={isDemo}
              onDemoChange={changeDemo}
              onSignOut={signOut}
            />
            <Inspector
              selection={inspecting}
              onClose={() => setSelection(null)}
              onSelect={pickFromList}
              nodes={nodes}
              connections={connections}
              places={places}
              counts={counts}
              warnings={nodeWarnings}
              cameraOf={cameraOf}
              driverConnected={driverConnected}
              onMove={(node, to) => proposeMove(node.node_id, to)}
              onRemoveCamera={removeCamera}
              onRemoveSection={removeSection}
              onSaveSection={saveEdge}
            />
          </PanelDock.Provider>

          {contextMenu ? (
            <Menu
              onClose={() => setContextMenu(null)}
              className="fixed w-56"
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <MenuItem
                onClick={() => {
                  const at = contextMenu.at;
                  setContextMenu(null);
                  openAddCheckpoint(at ? { lat: at.lat, lng: at.lng } : null);
                }}
              >
                Add camera here
              </MenuItem>
              <MenuItem
                hint="F"
                onClick={() => {
                  setContextMenu(null);
                  canvas.current?.fit();
                }}
              >
                Fit the network
              </MenuItem>
              {contextMenu.at ? (
                <>
                  <MenuDivider />
                  <MenuItem
                    hint={`${contextMenu.at.lat.toFixed(5)}, ${contextMenu.at.lng.toFixed(5)}`}
                    onClick={() => {
                      const at = contextMenu.at;
                      setContextMenu(null);
                      if (at) void navigator.clipboard?.writeText(`${at.lat.toFixed(6)}, ${at.lng.toFixed(6)}`);
                    }}
                  >
                    Copy
                  </MenuItem>
                </>
              ) : null}
            </Menu>
          ) : null}
        </div>

        <SayesDock
          projectId={session.project_id}
          apiKey={session.apiKey}
          canvas={canvas}
          cameraOf={cameraOf}
          presentation={presentation}
          onTogglePresentation={togglePresentation}
          onHighlights={setAgentHighlights}
          onActiveChange={setAgentActive}
          onControl={agentControl}
          onReplayMask={setReplayMask}
        />
      </div>

      <StatusBar
        canvas={canvas}
        cameras={nodes.length}
        sections={connections.length}
        unmeasured={unmeasured}
        violationsThisWeek={violationsThisWeek}
        graph={activeView === "graph"}
        basemap={basemap}
        onBasemap={setBasemap}
        hints={!presentation}
      />

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
        initialPosition={placeAt}
        onClose={() => setAddingCheckpoint(false)}
        onCreate={addCheckpoint}
      />
    </div>
  );
}
