const express = require("express");
const {
  createDatabase,
  initializeDatabase,
  statements,
} = require("./database.js");
const {
  createAPIKey,
  authenticateAPIKey,
  APIKeyToProjectId,
} = require("./api-key-manager.js");
const os = require("os");
require("dotenv").config({ quiet: true });
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const WebSocket = require("ws");
const crypto = require("crypto");

const port = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Distance Driver WebSocket ---
const wss = new WebSocket.Server({ noServer: true });
const distanceDrivers = {}; // projectId -> WebSocket
const pendingDistanceRequests = {}; // requestId -> { resolve, reject, timeout }

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/distance-driver") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    // Let Socket.IO handle its own upgrades
    // Do nothing here — Socket.IO hooks into the server internally
  }
});

wss.on("connection", (ws) => {
  console.log("🔗 Distance driver WebSocket connected");
  ws.isAuthenticated = false;
  ws.projectId = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "auth") {
      try {
        const projectId = await APIKeyToProjectId(msg.apiKey, db);
        ws.isAuthenticated = true;
        ws.projectId = projectId;
        distanceDrivers[projectId] = ws;
        ws.send(JSON.stringify({ type: "authenticated", projectId }));
        console.log(
          `🔗 Distance driver authenticated for project ${projectId}`,
        );
        // Notify web clients
        io.to(`project-${projectId}`).emit("distance-driver-status", {
          connected: true,
        });
        // Recalculate all edge distances now that a driver is available
        recalculateAllDistances(projectId);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid API key" }));
      }
    } else if (msg.type === "distance-result") {
      const pending = pendingDistanceRequests[msg.requestId];
      if (pending) {
        clearTimeout(pending.timeout);
        delete pendingDistanceRequests[msg.requestId];
        pending.resolve(msg.distance);
      }
    }
  });

  ws.on("close", () => {
    if (ws.projectId && distanceDrivers[ws.projectId] === ws) {
      delete distanceDrivers[ws.projectId];
      console.log(
        `🔗 Distance driver disconnected from project ${ws.projectId}`,
      );
      io.to(`project-${ws.projectId}`).emit("distance-driver-status", {
        connected: false,
      });
    }
  });
});

/**
 * Recalculates distances for ALL connections in a project by requesting
 * each one from the connected distance driver. Called automatically
 * whenever a distance driver (re)connects.
 */
async function recalculateAllDistances(projectId) {
  console.log(`📏 Recalculating all distances for project ${projectId}...`);
  try {
    const connections = await statements.getProjectConnections(projectId, db);
    const results = await Promise.allSettled(
      connections.map(async (conn) => {
        const fromNode = await statements.getNodeByNodeId(
          conn.from_node_id,
          db,
        );
        const toNode = await statements.getNodeByNodeId(conn.to_node_id, db);
        if (!fromNode || !toNode) return;

        const distance = await requestDistanceFromDriver(
          projectId,
          fromNode.id_in_project,
          toNode.id_in_project,
        );
        await statements.updateConnection(
          conn.connection_id,
          distance,
          conn.speed_limit,
          db,
        );
        io.to(`project-${projectId}`).emit("connection-updated", {
          connection_id: conn.connection_id,
          distance,
          speed_limit: conn.speed_limit,
        });
        console.log(
          `📏 Updated connection ${conn.connection_id}: distance=${distance}`,
        );
      }),
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.warn(
        `📏 ${failed.length}/${results.length} distance recalculations failed`,
      );
    }
    console.log(`📏 Finished recalculating distances for project ${projectId}`);
  } catch (err) {
    console.error(`📏 Error recalculating distances: ${err.message}`);
  }
}

function isDistanceDriverConnected(projectId) {
  const ws = distanceDrivers[projectId];
  return ws && ws.readyState === WebSocket.OPEN;
}

