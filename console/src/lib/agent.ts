/**
 * The Sayes agent's wire contract, and the calls the console makes to it.
 *
 * A run is one POST that answers with a Server-Sent Events stream. The stream
 * says what the agent is doing as it does it; the changes themselves arrive
 * over the existing Socket.IO channel like any other change, because the agent
 * makes them through the same REST API the console uses.
 */

export type AgentTarget =
  | { kind: "point"; latitude: number; longitude: number }
  | { kind: "edge-new"; from_node_id: number; to_node_id: number }
  | { kind: "edge"; connection_id: number }
  | { kind: "node-move"; node_id: number; to: { latitude: number; longitude: number } }
  | { kind: "ui"; element: "violations" | "quality" };

export type AgentApiCall = { method: string; path: string; status: number; ms: number };

export type AgentInfo = {
  enabled: boolean;
  reason?: string;
  model: string;
  thinking: string;
  effort: string;
  cursor_lead_ms: number;
  /** How far apart calls made together land, and how that shrinks per batch. */
  cursor_gap?: { ms: number; min_ms: number; decay: number };
  limits: { tool_calls_per_run: number; turns_per_run: number; tool_calls_per_session: number };
  busy: boolean;
  places: string[];
};

/** Every event a run can send, by name. */
export type AgentEvents = {
  "run.started": { run_id: string; session_id: string; model: string };
  "thinking.started": { turn: number };
  "thinking.stopped": { turn: number };
  "note.delta": { text: string };
  "text.delta": { text: string };
  "tool.pending": { call_id: string; tool: string };
  "tool.started": {
    call_id: string;
    tool: string;
    input: Record<string, unknown>;
    lane: number;
    target: AgentTarget | null;
    /** For a call with a target: when the server will send it, from now. */
    lead_ms?: number;
  };
  "tool.progress": { call_id: string; state: "measuring"; note: string };
  "tool.confirm_required": {
    call_id: string;
    tool: string;
    summary: string;
    details: string[];
    timeout_s: number;
  };
  "tool.confirmed": {
    call_id: string;
    outcome: "approved" | "declined" | "timed-out" | "cancelled";
    /** Approved with a target: when the server will send it, from now. */
    lead_ms?: number;
  };
  "tool.finished": {
    call_id: string;
    tool: string;
    ok: boolean;
    declined?: boolean;
    result: Record<string, unknown>;
    api_calls: AgentApiCall[];
    ms: number;
    /** For a call with a target: how long after its last announcement it was sent. */
    sent_after_ms?: number;
  };
  highlight: { connection_ids: number[]; node_ids: number[]; caption: string };
  reply: { text: string };
  "run.limit": { kind: string; used: number; limit: number };
  "run.error": { message: string };
  "run.finished": {
    run_id: string;
    session_id: string;
    outcome: string;
    turns: number;
    tool_calls: number;
    ms: number;
  };
};

export type AgentEventName = keyof AgentEvents;
export type AgentEvent = { [K in AgentEventName]: { name: K; data: AgentEvents[K] } }[AgentEventName];

export type AuditRow = {
  action_id: number;
  run_id: string;
  user_request: string;
  tool: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  ok: boolean | null;
  api_calls: AgentApiCall[];
  confirmation: string | null;
  started_at: string;
  finished_at: string | null;
};

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload && payload.error ? String(payload.error) : `HTTP ${response.status}`);
  }
  return payload as T;
}

export function getAgentInfo(projectId: number, apiKey: string, signal?: AbortSignal) {
  return fetch(`/project/${projectId}/agent`, { headers: { "x-api-key": apiKey }, signal }).then((r) =>
    json<AgentInfo>(r),
  );
}

export function getAudit(projectId: number, apiKey: string, limit = 100) {
  return fetch(`/project/${projectId}/agent/audit?limit=${limit}`, { headers: { "x-api-key": apiKey } }).then(
    (r) => json<AuditRow[]>(r),
  );
}

export function confirmAction(projectId: number, apiKey: string, runId: string, callId: string, approved: boolean) {
  return fetch(`/project/${projectId}/agent/runs/${runId}/confirm`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ call_id: callId, approved }),
  }).then((r) => json<{ success: true }>(r));
}

export function cancelRun(projectId: number, apiKey: string, runId: string) {
  return fetch(`/project/${projectId}/agent/runs/${runId}/cancel`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
  }).then((r) => json<{ success: true }>(r));
}

/**
 * Starts a run and calls `onEvent` for each event as it arrives. Resolves
 * when the stream ends. Aborting `signal` closes the stream, which the server
 * takes as a cancellation.
 */
export async function streamRun(
  projectId: number,
  apiKey: string,
  body: { message: string; session_id?: string | null },
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/project/${projectId}/agent/runs`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    await json(response);
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let name = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!name || !data) continue;
      try {
        onEvent({ name, data: JSON.parse(data) } as AgentEvent);
      } catch {
        // A malformed frame is skipped, not fatal.
      }
    }
  }
}
