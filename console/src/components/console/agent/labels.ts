import type { AgentAction } from "./useAgent";

/** node_id -> camera number, from the checkpoints the page already holds. */
export type CameraOf = (nodeId: number) => number | undefined;

const num = (value: unknown) => (typeof value === "number" ? value : undefined);

function camera(cameraOf: CameraOf, nodeId: unknown) {
  const id = num(nodeId);
  if (id === undefined) return "?";
  const n = cameraOf(id);
  return n === undefined ? "?" : String(n);
}

function metres(value: unknown) {
  const m = num(value);
  if (m === undefined) return "";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/**
 * What an action is, in the operator's words, and what came of it. The
 * title is shown while it runs; the outcome replaces it when it is done.
 */
export function describeAction(action: AgentAction, cameraOf: CameraOf): { title: string; outcome: string } {
  const input = action.input;
  const result = action.result ?? {};
  const failed = typeof result.error === "string" ? (result.error as string) : "";
  const declined = typeof result.message === "string" ? (result.message as string) : "";

  let title = "Working";
  let outcome = "Done";
  switch (action.tool) {
    case "get_network":
      title = "Reading the network";
      outcome = "Read the network";
      break;
    case "get_driver_status":
      title = "Checking the distance driver";
      outcome = result.distance_driver_connected ? "Distance driver connected" : "No distance driver connected";
      break;
    case "find_place":
      title = `Looking up ${typeof input.query === "string" ? `"${input.query}"` : "a place"}`;
      outcome = title.replace("Looking up", "Found");
      break;
    case "points_along_street":
      title = `Planning ${num(input.count) ?? ""} points along ${typeof input.street === "string" ? input.street : "the street"}`;
      outcome = `Planned ${num(input.count) ?? ""} points, ${metres(input.spacing_m)} apart`;
      break;
    case "points_between":
      title = `Planning ${num(input.count) ?? ""} points between camera ${camera(cameraOf, input.from_node_id)} and camera ${camera(cameraOf, input.to_node_id)}`;
      outcome = title.replace("Planning", "Planned");
      break;
    case "split_edge":
      title = "Adding a camera on an edge";
      outcome = `Placed camera ${num(result.camera) ?? "?"} on the edge`;
      break;
    case "delete_edges": {
      const n = Array.isArray(input.connection_ids) ? input.connection_ids.length : 0;
      const count = (key: string) => (Array.isArray(result[key]) ? (result[key] as unknown[]).length : 0);
      const done = count("deleted_connection_ids") + count("retired_connection_ids");
      title = n === 1 ? "Removing a section" : `Removing ${n} sections`;
      outcome = `Removed ${done} section${done === 1 ? "" : "s"}`;
      break;
    }
    case "delete_checkpoints": {
      const n = Array.isArray(input.node_ids) ? input.node_ids.length : 0;
      const list = (key: string) => (Array.isArray(result[key]) ? (result[key] as number[]) : []);
      const done = [...list("deleted_cameras"), ...list("retired_cameras")];
      title = n === 1 ? `Removing camera ${camera(cameraOf, (input.node_ids as unknown[])[0])}` : `Removing ${n} cameras`;
      outcome = done.length === 1 ? `Removed camera ${done[0]}` : `Removed ${done.length} cameras`;
      break;
    }
    case "import_checkpoints": {
      const n = Array.isArray(input.points) ? input.points.length : 0;
      const made = Array.isArray(result.created) ? result.created.length : 0;
      title = `Placing ${n} cameras${typeof input.source === "string" && input.source ? ` from ${input.source}` : ""}`;
      outcome = `Placed ${made} camera${made === 1 ? "" : "s"}`;
      break;
    }
    case "list_retired":
      title = "Reading retired cameras and sections";
      outcome = "Read retired cameras and sections";
      break;
    case "bring_back": {
      const cams = Array.isArray(result.cameras) ? result.cameras.length : 0;
      const secs = Array.isArray(result.sections) ? result.sections.length : 0;
      title = "Bringing back retired items";
      outcome = `Brought back ${cams} camera${cams === 1 ? "" : "s"} and ${secs} section${secs === 1 ? "" : "s"}`;
      break;
    }
    case "list_restore_points":
      title = "Reading the restore points";
      outcome = "Read the restore points";
      break;
    case "save_restore_point":
      title = "Saving a restore point";
      outcome = `Saved restore point “${typeof input.name === "string" ? input.name : ""}”`;
      break;
    case "restore_to":
      title = "Restoring the network";
      outcome = typeof result.restored === "string" ? `Restored “${result.restored}”` : "Restored";
      break;
    case "generate_report":
      title = "Writing the report";
      outcome = "Report ready";
      break;
    case "create_checkpoint":
      title = "Placing a checkpoint";
      outcome = `Placed camera ${num(result.camera) ?? "?"}`;
      break;
    case "create_edge": {
      const pair = `${camera(cameraOf, input.from_node_id)} → ${camera(cameraOf, input.to_node_id)}`;
      title = `Connecting ${pair} at ${num(input.speed_limit_kmh) ?? "?"} km/h`;
      outcome =
        result.status === "measured"
          ? `Connected ${pair} · ${metres(result.distance_m)}`
          : `Connected ${pair} · not measured yet`;
      break;
    }
    case "set_speed_limit":
      title = `Setting ${num(input.speed_limit_kmh) ?? "?"} km/h`;
      outcome = `Limit ${num(result.previous_speed_limit_kmh) ?? "?"} → ${num(result.speed_limit_kmh) ?? "?"} km/h`;
      break;
    case "move_checkpoint_by":
    case "move_checkpoint_to":
      title = `Moving camera ${camera(cameraOf, input.node_id)}`;
      outcome = `Moved camera ${num(result.camera) ?? camera(cameraOf, input.node_id)} by ${metres(result.moved_m)}`;
      break;
    case "await_remeasure":
      title = "Waiting for new distances";
      outcome = result.done ? "Distances re-measured" : "Still measuring";
      break;
    case "get_violation_summary":
      title = `Counting violations, last ${num(input.days) ?? 7} days`;
      outcome = `${num(result.total_violations) ?? 0} violations found`;
      break;
    case "get_diagnostics":
      title = "Running the quality check";
      outcome = "Quality check done";
      break;
    case "get_violations":
      title = "Reading the violation records";
      outcome = `${num(result.shown) ?? 0} of ${num(result.total_in_window) ?? 0} violations listed`;
      break;
    case "get_congestion":
      title = "Reading live congestion";
      outcome = Array.isArray(result.edges) && result.edges.length ? `Congestion on ${result.edges.length} edges` : "No live traffic reading";
      break;
    case "get_stats":
      title = "Reading the project's figures";
      outcome = "Read the project's figures";
      break;
    case "geocode":
      title = `Looking up ${typeof input.query === "string" ? `"${input.query}"` : "a place"} on OpenStreetMap`;
      outcome = Array.isArray(result.matches) && result.matches.length ? title.replace("Looking up", "Found") : "Not found on OpenStreetMap";
      break;
    case "road_info":
      title = "Checking the road on OpenStreetMap";
      outcome = typeof result.name === "string" ? `${result.name}: ${String(result.layout ?? "")}` : "Checked the road";
      break;
    case "nearby_places":
      title = "Looking at what is nearby";
      outcome = "Checked nearby places";
      break;
    case "web_search":
      title = `Searching the web${typeof input.query === "string" ? ` for "${input.query}"` : ""}`;
      outcome = title.replace("Searching", "Searched");
      break;
    case "code_execution":
      title = "Sorting through the search results";
      outcome = "Sorted the search results";
      break;
    case "web_fetch":
      title = "Reading a web page";
      outcome = typeof input.url === "string" ? `Read ${input.url}` : "Read a web page";
      break;
    case "frame_map":
      title = "Framing the map";
      outcome = "Framed the map";
      break;
    case "switch_view":
      title = `Switching to the ${input.view === "map" ? "map" : "graph"} view`;
      outcome = title.replace("Switching", "Switched");
      break;
    case "open_panel":
      title = input.panel === "none" ? "Closing the panel" : `Opening ${input.panel === "quality" ? "Quality" : "Violations"}`;
      outcome = title.replace("Opening", "Opened").replace("Closing", "Closed");
      break;
    case "highlight":
      title = "Highlighting on the map";
      outcome = typeof input.caption === "string" && input.caption ? `Highlighted: ${input.caption}` : "Highlighted on the map";
      break;
  }

  if (action.status === "failed") outcome = failed || "Did not finish";
  if (action.status === "declined") outcome = declined || "Declined";
  if (action.status === "measuring") title = "Measuring the road distance";
  return { title, outcome };
}

/**
 * The cursors, one per lane: calls running at once. Each has a name and its
 * own hue, so they read as separate hands at a glance; the house cyan leads.
 * Status colours (green, yellow, red) are never used. `ink` is the name tag's
 * text colour, chosen for at least 4.5:1 on the tag. Tuk-tuk keeps the navy
 * of the Vision cursor set the shapes are traced from.
 */
export const LANES = [
  { name: "Tram", colour: "#19c4d8", ink: "#1e2628" },
  { name: "Taxi", colour: "#4361ee", ink: "#ffffff" },
  { name: "Microbus", colour: "#7a4ff0", ink: "#ffffff" },
  { name: "Metro", colour: "#c4368c", ink: "#ffffff" },
  { name: "Tuk-tuk", colour: "#0c1e35", ink: "#ffffff" },
];

const lane = (n: number) => LANES[(Math.max(1, n) - 1) % LANES.length];

export function laneColour(n: number) {
  return lane(n).colour;
}

export function laneName(n: number) {
  return lane(n).name;
}

export function laneInk(n: number) {
  return lane(n).ink;
}

/** The tools that get a cursor: the same list as CURSOR_TOOLS in agent/runner.js. */
export const CURSOR_TOOLS = new Set([
  "create_checkpoint",
  "create_edge",
  "set_speed_limit",
  "move_checkpoint_by",
  "move_checkpoint_to",
  "get_violation_summary",
  "get_diagnostics",
]);

export const EXAMPLE_PROMPTS = [
  "Set up three checkpoints along the Corniche, speed limit 50, and connect them.",
  "The camera at El Shatby moved 200 metres east, update it.",
  "Which edges had the most violations this week?",
];
