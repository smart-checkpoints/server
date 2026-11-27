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
const { takeSnapshot } = require("./restore.js");
const { createApiClient, ApiError } = require("./api.js");

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The tools whose calls the console draws a cursor for (they have a target). */
const CURSOR_TOOLS = new Set([
  "create_checkpoint",
  "import_checkpoints",
  "create_edge",
  "split_edge",
  "delete_edges",
  "delete_checkpoints",
  "bring_back",
  "restore_to",
  "set_speed_limit",
  "move_checkpoint_by",
  "move_checkpoint_to",
  "get_violation_summary",
  "get_violations",
  "get_diagnostics",
  "frame_map",
  "switch_view",
  "open_panel",
]);

/** Tools that change the network. The first one in a run saves a restore point. */
const CHANGING_TOOLS = new Set([
  "create_checkpoint",
  "import_checkpoints",
  "create_edge",
  "split_edge",
  "delete_edges",
  "delete_checkpoints",
  "set_speed_limit",
  "move_checkpoint_by",
  "move_checkpoint_to",
  "restore_to",
  "bring_back",
]);

/**
 * The network as it was before this run changed anything, saved once per
 * run, so the operator can undo the whole run. Parallel calls share it.
 */
function ensureRestorePoint(run, api) {
  if (!run.restorePoint) {
    run.restorePoint = (async () => {
      try {
        const snapshot = await takeSnapshot(api);
        const request = run.userRequest.length > 80 ? `${run.userRequest.slice(0, 79)}…` : run.userRequest;
        const name = `Before: ${request}`;
        const id = await run.statements.insertRestorePoint(
          { projectId: run.projectId, name, origin: "auto", runId: run.id, snapshot },
          run.db,
        );
        run.emit("restore_point", { restore_point_id: id, name });
        return id;
      } catch (err) {
        console.error("🤖 Could not save a restore point before the run:", err.message);
        return null;
      }
    })();
  }
  return run.restorePoint;
}

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

/**
 * How long after announcing a call to send it. Calls made together take turns
 * by lane, `gap` apart; the gap shrinks with each batch of cursor calls in a
 * run (`batch` counts from 0), so a run starts calm and gets busier.
 */
function cursorLead(lane, batch) {
  // The minimum never raises a gap set lower than it (0 turns turns off).
  const floor = Math.min(config.cursorGapMinMs, config.cursorGapMs);
  const gap = Math.max(floor, config.cursorGapMs * config.cursorGapDecay ** batch);
  return Math.round(config.cursorLeadMs + Math.max(0, lane - 1) * gap);
}

