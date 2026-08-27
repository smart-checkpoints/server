const sqlite = require("sqlite3");
const { makeProjection } = require("./geo.js");

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
 * the other migrations in this file it does NOT swallow errors — a
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
              "— fix the schema by hand before serving coordinate data.",
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

function initializeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      createTables(db);
      // Coordinate rename runs last so the CREATE TABLE statements above have
      // already settled, and its failure rejects rather than being swallowed.
      db.run("SELECT 1", (err) => {
        if (err) return reject(err);
        migrateNodeCoordinateColumns(db).then(resolve, reject);
      });
    });
  });
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

  db.run(`CREATE TABLE IF NOT EXISTS violations (
      violation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      car_plate TEXT,
      car_speed REAL,
      timestamp TEXT,
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

const statements = {
  createProject: async (projectName, apiKey, db) => {
    return await addEntry(
      "projects",
      { project_name: projectName, api_key: apiKey },
      db,
    );
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
    const idInProject = await statements.getNextIdInProject(projectId, db);
    const nodeId = await addEntry(
      "nodes",
      {
        project_id: projectId,
        id_in_project: idInProject,
        latitude: latitude,
        longitude: longitude,
      },
      db,
    );
    // Update node count
    await statements.incrementNodeCount(projectId, db);
    console.log(`Node ${nodeId} (id_in_project: ${idInProject})`);
    return { node_id: nodeId, id_in_project: idInProject };
  },

  createConnection: async (
    projectId,
    fromNodeId,
    toNodeId,
    distance,
    speedLimit,
    db,
  ) => {
    const connectionId = await addEntry(
      "connections",
      {
        project_id: projectId,
        from_node_id: fromNodeId,
        to_node_id: toNodeId,
        distance: distance,
        speed_limit: speedLimit,
      },
      db,
    );
    // Update connection count
    await statements.incrementConnectionCount(projectId, db);
    return connectionId;
  },

  createViolation: async (projectId, carPlate, carSpeed, timestamp, db) => {
    console.log(projectId, carPlate, carSpeed, timestamp);
    return await addEntry(
      "violations",
      {
        project_id: projectId,
        car_plate: carPlate,
        car_speed: carSpeed,
        timestamp: timestamp,
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
        "SELECT * FROM connections WHERE from_node_id = ? AND to_node_id = ?",
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
        "SELECT project_id, project_name, node_count, connection_count FROM projects",
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
        "SELECT node_id, id_in_project, latitude, longitude FROM nodes WHERE project_id = ?",
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
        "SELECT connection_id, from_node_id, to_node_id, distance, speed_limit FROM connections WHERE project_id = ?",
        [projectId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      );
    });
  },

  updateConnection: (connectionId, distance, speedLimit, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "UPDATE connections SET distance = ?, speed_limit = ? WHERE connection_id = ?",
        [distance, speedLimit, connectionId],
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
        "SELECT node_id, project_id, id_in_project, latitude, longitude FROM nodes WHERE project_id = ? AND id_in_project = ?",
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
        "SELECT node_id, project_id, id_in_project, latitude, longitude FROM nodes WHERE node_id = ?",
        [nodeId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || null);
        },
      );
    });
  },

  getProjectViolations: (projectId, db) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT violation_id, car_plate, car_speed, timestamp FROM violations WHERE project_id = ? ORDER BY violation_id DESC",
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
            "SELECT id_in_project, latitude, longitude FROM nodes WHERE project_id = ?",
            [projectId],
            (err, rows) => (err ? rej(err) : res(rows || [])),
          );
        });
        const connections = await new Promise((res, rej) => {
          db.all(
            "SELECT from_node_id, to_node_id FROM connections WHERE project_id = ?",
            [projectId],
            (err, rows) => (err ? rej(err) : res(rows || [])),
          );
        });

        const nodesOut = normaliseNodeShape(nodes);

        // We need node_id -> id_in_project map for connections
        const nodeIdMap = await new Promise((res, rej) => {
          db.all(
            "SELECT node_id, id_in_project FROM nodes WHERE project_id = ?",
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

  recordTraversal: (connectionId, deltaT, timestamp, db) => {
    return new Promise((resolve, reject) => {
      db.run(
        "INSERT INTO traversals (connection_id, delta_t, timestamp) VALUES (?, ?, ?)",
        [
          connectionId,
          deltaT,
          typeof timestamp === "object" ? timestamp.toISOString() : timestamp,
        ],
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
};

module.exports = {
  createDatabase,
  initializeDatabase,
  statements,
};
