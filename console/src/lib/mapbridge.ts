/**
 * The postMessage contract between the console and a map driver's UI.
 *
 * The console holds the single Socket.IO connection to the server and forwards
 * what it hears into the iframe. The map driver never opens a socket of its
 * own, never talks to the distance driver, and never holds an API key: it is
 * handed state and hands back three things. That is the whole of the
 * micro-frontend split, and it is why an eleventh distance driver costs a map
 * driver nothing.
 *
 * Every message is `{ v: 2, type, payload }`. Both sides pass the approved
 * origin as `targetOrigin` and check `event.origin` on receipt - never `"*"`,
 * in either direction.
 *
 * The page at the far end is not ours. A TypeScript type is a compile-time
 * claim about this code, not a runtime check on someone else's, so everything
 * arriving from the iframe goes through the validators at the bottom of this
 * file: shape checked, coordinate ranges checked, anything unrecognised
 * dropped. Nothing else in the console spells these message names.
 */
import type {
  DistanceStatus,
  EdgeFlag,
  NodeFlag,
  PathGeometry,
} from "@/lib/api";

/** The bridge protocol version. Not the driver protocol; they move separately. */
export const BRIDGE_VERSION = 2;

export type { PathGeometry };

/* -------------------------------------------------------------------------
   Parent -> iframe
   ------------------------------------------------------------------------- */

export type BridgeNode = {
  node_id: number;
  id_in_project: number;
  latitude: number;
  longitude: number;
  /** Data-quality flags, so a map can draw the checkpoint that is wrong. */
  flags: NodeFlag[];
};

export type BridgeEdge = {
  connection_id: number;
  from_node_id: number;
  to_node_id: number;
  /** Metres, or null when the status is not `ok` and it enforces nothing. */
  distance: number | null;
  speed_limit: number;
  distance_status: DistanceStatus;
  /** The road's real shape, or null when no driver has produced one. */
  path: PathGeometry | null;
  flags: EdgeFlag[];
};

export type BridgeSelection =
  | { kind: "node" | "edge"; id: number }
  | { kind: null; id: null };

export type ToMapMessage =
  | {
      type: "sc:init";
      payload: {
        projectId: number;
        protocolVersion: number;
        /** The projection origin the graph view uses, so both agree on centre. */
        origin: { lat: number; lng: number };
      };
    }
  | { type: "sc:graph"; payload: { nodes: BridgeNode[]; edges: BridgeEdge[] } }
  | { type: "sc:node-updated"; payload: { node: BridgeNode } }
  | { type: "sc:edge-updated"; payload: { edge: BridgeEdge } }
  | { type: "sc:congestion"; payload: Record<number, number> }
  | {
      type: "sc:diagnostics";
      payload: {
        nodes: Record<number, NodeFlag[]>;
        edges: Record<number, EdgeFlag[]>;
      };
    }
  | { type: "sc:selection"; payload: BridgeSelection };

/** Posts one message to the frame, always at the approved origin. */
export function postToMap(
  frame: HTMLIFrameElement | null,
  origin: string,
  message: ToMapMessage,
): void {
  const target = frame?.contentWindow;
  if (!target) return;
  target.postMessage({ v: BRIDGE_VERSION, ...message }, origin);
}

/* -------------------------------------------------------------------------
   Iframe -> parent
   ------------------------------------------------------------------------- */

/**
 * What a map driver says it can do. Additive and optional, like the driver
 * handshake: absence costs a feature, never a connection.
 */
export type MapCapabilities = {
  /** Whether this map lets an operator drag a checkpoint to a new position. */
  nodeDrag?: boolean;
};

export type FromMapMessage =
  | {
      type: "sc:ready";
      payload: { protocolVersion: number; capabilities: MapCapabilities };
    }
  | { type: "sc:select"; payload: BridgeSelection }
  | {
      type: "sc:node-moved";
      payload: { nodeId: number; latitude: number; longitude: number };
    };

/* -------------------------------------------------------------------------
   Validation

   Everything below runs on data from a page the operator approved but nobody
   here wrote. Each validator returns the message or null; a null is dropped
   silently, because a map driver that sends nonsense should cost the console
   nothing at all.
   ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The same rule as the server's: WGS84 degrees, in range, or nothing. */
function coordinate(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const latitude = finiteNumber(lat);
  const longitude = finiteNumber(lng);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { lat: latitude, lng: longitude };
}

function selection(value: unknown): BridgeSelection | null {
  if (!isRecord(value)) return null;
  if (value.kind === null) return { kind: null, id: null };
  if (value.kind !== "node" && value.kind !== "edge") return null;
  const id = finiteNumber(value.id);
  if (id === null || !Number.isInteger(id)) return null;
  return { kind: value.kind, id };
}

/**
 * One validated message from the frame, or null.
 *
 * The origin check is first and is not negotiable: a message from anywhere
 * other than the approved origin is not from the map driver, whatever it says
 * about itself. `event.source` is checked too, so another frame on the same
 * approved origin cannot speak for it.
 */
export function readMapMessage(
  event: MessageEvent,
  expectedOrigin: string,
  expectedSource: Window | null | undefined,
): FromMapMessage | null {
  if (!expectedOrigin || event.origin !== expectedOrigin) return null;
  if (expectedSource && event.source !== expectedSource) return null;

  const data: unknown = event.data;
  if (!isRecord(data)) return null;
  if (data.v !== BRIDGE_VERSION) return null;

  const payload = isRecord(data.payload) ? data.payload : null;

  switch (data.type) {
    case "sc:ready": {
      if (!payload) return null;
      const version = finiteNumber(payload.protocolVersion);
      const declared = isRecord(payload.capabilities) ? payload.capabilities : {};
      return {
        type: "sc:ready",
        payload: {
          protocolVersion: version ?? 1,
          capabilities: { nodeDrag: declared.nodeDrag === true },
        },
      };
    }

    case "sc:select": {
      const parsed = selection(payload);
      return parsed ? { type: "sc:select", payload: parsed } : null;
    }

    case "sc:node-moved": {
      if (!payload) return null;
      const nodeId = finiteNumber(payload.nodeId);
      if (nodeId === null || !Number.isInteger(nodeId)) return null;
      const position = coordinate(payload.latitude, payload.longitude);
      if (!position) return null;
      return {
        type: "sc:node-moved",
        payload: {
          nodeId,
          latitude: position.lat,
          longitude: position.lng,
        },
      };
    }

    default:
      return null;
  }
}
