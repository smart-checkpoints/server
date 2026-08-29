const express = require("express");
const {
  createDatabase,
  initializeDatabase,
  statements,
  DISTANCE_STATUS,
  PATH_FORMAT,
  MAP_DRIVER_STATUS,
} = require("./database.js");
const {
  ROLES,
  createAPIKey,
  authenticateAPIKey,
  resolveAPIKey,
  APIKeyToProjectId,
} = require("./api-key-manager.js");
const os = require("os");
require("dotenv").config({ quiet: true });
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const WebSocket = require("ws");
const crypto = require("crypto");
const { parseCoordinate, isValidLatLng } = require("./geo.js");
const { analyseProject } = require("./diagnostics.js");

// Every coordinate entering the system is WGS84 degrees. Rejecting here is the
// only thing standing between a typo and enforcement built on a wrong position.
const INVALID_COORDINATES =
  "latitude must be a finite number within +/-90 and longitude within +/-180";

// A speed limit of 0 divides by zero in calculateViolation and in the
// congestion loop; a negative one inverts the comparison so every car passes;
// a string writes text into a REAL column. These two numbers are the entire
// input to the violation calculation, so neither is taken on trust.
const INVALID_SPEED_LIMIT =
  "speed-limit must be a finite number greater than 0, in km/h";
// Zero is rejected rather than stored. An edge of zero metres enforces
// nothing - the maximum traversal time comes out at zero, so no car is ever
// slower than it - and that is exactly the silent failure the distance status
// exists to make visible. An unresolved edge says so; it does not pretend to
// be a very short road.
const INVALID_DISTANCE =
  "distance must be a finite number of metres, greater than 0";
const INVALID_ENDPOINTS =
  "from-node-id and to-node-id must both be nodes in this project";

// One documentation site for the whole ecosystem: the server, the console, the
// website and every distance driver all point here rather than each keeping a
// copy of the protocol that slowly stops being true.
const DOCS_URL = "https://docs.smartcheckpoints.xyz";

const port = process.env.PORT || 3000;

// Which interfaces to listen on.
//
// `server.listen(port)` with no host binds every interface, so the REST API,
// the Socket.IO channel and the driver WebSocket become reachable by anything
// on whatever network this machine happens to be attached to - with nothing
// done to ask for it and no indication that it happened. Cameras do have to
// reach the server, so loopback cannot be the answer forever; it is the
// default so that opening the server up is a decision somebody made.
const host = process.env.HOST || "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const boundToLoopback = LOOPBACK_HOSTS.has(host);
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Driver WebSocket ---
//
// Two kinds of process connect here. A distance driver answers "how far is it
// from A to B by road"; a map driver serves a map view. The server knows
// nothing about either beyond this protocol - no routing engine, no basemap,
// and no branch anywhere on which driver happens to be attached. Adding an
// eleventh distance driver must cost no change here, and the way that stays
// true is that nothing here is written for a particular one.
const wss = new WebSocket.Server({ noServer: true });

/**
 * The protocol version this server speaks.
 *
 * A driver that names no version is speaking v1 and keeps working exactly as
 * it did: it reads the node indices in a request, calls back over REST for the
 * coordinates, and answers with a bare distance. v2 reads the coordinates
 * inline, may return route geometry, and can say why it failed.
 */
const PROTOCOL_VERSION = 2;

/** One driver per role per project. There is no second slot for either. */
const DRIVER_ROLES = new Set(["distance", "map"]);
const DEFAULT_DRIVER_ROLE = "distance";

/** projectId -> { distance?: WebSocket, map?: WebSocket } */
const drivers = {};

/** requestId -> { resolve, reject, timeout, ws } */
const pendingDistanceRequests = {};

/** How long a driver has to answer before the request is abandoned. */
const DISTANCE_TIMEOUT_MS = 30000;

/**
 * A socket that connects and never authenticates would otherwise live forever,
 * costing a file descriptor and telling nobody anything.
 */
const AUTH_TIMEOUT_MS = 10000;

/**
 * Ping every interval; terminate after two go unanswered.
 *
 * A driver killed outright leaves a socket that TCP will not notice for a very
 * long time, and that socket holds its project's only slot for all of it. Two
 * missed pings frees it inside about ninety seconds.
 */
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_MISSED_PONGS = 2;

const CLOSE_REPLACED = 4001;
const CLOSE_AUTH_TIMEOUT = 4002;
const CLOSE_UNKNOWN_ROLE = 4003;

/** Geometry is presentation. No road is worth a quarter of a megabyte of it. */
const MAX_PATH_BYTES = 256 * 1024;

/** The codes a driver may give for not answering. Anything else is transient. */
const DRIVER_ERROR_CODES = new Set(["no-route", "unavailable", "invalid-input"]);

/**
 * A driver said, in so many words, that it could not answer.
 *
 * Distinct from every other rejection on this path, which are all forms of
 * silence: a timeout, a dropped socket, no driver at all. Silence says nothing
 * about the road. This says something.
 */
class DriverError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "DriverError";
    this.code = code;
  }
}

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/distance-driver") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    // Let Socket.IO handle its own upgrades
    // Do nothing here - Socket.IO hooks into the server internally
  }
});

/** The open socket in a project's role slot, or null. */
function driverFor(projectId, role) {
  const socket = drivers[projectId] && drivers[projectId][role];
  return socket && socket.readyState === WebSocket.OPEN ? socket : null;
}

/**
 * Puts a driver in its project's slot, evicting whatever was there.
 *
 * The old socket is closed rather than forgotten. A duplicate driver started
 * by mistake - a second copy of a service, a stale container - would otherwise
 * sit there connected, authenticated, and never asked for anything, which
 * looks exactly like working. Closing it makes the mistake arrive at the
 * machine that made it.
 */
function registerDriver(projectId, role, ws) {
  const slot = drivers[projectId] || (drivers[projectId] = {});
  const existing = slot[role];
  if (existing && existing !== ws) {
    console.warn(
      `🔗 Evicting the ${role} driver on project ${projectId}: another one authenticated`,
    );
    failPending(existing, new Error("Distance driver was replaced"));
    existing.close(CLOSE_REPLACED, "replaced by a newer driver");
  }
  slot[role] = ws;
}

/** Takes a driver out of its slot, if it is still the one in it. */
function unregisterDriver(ws) {
  const slot = drivers[ws.projectId];
  if (!slot || slot[ws.driverRole] !== ws) return false;
  delete slot[ws.driverRole];
  if (Object.keys(slot).length === 0) delete drivers[ws.projectId];
  return true;
}

/**
 * Fails every request this socket still owes an answer for.
 *
 * A dead socket is never going to answer, and leaving its requests on the
 * thirty-second timer means an edge stays unresolved for half a minute after
 * the reason it could not be resolved is already known.
 */
function failPending(ws, error) {
  for (const [requestId, pending] of Object.entries(pendingDistanceRequests)) {
    if (pending.ws !== ws) continue;
    clearTimeout(pending.timeout);
    delete pendingDistanceRequests[requestId];
    pending.reject(error);
  }
}

/**
 * Claims the pending request a reply is for, or null.
 *
 * The socket has to match: request ids are handed to one driver, and a reply
 * from a socket that was never asked is not an answer to anything.
 */
function takePending(requestId, ws) {
  const pending = pendingDistanceRequests[requestId];
  if (!pending || pending.ws !== ws) return null;
  clearTimeout(pending.timeout);
  delete pendingDistanceRequests[requestId];
  return pending;
}

/** Absent means v1. Newer than this server means this server's version. */
function parseProtocolVersion(value) {
  if (value === undefined || value === null) return 1;
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) return 1;
  return Math.min(version, PROTOCOL_VERSION);
}

/** Absent means `distance`: v1 knew only one kind of driver. Null means unknown. */
function parseDriverRole(value) {
  if (value === undefined || value === null) return DEFAULT_DRIVER_ROLE;
  return DRIVER_ROLES.has(value) ? value : null;
}

