"use strict";

/**
 * Sayes's tools.
 *
 * Each one maps onto ALLOWED endpoints of the REST API and nothing else.
 * What the agent must never do - create, edit or delete violations or
 * evidence, touch API keys, auth, projects or the map driver - has no tool
 * here at all, so no prompt can talk it into doing so. Removing a checkpoint
 * or edge deletes it if it never had a violation and retires it otherwise
 * (the server decides, so violations always keep what they point at), always
 * behind an operator confirmation. No tool accepts a road distance: distances
 * are measured by the distance driver, never stated by the agent.
 *
 * A tool has three parts:
 *   validate(input)      -> { value } or { error }; inputs are re-checked here
 *                           even though the schemas are strict.
 *   prepare(value, ctx)  -> { target, confirm, plan }: reads what the call
 *                           needs, says where the cursor goes, and whether an
 *                           operator has to approve it first.
 *   run(plan, ctx)       -> the result handed back to the model.
 *
 * `target` is null for tools that get no cursor: reads, local lookups and
 * display-only calls. Cursors are only for calls that do something visible.
 */

const { makeProjection, haversineMeters } = require("../geo.js");
const places = require("./places");
const { camerasOnSegment } = require("../diagnostics.js");
const osm = require("./osm");
const { buildReport } = require("./report.js");
const { takeSnapshot, planRestore, describePlan, applyRestore, isEmpty } = require("./restore.js");

/** OSM services fail in ordinary ways (busy, rate limited); say so plainly. */
async function osmCall(task) {
  try {
    return await task();
  } catch (err) {
    if (err instanceof osm.OsmError) throw new ToolError(`${err.message} OpenStreetMap lookups are a shared public service; try again shortly.`);
    throw err;
  }
}

const MIN_LIMIT_KMH = 5;
const MAX_LIMIT_KMH = 200;
const MAX_MOVE_M = 2000;

const strict = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const isInt = (value) => Number.isInteger(value);
const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const isLatLng = (lat, lng) => isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

class ToolError extends Error {}

/* -------------------------------------------------------------------------
   Shared reads
   ------------------------------------------------------------------------- */

function edgeStatus(edge, driverConnected) {
  if (edge.distance_status === "ok") return "measured";
  if (edge.distance_status === "no-route") return "no route found";
  return driverConnected ? "measuring" : "not measured (no distance driver connected)";
}

function describeNode(node) {
  const near = places.nearestLandmark(node.latitude, node.longitude);
  const street = places.streetAt(node.latitude, node.longitude);
  return {
    node_id: node.node_id,
    camera: node.id_in_project,
    latitude: node.latitude,
    longitude: node.longitude,
    ...(street ? { street } : {}),
    ...(near ? { near: `${near.name} (${near.metres} m)` } : {}),
  };
}

function describeEdge(edge, driverConnected) {
  return {
    connection_id: edge.connection_id,
    from_node_id: edge.from_node_id,
    to_node_id: edge.to_node_id,
    speed_limit_kmh: edge.speed_limit,
    distance_m: edge.distance === null ? null : Math.round(edge.distance),
    status: edgeStatus(edge, driverConnected),
  };
}

async function readNetwork(api) {
  const [nodes, edges, driver] = await Promise.all([
    api.getNodes(),
    api.getConnections(),
    api.getDistanceDriverStatus(),
  ]);
  return { nodes, edges, driverConnected: Boolean(driver && driver.connected) };
}

async function findNode(api, nodeId) {
  const nodes = await api.getNodes();
  const node = nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node) throw new ToolError(`There is no checkpoint with node_id ${nodeId} in this project.`);
  return node;
}

const cameraOf = (nodes) => (nodeId) => {
  const node = nodes.find((n) => n.node_id === nodeId);
  return node ? node.id_in_project : "?";
};

/**
 * Where a coordinate is along a demo street, if it is on one. On a one-way or
 * divided street only edges running the traced way count as being on it:
 * the reverse way is the other carriageway, or not a legal road at all.
 */
function along(street, node) {
  return street ? places.positionOnStreet(street, node.latitude, node.longitude) : null;
}

function streetOf(node) {
  const name = places.streetAt(node.latitude, node.longitude);
  return name ? places.findStreet(name) : null;
}

/** Same street, and this edge runs a way that street carries. */
function edgeSpan(street, from, to) {
  const pf = along(street, from);
  const pt = along(street, to);
  if (!pf || !pt || pf.metres === pt.metres) return null;
  if (street.layout !== "two-way" && pt.metres < pf.metres) return null;
  return { lo: Math.min(pf.metres, pt.metres), hi: Math.max(pf.metres, pt.metres) };
}

const END_MARGIN_M = 25;

/**
 * The cameras an edge from -> to would pass: on the street between its two
 * ends when all three are on a demo street (which follows the road's curves),
 * and otherwise on the straight line between them, as the server's quality
 * check sees it.
 */
function camerasBetween(from, to, nodes, edges) {
  const street = streetOf(from);
  const span = street && edgeSpan(street, from, to);
  const found = new Map(camerasOnSegment(from, to, nodes, edges).map((c) => [c.node_id, c]));
  if (span) {
    for (const node of nodes) {
      if (node.node_id === from.node_id || node.node_id === to.node_id || found.has(node.node_id)) continue;
      const at = along(street, node);
      if (at && at.metres > span.lo + END_MARGIN_M && at.metres < span.hi - END_MARGIN_M) {
        found.set(node.node_id, { node_id: node.node_id, id_in_project: node.id_in_project });
      }
    }
  }
  return [...found.values()];
}

/** The edge a position sits on (between its two cameras, same road), or null. */
function edgeUnder(point, nodes, edges) {
  const ghost = { node_id: -1, id_in_project: -1, latitude: point.latitude, longitude: point.longitude };
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  for (const edge of edges) {
    const from = byId.get(edge.from_node_id);
    const to = byId.get(edge.to_node_id);
    if (!from || !to) continue;
    if (camerasBetween(from, to, [from, to, ghost], [edge]).some((c) => c.node_id === -1)) return { edge, from, to };
  }
  return null;
}

/* -------------------------------------------------------------------------
   The tools
   ------------------------------------------------------------------------- */

