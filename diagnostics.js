"use strict";

/**
 * Data-quality diagnostics: finding checkpoints whose position is wrong.
 *
 * A camera reports where it thinks it is, and nothing downstream questions it.
 * A bad GPS fix therefore does not fail; it produces plausible-looking
 * enforcement built on a distance measured between the wrong two points, which
 * is considerably worse than an obvious failure. Nobody reading the violation
 * it produces can tell.
 *
 * Everything here is derived from what the system already holds - node
 * coordinates, road distances, and the offsets a driver reported between the
 * coordinates it was given and the road network it routed on - and none of it
 * is stored. It is cheap to recompute, and derived data goes stale the moment
 * a node moves.
 *
 * This module does arithmetic on node coordinates, which is allowed, and does
 * it through `geo.js`, which is the only place that happens. It does not touch
 * route geometry.
 */

const { haversineMeters } = require("./geo.js");

/**
 * The thresholds, in one block because they are guesses.
 *
 * These are educated starting points, not tuned values: they come from how
 * road networks generally behave, not from measurements of any particular
 * city. They are collected here, and reported in the endpoint's response, so
 * an operator who disagrees with a flag can see exactly which number produced
 * it.
 */
const DIAGNOSTICS = {
  /** Below this separation, circuity says nothing. See `evaluated` below. */
  MIN_DISPLACEMENT_M: 250,
  /** Road distance this many times the straight line is worth a look. */
  CIRCUITY_FLAG: 2.5,
  /** A road shorter than the straight line is impossible, not suspicious. */
  CIRCUITY_IMPOSSIBLE: 0.9,
  /** Metres from a coordinate to the nearest road before it is off-network. */
  ENDPOINT_OFFSET_FLAG_M: 150,
  /** Fewer edges than this and the fraction below is noise. */
  NODE_MIN_EDGES: 3,
  /** Share of a node's judgeable edges that must be circuitous to blame it. */
  NODE_FLAG_FRACTION: 2 / 3,
};

/** The thresholds as the endpoint reports them: snake_case, like every row. */
const THRESHOLDS = {
  min_displacement_m: DIAGNOSTICS.MIN_DISPLACEMENT_M,
  circuity_flag: DIAGNOSTICS.CIRCUITY_FLAG,
  circuity_impossible: DIAGNOSTICS.CIRCUITY_IMPOSSIBLE,
  endpoint_offset_flag_m: DIAGNOSTICS.ENDPOINT_OFFSET_FLAG_M,
  node_min_edges: DIAGNOSTICS.NODE_MIN_EDGES,
  node_flag_fraction: DIAGNOSTICS.NODE_FLAG_FRACTION,
};

/**
 * The metres a driver reported between each coordinate it was given and the
 * road it snapped that coordinate to, or null if it reported nothing usable.
 *
 * Stored as a JSON string by whichever driver answered, so it is parsed
 * defensively: a driver is a separate process written by somebody else, and a
 * malformed offsets array should cost this project its diagnostics, not its
 * distances.
 */
