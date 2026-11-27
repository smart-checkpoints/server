"use strict";

/**
 * Sayes's settings, all from the environment.
 *
 * The Anthropic API key is read by the SDK itself from ANTHROPIC_API_KEY, on
 * this server only. It is never sent to the console and never logged.
 */

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`⚠️  ${name}=${raw} is not an integer in [${min}, ${max}]; using ${fallback}`);
    return fallback;
  }
  return value;
}

function fraction(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    console.warn(`⚠️  ${name}=${raw} is not a number in [0, 1]; using ${fallback}`);
    return fallback;
  }
  return value;
}

function oneOf(name, fallback, allowed) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.includes(raw)) {
    console.warn(`⚠️  ${name}=${raw} is not one of ${allowed.join(", ")}; using ${fallback}`);
    return fallback;
  }
  return raw;
}

const config = {
  enabled: Boolean(process.env.ANTHROPIC_API_KEY),
  model: process.env.AGENT_MODEL || "claude-sonnet-5-5",

  // Speed first. `between_tools` is the lowest thinking setting Claude Sonnet
  // 5.5 has (no extended thinking; short progress notes between tool calls).
  // `adaptive` lets it think when it decides to. Effort must be `high` or
  // below with `between_tools`.
  thinking: oneOf("AGENT_THINKING", "between_tools", ["between_tools", "adaptive"]),
  effort: oneOf("AGENT_EFFORT", "medium", ["low", "medium", "high"]),
  maxTokens: int("AGENT_MAX_TOKENS", 8000, 1024, 64000),

  // How long the server waits between telling the console a tool call is
  // starting and making it, so the change lands as the cursor arrives. The
  // call is real either way; this only decides when it is sent.
  cursorLeadMs: int("AGENT_CURSOR_LEAD_MS", 850, 0, 5000),

  // Calls made together land one cursor after another, this far apart, so
  // the cursors take turns rather than all clicking at once. The gap shrinks
  // with each batch of a run (times the decay, down to the minimum): the
  // first batch is calm and strictly in turn, later ones overlap.
  cursorGapMs: int("AGENT_CURSOR_GAP_MS", 480, 0, 3000),
  cursorGapMinMs: int("AGENT_CURSOR_GAP_MIN_MS", 120, 0, 3000),
  cursorGapDecay: fraction("AGENT_CURSOR_GAP_DECAY", 0.6),

  // Loop guards. A run is one operator message; a session is one panel
  // conversation, which ends when the operator clears it or after idling.
  maxToolCallsPerRun: int("AGENT_MAX_TOOL_CALLS_PER_RUN", 25, 1, 200),
  maxTurnsPerRun: int("AGENT_MAX_TURNS_PER_RUN", 10, 1, 50),
  maxToolCallsPerSession: int("AGENT_MAX_TOOL_CALLS_PER_SESSION", 100, 1, 2000),
  sessionIdleMs: int("AGENT_SESSION_IDLE_MINUTES", 60, 1, 24 * 60) * 60 * 1000,
  confirmTimeoutMs: int("AGENT_CONFIRM_TIMEOUT_SECONDS", 120, 10, 3600) * 1000,
};

module.exports = { config };
