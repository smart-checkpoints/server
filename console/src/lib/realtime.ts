/**
 * The Socket.IO channel, typed.
 *
 * The server speaks two realtime protocols on one port. This is the browser
 * one: Socket.IO, rooms named `project-<id>`, joined by sending the project
 * API key. The other is the raw WebSocket at `/distance-driver`, which is for
 * distance drivers only and never opened from here; the console learns about
 * drivers through the `distance-driver-status` event below.
 *
 * The event names and payload shapes are the published realtime contract; see
 * the realtime reference in the docs. Nothing else in the console types them.
 */
import { io, type Socket } from "socket.io-client";

import type { DistanceStatus, MapDriverState, Violation } from "@/lib/api";

/** Server to client. */
export type ServerEvents = {
  joined: (data: { project_id: number }) => void;
  "node-added": (data: {
    node_id: number;
    id_in_project: number;
    latitude: number;
    longitude: number;
  }) => void;
  /** A checkpoint's position was corrected. Its edges follow, unresolved. */
  "node-moved": (data: {
    node_id: number;
    id_in_project: number;
    latitude: number;
    longitude: number;
  }) => void;
  "connection-added": (data: {
    connection_id: number;
    from_node_id: number;
    to_node_id: number;
    /** Null whenever the status is not `ok`. */
    distance: number | null;
    speed_limit: number;
    distance_status: DistanceStatus;
  }) => void;
  "connection-updated": (data: {
    connection_id: number;
    distance: number | null;
    speed_limit: number;
    distance_status: DistanceStatus;
  }) => void;
  "node-triggered": (data: {
    id_in_project: number;
    car_plate: string;
    violation: boolean;
  }) => void;
  "violation-added": (data: Violation) => void;
  /** connection_id -> congestion ratio C, where 1 is free-flowing. */
  "congestion-update": (data: Record<string, number>) => void;
  "distance-driver-status": (data: { connected: boolean }) => void;
  /**
   * Where this project's map view stands: whether a driver is attached, and
   * whether anyone has approved the address it announced.
   *
   * Sent on joining, whenever a map driver connects or drops, and after every
   * approval decision. The console falls back to the graph view on it.
   */
  "map-driver-status": (data: MapDriverState) => void;
  error: (data: { message: string }) => void;
};

/** Client to server. */
export type ClientEvents = {
  "join-project": (data: { apiKey: string }) => void;
  "create-connection": (data: {
    from_node_id: number;
    to_node_id: number;
    distance?: number;
    speed_limit: number;
  }) => void;
  "update-connection": (data: {
    connection_id: number;
    /** Omitted to change only the limit: the server keeps the stored distance. */
    distance?: number;
    speed_limit: number;
  }) => void;
};

export type ConsoleSocket = Socket<ServerEvents, ClientEvents>;

/**
 * Opens the channel and joins the project the key belongs to.
 *
 * Socket.IO reconnects on its own, and the server re-derives the room from the
 * key, so `join-project` is sent on every `connect`, reconnects included,
 * rather than only the first one.
 */
export function connectProject(apiKey: string): ConsoleSocket {
  const socket: ConsoleSocket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    socket.emit("join-project", { apiKey });
  });

  return socket;
}