/**
 * Route geometry from a driver result, serialised and ready to store, or null.
 *
 * The server does not read route geometry. This checks the envelope and
 * nothing inside it: that it is a LineString, that it is in the one format
 * there is, and that it is small enough to keep. Anything that fails loses its
 * geometry and keeps its distance - the distance is what enforcement runs on,
 * and the shape of the road is what it looks like.
 */
function parsePath(path, pathFormat) {
  if (path === undefined || path === null) return null;

  if (typeof path !== "object" || path.type !== "LineString") {
    console.warn("🔗 Dropping driver geometry: not a GeoJSON LineString");
    return null;
  }
  if (
    pathFormat !== undefined &&
    pathFormat !== null &&
    pathFormat !== PATH_FORMAT
  ) {
    console.warn(`🔗 Dropping driver geometry: unknown format "${pathFormat}"`);
    return null;
  }

  let serialised;
  try {
    serialised = JSON.stringify(path);
  } catch {
    console.warn("🔗 Dropping driver geometry: it does not serialise");
    return null;
  }

  const bytes = Buffer.byteLength(serialised, "utf8");
  if (bytes > MAX_PATH_BYTES) {
    console.warn(
      `🔗 Dropping driver geometry: ${bytes} bytes is over the ${MAX_PATH_BYTES} cap`,
    );
    return null;
  }
  return serialised;
}

/** How far each requested coordinate was from the road, serialised, or null. */
function parseEndpointOffsets(value) {
  if (!Array.isArray(value)) return null;
  if (!value.every((offset) => Number.isFinite(offset))) {
    console.warn("🔗 Dropping driver endpointOffsets: not all finite numbers");
    return null;
  }
  return JSON.stringify(value);
}

/**
 * A map driver's announced UI address, normalised, or null.
 *
 * This decides what an operator will be asked to approve, and an approved
 * address ends up in an iframe inside the console. Everything that is not an
 * ordinary http(s) page is refused here rather than shown to somebody as a
 * choice: `javascript:` and `data:` URLs execute in the console's own
 * document if anything ever renders them into a link, credentials in a URL are
 * a way of making one address look like another, and a fragment is not part of
 * an origin and would only ever confuse the comparison below.
 */
const MAX_MAP_DRIVER_URL_LENGTH = 2048;

function parseMapDriverUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MAP_DRIVER_URL_LENGTH) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return { url: url.toString(), origin: url.origin };
}

/** Whether a map driver is in this project's map slot right now. */
function isMapDriverConnected(projectId) {
  return driverFor(projectId, "map") !== null;
}

/**
 * What the console needs to know about this project's map view.
 *
 * The stored state and the live socket are separate facts and both are here:
 * an approved address whose driver is not running is a map view that will not
 * load, and the console decides what to show from the pair.
 */
async function mapDriverState(projectId) {
  const row = (await statements.getMapDriver(projectId, db)) || {};
  return {
    connected: isMapDriverConnected(projectId),
    status: row.map_driver_status || MAP_DRIVER_STATUS.NONE,
    url: row.map_driver_url || null,
    origin: row.map_driver_origin || null,
    pending_url: row.pending_map_driver_url || null,
  };
}

/** Tells every console tab on this project where its map view stands. */
async function broadcastMapDriverState(projectId) {
  try {
    io.to(`project-${projectId}`).emit(
      "map-driver-status",
      await mapDriverState(projectId),
    );
  } catch (err) {
    console.error("Error broadcasting map driver status:", err);
  }
}

/**
 * Files what a map driver said its UI address is.
 *
 * Announcing is not approving. The same address that is already approved
 * changes nothing - a driver restarting on the same port must not send an
 * operator back to the approval screen every time - and anything else becomes
 * a proposal that will not be embedded until somebody agrees to it.
 */
async function recordAnnouncedMapDriverUrl(projectId, announced) {
  const parsed = parseMapDriverUrl(announced);
  if (announced !== undefined && announced !== null && !parsed) {
    console.warn(
      `🔗 Ignoring the UI address a map driver announced for project ${projectId}: ` +
        "not an http(s) URL this server will offer for approval",
    );
  }
  if (!parsed) return;

  const current = (await statements.getMapDriver(projectId, db)) || {};
  if (
    current.map_driver_status === MAP_DRIVER_STATUS.APPROVED &&
    current.map_driver_url === parsed.url
  ) {
    console.log(
      `🗺️  Map driver for project ${projectId} reconnected on its approved address`,
    );
    return;
  }
  if (current.pending_map_driver_url === parsed.url) return;

  await statements.setPendingMapDriverUrl(projectId, parsed.url, db);
  console.log(
    `🗺️  Map driver for project ${projectId} announced ${parsed.url}; ` +
      "waiting for an operator to approve it before the console embeds it",
  );
}

/** Just enough of a capability set to read in a log line. */
function describeCapabilities(capabilities) {
  const declared = Object.keys(capabilities).filter((key) => capabilities[key]);
  return declared.length ? `, offering ${declared.join(" and ")}` : "";
}

