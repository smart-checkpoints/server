"use strict";

/**
 * The agent loop: one run is one operator message, taken to a final reply.
 *
 * A manual Messages API loop rather than the SDK's tool runner, because every
 * tool call has to stop in the middle - to tell the console where the cursor
 * goes, to wait for the cursor to get there, and sometimes to wait for an
 * operator to approve it - and every one is recorded before and after.
 *
 * Conversation history lives here, on the server, per session. The console
 * sends only the operator's words; it cannot hand the model a tool result or
 * an assistant turn that never happened.
 */

const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk").default;

const { config } = require("./config.js");
const { SYSTEM_PROMPT } = require("./prompt.js");
const { BY_NAME, definitions, ToolError } = require("./tools.js");
const { createApiClient, ApiError } = require("./api.js");

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The tools whose calls the console draws a cursor for (they have a target). */
const CURSOR_TOOLS = new Set([
  "create_checkpoint",
  "create_edge",
  "set_speed_limit",
  "move_checkpoint_by",
  "move_checkpoint_to",
  "get_violation_summary",
  "get_diagnostics",
]);

let client = null;
function anthropic() {
  // The SDK reads ANTHROPIC_API_KEY itself. Created on first use so a server
  // without a key starts normally and the agent simply says it is off.
  if (!client) client = new Anthropic();
  return client;
}

/* -------------------------------------------------------------------------
   Sessions and runs, in memory
   ------------------------------------------------------------------------- */

/** session_id -> { id, projectId, messages, toolCalls, lastUsed } */
const sessions = new Map();
/** run_id -> run state */
const runs = new Map();
/** project_id -> run_id of the one run allowed at a time */
const activeRunByProject = new Map();

setInterval(() => {
  const cutoff = Date.now() - config.sessionIdleMs;
  for (const [id, session] of sessions) {
    if (session.lastUsed < cutoff && !session.busy) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

function getOrCreateSession(projectId, sessionId) {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing && existing.projectId === projectId) return existing;
    // An unknown or foreign id starts a fresh conversation rather than failing:
    // sessions are in memory and a server restart forgets them.
  }
  const session = {
    id: crypto.randomUUID(),
    projectId,
    messages: [],
    toolCalls: 0,
    busy: false,
    lastUsed: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

function activeRun(projectId) {
  const runId = activeRunByProject.get(projectId);
  return runId ? runs.get(runId) : null;
}

function getRun(projectId, runId) {
  const run = runs.get(runId);
  return run && run.projectId === projectId ? run : null;
}

/** Settles a pending confirmation. Returns false if nothing was waiting. */
function answerConfirmation(run, callId, approved) {
  const pending = run.confirmations.get(callId);
  if (!pending) return false;
  pending.resolve(approved ? "approved" : "declined");
  return true;
}

function cancelRun(run) {
  run.controller.abort();
  for (const pending of run.confirmations.values()) pending.resolve("cancelled");
}

/* -------------------------------------------------------------------------
   One tool call
   ------------------------------------------------------------------------- */

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function waitForConfirmation(run, callId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("timed-out"), config.confirmTimeoutMs);
    const onAbort = () => finish("cancelled");
    function finish(outcome) {
      clearTimeout(timer);
      run.signal.removeEventListener("abort", onAbort);
      run.confirmations.delete(callId);
      resolve(outcome);
    }
    run.signal.addEventListener("abort", onAbort, { once: true });
    run.confirmations.set(callId, { resolve: finish });
  });
}

