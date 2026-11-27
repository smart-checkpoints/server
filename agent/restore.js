"use strict";

/**
 * Restore points: the checkpoint network as it was at a moment, and putting
 * it back.
 *
 * A snapshot holds positions, edges and speed limits. Never violations or
 * evidence: those are records, and a restore never touches them. Putting a
 * snapshot back goes through the REST API like any other change, so every
 * check, broadcast and distance re-measurement happens as usual.
 *
 * Two things a restore cannot do, and says so:
 *   - delete an edge (or a camera with such an edge) that has violations
 *     linked to it; it stays, and is listed as kept;
 *   - give a camera back its old number. Numbers are never reused, so a
 *     camera deleted since the snapshot comes back under a new one.
 */

const { haversineMeters } = require("../geo.js");

const MOVED_M = 0.5;

async function takeSnapshot(api) {
  const [nodes, edges] = await Promise.all([api.getNodes(), api.getConnections()]);
  return {
    nodes: nodes.map((n) => ({ node_id: n.node_id, camera: n.id_in_project, latitude: n.latitude, longitude: n.longitude })),
    edges: edges.map((e) => ({ connection_id: e.connection_id, from_node_id: e.from_node_id, to_node_id: e.to_node_id, speed_limit: e.speed_limit })),
  };
}

/** What putting `snapshot` back would change, against the network now. */
async function planRestore(api, snapshot) {
  const [nodes, edges, violations] = await Promise.all([api.getNodes(), api.getConnections(), api.getViolations()]);
  const nowNode = new Map(nodes.map((n) => [n.node_id, n]));
  const thenNode = new Map(snapshot.nodes.map((n) => [n.node_id, n]));
  const linked = new Map();
  for (const v of violations) if (v.connection_id != null) linked.set(v.connection_id, (linked.get(v.connection_id) || 0) + 1);

  const recreate = snapshot.nodes.filter((n) => !nowNode.has(n.node_id));
  const move = snapshot.nodes.filter((n) => {
    const now = nowNode.get(n.node_id);
    return now && haversineMeters({ lat: now.latitude, lng: now.longitude }, { lat: n.latitude, lng: n.longitude }) > MOVED_M;
  });

  const key = (from, to) => `${from}>${to}`;
  const thenEdges = new Map(snapshot.edges.map((e) => [key(e.from_node_id, e.to_node_id), e]));
  const nowEdges = new Map(edges.map((e) => [key(e.from_node_id, e.to_node_id), e]));

  const addedEdges = edges.filter((e) => !thenEdges.has(key(e.from_node_id, e.to_node_id)));
  const deleteEdges = addedEdges.filter((e) => !linked.has(e.connection_id));
  const keptEdges = addedEdges.filter((e) => linked.has(e.connection_id));
  const createEdges = snapshot.edges.filter((e) => !nowEdges.has(key(e.from_node_id, e.to_node_id)));
  const limits = snapshot.edges
    .map((e) => ({ then: e, now: nowEdges.get(key(e.from_node_id, e.to_node_id)) }))
    .filter(({ then, now }) => now && now.speed_limit !== then.speed_limit)
    .map(({ then, now }) => ({ connection_id: now.connection_id, from: then.from_node_id, to: then.to_node_id, speed_limit: then.speed_limit, was: now.speed_limit }));

  // A camera added since goes, unless one of its edges has to stay.
  const added = nodes.filter((n) => !thenNode.has(n.node_id));
  const deleteNodes = added.filter((n) => !keptEdges.some((e) => e.from_node_id === n.node_id || e.to_node_id === n.node_id));
  const keptNodes = added.filter((n) => !deleteNodes.includes(n));

  const cam = (id) => (nowNode.get(id) || thenNode.get(id) || {}).id_in_project ?? (thenNode.get(id) || {}).camera ?? "?";
  return {
    recreate,
    move,
    deleteEdges,
    createEdges,
    limits,
    deleteNodes,
    kept: { edges: keptEdges.map((e) => ({ connection_id: e.connection_id, pair: `${cam(e.from_node_id)} → ${cam(e.to_node_id)}`, violations: linked.get(e.connection_id) })), cameras: keptNodes.map((n) => n.id_in_project) },
    cam,
  };
}