async function executeToolCall(run, block, lane, leadMs = config.cursorLeadMs) {
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
  // When the console was told the call was starting, and when it was sent:
  // the difference lets the console check its click landed on time.
  let announcedAt = null;
  let sentAt = null;
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
      ...(announcedAt !== null && sentAt !== null ? { sent_after_ms: sentAt - announcedAt } : {}),
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
    projectId: run.projectId,
    // Restore points live in this server's database, not behind the REST API.
    restorePoints: {
      list: () => run.statements.listRestorePoints(run.projectId, run.db),
      get: (id) => run.statements.getRestorePoint(id, run.projectId, run.db),
      save: (name, snapshot, origin = "agent") =>
        run.statements.insertRestorePoint({ projectId: run.projectId, name, origin, runId: run.id, snapshot }, run.db),
    },
  };

  try {
    if (CHANGING_TOOLS.has(block.name)) await ensureRestorePoint(run, ctx.api);
    const prepared = await tool.prepare(checked.value, ctx);
    emit("tool.started", {
      call_id: block.id,
      tool: block.name,
      input: checked.value,
      lane,
      target: prepared.target,
      // When the call will be sent, so the console can time the click to it.
      ...(prepared.target ? { lead_ms: leadMs } : {}),
    });
    announcedAt = Date.now();

    if (prepared.confirm) {
      emit("tool.confirm_required", {
        call_id: block.id,
        tool: block.name,
        summary: prepared.confirm.summary,
        details: prepared.confirm.details,
        timeout_s: Math.round(config.confirmTimeoutMs / 1000),
      });
      confirmation = await waitForConfirmation(run, block.id);
      emit("tool.confirmed", {
        call_id: block.id,
        outcome: confirmation,
        ...(confirmation === "approved" && prepared.target ? { lead_ms: config.cursorLeadMs } : {}),
      });
      announcedAt = Date.now();
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
      // across the map); send the call as it lands. One approval at a time,
      // so no turn to wait for.
      if (prepared.target) await sleep(config.cursorLeadMs, run.signal);
    } else if (prepared.target) {
      // The cursor is on its way; send the call as it clicks.
      await sleep(leadMs, run.signal);
    }

    if (waitForTurn) await waitForTurn;
    if (run.signal.aborted) return finish(false, { error: "The run was cancelled before this ran." });

    if (prepared.target) sentAt = Date.now();
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

/**
 * Web searches and fetches run on Anthropic's side, inside the model's turn.
 * They change nothing here, but they belong in the trace like every other
 * call, and they count against the run's web budget.
 */
function reportServerTools(run, content) {
  for (const block of content) {
    if (block.type !== "server_tool_use") continue;
    const result = content.find((b) => b.type !== "server_tool_use" && b.tool_use_id === block.id);
    if (block.name === "web_search") run.webSearches += 1;
    if (block.name === "web_fetch") run.webFetches += 1;
    let summary = { note: "No result returned." };
    let ok = false;
    if (result && Array.isArray(result.content)) {
      ok = true;
      summary = { results: result.content.filter((r) => r.type === "web_search_result").map((r) => ({ title: r.title, url: r.url })) };
    } else if (result && result.content && result.content.type === "web_fetch_result") {
      ok = true;
      summary = { url: result.content.url, title: result.content.content && result.content.content.title };
    } else if (result && result.content && result.content.error_code) {
      summary = { error: `${block.name} failed: ${result.content.error_code}` };
    } else if (result) {
      // Code execution filtering search results: its output is the model's own working.
      ok = true;
      summary = { note: `${result.type.replace(/_/g, " ")} returned` };
    }
    run.emit("tool.started", { call_id: block.id, tool: block.name, input: block.input || {}, lane: 0, target: null });
    run.emit("tool.finished", { call_id: block.id, tool: block.name, ok, result: summary, api_calls: [], ms: 0 });
  }
}

/* -------------------------------------------------------------------------
   The loop
   ------------------------------------------------------------------------- */

/** The web tools still allowed in this run, as API tool definitions. */
function webTools(run) {
  const tools = [];
  const searches = config.webSearchPerRun - run.webSearches;
  const fetches = config.webFetchesPerRun - run.webFetches;
  if (searches > 0) tools.push({ type: "web_search_20260318", name: "web_search", max_uses: searches });
  if (fetches > 0) tools.push({ type: "web_fetch_20260318", name: "web_fetch", max_uses: fetches, max_content_tokens: 8000 });
  return tools;
}

function requestParams(messages, run) {
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    tools: [...definitions, ...webTools(run)],
    messages,
    thinking: { type: config.thinking },
    output_config: { effort: run.effort.level },
    // Caches the tools, the system prompt and the conversation so far; each
    // loop turn then reads the prefix instead of paying for it again.
    cache_control: { type: "ephemeral" },
    // On a policy decline the API retries the request on a fallback model.
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  };
}

/** Overloaded, rate limited, a server error or a dropped connection: worth another try. */
function isTransient(err) {
  if (err instanceof Anthropic.APIConnectionError && !(err instanceof Anthropic.APIUserAbortError)) return true;
  if (!(err instanceof Anthropic.APIError)) return false;
  const status = err.status;
  if (status === 429 || status === 529 || (typeof status === "number" && status >= 500)) return true;
  // Overload reported inside an open stream arrives without an HTTP status.
  return /overloaded/i.test(String(err.message || ""));
}

const RETRY_WAITS_MS = [2000, 5000, 12000];

