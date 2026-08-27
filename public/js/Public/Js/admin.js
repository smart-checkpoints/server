// ==============================
// Smart Checkpoints — Admin
// ==============================

const passwordInput = document.getElementById("admin-password");
const loginBtn = document.getElementById("admin-login");
const adminError = document.getElementById("admin-error");
const passwordGate = document.getElementById("password-gate");
const adminDashboard = document.getElementById("admin-dashboard");
const adminTbody = document.getElementById("admin-tbody");
const projectCount = document.getElementById("project-count");

let adminPassword = "";

// --- Login ---
loginBtn.addEventListener("click", async () => {
  const password = passwordInput.value.trim();
  if (!password) return;

  try {
    const res = await fetch("/admin/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      adminError.classList.remove("hidden");
      return;
    }

    adminPassword = password;
    adminError.classList.add("hidden");
    passwordGate.classList.add("hidden");
    adminDashboard.classList.remove("hidden");
    loadProjects();
  } catch (err) {
    adminError.classList.remove("hidden");
  }
});

passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});

// --- Load Projects ---
async function loadProjects() {
  try {
    const res = await fetch("/admin/projects", {
      headers: { "x-admin-password": adminPassword },
    });
    const projects = await res.json();

    projectCount.textContent = `${projects.length} project${projects.length !== 1 ? "s" : ""}`;
    adminTbody.innerHTML = "";

    for (const p of projects) {
      const tr = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = p.project_id;

      const tdName = document.createElement("td");
      tdName.textContent = p.project_name;

      const tdKey = document.createElement("td");
      tdKey.classList.add("api-key-cell");
      tdKey.textContent = p.api_key;
      tdKey.title = p.api_key;

      const tdNodes = document.createElement("td");
      tdNodes.textContent = p.node_count || 0;

      const tdConns = document.createElement("td");
      tdConns.textContent = p.connection_count || 0;

      const tdAction = document.createElement("td");
      const copyBtn = document.createElement("button");
      copyBtn.classList.add("copy-btn");
      copyBtn.textContent = "Copy Key";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(p.api_key);
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy Key";
          copyBtn.classList.remove("copied");
        }, 1500);
      });
      tdAction.appendChild(copyBtn);

      tr.appendChild(tdId);
      tr.appendChild(tdName);
      tr.appendChild(tdKey);
      tr.appendChild(tdNodes);
      tr.appendChild(tdConns);
      tr.appendChild(tdAction);

      adminTbody.appendChild(tr);
    }
  } catch (err) {
    console.error("Error loading projects:", err);
  }
}