function isEmpty(plan) {
  return !plan.recreate.length && !plan.move.length && !plan.deleteEdges.length && !plan.createEdges.length && !plan.limits.length && !plan.deleteNodes.length;
}

/** The plan in the operator's words, for a confirmation card. */
function describePlan(plan) {
  const lines = [];
  const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (plan.deleteNodes.length) lines.push(`Removes ${n(plan.deleteNodes.length, "camera")} added since: ${plan.deleteNodes.map((x) => x.id_in_project).join(", ")}.`);
  if (plan.move.length) lines.push(`Moves ${n(plan.move.length, "camera")} back: ${plan.move.map((x) => x.camera).join(", ")}.`);
  if (plan.recreate.length) lines.push(`Brings back ${n(plan.recreate.length, "deleted camera")} (was ${plan.recreate.map((x) => x.camera).join(", ")}), under new numbers.`);
  const edgeParts = [];
  if (plan.deleteEdges.length) edgeParts.push(`removes ${n(plan.deleteEdges.length, "edge")}`);
  if (plan.createEdges.length) edgeParts.push(`re-creates ${n(plan.createEdges.length, "edge")}`);
  if (plan.limits.length) edgeParts.push(`puts back ${n(plan.limits.length, "speed limit")}`);
  if (edgeParts.length) lines.push(`${edgeParts.join(", ").replace(/^./, (c) => c.toUpperCase())}.`);
  if (plan.kept.edges.length) {
    lines.push(`Kept, because violations are linked to them: ${plan.kept.edges.map((e) => `${e.pair} (${e.violations})`).join(", ")}.`);
  }
  if (plan.createEdges.length || plan.move.length) lines.push("Re-created and moved edges enforce again once the distance driver measures them.");
  return lines;
}

/** Carries the plan out through the REST API. Best effort, step by step; reports what did not work. */
async function applyRestore(api, plan) {
  const done = { created_cameras: [], moved: 0, deleted_edges: 0, created_edges: 0, limits: 0, deleted_cameras: [], failed: [] };
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      done.failed.push(`${what}: ${err.message}`);
    }
  };
  const idMap = new Map();
  for (const node of plan.recreate) {
    await step(`bring back camera ${node.camera}`, async () => {
      const created = await api.createNode(node.latitude, node.longitude);
      idMap.set(node.node_id, created.node_id);
      done.created_cameras.push({ was: node.camera, now: created.id_in_project });
    });
  }
  for (const node of plan.move) {
    await step(`move camera ${node.camera}`, async () => {
      await api.moveNode(node.node_id, node.latitude, node.longitude);
      done.moved += 1;
    });
  }
  for (const edge of plan.deleteEdges) {
    await step(`remove edge ${edge.connection_id}`, async () => {
      await api.deleteConnection(edge.connection_id);
      done.deleted_edges += 1;
    });
  }
  for (const edge of plan.createEdges) {
    const from = idMap.get(edge.from_node_id) ?? edge.from_node_id;
    const to = idMap.get(edge.to_node_id) ?? edge.to_node_id;
    await step(`re-create edge ${plan.cam(edge.from_node_id)} → ${plan.cam(edge.to_node_id)}`, async () => {
      await api.createConnection(from, to, edge.speed_limit);
      done.created_edges += 1;
    });
  }
  for (const limit of plan.limits) {
    await step(`put back the limit on edge ${limit.connection_id}`, async () => {
      await api.setSpeedLimit(limit.connection_id, limit.speed_limit);
      done.limits += 1;
    });
  }
  for (const node of plan.deleteNodes) {
    await step(`remove camera ${node.id_in_project}`, async () => {
      await api.deleteNode(node.node_id);
      done.deleted_cameras.push(node.id_in_project);
    });
  }
  done.kept = plan.kept;
  return done;
}

module.exports = { takeSnapshot, planRestore, describePlan, applyRestore, isEmpty };
