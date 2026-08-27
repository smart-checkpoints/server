function createAPIKey() {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxy0123456789";
  let apiKey = "";
  for (let i = 0; i < 32; i++) {
    apiKey += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return apiKey;
}

function APIKeyToProjectId(apiKey, db) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT project_id FROM projects WHERE api_key = ?",
      [apiKey],
      (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          resolve(row.project_id);
        } else {
          reject(new Error("Invalid API key"));
        }
      },
    );
  });
}

function authenticateAPIKey(db) {
  return async (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      return res.status(401).json({ error: "Missing API key" });
    }
    try {
      const projectId = await APIKeyToProjectId(apiKey, db);
      req.projectId = projectId;
      next();
    } catch (err) {
      res.status(401).json({ error: "Invalid API key" });
    }
  };
}

module.exports = {
  createAPIKey,
  APIKeyToProjectId,
  authenticateAPIKey,
};
