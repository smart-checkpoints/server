/**
 * The Smart Checkpoints REST client.
 *
 * Every read and every write the console performs goes through this file, and
 * nothing else in the console constructs a URL, spells an endpoint, or knows
 * that request bodies are kebab-case while rows come back snake_case. That
 * asymmetry is part of the published wire protocol, set out in the REST API
 * reference in the docs, so it is preserved exactly and contained here.
 *
 * The console is served by the same origin it talks to, so every path is
 * relative. Authentication is the `x-api-key` header on every project-scoped
 * call; the key never travels in a URL.
 */
import type { LatLng } from "@/lib/geo";

/* -------------------------------------------------------------------------
   Domain types. These are the row shapes the server returns, unchanged.
   ------------------------------------------------------------------------- */

export type ProjectSummary = {
  project_id: number;
  project_name: string;
  node_count: number;
  connection_count: number;
};

export type AdminProject = ProjectSummary & {
  api_key: string;
};

export type Project = {
  project_id: number;
  project_name: string;
};

export type CheckpointNode = {
  node_id: number;
  id_in_project: number;
  latitude: number;
  longitude: number;
};

/**
 * What an edge's distance is worth, and therefore whether it enforces.
 *
 * - `ok` - a driver routed it, or an operator typed it. Violations run.
 * - `unknown` - nobody has answered yet, or a driver failed. Not enforced.
 * - `no-route` - a driver says there is no road here. Not enforced; wrong.
 *
 * The last two are different problems with different fixes - one is "wait, or
 * check the driver", the other is "you drew a connection where there is no
 * road" - so the console shows them differently.
 */
export type DistanceStatus = "ok" | "unknown" | "no-route";

export type Connection = {
  connection_id: number;
  from_node_id: number;
  to_node_id: number;
  /** Road distance in metres, or null while the status is not `ok`. */
  distance: number | null;
  /** Enforced limit in km/h. */
  speed_limit: number;
  distance_status: DistanceStatus;
  /**
   * Epoch milliseconds when the distance figure was last decided. Present on
   * the REST rows; the realtime events do not carry it.
   */
  distance_updated_at?: number | null;
};

/** Whether this edge may decide a violation. The server asks the same question. */
export function isEnforced(edge: {
  distance_status: DistanceStatus;
}): boolean {
  return edge.distance_status === "ok";
}

/**
 * A key issued for one camera, as the server lists it back.
 *
 * The key itself is not in here. It is returned once, when it is issued, and
 * never again: what is left is enough to tell one camera's credential from
 * another's and revoke the right one.
 */
export type ReporterKey = {
  key_id: number;
  role: string;
  label: string | null;
  created_at: string;
  /** The first six characters, so a key can be matched to a camera. */
  key_prefix: string;
};

export type Violation = {
  violation_id?: number;
  car_plate: string;
  car_speed: number;
  timestamp: string;
};

/**
 * Thumbnail geometry: node positions already projected and normalised into the
 * unit square by the server, so no camera's GPS position is disclosed.
 */
export type ThumbnailData = {
  nodes: Array<{ id: number; x: number; y: number }>;
  connections: Array<{ from: number; to: number }>;
};

/* -------------------------------------------------------------------------
   Transport
   ------------------------------------------------------------------------- */