function parseOffsets(value) {
  if (typeof value !== "string" || value === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const usable = parsed.every((entry) => Number.isFinite(entry) && entry >= 0);
  return usable ? parsed : null;
}

/** Rounded for reading. Diagnostics are read by a person, not differenced. */
function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The middle value.
 *
 * Used rather than the mean because the sentence the console builds from it -
 * "3.1 times longer than the straight line" - is meant to describe what is
 * typical of a node's flagged edges, and one 40x edge across a river should
 * not be what the operator is told about the other three.
 */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A fresh tally for a node nothing has been counted against yet. */
function emptyStats() {
  return {
    edgeCount: 0,
    evaluated: 0,
    circuitous: 0,
    impossible: 0,
    flaggedCircuities: [],
    offset: null,
  };
}

/** Keeps the worst distance-to-road any driver has reported for this node. */
function recordOffset(stats, offset) {
  if (!Number.isFinite(offset)) return;
  if (stats.offset === null || offset > stats.offset) stats.offset = offset;
}

/**
 * Every checkpoint and every edge in a project, with what is wrong with them.
 *
 * Pure: it takes the rows and returns the verdict, holding no database handle
 * and no state between calls. That is what makes the thresholds testable
 * against a fixture instead of against a running server.
 *
 * @param {Array} nodes Rows from `getProjectNodes`.
 * @param {Array} connections Rows from `getConnectionsForDiagnostics`.
 */
function analyseProject(nodes, connections) {
  const nodesById = new Map(nodes.map((node) => [node.node_id, node]));
  const stats = new Map(nodes.map((node) => [node.node_id, emptyStats()]));

  const edges = [];
  for (const conn of connections) {
    const from = nodesById.get(conn.from_node_id);
    const to = nodesById.get(conn.to_node_id);
    // An edge whose endpoints are missing cannot be judged against anything.
    if (!from || !to) continue;

    const fromStats = stats.get(conn.from_node_id);
    const toStats = stats.get(conn.to_node_id);
    fromStats.edgeCount += 1;
    toStats.edgeCount += 1;

    const displacement = haversineMeters(
      { lat: from.latitude, lng: from.longitude },
      { lat: to.latitude, lng: to.longitude },
    );

    // Signal A - off-network. The driver said this coordinate was this far
    // from any road it could route on. The most direct evidence that a fix is
    // bad, and the only signal here that needs no inference at all.
    const offsets = parseOffsets(conn.endpoint_offsets);
    if (offsets) {
      recordOffset(fromStats, offsets[0]);
      recordOffset(toStats, offsets[1]);
    }

    // Circuity needs a road distance that means something. An edge nobody has
    // resolved has no ratio, and saying nothing about it is right: it is
    // already visible as unresolved, and it is not evidence about a camera.
    const resolved =
      conn.distance_status === "ok" &&
      Number.isFinite(conn.distance) &&
      conn.distance > 0;
    const circuity =
      resolved && displacement > 0 ? conn.distance / displacement : null;

    const flags = [];

    // Signal B - impossible geometry. A road cannot be shorter than the
    // straight line between its ends. This is not a suspicious node, it is a
    // hard error: swapped latitude and longitude, the wrong units, or a broken
    // driver. The allowance below 1.0 is for a driver snapping both endpoints
    // inward onto the road, which shortens the route legitimately.
    if (circuity !== null && circuity < DIAGNOSTICS.CIRCUITY_IMPOSSIBLE) {
      flags.push("impossible");
      fromStats.impossible += 1;
      toStats.impossible += 1;
    }

    // Signal C - circuity, and only above the displacement floor. Two cameras
    // on opposite sides of a divided road can be 30 m apart with a 400 m drive
    // to the nearest U-turn, and a circuity of 27 there is entirely correct.
    const evaluated =
      circuity !== null && displacement >= DIAGNOSTICS.MIN_DISPLACEMENT_M;
    if (evaluated) {
      fromStats.evaluated += 1;
      toStats.evaluated += 1;
      if (circuity >= DIAGNOSTICS.CIRCUITY_FLAG) {
        flags.push("circuitous");
        fromStats.circuitous += 1;
        toStats.circuitous += 1;
        fromStats.flaggedCircuities.push(circuity);
        toStats.flaggedCircuities.push(circuity);
      }
    }

    edges.push({
      connection_id: conn.connection_id,
      from_node_id: conn.from_node_id,
      to_node_id: conn.to_node_id,
      from_id_in_project: from.id_in_project,
      to_id_in_project: to.id_in_project,
      distance: resolved ? conn.distance : null,
      distance_status: conn.distance_status,
      displacement: round(displacement, 1),
      circuity: circuity === null ? null : round(circuity, 3),
      endpoint_offsets: offsets
        ? offsets.map((offset) => round(offset, 1))
        : null,
      /** Whether this edge counted toward its endpoints' verdicts. */
      evaluated,
      flags,
    });
  }

  const nodeRows = nodes.map((node) => {
    const tally = stats.get(node.node_id);
    const fraction =
      tally.evaluated === 0 ? null : tally.circuitous / tally.evaluated;
    const typical = median(tally.flaggedCircuities);
    const flags = [];

    if (
      tally.offset !== null &&
      tally.offset >= DIAGNOSTICS.ENDPOINT_OFFSET_FLAG_M
    ) {
      flags.push("off-network");
    }

    // The aggregate, and the point of the whole exercise. One circuitous edge
    // is usually real geography - a river with a distant bridge, a rail
    // corridor, a one-way system - and flagging per edge produces false
    // positives forever. A node with a bad fix inflates every edge that
    // touches it, so most of a node's edges being circuitous is evidence about
    // the camera rather than about the roads.
    if (
      tally.evaluated >= DIAGNOSTICS.NODE_MIN_EDGES &&
      fraction !== null &&
      fraction >= DIAGNOSTICS.NODE_FLAG_FRACTION
    ) {
      flags.push("suspect-position");
    }

    return {
      node_id: node.node_id,
      id_in_project: node.id_in_project,
      latitude: node.latitude,
      longitude: node.longitude,
      flags,
      /** Every edge touching this node. */
      edge_count: tally.edgeCount,
      /** Those far enough apart, and resolved enough, to judge. */
      evaluated_edges: tally.evaluated,
      circuitous_edges: tally.circuitous,
      impossible_edges: tally.impossible,
      flagged_fraction: fraction === null ? null : round(fraction, 3),
      /** Median circuity of this node's flagged edges. */
      typical_circuity: typical === null ? null : round(typical, 2),
      /** Worst metres-to-road any driver has reported for this node. */
      endpoint_offset: tally.offset === null ? null : round(tally.offset, 1),
    };
  });

  // Worst first, so the console panel does not have to invent its own opinion
  // of what "worst" means and then disagree with the API about it.
  nodeRows.sort(
    (a, b) =>
      nodeRank(b) - nodeRank(a) ||
      (b.flagged_fraction ?? 0) - (a.flagged_fraction ?? 0) ||
      (b.endpoint_offset ?? 0) - (a.endpoint_offset ?? 0),
  );
  edges.sort(
    (a, b) => edgeRank(b) - edgeRank(a) || (b.circuity ?? 0) - (a.circuity ?? 0),
  );

  return { thresholds: THRESHOLDS, nodes: nodeRows, connections: edges };
}

/** Both flags beats a bad fix, which beats an inference from the graph. */
function nodeRank(node) {
  return (
    (node.flags.includes("off-network") ? 2 : 0) +
    (node.flags.includes("suspect-position") ? 1 : 0)
  );
}

/** An impossible edge is a hard error; a circuitous one is a question. */
function edgeRank(edge) {
  if (edge.flags.includes("impossible")) return 2;
  if (edge.flags.includes("circuitous")) return 1;
  return 0;
}

module.exports = { DIAGNOSTICS, THRESHOLDS, analyseProject };
