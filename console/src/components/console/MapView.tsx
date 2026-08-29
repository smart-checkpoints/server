"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BRIDGE_VERSION,
  postToMap,
  readMapMessage,
  type BridgeEdge,
  type BridgeNode,
  type BridgeSelection,
  type MapCapabilities,
  type PathGeometry,
} from "@/lib/mapbridge";
import type {
  CheckpointNode,
  Connection,
  Diagnostics,
  EdgeFlag,
  NodeFlag,
} from "@/lib/api";

type MapViewProps = {
  /** Whether the map is the view on screen. It stays mounted either way. */
  active: boolean;
  projectId: number;
  /** The approved address, and the origin every message is checked against. */
  url: string;
  origin: string;
  nodes: CheckpointNode[];
  connections: Connection[];
  /** connection_id -> the road's real shape, where a driver has produced one. */
  geometry: Record<number, PathGeometry>;
  congestion: Record<number, number>;
  diagnostics: Diagnostics | null;
  selectedConnectionId: number | null;
  onSelect: (selection: BridgeSelection) => void;
  /** A checkpoint dragged on the basemap. Confirmed before anything is written. */
  onNodeMoved: (nodeId: number, position: { lat: number; lng: number }) => void;
};

/** What a node looks like on the wire, and what changing it means. */
function signature(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The map driver's own UI, embedded.
 *
 * The console holds the one Socket.IO connection and forwards state in; the
 * frame sends three kinds of message back. It is deliberately thin - the map
 * driver owns everything about how a map looks, and this file owns nothing
 * except who is allowed to say what to whom.
 *
 * Three things are load-bearing:
 *
 * - **The frame is never unmounted to hide it.** Re-initialising a map library
 *   on every toggle is slow and re-downloads tiles, so toggling away hides it.
 * - **Every message names the approved origin**, going out and coming in.
 *   `"*"` would post project state to whatever happened to be loaded, and an
 *   unchecked `event.origin` would take instructions from anything.
 * - **A frame on the console's own origin is refused outright.** The sandbox
 *   needs `allow-same-origin` for a map library to work at all, and a
 *   same-origin frame with scripts can reach `window.parent` - which is the
 *   API key, the session, and the whole console. A map driver serves its own
 *   page from its own process, so this never happens by accident.
 */
export default function MapView({
  active,
  projectId,
  url,
  origin,
  nodes,
  connections,
  geometry,
  congestion,
  diagnostics,
  selectedConnectionId,
  onSelect,
  onNodeMoved,
}: MapViewProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const capabilities = useRef<MapCapabilities>({});

  /* What has already been sent, so a change sends the one thing that changed
     rather than the whole graph. Keyed by id; the value is what was sent. */
  const sentNodes = useRef(new Map<number, string>());
  const sentEdges = useRef(new Map<number, string>());

  /* Whether this frame has had a snapshot at all. Not derivable from the two
     maps above: an empty project produces two empty maps, which is also what
     "nothing has been sent yet" looks like, and the difference between those
     two decides whether the frame is told anything. */
  const sentSnapshot = useRef(false);

  /* The frame is loaded by the browser, not by us, so the console cannot see
     it fail. If no handshake arrives, something between here and the map
     driver's HTTP port is wrong, and only an operator can fix it. */
  const [unanswered, setUnanswered] = useState(false);

  const sameOrigin =
    typeof window !== "undefined" && origin === window.location.origin;

  /* ---------------------------------------------------------------------
     The state, in the shape the bridge publishes
     --------------------------------------------------------------------- */

  const nodeFlags = useMemo(() => {
    const flags: Record<number, NodeFlag[]> = {};
    for (const node of diagnostics?.nodes ?? []) {
      if (node.flags.length > 0) flags[node.node_id] = node.flags;
    }
    return flags;
  }, [diagnostics]);

  const edgeFlags = useMemo(() => {
    const flags: Record<number, EdgeFlag[]> = {};
    for (const edge of diagnostics?.connections ?? []) {
      if (edge.flags.length > 0) flags[edge.connection_id] = edge.flags;
    }
    return flags;
  }, [diagnostics]);

  const bridgeNodes = useMemo<BridgeNode[]>(
    () =>
      nodes.map((node) => ({
        node_id: node.node_id,
        id_in_project: node.id_in_project,
        latitude: node.latitude,
        longitude: node.longitude,
        flags: nodeFlags[node.node_id] ?? [],
      })),
    [nodes, nodeFlags],
  );

  const bridgeEdges = useMemo<BridgeEdge[]>(
    () =>
      connections.map((edge) => ({
        connection_id: edge.connection_id,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        distance: edge.distance,
        speed_limit: edge.speed_limit,
        distance_status: edge.distance_status,
        path: geometry[edge.connection_id] ?? null,
        flags: edgeFlags[edge.connection_id] ?? [],
      })),
    [connections, geometry, edgeFlags],
  );

  /** The centroid the graph view projects around, so both views agree on centre. */
  const projectionOrigin = useMemo(() => {
    if (nodes.length === 0) return { lat: 0, lng: 0 };
    let lat = 0;
    let lng = 0;
    for (const node of nodes) {
      lat += node.latitude;
      lng += node.longitude;
    }
    return { lat: lat / nodes.length, lng: lng / nodes.length };
  }, [nodes]);

  const send = useCallback(
    (message: Parameters<typeof postToMap>[2]) => {
      postToMap(frame.current, origin, message);
    },
    [origin],
  );

  /* ---------------------------------------------------------------------
     Listening
     --------------------------------------------------------------------- */

  useEffect(() => {
    if (sameOrigin) return;

    const onMessage = (event: MessageEvent) => {
      const message = readMapMessage(
        event,
        origin,
        frame.current?.contentWindow,
      );
      if (!message) return;

      switch (message.type) {
        case "sc:ready":
          capabilities.current = message.payload.capabilities;
          // A fresh handshake means a fresh page: whatever was sent to the
          // last one was sent to a document that no longer exists.
          sentNodes.current.clear();
          sentEdges.current.clear();
          sentSnapshot.current = false;
          setReady(true);
          break;

        case "sc:select":
          onSelect(message.payload);
          break;

        case "sc:node-moved":
          // Only if the driver said it does this. A map that never declared
          // `nodeDrag` asking to move a camera is not a feature nobody
          // switched on; it is a message that should not exist.
          if (!capabilities.current.nodeDrag) return;
          onNodeMoved(message.payload.nodeId, {
            lat: message.payload.latitude,
            lng: message.payload.longitude,
          });
          break;
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, sameOrigin, onSelect, onNodeMoved]);

  /* ---------------------------------------------------------------------
     Forwarding
     --------------------------------------------------------------------- */

  /* The handshake reply. The projection origin is deliberately not a
     dependency: it is where the graph view was centred when the frame came
     up, and re-sending an init every time a checkpoint moves the centroid
     would ask a map that is already running to start over. */
  useEffect(() => {
    if (!ready) return;
    send({
      type: "sc:init",
      payload: {
        projectId,
        protocolVersion: BRIDGE_VERSION,
        origin: projectionOrigin,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, projectId, send]);

  useEffect(() => {
    if (!ready) return;

    const nodeIds = bridgeNodes.map((node) => node.node_id).join(",");
    const edgeIds = bridgeEdges.map((edge) => edge.connection_id).join(",");
    const knownNodes = [...sentNodes.current.keys()].join(",");
    const knownEdges = [...sentEdges.current.keys()].join(",");

    // A checkpoint or an edge appearing or disappearing changes the whole
    // picture; anything else is one thing changing, and is sent as one thing.
    // The first snapshot after a handshake goes out either way: a project with
    // no checkpoints diffs clean against a frame that has been told nothing,
    // and that frame would sit waiting for a message that never came.
    if (
      !sentSnapshot.current ||
      nodeIds !== knownNodes ||
      edgeIds !== knownEdges
    ) {
      send({
        type: "sc:graph",
        payload: { nodes: bridgeNodes, edges: bridgeEdges },
      });
      sentSnapshot.current = true;
      sentNodes.current = new Map(
        bridgeNodes.map((node) => [node.node_id, signature(node)]),
      );
      sentEdges.current = new Map(
        bridgeEdges.map((edge) => [edge.connection_id, signature(edge)]),
      );
      return;
    }

    for (const node of bridgeNodes) {
      const next = signature(node);
      if (sentNodes.current.get(node.node_id) === next) continue;
      sentNodes.current.set(node.node_id, next);
      send({ type: "sc:node-updated", payload: { node } });
    }
    for (const edge of bridgeEdges) {
      const next = signature(edge);
      if (sentEdges.current.get(edge.connection_id) === next) continue;
      sentEdges.current.set(edge.connection_id, next);
      send({ type: "sc:edge-updated", payload: { edge } });
    }
  }, [ready, bridgeNodes, bridgeEdges, send]);

  useEffect(() => {
    if (!ready) return;
    send({ type: "sc:congestion", payload: congestion });
  }, [ready, congestion, send]);

  /* A frame that never handshakes.
     The page inside it says why when it can - no token, no library, no
     basemap - but it cannot say anything at all when it did not load, and the
     console is then the only thing that knows the map view is not working.
     Generous, because a map library is a large download on a first visit. */
  useEffect(() => {
    if (sameOrigin || ready) return;
    const timer = setTimeout(() => setUnanswered(true), 20000);
    return () => clearTimeout(timer);
  }, [sameOrigin, ready]);

  useEffect(() => {
    if (!ready) return;
    send({
      type: "sc:diagnostics",
      payload: { nodes: nodeFlags, edges: edgeFlags },
    });
  }, [ready, nodeFlags, edgeFlags, send]);

  useEffect(() => {
    if (!ready) return;
    send({
      type: "sc:selection",
      payload:
        selectedConnectionId === null
          ? { kind: null, id: null }
          : { kind: "edge", id: selectedConnectionId },
    });
  }, [ready, selectedConnectionId, send]);

  /* ---------------------------------------------------------------------
     Render
     --------------------------------------------------------------------- */

  if (sameOrigin) {
    return (
      <div
        className={active ? "absolute inset-0 grid place-items-center p-6" : "hidden"}
      >
        <p className="max-w-sm text-center text-sm leading-relaxed text-text-dim">
          This map view is served from the console&apos;s own address, so it
          would not be isolated from the console at all. It has not been
          loaded. A map driver serves its page from its own process.
        </p>
      </div>
    );
  }

  return (
    <>
      <iframe
        ref={frame}
        key={url}
        src={url}
        title="Map view"
        /* Scripts, because a map is one. Same-origin, because map libraries
           need their own storage and workers - which is exactly why the frame
           is refused above when its origin is the console's own. Nothing else:
           no top-level navigation, no forms, no popups. */
        sandbox="allow-scripts allow-same-origin"
        /* The frame is told the console's origin and nothing else. It needs
           that to know where to post back to and what to check incoming
           messages against; the path it was opened from is none of its
           business. */
        referrerPolicy="origin"
        className={
          active
            ? "absolute inset-0 h-full w-full border-0"
            : "absolute inset-0 h-full w-full border-0 invisible"
        }
        /* Hidden rather than unmounted: re-initialising a map library on every
           toggle is slow and re-downloads every tile. */
        aria-hidden={!active}
      />

      {active && unanswered && !ready ? (
        <p className="pointer-events-none absolute left-1/2 top-4 z-10 max-w-md -translate-x-1/2 rounded-2xl border border-border bg-surface px-4 py-2 text-center font-mono text-xs leading-relaxed text-text-dim shadow-sm">
          The map view has not answered. That page is served by the map driver
          at {url}, not by the console - check that the driver is still running
          and that this browser can reach that address.
        </p>
      ) : null}
    </>
  );
}
