/**
 * What a replay undoes, on screen only.
 *
 * Replaying a run starts from the network as it was before that run: the
 * checkpoints and roads it created are hidden, a checkpoint it moved is shown
 * where it was, and a speed limit it changed shows the old value. Each change
 * then lands again at the moment its cursor clicks. Nothing here touches the
 * server or the page's real data; the page draws the graph through the mask.
 */

import type { AgentEvent } from "@/lib/agent";

export type ReplayMask = {
  hiddenNodes: ReadonlySet<number>;
  hiddenConnections: ReadonlySet<number>;
  /** node_id -> where it was before the run moved it. */
  nodeAt: ReadonlyMap<number, { latitude: number; longitude: number }>;
  /** connection_id -> the speed limit before the run changed it. */
  speedLimit: ReadonlyMap<number, number>;
};

/** One change the run made, keyed by the call that made it. */
type Change =
  | { kind: "node"; nodeId: number }
  | { kind: "connection"; connectionId: number }
  | { kind: "move"; nodeId: number; from: { latitude: number; longitude: number } }
  | { kind: "limit"; connectionId: number; previous: number };

const num = (v: unknown) => (typeof v === "number" ? v : null);

/** Every change a recorded run made that the screen would show, by call id. */
export function changesOf(events: AgentEvent[]): Map<string, Change> {
  const started = new Map<string, Extract<AgentEvent, { name: "tool.started" }>["data"]>();
  const changes = new Map<string, Change>();
  for (const e of events) {
    if (e.name === "tool.started") started.set(e.data.call_id, e.data);
    if (e.name !== "tool.finished" || !e.data.ok) continue;
    const r = e.data.result;
    const s = started.get(e.data.call_id);
    switch (e.data.tool) {
      case "create_checkpoint": {
        const id = num(r.node_id);
        if (id !== null) changes.set(e.data.call_id, { kind: "node", nodeId: id });
        break;
      }
      case "create_edge": {
        const id = num(r.connection_id);
        if (id !== null) changes.set(e.data.call_id, { kind: "connection", connectionId: id });
        break;
      }
      case "move_checkpoint_by":
      case "move_checkpoint_to": {
        const target = s?.target;
        if (target?.kind === "node-move" && target.from) {
          changes.set(e.data.call_id, { kind: "move", nodeId: target.node_id, from: target.from });
        }
        break;
      }
      case "set_speed_limit": {
        const id = num(r.connection_id) ?? (s?.target?.kind === "edge" ? s.target.connection_id : null);
        const previous = num(r.previous_speed_limit_kmh);
        if (id !== null && previous !== null) changes.set(e.data.call_id, { kind: "limit", connectionId: id, previous });
        break;
      }
    }
  }
  return changes;
}

/** The screen as it was before the run, with the changes in `landed` put back. */
export function maskFor(changes: Map<string, Change>, landed: ReadonlySet<string>): ReplayMask {
  const hiddenNodes = new Set<number>();
  const hiddenConnections = new Set<number>();
  const nodeAt = new Map<number, { latitude: number; longitude: number }>();
  const speedLimit = new Map<number, number>();
  for (const [callId, c] of changes) {
    if (landed.has(callId)) continue;
    if (c.kind === "node") hiddenNodes.add(c.nodeId);
    if (c.kind === "connection") hiddenConnections.add(c.connectionId);
    // The earliest move of a checkpoint is where it was before the run.
    if (c.kind === "move" && !nodeAt.has(c.nodeId)) nodeAt.set(c.nodeId, c.from);
    if (c.kind === "limit" && !speedLimit.has(c.connectionId)) speedLimit.set(c.connectionId, c.previous);
  }
  return { hiddenNodes, hiddenConnections, nodeAt, speedLimit };
}

/** Whether a run did anything a cursor showed: runs that did not are not worth replaying. */
export function hadCursorWork(events: AgentEvent[]) {
  return events.some((e) => e.name === "tool.started" && e.data.target !== null);
}