const TOOLS = [
  {
    name: "get_network",
    loose: true,
    description:
      "Read the current checkpoint network: every checkpoint (node_id, camera number, position, nearby landmark) and every edge (a one-way road section between two checkpoints, with its speed limit, measured road distance and status), plus whether a distance driver is connected. Call this before acting on existing checkpoints or edges.",
    input_schema: strict({}),
    validate: () => ({ value: {} }),
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const { nodes, edges, driverConnected } = await readNetwork(ctx.api);
      return {
        distance_driver_connected: driverConnected,
        checkpoints: nodes.map(describeNode),
        edges: edges.map((edge) => describeEdge(edge, driverConnected)),
      };
    },
  },

  {
    name: "get_driver_status",
    loose: true,
    description:
      "Check whether a distance driver (the routing service that measures road distances) is connected to this project. Read-only: drivers are separate services and cannot be switched from here.",
    input_schema: strict({}),
    validate: () => ({ value: {} }),
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const status = await ctx.api.getDistanceDriverStatus();
      return { distance_driver_connected: Boolean(status && status.connected) };
    },
  },

  {
    name: "find_place",
    loose: true,
    description:
      "Look up a street or landmark in the demo place list (Alexandria: Fouad Street / El Horreya Road, El Geish Road / the Corniche at El Shatby, Abu Qir Street, and landmarks along them). Returns coordinates on the road. This is the only source of coordinates for named places; never guess coordinates.",
    input_schema: strict({ query: { type: "string", description: "A street or landmark name, as the operator said it." } }),
    validate: (input) =>
      typeof input.query === "string" && input.query.trim()
        ? { value: { query: input.query.trim().slice(0, 200) } }
        : { error: "query must be a non-empty string" },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan) => {
      const matches = places.findPlaces(plan.query);
      if (matches.length === 0) {
        return {
          matches: [],
          note: "Not in the place list. Ask the operator for coordinates; do not guess.",
          known_places: [
            ...places.places.streets.map((s) => s.name),
            ...places.places.landmarks.map((l) => l.name),
          ],
        };
      }
      return { matches: matches.slice(0, 5) };
    },
  },

  {
    name: "points_along_street",
    description:
      "Get points for new checkpoints on a known street, spacing_m apart, in the legal direction of travel. They are always placed in the first stretch of the street that is clear of the cameras and edges already there, so a new stretch never overlaps or interleaves with an existing one. To add a camera between two existing ones, use points_between and split_edge instead. Also returns the cameras already on the street and how traffic runs, which decides how to connect the new ones. About 800 m is a sensible default spacing.",
    input_schema: strict({
      street: { type: "string", description: "Street name from the place list." },
      count: { type: "integer", description: "How many points, 1 to 10." },
      spacing_m: { type: "number", description: "Metres between neighbouring points, 100 to 3000." },
    }),
    validate: (input) => {
      if (typeof input.street !== "string" || !input.street.trim()) return { error: "street must be a non-empty string" };
      if (!isInt(input.count) || input.count < 1 || input.count > 10) return { error: "count must be an integer from 1 to 10" };
      if (!isNum(input.spacing_m) || input.spacing_m < 100 || input.spacing_m > 3000) return { error: "spacing_m must be 100 to 3000" };
      return { value: { street: input.street.trim(), count: input.count, spacing_m: Math.round(input.spacing_m) } };
    },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const street = places.findStreet(plan.street);
      if (!street) {
        throw new ToolError(
          `"${plan.street}" is not in the place list. Known streets: ${places.places.streets.map((s) => s.name).join("; ")}.`,
        );
      }
      const [nodes, edges] = await Promise.all([ctx.api.getNodes(), ctx.api.getConnections()]);
      const on = new Map();
      for (const node of nodes) {
        const at = places.positionOnStreet(street, node.latitude, node.longitude);
        if (at) on.set(node.node_id, { camera: node.id_in_project, node_id: node.node_id, metres: at.metres });
      }
      // Taken: every camera, and every edge's span between two cameras on
      // this street, so a new stretch cannot land inside an existing one.
      const clearance = Math.max(200, plan.spacing_m / 2);
      const taken = [...on.values()].map((c) => c.metres);
      for (const edge of edges) {
        const a = on.get(edge.from_node_id);
        const b = on.get(edge.to_node_id);
        if (!a || !b) continue;
        const lo = Math.min(a.metres, b.metres);
        const hi = Math.max(a.metres, b.metres);
        for (let m = lo; m <= hi; m += clearance) taken.push(m);
      }
      const existing = [...on.values()].sort((a, b) => a.metres - b.metres);
      const points = places.pointsInFreeStretch(street, plan.count, plan.spacing_m, taken, clearance);
      if (!points) {
        throw new ToolError(
          `No clear stretch of ${(plan.count - 1) * plan.spacing_m} m is left on ${street.name} (${street.length_m} m in the place list). ` +
            `Cameras already there: ${existing.map((c) => `camera ${c.camera} at ${c.metres} m`).join(", ") || "none"}. ` +
            "Ask the operator where to put them, or use a shorter spacing.",
        );
      }
      return {
        street: street.name,
        layout: street.layout,
        direction: street.direction,
        traffic: street.traffic,
        connect: places.connectRule(street),
        length_m: street.length_m,
        existing_cameras_on_street: existing.map((c) => ({ camera: c.camera, node_id: c.node_id, metres_from_start: c.metres })),
        new_stretch: `${points[0].metres_from_start} to ${points[points.length - 1].metres_from_start} m from the start, clear of the cameras above`,
        points,
      };
    },
  },

  {
    name: "points_between",
    loose: true,
    description:
      "Get evenly spaced points on the road between two existing checkpoints, for adding cameras in between. Place each one with split_edge on the edge that connects them, never with create_checkpoint.",
    input_schema: strict({
      from_node_id: { type: "integer" },
      to_node_id: { type: "integer" },
      count: { type: "integer", description: "How many points, 1 to 5." },
    }),
    validate: (input) => {
      if (!isInt(input.from_node_id) || !isInt(input.to_node_id)) return { error: "node ids must be integers" };
      if (!isInt(input.count) || input.count < 1 || input.count > 5) return { error: "count must be 1 to 5" };
      return { value: { ...input } };
    },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const nodes = await ctx.api.getNodes();
      const a = nodes.find((n) => n.node_id === plan.from_node_id);
      const b = nodes.find((n) => n.node_id === plan.to_node_id);
      if (!a || !b) throw new ToolError("Both checkpoints must exist in this project.");
      const name = places.streetAt(a.latitude, a.longitude);
      const street = name ? places.findStreet(name) : null;
      const pa = street && places.positionOnStreet(street, a.latitude, a.longitude);
      const pb = street && places.positionOnStreet(street, b.latitude, b.longitude);
      const points = [];
      for (let i = 1; i <= plan.count; i += 1) {
        const f = i / (plan.count + 1);
        points.push(
          pa && pb
            ? places.pointAt(street, pa.metres + (pb.metres - pa.metres) * f)
            : { latitude: round6(a.latitude + (b.latitude - a.latitude) * f), longitude: round6(a.longitude + (b.longitude - a.longitude) * f) },
        );
      }
      return { from_camera: a.id_in_project, to_camera: b.id_in_project, on_street: pa && pb ? street.name : null, points };
    },
  },

  {
    name: "create_checkpoint",
    description:
      "Place one new checkpoint (camera) at a position. Use coordinates from find_place or points_along_street. To place several, call this several times in the same turn: the calls run in parallel. Refused if the position is on an existing edge between two cameras: use split_edge for that.",
    input_schema: strict({
      latitude: { type: "number", description: "WGS84 degrees." },
      longitude: { type: "number", description: "WGS84 degrees." },
    }),
    validate: (input) =>
      isLatLng(input.latitude, input.longitude)
        ? { value: { latitude: round6(input.latitude), longitude: round6(input.longitude) } }
        : { error: "latitude must be within +/-90 and longitude within +/-180" },
    prepare: async (value, ctx) => {
      const [nodes, edges] = await Promise.all([ctx.api.getNodes(), ctx.api.getConnections()]);
      const hit = edgeUnder(value, nodes, edges);
      if (hit) {
        throw new ToolError(
          `That position is on the existing edge from camera ${hit.from.id_in_project} to camera ${hit.to.id_in_project} (connection_id ${hit.edge.connection_id}). ` +
            "Use split_edge, so that edge is replaced by two edges through the new camera.",
        );
      }
      return { target: { kind: "point", latitude: value.latitude, longitude: value.longitude }, plan: value };
    },
    run: async (plan, ctx) => {
      const created = await ctx.api.createNode(plan.latitude, plan.longitude);
      return {
        node_id: created.node_id,
        camera: created.id_in_project,
        latitude: plan.latitude,
        longitude: plan.longitude,
      };
    },
  },

  {
    name: "import_checkpoints",
    description:
      "Place many checkpoints at once, for example every row of a CSV the operator attached: one call, one confirmation card. Points that fall on an existing edge are skipped and reported (use split_edge for those). Up to 100 points; camera numbers follow the order given. Connect them afterwards with create_edge in the legal direction of travel.",
    input_schema: strict({
      points: {
        type: "array",
        items: strict({
          latitude: { type: "number" },
          longitude: { type: "number" },
          label: { type: "string", description: "The row's name or id from the file, or an empty string." },
        }),
      },
      source: { type: "string", description: "Where the points came from, for example the file name." },
    }),
    validate: (input) => {
      if (!Array.isArray(input.points) || input.points.length === 0 || input.points.length > 100) {
        return { error: "points must be a list of 1 to 100" };
      }
      const bad = input.points.findIndex((p) => !p || !isLatLng(p.latitude, p.longitude));
      if (bad >= 0) return { error: `point ${bad + 1} has an invalid latitude/longitude` };
      return {
        value: {
          points: input.points.map((p) => ({
            latitude: round6(p.latitude),
            longitude: round6(p.longitude),
            label: typeof p.label === "string" ? p.label.slice(0, 60) : "",
          })),
          source: typeof input.source === "string" ? input.source.slice(0, 120) : "",
        },
      };
    },
    prepare: async (value, ctx) => {
      const [nodes, edges] = await Promise.all([ctx.api.getNodes(), ctx.api.getConnections()]);
      const place = [];
      const skipped = [];
      for (const p of value.points) {
        const hit = edgeUnder(p, nodes, edges);
        if (hit) skipped.push({ ...p, on_edge: `${hit.from.id_in_project} → ${hit.to.id_in_project}` });
        else place.push(p);
      }
      if (place.length === 0) throw new ToolError("Every point is on an existing edge. Use split_edge for those.");
      const streets = {};
      for (const p of place) {
        const street = places.streetAt(p.latitude, p.longitude) || "elsewhere";
        streets[street] = (streets[street] || 0) + 1;
      }
      return {
        target: { kind: "point", latitude: place[0].latitude, longitude: place[0].longitude },
        confirm: {
          summary: `Place ${place.length} camera${place.length === 1 ? "" : "s"}${value.source ? ` from ${value.source}` : ""}?`,
          details: [
            `Where: ${Object.entries(streets).map(([s, n]) => `${n} on ${s}`).join(", ")}.`,
            ...(skipped.length ? [`Skipped ${skipped.length}: on an existing edge (${skipped.map((p) => p.label || p.on_edge).join(", ")}).`] : []),
            "They are not connected yet; edges come next.",
          ],
        },
        plan: { place, skipped },
      };
    },
    run: async (plan, ctx) => {
      const created = [];
      const failed = [];
      for (const p of plan.place) {
        try {
          const node = await ctx.api.createNode(p.latitude, p.longitude);
          created.push({ node_id: node.node_id, camera: node.id_in_project, label: p.label });
        } catch (err) {
          failed.push({ label: p.label, error: err.message });
        }
      }
      return { created, skipped_on_existing_edges: plan.skipped, ...(failed.length ? { failed } : {}) };
    },
  },

  {
    name: "create_edge",
    description:
      "Connect two ADJACENT checkpoints with a one-way edge (from -> to) and a speed limit, in the legal direction of travel. Refused if another camera sits on the road between them: connect through that camera instead. The road distance is measured by the distance driver; it cannot be set here. Only on a two-way undivided road, or when the operator asks for both directions, add the reverse edge too. Create all the edges in the same turn. Measuring can take several seconds.",
    input_schema: strict({
      from_node_id: { type: "integer" },
      to_node_id: { type: "integer" },
      speed_limit_kmh: { type: "number", description: `${MIN_LIMIT_KMH} to ${MAX_LIMIT_KMH}.` },
    }),
    validate: (input) => {
      if (!isInt(input.from_node_id) || !isInt(input.to_node_id)) return { error: "node ids must be integers" };
      if (input.from_node_id === input.to_node_id) return { error: "an edge needs two different checkpoints" };
      if (!isNum(input.speed_limit_kmh) || input.speed_limit_kmh < MIN_LIMIT_KMH || input.speed_limit_kmh > MAX_LIMIT_KMH) {
        return { error: `speed_limit_kmh must be between ${MIN_LIMIT_KMH} and ${MAX_LIMIT_KMH}` };
      }
      return { value: { ...input } };
    },
    prepare: async (value, ctx) => {
      const { nodes, edges, driverConnected } = await readNetwork(ctx.api);
      const existing = edges.find(
        (edge) => edge.from_node_id === value.from_node_id && edge.to_node_id === value.to_node_id,
      );
      if (existing) {
        throw new ToolError(
          `These checkpoints are already connected in this direction (connection_id ${existing.connection_id}, ${existing.speed_limit} km/h). Use set_speed_limit to change it.`,
        );
      }
      const from = nodes.find((n) => n.node_id === value.from_node_id);
      const to = nodes.find((n) => n.node_id === value.to_node_id);
      if (from && to) {
        const skipped = camerasBetween(from, to, nodes, edges);
        if (skipped.length > 0) {
          throw new ToolError(
            `Camera ${skipped.map((c) => c.id_in_project).join(", ")} is on the road between camera ${from.id_in_project} and camera ${to.id_in_project}. ` +
              "An edge must connect neighbouring cameras: connect through the camera in between instead.",
          );
        }
      }
      return {
        target: { kind: "edge-new", from_node_id: value.from_node_id, to_node_id: value.to_node_id },
        plan: { ...value, driverConnected },
      };
    },
    run: async (plan, ctx) => {
      if (plan.driverConnected) ctx.progress({ state: "measuring", note: "Measuring the road distance" });
      const created = await ctx.api.createConnection(plan.from_node_id, plan.to_node_id, plan.speed_limit_kmh);
      const edges = await ctx.api.getConnections();
      const edge = edges.find((candidate) => candidate.connection_id === created.connection_id);
      const result = edge
        ? describeEdge(edge, plan.driverConnected)
        : { connection_id: created.connection_id, status: "created" };
      if (!plan.driverConnected) {
        result.note = "No distance driver is connected, so this edge is not enforcing until one measures it.";
      }
      return result;
    },
  },

  {
    name: "split_edge",
    description:
      "Add a camera ON an existing edge A -> B: creates checkpoint N there, connects A -> N and N -> B at the same speed limit, and removes A -> B (retired, not deleted, if violations are linked to it, so they stay on record). If B -> A exists too, it is split the same way. Get the position from points_between. The operator always confirms.",
    input_schema: strict({
      connection_id: { type: "integer" },
      latitude: { type: "number" },
      longitude: { type: "number" },
    }),
    validate: (input) => {
      if (!isInt(input.connection_id)) return { error: "connection_id must be an integer" };
      if (!isLatLng(input.latitude, input.longitude)) return { error: "latitude/longitude out of range" };
      return { value: { connection_id: input.connection_id, latitude: round6(input.latitude), longitude: round6(input.longitude) } };
    },
    prepare: async (value, ctx) => {
      const [nodes, edges, violations] = await Promise.all([
        ctx.api.getNodes(),
        ctx.api.getConnections(),
        ctx.api.getViolations(),
      ]);
      const edge = edges.find((e) => e.connection_id === value.connection_id);
      if (!edge) throw new ToolError(`There is no edge with connection_id ${value.connection_id}.`);
      const cam = cameraOf(nodes);
      const hit = edgeUnder(value, nodes, [edge]);
      if (!hit) {
        throw new ToolError(
          `That position is not on the edge from camera ${cam(edge.from_node_id)} to camera ${cam(edge.to_node_id)}. Use points_between for a position on it.`,
        );
      }
      const reverse = edges.find((e) => e.from_node_id === edge.to_node_id && e.to_node_id === edge.from_node_id);
      const split = reverse ? [edge, reverse] : [edge];
      const linked = violations.filter((v) => split.some((e) => e.connection_id === v.connection_id)).length;
      const pair = (e) => `${cam(e.from_node_id)} → ${cam(e.to_node_id)}`;
      return {
        target: { kind: "point", latitude: value.latitude, longitude: value.longitude },
        confirm: {
          summary: `Add a camera between camera ${cam(edge.from_node_id)} and camera ${cam(edge.to_node_id)}?`,
          details: [
            `Replaces ${split.map(pair).join(" and ")} with two edges through the new camera, at ${edge.speed_limit} km/h.`,
            linked > 0
              ? `The old section is retired, not deleted: its ${linked} violation${linked === 1 ? "" : "s"} stay on record.`
              : "No violations are linked to the section being replaced.",
            "The new sections enforce once the distance driver measures them.",
          ],
        },
        plan: {
          ...value,
          split: split.map((e) => ({ connection_id: e.connection_id, from: e.from_node_id, to: e.to_node_id, limit: e.speed_limit })),
        },
      };
    },
    run: async (plan, ctx) => {
      const created = await ctx.api.createNode(plan.latitude, plan.longitude);
      const replaced = [];
      for (const old of plan.split) {
        const first = await ctx.api.createConnection(old.from, created.node_id, old.limit);
        const second = await ctx.api.createConnection(created.node_id, old.to, old.limit);
        await ctx.api.deleteConnection(old.connection_id);
        replaced.push({ deleted_connection_id: old.connection_id, new_connection_ids: [first.connection_id, second.connection_id] });
      }
      return { node_id: created.node_id, camera: created.id_in_project, latitude: plan.latitude, longitude: plan.longitude, replaced };
    },
  },

  {
    name: "delete_edges",
    description:
      "Remove one or more edges, in ONE call with all their connection_ids: the operator approves them together on one card. An edge that never had a violation is deleted; one with violations is retired instead (taken out of the network and no longer enforcing, while its violations stay on record), automatically. Never refuse a removal because of violations.",
    input_schema: strict({ connection_ids: { type: "array", items: { type: "integer" } } }),
    validate: (input) =>
      Array.isArray(input.connection_ids) && input.connection_ids.length > 0 && input.connection_ids.every(isInt)
        ? { value: { connection_ids: [...new Set(input.connection_ids)].slice(0, 500) } }
        : { error: "connection_ids must be a non-empty array of integers" },
    prepare: async (value, ctx) => {
      const [nodes, edges, violations] = await Promise.all([
        ctx.api.getNodes(),
        ctx.api.getConnections(),
        ctx.api.getViolations(),
      ]);
      const cam = cameraOf(nodes);
      const asked = edges.filter((e) => value.connection_ids.includes(e.connection_id));
      if (asked.length === 0) throw new ToolError(`There is no edge with connection_id ${value.connection_ids.join(", ")} in service.`);
      const linked = (e) => violations.filter((v) => v.connection_id === e.connection_id).length;
      const records = asked.reduce((sum, e) => sum + linked(e), 0);
      const n = asked.length;
      const pair = (e) => `${cam(e.from_node_id)} → ${cam(e.to_node_id)}`;
      return {
        target: { kind: "edge", connection_id: asked[0].connection_id },
        confirm: {
          summary: n === 1 ? `The section ${pair(asked[0])} will be removed.` : `${n} sections will be removed.`,
          details: [
            ...(n > 1 && n <= 12 ? [`Sections: ${asked.map(pair).join(", ")}.`] : []),
            records > 0
              ? `${records} violation${records === 1 ? "" : "s"} stay on record.`
              : "No violations are linked to them.",
          ],
        },
        plan: { connection_ids: asked.map((e) => e.connection_id) },
      };
    },
    run: async (plan, ctx) => {
      const deleted = [];
      const retired = [];
      const failed = [];
      for (const id of plan.connection_ids) {
        try {
          const result = await ctx.api.deleteConnection(id);
          (result.outcome === "retired" ? retired : deleted).push(id);
        } catch (err) {
          failed.push({ connection_id: id, error: err.message });
        }
      }
      return {
        deleted_connection_ids: deleted,
        retired_connection_ids: retired,
        ...(retired.length ? { note: "Retired sections had violations; they stay on record and can be brought back with bring_back." } : {}),
        ...(failed.length ? { failed } : {}),
      };
    },
  },

  {
    name: "delete_checkpoints",
    description:
      "Remove one or more checkpoints and every edge touching them, in ONE call with all their node_ids (for 'clear all', every node_id): the operator approves them together on one card. Anything that never had a violation is deleted; anything with violations is retired instead (out of the network, no longer enforcing, violations kept on record), automatically. Never refuse a removal because of violations. Camera numbers are never reused.",
    input_schema: strict({ node_ids: { type: "array", items: { type: "integer" } } }),
    validate: (input) =>
      Array.isArray(input.node_ids) && input.node_ids.length > 0 && input.node_ids.every(isInt)
        ? { value: { node_ids: [...new Set(input.node_ids)].slice(0, 500) } }
        : { error: "node_ids must be a non-empty array of integers" },
    prepare: async (value, ctx) => {
      const [nodes, edges, violations] = await Promise.all([
        ctx.api.getNodes(),
        ctx.api.getConnections(),
        ctx.api.getViolations(),
      ]);
      const asked = nodes.filter((n) => value.node_ids.includes(n.node_id));
      if (asked.length === 0) throw new ToolError(`There is no checkpoint with node_id ${value.node_ids.join(", ")} in service.`);
      const ids = new Set(asked.map((n) => n.node_id));
      const goingEdges = edges.filter((e) => ids.has(e.from_node_id) || ids.has(e.to_node_id));
      const goingIds = new Set(goingEdges.map((e) => e.connection_id));
      const records = violations.filter((v) => goingIds.has(v.connection_id)).length;
      const n = asked.length;
      const e = goingEdges.length;
      const everything = n === nodes.length;
      const cameras = n === 1 ? `Camera ${asked[0].id_in_project}` : `${n} cameras`;
      const sections = e ? ` and ${e} section${e === 1 ? "" : "s"}` : "";
      return {
        target: { kind: "node", node_id: asked[0].node_id },
        confirm: {
          summary: `${cameras}${sections} will be removed.`,
          details: [
            ...(everything ? ["That is the whole network."] : n > 1 && n <= 15 ? [`Cameras: ${asked.map((c) => c.id_in_project).join(", ")}.`] : []),
            records > 0 ? `${records} violation${records === 1 ? "" : "s"} stay on record.` : "No violations are linked to them.",
          ],
        },
        plan: { node_ids: asked.map((c) => c.node_id) },
      };
    },
    run: async (plan, ctx) => {
      const deleted = [];
      const retired = [];
      let edgesDeleted = 0;
      let edgesRetired = 0;
      const failed = [];
      for (const id of plan.node_ids) {
        try {
          const result = await ctx.api.deleteNode(id);
          (result.outcome === "retired" ? retired : deleted).push(result.id_in_project);
          edgesDeleted += (result.connections_deleted || []).length;
          edgesRetired += (result.connections_retired || []).length;
        } catch (err) {
          failed.push({ node_id: id, error: err.message });
        }
      }
      return {
        deleted_cameras: deleted,
        retired_cameras: retired,
        sections_deleted: edgesDeleted,
        sections_retired: edgesRetired,
        ...(retired.length || edgesRetired ? { note: "Retired items had violations; they stay on record and can be brought back with bring_back." } : {}),
        ...(failed.length ? { failed } : {}),
      };
    },
  },

  {
    name: "list_retired",
    loose: true,
    description:
      "List retired checkpoints and edges: removed from the network because violations are linked to them, kept on record, and able to be brought back.",
    input_schema: strict({}),
    validate: () => ({ value: {} }),
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const retired = await ctx.api.getRetired();
      const camera = new Map(retired.nodes.map((n) => [n.node_id, n.id_in_project]));
      const live = new Map((await ctx.api.getNodes()).map((n) => [n.node_id, n.id_in_project]));
      const cam = (id) => camera.get(id) ?? live.get(id) ?? "?";
      return {
        retired_cameras: retired.nodes.map((n) => ({ node_id: n.node_id, camera: n.id_in_project, retired_at: n.retired_at })),
        retired_sections: retired.connections.map((e) => ({
          connection_id: e.connection_id,
          from_camera: cam(e.from_node_id),
          to_camera: cam(e.to_node_id),
          speed_limit_kmh: e.speed_limit,
          violations: e.violations,
          retired_at: e.retired_at,
        })),
      };
    },
  },

  {
    name: "bring_back",
    description:
      "Put retired checkpoints and edges back in service, in ONE call: cameras first, then the sections between them, with the limits and distances they had. The operator confirms on one card. A section can only come back if both its cameras are in service. Get the ids from list_retired.",
    input_schema: strict({
      node_ids: { type: "array", items: { type: "integer" } },
      connection_ids: { type: "array", items: { type: "integer" } },
    }),
    validate: (input) => {
      const ints = (list) => Array.isArray(list) && list.every(isInt);
      if (!ints(input.node_ids) || !ints(input.connection_ids)) return { error: "ids must be arrays of integers" };
      if (input.node_ids.length + input.connection_ids.length === 0) return { error: "give at least one id" };
      return { value: { node_ids: [...new Set(input.node_ids)], connection_ids: [...new Set(input.connection_ids)] } };
    },
    prepare: async (value, ctx) => {
      const retired = await ctx.api.getRetired();
      const nodes = retired.nodes
        .filter((n) => value.node_ids.includes(n.node_id))
        .sort((x, y) => x.id_in_project - y.id_in_project);
      const edges = retired.connections.filter((e) => value.connection_ids.includes(e.connection_id));
      if (nodes.length + edges.length === 0) throw new ToolError("None of those are retired. Use list_retired for the ids.");
      const parts = [];
      if (nodes.length) parts.push(`${nodes.length} camera${nodes.length === 1 ? "" : "s"}`);
      if (edges.length) parts.push(`${edges.length} section${edges.length === 1 ? "" : "s"}`);
      return {
        target: nodes.length ? { kind: "point", latitude: nodes[0].latitude, longitude: nodes[0].longitude } : { kind: "ui", element: "frame" },
        confirm: {
          summary: `${parts.join(" and ")} will be back in service.`,
          details: [
            ...(nodes.length ? [`Cameras ${nodes.map((n) => n.id_in_project).join(", ")}, with their old numbers.`] : []),
            ...(edges.length ? ["Sections come back with the limits and distances they had, and enforce again."] : []),
          ],
        },
        plan: { node_ids: nodes.map((n) => n.node_id), connection_ids: edges.map((e) => e.connection_id) },
      };
    },
    run: async (plan, ctx) => {
      const back = { cameras: [], sections: [], failed: [] };
      for (const id of plan.node_ids) {
        try {
          back.cameras.push((await ctx.api.unretireNode(id)).id_in_project);
        } catch (err) {
          back.failed.push({ node_id: id, error: err.message });
        }
      }
      for (const id of plan.connection_ids) {
        try {
          await ctx.api.unretireConnection(id);
          back.sections.push(id);
        } catch (err) {
          back.failed.push({ connection_id: id, error: err.message });
        }
      }
      return back;
    },
  },

  {
    name: "set_speed_limit",
    description:
      "Change the speed limit on one existing edge. If violations were already recorded on that edge, the operator is asked to confirm first.",
    input_schema: strict({
      connection_id: { type: "integer" },
      speed_limit_kmh: { type: "number", description: `${MIN_LIMIT_KMH} to ${MAX_LIMIT_KMH}.` },
    }),
    validate: (input) => {
      if (!isInt(input.connection_id)) return { error: "connection_id must be an integer" };
      if (!isNum(input.speed_limit_kmh) || input.speed_limit_kmh < MIN_LIMIT_KMH || input.speed_limit_kmh > MAX_LIMIT_KMH) {
        return { error: `speed_limit_kmh must be between ${MIN_LIMIT_KMH} and ${MAX_LIMIT_KMH}` };
      }
      return { value: { ...input } };
    },
    prepare: async (value, ctx) => {
      const [edges, violations] = await Promise.all([ctx.api.getConnections(), ctx.api.getViolations()]);
      const edge = edges.find((candidate) => candidate.connection_id === value.connection_id);
      if (!edge) throw new ToolError(`There is no edge with connection_id ${value.connection_id} in this project.`);
      if (edge.speed_limit === value.speed_limit_kmh) {
        throw new ToolError(`That edge is already ${edge.speed_limit} km/h. Nothing to change.`);
      }
      const recorded = violations.filter((v) => v.connection_id === value.connection_id).length;
      return {
        target: { kind: "edge", connection_id: value.connection_id },
        confirm:
          recorded > 0
            ? {
                summary: `Change the limit from ${edge.speed_limit} to ${value.speed_limit_kmh} km/h on an edge with ${recorded} recorded violation${recorded === 1 ? "" : "s"}?`,
                details: [
                  "Recorded violations are not changed.",
                  "Only cars measured after the change are judged against the new limit.",
                ],
              }
            : null,
        plan: { ...value, previous: edge.speed_limit },
      };
    },
    run: async (plan, ctx) => {
      await ctx.api.setSpeedLimit(plan.connection_id, plan.speed_limit_kmh);
      return {
        connection_id: plan.connection_id,
        previous_speed_limit_kmh: plan.previous,
        speed_limit_kmh: plan.speed_limit_kmh,
      };
    },
  },

  {
    name: "move_checkpoint_by",
    description:
      "Move an existing checkpoint by a number of metres east and north (negative for west or south), for example after a camera was relocated. Its edges stop enforcing until the distance driver re-measures them. The operator is always asked to confirm.",
    input_schema: strict({
      node_id: { type: "integer" },
      east_m: { type: "number", description: "Metres east; negative is west." },
      north_m: { type: "number", description: "Metres north; negative is south." },
    }),
    validate: (input) => {
      if (!isInt(input.node_id)) return { error: "node_id must be an integer" };
      if (!isNum(input.east_m) || !isNum(input.north_m)) return { error: "east_m and north_m must be numbers" };
      if (Math.hypot(input.east_m, input.north_m) > MAX_MOVE_M) return { error: `a move can be at most ${MAX_MOVE_M} m` };
      if (input.east_m === 0 && input.north_m === 0) return { error: "the move is zero metres" };
      return { value: { ...input } };
    },
    prepare: async (value, ctx) => {
      const node = await findNode(ctx.api, value.node_id);
      const projection = makeProjection(node.latitude, node.longitude);
      // The projection's y axis points south (screen convention).
      const to = projection.unproject(value.east_m, -value.north_m);
      return prepareMove(ctx, node, { latitude: round6(to.lat), longitude: round6(to.lng) });
    },
    run: (plan, ctx) => runMove(plan, ctx),
  },

  {
    name: "move_checkpoint_to",
    description:
      "Move an existing checkpoint to an exact position. Its edges stop enforcing until the distance driver re-measures them. The operator is always asked to confirm.",
    input_schema: strict({
      node_id: { type: "integer" },
      latitude: { type: "number" },
      longitude: { type: "number" },
    }),
    validate: (input) => {
      if (!isInt(input.node_id)) return { error: "node_id must be an integer" };
      if (!isLatLng(input.latitude, input.longitude)) return { error: "latitude/longitude out of range" };
      return { value: { node_id: input.node_id, latitude: round6(input.latitude), longitude: round6(input.longitude) } };
    },
    prepare: async (value, ctx) => {
      const node = await findNode(ctx.api, value.node_id);
      const metres = haversineMeters({ lat: node.latitude, lng: node.longitude }, { lat: value.latitude, lng: value.longitude });
      if (metres > MAX_MOVE_M) throw new ToolError(`That is ${Math.round(metres)} m away; a move can be at most ${MAX_MOVE_M} m.`);
      return prepareMove(ctx, node, { latitude: value.latitude, longitude: value.longitude });
    },
    run: (plan, ctx) => runMove(plan, ctx),
  },

  {
    name: "await_remeasure",
    description:
      "Wait until the distance driver has re-measured the given edges (after a move), up to timeout_s seconds, and return their new distances.",
    input_schema: strict({
      connection_ids: { type: "array", items: { type: "integer" } },
      timeout_s: { type: "integer", description: "1 to 30." },
    }),
    validate: (input) => {
      if (!Array.isArray(input.connection_ids) || input.connection_ids.length === 0 || !input.connection_ids.every(isInt)) {
        return { error: "connection_ids must be a non-empty array of integers" };
      }
      if (!isInt(input.timeout_s) || input.timeout_s < 1 || input.timeout_s > 30) return { error: "timeout_s must be 1 to 30" };
      return { value: { connection_ids: [...new Set(input.connection_ids)].slice(0, 50), timeout_s: input.timeout_s } };
    },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const deadline = Date.now() + plan.timeout_s * 1000;
      let edges;
      let driverConnected;
      for (;;) {
        ({ edges, driverConnected } = await readNetwork(ctx.api));
        const watched = edges.filter((edge) => plan.connection_ids.includes(edge.connection_id));
        const pending = watched.filter((edge) => edge.distance_status === "unknown");
        if (pending.length === 0 || !driverConnected || Date.now() >= deadline || ctx.signal.aborted) {
          return {
            done: pending.length === 0,
            distance_driver_connected: driverConnected,
            edges: watched.map((edge) => describeEdge(edge, driverConnected)),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    },
  },

  {
    name: "get_violation_summary",
    description:
      "Count recorded violations per edge over the last N days, most first, with the fastest and average measured speeds. Returns totals only, never plates.",
    input_schema: strict({ days: { type: "integer", description: "1 to 90. 'This week' is 7." } }),
    validate: (input) =>
      isInt(input.days) && input.days >= 1 && input.days <= 90
        ? { value: { days: input.days } }
        : { error: "days must be an integer from 1 to 90" },
    prepare: async (value) => ({ target: { kind: "ui", element: "violations" }, plan: value }),
    run: async (plan, ctx) => {
      const [violations, edges, nodes] = await Promise.all([
        ctx.api.getViolations(),
        ctx.api.getConnections(),
        ctx.api.getNodes(),
      ]);
      const to = new Date();
      const from = new Date(to.getTime() - plan.days * 86400000);
      const inWindow = violations.filter((v) => {
        const at = new Date(v.timestamp).getTime();
        return at >= from.getTime() && at <= to.getTime();
      });

      const byEdge = new Map();
      let unattributed = 0;
      for (const v of inWindow) {
        if (v.connection_id === null || v.connection_id === undefined) {
          unattributed += 1;
          continue;
        }
        const entry = byEdge.get(v.connection_id) || { count: 0, max: 0, sum: 0 };
        entry.count += 1;
        entry.max = Math.max(entry.max, v.car_speed);
        entry.sum += v.car_speed;
        byEdge.set(v.connection_id, entry);
      }

      const camera = new Map(nodes.map((node) => [node.node_id, node]));
      const ranked = [...byEdge.entries()]
        .map(([connectionId, entry]) => {
          const edge = edges.find((candidate) => candidate.connection_id === connectionId);
          const fromNode = edge && camera.get(edge.from_node_id);
          const toNode = edge && camera.get(edge.to_node_id);
          const near = fromNode && places.nearestLandmark(fromNode.latitude, fromNode.longitude, 600);
          const street = fromNode && places.streetAt(fromNode.latitude, fromNode.longitude);
          return {
            connection_id: connectionId,
            from_camera: fromNode ? fromNode.id_in_project : null,
            to_camera: toNode ? toNode.id_in_project : null,
            ...(street ? { street } : {}),
            ...(near ? { near: near.name } : {}),
            speed_limit_kmh: edge ? edge.speed_limit : null,
            violations: entry.count,
            max_speed_kmh: Math.round(entry.max),
            mean_speed_kmh: Math.round(entry.sum / entry.count),
          };
        })
        .sort((a, b) => b.violations - a.violations);

      return {
        window: { from: from.toISOString(), to: to.toISOString(), days: plan.days },
        total_violations: inWindow.length,
        unattributed_to_an_edge: unattributed,
        edges: ranked.slice(0, 10),
      };
    },
  },

  {
    name: "get_diagnostics",
    description:
      "Run the data-quality check: checkpoints that look misplaced and edges whose road distance looks wrong, each with the reason.",
    input_schema: strict({}),
    validate: () => ({ value: {} }),
    prepare: async (value) => ({ target: { kind: "ui", element: "quality" }, plan: value }),
    run: async (plan, ctx) => {
      const report = await ctx.api.getDiagnostics();
      const nodes = (report.nodes || []).filter((n) => n.flags && n.flags.length > 0);
      const edges = (report.connections || report.edges || []).filter((e) => e.flags && e.flags.length > 0);
      return {
        flagged_checkpoints: nodes.map((n) => ({ node_id: n.node_id, flags: n.flags.map((f) => f.type || f) })),
        flagged_edges: edges.map((e) => ({ connection_id: e.connection_id, flags: e.flags.map((f) => f.type || f) })),
      };
    },
  },

  {
    name: "get_violations",
    description:
      "List individual recorded violations, newest first: time, edge, measured speed against the limit. Read-only. Plates are personal data: set include_plates only when the operator explicitly asks for plates.",
    input_schema: strict({
      days: { type: "integer", description: "1 to 90." },
      connection_id: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Only this edge, or null for all." },
      limit: { type: "integer", description: "1 to 50." },
      include_plates: { type: "boolean" },
    }),
    validate: (input) => {
      if (!isInt(input.days) || input.days < 1 || input.days > 90) return { error: "days must be 1 to 90" };
      if (input.connection_id !== null && !isInt(input.connection_id)) return { error: "connection_id must be an integer or null" };
      if (!isInt(input.limit) || input.limit < 1 || input.limit > 50) return { error: "limit must be 1 to 50" };
      return { value: { ...input, include_plates: input.include_plates === true } };
    },
    prepare: async (value) => ({ target: { kind: "ui", element: "violations" }, plan: value }),
    run: async (plan, ctx) => {
      const [violations, edges, nodes] = await Promise.all([ctx.api.getViolations(), ctx.api.getConnections(), ctx.api.getNodes()]);
      const since = Date.now() - plan.days * 86400000;
      const cam = cameraOf(nodes);
      const rows = violations
        .filter((v) => new Date(v.timestamp).getTime() >= since)
        .filter((v) => plan.connection_id === null || v.connection_id === plan.connection_id)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return {
        total_in_window: rows.length,
        shown: Math.min(rows.length, plan.limit),
        violations: rows.slice(0, plan.limit).map((v) => {
          const edge = edges.find((e) => e.connection_id === v.connection_id);
          return {
            at: v.timestamp,
            connection_id: v.connection_id,
            ...(edge ? { from_camera: cam(edge.from_node_id), to_camera: cam(edge.to_node_id), speed_limit_kmh: edge.speed_limit } : {}),
            speed_kmh: Math.round(v.car_speed),
            ...(plan.include_plates ? { plate: v.car_plate } : {}),
          };
        }),
      };
    },
  },

  {
    name: "get_congestion",
    loose: true,
    description:
      "Live congestion per edge over the last few minutes: the average time cars took divided by the time the limit allows. 1 is free-flowing, 2 means twice as slow. Edges with no recent traffic are not listed.",
    input_schema: strict({}),
    validate: () => ({ value: {} }),
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const [congestion, edges, nodes] = await Promise.all([ctx.api.getCongestion(), ctx.api.getConnections(), ctx.api.getNodes()]);
      const cam = cameraOf(nodes);
      const list = Object.entries(congestion.ratios || {})
        .map(([id, ratio]) => {
          const edge = edges.find((e) => e.connection_id === Number(id));
          return {
            connection_id: Number(id),
            ...(edge ? { from_camera: cam(edge.from_node_id), to_camera: cam(edge.to_node_id) } : {}),
            ratio: Math.round(ratio * 100) / 100,
            reading: ratio >= 2 ? "congested" : ratio >= 1.3 ? "slow" : "free-flowing",
          };
        })
        .sort((a, b) => b.ratio - a.ratio);
      return {
        window_minutes: congestion.window_minutes,
        edges: list,
        ...(list.length === 0 ? { note: "No car has crossed a measured edge recently, so there is no live reading." } : {}),
      };
    },
  },

  {
    name: "get_stats",
    loose: true,
    description:
      "A one-call overview of the project: how many cameras and edges, how many edges are measured and enforcing, violations in the last 24 hours, 7 days and in all, and the busiest edge this week.",
    input_schema: strict({}),
    validate: () => ({ value: {} }),
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const [{ nodes, edges, driverConnected }, violations] = await Promise.all([readNetwork(ctx.api), ctx.api.getViolations()]);
      const now = Date.now();
      const within = (ms) => violations.filter((v) => new Date(v.timestamp).getTime() >= now - ms);
      const week = within(7 * 86400000);
      const perEdge = new Map();
      for (const v of week) perEdge.set(v.connection_id, (perEdge.get(v.connection_id) || 0) + 1);
      const [busiestId, busiestCount] = [...perEdge.entries()].sort((a, b) => b[1] - a[1])[0] || [];
      const busiest = edges.find((e) => e.connection_id === busiestId);
      const cam = cameraOf(nodes);
      const byStreet = {};
      for (const node of nodes) {
        const street = places.streetAt(node.latitude, node.longitude) || "elsewhere";
        byStreet[street] = (byStreet[street] || 0) + 1;
      }
      return {
        cameras: nodes.length,
        cameras_by_street: byStreet,
        edges: edges.length,
        edges_measured: edges.filter((e) => e.distance_status === "ok").length,
        edges_no_route: edges.filter((e) => e.distance_status === "no-route").length,
        distance_driver_connected: driverConnected,
        violations_last_24h: within(86400000).length,
        violations_last_7_days: week.length,
        violations_all_time: violations.length,
        ...(busiest
          ? { busiest_edge_this_week: { connection_id: busiest.connection_id, from_camera: cam(busiest.from_node_id), to_camera: cam(busiest.to_node_id), violations: busiestCount } }
          : {}),
      };
    },
  },

  {
    name: "geocode",
    loose: true,
    description:
      "Find a place in Egypt that is not in the demo place list, with OpenStreetMap (Nominatim). Returns matches with the nearest point on a drivable road. Use the nearest_road point, not the raw point, if a checkpoint goes there, and tell the operator the position came from OpenStreetMap so they can check it. Slow (about a second per lookup); results are cached.",
    input_schema: strict({ query: { type: "string", description: "An address, street or landmark, with the city." } }),
    validate: (input) =>
      typeof input.query === "string" && input.query.trim()
        ? { value: { query: input.query.trim().slice(0, 200) } }
        : { error: "query must be a non-empty string" },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan) => {
      const matches = await osmCall(() => osm.geocode(plan.query));
      return {
        source: "OpenStreetMap Nominatim",
        matches,
        ...(matches.length === 0 ? { note: "OpenStreetMap found nothing in Egypt by that name. Ask the operator for a nearby landmark or coordinates." } : {}),
      };
    },
  },

  {
    name: "road_info",
    loose: true,
    description:
      "What OpenStreetMap records about the road at a point: its name, class, whether it is one-way, divided or two-way, which way traffic runs, lanes and the posted speed limit. Use it before placing or connecting cameras outside the demo place list. A missing value means OSM does not have it: say so, never guess.",
    input_schema: strict({ latitude: { type: "number" }, longitude: { type: "number" } }),
    validate: (input) =>
      isLatLng(input.latitude, input.longitude)
        ? { value: { latitude: round6(input.latitude), longitude: round6(input.longitude) } }
        : { error: "latitude/longitude out of range" },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan) => osmCall(() => osm.roadAt(plan.latitude, plan.longitude)),
  },

  {
    name: "nearby_places",
    loose: true,
    description:
      "Schools, hospitals, traffic signals, pedestrian crossings, speed bumps, fuel stations and bus stops near a point, from OpenStreetMap, for judging where cameras and lower limits make sense. OSM has no accident or traffic data: never present these as accident statistics.",
    input_schema: strict({
      latitude: { type: "number" },
      longitude: { type: "number" },
      radius_m: { type: "integer", description: "50 to 1000." },
    }),
    validate: (input) => {
      if (!isLatLng(input.latitude, input.longitude)) return { error: "latitude/longitude out of range" };
      if (!isInt(input.radius_m) || input.radius_m < 50 || input.radius_m > 1000) return { error: "radius_m must be 50 to 1000" };
      return { value: { latitude: round6(input.latitude), longitude: round6(input.longitude), radius_m: input.radius_m } };
    },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan) => osmCall(() => osm.nearby(plan.latitude, plan.longitude, plan.radius_m)),
  },

  {
    name: "frame_map",
    loose: true,
    description:
      "Move the operator's map to show these checkpoints and edges, or the whole network if both lists are empty. Display only.",
    input_schema: strict({
      node_ids: { type: "array", items: { type: "integer" } },
      connection_ids: { type: "array", items: { type: "integer" } },
    }),
    validate: (input) => {
      const ints = (list) => Array.isArray(list) && list.every(isInt);
      if (!ints(input.node_ids) || !ints(input.connection_ids)) return { error: "ids must be arrays of integers" };
      return { value: { node_ids: input.node_ids.slice(0, 100), connection_ids: input.connection_ids.slice(0, 100) } };
    },
    prepare: async (value) => ({ target: { kind: "ui", element: "frame" }, plan: value }),
    run: async (plan, ctx) => {
      ctx.emit("ui.control", { action: "frame", node_ids: plan.node_ids, connection_ids: plan.connection_ids });
      return { framed: plan.node_ids.length + plan.connection_ids.length || "the whole network" };
    },
  },

  {
    name: "switch_view",
    description:
      "Switch the operator's console between the graph view and the map view. The map view exists only when the project's map driver is approved and running. Display only.",
    input_schema: strict({ view: { type: "string", enum: ["graph", "map"] } }),
    validate: (input) => (input.view === "graph" || input.view === "map" ? { value: { view: input.view } } : { error: "view must be graph or map" }),
    prepare: async (value, ctx) => {
      if (value.view === "map") {
        const map = await ctx.api.getMapDriver();
        if (!(map && map.connected && map.status === "approved")) {
          throw new ToolError(
            "The map view is not available: this project has no approved, running map driver. Only an operator can approve one, under Project.",
          );
        }
      }
      return { target: { kind: "ui", element: value.view === "map" ? "view-map" : "view-graph" }, plan: value };
    },
    run: async (plan, ctx) => {
      ctx.emit("ui.control", { action: "view", view: plan.view });
      return { view: plan.view };
    },
  },

  {
    name: "open_panel",
    description:
      "Open the Quality panel (data-quality flags) or the Violations panel on the operator's screen, or close whichever is open. Display only.",
    input_schema: strict({ panel: { type: "string", enum: ["quality", "violations", "none"] } }),
    validate: (input) =>
      ["quality", "violations", "none"].includes(input.panel) ? { value: { panel: input.panel } } : { error: "panel must be quality, violations or none" },
    prepare: async (value) => ({
      target: value.panel === "none" ? null : { kind: "ui", element: value.panel },
      plan: value,
    }),
    run: async (plan, ctx) => {
      ctx.emit("ui.control", { action: "panel", panel: plan.panel });
      return { panel: plan.panel };
    },
  },

  {
    name: "list_restore_points",
    loose: true,
    description:
      "List the project's restore points, newest first: saved copies of the checkpoint network (positions, edges, speed limits; never violations). One is saved automatically before every request that changes the network, named after that request.",
    input_schema: strict({}),
    validate: () => ({ value: {} }),
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const points = await ctx.restorePoints.list();
      return {
        restore_points: points.slice(0, 20).map((p) => ({
          restore_point_id: p.restore_point_id,
          name: p.name,
          saved_at: p.created_at,
          automatic: p.origin === "auto",
          cameras: p.cameras,
          edges: p.edges,
        })),
      };
    },
  },

  {
    name: "save_restore_point",
    loose: true,
    description: "Save the checkpoint network as it is now under a name, so it can be put back later. Changes nothing.",
    input_schema: strict({ name: { type: "string", description: "A short name the operator will recognise." } }),
    validate: (input) =>
      typeof input.name === "string" && input.name.trim()
        ? { value: { name: input.name.trim().slice(0, 120) } }
        : { error: "name must be a non-empty string" },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const snapshot = await takeSnapshot(ctx.api);
      const id = await ctx.restorePoints.save(plan.name, snapshot);
      return { restore_point_id: id, name: plan.name, cameras: snapshot.nodes.length, edges: snapshot.edges.length };
    },
  },

  {
    name: "restore_to",
    description:
      "Put the checkpoint network back the way a restore point saved it: moves cameras back, removes cameras and edges added since, re-creates deleted ones and puts speed limits back. The operator always confirms. Edges with violations linked are kept, and cameras that come back get new numbers. Violations are never touched. To undo the last request, use the newest automatic restore point.",
    input_schema: strict({ restore_point_id: { type: "integer" } }),
    validate: (input) =>
      isInt(input.restore_point_id) ? { value: { restore_point_id: input.restore_point_id } } : { error: "restore_point_id must be an integer" },
    prepare: async (value, ctx) => {
      const point = await ctx.restorePoints.get(value.restore_point_id);
      if (!point) throw new ToolError(`There is no restore point ${value.restore_point_id} in this project.`);
      const plan = await planRestore(ctx.api, point.snapshot);
      if (isEmpty(plan)) throw new ToolError(`The network already matches “${point.name}”. Nothing to restore.`);
      return {
        target: { kind: "ui", element: "frame" },
        confirm: { summary: `Restore “${point.name}”?`, details: describePlan(plan) },
        plan: { point, plan },
      };
    },
    run: async ({ point, plan }, ctx) => {
      const done = await applyRestore(ctx.api, plan);
      return { restored: point.name, ...done };
    },
  },

  {
    name: "generate_report",
    loose: true,
    description:
      "Write a PDF report of the project: summary figures, violations per edge over the last N days, the network with limits and distances, and data-quality flags. The operator gets a download button. Plates are personal data: set include_plates only when the operator explicitly asks for plates in the report.",
    input_schema: strict({
      title: { type: "string", description: "A short title, for example 'Weekly enforcement report'." },
      days: { type: "integer", description: "1 to 90. A week is 7." },
      include_plates: { type: "boolean" },
      notes: { type: "string", description: "An optional short paragraph for the top of the report, or an empty string." },
    }),
    validate: (input) => {
      if (typeof input.title !== "string" || !input.title.trim()) return { error: "title must be a non-empty string" };
      if (!isInt(input.days) || input.days < 1 || input.days > 90) return { error: "days must be 1 to 90" };
      return {
        value: {
          title: input.title.trim().slice(0, 80),
          days: input.days,
          include_plates: input.include_plates === true,
          notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 1000) : "",
        },
      };
    },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      const report = await buildReport(ctx.api, ctx.projectId, {
        title: plan.title,
        days: plan.days,
        includePlates: plan.include_plates,
        notes: plan.notes,
      });
      ctx.emit("report", { report_id: report.id, title: report.title, filename: report.filename, pages: report.pages });
      return { report: report.title, pages: report.pages, plates_included: plan.include_plates, note: "The operator has a download button under your reply." };
    },
  },

  {
    name: "highlight",
    loose: true,
    description:
      "Highlight checkpoints and edges on the operator's map, for example the results of a question. Display only: it changes nothing in the system. An empty list clears highlights.",
    input_schema: strict({
      connection_ids: { type: "array", items: { type: "integer" } },
      node_ids: { type: "array", items: { type: "integer" } },
      caption: { type: "string", description: "A few words shown with the highlight." },
    }),
    validate: (input) => {
      const ints = (list) => Array.isArray(list) && list.every(isInt);
      if (!ints(input.connection_ids) || !ints(input.node_ids)) return { error: "ids must be arrays of integers" };
      return {
        value: {
          connection_ids: input.connection_ids.slice(0, 50),
          node_ids: input.node_ids.slice(0, 50),
          caption: typeof input.caption === "string" ? input.caption.slice(0, 120) : "",
        },
      };
    },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan, ctx) => {
      ctx.emit("highlight", plan);
      return { highlighted: plan.connection_ids.length + plan.node_ids.length };
    },
  },
];