function requestDistanceFromDriver(projectId, fromIdInProject, toIdInProject) {
  return new Promise((resolve, reject) => {
    const ws = distanceDrivers[projectId];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("No distance driver connected"));
      return;
    }

    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      delete pendingDistanceRequests[requestId];
      reject(new Error("Distance calculation timed out"));
    }, 30000);

    pendingDistanceRequests[requestId] = { resolve, reject, timeout };

    ws.send(
      JSON.stringify({
        type: "calculate-distance",
        requestId,
        fromIdInProject,
        toIdInProject,
      }),
    );
  });
}

const db = createDatabase(path.join(__dirname, "database.db"));

app.use(express.json());
app.use(express.static(path.join(__dirname, "Public")));
initializeDatabase(db);

// --- Serve pages ---
app.get("/project", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "project.html"));
});

app.get("/documentation", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "documentation.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "Public", "admin.html"));
});

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

app.post("/create-node", authenticateAPIKey(db), async (req, res) => {
  try {
    const projectId = req.projectId;
    const xCoord = req.body["x-coord"];
    const yCoord = req.body["y-coord"];
    const zCoord = req.body["z-coord"]; // Optional 3D coordinate

    const result = await statements.createNode(projectId, xCoord, yCoord, db);

    // Emit to connected clients
    io.to(`project-${projectId}`).emit("node-added", {
      node_id: result.node_id,
      id_in_project: result.id_in_project,
      x_coord: xCoord,
      y_coord: yCoord,
    });

    res.json({
      node_id: result.node_id,
      id_in_project: result.id_in_project,
    });
  } catch (err) {
    console.error("Error creating node:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/create-connection", authenticateAPIKey(db), async (req, res) => {
  const projectId = req.projectId;
  const fromNodeId = req.body["from-node-id"];
  const toNodeId = req.body["to-node-id"];
  let distance = req.body["distance"];
  const speedLimit = req.body["speed-limit"];

  try {
    // If no distance provided and distance driver is connected, request it
    if (
      (distance === undefined || distance === null) &&
      isDistanceDriverConnected(projectId)
    ) {
      const fromNode = await statements.getNodeByNodeId(fromNodeId, db);
      const toNode = await statements.getNodeByNodeId(toNodeId, db);
      if (fromNode && toNode) {
        try {
          distance = await requestDistanceFromDriver(
            projectId,
            fromNode.id_in_project,
            toNode.id_in_project,
          );
        } catch (err) {
          console.error("Distance driver request failed:", err.message);
          distance = 0;
        }
      } else {
        distance = 0;
      }
    }

    if (distance === undefined || distance === null) distance = 0;

    const connectionId = await statements.createConnection(
      projectId,
      fromNodeId,
      toNodeId,
      distance,
      speedLimit,
      db,
    );

    // Emit to connected clients
    io.to(`project-${projectId}`).emit("connection-added", {
      connection_id: connectionId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      distance,
      speed_limit: speedLimit,
    });

    res.send({ connection_id: connectionId });
  } catch (err) {
    console.error("Error creating connection:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/project/:id/nodes", authenticateAPIKey(db), async (req, res) => {
  const projectId = parseInt(req.params.id);
  if (req.projectId !== projectId) {
    return res.status(403).json({ error: "API key does not match project" });
  }
  const nodes = await statements.getProjectNodes(projectId, db);
  res.json(nodes);
});

app.get(
  "/project/:id/connections",
  authenticateAPIKey(db),
  async (req, res) => {
    const projectId = parseInt(req.params.id);
    if (req.projectId !== projectId) {
      return res.status(403).json({ error: "API key does not match project" });
    }
    const connections = await statements.getProjectConnections(projectId, db);
    res.json(connections);
  },
);

app.put("/connection/:id", authenticateAPIKey(db), async (req, res) => {
  const connectionId = parseInt(req.params.id);
  const distance = req.body["distance"];
  const speedLimit = req.body["speed-limit"];

  await statements.updateConnection(connectionId, distance, speedLimit, db);

  // Emit to connected clients
  io.to(`project-${req.projectId}`).emit("connection-updated", {
    connection_id: connectionId,
    distance,
    speed_limit: speedLimit,
  });

  res.json({ success: true });
});

app.post("/report-checkpoint", authenticateAPIKey(db), async (req, res) => {
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
});

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
app.get("/project/:id/violations", authenticateAPIKey(db), async (req, res) => {
  const projectId = parseInt(req.params.id);
  if (req.projectId !== projectId) {
    return res.status(403).json({ error: "API key does not match project" });
  }
  try {
    const violations = await statements.getProjectViolations(projectId, db);
    res.json(violations);
  } catch (err) {
    res.status(500).json({ error: "Failed to get violations" });
  }
});

// --- Admin endpoints ---
app.post("/admin/auth", (req, res) => {
  const password = req.body.password;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// --- Distance Driver Status ---
app.get(
  "/project/:id/distance-driver-status",
  authenticateAPIKey(db),
  (req, res) => {
    const projectId = parseInt(req.params.id);
    res.json({ connected: isDistanceDriverConnected(projectId) });
  },
);

app.get("/admin/projects", async (req, res) => {
  // Simple password check via header
  const password = req.headers["x-admin-password"];
  if (password !== process.env.ADMIN_PASSWORD) {
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
    } catch (err) {
      socket.emit("error", { message: "Invalid API key" });
    }
  });

  socket.on("create-connection", async (data) => {
    if (!socket.projectId) return;
    let { from_node_id, to_node_id, distance, speed_limit } = data;
    try {
      // If no distance and distance driver is connected, request it
      if (
        (distance === undefined || distance === null) &&
        isDistanceDriverConnected(socket.projectId)
      ) {
        const fromNode = await statements.getNodeByNodeId(from_node_id, db);
        const toNode = await statements.getNodeByNodeId(to_node_id, db);
        if (fromNode && toNode) {
          try {
            distance = await requestDistanceFromDriver(
              socket.projectId,
              fromNode.id_in_project,
              toNode.id_in_project,
            );
          } catch (err) {
            console.error("Distance driver request failed:", err.message);
            distance = 0;
          }
        } else {
          distance = 0;
        }
      }
      if (distance === undefined || distance === null) distance = 0;

      const connectionId = await statements.createConnection(
        socket.projectId,
        from_node_id,
        to_node_id,
        distance,
        speed_limit,
        db,
      );
      io.to(`project-${socket.projectId}`).emit("connection-added", {
        connection_id: connectionId,
        from_node_id,
        to_node_id,
        distance,
        speed_limit,
      });
    } catch (err) {
      socket.emit("error", { message: "Failed to create connection" });
    }
  });

  socket.on("update-connection", async (data) => {
    if (!socket.projectId) return;
    const { connection_id, distance, speed_limit } = data;
    try {
      await statements.updateConnection(
        connection_id,
        distance,
        speed_limit,
        db,
      );
      io.to(`project-${socket.projectId}`).emit("connection-updated", {
        connection_id,
        distance,
        speed_limit,
      });
    } catch (err) {
      socket.emit("error", { message: "Failed to update connection" });
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// --- Start Server ---
server.listen(port);
console.log(
  `🎧 Listening on localhost:${port}\n📌 Local Network Path: ${getWifiAddress()}:${port}`,
);

// --- Congestion Broadcast Loop ---
const CONGESTION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CONGESTION_INTERVAL_MS = 3000; // every 3 seconds

setInterval(async () => {
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
        if (tLegal > 0) {
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
}, CONGESTION_INTERVAL_MS);

// --- Helpers ---
function getWifiAddress() {
  const interfaces = os.networkInterfaces();
  const adapterName = process.env.WIFI_ADAPTER_NAME;

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

  violationData = {
    status,
    carSpeed: carSpeed,
    legalLimit: connection.speed_limit,
    timestamp: sightingTime,
    nodeId,
    carPlate,
  };

  return violationData;
}