async function executeToolCall(run, block, lane) {
  const started = Date.now();
  const apiCalls = [];
  const emit = run.emit;
  const tool = BY_NAME.get(block.name);

  // Checkpoints placed together are created in the order they were asked
  // for, so camera numbers run along the street in the order the agent
  // listed the points. The cursors still move together; only the calls,
  // each a few milliseconds, queue. The slot is taken before the first
  // await, which is what makes the order the lane order.
  let waitForTurn = null;
  let releaseTurn = () => {};
  if (block.name === "create_checkpoint") {
    waitForTurn = run.checkpointQueue;
    run.checkpointQueue = new Promise((resolve) => (releaseTurn = resolve));
  }

  let actionId = null;
  try {
    actionId = await run.statements.insertAgentAction(
      {
        projectId: run.projectId,
        runId: run.id,
        sessionId: run.session.id,
        callId: block.id,
        userRequest: run.userRequest,
        tool: block.name,
        input: block.input,
      },
      run.db,
    );
  } catch (err) {
    // No audit row, no action: an unrecorded change is worse than a refused one.
    console.error("🤖 Could not write the agent audit row:", err.message);
    releaseTurn();
    return toolResult(block.id, { error: "The action could not be recorded, so it was not run." }, true);
  }

  let confirmation = null;
  const finish = async (ok, result, extra = {}) => {
    releaseTurn();
    try {
      await run.statements.finishAgentAction(actionId, { ok, result, apiCalls, confirmation }, run.db);
    } catch (err) {
      console.error("🤖 Could not finish the agent audit row:", err.message);
    }
    emit("tool.finished", {
      call_id: block.id,
      tool: block.name,
      ok,
      result,
      api_calls: apiCalls,
      ms: Date.now() - started,
      ...extra,
    });
    return toolResult(block.id, result, !ok);
  };

  if (!tool) return finish(false, { error: `Unknown tool ${block.name}.` });

  const checked = tool.validate(block.input || {});
  if (checked.error) return finish(false, { error: `Invalid input: ${checked.error}` });

  const ctx = {
    api: createApiClient(run.apiBaseUrl, run.apiKey, run.projectId, (call) => apiCalls.push(call)),
    signal: run.signal,
    emit,
    progress: (data) => emit("tool.progress", { call_id: block.id, ...data }),
  };

  try {
    const prepared = await tool.prepare(checked.value, ctx);
    emit("tool.started", {
      call_id: block.id,
      tool: block.name,
      input: checked.value,
      lane,
      target: prepared.target,
    });

    if (prepared.confirm) {
      emit("tool.confirm_required", {
        call_id: block.id,
        tool: block.name,
        summary: prepared.confirm.summary,
        details: prepared.confirm.details,
        timeout_s: Math.round(config.confirmTimeoutMs / 1000),
      });
      confirmation = await waitForConfirmation(run, block.id);
      emit("tool.confirmed", { call_id: block.id, outcome: confirmation });
      if (confirmation !== "approved") {
        const why =
          confirmation === "declined"
            ? "The operator declined this action. Nothing was changed."
            : confirmation === "timed-out"
              ? "Nobody confirmed this action in time. Nothing was changed."
              : "The run was cancelled. Nothing was changed.";
        return finish(false, { declined: true, message: why }, { declined: true });
      }
      // The cursor carries the change out once approved (a move is dragged
      // across the map); send the call as it lands.
      if (prepared.target) await sleep(config.cursorLeadMs, run.signal);
    } else if (prepared.target) {
      // The cursor is on its way; send the call as it arrives.
      await sleep(config.cursorLeadMs, run.signal);
    }

    if (waitForTurn) await waitForTurn;
    if (run.signal.aborted) return finish(false, { error: "The run was cancelled before this ran." });

    const result = await tool.run(prepared.plan, ctx);
    return finish(true, result);
  } catch (err) {
    const message =
      err instanceof ToolError || err instanceof ApiError ? err.message : "The action failed unexpectedly.";
    if (!(err instanceof ToolError) && !(err instanceof ApiError)) {
      console.error(`🤖 Tool ${block.name} failed:`, err);
    }
    return finish(false, { error: message });
  }
}

function toolResult(toolUseId, result, isError) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(result),
    ...(isError ? { is_error: true } : {}),
  };
}

