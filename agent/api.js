"use strict";

/**
 * Sayes's only way to touch the system: the server's own REST API, called
 * over loopback with the operator key the console sent with the run.
 *
 * Going through HTTP rather than calling the handlers directly is the point.
 * Every check a request from the console gets - the key, the project, the
 * validation - Sayes's calls get too, and every change it makes is
 * broadcast over Socket.IO by the same code that broadcasts the console's.
 */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function createApiClient(baseUrl, apiKey, projectId, record) {
  async function call(method, path, body) {
    const started = Date.now();
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "x-api-key": apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      record({ method, path, status: 0, ms: Date.now() - started });
      throw new ApiError(0, `The server could not be reached: ${err.message}`);
    }
    const text = await response.text();
    record({ method, path, status: response.status, ms: Date.now() - started });

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const message = data && typeof data === "object" && data.error ? data.error : `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return data;
  }

  const p = `/project/${projectId}`;
  return {
    getNodes: () => call("GET", `${p}/nodes`),
    getConnections: () => call("GET", `${p}/connections`),
    getDistanceDriverStatus: () => call("GET", `${p}/distance-driver-status`),
    getViolations: () => call("GET", `${p}/violations`),
    getDiagnostics: () => call("GET", `${p}/diagnostics`),
    getCongestion: () => call("GET", `${p}/congestion`),
    getMapDriver: () => call("GET", `${p}/map-driver`),
    createNode: (latitude, longitude) => call("POST", "/create-node", { latitude, longitude }),
    createConnection: (fromNodeId, toNodeId, speedLimit) =>
      call("POST", "/create-connection", {
        "from-node-id": fromNodeId,
        "to-node-id": toNodeId,
        "speed-limit": speedLimit,
      }),
    setSpeedLimit: (connectionId, speedLimit) =>
      call("PUT", `/connection/${connectionId}`, { "speed-limit": speedLimit }),
    moveNode: (nodeId, latitude, longitude) => call("PUT", `/node/${nodeId}`, { latitude, longitude }),
    deleteConnection: (connectionId) => call("DELETE", `/connection/${connectionId}`),
    deleteNode: (nodeId) => call("DELETE", `/node/${nodeId}`),
  };
}

module.exports = { createApiClient, ApiError };