/** A failed call, carrying the status so callers can tell 401 from 500. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Project API key, sent as `x-api-key`. */
  apiKey?: string;
  /** Admin password, sent as `x-admin-password`. */
  adminPassword?: string;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, apiKey, adminPassword, signal } = options;

  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (apiKey) headers["x-api-key"] = apiKey;
  if (adminPassword) headers["x-admin-password"] = adminPassword;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // A dropped connection is not a 500: say so, rather than inventing one.
    throw new ApiError(
      err instanceof Error ? err.message : "The server could not be reached",
      0,
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `${method} ${path} failed with HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

/* -------------------------------------------------------------------------
   Projects
   ------------------------------------------------------------------------- */

export function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>("/list-projects", { signal });
}

export function getThumbnailData(
  projectId: number,
  signal?: AbortSignal,
): Promise<ThumbnailData> {
  return request<ThumbnailData>(`/project/${projectId}/thumbnail-data`, { signal });
}

export function createProject(
  name: string,
): Promise<{ project_id: number; api_key: string }> {
  return request("/create-project", {
    method: "POST",
    body: { "project-name": name },
  });
}

/** Exchanges an API key for the project it opens. Throws ApiError(401) if not. */
export function authenticate(apiKey: string): Promise<Project> {
  return request<Project>("/authenticate", {
    method: "POST",
    body: { "api-key": apiKey },
  });
}

/* -------------------------------------------------------------------------
   The graph
   ------------------------------------------------------------------------- */

export function getNodes(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<CheckpointNode[]> {
  return request<CheckpointNode[]>(`/project/${projectId}/nodes`, { apiKey, signal });
}

export function getConnections(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Connection[]> {
  return request<Connection[]>(`/project/${projectId}/connections`, {
    apiKey,
    signal,
  });
}

export function createNode(
  apiKey: string,
  position: LatLng,
): Promise<{ node_id: number; id_in_project: number }> {
  return request("/create-node", {
    method: "POST",
    apiKey,
    body: { latitude: position.lat, longitude: position.lng },
  });
}

/**
 * Corrects a checkpoint's position.
 *
 * Every edge touching it loses its distance, its geometry and its enforcement
 * until a driver measures the new position, and the response says how many
 * that was. The checkpoint's new position and each of those edges arrive back
 * over the realtime channel like any other change.
 */
export function moveNode(
  apiKey: string,
  nodeId: number,
  position: LatLng,
): Promise<{
  success: boolean;
  node_id: number;
  id_in_project: number;
  latitude: number;
  longitude: number;
  connections_invalidated: number;
}> {
  return request(`/node/${nodeId}`, {
    method: "PUT",
    apiKey,
    body: { latitude: position.lat, longitude: position.lng },
  });
}

/**
 * Creates an edge. Omit `distanceMeters` when a distance driver is connected:
 * the server then asks the driver for the road distance and fills it in.
 */
export function createConnection(
  apiKey: string,
  edge: {
    fromNodeId: number;
    toNodeId: number;
    speedLimitKmh: number;
    distanceMeters?: number;
  },
): Promise<{ connection_id: number }> {
  const body: Record<string, unknown> = {
    "from-node-id": edge.fromNodeId,
    "to-node-id": edge.toNodeId,
    "speed-limit": edge.speedLimitKmh,
  };
  if (edge.distanceMeters !== undefined) body["distance"] = edge.distanceMeters;

  return request("/create-connection", { method: "POST", apiKey, body });
}

/**
 * Updates an edge. Omit `distanceMeters` to change only the speed limit: the
 * server keeps the distance and its status untouched, which is the only way to
 * edit an edge a driver owns, or one nobody has resolved yet.
 */
export function updateConnection(
  apiKey: string,
  connectionId: number,
  edge: { distanceMeters?: number; speedLimitKmh: number },
): Promise<{ success: boolean }> {
  const body: Record<string, unknown> = {
    "speed-limit": edge.speedLimitKmh,
  };
  if (edge.distanceMeters !== undefined) body["distance"] = edge.distanceMeters;

  return request(`/connection/${connectionId}`, {
    method: "PUT",
    apiKey,
    body,
  });
}

/* -------------------------------------------------------------------------
   Data quality

   What is wrong with the graph, computed by the server on request and never
   stored. Every flag arrives with the numbers that produced it and with the
   thresholds those numbers were judged against, because a flag the operator
   cannot interrogate is a flag they will learn to ignore.
   ------------------------------------------------------------------------- */

/**
 * - `off-network` - a driver reported this coordinate as far from any road.
 *   The most direct evidence of a bad GPS fix, and it needs no inference.
 * - `suspect-position` - most of this checkpoint's roads are much longer than
 *   the straight line to their far end. One such edge is geography; most of
 *   them means the checkpoint is not where it says it is.
 */
export type NodeFlag = "off-network" | "suspect-position";

/**
 * - `impossible` - the road is shorter than the straight line, which is a hard
 *   error rather than a suspicious camera.
 * - `circuitous` - the road is much longer than the straight line.
 */
export type EdgeFlag = "impossible" | "circuitous";

/** The numbers the flags were judged against. Guesses, and labelled as such. */
export type DiagnosticsThresholds = {
  min_displacement_m: number;
  circuity_flag: number;
  circuity_impossible: number;
  endpoint_offset_flag_m: number;
  node_min_edges: number;
  node_flag_fraction: number;
};

export type NodeDiagnostics = {
  node_id: number;
  id_in_project: number;
  latitude: number;
  longitude: number;
  flags: NodeFlag[];
  /** Every edge touching this checkpoint. */
  edge_count: number;
  /** Those far enough apart, and resolved enough, to judge. */
  evaluated_edges: number;
  circuitous_edges: number;
  impossible_edges: number;
  /** circuitous / evaluated, or null when there is nothing to judge. */
  flagged_fraction: number | null;
  /** Median circuity of this checkpoint's flagged edges. */
  typical_circuity: number | null;
  /** Worst metres-to-road any driver has reported for this checkpoint. */
  endpoint_offset: number | null;
};

export type EdgeDiagnostics = {
  connection_id: number;
  from_node_id: number;
  to_node_id: number;
  from_id_in_project: number;
  to_id_in_project: number;
  /** Road metres, or null while the distance is not resolved. */
  distance: number | null;
  distance_status: DistanceStatus;
  /** Straight-line metres between the two checkpoints. */
  displacement: number;
  /** distance / displacement, or null when there is no usable distance. */
  circuity: number | null;
  /** Metres from each requested coordinate to the road it was snapped to. */
  endpoint_offsets: number[] | null;
  /** Whether this edge counted toward its endpoints' verdicts. */
  evaluated: boolean;
  flags: EdgeFlag[];
};

/** Worst first, both lists. The server decides what worst means. */
export type Diagnostics = {
  thresholds: DiagnosticsThresholds;
  nodes: NodeDiagnostics[];
  connections: EdgeDiagnostics[];
};

export function getDiagnostics(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Diagnostics> {
  return request<Diagnostics>(`/project/${projectId}/diagnostics`, {
    apiKey,
    signal,
  });
}

/* -------------------------------------------------------------------------
   Route geometry

   The real shape of each road, as a distance driver measured it. Separate
   from the edge rows because it is a different order of size and a different
   audience: the graph view draws straight lines and needs none of this, and
   most sessions never open a map.
   ------------------------------------------------------------------------- */

/** A GeoJSON LineString in WGS84: `[longitude, latitude]` pairs, longitude first. */
export type PathGeometry = {
  type: "LineString";
  coordinates: [number, number][];
};

export type EdgeGeometry = {
  connection_id: number;
  path: PathGeometry;
};

/**
 * Whether this is the one wire format route geometry has.
 *
 * The server stores what a driver sent and forwards it without reading it, so
 * this is the first thing in the system that looks inside. It checks the
 * envelope only - a LineString of coordinate pairs - and not whether the road
 * goes anywhere sensible, which is what the diagnostics are for.
 */
function isPathGeometry(value: unknown): value is PathGeometry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== "LineString") return false;
  if (!Array.isArray(candidate.coordinates)) return false;
  return candidate.coordinates.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length >= 2 &&
      Number.isFinite(pair[0]) &&
      Number.isFinite(pair[1]),
  );
}

/**
 * Every edge that has a road shape, with the shape parsed.
 *
 * The server sends `path` as the text it stored, inside a JSON string, because
 * it does not parse route geometry. This is where that text becomes geometry,
 * and it is the only place in the console that does it: an edge whose stored
 * text is not a LineString is dropped rather than handed on half-read.
 */
export async function getGeometry(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<EdgeGeometry[]> {
  const rows = await request<
    Array<{ connection_id: number; path: string; path_format: string | null }>
  >(`/project/${projectId}/geometry`, { apiKey, signal });

  const parsed: EdgeGeometry[] = [];
  for (const row of rows) {
    let path: unknown;
    try {
      path = JSON.parse(row.path);
    } catch {
      continue;
    }
    if (isPathGeometry(path)) {
      parsed.push({ connection_id: row.connection_id, path });
    }
  }
  return parsed;
}

/* -------------------------------------------------------------------------
   The map view

   A map driver announces the address of its own UI when it connects, and that
   address ends up in an iframe inside the console. Whoever holds the project
   API key would otherwise be choosing what renders inside trusted chrome, so
   an announcement is a proposal: it is shown, an operator approves it once,
   and only then is it embedded.
   ------------------------------------------------------------------------- */

/**
 * - `none` - nothing announced, or approval withdrawn. The graph view only.
 * - `pending` - a driver named an address nobody has agreed to. Not embedded.
 * - `approved` - an operator approved this address. The only status that renders.
 */
export type MapDriverStatus = "none" | "pending" | "approved";

export type MapDriverState = {
  /** Whether a map driver holds this project's map slot right now. */
  connected: boolean;
  status: MapDriverStatus;
  /** The approved address, or null. */
  url: string | null;
  /** Its origin, which every postMessage is sent to and checked against. */
  origin: string | null;
  /** An address waiting for somebody to decide about it, or null. */
  pending_url: string | null;
};

export function getMapDriverState(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MapDriverState> {
  return request<MapDriverState>(`/project/${projectId}/map-driver`, {
    apiKey,
    signal,
  });
}

/**
 * Approves the announced address, naming it rather than saying "whatever is
 * pending". If a driver re-announced something else since this screen was
 * drawn, the server refuses with 409 rather than approving a page nobody read.
 */
export function approveMapDriver(
  projectId: number,
  apiKey: string,
  url: string,
): Promise<MapDriverState> {
  return request(`/project/${projectId}/map-driver/approve`, {
    method: "POST",
    apiKey,
    body: { url },
  });
}

/** Refuses the announcement. Anything already approved is left alone. */
export function rejectMapDriver(
  projectId: number,
  apiKey: string,
): Promise<MapDriverState> {
  return request(`/project/${projectId}/map-driver/reject`, {
    method: "POST",
    apiKey,
  });
}

/** Withdraws approval entirely. No map view until something is approved again. */
export function revokeMapDriver(
  projectId: number,
  apiKey: string,
): Promise<MapDriverState> {
  return request(`/project/${projectId}/map-driver/revoke`, {
    method: "POST",
    apiKey,
  });
}

/* -------------------------------------------------------------------------
   Enforcement
   ------------------------------------------------------------------------- */

export function getViolations(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Violation[]> {
  return request<Violation[]>(`/project/${projectId}/violations`, { apiKey, signal });
}

export function getDistanceDriverStatus(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ connected: boolean }> {
  return request(`/project/${projectId}/distance-driver-status`, { apiKey, signal });
}

/* -------------------------------------------------------------------------
   Reporter keys

   One key per camera, each able to do nothing but report a sighting for its
   own project. Issuing, listing and revoking them all need the project's
   operator key, which is the one this console holds.
   ------------------------------------------------------------------------- */

export function listReporterKeys(
  projectId: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ReporterKey[]> {
  return request<ReporterKey[]>(`/project/${projectId}/reporter-keys`, {
    apiKey,
    signal,
  });
}

/**
 * Issues a key for one camera. The `api_key` in the response is the only time
 * it is readable: it is shown once and then only ever as a prefix.
 */
export function issueReporterKey(
  projectId: number,
  apiKey: string,
  label: string,
): Promise<ReporterKey & { api_key: string }> {
  return request(`/project/${projectId}/reporter-keys`, {
    method: "POST",
    apiKey,
    body: { label },
  });
}

export function revokeReporterKey(
  projectId: number,
  apiKey: string,
  keyId: number,
): Promise<{ success: boolean }> {
  return request(`/project/${projectId}/reporter-keys/${keyId}`, {
    method: "DELETE",
    apiKey,
  });
}

/* -------------------------------------------------------------------------
   Administration
   ------------------------------------------------------------------------- */

export function adminAuthenticate(password: string): Promise<{ success: boolean }> {
  return request("/admin/auth", { method: "POST", body: { password } });
}

export function adminListProjects(
  password: string,
  signal?: AbortSignal,
): Promise<AdminProject[]> {
  return request<AdminProject[]>("/admin/projects", {
    adminPassword: password,
    signal,
  });
}
