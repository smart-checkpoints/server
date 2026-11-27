"use strict";

/**
 * Resets the demo project and seeds it for one recording scenario, so every
 * take starts from the same state.
 *
 *   npm run demo:1    empty project            (scenario 1: build a network)
 *   npm run demo:2    network with a week of history (scenario 2: move a camera)
 *   npm run demo:3    the same network          (scenario 3: violations this week)
 *
 * Needs the server running (the seed goes through its REST API) and
 * DEMO_API_KEY in .env: the operator key of the project to reset. Run with no
 * key and it creates a demo project and prints the line to add.
 *
 * The reset deletes the project's checkpoints, edges, sightings and
 * violations directly in SQLite. The API deliberately cannot do this: no
 * endpoint deletes a violation, and an edge with violations linked to it
 * cannot be deleted. It keeps the project, its keys, its map driver approval
 * and the agent's audit log. It also restarts camera numbering at 0, which
 * nothing else ever does: this is a demo project being wiped whole, so no
 * camera in the field can still hold one of its numbers.
 *
 * Everything after the reset goes through
 * the REST API like any other client: checkpoints and edges are created over
 * it, and violations exist only because sightings were replayed through
 * POST /report-checkpoint, the real enforcement path. No violation row is
 * ever written here.
 *
 * Open consoles do not see a reset; reload the page after running this.
 *
 * Options: --key <operator key>, --base <server url>.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env"), quiet: true });
const sqlite = require("sqlite3");

const DB_PATH = path.join(__dirname, "..", "..", "database.db");

/* -------------------------------------------------------------------------
   The seeded network: nine cameras on the three demo streets, connected in
   the legal direction of travel. Positions are from places.json; distances
   are what OSRM measured between them on 2026-11-27, given here so a seed
   never waits on a routing service. A distance driver that connects later
   re-measures them (and adds road shapes) without changing the numbers.
   ------------------------------------------------------------------------- */

const CAMERAS = [
  // camera 0-2: El Geish Road (the Corniche), eastbound carriageway
  { key: "corniche_west", latitude: 31.206547, longitude: 29.905591 },
  { key: "bibliotheca", latitude: 31.209634, longitude: 29.908982 },
  { key: "shatby", latitude: 31.212997, longitude: 29.918001 },
  // camera 3-5: Fouad Street / El Horreya Road, one-way westbound
  { key: "fouad_museum", latitude: 31.200563, longitude: 29.91312 },
  { key: "fouad_mid", latitude: 31.198647, longitude: 29.908112 },
  { key: "fouad_west", latitude: 31.196263, longitude: 29.901919 },
  // camera 6-8: Abu Qir Street, eastbound carriageway
  { key: "abuqir_west", latitude: 31.214745, longitude: 29.936744 },
  { key: "sidi_gaber", latitude: 31.219246, longitude: 29.941687 },
  { key: "abuqir_east", latitude: 31.223929, longitude: 29.946478 },
];

/**
 * `week` is how many violating trips fall inside the last seven days, `older`
 * how many fall 8-20 days ago, and `legal` how many trips under the limit
 * are spread over the week. The ranking this week is deliberately not the
 * all-time ranking: Fouad's western section had a bad fortnight before this
 * week and a quiet week since, so "this week" has to be read as this week.
 */
const EDGES = [
  { from: "corniche_west", to: "bibliotheca", limit: 60, distance: 507.8, week: 3, older: 2, legal: 6 },
  { from: "bibliotheca", to: "shatby", limit: 60, distance: 955.7, week: 17, older: 4, legal: 8 },
  { from: "fouad_museum", to: "fouad_mid", limit: 40, distance: 522.5, week: 6, older: 3, legal: 6 },
  { from: "fouad_mid", to: "fouad_west", limit: 40, distance: 646.9, week: 0, older: 25, legal: 6 },
  { from: "abuqir_west", to: "sidi_gaber", limit: 50, distance: 686.3, week: 11, older: 3, legal: 7 },
  { from: "sidi_gaber", to: "abuqir_east", limit: 50, distance: 692.5, week: 2, older: 1, legal: 6 },
];

const SCENARIOS = {
  empty: { label: "empty project", network: false },
  network: { label: "network with a week of history", network: true },
};

/* -------------------------------------------------------------------------
   Plumbing
   ------------------------------------------------------------------------- */

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

/** A fixed-seed PRNG, so every seed is the same seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function api(base, key, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(key ? { "x-api-key": key } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${data && data.error ? data.error : ""}`);
  return data;
}

function resetProject(projectId) {
  if (!Number.isInteger(projectId)) throw new Error("project id is not an integer");
  const db = new sqlite.Database(DB_PATH);
  const sql = `
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    DELETE FROM traversals WHERE connection_id IN (SELECT connection_id FROM connections WHERE project_id = ${projectId});
    DELETE FROM violations WHERE project_id = ${projectId};
    DELETE FROM car_data WHERE project_id = ${projectId};
    DELETE FROM connections WHERE project_id = ${projectId};
    DELETE FROM nodes WHERE project_id = ${projectId};
    UPDATE projects SET node_count = 0, connection_count = 0, next_id_in_project = 0 WHERE project_id = ${projectId};
    COMMIT;`;
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      db.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

/* -------------------------------------------------------------------------
   Seeding
   ------------------------------------------------------------------------- */

