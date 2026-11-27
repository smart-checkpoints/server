/*
 * What the drawers and the inspector read off the network: counts per
 * section, labels, and a camera's status. Derived on render, never stored.
 */

import type { CameraPlace, CheckpointNode, Connection, Violation } from "@/lib/api";
import { isEnforced } from "@/lib/api";
import type { Tone } from "./parts";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type SectionCounts = { week: number; all: number };

/** connection_id -> violations this week and in all. */
export function countBySection(violations: Violation[], now = Date.now()): Map<number, SectionCounts> {
  const counts = new Map<number, SectionCounts>();
  for (const violation of violations) {
    if (violation.connection_id == null) continue;
    const entry = counts.get(violation.connection_id) ?? { week: 0, all: 0 };
    entry.all += 1;
    if (now - new Date(violation.timestamp).getTime() <= WEEK_MS) entry.week += 1;
    counts.set(violation.connection_id, entry);
  }
  return counts;
}

export function countThisWeek(violations: Violation[], now = Date.now()): number {
  let n = 0;
  for (const violation of violations) if (now - new Date(violation.timestamp).getTime() <= WEEK_MS) n += 1;
  return n;
}

export type CameraOf = (nodeId: number) => number | undefined;

/** "1 › 2": a section by its cameras' numbers, in the direction it is enforced. */
export function sectionLabel(edge: Connection, cameraOf: CameraOf): string {
  return `${cameraOf(edge.from_node_id) ?? "?"} › ${cameraOf(edge.to_node_id) ?? "?"}`;
}

export function placeOf(places: Record<string, CameraPlace>, node: CheckpointNode): CameraPlace | undefined {
  return places[String(node.node_id)];
}

export function coordinates(node: CheckpointNode, digits = 5): string {
  return `${node.latitude.toFixed(digits)}, ${node.longitude.toFixed(digits)}`;
}

/** The street a camera is on, or its coordinates while nobody knows. */
export function streetOf(places: Record<string, CameraPlace>, node: CheckpointNode): string {
  return placeOf(places, node)?.street ?? coordinates(node);
}

export type Status = { tone: Tone; label: string };

export function sectionStatus(edge: Connection): Status {
  if (isEnforced(edge)) return { tone: "ok", label: "Measured, enforcing" };
  if (edge.distance_status === "no-route") return { tone: "bad", label: "No road found, not enforcing" };
  return { tone: "warn", label: "Not measured yet, not enforcing" };
}

export function cameraStatus(node: CheckpointNode, connections: Connection[], warning: string | undefined): Status {
  if (warning) return { tone: "warn", label: warning };
  const touching = connections.filter((edge) => edge.from_node_id === node.node_id || edge.to_node_id === node.node_id);
  if (touching.length === 0) return { tone: "off", label: "Not linked to a section" };
  if (touching.some(isEnforced)) return { tone: "ok", label: "In service" };
  return { tone: "warn", label: "No measured section yet" };
}
