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
      outcome = `Planned ${num(input.count) ?? ""} points, ${metres(result.spacing_m)} apart`;
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

/** Lanes are told apart by shade and number; status colours stay for status. */
/**
 * Calls running at once, told apart by name and shade. Every shade is the
 * cyan family or ink from the design tokens, mixed where two would otherwise
 * look alike; status colours (green, yellow, red) are never used.
 */
export const LANES = [
  { name: "Tram", colour: "var(--cyan)" },
  { name: "Taxi", colour: "var(--cyan-dark)" },
  { name: "Microbus", colour: "var(--text)" },
  { name: "Metro", colour: "color-mix(in oklab, var(--cyan-dark) 55%, var(--text))" },
  { name: "Tuk-tuk", colour: "var(--text-dim)" },
];

const lane = (n: number) => LANES[(Math.max(1, n) - 1) % LANES.length];

export function laneColour(n: number) {
  return lane(n).colour;
}

export function laneName(n: number) {
  return lane(n).name;
}

export const EXAMPLE_PROMPTS = [
  "Set up three checkpoints along the Corniche, speed limit 50, and connect them.",
  "The camera at El Shatby moved 200 metres east, update it.",
  "Which edges had the most violations this week?",
];
