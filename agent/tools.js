"use strict";

/**
 * Sayes's tools.
 *
 * Each one maps onto ALLOWED endpoints of the REST API and nothing else.
 * What the agent must never do - create, edit or delete violations or
 * evidence, touch API keys, auth, projects or the map driver - has no tool
 * here at all, so no prompt can talk it into doing so. There is no delete
 * either, and no tool accepts a road distance: distances are measured by the
 * distance driver, never stated by the agent.
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

/* -------------------------------------------------------------------------
   The tools
   ------------------------------------------------------------------------- */

const TOOLS = [
  {
    name: "get_network",
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
      "Get evenly spaced points along a known street, both ends included, in the legal direction of travel, for placing checkpoints on it. Also says whether the street is one-way, divided or two-way, and which way to connect the checkpoints.",
    input_schema: strict({
      street: { type: "string", description: "Street name from the place list." },
      count: { type: "integer", description: "How many points, 1 to 10." },
    }),
    validate: (input) => {
      if (typeof input.street !== "string" || !input.street.trim()) return { error: "street must be a non-empty string" };
      if (!isInt(input.count) || input.count < 1 || input.count > 10) return { error: "count must be an integer from 1 to 10" };
      return { value: { street: input.street.trim(), count: input.count } };
    },
    prepare: async (value) => ({ target: null, plan: value }),
    run: async (plan) => {
      const street = places.findStreet(plan.street);
      if (!street) {
        throw new ToolError(
          `"${plan.street}" is not in the place list. Known streets: ${places.places.streets.map((s) => s.name).join("; ")}.`,
        );
      }
      const points = places.pointsAlongStreet(street, plan.count);
      const spacing = plan.count > 1 ? Math.round(street.length_m / (plan.count - 1)) : null;
      return {
        street: street.name,
        layout: street.layout,
        direction: street.direction,
        traffic: street.traffic,
        connect: places.connectRule(street),
        length_m: street.length_m,
        spacing_m: spacing,
        points,
      };
    },
  },

  {
    name: "create_checkpoint",
    description:
      "Place one new checkpoint (camera) at a position. Use coordinates from find_place or points_along_street. To place several, call this several times in the same turn: the calls run in parallel.",
    input_schema: strict({
      latitude: { type: "number", description: "WGS84 degrees." },
      longitude: { type: "number", description: "WGS84 degrees." },
    }),
    validate: (input) =>
      isLatLng(input.latitude, input.longitude)
        ? { value: { latitude: round6(input.latitude), longitude: round6(input.longitude) } }
        : { error: "latitude must be within +/-90 and longitude within +/-180" },
    prepare: async (value) => ({
      target: { kind: "point", latitude: value.latitude, longitude: value.longitude },
      plan: value,
    }),
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
    name: "create_edge",
    description:
      "Connect two checkpoints with a one-way edge (from -> to) and a speed limit, in the legal direction of travel. The road distance is measured by the distance driver; it cannot be set here. Only on a two-way undivided road, or when the operator asks for both directions, add the reverse edge too. Create all the edges in the same turn. Measuring can take several seconds.",
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
      const { edges, driverConnected } = await readNetwork(ctx.api);
      const existing = edges.find(
        (edge) => edge.from_node_id === value.from_node_id && edge.to_node_id === value.to_node_id,
      );
      if (existing) {
        throw new ToolError(
          `These checkpoints are already connected in this direction (connection_id ${existing.connection_id}, ${existing.speed_limit} km/h). Use set_speed_limit to change it.`,
        );
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
    name: "highlight",
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
  strict: true,
}));

module.exports = { TOOLS, BY_NAME, definitions, ToolError };
