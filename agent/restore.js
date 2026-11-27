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
 * Removing what was added since goes through the same DELETE as anything
 * else, so what has violations is retired rather than deleted. What was
 * retired since comes back as it was, old number included; only a camera
 * deleted outright since comes back under a new number, because numbers are
 * never reused.
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
  const [nodes, edges, retired] = await Promise.all([api.getNodes(), api.getConnections(), api.getRetired()]);
  const retiredNodes = new Set(retired.nodes.map((n) => n.node_id));
  const retiredEdges = new Set(retired.connections.map((e) => e.connection_id));
  const nowNode = new Map(nodes.map((n) => [n.node_id, n]));
  const thenNode = new Map(snapshot.nodes.map((n) => [n.node_id, n]));
  const missing = snapshot.nodes.filter((n) => !nowNode.has(n.node_id));
  const unretireNodes = missing.filter((n) => retiredNodes.has(n.node_id));
  const recreate = missing.filter((n) => !retiredNodes.has(n.node_id));
  const move = snapshot.nodes.filter((n) => {
    const now = nowNode.get(n.node_id);
    return now && haversineMeters({ lat: now.latitude, lng: now.longitude }, { lat: n.latitude, lng: n.longitude }) > MOVED_M;
  });

  const key = (from, to) => `${from}>${to}`;
  const thenEdges = new Map(snapshot.edges.map((e) => [key(e.from_node_id, e.to_node_id), e]));
  const nowEdges = new Map(edges.map((e) => [key(e.from_node_id, e.to_node_id), e]));

  const deleteEdges = edges.filter((e) => !thenEdges.has(key(e.from_node_id, e.to_node_id)));
  const missingEdges = snapshot.edges.filter((e) => !nowEdges.has(key(e.from_node_id, e.to_node_id)));
  const unretireEdges = missingEdges.filter((e) => retiredEdges.has(e.connection_id));
  const createEdges = missingEdges.filter((e) => !retiredEdges.has(e.connection_id));
  const limits = snapshot.edges
    .map((e) => ({ then: e, now: nowEdges.get(key(e.from_node_id, e.to_node_id)) }))
    .filter(({ then, now }) => now && now.speed_limit !== then.speed_limit)
    .map(({ then, now }) => ({ connection_id: now.connection_id, from: then.from_node_id, to: then.to_node_id, speed_limit: then.speed_limit, was: now.speed_limit }));

  const deleteNodes = nodes.filter((n) => !thenNode.has(n.node_id));

  const cam = (id) => (nowNode.get(id) || thenNode.get(id) || {}).id_in_project ?? (thenNode.get(id) || {}).camera ?? "?";
  return { unretireNodes, recreate, move, deleteEdges, unretireEdges, createEdges, limits, deleteNodes, cam };
}

function isEmpty(plan) {
  return [plan.unretireNodes, plan.recreate, plan.move, plan.deleteEdges, plan.unretireEdges, plan.createEdges, plan.limits, plan.deleteNodes].every(
    (list) => list.length === 0,
  );
}

/** The plan in the operator's words, for a confirmation card. */
function describePlan(plan) {
  const lines = [];
  const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (plan.deleteNodes.length) lines.push(`Removes ${n(plan.deleteNodes.length, "camera")} added since: ${plan.deleteNodes.map((x) => x.id_in_project).join(", ")}.`);
  if (plan.move.length) lines.push(`Moves ${n(plan.move.length, "camera")} back: ${plan.move.map((x) => x.camera).join(", ")}.`);
  if (plan.unretireNodes.length) lines.push(`Brings back ${n(plan.unretireNodes.length, "retired camera")}: ${plan.unretireNodes.map((x) => x.camera).join(", ")}.`);
  if (plan.recreate.length) lines.push(`Brings back ${n(plan.recreate.length, "deleted camera")} (was ${plan.recreate.map((x) => x.camera).join(", ")}), under new numbers.`);
  const edgeParts = [];
  if (plan.deleteEdges.length) edgeParts.push(`removes ${n(plan.deleteEdges.length, "edge")}`);
  if (plan.unretireEdges.length) edgeParts.push(`brings back ${n(plan.unretireEdges.length, "retired edge")}`);
  if (plan.createEdges.length) edgeParts.push(`re-creates ${n(plan.createEdges.length, "edge")}`);
  if (plan.limits.length) edgeParts.push(`puts back ${n(plan.limits.length, "speed limit")}`);
  if (edgeParts.length) lines.push(`${edgeParts.join(", ").replace(/^./, (c) => c.toUpperCase())}.`);
  if (plan.deleteEdges.length || plan.deleteNodes.length) lines.push("Anything removed that has violations is retired, so the violations stay on record.");
  if (plan.createEdges.length || plan.move.length) lines.push("Re-created and moved edges enforce again once the distance driver measures them.");
  return lines;
}

/** Carries the plan out through the REST API. Best effort, step by step; reports what did not work. */
async function applyRestore(api, plan) {
  const done = { brought_back_cameras: [], created_cameras: [], moved: 0, deleted_edges: 0, brought_back_edges: 0, created_edges: 0, limits: 0, deleted_cameras: [], failed: [] };
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      done.failed.push(`${what}: ${err.message}`);
    }
  };
  const idMap = new Map();
  for (const node of plan.unretireNodes) {
    await step(`bring back camera ${node.camera}`, async () => {
      await api.unretireNode(node.node_id);
      done.brought_back_cameras.push(node.camera);
    });
  }
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
  for (const edge of plan.unretireEdges) {
    await step(`bring back edge ${plan.cam(edge.from_node_id)} → ${plan.cam(edge.to_node_id)}`, async () => {
      await api.unretireConnection(edge.connection_id);
      done.brought_back_edges += 1;
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
  return done;
}

module.exports = { takeSnapshot, planRestore, describePlan, applyRestore, isEmpty };
