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

export type Connection = {
  connection_id: number;
  from_node_id: number;
  to_node_id: number;
  /** Road distance in metres. 0 means no driver has resolved this edge yet. */
  distance: number;
  /** Enforced limit in km/h. */
  speed_limit: number;
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
  method?: "GET" | "POST" | "PUT";
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

export function updateConnection(
  apiKey: string,
  connectionId: number,
  edge: { distanceMeters: number; speedLimitKmh: number },
): Promise<{ success: boolean }> {
  return request(`/connection/${connectionId}`, {
    method: "PUT",
    apiKey,
    body: { distance: edge.distanceMeters, "speed-limit": edge.speedLimitKmh },
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
