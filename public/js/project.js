// ==============================
// Smart Checkpoints — Canvas
// ==============================

(() => {
  // --- Parse URL params ---
  const params = new URLSearchParams(window.location.search);
  const projectId = parseInt(params.get("id"));
  const apiKey = params.get("key");

  if (!projectId || !apiKey) {
    window.location.href = "/";
    return;
  }

  // --- State ---
  let nodes = []; // { node_id, id_in_project, x_coord, y_coord }
  let connections = []; // { connection_id, from_node_id, to_node_id, distance, speed_limit }
  let settingsScale = 1.0; // Scale multiplier for node positions

  const NODE_RADIUS = 28;
  const NODE_STROKE = 3.5;
  const ARROW_SIZE = 12;
  const CONNECTION_COLORS = [
    "#4ecb71",
    "#e74c5e",
    "#f7c948",
    "#19c4d8",
    "#a87fff",
    "#ff8a5c",
  ];
  const CYAN = "#19c4d8";
  const CANVAS_BG = "#d9d9d9";
  const EDGE_OFFSET = 8; // Perpendicular offset for bidirectional edges
  const NO_DATA_COLOR = "#aaaaaa";

  // Congestion state
  const congestionTarget = {}; // connection_id -> target C value
  const congestionDisplay = {}; // connection_id -> smoothly lerped display C

  // Preload arrow head image
  const arrowHeadImg = new Image();
  arrowHeadImg.src = "/Images/arrow-head.png";
  arrowHeadImg.onload = () => draw();

  let hoveredNode = null;
  let hoveredConnection = null;

  // Drag-connect state
  let isDragging = false;
  let dragFromNode = null;
  let dragMouseX = 0;
  let dragMouseY = 0;

  // Pan & Zoom state
  let panX = 0;
  let panY = 0;
  let zoom = 1;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panStartPanX = 0;
  let panStartPanY = 0;

  // Flash state
  const nodeFlashes = {}; // id_in_project -> { alpha, timer }

  // Selected connection for editing
  let selectedConnection = null;

  // Distance driver state
  let distanceDriverConnected = false;

  // --- Canvas Setup ---
  const canvas = document.getElementById("project-canvas");
  const ctx = canvas.getContext("2d");

  function resizeCanvas() {
    const header = document.getElementById("project-header");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - header.offsetHeight;
    // Initialize pan so (0,0) is at center
    if (panX === 0 && panY === 0) {
      panX = canvas.width / 2;
      panY = canvas.height / 2;
    }
  }
  window.addEventListener("resize", () => {
    resizeCanvas();
    draw();
  });
  resizeCanvas();

  // --- Coordinate transforms ---
  function screenToWorld(sx, sy) {
    return {
      x: (sx - panX) / zoom,
      y: (sy - panY) / zoom,
    };
  }

  function worldToScreen(wx, wy) {
    return {
      x: wx * zoom + panX,
      y: wy * zoom + panY,
    };
  }

  // --- Helpers ---
  function getNodeById(nodeId) {
    return nodes.find((n) => n.node_id === nodeId);
  }

  function getNodeByIdInProject(idInProject) {
    return nodes.find((n) => n.id_in_project === idInProject);
  }

  function getConnectionColor(index) {
    return CONNECTION_COLORS[index % CONNECTION_COLORS.length];
  }

  // --- Congestion Color Interpolation ---
  function getCongestionColor(C) {
    if (C === undefined || C === null) return NO_DATA_COLOR;
    // Green (C<=1) -> Yellow (C=1.5) -> Red (C>=2)
    if (C <= 1.0) return "hsl(130, 65%, 45%)";
    if (C >= 2.0) return "hsl(0, 75%, 50%)";
    if (C <= 1.5) {
      // Green -> Yellow
      const t = (C - 1.0) / 0.5;
      const h = 130 + (45 - 130) * t;
      const s = 65 + (95 - 65) * t;
      const l = 45 + (50 - 45) * t;
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
    // Yellow -> Red
    const t = (C - 1.5) / 0.5;
    const h = 45 + (0 - 45) * t;
    const s = 95 + (75 - 95) * t;
    const l = 50;
    return `hsl(${h}, ${s}%, ${l}%)`;
  }

  function distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
  }

  // --- Check for bidirectional edges ---
  function hasBidirectional(fromId, toId) {
    return connections.some(
      (c) => c.from_node_id === toId && c.to_node_id === fromId,
    );
  }

  // --- Drawing ---
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // Draw subtle grid (origin cross)
    drawGrid();

    drawConnections();
    drawNodes();

    // Draw drag line (in world coords)
    if (isDragging && dragFromNode) {
      const worldMouse = screenToWorld(dragMouseX, dragMouseY);
      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = "rgba(25, 196, 216, 0.6)";
      ctx.lineWidth = 2.5 / zoom;
      ctx.beginPath();
      ctx.moveTo(
        dragFromNode.x_coord * settingsScale,
        dragFromNode.y_coord * settingsScale,
      );
      ctx.lineTo(worldMouse.x, worldMouse.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function drawGrid() {
    // Draw subtle origin cross
    ctx.save();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([6 / zoom, 6 / zoom]);

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(-10000, 0);
    ctx.lineTo(10000, 0);
    ctx.stroke();

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(0, -10000);
    ctx.lineTo(0, 10000);
    ctx.stroke();

    ctx.setLineDash([]);

    // Origin dot
    ctx.beginPath();
    ctx.arc(0, 0, 4 / zoom, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.fill();

    ctx.restore();
  }

  function drawNodes() {
    for (const node of nodes) {
      const isHovered = hoveredNode === node;
      const flash = nodeFlashes[node.id_in_project];
      const hasFlash = flash && flash.alpha > 0;

      ctx.save();

      // Flash glow
      if (hasFlash) {
        ctx.beginPath();
        ctx.arc(
          node.x_coord * settingsScale,
          node.y_coord * settingsScale,
          NODE_RADIUS + 10,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = `rgba(231, 76, 94, ${flash.alpha * 0.35})`;
        ctx.fill();
      }

      // Outer circle
      ctx.beginPath();
      ctx.arc(
        node.x_coord * settingsScale,
        node.y_coord * settingsScale,
        NODE_RADIUS,
        0,
        Math.PI * 2,
      );

      // Fill — white normally, light blue on hover
      if (hasFlash) {
        ctx.fillStyle = `rgba(231, 76, 94, ${0.15 + flash.alpha * 0.3})`;
      } else {
        ctx.fillStyle = isHovered ? "#e3fcff" : "#ffffff";
      }
      ctx.fill();

      // Stroke
      ctx.lineWidth = NODE_STROKE;
      if (isHovered) {
        ctx.strokeStyle = "#14a8bd";
      } else {
        ctx.strokeStyle = CYAN;
      }
      ctx.stroke();

      // Label
      ctx.fillStyle = isHovered ? "#14a8bd" : CYAN;
      ctx.font = `bold ${NODE_RADIUS * 0.75}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        node.id_in_project,
        node.x_coord * settingsScale,
        node.y_coord * settingsScale + 1,
      );

      ctx.restore();
    }
  }

  function drawConnections() {
    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i];
      const fromNode = getNodeById(conn.from_node_id);
      const toNode = getNodeById(conn.to_node_id);
      if (!fromNode || !toNode) continue;

      const isHovered = hoveredConnection === conn;
      const isSelected = selectedConnection === conn;
      const cVal = congestionDisplay[conn.connection_id];
      const color = getCongestionColor(cVal);

      const fX = fromNode.x_coord * settingsScale;
      const fY = fromNode.y_coord * settingsScale;
      const tX = toNode.x_coord * settingsScale;
      const tY = toNode.y_coord * settingsScale;

      let dx = tX - fX;
      let dy = tY - fY;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;

      const ux = dx / len;
      const uy = dy / len;

      // Perpendicular direction
      const perpX = -uy;
      const perpY = ux;

      // Check if bidirectional — offset if so
      const isBidi = hasBidirectional(conn.from_node_id, conn.to_node_id);
      const offset = isBidi ? EDGE_OFFSET : 0;

      // Offset start and end points
      const fromX = fX + perpX * offset;
      const fromY = fY + perpY * offset;
      const toX = tX + perpX * offset;
      const toY = tY + perpY * offset;

      // Recalculate direction for offset line
      const odx = toX - fromX;
      const ody = toY - fromY;
      const olen = Math.hypot(odx, ody);
      const oux = odx / olen;
      const ouy = ody / olen;

      // Start and end points (clipped to node radius)
      const x1 = fromX + oux * NODE_RADIUS;
      const y1 = fromY + ouy * NODE_RADIUS;
      const x2 = toX - oux * (NODE_RADIUS + ARROW_SIZE + 4);
      const y2 = toY - ouy * (NODE_RADIUS + ARROW_SIZE + 4);

      ctx.save();

      // Line
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle =
        isHovered || isSelected ? darkenColor(color, 0.3) : color;
      ctx.lineWidth = isHovered || isSelected ? 4 : 3;
      ctx.stroke();

      // Arrowhead (drawn with arrow-head.png)
      if (arrowHeadImg.complete && arrowHeadImg.naturalWidth > 0) {
        const arrowTipX = toX - oux * (NODE_RADIUS + 2);
        const arrowTipY = toY - ouy * (NODE_RADIUS + 2);
        const angle = Math.atan2(ouy, oux);
        const imgSize = ARROW_SIZE * 2;

        ctx.save();
        ctx.translate(arrowTipX, arrowTipY);
        ctx.rotate(angle + Math.PI / 2);
        ctx.drawImage(arrowHeadImg, -imgSize / 2, 0, imgSize, imgSize);
        ctx.restore();
      }

      ctx.restore();
    }
  }

  function darkenColor(hex, amount) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * (1 - amount))}, ${Math.round(g * (1 - amount))}, ${Math.round(b * (1 - amount))})`;
  }

  // --- Hit Testing (in world coords) ---
  function getNodeAt(wx, wy) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dist = Math.hypot(
        wx - n.x_coord * settingsScale,
        wy - n.y_coord * settingsScale,
      );
      if (dist <= NODE_RADIUS) return n;
    }
    return null;
  }

  function getConnectionAt(wx, wy) {
    const threshold = 8 / zoom;
    for (let i = connections.length - 1; i >= 0; i--) {
      const conn = connections[i];
      const fromNode = getNodeById(conn.from_node_id);
      const toNode = getNodeById(conn.to_node_id);
      if (!fromNode || !toNode) continue;

      const fX = fromNode.x_coord * settingsScale;
      const fY = fromNode.y_coord * settingsScale;
      const tX = toNode.x_coord * settingsScale;
      const tY = toNode.y_coord * settingsScale;

      // Account for bidirectional offset
      const dx = tX - fX;
      const dy = tY - fY;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const perpX = -(dy / len);
      const perpY = dx / len;
      const isBidi = hasBidirectional(conn.from_node_id, conn.to_node_id);
      const offset = isBidi ? EDGE_OFFSET : 0;

      const dist = distPointToSegment(
        wx,
        wy,
        fX + perpX * offset,
        fY + perpY * offset,
        tX + perpX * offset,
        tY + perpY * offset,
      );
      if (dist <= threshold) return conn;
    }
    return null;
  }

  // --- Mouse Events ---
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (isPanning) {
      panX = panStartPanX + (sx - panStartX);
      panY = panStartPanY + (sy - panStartY);
      draw();
      return;
    }

    if (isDragging) {
      dragMouseX = sx;
      dragMouseY = sy;
      draw();
      return;
    }

    const world = screenToWorld(sx, sy);
    const node = getNodeAt(world.x, world.y);
    const conn = node ? null : getConnectionAt(world.x, world.y);

    const changed = hoveredNode !== node || hoveredConnection !== conn;
    hoveredNode = node;
    hoveredConnection = conn;

    canvas.style.cursor = node ? "pointer" : conn ? "pointer" : "";
    if ((node != null) | (conn != null)) {
      canvas.classList.add("is-hovered-on");
    } else {
      canvas.classList.remove("is-hovered-on");
    }
    if (changed) draw();
  });

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Middle click = pan
    if (e.button === 1) {
      e.preventDefault();
      isPanning = true;
      panStartX = sx;
      panStartY = sy;
      panStartPanX = panX;
      panStartPanY = panY;
      canvas.style.cursor = "grabbing";
      return;
    }

    if (e.button !== 0) return;

    const world = screenToWorld(sx, sy);
    const node = getNodeAt(world.x, world.y);
    if (node) {
      // Start drag-connect
      isDragging = true;
      dragFromNode = node;
      dragMouseX = sx;
      dragMouseY = sy;
      canvas.style.cursor = "crosshair";
      return;
    }

    const conn = getConnectionAt(world.x, world.y);
    if (conn) {
      openConnectionEditor(conn);
    } else {
      closeConnectionEditor();
      // Start panning on left-click on empty space
      isPanning = true;
      panStartX = sx;
      panStartY = sy;
      panStartPanX = panX;
      panStartPanY = panY;
      canvas.style.cursor = "grabbing";
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (isPanning) {
      isPanning = false;
      canvas.style.cursor = "";
      return;
    }

    if (!isDragging) return;
    isDragging = false;
    canvas.style.cursor = "";

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);

    const targetNode = getNodeAt(world.x, world.y);
    if (targetNode && targetNode !== dragFromNode) {
      openNewConnectionModal(dragFromNode, targetNode);
    }

    dragFromNode = null;
    draw();
  });

  // Prevent context menu on canvas
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Zoom with mouse wheel
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.max(0.1, Math.min(5, zoom * zoomFactor));

      // Zoom centered on cursor
      panX = sx - (sx - panX) * (newZoom / zoom);
      panY = sy - (sy - panY) * (newZoom / zoom);
      zoom = newZoom;

      draw();
    },
    { passive: false },
  );

  canvas.addEventListener("mouseleave", () => {
    if (isDragging) {
      isDragging = false;
      dragFromNode = null;
      canvas.style.cursor = "";
      draw();
    }
    if (isPanning) {
      isPanning = false;
      canvas.style.cursor = "";
    }
    hoveredNode = null;
    hoveredConnection = null;
    draw();
  });

  // --- Connection Editor ---
  const editorPanel = document.getElementById("connection-editor");
  const editDistance = document.getElementById("edit-distance");
  const editSpeedLimit = document.getElementById("edit-speed-limit");
  const editSave = document.getElementById("edit-save");
  const editCancel = document.getElementById("edit-cancel");

  function openConnectionEditor(conn) {
    selectedConnection = conn;
    editDistance.value = conn.distance || "";
    editSpeedLimit.value = conn.speed_limit || "";
    editDistance.disabled = distanceDriverConnected;
    editorPanel.classList.remove("hidden");
    draw();
  }

  function closeConnectionEditor() {
    selectedConnection = null;
    editorPanel.classList.add("hidden");
    draw();
  }

  editSave.addEventListener("click", () => {
    if (!selectedConnection) return;
    const distance = parseFloat(editDistance.value);
    const speedLimit = parseFloat(editSpeedLimit.value);
    if (isNaN(distance) || isNaN(speedLimit)) return;

    socket.emit("update-connection", {
      connection_id: selectedConnection.connection_id,
      distance,
      speed_limit: speedLimit,
    });

    selectedConnection.distance = distance;
    selectedConnection.speed_limit = speedLimit;
    closeConnectionEditor();
  });

  editCancel.addEventListener("click", closeConnectionEditor);

  // Enter to save in editor
  editDistance.addEventListener("keydown", (e) => {
    if (e.key === "Enter") editSave.click();
  });
  editSpeedLimit.addEventListener("keydown", (e) => {
    if (e.key === "Enter") editSave.click();
  });

  // --- New Connection Modal ---
  const newConnModal = document.getElementById("new-connection-modal");
  const newConnSubtitle = document.getElementById("new-conn-subtitle");
  const newConnDistance = document.getElementById("new-conn-distance");
  const newConnSpeed = document.getElementById("new-conn-speed");
  const newConnSubmit = document.getElementById("new-conn-submit");
  const newConnClose = document.getElementById("new-conn-close");

  let pendingFromNode = null;
  let pendingToNode = null;

  function openNewConnectionModal(from, to) {
    pendingFromNode = from;
    pendingToNode = to;
    newConnSubtitle.textContent = `Node ${from.id_in_project} → Node ${to.id_in_project}`;
    // Set default values
    newConnDistance.value = distanceDriverConnected ? "" : "100";
    newConnDistance.disabled = distanceDriverConnected;
    newConnDistance.placeholder = distanceDriverConnected
      ? "Calculated by driver"
      : "100";
    newConnSpeed.value = "60";
    newConnModal.classList.remove("hidden");
    setTimeout(
      () => (distanceDriverConnected ? newConnSpeed : newConnDistance).focus(),
      50,
    );
  }

  function submitNewConnection() {
    if (!pendingFromNode || !pendingToNode) return;
    const speedLimit = parseFloat(newConnSpeed.value);
    if (isNaN(speedLimit)) return;

    const payload = {
      from_node_id: pendingFromNode.node_id,
      to_node_id: pendingToNode.node_id,
      speed_limit: speedLimit,
    };

    if (!distanceDriverConnected) {
      const distance = parseFloat(newConnDistance.value);
      if (isNaN(distance)) return;
      payload.distance = distance;
    }
    // If driver connected, omit distance — server will request from driver

    socket.emit("create-connection", payload);

    newConnModal.classList.add("hidden");
    pendingFromNode = null;
    pendingToNode = null;
  }

  newConnSubmit.addEventListener("click", submitNewConnection);

  // Enter to submit on both inputs
  newConnDistance.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitNewConnection();
  });
  newConnSpeed.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitNewConnection();
  });

  newConnClose.addEventListener("click", () => {
    newConnModal.classList.add("hidden");
  });

  newConnModal.addEventListener("click", (e) => {
    if (e.target === newConnModal) newConnModal.classList.add("hidden");
  });

  // --- Violations Panel ---
  const violationsPanel = document.getElementById("violations-panel");
  const violationsToggle = document.getElementById("violations-toggle");
  const violationsTbody = document.getElementById("violations-tbody");
  const violationsEmpty = document.getElementById("violations-empty");
  let violationsOpen = false;

  violationsToggle.addEventListener("click", () => {
    violationsOpen = !violationsOpen;
    violationsPanel.classList.toggle("open", violationsOpen);
    violationsToggle.classList.toggle("active", violationsOpen);
  });

  function formatViolationTime(timestamp) {
    const d = new Date(timestamp);
    return d.toLocaleTimeString("en-US", {
      hour12: true,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function addViolationRow(violation, prepend = false, animate = false) {
    violationsEmpty.style.display = "none";
    const tr = document.createElement("tr");
    if (animate) tr.classList.add("violation-new");

    const tdTime = document.createElement("td");
    tdTime.textContent = formatViolationTime(violation.timestamp);

    const tdPlate = document.createElement("td");
    tdPlate.textContent = violation.car_plate;

    const tdSpeed = document.createElement("td");
    tdSpeed.classList.add("speed-cell");
    tdSpeed.textContent = `${Math.round(violation.car_speed)} km/h`;

    tr.appendChild(tdTime);
    tr.appendChild(tdPlate);
    tr.appendChild(tdSpeed);

    if (prepend) {
      violationsTbody.prepend(tr);
    } else {
      violationsTbody.appendChild(tr);
    }
  }

  async function loadViolations() {
    try {
      const res = await fetch(`/project/${projectId}/violations`, {
        headers: { "x-api-key": apiKey },
      });
      const violations = await res.json();
      if (violations.length === 0) {
        violationsEmpty.style.display = "";
      } else {
        violationsEmpty.style.display = "none";
        for (const v of violations) {
          addViolationRow(v);
        }
      }
    } catch (err) {
      console.error("Error loading violations:", err);
    }
  }

  // --- Node Flash ---
  function flashNode(idInProject) {
    nodeFlashes[idInProject] = { alpha: 1.0 };
    const interval = setInterval(() => {
      const flash = nodeFlashes[idInProject];
      if (!flash || flash.alpha <= 0) {
        clearInterval(interval);
        delete nodeFlashes[idInProject];
        draw();
        return;
      }
      flash.alpha -= 0.02;
      draw();
    }, 30);
  }

  // --- Data Loading ---
  async function loadProjectData() {
    const headers = { "x-api-key": apiKey };

    const [nodesRes, connsRes] = await Promise.all([
      fetch(`/project/${projectId}/nodes`, { headers }),
      fetch(`/project/${projectId}/connections`, { headers }),
    ]);

    nodes = await nodesRes.json();
    connections = await connsRes.json();
    draw();
  }

  // --- Socket.IO ---
  const socket = io();

  socket.on("connect", () => {
    console.log("🔌 Connected to server");
    socket.emit("join-project", { apiKey });
  });

  socket.on("joined", (data) => {
    console.log(`🏠 Joined project ${data.project_id}`);
  });

  socket.on("node-added", (data) => {
    if (!getNodeById(data.node_id)) {
      nodes.push({
        node_id: data.node_id,
        id_in_project: data.id_in_project,
        x_coord: data.x_coord,
        y_coord: data.y_coord,
      });
      draw();
    }
  });

  socket.on("connection-added", (data) => {
    if (!connections.find((c) => c.connection_id === data.connection_id)) {
      connections.push({
        connection_id: data.connection_id,
        from_node_id: data.from_node_id,
        to_node_id: data.to_node_id,
        distance: data.distance,
        speed_limit: data.speed_limit,
      });
      draw();
    }
  });

  socket.on("connection-updated", (data) => {
    const conn = connections.find(
      (c) => c.connection_id === data.connection_id,
    );
    if (conn) {
      conn.distance = data.distance;
      conn.speed_limit = data.speed_limit;
      draw();
    }
  });

  socket.on("node-triggered", (data) => {
    const idInProject = data.id_in_project;
    if (idInProject !== undefined) {
      flashNode(idInProject);
    }
  });

  socket.on("violation-added", (data) => {
    addViolationRow(data, true, true);
  });

  socket.on("error", (data) => {
    console.error("Socket error:", data.message);
  });

  socket.on("congestion-update", (data) => {
    for (const [connId, cValue] of Object.entries(data)) {
      congestionTarget[connId] = cValue;
    }
  });

  socket.on("distance-driver-status", (data) => {
    distanceDriverConnected = data.connected;
    console.log(
      `🔗 Distance driver ${distanceDriverConnected ? "connected" : "disconnected"}`,
    );
    // Update any currently open editor panels
    editDistance.disabled = distanceDriverConnected;
    newConnDistance.disabled = distanceDriverConnected;
    if (distanceDriverConnected) {
      newConnDistance.placeholder = "Calculated by driver";
    } else {
      newConnDistance.placeholder = "100";
    }
  });

  // --- Congestion Smooth Lerp Loop ---
  function lerpCongestion() {
    let changed = false;
    for (const connId of Object.keys(congestionTarget)) {
      const target = congestionTarget[connId];
      const current = congestionDisplay[connId];
      if (current === undefined) {
        congestionDisplay[connId] = target;
        changed = true;
      } else if (Math.abs(current - target) > 0.005) {
        congestionDisplay[connId] = current + (target - current) * 0.12;
        changed = true;
      }
    }
    if (changed) draw();
    requestAnimationFrame(lerpCongestion);
  }
  requestAnimationFrame(lerpCongestion);

  // --- Settings Panel Logic ---
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");
  const settingsClose = document.getElementById("settings-close");
  const copyApiKeyBtn = document.getElementById("copy-api-key");
  const apiKeyInput = document.getElementById("api-key-input");
  const scaleSlider = document.getElementById("scale-slider");
  const scaleVal = document.getElementById("scale-val");

  // Populate API Key
  if (apiKeyInput) apiKeyInput.value = apiKey;

  if (settingsToggle) {
    settingsToggle.addEventListener("click", () => {
      settingsPanel.classList.toggle("open");
      settingsToggle.classList.toggle("active");
    });
  }

  if (settingsClose) {
    settingsClose.addEventListener("click", () => {
      settingsPanel.classList.remove("open");
      settingsToggle.classList.remove("active");
    });
  }

  if (copyApiKeyBtn) {
    copyApiKeyBtn.addEventListener("click", () => {
      apiKeyInput.select();
      apiKeyInput.setSelectionRange(0, 99999); // For mobile devices
      navigator.clipboard.writeText(apiKeyInput.value);
    });
  }

  if (scaleSlider) {
    scaleSlider.addEventListener("input", (e) => {
      settingsScale = parseFloat(e.target.value);
      if (scaleVal) scaleVal.textContent = settingsScale.toFixed(1);
      draw();
    });
  }

  // --- Init ---
  loadProjectData();
  loadViolations();
})();
