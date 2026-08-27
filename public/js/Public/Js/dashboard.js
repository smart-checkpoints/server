const projectsGrid = document.getElementById("projects-grid");

// Modal elements
const apiKeyModal = document.getElementById("api-key-modal");
const apiKeyInput = document.getElementById("api-key-input");
const apiKeySubmit = document.getElementById("api-key-submit");
const apiKeyError = document.getElementById("api-key-error");
const apiModalClose = document.getElementById("api-modal-close");

const newProjectModal = document.getElementById("new-project-modal");
const newProjectName = document.getElementById("new-project-name");
const newProjectSubmit = document.getElementById("new-project-submit");
const newModalClose = document.getElementById("new-modal-close");
const apiKeyReveal = document.getElementById("api-key-reveal");
const apiKeyDisplay = document.getElementById("api-key-display");
const apiKeyCopy = document.getElementById("api-key-copy");

let selectedProjectId = null;

// --- Fetch projects ---
async function fetchProjects() {
  try {
    const response = await fetch("/list-projects");
    return await response.json();
  } catch (error) {
    console.error("Error fetching projects:", error);
    return [];
  }
}

// --- Fetch thumbnail data for a project ---
async function fetchThumbnailData(projectId) {
  try {
    const res = await fetch(`/project/${projectId}/thumbnail-data`);
    return await res.json();
  } catch (err) {
    return { nodes: [], connections: [] };
  }
}

// --- Draw mini thumbnail with real data ---
function drawThumbnail(canvas, thumbData) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const { nodes, connections } = thumbData;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#d9d9d9";
  ctx.fillRect(0, 0, w, h);

  if (nodes.length === 0) {
    // Empty placeholder
    ctx.fillStyle = "rgba(25, 196, 216, 0.1)";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(25, 196, 216, 0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
    return;
  }

  // Calculate bounding box of all nodes
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }

  const padding = 35;
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scaleX = (w - padding * 2) / rangeX;
  const scaleY = (h - padding * 2) / rangeY;
  const scale = Math.min(scaleX, scaleY);

  // Center the content
  const scaledWidth = rangeX * scale;
  const scaledHeight = rangeY * scale;
  const offsetX = (w - scaledWidth) / 2;
  const offsetY = (h - scaledHeight) / 2;

  function toScreen(x, y) {
    return {
      sx: offsetX + (x - minX) * scale,
      sy: offsetY + (y - minY) * scale,
    };
  }

  // Build id->screenPos map
  const nodeMap = {};
  for (const n of nodes) {
    const pos = toScreen(n.x, n.y);
    nodeMap[n.id] = pos;
  }

  // Draw connections
  const connColors = ["#4ecb71", "#e74c5e", "#f7c948", "#19c4d8", "#a87fff", "#ff8a5c"];
  for (let i = 0; i < connections.length; i++) {
    const conn = connections[i];
    const from = nodeMap[conn.from];
    const to = nodeMap[conn.to];
    if (!from || !to) continue;

    const dx = to.sx - from.sx;
    const dy = to.sy - from.sy;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;

    const ux = dx / len;
    const uy = dy / len;
    const nodeR = 8;

    ctx.beginPath();
    ctx.moveTo(from.sx + ux * nodeR, from.sy + uy * nodeR);
    ctx.lineTo(to.sx - ux * nodeR, to.sy - uy * nodeR);
    ctx.strokeStyle = connColors[i % connColors.length];
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.stroke();

    // Tiny arrowhead
    const arrowSize = 5;
    const tipX = to.sx - ux * nodeR;
    const tipY = to.sy - uy * nodeR;
    const baseX = tipX - ux * arrowSize;
    const baseY = tipY - uy * arrowSize;
    const perpX = -uy;
    const perpY = ux;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX + perpX * 2.5, baseY + perpY * 2.5);
    ctx.lineTo(baseX - perpX * 2.5, baseY - perpY * 2.5);
    ctx.closePath();
    ctx.fillStyle = connColors[i % connColors.length];
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Draw nodes
  for (const n of nodes) {
    const pos = nodeMap[n.id];
    const nodeR = 8;

    ctx.beginPath();
    ctx.arc(pos.sx, pos.sy, nodeR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#19c4d8";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#19c4d8";
    ctx.font = "bold 7px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(n.id, pos.sx, pos.sy);
  }
}

