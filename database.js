const sqlite = require("sqlite3");
const { makeProjection } = require("./geo.js");

/**
 * What `connections.distance` is actually worth.
 *
 * The column used to answer this with the number alone, and `0` meant two
 * different things: an edge nobody had routed yet, and an edge whose driver
 * had failed. Both produced a maximum traversal time of zero, so the
 * comparison every violation is decided by was false for every car and the
 * road silently stopped enforcing anything - not because someone decided it
 * should, but as a side effect of dividing by the placeholder.
 *
 * Distance is NULL whenever the status is not `ok`. Nothing writes 0 as a
 * placeholder any more.
 */
const DISTANCE_STATUS = {
  /** A driver routed it, or an operator typed it. Violations run normally. */
  OK: "ok",
  /** Nobody has answered yet, or a driver failed transiently. Not enforced. */
  UNKNOWN: "unknown",
  /** A driver said definitively there is no road here. Not enforced; a data error. */
  NO_ROUTE: "no-route",
};

const DISTANCE_STATUSES = new Set(Object.values(DISTANCE_STATUS));

/**
 * The only wire format route geometry has: a GeoJSON LineString in WGS84,
 * coordinates as [longitude, latitude] pairs, longitude first.
 *
 * Stored beside the geometry so a row read years from now says what it holds,
 * not so a second format can be added. There is no second format - a driver
 * emits this or emits nothing.
 */
const PATH_FORMAT = "geojson-linestring-wgs84";

/**
 * Whether this project has a map view, and whether anyone agreed to it.
 *
 * A map driver announces the address of its own UI when it authenticates, and
 * that address is put in an iframe inside the console's own chrome. Whoever
 * holds the project API key would otherwise choose what renders there: a
 * cross-origin frame cannot read the parent, but it is handed every piece of
 * project state and can paint a convincing fake console around it.
 *
 * So an announced address is only ever a proposal. It sits in
 * `pending_map_driver_url` until an operator approves it, and only an
 * approved one is ever embedded.
 */
const MAP_DRIVER_STATUS = {
  /** Nothing has been announced, or approval was withdrawn. No map view. */
  NONE: "none",
  /** A driver named an address nobody has agreed to yet. Not embedded. */
  PENDING: "pending",
  /** An operator approved this exact address. The only status that renders. */
  APPROVED: "approved",
};

function createDatabase(path = "server/database.db") {
  const db = new sqlite.Database(path);
  // Enable WAL mode for better concurrency under high write load
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Renames the legacy `nodes.x_coord` / `nodes.y_coord` columns to
 * `longitude` / `latitude`. The existing mapping was x = longitude and
 * y = latitude, so the rename preserves meaning without swapping values.
 *
 * Idempotent: a database already carrying the new names is left alone. Unlike
 * the other migrations in this file it does NOT swallow errors: a
 * half-renamed nodes table means every coordinate read is silently wrong, so
 * it must stop startup rather than run on.
 */
function migrateNodeCoordinateColumns(db) {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(nodes)", (err, columns) => {
      if (err) return reject(err);

      const names = new Set((columns || []).map((c) => c.name));
      const hasOldLng = names.has("x_coord");
      const hasOldLat = names.has("y_coord");
      const hasNewLng = names.has("longitude");
      const hasNewLat = names.has("latitude");

      if (hasNewLng && hasNewLat && !hasOldLng && !hasOldLat) {
        return resolve(false); // already migrated
      }

      if (hasOldLng !== hasOldLat || hasNewLng !== hasNewLat) {
        return reject(
          new Error(
            "nodes table is half-renamed: found columns " +
              `[${[...names].join(", ")}]. Expected either ` +
              "(x_coord, y_coord) or (longitude, latitude). Refusing to start " +
              "Fix the schema by hand before serving coordinate data.",
          ),
        );
      }

      if (!hasOldLng && !hasOldLat) {
        return reject(
          new Error(
            "nodes table has no coordinate columns at all: found " +
              `[${[...names].join(", ")}]. Refusing to start.`,
          ),
        );
      }

      db.run("ALTER TABLE nodes RENAME COLUMN x_coord TO longitude", (e1) => {
        if (e1) return reject(e1);
        db.run("ALTER TABLE nodes RENAME COLUMN y_coord TO latitude", (e2) => {
          if (e2) return reject(e2);
          console.log(
            "🗺️  Migrated nodes.x_coord -> longitude, nodes.y_coord -> latitude",
          );
          resolve(true);
        });
      });
    });
  });
}

/**
 * Adds `distance_status` and `distance_updated_at` to `connections`, and
 * resolves the ambiguous zeros already sitting in the distance column.
 *
 * A stored distance above zero is a real answer, from a driver or from an
 * operator, so it keeps enforcing. Everything else is the old placeholder: it
 * becomes an explicit "nobody has resolved this", with the distance nulled, and
 * is recalculated the next time a driver connects.
 *
 * The backfill is guarded on the column being absent so it runs exactly once.
 * A second pass would read a `no-route` row - legitimately NULL - as an
 * unresolved zero and throw away what a driver definitively answered.
 */
function migrateDistanceStatus(db) {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(connections)", (err, columns) => {
      if (err) return reject(err);

      const names = new Set((columns || []).map((c) => c.name));
      const needsStatus = !names.has("distance_status");
      const needsTimestamp = !names.has("distance_updated_at");
      if (!needsStatus && !needsTimestamp) return resolve(false);

      const steps = [];
      if (needsStatus) {
        steps.push(
          "ALTER TABLE connections ADD COLUMN distance_status TEXT " +
            `DEFAULT '${DISTANCE_STATUS.UNKNOWN}'`,
        );
      }
      if (needsTimestamp) {
        steps.push(
          "ALTER TABLE connections ADD COLUMN distance_updated_at INTEGER",
        );
      }
      if (needsStatus) {
        steps.push(
          `UPDATE connections SET distance_status = '${DISTANCE_STATUS.OK}' ` +
            "WHERE distance IS NOT NULL AND distance > 0",
        );
        steps.push(
          `UPDATE connections SET distance_status = '${DISTANCE_STATUS.UNKNOWN}', ` +
            "distance = NULL WHERE distance IS NULL OR distance <= 0",
        );
      }

      // Sequential rather than db.serialize: a failure here has to reject and
      // stop startup, the same way the coordinate rename does. Serving
      // enforcement off a half-migrated table is worse than not starting.
      const run = (index) => {
        if (index >= steps.length) {
          if (needsStatus) {
            console.log(
              "📏 Migrated connections: distance_status added, placeholder " +
                "zeros are now explicitly unresolved",
            );
          }
          return resolve(true);
        }
        db.run(steps[index], (stepErr) => {
          if (stepErr) return reject(stepErr);
          run(index + 1);
        });
      };
      run(0);
    });
  });
}

