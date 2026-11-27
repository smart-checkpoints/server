"use strict";

/**
 * Sayes: an operator describes what they want, and the agent configures
 * the checkpoint network through the server's own REST API, streaming every
 * step to the console so it can be animated as it happens.
 *
 *   GET  /project/:id/agent                          is it on, and its limits
 *   POST /project/:id/agent/runs                     { message, session_id? } -> SSE stream
 *   POST /project/:id/agent/runs/:runId/confirm      { call_id, approved }
 *   POST /project/:id/agent/runs/:runId/cancel
 *   GET  /project/:id/agent/audit?limit=N            read-only record of every action
 *
 * All five need the project's operator key, checked against the project in
 * the path, exactly like every other project-scoped endpoint.
 */

const { config } = require("./config.js");
const { places } = require("./places");
const { launchRun, activeRun, getRun, answerConfirmation, cancelRun } = require("./runner.js");

const MAX_MESSAGE_LENGTH = 2000;
const HEARTBEAT_MS = 15000;

function openEventStream(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  let seq = 0;
  let open = true;
  const heartbeat = setInterval(() => open && res.write(": keep-alive\n\n"), HEARTBEAT_MS);
  res.on("close", () => {
    open = false;
    clearInterval(heartbeat);
  });
  return {
    get open() {
      return open;
    },
    send(event, data) {
      if (!open) return;
      seq += 1;
      res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify({ ...data, at: new Date().toISOString() })}\n\n`);
    },
    end() {
      if (!open) return;
      clearInterval(heartbeat);
      res.end();
    },
  };
}

function mountAgent({ app, db, statements, authenticateAPIKey, requireOwnProject, apiBaseUrl }) {
  const guard = [authenticateAPIKey(db), requireOwnProject];

  app.get("/project/:id/agent", ...guard, (req, res) => {
    res.json({
      enabled: config.enabled,
      ...(config.enabled ? {} : { reason: "ANTHROPIC_API_KEY is not set on the server." }),
      model: config.model,
      thinking: config.thinking,
      effort: config.effort,
      cursor_lead_ms: config.cursorLeadMs,
      limits: {
        tool_calls_per_run: config.maxToolCallsPerRun,
        turns_per_run: config.maxTurnsPerRun,
        tool_calls_per_session: config.maxToolCallsPerSession,
      },
      busy: Boolean(activeRun(req.projectId)),
      places: [...places.streets.map((s) => s.name), ...places.landmarks.map((l) => l.name)],
    });
  });

  app.get("/project/:id/agent/audit", ...guard, async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    try {
      res.json(await statements.listAgentActions(req.projectId, limit, db));
    } catch (err) {
      console.error("🤖 Could not read the agent audit log:", err);
      res.status(500).json({ error: "Failed to read the agent audit log" });
    }
  });

  app.post("/project/:id/agent/runs", ...guard, async (req, res) => {
    if (!config.enabled) {
      return res.status(503).json({ error: "The agent is off: ANTHROPIC_API_KEY is not set on the server." });
    }
    const message = req.body && req.body.message;
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `message must be text of 1 to ${MAX_MESSAGE_LENGTH} characters` });
    }
    const sessionId = req.body.session_id;
    if (sessionId !== undefined && sessionId !== null && typeof sessionId !== "string") {
      return res.status(400).json({ error: "session_id must be a string" });
    }
    if (activeRun(req.projectId)) {
      return res.status(409).json({ error: "The agent is already working on this project." });
    }

    const stream = openEventStream(res);
    const { idReady, done } = launchRun({
      projectId: req.projectId,
      apiKey: req.headers["x-api-key"],
      apiBaseUrl,
      sessionId: sessionId || null,
      message: message.trim(),
      retry: req.body.retry === true,
      emit: (event, data) => stream.send(event, data),
      db,
      statements,
    });

    // The operator closing the panel or the tab stops the run: nobody is
    // there to watch it or to answer a confirmation.
    const runId = await idReady;
    res.on("close", () => {
      const run = getRun(req.projectId, runId);
      if (run) cancelRun(run);
    });

    await done;
    stream.end();
  });

  app.post("/project/:id/agent/runs/:runId/confirm", ...guard, (req, res) => {
    const run = getRun(req.projectId, req.params.runId);
    if (!run) return res.status(404).json({ error: "No such run is in progress" });
    const callId = req.body && req.body.call_id;
    const approved = req.body && req.body.approved;
    if (typeof callId !== "string" || typeof approved !== "boolean") {
      return res.status(400).json({ error: "call_id must be a string and approved a boolean" });
    }
    if (!answerConfirmation(run, callId, approved)) {
      return res.status(404).json({ error: "That action is not waiting for confirmation" });
    }
    res.json({ success: true });
  });

  app.post("/project/:id/agent/runs/:runId/cancel", ...guard, (req, res) => {
    const run = getRun(req.projectId, req.params.runId);
    if (!run) return res.status(404).json({ error: "No such run is in progress" });
    cancelRun(run);
    res.json({ success: true });
  });

  console.log(
    config.enabled
      ? `🤖 Sayes agent on: ${config.model}, thinking ${config.thinking}, effort ${config.effort}`
      : "🤖 Sayes agent off: set ANTHROPIC_API_KEY in .env to enable it",
  );
}

module.exports = { mountAgent };