// --- Render cards ---
async function renderProjects(projects) {
  projectsGrid.innerHTML = "";

  for (const project of projects) {
    const card = document.createElement("div");
    card.classList.add("project-card");
    card.dataset.projectId = project.project_id;

    // Thumbnail
    const thumb = document.createElement("div");
    thumb.classList.add("card-thumbnail");
    const canvas = document.createElement("canvas");
    canvas.width = 280;
    canvas.height = 170;
    thumb.appendChild(canvas);
    card.appendChild(thumb);

    // Fetch real thumbnail data
    fetchThumbnailData(project.project_id).then((data) => {
      drawThumbnail(canvas, data);
    });

    // Info bar
    const info = document.createElement("div");
    info.classList.add("card-info");

    const title = document.createElement("span");
    title.classList.add("card-title");
    title.textContent = project.project_name;

    const legend = document.createElement("span");
    legend.classList.add("card-legend");
    const nc = project.node_count || 0;
    const cc = project.connection_count || 0;
    legend.textContent = `${nc} node${nc !== 1 ? "s" : ""}, ${cc} connection${cc !== 1 ? "s" : ""}`;

    info.appendChild(title);
    info.appendChild(legend);
    card.appendChild(info);

    // Click to open
    card.addEventListener("click", () => {
      selectedProjectId = project.project_id;
      apiKeyError.classList.add("hidden");
      apiKeyInput.value = "";
      apiKeyModal.classList.remove("hidden");
      setTimeout(() => apiKeyInput.focus(), 50);
    });

    projectsGrid.appendChild(card);
  }

  // New project card
  const newCard = document.createElement("div");
  newCard.classList.add("new-project-card");
  newCard.innerHTML = `
    <div class="new-project-icon">+</div>
    <span class="new-project-label">New Project</span>
  `;
  newCard.addEventListener("click", () => {
    newProjectName.value = "";
    apiKeyReveal.classList.add("hidden");
    newProjectModal.classList.remove("hidden");
    setTimeout(() => newProjectName.focus(), 50);
  });
  projectsGrid.appendChild(newCard);
}

// --- API Key Modal ---
apiKeySubmit.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  try {
    const res = await fetch("/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "api-key": key }),
    });

    if (!res.ok) {
      apiKeyError.classList.remove("hidden");
      return;
    }

    const data = await res.json();
    // Navigate to project canvas
    window.location.href = `/project?id=${data.project_id}&key=${encodeURIComponent(key)}`;
  } catch (err) {
    apiKeyError.classList.remove("hidden");
  }
});

apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") apiKeySubmit.click();
});

apiModalClose.addEventListener("click", () => {
  apiKeyModal.classList.add("hidden");
});

apiKeyModal.addEventListener("click", (e) => {
  if (e.target === apiKeyModal) apiKeyModal.classList.add("hidden");
});

// --- New Project Modal ---
newProjectSubmit.addEventListener("click", async () => {
  const name = newProjectName.value.trim();
  if (!name) return;

  try {
    const res = await fetch("/create-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "project-name": name }),
    });
    const data = await res.json();

    // Show API key
    apiKeyDisplay.textContent = data.api_key;
    apiKeyReveal.classList.remove("hidden");
    newProjectSubmit.style.display = "none";
    newProjectName.style.display = "none";

    // Refresh project list
    const projects = await fetchProjects();
    renderProjects(projects);
  } catch (err) {
    console.error("Error creating project:", err);
  }
});

newProjectName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") newProjectSubmit.click();
});

newModalClose.addEventListener("click", () => {
  newProjectModal.classList.add("hidden");
  newProjectSubmit.style.display = "";
  newProjectName.style.display = "";
});

newProjectModal.addEventListener("click", (e) => {
  if (e.target === newProjectModal) {
    newProjectModal.classList.add("hidden");
    newProjectSubmit.style.display = "";
    newProjectName.style.display = "";
  }
});

apiKeyCopy.addEventListener("click", () => {
  navigator.clipboard.writeText(apiKeyDisplay.textContent);
  apiKeyCopy.textContent = "Copied!";
  setTimeout(() => (apiKeyCopy.textContent = "Copy"), 1500);
});

// --- Init ---
const projects = await fetchProjects();
renderProjects(projects);