/**
 * Adds columns to a table that does not have them yet, in order, stopping
 * startup if any of it fails.
 *
 * SQLite has no ADD COLUMN IF NOT EXISTS, and the older migrations in this
 * file swallow the duplicate-column error instead - which also swallows a real
 * failure. Asking the table what it already has costs one PRAGMA and lets the
 * error mean something.
 */
function addMissingColumns(db, table, columns) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, existing) => {
      if (err) return reject(err);

      const names = new Set((existing || []).map((c) => c.name));
      const missing = columns.filter(([name]) => !names.has(name));
      if (missing.length === 0) return resolve(false);

      const run = (index) => {
        if (index >= missing.length) {
          console.log(
            `🗺️  Migrated ${table}: added ` +
              missing.map(([name]) => name).join(", "),
          );
          return resolve(true);
        }
        const [name, type] = missing[index];
        db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`, (stepErr) =>
          stepErr ? reject(stepErr) : run(index + 1),
        );
      };
      run(0);
    });
  });
}

/**
 * Adds what a driver result carries beyond the distance: the route geometry,
 * the format it is in, and how far each requested coordinate was from the road
 * network the driver actually routed on.
 *
 * No backfill, because there is nothing to convert. An edge resolved before
 * protocol v2 has no geometry until a driver answers for it again.
 */
function migrateRouteGeometry(db) {
  return addMissingColumns(db, "connections", [
    ["path", "TEXT"],
    ["path_format", "TEXT"],
    ["endpoint_offsets", "TEXT"],
  ]);
}

/**
 * Adds the fingerprint of the two positions a stored distance was measured
 * between, so a driver can be asked only about the edges that have changed.
 *
 * No backfill: an existing row has a distance and no record of where its
 * endpoints were when that distance was worked out, and inventing one would
 * assert something nobody checked. A NULL hash reads as "moved", so every
 * pre-existing edge is recalculated once - and only once, because that pass
 * writes the hashes.
 */
function migrateEndpointsHash(db) {
  return addMissingColumns(db, "connections", [["endpoints_hash", "TEXT"]]);
}

/**
 * Adds where a project's map view lives, and whether it was approved.
 *
 * Four columns rather than one because the announced address and the approved
 * address are different facts: a driver that reconnects on a new port has
 * announced something, and what it announced must not become what gets
 * embedded until somebody says so. Existing projects get status `none`, which
 * is exactly right - they have never had a map driver.
 */
function migrateMapDriver(db) {
  return addMissingColumns(db, "projects", [
    ["map_driver_url", "TEXT"],
    ["map_driver_origin", "TEXT"],
    ["map_driver_status", `TEXT DEFAULT '${MAP_DRIVER_STATUS.NONE}'`],
    ["pending_map_driver_url", "TEXT"],
  ]);
}

/**
 * Adds the edge a violation was measured on.
 *
 * No backfill. A violation row never recorded which edge it came from, and
 * reconstructing it from sightings would be a guess presented as a fact. Old
 * rows stay NULL; every violation recorded from here on carries its edge.
 */
function migrateViolationConnection(db) {
  return addMissingColumns(db, "violations", [["connection_id", "INTEGER"]]);
}

/**
 * Adds the demo flag. A demo project lets an operator drive a test car
 * between checkpoints from the console; the sightings that drive produces go
 * through `/report-checkpoint` like any camera's, so the flag changes what the
 * console offers and nothing about how a violation is decided.
 */
function migrateDemoFlag(db) {
  return addMissingColumns(db, "projects", [["is_demo", "INTEGER DEFAULT 0"]]);
}

/**
 * Adds the per-project camera counter.
 *
 * `id_in_project` is the number every camera reports by, so a number that has
 * ever been given out must never be given out again: a camera still in the
 * field with a deleted checkpoint's number would otherwise start reporting
 * into whatever new checkpoint inherited it. MAX+1 reuses the top number the
 * moment the highest checkpoint is deleted; a counter that only goes up does
 * not. Existing projects start counting after the highest number they hold.
 */
function migrateCameraCounter(db) {
  return addMissingColumns(db, "projects", [["next_id_in_project", "INTEGER"]]).then(
    () =>
      new Promise((resolve, reject) => {
        db.run(
          "UPDATE projects SET next_id_in_project = COALESCE(" +
            "(SELECT MAX(id_in_project) + 1 FROM nodes WHERE nodes.project_id = projects.project_id), 0) " +
            "WHERE next_id_in_project IS NULL",
          (err) => (err ? reject(err) : resolve()),
        );
      }),
  );
}

/**
 * Retired checkpoints and edges: taken out of the network (no reads, no
 * enforcement) without deleting them, because violations are linked to them
 * and violations are records. NULL means in service.
 */
function migrateRetired(db) {
  return addMissingColumns(db, "nodes", [["retired_at", "TEXT"]]).then(() =>
    addMissingColumns(db, "connections", [["retired_at", "TEXT"]]),
  );
}

function initializeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      createTables(db);
      // Coordinate rename runs last so the CREATE TABLE statements above have
      // already settled, and its failure rejects rather than being swallowed.
      db.run("SELECT 1", (err) => {
        if (err) return reject(err);
        migrateNodeCoordinateColumns(db)
          .then(() => migrateDistanceStatus(db))
          .then(() => migrateRouteGeometry(db))
          .then(() => migrateEndpointsHash(db))
          .then(() => migrateMapDriver(db))
          .then(() => migrateViolationConnection(db))
          .then(() => migrateDemoFlag(db))
          .then(() => migrateCameraCounter(db))
          .then(() => migrateRetired(db))
          .then(() => resolve(), reject);
      });
    });
  });
}

/**
 * Every timestamp written to a TEXT column goes through here.
 *
 * One format across the whole system: ISO 8601 in UTC. It is what the REST API
 * accepts on the way in, what the realtime events carry on the way out, and it
 * sorts lexicographically, which is what lets the traversal window be a plain
 * string comparison in SQL.
 */
function toIsoTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();

  // A string that is already a time is kept; anything unparseable is stamped
  // now rather than written as a value nothing can read back.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
}

function createTables(db) {
  db.run(`CREATE TABLE IF NOT EXISTS projects (
      project_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT,
      api_key TEXT,
      node_count INTEGER DEFAULT 0,
      connection_count INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS nodes (
      node_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      id_in_project INTEGER,
      longitude REAL,
      latitude REAL,
      FOREIGN KEY(project_id) REFERENCES projects(project_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS connections (
      connection_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      from_node_id INTEGER, 
      to_node_id INTEGER,
      distance REAL,
      speed_limit REAL,
      distance_status TEXT DEFAULT 'unknown',
      distance_updated_at INTEGER,
      path TEXT,
      path_format TEXT,
      endpoint_offsets TEXT,
      endpoints_hash TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(project_id),
      FOREIGN KEY(from_node_id) REFERENCES nodes(node_id),
      FOREIGN KEY(to_node_id) REFERENCES nodes(node_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS car_data (
      car_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      car_plate TEXT,
      last_sighting_time INT,
      last_sighting_node_id INTEGER,
      FOREIGN KEY(project_id) REFERENCES projects(project_id),
      FOREIGN KEY(last_sighting_node_id) REFERENCES nodes(node_id)
  )`);

  // `connection_id` is the edge the violation was measured on. Nullable:
  // rows recorded before it existed stay unattributed rather than guessed at.
  db.run(`CREATE TABLE IF NOT EXISTS violations (
      violation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      car_plate TEXT,
      car_speed REAL,
      timestamp TEXT,
      connection_id INTEGER,
      FOREIGN KEY(project_id) REFERENCES projects(project_id),
      FOREIGN KEY(connection_id) REFERENCES connections(connection_id)
  )`);

  // What the Dispatch agent did, and on whose request. Written by the agent
  // module only, never edited, and read back by the console's audit tab.
  db.run(`CREATE TABLE IF NOT EXISTS agent_actions (
      action_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     INTEGER NOT NULL,
      run_id         TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      call_id        TEXT NOT NULL,
      user_request   TEXT NOT NULL,
      tool           TEXT NOT NULL,
      input          TEXT NOT NULL,
      result         TEXT,
      ok             INTEGER,
      api_calls      TEXT,
      confirmation   TEXT,
      started_at     TEXT NOT NULL,
      finished_at    TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(project_id)
  )`);

  // Restore points: the checkpoint network (positions, edges, limits) as it
  // was at a moment, so it can be put back. Never violations or evidence:
  // those are records, and a restore never touches them.
  db.run(`CREATE TABLE IF NOT EXISTS restore_points (
      restore_point_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id       INTEGER NOT NULL,
      name             TEXT NOT NULL,
      origin           TEXT NOT NULL,
      run_id           TEXT,
      snapshot         TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(project_id)
  )`);

  // Migration for existing databases
  db.run(`CREATE TABLE IF NOT EXISTS traversals (
      traversal_id  INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id INTEGER,
      delta_t       REAL,
      timestamp     TEXT,
      FOREIGN KEY(connection_id) REFERENCES connections(connection_id)
  )`);

  // Every credential that is not the project's own operator key.
  //
  // `projects.api_key` stays exactly what it was: the project's operator key,
  // full read and write. This table holds the narrower ones - a key per camera
  // that can only report a sighting - so a key lifted off roadside hardware
  // cannot rewrite the numbers that decide what counts as speeding.
  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
      key_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      api_key    TEXT NOT NULL UNIQUE,
      role       TEXT NOT NULL DEFAULT 'reporter',
      label      TEXT,
      created_at TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(project_id)
  )`);

  // Migration for existing databases
  db.run(
    `ALTER TABLE projects ADD COLUMN node_count INTEGER DEFAULT 0`,
    () => {},
  );
  db.run(
    `ALTER TABLE projects ADD COLUMN connection_count INTEGER DEFAULT 0`,
    () => {},
  );
  db.run(`ALTER TABLE nodes ADD COLUMN id_in_project INTEGER`, () => {});
}

/**
 * Projects `{ id_in_project, latitude, longitude }` rows onto the local
 * tangent plane and rescales them into the unit square, preserving aspect
 * ratio and north-up orientation. Returns `{ id, x, y }` with x/y in [0, 1].
 *
 * Rows with unusable coordinates are dropped rather than poisoning the
 * bounding box with NaN.
 */
function normaliseNodeShape(nodes) {
  const usable = nodes.filter(
    (n) => Number.isFinite(n.latitude) && Number.isFinite(n.longitude),
  );
  if (usable.length === 0) return [];

  const originLat =
    usable.reduce((sum, n) => sum + n.latitude, 0) / usable.length;
  const originLng =
    usable.reduce((sum, n) => sum + n.longitude, 0) / usable.length;
  const projection = makeProjection(originLat, originLng);

  const projected = usable.map((n) => ({
    id: n.id_in_project,
    ...projection.project(n.latitude, n.longitude),
  }));

  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  // One divisor for both axes keeps the drawing proportional; using each
  // axis's own range would stretch the graph to fill the box.
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;

  return projected.map((p) => ({
    id: p.id,
    x: (p.x - minX) / span,
    y: (p.y - minY) / span,
  }));
}

function createPlaceholders(object) {
  return Object.keys(object)
    .map(() => "?")
    .join(", ");
}

function addEntry(tableName = "", entry = {}, db = createDatabase()) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO ${tableName} (${Object.keys(entry).join(", ")}) VALUES (${createPlaceholders(entry)})`,
      Object.values(entry),
      function (err) {
        if (err) {
          console.error("Database Error:", err.message);
          return reject(err);
        }

        console.log(`A row has been inserted with row id ${this.lastID}`);
        resolve(this.lastID);
      },
    );
  });
}

function isCarPlateRegistered(projectId, carPlate, db = createDatabase()) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT * FROM car_data WHERE project_id = ? AND car_plate = ?",
      [projectId, carPlate],
      (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          resolve(true);
        } else {
          resolve(false);
        }
      },
    );
  });
}

function registerCarPlate(projectId, carPlate, db = createDatabase()) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO car_data (project_id, car_plate) VALUES (?, ?)",
      [projectId, carPlate],
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      },
    );
  });
}

function carPlateToCarId(projectId, carPlate, db = createDatabase()) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT * FROM car_data WHERE project_id = ? AND car_plate = ?",
      [projectId, carPlate],
      (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          resolve(row.car_id);
        } else {
          reject(new Error("Car plate not found"));
        }
      },
    );
  });
}

/**
 * The status a row may hold, or `unknown` if it is not one of the three.
 *
 * A status that is not recognised must not fall through to `ok`: an edge whose
 * worth cannot be established is one that must not decide who is speeding.
 */
function normaliseStatus(status) {
  return DISTANCE_STATUSES.has(status) ? status : DISTANCE_STATUS.UNKNOWN;
}

const statements = {
  createProject: async (projectName, apiKey, db, isDemo = false) => {
    return await addEntry(
      "projects",
      { project_name: projectName, api_key: apiKey, is_demo: isDemo ? 1 : 0 },
      db,
    );
  },

  getProjectDemo: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT is_demo FROM projects WHERE project_id = ?",
        [projectId],
        (err, row) => (err ? reject(err) : resolve(Boolean(row?.is_demo))),
      );
    });
  },

  setProjectDemo: (projectId, isDemo, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE projects SET is_demo = ? WHERE project_id = ?",
        [isDemo ? 1 : 0, projectId],
        (err) => (err ? reject(err) : resolve(Boolean(isDemo))),
      );
    });
  },

  getNextIdInProject: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT COALESCE(MAX(id_in_project), -1) as max_id FROM nodes WHERE project_id = ?",
        [projectId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row.max_id + 1);
        },
      );
    });
  },

  /**
   * @param {number} latitude  WGS84 latitude in degrees, +/-90.
   * @param {number} longitude WGS84 longitude in degrees, +/-180.
   */
  createNode: async (projectId, latitude, longitude, db) => {
    // The number comes from the project's counter, taken and advanced in one
    // statement, so two creates arriving together cannot get the same one,
    // and a deleted checkpoint's number is never handed out again.
    const idInProject = await new Promise((resolve, reject) => {
      db.get(
        "UPDATE projects SET next_id_in_project = COALESCE(next_id_in_project, 0) + 1 " +
          "WHERE project_id = ? RETURNING next_id_in_project - 1 AS id",
        [projectId],
        (err, row) => {
          if (err) reject(err);
          else if (!row) reject(new Error(`No project ${projectId}`));
          else resolve(row.id);
        },
      );
    });
    const nodeId = await addEntry(
      "nodes",
      { project_id: projectId, id_in_project: idInProject, latitude, longitude },
      db,
    );
    // Update node count
    await statements.incrementNodeCount(projectId, db);
    console.log(`Node ${nodeId} (id_in_project: ${idInProject})`);
    return { node_id: nodeId, id_in_project: idInProject };
  },

  /**
   * @param {object} edge
   * @param {number|null} edge.distance          Metres, or null when unresolved.
   * @param {string} edge.distanceStatus         One of DISTANCE_STATUS.
   * @param {number} edge.speedLimit             km/h.
   * @param {string|null} [edge.path]            Route geometry, already
   *   serialised and size-checked by the caller. Stored, never read: the
   *   server does not parse route geometry.
   * @param {string|null} [edge.endpointOffsets] Serialised metres from each
   *   requested coordinate to the road network the driver routed on.
   * @param {string|null} [edge.endpointsHash] Fingerprint of the two positions
   *   this answer was worked out between.
   *
   * Distance and status are written together because they are one fact. A
   * caller cannot store a number without saying what it is worth.
   */
  createConnection: async (projectId, fromNodeId, toNodeId, edge, db) => {
    const path = edge.path ?? null;
    const connectionId = await addEntry(
      "connections",
      {
        project_id: projectId,
        from_node_id: fromNodeId,
        to_node_id: toNodeId,
        distance: edge.distance,
        speed_limit: edge.speedLimit,
        distance_status: normaliseStatus(edge.distanceStatus),
        distance_updated_at: Date.now(),
        path,
        path_format: path === null ? null : PATH_FORMAT,
        endpoint_offsets: edge.endpointOffsets ?? null,
        endpoints_hash: edge.endpointsHash ?? null,
      },
      db,
    );
    // Update connection count
    await statements.incrementConnectionCount(projectId, db);
    return connectionId;
  },

  createViolation: async (
    projectId,
    carPlate,
    carSpeed,
    timestamp,
    connectionId,
    db,
  ) => {
    return await addEntry(
      "violations",
      {
        project_id: projectId,
        car_plate: carPlate,
        car_speed: carSpeed,
        connection_id: connectionId,
        // ISO 8601 UTC, the same form `traversals.timestamp` uses and the same
        // form the realtime `violation-added` event carries. Binding a Date
        // straight into this TEXT column made SQLite write "1787905380236.0",
        // which no client could parse back into a time.
        timestamp: toIsoTimestamp(timestamp),
      },
      db,
    );
  },

  createCarData: async (
    projectId,
    carPlate,
    lastSightingTime,
    lastSightingNodeId,
    db,
  ) => {
    return await addEntry(
      "car_data",
      {
        project_id: projectId,
        car_plate: carPlate,
        last_sighting_time: lastSightingTime,
        last_sighting_node_id: lastSightingNodeId,
      },
      db,
    );
  },

  sightCar: async (
    projectId,
    carPlate,
    newSightingTime,
    newSightingNodeId,
    db,
  ) => {
    const isRegistered = await isCarPlateRegistered(projectId, carPlate, db);
    const carId = isRegistered
      ? await carPlateToCarId(projectId, carPlate, db)
      : await registerCarPlate(projectId, carPlate, db);

    // Only update if the new timestamp is actually newer than what is stored,
    // preventing out-of-order HTTP requests from overwriting a later sighting.
    db.run(
      `UPDATE car_data
       SET last_sighting_time = ?, last_sighting_node_id = ?
       WHERE car_id = ? AND (last_sighting_time IS NULL OR last_sighting_time < ?)`,
      [newSightingTime, newSightingNodeId, carId, newSightingTime],
      function (err) {
        if (err) {
          console.error(err.message);
        }
        if (this.changes > 0) {
          console.log(`Car ${carId} is on ${newSightingNodeId}`);
        }
      },
    );
  },

  getConnectionByNodes: (fromNodeId, toNodeId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM connections WHERE from_node_id = ? AND to_node_id = ? AND retired_at IS NULL",
        [fromNodeId, toNodeId],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(row);
        },
      );
    });
  },

  fetchCarData: (carPlate, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM car_data WHERE car_plate = ?",
        [carPlate],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(row);
        },
      );
    });
  },

  listProjects: (db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT project_id, project_name, node_count, connection_count, " +
          "COALESCE(is_demo, 0) AS is_demo FROM projects",
        [],
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(rows);
        },
      );
    });
  },

  getProjectNodes: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT node_id, id_in_project, latitude, longitude FROM nodes WHERE project_id = ? AND retired_at IS NULL",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  getProjectConnections: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT connection_id, from_node_id, to_node_id, distance, " +
          "speed_limit, distance_status, distance_updated_at " +
          "FROM connections WHERE project_id = ? AND retired_at IS NULL",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  /**
   * Every edge in a project, with just enough to decide whether a driver needs
   * to be asked about it again.
   *
   * `has_path` rather than `path`: the question is whether geometry is missing,
   * and the geometry itself can be a quarter of a megabyte per edge.
   */
  getConnectionsForRecalculation: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT connection_id, from_node_id, to_node_id, speed_limit, " +
          "distance_status, endpoints_hash, path IS NOT NULL AS has_path " +
          "FROM connections WHERE project_id = ? AND retired_at IS NULL",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  /**
   * Every edge in a project, with what the data-quality checks need.
   *
   * `endpoint_offsets` is here and `path` is not: how far each coordinate was
   * from the road network is a handful of numbers and the whole of signal A,
   * while the geometry itself is up to a quarter of a megabyte per edge and
   * tells the diagnostics nothing they cannot get from the distance.
   */
  getConnectionsForDiagnostics: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT connection_id, from_node_id, to_node_id, distance, " +
          "distance_status, endpoint_offsets " +
          "FROM connections WHERE project_id = ? AND retired_at IS NULL",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  /**
   * Every edge in a project that has route geometry, and its geometry.
   *
   * The `path` column is stored and forwarded as the text a driver sent, never
   * parsed here: the server does not read route geometry, and reading it far
   * enough to re-encode it would be reading it. Edges without geometry are not
   * returned at all - the absence is the answer, and a null per edge would
   * cost a row each to say nothing.
   */
  getProjectGeometry: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT connection_id, path, path_format FROM connections " +
          "WHERE project_id = ? AND path IS NOT NULL AND retired_at IS NULL",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  /* ---------------------------------------------------------------------
     The map driver's address

     Four columns on `projects`, written only through these four statements so
     the state machine - none, pending, approved - exists in one place rather
     than in each caller.
     --------------------------------------------------------------------- */

  getMapDriver: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT map_driver_url, map_driver_origin, map_driver_status, " +
          "pending_map_driver_url FROM projects WHERE project_id = ?",
        [projectId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  },

  /**
   * Records an address a driver announced, which nobody has agreed to.
   *
   * Any previously approved address is cleared at the same time. It pointed at
   * the UI of the driver that was in this project's map slot, and that driver
   * has just been replaced by one serving something else; keeping it would
   * leave the console embedding a page that is no longer there, on the
   * strength of an approval that was about a different address.
   */
  setPendingMapDriverUrl: (projectId, url, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE projects SET pending_map_driver_url = ?, map_driver_url = NULL, " +
          "map_driver_origin = NULL, map_driver_status = ? WHERE project_id = ?",
        [url, MAP_DRIVER_STATUS.PENDING, projectId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  /**
   * Approves exactly one address, storing the origin the console will check
   * every `postMessage` against.
   *
   * The URL is part of the WHERE clause: an operator approves the address they
   * were shown, and if a driver re-announced a different one between the
   * screen being drawn and the button being pressed, nothing is approved.
   */
  approveMapDriverUrl: (projectId, url, origin, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE projects SET map_driver_url = ?, map_driver_origin = ?, " +
          "map_driver_status = ?, pending_map_driver_url = NULL " +
          "WHERE project_id = ? AND pending_map_driver_url = ?",
        [url, origin, MAP_DRIVER_STATUS.APPROVED, projectId, url],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  /** Discards an announcement without touching an address already approved. */
  clearPendingMapDriverUrl: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE projects SET pending_map_driver_url = NULL, map_driver_status = " +
          "CASE WHEN map_driver_url IS NULL THEN ? ELSE ? END " +
          "WHERE project_id = ?",
        [MAP_DRIVER_STATUS.NONE, MAP_DRIVER_STATUS.APPROVED, projectId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  /** Withdraws approval and forgets every address. Back to no map view. */
  clearMapDriver: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE projects SET map_driver_url = NULL, map_driver_origin = NULL, " +
          "pending_map_driver_url = NULL, map_driver_status = ? " +
          "WHERE project_id = ?",
        [MAP_DRIVER_STATUS.NONE, projectId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  /**
   * One connection by its own id, including the project it belongs to.
   *
   * Connection ids are sequential integers from AUTOINCREMENT, so any endpoint
   * that takes one from a request has to check its `project_id` before
   * touching it. This is how it does that.
   */
  getConnectionById: (connectionId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT connection_id, project_id, from_node_id, to_node_id, " +
          "distance, speed_limit, distance_status, distance_updated_at " +
          "FROM connections WHERE connection_id = ? AND retired_at IS NULL",
        [connectionId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  },

  /**
   * Updates one connection, scoped to its project.
   *
   * The project is part of the WHERE clause rather than a check the caller is
   * trusted to have made. Callers do check - both the REST and the Socket.IO
   * path resolve the connection first, so they can answer 403 rather than a
   * silent no-op - but a future caller that forgets cannot use this statement
   * to write across projects. Resolves with the number of rows changed, so
   * zero is distinguishable from success.
   */
  updateConnection: (connectionId, projectId, edge, db) => {
    const columns = [
      "distance = ?",
      "speed_limit = ?",
      "distance_status = ?",
      "distance_updated_at = ?",
    ];
    const values = [
      edge.distance,
      edge.speedLimit,
      normaliseStatus(edge.distanceStatus),
      Date.now(),
    ];

    // Geometry is only ever rewritten by a driver answering for this edge, and
    // then always all three columns together - a new distance with the old
    // road shape beside it would be two answers from two different moments. An
    // operator editing the numbers by hand leaves the shape alone.
    if ("path" in edge) {
      const path = edge.path ?? null;
      columns.push("path = ?", "path_format = ?", "endpoint_offsets = ?");
      values.push(
        path,
        path === null ? null : PATH_FORMAT,
        edge.endpointOffsets ?? null,
      );
    }

    // Written only by a caller that knows where the endpoints were when this
    // answer was decided. An edit that leaves the distance alone leaves the
    // fingerprint alone with it: the stored number still belongs to whatever
    // positions it always did.
    if ("endpointsHash" in edge) {
      columns.push("endpoints_hash = ?");
      values.push(edge.endpointsHash ?? null);
    }

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE connections SET ${columns.join(", ")} ` +
          "WHERE connection_id = ? AND project_id = ?",
        [...values, connectionId, projectId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  authenticateProject: (apiKey, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT project_id, project_name FROM projects WHERE api_key = ?",
        [apiKey],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  },

  incrementNodeCount: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE projects SET node_count = node_count + 1 WHERE project_id = ?",
        [projectId],
        function (err) {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  },

  incrementConnectionCount: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE projects SET connection_count = connection_count + 1 WHERE project_id = ?",
        [projectId],
        function (err) {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  },

  getNodeByIdInProject: (projectId, idInProject, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT node_id, project_id, id_in_project, latitude, longitude FROM nodes WHERE project_id = ? AND id_in_project = ? AND retired_at IS NULL",
        [projectId, idInProject],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  },

  getNodeByNodeId: (nodeId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT node_id, project_id, id_in_project, latitude, longitude, retired_at FROM nodes WHERE node_id = ?",
        [nodeId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  },

  /**
   * Moves a checkpoint.
   *
   * Scoped by project in the SQL as well as by the caller's check, which is
   * the same belt and braces every other id-addressed write here wears: node
   * ids are sequential integers, and one typo in a caller should not be able
   * to move somebody else's camera.
   *
   * Resolves to the number of rows changed, so a caller can tell "moved" from
   * "there was nothing there to move".
   */
  updateNodePosition: (nodeId, projectId, latitude, longitude, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE nodes SET latitude = ?, longitude = ? " +
          "WHERE node_id = ? AND project_id = ?",
        [latitude, longitude, nodeId, projectId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  /** Every edge with this checkpoint at either end. */
  getConnectionsTouchingNode: (nodeId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT connection_id, from_node_id, to_node_id, speed_limit " +
          "FROM connections " +
          "WHERE project_id = ? AND (from_node_id = ? OR to_node_id = ?) AND retired_at IS NULL",
        [projectId, nodeId, nodeId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  /**
   * Forgets everything that was measured between a moved checkpoint and its
   * neighbours: the distance, the route geometry, the offsets to the road,
   * and the fingerprint of the positions it was all worked out from.
   *
   * This is the whole point of moving a node through the server rather than
   * with an UPDATE. The stored distance was measured from where the camera
   * used to be; leaving it in place would keep enforcing speeds against a
   * road length that no longer exists, and nothing downstream could tell.
   * An edge with no distance enforces nothing, which is the correct state
   * until a driver has answered again.
   */
  invalidateConnectionsForNode: (nodeId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE connections SET distance = NULL, distance_status = ?, " +
          "distance_updated_at = ?, path = NULL, path_format = NULL, " +
          "endpoint_offsets = NULL, endpoints_hash = NULL " +
          "WHERE project_id = ? AND (from_node_id = ? OR to_node_id = ?)",
        [DISTANCE_STATUS.UNKNOWN, Date.now(), projectId, nodeId, nodeId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  getProjectViolations: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT violation_id, car_plate, car_speed, timestamp, connection_id FROM violations WHERE project_id = ? ORDER BY violation_id DESC",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  listProjectsWithKeys: (db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT project_id, project_name, api_key, node_count, connection_count FROM projects",
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  /**
   * Shape-only geometry for the dashboard thumbnails.
   *
   * This endpoint is unauthenticated, and node coordinates are the GPS
   * positions of real cameras, so no absolute position leaves here. The nodes
   * are projected to the local tangent plane (north up, correct aspect ratio)
   * and then normalised into the unit square. Both axes are divided by the
   * SAME span, so the drawing stays proportional to real distances; origin and
   * scale are discarded, which is everything the thumbnail never needed.
   */
  getThumbnailData: (projectId, db) => {
    return new Promise(async (resolve, reject) => {
      try {
        const nodes = await new Promise((res, rej) => {
          db.all(
            "SELECT id_in_project, latitude, longitude FROM nodes WHERE project_id = ? AND retired_at IS NULL",
            [projectId],
            (err, rows) => (err ? rej(err) : res(rows || [])),
          );
        });
        const connections = await new Promise((res, rej) => {
          db.all(
            "SELECT from_node_id, to_node_id FROM connections WHERE project_id = ? AND retired_at IS NULL",
            [projectId],
            (err, rows) => (err ? rej(err) : res(rows || [])),
          );
        });

        const nodesOut = normaliseNodeShape(nodes);

        // We need node_id -> id_in_project map for connections
        const nodeIdMap = await new Promise((res, rej) => {
          db.all(
            "SELECT node_id, id_in_project FROM nodes WHERE project_id = ? AND retired_at IS NULL",
            [projectId],
            (err, rows) => {
              if (err) rej(err);
              const map = {};
              for (const r of rows || []) map[r.node_id] = r.id_in_project;
              res(map);
            },
          );
        });
        const connsOut = connections.map((c) => ({
          from: nodeIdMap[c.from_node_id],
          to: nodeIdMap[c.to_node_id],
        }));
        resolve({ nodes: nodesOut, connections: connsOut });
      } catch (err) {
        reject(err);
      }
    });
  },

  /* ---------------------------------------------------------------------
     Credentials. See api-key-manager.js for what each role may do.
     --------------------------------------------------------------------- */

  /**
   * Resolves an API key to `{ projectId, role, keyId }`, or null.
   *
   * The project's own key is checked first and is always `operator`; it lives
   * on the projects row, has no `key_id`, and cannot be revoked individually.
   * Everything else is a row in `api_keys` carrying its own role.
   */
  resolveApiKey: (apiKey, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT project_id FROM projects WHERE api_key = ?",
        [apiKey],
        (err, project) => {
          if (err) return reject(err);
          if (project) {
            return resolve({
              projectId: project.project_id,
              role: "operator",
              keyId: null,
            });
          }
          db.get(
            "SELECT key_id, project_id, role FROM api_keys WHERE api_key = ?",
            [apiKey],
            (keyErr, row) => {
              if (keyErr) return reject(keyErr);
              if (!row) return resolve(null);
              resolve({
                projectId: row.project_id,
                role: row.role,
                keyId: row.key_id,
              });
            },
          );
        },
      );
    });
  },

  createApiKey: (projectId, apiKey, role, label, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO api_keys (project_id, api_key, role, label, created_at) VALUES (?, ?, ?, ?, ?)",
        [projectId, apiKey, role, label || null, toIsoTimestamp(new Date())],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        },
      );
    });
  },

  /**
   * The keys issued for a project, without the keys themselves.
   *
   * A key is shown once, when it is issued, and never again: what comes back
   * here is enough to tell one camera's credential from another's and revoke
   * the right one. An operator who loses a camera key revokes it and issues a
   * new one, which is a single call rather than a reason to keep every bearer
   * credential on the server readable.
   */
  listApiKeys: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT key_id, role, label, created_at, substr(api_key, 1, 6) AS key_prefix FROM api_keys WHERE project_id = ? ORDER BY key_id",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  /** Deletes one key, scoped to its project. Resolves with rows removed. */
  revokeApiKey: (keyId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "DELETE FROM api_keys WHERE key_id = ? AND project_id = ?",
        [keyId, projectId],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  recordTraversal: (connectionId, deltaT, timestamp, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO traversals (connection_id, delta_t, timestamp) VALUES (?, ?, ?)",
        [connectionId, deltaT, toIsoTimestamp(timestamp)],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        },
      );
    });
  },

  getRecentTraversals: (connectionId, windowMs, db) => {
    return new Promise((resolve, reject) => {
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      db.all(
        "SELECT delta_t FROM traversals WHERE connection_id = ? AND timestamp >= ?",
        [connectionId, cutoff],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  deleteOldTraversals: (windowMs, db) => {
    return new Promise((resolve, reject) => {
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      db.run(
        "DELETE FROM traversals WHERE timestamp < ?",
        [cutoff],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  },

  /** connection_id -> how many violations are linked to it, for the given edges. */
  countViolationsByConnection: (connectionIds, db) => {
    if (connectionIds.length === 0) return Promise.resolve(new Map());
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT connection_id, COUNT(*) AS n FROM violations WHERE connection_id IN (${connectionIds
          .map(() => "?")
          .join(",")}) GROUP BY connection_id`,
        connectionIds,
        (err, rows) =>
          err ? reject(err) : resolve(new Map((rows || []).map((row) => [row.connection_id, row.n]))),
      );
    });
  },

  /**
   * Deletes one edge, unless a violation is linked to it.
   *
   * The check is inside the DELETE, so a violation recorded between a caller
   * checking and the delete running still stops it. Resolves with rows removed.
   */
  deleteConnection: (connectionId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "DELETE FROM connections WHERE connection_id = ? AND project_id = ? " +
          "AND NOT EXISTS (SELECT 1 FROM violations WHERE violations.connection_id = ?)",
        [connectionId, projectId, connectionId],
        function (err) {
          if (err) return reject(err);
          const removed = this.changes;
          if (removed === 0) return resolve(0);
          // Congestion samples for a road that no longer exists mean nothing.
          db.run("DELETE FROM traversals WHERE connection_id = ?", [connectionId]);
          db.run(
            "UPDATE projects SET connection_count = MAX(connection_count - 1, 0) WHERE project_id = ?",
            [projectId],
          );
          resolve(removed);
        },
      );
    });
  },

  /**
   * Deletes one checkpoint that no longer has edges. A car last seen there
   * is treated as not seen anywhere, so its next sighting starts fresh rather
   * than being measured from a camera that is gone.
   */
  deleteNode: (nodeId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "DELETE FROM nodes WHERE node_id = ? AND project_id = ? " +
          "AND NOT EXISTS (SELECT 1 FROM connections WHERE from_node_id = ? OR to_node_id = ?)",
        [nodeId, projectId, nodeId, nodeId],
        function (err) {
          if (err) return reject(err);
          const removed = this.changes;
          if (removed === 0) return resolve(0);
          db.run("UPDATE car_data SET last_sighting_node_id = NULL WHERE last_sighting_node_id = ?", [nodeId]);
          db.run(
            "UPDATE projects SET node_count = MAX(node_count - 1, 0) WHERE project_id = ?",
            [projectId],
          );
          resolve(removed);
        },
      );
    });
  },

  /** Takes an edge out of service, keeping the row and its violations. Resolves with rows changed. */
  retireConnection: (connectionId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE connections SET retired_at = ? WHERE connection_id = ? AND project_id = ? AND retired_at IS NULL",
        [new Date().toISOString(), connectionId, projectId],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) return resolve(0);
          db.run("DELETE FROM traversals WHERE connection_id = ?", [connectionId]);
          db.run("UPDATE projects SET connection_count = MAX(connection_count - 1, 0) WHERE project_id = ?", [projectId]);
          resolve(this.changes);
        },
      );
    });
  },

  /** Takes a checkpoint out of service. Its edges must be retired or deleted first. */
  retireNode: (nodeId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE nodes SET retired_at = ? WHERE node_id = ? AND project_id = ? AND retired_at IS NULL " +
          "AND NOT EXISTS (SELECT 1 FROM connections WHERE (from_node_id = ? OR to_node_id = ?) AND retired_at IS NULL)",
        [new Date().toISOString(), nodeId, projectId, nodeId, nodeId],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) return resolve(0);
          db.run("UPDATE car_data SET last_sighting_node_id = NULL WHERE last_sighting_node_id = ?", [nodeId]);
          db.run("UPDATE projects SET node_count = MAX(node_count - 1, 0) WHERE project_id = ?", [projectId]);
          resolve(this.changes);
        },
      );
    });
  },

  unretireNode: (nodeId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE nodes SET retired_at = NULL WHERE node_id = ? AND project_id = ? AND retired_at IS NOT NULL",
        [nodeId, projectId],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) return resolve(0);
          db.run("UPDATE projects SET node_count = node_count + 1 WHERE project_id = ?", [projectId]);
          resolve(this.changes);
        },
      );
    });
  },

  /** Back into service, if both of its checkpoints are in service and the pair has no other live edge. */
  unretireConnection: (connectionId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE connections SET retired_at = NULL WHERE connection_id = ? AND project_id = ? AND retired_at IS NOT NULL " +
          "AND (SELECT retired_at FROM nodes WHERE node_id = connections.from_node_id) IS NULL " +
          "AND (SELECT retired_at FROM nodes WHERE node_id = connections.to_node_id) IS NULL " +
          "AND NOT EXISTS (SELECT 1 FROM connections c2 WHERE c2.from_node_id = connections.from_node_id " +
          "AND c2.to_node_id = connections.to_node_id AND c2.retired_at IS NULL)",
        [connectionId, projectId],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) return resolve(0);
          db.run("UPDATE projects SET connection_count = connection_count + 1 WHERE project_id = ?", [projectId]);
          resolve(this.changes);
        },
      );
    });
  },

  /** Retired checkpoints and edges, newest first, with how many violations each edge holds. */
  listRetired: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT node_id, id_in_project, latitude, longitude, retired_at FROM nodes " +
          "WHERE project_id = ? AND retired_at IS NOT NULL ORDER BY retired_at DESC",
        [projectId],
        (err, nodes) => {
          if (err) return reject(err);
          db.all(
            "SELECT c.connection_id, c.from_node_id, c.to_node_id, c.distance, c.speed_limit, c.distance_status, c.retired_at, " +
              "(SELECT COUNT(*) FROM violations v WHERE v.connection_id = c.connection_id) AS violations " +
              "FROM connections c WHERE c.project_id = ? AND c.retired_at IS NOT NULL ORDER BY c.retired_at DESC",
            [projectId],
            (err2, connections) => (err2 ? reject(err2) : resolve({ nodes: nodes || [], connections: connections || [] })),
          );
        },
      );
    });
  },

  /** One edge, retired or not, for bringing it back. */
  getAnyConnection: (connectionId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT connection_id, project_id, from_node_id, to_node_id, distance, speed_limit, distance_status, retired_at " +
          "FROM connections WHERE connection_id = ?",
        [connectionId],
        (err, row) => (err ? reject(err) : resolve(row || null)),
      );
    });
  },

  insertAgentAction: (action, db) => {
    return addEntry(
      "agent_actions",
      {
        project_id: action.projectId,
        run_id: action.runId,
        session_id: action.sessionId,
        call_id: action.callId,
        user_request: action.userRequest,
        tool: action.tool,
        input: JSON.stringify(action.input),
        started_at: new Date().toISOString(),
      },
      db,
    );
  },

  finishAgentAction: (actionId, outcome, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE agent_actions SET result = ?, ok = ?, api_calls = ?, " +
          "confirmation = ?, finished_at = ? WHERE action_id = ?",
        [
          JSON.stringify(outcome.result ?? null),
          outcome.ok ? 1 : 0,
          JSON.stringify(outcome.apiCalls ?? []),
          outcome.confirmation ?? null,
          new Date().toISOString(),
          actionId,
        ],
        (err) => (err ? reject(err) : resolve()),
      );
    });
  },

  /** Keeps the newest RESTORE_POINTS_KEPT per project; older ones are dropped. */
  insertRestorePoint: (point, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO restore_points (project_id, name, origin, run_id, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [point.projectId, point.name, point.origin, point.runId ?? null, JSON.stringify(point.snapshot), new Date().toISOString()],
        function (err) {
          if (err) return reject(err);
          const id = this.lastID;
          db.run(
            "DELETE FROM restore_points WHERE project_id = ? AND restore_point_id NOT IN " +
              "(SELECT restore_point_id FROM restore_points WHERE project_id = ? ORDER BY restore_point_id DESC LIMIT 50)",
            [point.projectId, point.projectId],
            () => resolve(id),
          );
        },
      );
    });
  },

  listRestorePoints: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT restore_point_id, name, origin, run_id, created_at, snapshot FROM restore_points " +
          "WHERE project_id = ? ORDER BY restore_point_id DESC",
        [projectId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(
            (rows || []).map(({ snapshot, ...row }) => {
              const parsed = JSON.parse(snapshot);
              return { ...row, cameras: parsed.nodes.length, edges: parsed.edges.length };
            }),
          );
        },
      );
    });
  },

  getRestorePoint: (restorePointId, projectId, db) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT restore_point_id, name, origin, run_id, created_at, snapshot FROM restore_points " +
          "WHERE restore_point_id = ? AND project_id = ?",
        [restorePointId, projectId],
        (err, row) => (err ? reject(err) : resolve(row ? { ...row, snapshot: JSON.parse(row.snapshot) } : null)),
      );
    });
  },

  listAgentActions: (projectId, limit, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT action_id, run_id, session_id, call_id, user_request, tool, " +
          "input, result, ok, api_calls, confirmation, started_at, finished_at " +
          "FROM agent_actions WHERE project_id = ? ORDER BY action_id DESC LIMIT ?",
        [projectId, limit],
        (err, rows) => {
          if (err) return reject(err);
          resolve(
            (rows || []).map((row) => ({
              ...row,
              ok: row.ok === null ? null : row.ok === 1,
              input: JSON.parse(row.input),
              result: row.result === null ? null : JSON.parse(row.result),
              api_calls: row.api_calls === null ? [] : JSON.parse(row.api_calls),
            })),
          );
        },
      );
    });
  },
};

module.exports = {
  createDatabase,
  initializeDatabase,
  statements,
  DISTANCE_STATUS,
  PATH_FORMAT,
  MAP_DRIVER_STATUS,
};