/* -------------------------------------------------------------------------
   The loop
   ------------------------------------------------------------------------- */

function requestParams(messages) {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    tools: definitions,
    messages,
    thinking: { type: config.thinking },
    output_config: { effort: config.effort },
    // Caches the tools, the system prompt and the conversation so far; each
    // loop turn then reads the prefix instead of paying for it again.
    cache_control: { type: "ephemeral" },
    // On a policy decline the API retries the request on a fallback model.
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  };
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The agent's Anthropic API key was rejected.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The agent's API key is not allowed to use this model.";
  if (err instanceof Anthropic.RateLimitError) return "The agent is rate limited right now. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "The agent could not reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `The Anthropic API returned an error (${err.status}).`;
  return "The agent stopped because of an unexpected error.";
}

/**
 * Runs one operator message to completion. `emit(event, data)` streams to
 * the console. Never throws: every failure ends in `run.error`.
 */
async function startRun({ projectId, apiKey, apiBaseUrl, sessionId, message, emit, db, statements }) {
  const session = getOrCreateSession(projectId, sessionId);
  const controller = new AbortController();
  const run = {
    id: crypto.randomUUID(),
    projectId,
    apiKey,
    apiBaseUrl,
    session,
    userRequest: message,
    controller,
    signal: controller.signal,
    confirmations: new Map(),
    checkpointQueue: Promise.resolve(),
    emit,
    db,
    statements,
  };
  runs.set(run.id, run);
  activeRunByProject.set(projectId, run.id);
  session.busy = true;
  session.lastUsed = Date.now();

  const startLength = session.messages.length;
  let consistentLength = startLength;
  let toolCallsThisRun = 0;
  let turns = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const startedAt = Date.now();

  emit("run.started", {
    run_id: run.id,
    session_id: session.id,
    model: config.model,
    limits: {
      tool_calls_per_run: config.maxToolCallsPerRun,
      turns_per_run: config.maxTurnsPerRun,
      tool_calls_per_session: config.maxToolCallsPerSession,
      tool_calls_used_in_session: session.toolCalls,
    },
  });

  session.messages.push({ role: "user", content: message });

  const stop = (kind, used, limit) => {
    emit("run.limit", { kind, used, limit });
    const text =
      kind === "session"
        ? "I've reached the action limit for this conversation. Start a new conversation to continue."
        : "I stopped because this request needed more steps than I'm allowed in one go. Tell me what to do next.";
    emit("reply", { text });
  };

  let outcome = "completed";
  try {
    for (;;) {
      if (turns >= config.maxTurnsPerRun) {
        stop("turns", turns, config.maxTurnsPerRun);
        outcome = "limit";
        break;
      }
      turns += 1;

      emit("thinking.started", { turn: turns });
      let thinkingOpen = true;
      const closeThinking = () => {
        if (thinkingOpen) emit("thinking.stopped", { turn: turns });
        thinkingOpen = false;
      };

      const blockTypes = new Map();
      const stream = anthropic().beta.messages.stream(requestParams(session.messages), {
        signal: run.signal,
      });
      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          blockTypes.set(event.index, block.type);
          if (block.type !== "thinking" && block.type !== "redacted_thinking") closeThinking();
          if (block.type === "tool_use") {
            emit("tool.pending", { call_id: block.id, tool: block.name });
          }
        }
      });
      stream.on("text", (delta) => emit("text.delta", { text: delta }));
      // With `between_tools` these are the short progress notes the model
      // writes between tool calls; with `adaptive` and the default display
      // they are empty.
      stream.on("thinking", (delta) => {
        if (delta) emit("note.delta", { text: delta });
      });

      const reply = await stream.finalMessage();
      closeThinking();
      for (const key of Object.keys(usage)) usage[key] += (reply.usage && reply.usage[key]) || 0;

      if (reply.stop_reason === "refusal") {
        // Never run tools from a refused turn, and do not keep it: the
        // conversation carries on as though this request was not made.
        session.messages.length = startLength;
        emit("reply", { text: "I can't help with that request." });
        outcome = "refused";
        break;
      }
      if (reply.stop_reason === "max_tokens") {
        session.messages.length = consistentLength;
        emit("run.error", { message: "The reply was cut off before it finished. Try a shorter request." });
        outcome = "error";
        break;
      }

      session.messages.push({ role: "assistant", content: reply.content });
      const toolUses = reply.content.filter((block) => block.type === "tool_use");

      if (toolUses.length === 0) {
        const text = reply.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
        emit("reply", { text });
        consistentLength = session.messages.length;
        break;
      }

      // Every tool_use needs a tool_result, run or not, or the conversation
      // cannot continue. Over a limit, they are answered without being run.
      const runLimitHit = toolCallsThisRun + toolUses.length > config.maxToolCallsPerRun;
      const sessionLimitHit = session.toolCalls + toolUses.length > config.maxToolCallsPerSession;
      if (runLimitHit || sessionLimitHit) {
        session.messages.push({
          role: "user",
          content: toolUses.map((block) =>
            toolResult(block.id, { error: "Not run: the action limit was reached." }, true),
          ),
        });
        consistentLength = session.messages.length;
        if (sessionLimitHit) stop("session", session.toolCalls, config.maxToolCallsPerSession);
        else stop("run", toolCallsThisRun, config.maxToolCallsPerRun);
        outcome = "limit";
        break;
      }

      toolCallsThisRun += toolUses.length;
      session.toolCalls += toolUses.length;

      // Parallel calls run in parallel: that is what puts several cursors on
      // screen at once. Lanes number the calls that get a cursor.
      // Lanes count only the calls that get a cursor, so the first cursor on
      // screen is always lane 1 whatever reads run beside it.
      let cursorLane = 0;
      const lanes = toolUses.map((block) => (CURSOR_TOOLS.has(block.name) ? ++cursorLane : 0));
      const results = await Promise.all(toolUses.map((block, index) => executeToolCall(run, block, lanes[index])));
      session.messages.push({ role: "user", content: results });
      consistentLength = session.messages.length;

      if (run.signal.aborted) {
        outcome = "cancelled";
        break;
      }
    }
  } catch (err) {
    session.messages.length = consistentLength;
    if (run.signal.aborted || err instanceof Anthropic.APIUserAbortError) {
      outcome = "cancelled";
    } else {
      outcome = "error";
      if (!(err instanceof Anthropic.APIError)) console.error("🤖 Agent run failed:", err);
      else console.error(`🤖 Agent run failed: ${err.status} ${err.message}`);
      emit("run.error", { message: describeApiError(err) });
    }
  } finally {
    // A conversation that ended halfway through a turn is put back to the
    // last point the API will accept as a continuation.
    if (session.messages.length > consistentLength) session.messages.length = consistentLength;
    session.busy = false;
    session.lastUsed = Date.now();
    activeRunByProject.delete(projectId);
    runs.delete(run.id);
  }

  emit("run.finished", {
    run_id: run.id,
    session_id: session.id,
    outcome,
    turns,
    tool_calls: toolCallsThisRun,
    tool_calls_used_in_session: session.toolCalls,
    ms: Date.now() - startedAt,
    usage,
  });
  return run.id;
}

/**
 * Starts a run and returns its id as soon as it is registered, so the
 * caller can wire cancellation before the loop gets going.
 */
function launchRun(options) {
  let resolveId;
  const idReady = new Promise((resolve) => (resolveId = resolve));
  const wrappedEmit = (event, data) => {
    if (event === "run.started") resolveId(data.run_id);
    options.emit(event, data);
  };
  const done = startRun({ ...options, emit: wrappedEmit });
  return { idReady, done };
}

module.exports = {
  launchRun,
  activeRun,
  getRun,
  answerConfirmation,
  cancelRun,
};