/** How long the API asked us to wait, if it said, capped so a demo never stalls for long. */
function retryAfterMs(err, fallback) {
  const header = err && err.headers && (typeof err.headers.get === "function" ? err.headers.get("retry-after") : err.headers["retry-after"]);
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 20000) : fallback;
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The agent's Anthropic API key was rejected.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The agent's API key is not allowed to use this model.";
  if (err instanceof Anthropic.RateLimitError) return "The agent is rate limited right now. Try again in a minute.";
  if (err instanceof Anthropic.APIError && (err.status === 529 || /overloaded/i.test(String(err.message || "")))) {
    return "The model is overloaded right now, and kept being overloaded after a few tries. Try again shortly.";
  }
  if (err instanceof Anthropic.APIConnectionError) return "The agent could not reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `The Anthropic API returned an error (${err.status}).`;
  return "The agent stopped because of an unexpected error.";
}

/**
 * Runs one operator message to completion. `emit(event, data)` streams to
 * the console. Never throws: every failure ends in `run.error`.
 */
async function startRun({ projectId, apiKey, apiBaseUrl, sessionId, message, retry, attachments = [], effort, emit, db, statements }) {
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
    webSearches: 0,
    webFetches: 0,
    // The effort for this request: the operator's pick, or Auto's (effort.js).
    effort: effort || { level: config.effort, chosen: "server", reason: "the server's default" },
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
  /** Batches of calls that had a cursor so far this run: sets the turn gap. */
  let cursorBatches = 0;
  let toolCallsThisRun = 0;
  let turns = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const startedAt = Date.now();

  emit("run.started", {
    run_id: run.id,
    session_id: session.id,
    model: config.model,
    effort: run.effort,
    limits: {
      tool_calls_per_run: config.maxToolCallsPerRun,
      turns_per_run: config.maxTurnsPerRun,
      tool_calls_per_session: config.maxToolCallsPerSession,
      tool_calls_used_in_session: session.toolCalls,
    },
  });

  // A retry after a failed run: some of the request may already be done, and
  // the model is told so rather than being sent the same words again.
  const text = retry
    ? `(The previous attempt at this request stopped with an error before it finished. Some of it may already be done: check the network first, then finish only what is left.)

${message}`
    : message;
  // Attachments go before the words, so the request reads as being about them.
  session.messages.push({
    role: "user",
    content: attachments.length > 0 ? [...attachments, { type: "text", text }] : text,
  });

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

      let reply;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const blockTypes = new Map();
          const stream = anthropic().beta.messages.stream(requestParams(session.messages, run), {
            signal: run.signal,
          });
          stream.on("streamEvent", (event) => {
            if (event.type === "content_block_start") {
              const block = event.content_block;
              blockTypes.set(event.index, block.type);
              if (block.type !== "thinking" && block.type !== "redacted_thinking") closeThinking();
              if (block.type === "tool_use" || block.type === "server_tool_use") {
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

          reply = await stream.finalMessage();
          break;
        } catch (err) {
          if (run.signal.aborted || !isTransient(err) || attempt >= RETRY_WAITS_MS.length) throw err;
          const waitMs = retryAfterMs(err, RETRY_WAITS_MS[attempt]);
          console.warn(`🤖 Anthropic API ${err.status || "connection"} error, retrying in ${waitMs} ms`);
          // Whatever streamed before the failure is dropped by the console;
          // tools only run from a finished message, so none ran.
          emit("run.retrying", { attempt: attempt + 1, of: RETRY_WAITS_MS.length, wait_ms: waitMs, reason: describeApiError(err) });
          await sleep(waitMs, run.signal);
          if (run.signal.aborted) throw err;
        }
      }
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
      reportServerTools(run, reply.content);

      // A long server-side tool turn (web search) can pause; it is resumed by
      // sending the conversation back as it is.
      if (reply.stop_reason === "pause_turn") {
        consistentLength = session.messages.length;
        continue;
      }
      const toolUses = reply.content.filter((block) => block.type === "tool_use");

      if (toolUses.length === 0) {
        // Only the text after the last tool block is the answer; text before
        // a web search is the model saying what it is about to do.
        const lastTool = reply.content.reduce((at, block, i) => (block.type === "text" ? at : i), -1);
        const text = reply.content
          .slice(lastTool + 1)
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
      const batch = cursorBatches;
      if (cursorLane > 0) cursorBatches += 1;
      const results = await Promise.all(
        toolUses.map((block, index) => executeToolCall(run, block, lanes[index], cursorLead(lanes[index], batch))),
      );
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
