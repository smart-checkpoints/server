"use strict";

/**
 * Credentials, and what each one is allowed to do.
 *
 * There are two roles, and the split exists because of who holds the key.
 *
 * An `operator` key is the project's own key. It is held by the console, by
 * administrators, and by the project's distance driver, and it can do
 * everything: read the graph, rewrite it, read violations, open the driver
 * channel.
 *
 * A `reporter` key is held by one camera. A camera is a box on a pole that
 * somebody can open, and all it ever needs to do is `POST /report-checkpoint`
 * for its own project. So that is all a reporter key can do. One per camera
 * means one can be revoked without reflashing the fleet.
 *
 * `projects.api_key` is the project's operator key and keeps working exactly
 * as it did, so nothing breaks on upgrade. Every other key lives in the
 * `api_keys` table.
 */

const crypto = require("crypto");
const { statements } = require("./database.js");

const ROLES = {
  OPERATOR: "operator",
  REPORTER: "reporter",
};

const KEY_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_LENGTH = 32;

/**
 * A new API key: 32 characters from a 62 character alphabet, ~190 bits.
 *
 * Drawn from `crypto.randomInt`, not `Math.random`. These are bearer
 * credentials for an enforcement project, and `Math.random` is a seeded PRNG
 * whose output is predictable from previous output. The wire format is
 * unchanged - still an opaque 32 character string - so existing keys, cameras
 * and drivers are unaffected.
 */
function createAPIKey() {
  let apiKey = "";
  for (let i = 0; i < KEY_LENGTH; i++) {
    apiKey += KEY_ALPHABET.charAt(crypto.randomInt(KEY_ALPHABET.length));
  }
  return apiKey;
}

/**
 * Resolves a key to `{ projectId, role, keyId }`, or rejects.
 *
 * `keyId` is null for a project's own operator key, which lives on the
 * projects row rather than in `api_keys` and therefore cannot be revoked
 * individually.
 */
async function resolveAPIKey(apiKey, db) {
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new Error("Invalid API key");
  }
  const credential = await statements.resolveApiKey(apiKey, db);
  if (!credential) {
    throw new Error("Invalid API key");
  }
  return credential;
}

/**
 * Resolves a key to its project, requiring the operator role.
 *
 * Both callers - the distance driver WebSocket and the Socket.IO
 * `join-project` handshake - are operator surfaces: one rewrites every
 * distance in the project, the other subscribes to live violations. A camera's
 * key opens neither.
 */
async function APIKeyToProjectId(apiKey, db) {
  const { projectId, role } = await resolveAPIKey(apiKey, db);
  if (role !== ROLES.OPERATOR) {
    throw new Error("Invalid API key");
  }
  return projectId;
}

/**
 * Express middleware: authenticates `x-api-key` and enforces the role.
 *
 * Defaults to operator-only, so an endpoint added later is closed to cameras
 * unless somebody deliberately opens it. Sets `req.projectId`, `req.apiRole`
 * and `req.apiKeyId`.
 */
function authenticateAPIKey(db, { roles = [ROLES.OPERATOR] } = {}) {
  return async (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      return res.status(401).json({ error: "Missing API key" });
    }

    let credential;
    try {
      credential = await resolveAPIKey(apiKey, db);
    } catch {
      return res.status(401).json({ error: "Invalid API key" });
    }

    if (!roles.includes(credential.role)) {
      // 403, not 401: the key is real, it is simply not allowed to do this.
      // Retrying with the same credential will never work.
      return res.status(403).json({
        error:
          `This is a ${credential.role} key. ` +
          `That endpoint requires ${roles.join(" or ")}.`,
      });
    }

    req.projectId = credential.projectId;
    req.apiRole = credential.role;
    req.apiKeyId = credential.keyId;
    next();
  };
}

module.exports = {
  ROLES,
  createAPIKey,
  resolveAPIKey,
  APIKeyToProjectId,
  authenticateAPIKey,
};