/* -------------------------------------------------------------------------
   Moves share one path
   ------------------------------------------------------------------------- */

async function prepareMove(ctx, node, to) {
  const edges = await ctx.api.getConnections();
  const touching = edges.filter((edge) => edge.from_node_id === node.node_id || edge.to_node_id === node.node_id);
  const metres = Math.round(
    haversineMeters({ lat: node.latitude, lng: node.longitude }, { lat: to.latitude, lng: to.longitude }),
  );
  const offset = makeProjection(node.latitude, node.longitude).project(to.latitude, to.longitude);
  const bearing = (Math.atan2(offset.x, -offset.y) * 180) / Math.PI;
  const compass = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][
    Math.round(((bearing + 360) % 360) / 45) % 8
  ];
  return {
    // `from` lets the console put the checkpoint back when it replays a run.
    target: { kind: "node-move", node_id: node.node_id, from: { latitude: node.latitude, longitude: node.longitude }, to },
    confirm: {
      summary: `Move camera ${node.id_in_project} by ${metres} m ${compass}?`,
      details: [
        `${touching.length} edge${touching.length === 1 ? "" : "s"} stop enforcing until the distance driver re-measures ${touching.length === 1 ? "it" : "them"}.`,
        "Recorded violations are not changed.",
      ],
    },
    plan: { node_id: node.node_id, from: { latitude: node.latitude, longitude: node.longitude }, to, metres },
  };
}

async function runMove(plan, ctx) {
  const moved = await ctx.api.moveNode(plan.node_id, plan.to.latitude, plan.to.longitude);
  const edges = await ctx.api.getConnections();
  const touching = edges.filter((edge) => edge.from_node_id === plan.node_id || edge.to_node_id === plan.node_id);
  return {
    node_id: plan.node_id,
    camera: moved.id_in_project,
    moved_m: plan.metres,
    latitude: moved.latitude,
    longitude: moved.longitude,
    edges_being_remeasured: touching.map((edge) => edge.connection_id),
  };
}

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** The definitions sent to the model: name, description, strict schema. */
const definitions = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.input_schema,
  // The API allows 20 strict tools. Every tool that changes something is
  // strict; a few read-only lookups are not, and validate() checks their
  // inputs here either way.
  strict: !tool.loose,
}));

module.exports = { TOOLS, BY_NAME, definitions, ToolError };
