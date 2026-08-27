const sqlite = require("sqlite3");

function createDatabase(path = "Server/database.db") {
  const db = new sqlite.Database(path);
  // Enable WAL mode for better concurrency under high write load
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

function initializeDatabase(db) {
  db.serialize(() => {
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
        x_coord REAL,
        y_coord REAL,
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
  });
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

  createNode: async (projectId, xCoord, yCoord, db) => {
    const idInProject = await statements.getNextIdInProject(projectId, db);
    const nodeId = await addEntry(
      "nodes",
      {
        project_id: projectId,
        id_in_project: idInProject,
        x_coord: xCoord,
        y_coord: yCoord,
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
        "SELECT node_id, id_in_project, x_coord, y_coord FROM nodes WHERE project_id = ?",
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
        "SELECT * FROM nodes WHERE project_id = ? AND id_in_project = ?",
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
      db.get("SELECT * FROM nodes WHERE node_id = ?", [nodeId], (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
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

  getThumbnailData: (projectId, db) => {
    return new Promise(async (resolve, reject) => {
      try {
        const nodes = await new Promise((res, rej) => {
          db.all(
            "SELECT id_in_project, x_coord, y_coord FROM nodes WHERE project_id = ?",
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
        // Map from_node_id/to_node_id to id_in_project for client
        const nodeMap = {};
        const nodesOut = [];
        for (const n of nodes) {
          nodesOut.push({ id: n.id_in_project, x: n.x_coord, y: n.y_coord });
        }
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