wss.on("connection", (ws) => {
  console.log("🔗 Driver WebSocket connected");
  ws.isAuthenticated = false;
  ws.projectId = null;
  ws.driverRole = null;
  ws.protocolVersion = 1;
  ws.missedPongs = 0;
  ws.authTimer = setTimeout(() => {
    if (ws.isAuthenticated) return;
    console.warn(
      `🔗 Closing a driver socket that did not authenticate within ${AUTH_TIMEOUT_MS}ms`,
    );
    ws.close(CLOSE_AUTH_TIMEOUT, "authentication timeout");
  }, AUTH_TIMEOUT_MS);

  ws.on("pong", () => {
    ws.missedPongs = 0;
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "auth") {
      const role = parseDriverRole(msg.role);
      if (role === null) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Unknown driver role "${msg.role}"`,
          }),
        );
        ws.close(CLOSE_UNKNOWN_ROLE, "unknown driver role");
        return;
      }

      let projectId;
      try {
        projectId = await APIKeyToProjectId(msg.apiKey, db);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid API key" }));
        return;
      }

      clearTimeout(ws.authTimer);
      ws.isAuthenticated = true;
      ws.projectId = projectId;
      ws.driverRole = role;
      ws.protocolVersion = parseProtocolVersion(msg.protocolVersion);
      // Capabilities are additive and optional. Their absence costs the
      // console a thing to draw; it never costs a connection, and nothing here
      // reads them to decide what to send. If one ever had to be agreed on, it
      // would belong in the invariants rather than in a handshake.
      ws.capabilities =
        msg.capabilities && typeof msg.capabilities === "object"
          ? msg.capabilities
          : {};

      registerDriver(projectId, role, ws);
      ws.send(
        JSON.stringify({
          type: "authenticated",
          projectId,
          protocolVersion: ws.protocolVersion,
        }),
      );
      console.log(
        `🔗 ${role} driver "${msg.driverName || "unnamed"}" authenticated for ` +
          `project ${projectId} on protocol v${ws.protocolVersion}` +
          describeCapabilities(ws.capabilities),
      );

      if (role === "distance") {
        io.to(`project-${projectId}`).emit("distance-driver-status", {
          connected: true,
        });
        // Recalculate all edge distances now that a driver is available
        recalculateAllDistances(projectId);
      }

      if (role === "map") {
        try {
          await recordAnnouncedMapDriverUrl(projectId, msg.uiUrl);
        } catch (err) {
          console.error("Error recording an announced map driver URL:", err);
        }
        void broadcastMapDriverState(projectId);
      }
    } else if (msg.type === "distance-result") {
      const pending = takePending(msg.requestId, ws);
      if (!pending) return;
      pending.resolve({
        distance: msg.distance,
        path: parsePath(msg.path, msg.pathFormat),
        endpointOffsets: parseEndpointOffsets(msg.endpointOffsets),
      });
    } else if (msg.type === "distance-error") {
      const pending = takePending(msg.requestId, ws);
      if (!pending) return;
      const code = DRIVER_ERROR_CODES.has(msg.code) ? msg.code : "unavailable";
      if (code === "invalid-input") {
        // The driver is saying the server sent it something it could not use.
        // That is a fault on this side of the wire and it should be loud.
        console.error(
          `🔗 Driver on project ${ws.projectId} rejected a request as invalid ` +
            `input: ${msg.message || "(no message given)"}`,
        );
      }
      pending.reject(new DriverError(code, msg.message));
    }
  });

  ws.on("close", (code) => {
    clearTimeout(ws.authTimer);
    failPending(ws, new Error("Distance driver disconnected"));
    if (!unregisterDriver(ws)) return;

    console.log(
      `🔗 ${ws.driverRole} driver disconnected from project ${ws.projectId} (code ${code})`,
    );
    if (ws.driverRole === "distance") {
      io.to(`project-${ws.projectId}`).emit("distance-driver-status", {
        connected: false,
      });
    }
    // The approved address is still approved; there is just nothing serving
    // it. The console falls back to the graph view on this.
    if (ws.driverRole === "map") void broadcastMapDriverState(ws.projectId);
  });
});

// A crashed driver's socket looks open until TCP works out that it is not, and
// while it does the project's slot is taken by something that will never
// answer. Two unanswered pings is the difference between a driver that is busy
// and one that is gone.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.missedPongs >= MAX_MISSED_PONGS) {
      console.warn(
        `🔗 Terminating an unresponsive ${ws.driverRole || "unauthenticated"} ` +
          `driver socket after ${ws.missedPongs} missed pings`,
      );
      ws.terminate();
      continue;
    }
    ws.missedPongs = (ws.missedPongs || 0) + 1;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

/**
 * The fingerprint of the two positions a distance was measured between.
 *
 * What makes a stored distance stale is one of its checkpoints moving, and the
 * only way to notice that after the fact is to have written down where they
 * were. Null when either position is unusable, which reads as "moved" - an
 * edge whose ends cannot be identified is one worth asking about again.
 */
function endpointsHash(fromNode, toNode) {
  const parts = [
    fromNode.latitude,
    fromNode.longitude,
    toNode.latitude,
    toNode.longitude,
  ].map(Number);
  if (!parts.every(Number.isFinite)) return null;
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Why this edge needs asking about again, or null if it does not.
 *
 * Three reasons, and nothing else counts: it has no usable distance; one of
 * its checkpoints has moved since the distance was worked out; or it has no
 * route geometry and the attached driver is one that produces geometry. An
 * edge that fails all three is answered, current, and complete, and asking
 * again would cost a routing request to be told what is already stored.
 */
function stalenessReason(connection, nodesById, driverHasGeometry) {
  const fromNode = nodesById.get(connection.from_node_id);
  const toNode = nodesById.get(connection.to_node_id);
  // An edge whose endpoints are gone is not something a driver can answer.
  if (!fromNode || !toNode) return null;

  if (connection.distance_status !== DISTANCE_STATUS.OK) return "unresolved";

  const hash = endpointsHash(fromNode, toNode);
  // A NULL stored hash is every edge written before this was recorded. It
  // reads as moved, so each one is recalculated once, and that pass is what
  // gives it a hash.
  if (hash === null || hash !== connection.endpoints_hash) {
    return "endpoints moved";
  }

  if (driverHasGeometry && !connection.has_path) return "no geometry yet";

  return null;
}

/**
 * Asks the project's distance driver about the edges that have changed.
 *
 * Called whenever a distance driver connects, which used to mean every edge in
 * the project at once, every time. That was tolerable while the answer was a
 * single number; with geometry riding along it is wasteful, and against a
 * shared routing service it is close to abusive. A driver restarting on a
 * project whose distances are all current now sends nothing at all.
 */
async function recalculateAllDistances(projectId) {
  try {
    const driver = driverFor(projectId, "distance");
    if (!driver) return;
    // Declared capabilities decide what is worth asking for, never what is
    // sent: a driver that does not produce geometry is simply not asked to
    // fill geometry in. Nothing branches on which driver it is.
    const driverHasGeometry = Boolean(
      driver.capabilities && driver.capabilities.geometry,
    );

    const [connections, nodes] = await Promise.all([
      statements.getConnectionsForRecalculation(projectId, db),
      statements.getProjectNodes(projectId, db),
    ]);
    const nodesById = new Map(nodes.map((node) => [node.node_id, node]));

    const stale = [];
    const reasons = {};
    for (const conn of connections) {
      const reason = stalenessReason(conn, nodesById, driverHasGeometry);
      if (!reason) continue;
      stale.push(conn);
      reasons[reason] = (reasons[reason] || 0) + 1;
    }

    if (stale.length === 0) {
      console.log(
        `📏 Project ${projectId}: ${connections.length} edges considered, ` +
          "0 stale, nothing to ask",
      );
      return;
    }
    console.log(
      `📏 Project ${projectId}: ${connections.length} edges considered, ` +
        `${stale.length} stale (` +
        Object.entries(reasons)
          .map(([reason, count]) => `${count} ${reason}`)
          .join(", ") +
        ")",
    );

    const results = await Promise.allSettled(
      stale.map(async (conn) => {
        const fromNode = nodesById.get(conn.from_node_id);
        const toNode = nodesById.get(conn.to_node_id);
        const hash = endpointsHash(fromNode, toNode);

        let answer;
        try {
          answer = await requestDistanceFromDriver(projectId, fromNode, toNode);
        } catch (err) {
          // A driver that states a reason is believed, and the edge is marked
          // with what it said. Silence - a timeout, a dropped socket - is not
          // a statement about the road, so the edge keeps whatever it had.
          const stated = statusFromDriverError(err);
          if (!stated) throw err;

          await statements.updateConnection(
            conn.connection_id,
            projectId,
            {
              distance: null,
              distanceStatus: stated,
              speedLimit: conn.speed_limit,
              path: null,
              endpointOffsets: null,
              endpointsHash: hash,
            },
            db,
          );
          io.to(`project-${projectId}`).emit("connection-updated", {
            connection_id: conn.connection_id,
            distance: null,
            speed_limit: conn.speed_limit,
            distance_status: stated,
          });
          console.warn(
            `📏 Connection ${conn.connection_id} is ${stated}: driver said ${err.code} (${err.message})`,
          );
          return true;
        }

        const distance = parseNumeric(answer.distance);
        // An unusable answer is not an answer. The stored figure is left as it
        // was - a good distance is not downgraded because one reply was junk,
        // and an unresolved edge stays unresolved rather than becoming a
        // number that enforces nothing.
        if (!isValidDistance(distance)) {
          console.error(
            `📏 Connection ${conn.connection_id}: driver answered with a non-distance`,
          );
          return false;
        }
        await statements.updateConnection(
          conn.connection_id,
          projectId,
          {
            distance,
            distanceStatus: DISTANCE_STATUS.OK,
            speedLimit: conn.speed_limit,
            path: answer.path,
            endpointOffsets: answer.endpointOffsets,
            endpointsHash: hash,
          },
          db,
        );
        io.to(`project-${projectId}`).emit("connection-updated", {
          connection_id: conn.connection_id,
          distance,
          speed_limit: conn.speed_limit,
          distance_status: DISTANCE_STATUS.OK,
        });
        console.log(
          `📏 Updated connection ${conn.connection_id}: distance=${distance}` +
            (answer.path ? " with geometry" : ""),
        );
        return true;
      }),
    );

    // A failed request leaves that edge exactly as it was. A driver blip must
    // not turn a working road's distance into an unresolved one, and the edge
    // keeps its old fingerprint, so the next driver to connect asks again.
    const failed = results.filter((r) => r.status === "rejected").length;
    const recalculated = results.filter(
      (r) => r.status === "fulfilled" && r.value === true,
    ).length;
    console.log(
      `📏 Project ${projectId}: recalculated ${recalculated} of ${stale.length}` +
        (failed ? `, ${failed} unanswered and unchanged` : ""),
    );
  } catch (err) {
    console.error(`📏 Error recalculating distances: ${err.message}`);
  }
}

function isDistanceDriverConnected(projectId) {
  return driverFor(projectId, "distance") !== null;
}

/**
 * The distance status a driver's stated failure implies, or null if it stated
 * none.
 *
 * Silence is not a statement. A request that times out, or dies with its
 * socket, leaves the edge as it was: nobody has said anything about that road,
 * and a distance that was right an hour ago is still the best thing known. A
 * `distance-error` is different - the driver looked, and is saying what it
 * found. `no-route` is definitive and there is no point retrying it;
 * `unavailable` and `invalid-input` are not, and the next reconnect will.
 */
function statusFromDriverError(err) {
  if (!(err instanceof DriverError)) return null;
  return err.code === "no-route"
    ? DISTANCE_STATUS.NO_ROUTE
    : DISTANCE_STATUS.UNKNOWN;
}

/**
 * Asks the project's distance driver how far it is from one node to another.
 *
 * Resolves to `{ distance, path, endpointOffsets }`; rejects with a
 * DriverError when the driver said why it could not answer, and with a plain
 * Error when it said nothing at all.
 *
 * Both the node indices and the coordinates go out every time. A v1 driver
 * reads the indices and looks the positions up over REST; a v2 driver reads
 * the coordinates and never asks. Nothing here needs to know which is on the
 * other end, which is the point: one message serves both.
 */
function requestDistanceFromDriver(projectId, fromNode, toNode) {
  return new Promise((resolve, reject) => {
    const ws = driverFor(projectId, "distance");
    if (!ws) {
      reject(new Error("No distance driver connected"));
      return;
    }

    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      delete pendingDistanceRequests[requestId];
      reject(new Error("Distance calculation timed out"));
    }, DISTANCE_TIMEOUT_MS);

    pendingDistanceRequests[requestId] = { resolve, reject, timeout, ws };

    ws.send(
      JSON.stringify({
        type: "calculate-distance",
        requestId,
        fromIdInProject: fromNode.id_in_project,
        toIdInProject: toNode.id_in_project,
        from: { latitude: fromNode.latitude, longitude: fromNode.longitude },
        to: { latitude: toNode.latitude, longitude: toNode.longitude },
      }),
    );
  });
}

const db = createDatabase(path.join(__dirname, "database.db"));

app.use(express.json());

// --- The operator console ---
//
// The console is the Next.js app in `console/`, built to static files. Express
// serves that build where Next.js leaves it, so there is no copy step and no
// second directory to keep in sync. It is the same stack and the same design
// system as smartcheckpoints.xyz, and it talks to this process over the REST
// API and the Socket.IO channel below; there is no second server involved.
const consoleDir = path.join(__dirname, "console", "out");

// `_next` holds every stylesheet and script. Without it the pages load bare,
// which looks like a broken console rather than an unbuilt one.
const consoleBuilt =
  fs.existsSync(path.join(consoleDir, "index.html")) &&
  fs.existsSync(path.join(consoleDir, "_next"));

const NOT_BUILT_MESSAGE =
  "The Smart Checkpoints console has not been built.\n\n" +
  "Run this in the server directory, then reload:\n\n" +
  "    npm run build\n\n" +
  "The REST API and both realtime channels work without it; only these\n" +
  "pages are missing.\n";

if (!consoleBuilt) {
  console.warn(
    [
      "⚠️  The console has not been built, so its pages are unavailable.",
      "    The REST API and both realtime channels are running normally.",
      "    Run `npm run build` in this directory to build them.",
    ].join("\n"),
  );
}

/**
 * Serves one exported console page.
 *
 * Next.js writes `<route>/index.html`, and these routes are registered ahead
 * of `express.static` so `/admin` serves the page directly; left to itself,
 * static answers the slashless form with a 301 to `/admin/` and makes every
 * page load a round trip longer.
 */
function sendConsolePage(route) {
  return (req, res) => {
    if (!consoleBuilt) {
      return res.status(503).type("text/plain").send(NOT_BUILT_MESSAGE);
    }

    // A missing file must not reach the browser as an ENOENT stack trace with
    // an absolute path in it. Say what the startup warning says.
    res.sendFile(path.join(consoleDir, route, "index.html"), (err) => {
      if (!err || res.headersSent) return;
      console.warn(`⚠️  Could not serve /${route}: ${err.message}`);
      res.status(503).type("text/plain").send(NOT_BUILT_MESSAGE);
    });
  };
}

// The root is served explicitly too, so an unbuilt console answers it with the
// message above rather than with Express's own 404.
app.get("/", sendConsolePage(""));
app.get("/project", sendConsolePage("project"));
app.get("/admin", sendConsolePage("admin"));

if (consoleBuilt) {
  app.use(express.static(consoleDir));
}

// The documentation lives in one place for the whole ecosystem, and this is
// not it. The server used to carry a hand-maintained copy of the API reference
// that drifted from the published one; this redirect is what replaced it.
app.get("/documentation", (req, res) => {
  res.redirect(308, DOCS_URL);
});

app.get("/documentation/*splat", (req, res) => {
  res.redirect(308, DOCS_URL);
});

// --- Ownership and validation ---
//
// Node ids and connection ids are sequential integers from AUTOINCREMENT, so
// an id taken from a request says nothing about who is allowed to touch it.
// Every project-scoped path checks the row's project against the project the
// key opens, and the two write paths - REST and Socket.IO - share one
// implementation rather than each carrying its own copy of the rules.

/**
 * Rejects when `:id` in the path is not the project the API key opens.
 *
 * Declared once and applied as middleware, so a project-scoped endpoint added
 * later cannot quietly skip the check by forgetting to write it out.
 */
function requireOwnProject(req, res, next) {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isInteger(projectId) || req.projectId !== projectId) {
    return res.status(403).json({ error: "API key does not match project" });
  }
  next();
}

/**
 * Coerces a request-body value to a number, returning NaN for anything that is
 * not really one.
 *
 * Same rule, and the same reason, as `parseCoordinate` in geo.js: `Number()`
 * maps null, "", [] and false to 0, and 0 is a catastrophic speed limit rather
 * than an obviously missing one.
 */
function parseNumeric(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

/** km/h. Finite and above zero, or the violation maths is meaningless. */
function isValidSpeedLimit(value) {
  return Number.isFinite(value) && value > 0;
}

/** Metres. Finite and above zero: see INVALID_DISTANCE. */
function isValidDistance(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * Whether this edge may decide anything.
 *
 * The one question both the violation path and the congestion loop ask, asked
 * the same way in both places. It is a status check, not an arithmetic one:
 * enforcement is skipped because the distance is unresolved, not because a
 * placeholder happens to divide into a comparison that is false for every car.
 */
function canEnforce(connection) {
  return connection.distance_status === DISTANCE_STATUS.OK;
}

/**
 * Both endpoints of a proposed edge, but only if both are nodes in this
 * project. Returns null otherwise, and does not say which of the two failed:
 * "not yours" and "does not exist" are the same answer to a caller who should
 * not be able to tell them apart.
 */
async function resolveEdgeEndpoints(projectId, fromNodeId, toNodeId) {
  if (!Number.isFinite(fromNodeId) || !Number.isFinite(toNodeId)) return null;
  const [fromNode, toNode] = await Promise.all([
    statements.getNodeByNodeId(fromNodeId, db),
    statements.getNodeByNodeId(toNodeId, db),
  ]);
  if (!fromNode || !toNode) return null;
  if (fromNode.project_id !== projectId || toNode.project_id !== projectId) {
    return null;
  }
  return { fromNode, toNode };
}

/**
 * Creates an edge in `projectId`, asking the distance driver for the road
 * distance when one is attached and no distance was given.
 *
 * Resolves to `{ ok: true, connection }` or `{ ok: false, status, error }`.
 * The `connection-added` broadcast happens here, so both callers emit the same
 * event with the same fields.
 */
async function createConnectionForProject(projectId, input) {
  const fromNodeId = parseNumeric(input.fromNodeId);
  const toNodeId = parseNumeric(input.toNodeId);
  const speedLimit = parseNumeric(input.speedLimit);

  if (!isValidSpeedLimit(speedLimit)) {
    return { ok: false, status: 400, error: INVALID_SPEED_LIMIT };
  }

  const given = input.distance;
  let distance = null;
  if (given !== undefined && given !== null && given !== "") {
    distance = parseNumeric(given);
    if (!isValidDistance(distance)) {
      return { ok: false, status: 400, error: INVALID_DISTANCE };
    }
  }

  const endpoints = await resolveEdgeEndpoints(projectId, fromNodeId, toNodeId);
  if (!endpoints) {
    return { ok: false, status: 400, error: INVALID_ENDPOINTS };
  }
  const { fromNode, toNode } = endpoints;

  // A distance the operator typed is a figure they stand behind, so the edge
  // enforces on it. Without one the edge starts unresolved and stays that way
  // unless a driver answers.
  let distanceStatus =
    distance === null ? DISTANCE_STATUS.UNKNOWN : DISTANCE_STATUS.OK;
  let path = null;
  let endpointOffsets = null;

  if (distance === null && isDistanceDriverConnected(projectId)) {
    try {
      const answer = await requestDistanceFromDriver(
        projectId,
        fromNode,
        toNode,
      );
      const answered = parseNumeric(answer.distance);
      // A driver that answers with something unusable is a failed answer, not
      // a distance. Leave the edge unresolved rather than writing a number
      // nothing can enforce on into the column violations are computed from.
      if (isValidDistance(answered)) {
        distance = answered;
        distanceStatus = DISTANCE_STATUS.OK;
        path = answer.path;
        endpointOffsets = answer.endpointOffsets;
      } else {
        console.error(
          "Distance driver answered with a non-distance; edge left unresolved",
        );
      }
    } catch (err) {
      // "There is no road here" is an answer, and a new edge should be created
      // carrying it rather than looking like one nobody has got to yet.
      const stated = statusFromDriverError(err);
      if (stated) distanceStatus = stated;
      console.error("Distance driver request failed:", err.message);
    }
  }

  const connectionId = await statements.createConnection(
    projectId,
    fromNode.node_id,
    toNode.node_id,
    {
      distance,
      distanceStatus,
      speedLimit,
      path,
      endpointOffsets,
      endpointsHash: endpointsHash(fromNode, toNode),
    },
    db,
  );

  const connection = {
    connection_id: connectionId,
    from_node_id: fromNode.node_id,
    to_node_id: toNode.node_id,
    distance,
    speed_limit: speedLimit,
    distance_status: distanceStatus,
  };
  io.to(`project-${projectId}`).emit("connection-added", connection);
  return { ok: true, connection };
}

/**
 * Updates one edge, after checking it belongs to `projectId`.
 *
 * Distance and speed limit are the two numbers the violation calculation is
 * built from, which is why this path is checked rather than trusted: without
 * it, any valid key could count upward through connection ids and switch off
 * enforcement - or fabricate it - anywhere on the server, and the
 * `connection-updated` broadcast would go to the caller's room, so the project
 * that owns the edge would see nothing.
 */
async function updateConnectionForProject(projectId, connectionId, input) {
  if (!Number.isInteger(connectionId)) {
    return { ok: false, status: 400, error: "Invalid connection id" };
  }

  const existing = await statements.getConnectionById(connectionId, db);
  if (!existing) {
    return { ok: false, status: 404, error: "Connection not found" };
  }
  if (existing.project_id !== projectId) {
    return { ok: false, status: 403, error: "API key does not match project" };
  }

  const speedLimit = parseNumeric(input.speedLimit);
  if (!isValidSpeedLimit(speedLimit)) {
    return { ok: false, status: 400, error: INVALID_SPEED_LIMIT };
  }

  // An absent distance leaves the stored one, and its status, alone. This is
  // the path an operator takes when they are editing only the speed limit -
  // including on an edge no driver has resolved, which they must be able to do
  // without being asked for a distance they do not have.
  const given = input.distance;
  const edit = { speedLimit };
  let distance = existing.distance;
  let distanceStatus = existing.distance_status;
  if (given !== undefined && given !== null && given !== "") {
    distance = parseNumeric(given);
    if (!isValidDistance(distance)) {
      return { ok: false, status: 400, error: INVALID_DISTANCE };
    }
    // Typing a distance resolves the edge by hand, whatever a driver has or
    // has not managed to say about it - and it is a measurement of where the
    // checkpoints are now, so it is fingerprinted like any other.
    distanceStatus = DISTANCE_STATUS.OK;

    const [fromNode, toNode] = await Promise.all([
      statements.getNodeByNodeId(existing.from_node_id, db),
      statements.getNodeByNodeId(existing.to_node_id, db),
    ]);
    edit.endpointsHash =
      fromNode && toNode ? endpointsHash(fromNode, toNode) : null;
  }

  await statements.updateConnection(
    connectionId,
    projectId,
    { ...edit, distance, distanceStatus },
    db,
  );

  const connection = {
    connection_id: connectionId,
    distance,
    speed_limit: speedLimit,
    distance_status: distanceStatus,
  };
  io.to(`project-${projectId}`).emit("connection-updated", connection);
  return { ok: true, connection };
}

/**
 * Moves a checkpoint, after checking it belongs to `projectId`.
 *
 * A camera's position is the one input every distance in the project was
 * measured from, so moving one invalidates every edge that touches it. The
 * order below is what the operator sees: the checkpoint arrives at its new
 * position with its roads already marked as not enforcing, and the distances
 * fill back in as the driver answers. The alternative - leaving the old
 * numbers in place until new ones arrive - is a window in which the system
 * enforces a road length measured from somewhere the camera no longer is, and
 * nothing on any screen would say so.
 *
 * Resolves to `{ ok: true, node, invalidated }` or `{ ok: false, status,
 * error }`.
 */
async function moveNodeForProject(projectId, nodeId, input) {
  if (!Number.isInteger(nodeId)) {
    return { ok: false, status: 400, error: "Invalid node id" };
  }

  const latitude = parseCoordinate(input.latitude);
  const longitude = parseCoordinate(input.longitude);
  if (!isValidLatLng(latitude, longitude)) {
    return { ok: false, status: 400, error: INVALID_COORDINATES };
  }

  const node = await statements.getNodeByNodeId(nodeId, db);
  if (!node) {
    return { ok: false, status: 404, error: "Node not found" };
  }
  if (node.project_id !== projectId) {
    return { ok: false, status: 403, error: "API key does not match project" };
  }

  const moved = {
    node_id: node.node_id,
    id_in_project: node.id_in_project,
    latitude,
    longitude,
  };

  // A move to where the checkpoint already is changes nothing, and must not
  // throw away resolved distances to say so. This is what a retried PUT looks
  // like after a reply went missing, and the retry should be free.
  if (node.latitude === latitude && node.longitude === longitude) {
    return { ok: true, node: moved, invalidated: [] };
  }

  await statements.updateNodePosition(
    nodeId,
    projectId,
    latitude,
    longitude,
    db,
  );

  const touching = await statements.getConnectionsTouchingNode(
    nodeId,
    projectId,
    db,
  );
  await statements.invalidateConnectionsForNode(nodeId, projectId, db);

  io.to(`project-${projectId}`).emit("node-moved", moved);
  for (const edge of touching) {
    io.to(`project-${projectId}`).emit("connection-updated", {
      connection_id: edge.connection_id,
      distance: null,
      speed_limit: edge.speed_limit,
      distance_status: DISTANCE_STATUS.UNKNOWN,
    });
  }

  console.log(
    `📍 Checkpoint ${node.id_in_project} moved in project ${projectId}: ` +
      `${touching.length} edge(s) no longer enforcing until remeasured`,
  );

  // Nothing is asked of a driver here beyond "look again". Every edge just
  // invalidated is now unresolved, which is exactly what the staleness rule
  // already looks for, and this returns immediately when no driver is
  // attached - so this call is the whole of "recalculate if one is".
  void recalculateAllDistances(projectId);

  return { ok: true, node: moved, invalidated: touching };
}

// --- REST Endpoints ---

app.post("/create-project", async (req, res) => {
  const projectName = req.body["project-name"];
  const APIKey = createAPIKey();
  const projectId = await statements.createProject(projectName, APIKey, db);
  res.send({ project_id: projectId, api_key: APIKey });
});

app.post("/authenticate", async (req, res) => {
  const apiKey = req.body["api-key"];
  if (!apiKey) {
    return res.status(400).json({ error: "Missing API key" });
  }
  try {
    const project = await statements.authenticateProject(apiKey, db);
    if (!project) {
      // A camera's key is a real credential; it just does not open a project.
      // Saying so is the difference between an operator fixing their mistake
      // and an operator convinced the server has lost their project.
      const credential = await resolveAPIKey(apiKey, db).catch(() => null);
      if (credential) {
        return res.status(403).json({
          error:
            `This is a ${credential.role} key. The console needs the ` +
            "project's operator key.",
        });
      }
      return res.status(401).json({ error: "Invalid API key" });
    }
    res.json({
      project_id: project.project_id,
      project_name: project.project_name,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Altitude is future work: nodes carry latitude/longitude only for now, and
// the column naming leaves room for an `altitude` column later.
app.post("/create-node", authenticateAPIKey(db), async (req, res) => {
  try {
    const projectId = req.projectId;
    const latitude = parseCoordinate(req.body["latitude"]);
    const longitude = parseCoordinate(req.body["longitude"]);

    if (!isValidLatLng(latitude, longitude)) {
      return res.status(400).json({ error: INVALID_COORDINATES });
    }

    const result = await statements.createNode(
      projectId,
      latitude,
      longitude,
      db,
    );

    // Emit to connected clients
    io.to(`project-${projectId}`).emit("node-added", {
      node_id: result.node_id,
      id_in_project: result.id_in_project,
      latitude,
      longitude,
    });

    res.json({
      node_id: result.node_id,
      id_in_project: result.id_in_project,
    });
  } catch (err) {
    console.error("Error creating node:", err);
    res.status(500).json({ error: "Failed to create node" });
  }
});

app.post("/create-connection", authenticateAPIKey(db), async (req, res) => {
  try {
    const result = await createConnectionForProject(req.projectId, {
      fromNodeId: req.body["from-node-id"],
      toNodeId: req.body["to-node-id"],
      distance: req.body["distance"],
      speedLimit: req.body["speed-limit"],
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.send({ connection_id: result.connection.connection_id });
  } catch (err) {
    console.error("Error creating connection:", err);
    res.status(500).json({ error: "Failed to create connection" });
  }
});

app.get(
  "/project/:id/nodes",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    const nodes = await statements.getProjectNodes(req.projectId, db);
    res.json(nodes);
  },
);

app.get(
  "/project/:id/connections",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    const connections = await statements.getProjectConnections(
      req.projectId,
      db,
    );
    res.json(connections);
  },
);

/**
 * What is wrong with this project's data.
 *
 * Computed on request and never stored: it is a few milliseconds of arithmetic
 * over rows already in memory, and the moment a node moves every number in it
 * is a lie. The thresholds travel with the answer, because a flag an operator
 * cannot interrogate is a flag they will learn to ignore.
 */
app.get(
  "/project/:id/diagnostics",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    try {
      const [nodes, connections] = await Promise.all([
        statements.getProjectNodes(req.projectId, db),
        statements.getConnectionsForDiagnostics(req.projectId, db),
      ]);
      res.json(analyseProject(nodes, connections));
    } catch (err) {
      console.error("Error computing diagnostics:", err);
      res.status(500).json({ error: "Failed to compute diagnostics" });
    }
  },
);

/**
 * Every edge's route geometry, for whatever is drawing a map.
 *
 * Separate from `/connections` because it is a different order of size and a
 * different audience: the graph view needs neither, and most sessions never
 * open a map. The geometry goes out as the text the driver sent, inside a JSON
 * string, because the server does not parse route geometry - decoding it here
 * to re-encode it would be reading it, and invariant 4 says it does not.
 */
app.get(
  "/project/:id/geometry",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    try {
      const rows = await statements.getProjectGeometry(req.projectId, db);
      res.json(rows);
    } catch (err) {
      console.error("Error reading project geometry:", err);
      res.status(500).json({ error: "Failed to read geometry" });
    }
  },
);

/**
 * Where this project's map view is, and whether it is allowed to render.
 *
 * A map driver announces its own UI address when it authenticates. Whoever
 * holds the project API key would otherwise be choosing what appears inside
 * the console's own chrome, so an announcement is only ever a proposal: this
 * is what an operator reads before deciding, and the three writes below are
 * the decision.
 */
app.get(
  "/project/:id/map-driver",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    try {
      res.json(await mapDriverState(req.projectId));
    } catch (err) {
      console.error("Error reading map driver status:", err);
      res.status(500).json({ error: "Failed to read map driver status" });
    }
  },
);

/**
 * Approves the announced address, which is named in the body rather than
 * assumed.
 *
 * The operator is agreeing to a specific address they were shown. If a driver
 * re-announced a different one between that screen being drawn and this call
 * arriving, the statement matches nothing and this answers 409 - approving
 * "whatever is pending now" would be approving something nobody read.
 */
app.post(
  "/project/:id/map-driver/approve",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    const parsed = parseMapDriverUrl(req.body["url"]);
    if (!parsed) {
      return res
        .status(400)
        .json({ error: "url must be the announced http(s) address" });
    }
    try {
      const changed = await statements.approveMapDriverUrl(
        req.projectId,
        parsed.url,
        parsed.origin,
        db,
      );
      if (changed === 0) {
        return res.status(409).json({
          error: "That address is not the one waiting for approval",
        });
      }
      console.log(
        `🗺️  Project ${req.projectId} approved the map view at ${parsed.url} ` +
          `(origin ${parsed.origin})`,
      );
      const state = await mapDriverState(req.projectId);
      io.to(`project-${req.projectId}`).emit("map-driver-status", state);
      res.json(state);
    } catch (err) {
      console.error("Error approving a map driver URL:", err);
      res.status(500).json({ error: "Failed to approve the map driver" });
    }
  },
);

/** Refuses the announcement. Anything already approved is left alone. */
app.post(
  "/project/:id/map-driver/reject",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    try {
      await statements.clearPendingMapDriverUrl(req.projectId, db);
      const state = await mapDriverState(req.projectId);
      io.to(`project-${req.projectId}`).emit("map-driver-status", state);
      res.json(state);
    } catch (err) {
      console.error("Error rejecting a map driver URL:", err);
      res.status(500).json({ error: "Failed to reject the map driver" });
    }
  },
);

/** Withdraws approval entirely: no map view until something is approved again. */
app.post(
  "/project/:id/map-driver/revoke",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    try {
      await statements.clearMapDriver(req.projectId, db);
      console.log(`🗺️  Project ${req.projectId} withdrew its map view approval`);
      const state = await mapDriverState(req.projectId);
      io.to(`project-${req.projectId}`).emit("map-driver-status", state);
      res.json(state);
    } catch (err) {
      console.error("Error revoking a map driver URL:", err);
      res.status(500).json({ error: "Failed to revoke the map driver" });
    }
  },
);

/**
 * Corrects a checkpoint's position.
 *
 * `:id` is a node id, not a project id, so `requireOwnProject` does not fit
 * and the ownership check lives in the helper - the same shape, and for the
 * same reason, as editing a connection.
 */
app.put("/node/:id", authenticateAPIKey(db), async (req, res) => {
  try {
    const result = await moveNodeForProject(
      req.projectId,
      parseInt(req.params.id, 10),
      {
        latitude: req.body["latitude"],
        longitude: req.body["longitude"],
      },
    );
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({
      success: true,
      node_id: result.node.node_id,
      id_in_project: result.node.id_in_project,
      latitude: result.node.latitude,
      longitude: result.node.longitude,
      connections_invalidated: result.invalidated.length,
    });
  } catch (err) {
    console.error("Error moving node:", err);
    res.status(500).json({ error: "Failed to move node" });
  }
});

app.put("/connection/:id", authenticateAPIKey(db), async (req, res) => {
  try {
    const result = await updateConnectionForProject(
      req.projectId,
      parseInt(req.params.id, 10),
      {
        distance: req.body["distance"],
        speedLimit: req.body["speed-limit"],
      },
    );
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating connection:", err);
    res.status(500).json({ error: "Failed to update connection" });
  }
});

// The only endpoint a reporter key reaches. A camera holds one of those and
// nothing else: it reports what it saw, for its own project, and cannot read
// the graph, edit an edge, read violations or open the driver channel.
app.post(
  "/report-checkpoint",
  authenticateAPIKey(db, { roles: [ROLES.OPERATOR, ROLES.REPORTER] }),
  async (req, res) => {
    const projectId = req.projectId;
    const carPlate = req.body["car-plate"];
    const idInProject = req.body["id-in-project"];
    const timestamp = req.body["timestamp"];

    const node = await statements.getNodeByIdInProject(
      projectId,
      idInProject,
      db,
    );
    if (!node) {
      return res.status(404).json({ error: "Node not found" });
    }
    const nodeId = node.node_id;

    const sightingTime = timestamp ? new Date(timestamp) : new Date();
    const violationData = await calculateViolation(
      carPlate,
      nodeId,
      sightingTime,
    );

    // A road that is not enforcing should say so where somebody will see it,
    // rather than looking identical to a road where everyone drives legally.
    if (violationData.reason === "distance-not-resolved") {
      console.log(
        `⚠️  ${carPlate} crossed an edge that is not enforcing: distance is ` +
          `${violationData.distanceStatus}. No speed computed, no traversal recorded.`,
      );
    }

    if (violationData.status == true) {
      console.log(
        `Car ${carPlate} is violating the speed limit!
        Going ${violationData.carSpeed} in a ${violationData.legalLimit} zone!`,
      );

      // Emit violation to connected clients
      io.to(`project-${projectId}`).emit("violation-added", {
        car_plate: carPlate,
        car_speed: violationData.carSpeed,
        timestamp: sightingTime,
      });
    }
    // Only update the stored sighting when the request is not out-of-order;
    // otherwise we would overwrite a newer timestamp with an older one.
    if (!violationData.outOfOrder) {
      await statements.sightCar(projectId, carPlate, sightingTime, nodeId, db);
    }

    io.to(`project-${projectId}`).emit("node-triggered", {
      id_in_project: idInProject,
      car_plate: carPlate,
      violation: violationData.status,
    });

    res.send(violationData);
  },
);

app.get("/list-projects", async (req, res) => {
  const projects = await statements.listProjects(db);
  res.send(projects);
});

// --- Thumbnail data (no auth, just geometry) ---
app.get("/project/:id/thumbnail-data", async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    const data = await statements.getThumbnailData(projectId, db);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to get thumbnail data" });
  }
});

// --- Violations endpoint ---
app.get(
  "/project/:id/violations",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    try {
      const violations = await statements.getProjectViolations(
        req.projectId,
        db,
      );
      res.json(violations);
    } catch (err) {
      res.status(500).json({ error: "Failed to get violations" });
    }
  },
);

// --- Reporter keys ---
//
// One key per camera, each able to do exactly one thing. Issuing them is an
// operator action, so these three endpoints need the project's operator key;
// a reporter key cannot mint another, list its siblings, or revoke itself.

/** Labels are for the operator's eyes: a camera name, a junction, a pole. */
const MAX_LABEL_LENGTH = 60;

function parseLabel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined; // signals invalid
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_LABEL_LENGTH ? undefined : trimmed;
}

/**
 * Issues a reporter key for one camera.
 *
 * The key comes back in this response and is never readable again: the list
 * endpoint returns a prefix, not the credential. A lost camera key is revoked
 * and reissued, which is one call, rather than being a standing reason for
 * every bearer credential on the server to stay readable.
 */
app.post(
  "/project/:id/reporter-keys",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    const label = parseLabel(req.body && req.body["label"]);
    if (label === undefined) {
      return res.status(400).json({
        error: `label must be text of at most ${MAX_LABEL_LENGTH} characters`,
      });
    }
    try {
      const apiKey = createAPIKey();
      const keyId = await statements.createApiKey(
        req.projectId,
        apiKey,
        ROLES.REPORTER,
        label,
        db,
      );
      console.log(
        `🔑 Issued reporter key ${keyId} for project ${req.projectId}` +
          (label ? ` (${label})` : ""),
      );
      res.status(201).json({
        key_id: keyId,
        api_key: apiKey,
        role: ROLES.REPORTER,
        label,
      });
    } catch (err) {
      console.error("Error issuing reporter key:", err);
      res.status(500).json({ error: "Failed to issue reporter key" });
    }
  },
);

app.get(
  "/project/:id/reporter-keys",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    try {
      res.json(await statements.listApiKeys(req.projectId, db));
    } catch (err) {
      res.status(500).json({ error: "Failed to list reporter keys" });
    }
  },
);

app.delete(
  "/project/:id/reporter-keys/:keyId",
  authenticateAPIKey(db),
  requireOwnProject,
  async (req, res) => {
    const keyId = parseInt(req.params.keyId, 10);
    if (!Number.isInteger(keyId)) {
      return res.status(400).json({ error: "Invalid key id" });
    }
    try {
      // Scoped to the project, so a key id from another project deletes
      // nothing and reads as not found rather than succeeding quietly.
      const removed = await statements.revokeApiKey(keyId, req.projectId, db);
      if (removed === 0) {
        return res.status(404).json({ error: "Key not found" });
      }
      console.log(`🔑 Revoked key ${keyId} for project ${req.projectId}`);
      res.json({ success: true });
    } catch (err) {
      console.error("Error revoking reporter key:", err);
      res.status(500).json({ error: "Failed to revoke key" });
    }
  },
);

// --- Admin endpoints ---
//
// These list every project on the server together with its API key, and a
// project API key is full read/write on that project's graph and its violation
// records. So the gate fails closed: with no ADMIN_PASSWORD configured the
// endpoints are off, rather than comparing an absent password against an
// absent environment variable and finding them equal.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminEnabled =
  typeof ADMIN_PASSWORD === "string" && ADMIN_PASSWORD.length > 0;

if (!adminEnabled) {
  console.warn(
    "⚠️  ADMIN_PASSWORD is not set, so /admin is disabled on this server.\n" +
      "    Set it in .env to enable administration. See .env.example.",
  );
}

/** Compares digests so neither the password nor its length leaks by timing. */
function isAdminPassword(candidate) {
  if (!adminEnabled || typeof candidate !== "string" || candidate === "") {
    return false;
  }
  const given = crypto.createHash("sha256").update(candidate).digest();
  const expected = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(given, expected);
}

/** Rejects the request and returns true when administration is unavailable. */
function refuseIfAdminDisabled(res) {
  if (adminEnabled) return false;
  res.status(503).json({
    error:
      "Administration is disabled on this server: ADMIN_PASSWORD is not set.",
  });
  return true;
}

app.post("/admin/auth", (req, res) => {
  if (refuseIfAdminDisabled(res)) return;
  if (isAdminPassword(req.body.password)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// --- Distance Driver Status ---
app.get(
  "/project/:id/distance-driver-status",
  authenticateAPIKey(db),
  requireOwnProject,
  (req, res) => {
    res.json({ connected: isDistanceDriverConnected(req.projectId) });
  },
);

app.get("/admin/projects", async (req, res) => {
  if (refuseIfAdminDisabled(res)) return;
  if (!isAdminPassword(req.headers["x-admin-password"])) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const projects = await statements.listProjectsWithKeys(db);
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: "Failed to list projects" });
  }
});

// --- Socket.IO ---
io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  socket.on("join-project", async (data) => {
    const { apiKey } = data;
    try {
      const projectId = await APIKeyToProjectId(apiKey, db);
      const room = `project-${projectId}`;
      socket.join(room);
      socket.projectId = projectId;
      socket.apiKey = apiKey;
      console.log(`🏠 Socket ${socket.id} joined room ${room}`);
      socket.emit("joined", { project_id: projectId });
      // Send current distance driver status
      socket.emit("distance-driver-status", {
        connected: isDistanceDriverConnected(projectId),
      });
      socket.emit("map-driver-status", await mapDriverState(projectId));
    } catch (err) {
      socket.emit("error", { message: "Invalid API key" });
    }
  });

  // Both write handlers go through the same functions the REST endpoints
  // use. They used to be a second copy of that logic, and the copy was missing
  // the same ownership checks: a socket that had joined any project could
  // rewrite any connection on the server by its id.
  socket.on("create-connection", async (data) => {
    if (!socket.projectId) return;
    try {
      const result = await createConnectionForProject(socket.projectId, {
        fromNodeId: data.from_node_id,
        toNodeId: data.to_node_id,
        distance: data.distance,
        speedLimit: data.speed_limit,
      });
      if (!result.ok) {
        socket.emit("error", { message: result.error });
      }
    } catch (err) {
      socket.emit("error", { message: "Failed to create connection" });
    }
  });

  socket.on("update-connection", async (data) => {
    if (!socket.projectId) return;
    try {
      const result = await updateConnectionForProject(
        socket.projectId,
        parseInt(data.connection_id, 10),
        { distance: data.distance, speedLimit: data.speed_limit },
      );
      if (!result.ok) {
        socket.emit("error", { message: result.error });
      }
    } catch (err) {
      socket.emit("error", { message: "Failed to update connection" });
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// --- Start Server ---
// The schema migration must finish before anything can read a coordinate, and
// a failed migration must stop startup rather than serve wrong positions.
initializeDatabase(db)
  .then(() => {
    server.listen(port, host);
    console.log(
      `🎧 Listening on ${host}:${port}\n` +
        describeExposure() +
        `🖥️  Console: http://localhost:${port}/` +
        `${consoleBuilt ? "" : "  (not built, run: npm run build)"}\n` +
        `📚 Docs: ${DOCS_URL}`,
    );
    setInterval(broadcastCongestion, CONGESTION_INTERVAL_MS);
  })
  .catch((err) => {
    console.error("💥 Database initialization failed:", err.message);
    process.exit(1);
  });

// --- Congestion Broadcast Loop ---
const CONGESTION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CONGESTION_INTERVAL_MS = 3000; // every 3 seconds

async function broadcastCongestion() {
  try {
    // Prune old traversals
    await statements.deleteOldTraversals(CONGESTION_WINDOW_MS, db);

    // Find active project rooms
    const rooms = io.sockets.adapter.rooms;
    const projectRooms = new Set();
    for (const [roomName] of rooms) {
      const match = roomName.match(/^project-(\d+)$/);
      if (match) projectRooms.add(parseInt(match[1]));
    }

    for (const projectId of projectRooms) {
      const connections = await statements.getProjectConnections(projectId, db);
      const congestionData = {};

      for (const conn of connections) {
        // The same question the violation path asks. This loop used to skip
        // unresolved edges only because `tLegal > 0` happened to catch the
        // placeholder zero; with a null distance that accident would still
        // work, which is precisely why it is worth replacing with the reason.
        if (!canEnforce(conn)) continue;

        const traversals = await statements.getRecentTraversals(
          conn.connection_id,
          CONGESTION_WINDOW_MS,
          db,
        );
        if (traversals.length === 0) continue;

        const avgDeltaT =
          traversals.reduce((sum, t) => sum + t.delta_t, 0) / traversals.length;
        // T_legal in seconds: distance(m) / speed_limit(km/h) * 3.6
        const tLegal = (conn.distance / conn.speed_limit) * 3.6;
        if (Number.isFinite(tLegal) && tLegal > 0) {
          congestionData[conn.connection_id] = avgDeltaT / tLegal;
        }
      }

      if (Object.keys(congestionData).length > 0) {
        io.to(`project-${projectId}`).emit("congestion-update", congestionData);
      }
    }
  } catch (err) {
    console.error("Congestion broadcast error:", err);
  }
}

// --- Helpers ---

/**
 * One line at startup saying whether anything but this machine can reach the
 * server, and what to do about it either way.
 *
 * A server that is open to the network should say so, and a server that is not
 * should say why the cameras cannot see it - otherwise the first symptom of
 * either is a fleet of cameras reporting into nothing, or an enforcement API
 * quietly answering the whole network.
 */
function describeExposure() {
  if (boundToLoopback) {
    return (
      `🔒 Loopback only: nothing else on the network can reach this server.\n` +
      `   Set HOST=0.0.0.0 in .env to open it to cameras and drivers.\n`
    );
  }
  return (
    `🌐 Open to the network on ${host}.\n` +
    `📌 Cameras should report to ${getWifiAddress()}:${port}\n`
  );
}

function getWifiAddress() {
  const interfaces = os.networkInterfaces();
  const adapterName = process.env.WIFI_ADAPTER_NAME || "Wi-Fi";

  if (interfaces[adapterName]) {
    for (const info of interfaces[adapterName]) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return "Adapter not found or no IPv4 assigned";
}

function calculateTimeDifferenceInSeconds(timestamp1, timestamp2) {
  const timeDifference = timestamp2 - timestamp1;
  const timeDifferenceInSeconds = timeDifference / 1000;
  return timeDifferenceInSeconds;
}

/**
 * Decides whether this sighting is a violation, or says why it is not.
 *
 * Every path out carries a `reason`. Enforcement not happening is a normal
 * outcome here - a car's first sighting, two checkpoints with no edge between
 * them, an edge whose distance nobody has resolved - and the difference
 * between those matters to whoever is looking at why a road is quiet.
 */
async function calculateViolation(carPlate, nodeId, sightingTime) {
  const carData = await statements.fetchCarData(carPlate, db);
  if (!carData)
    return {
      status: false,
      carSpeed: 0,
      legalLimit: 0,
      timestamp: sightingTime,
      nodeId,
      carPlate,
      reason: "first-sighting",
    };

  const connection = await statements.getConnectionByNodes(
    carData.last_sighting_node_id,
    nodeId,
    db,
  );

  if (!connection)
    return {
      status: false,
      carSpeed: 10,
      legalLimit: 0,
      timestamp: sightingTime,
      nodeId,
      carPlate,
      reason: "no-edge",
    };

  const carTransversalTime = calculateTimeDifferenceInSeconds(
    carData.last_sighting_time,
    sightingTime,
  );

  // Guard against out-of-order HTTP requests: if the traversal time is
  // non-positive the current request arrived after a later one was already
  // processed, so we must ignore it entirely.
  if (carTransversalTime <= 0) {
    return {
      status: false,
      carSpeed: 0,
      legalLimit: connection.speed_limit,
      timestamp: sightingTime,
      nodeId,
      carPlate,
      outOfOrder: true,
      reason: "out-of-order",
    };
  }

  // An edge whose distance is not resolved decides nothing: no speed, no
  // traversal, no violation. This used to happen by accident - the placeholder
  // distance of 0 made the maximum traversal time 0, so the comparison was
  // false for every car and the road quietly stopped enforcing. The arithmetic
  // gave the right answer for the wrong reason, and would have started giving
  // the wrong one the moment anybody replaced that zero with an estimate.
  if (!canEnforce(connection)) {
    return {
      status: false,
      carSpeed: 0,
      legalLimit: connection.speed_limit,
      timestamp: sightingTime,
      nodeId,
      carPlate,
      reason: "distance-not-resolved",
      distanceStatus: connection.distance_status,
    };
  }

  // Record this traversal for congestion tracking
  await statements.recordTraversal(
    connection.connection_id,
    carTransversalTime,
    sightingTime,
    db,
  );

  const maximumTransversalTime =
    (connection.distance / connection.speed_limit) * (18 / 5);
  const carSpeed = (connection.distance / carTransversalTime) * (18 / 5);
  const status = carTransversalTime < maximumTransversalTime;

  if (status) {
    console.log(carData.project_id, carPlate, carSpeed, sightingTime);
    await statements.createViolation(
      carData.project_id,
      carPlate,
      carSpeed,
      sightingTime,
      db,
    );
  }
  console.log(carSpeed, connection.speed_limit);
  console.log(carTransversalTime, maximumTransversalTime, connection.distance);

  const violationData = {
    status,
    carSpeed: carSpeed,
    legalLimit: connection.speed_limit,
    timestamp: sightingTime,
    nodeId,
    carPlate,
    reason: null,
  };

  return violationData;
}