async function seedNetwork(base, key, projectId) {
  // Sequential, so camera numbers come out 0-8 in the order above.
  const cameraOf = {};
  for (const camera of CAMERAS) {
    const created = await api(base, key, "POST", "/create-node", {
      latitude: camera.latitude,
      longitude: camera.longitude,
    });
    cameraOf[camera.key] = created;
  }
  for (const edge of EDGES) {
    await api(base, key, "POST", "/create-connection", {
      "from-node-id": cameraOf[edge.from].node_id,
      "to-node-id": cameraOf[edge.to].node_id,
      "speed-limit": edge.limit,
      distance: edge.distance,
    });
  }

  // Trips, as a camera at each end would report them. One plate per trip,
  // so no two trips share a car and the order they are sent in cannot
  // matter. Plates are salted with the project id: car records are looked
  // up by plate, and two seeded projects must not share cars.
  const random = mulberry32(20261127);
  const now = Date.now();
  const hour = 3600000;
  const day = 24 * hour;
  const trips = [];
  let serial = 0;
  const plate = () => {
    serial += 1;
    const letters = "ABDEFGHKLMNRSTUWY";
    const pick = () => letters[Math.floor(random() * letters.length)];
    const number = ((projectId * 7919 + serial * 131) % 9000) + 1000;
    return `${pick()}${pick()}${pick()} ${number}`;
  };

  for (const edge of EDGES) {
    const add = (count, fromMs, toMs, speeding) => {
      for (let i = 0; i < count; i += 1) {
        const kmh = speeding ? edge.limit + 8 + random() * 34 : edge.limit - 4 - random() * 14;
        const seconds = edge.distance / (kmh / 3.6);
        const start = fromMs + random() * (toMs - fromMs);
        trips.push({ edge, plate: plate(), start, end: start + seconds * 1000 });
      }
    };
    add(edge.week, now - 7 * day + 2 * hour, now - hour, true);
    add(edge.older, now - 20 * day, now - 8 * day, true);
    add(edge.legal, now - 7 * day + 2 * hour, now - hour, false);
  }

  for (const trip of trips) {
    const a = cameraOf[trip.edge.from].id_in_project;
    const b = cameraOf[trip.edge.to].id_in_project;
    await api(base, key, "POST", "/report-checkpoint", {
      "car-plate": trip.plate,
      "id-in-project": a,
      timestamp: new Date(trip.start).toISOString(),
    });
    await api(base, key, "POST", "/report-checkpoint", {
      "car-plate": trip.plate,
      "id-in-project": b,
      timestamp: new Date(trip.end).toISOString(),
    });
  }
  return trips.length;
}

async function summarise(base, key, projectId) {
  const [nodes, edges, violations] = await Promise.all([
    api(base, key, "GET", `/project/${projectId}/nodes`),
    api(base, key, "GET", `/project/${projectId}/connections`),
    api(base, key, "GET", `/project/${projectId}/violations`),
  ]);
  const camera = new Map(nodes.map((n) => [n.node_id, n.id_in_project]));
  const weekStart = Date.now() - 7 * 24 * 3600000;
  console.log(`  ${nodes.length} cameras, ${edges.length} edges, ${violations.length} violations recorded`);
  for (const edge of edges) {
    const all = violations.filter((v) => v.connection_id === edge.connection_id);
    const week = all.filter((v) => new Date(v.timestamp).getTime() >= weekStart);
    console.log(
      `  camera ${camera.get(edge.from_node_id)} -> ${camera.get(edge.to_node_id)}: ` +
        `${edge.speed_limit} km/h, ${Math.round(edge.distance)} m, ` +
        `${week.length} violations this week, ${all.length} in all`,
    );
  }
}

(async () => {
  const which = process.argv[2];
  const scenario = SCENARIOS[which];
  if (!scenario) {
    console.error("usage: node agent/demo/seed.js <empty|network> [--key KEY] [--base URL]");
    process.exit(2);
  }
  const base = (arg("base") || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
  const key = arg("key") || process.env.DEMO_API_KEY;

  if (!key) {
    const created = await api(base, null, "POST", "/create-project", { "project-name": "Sayes demo" });
    console.log(`Created project ${created.project_id}, "Sayes demo". Add this line to server/.env and run again:`);
    console.log(`\n  DEMO_API_KEY=${created.api_key}\n`);
    console.log("Start the distance driver with the same key (SC_API_KEY in driver-osrm/.env).");
    process.exit(1);
  }

  const project = await api(base, null, "POST", "/authenticate", { "api-key": key });
  const started = Date.now();
  console.log(`Resetting project ${project.project_id} "${project.project_name}" to: ${scenario.label}`);
  await resetProject(project.project_id);

  if (scenario.network) {
    const trips = await seedNetwork(base, key, project.project_id);
    console.log(`  replayed ${trips} trips through POST /report-checkpoint`);
  }
  await summarise(base, key, project.project_id);

  const driver = await api(base, key, "GET", `/project/${project.project_id}/distance-driver-status`);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s. Reload the console page before recording.`);
  if (!driver.connected) {
    console.log("Note: no distance driver is connected to this project; new edges will not be measured.");
  }
})().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  if (/ECONNREFUSED|fetch failed/.test(err.message)) console.error("Is the server running?");
  process.exit(1);
});
