"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  confirmAction,
  getAgentInfo,
  streamRun,
  type AgentEvent,
  type AgentInfo,
  type AgentTarget,
} from "@/lib/agent";

export type ActionStatus =
  | "pending"
  | "working"
  | "measuring"
  | "confirm"
  | "done"
  | "failed"
  | "declined";

export type AgentAction = {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  lane: number;
  target: AgentTarget | null;
  status: ActionStatus;
  result?: Record<string, unknown>;
  confirm?: { summary: string; details: string[] };
  /** Set when an approved action is carried out, so the cursor can drag. */
  approvedAt?: number;
  startedAt: number;
  finishedAt?: number;
};

export type AgentTurn = {
  id: number;
  request: string;
  reply: string;
  notes: string;
  actions: AgentAction[];
  status: "running" | "done" | "error" | "cancelled" | "limit";
  error?: string;
};

export type Highlights = { connectionIds: number[]; nodeIds: number[]; caption: string };

const NO_HIGHLIGHTS: Highlights = { connectionIds: [], nodeIds: [], caption: "" };

/**
 * One Dispatch conversation: sends the operator's words, folds the event
 * stream into turns and actions, and answers confirmations.
 */
export function useAgent(projectId: number, apiKey: string) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [highlights, setHighlights] = useState<Highlights>(NO_HIGHLIGHTS);

  const sessionId = useRef<string | null>(null);
  const runId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const turnSeq = useRef(0);
  /* Raw events, for things that animate rather than render (the cursors). */
  const listeners = useRef(new Set<(event: AgentEvent) => void>());

  const subscribe = useCallback((listener: (event: AgentEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!apiKey) return;
    const abort = new AbortController();
    getAgentInfo(projectId, apiKey, abort.signal)
      .then(setInfo)
      .catch(() => setInfo(null));
    return () => abort.abort();
  }, [projectId, apiKey]);

  useEffect(() => () => controller.current?.abort(), []);

  const updateTurn = useCallback((id: number, change: (turn: AgentTurn) => AgentTurn) => {
    setTurns((current) => current.map((turn) => (turn.id === id ? change(turn) : turn)));
  }, []);

  const updateAction = useCallback(
    (turnId: number, callId: string, change: (action: AgentAction) => AgentAction) => {
      updateTurn(turnId, (turn) => ({
        ...turn,
        actions: turn.actions.map((action) => (action.callId === callId ? change(action) : action)),
      }));
    },
    [updateTurn],
  );

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) return;

      turnSeq.current += 1;
      const turnId = turnSeq.current;
      setTurns((current) => [
        ...current,
        { id: turnId, request: text, reply: "", notes: "", actions: [], status: "running" },
      ]);
      setBusy(true);
      setHighlights(NO_HIGHLIGHTS);

      const abort = new AbortController();
      controller.current = abort;

      const onEvent = (event: AgentEvent) => {
        for (const listener of listeners.current) listener(event);
        switch (event.name) {
          case "run.started":
            runId.current = event.data.run_id;
            sessionId.current = event.data.session_id;
            break;
          case "thinking.started":
            setThinking(true);
            break;
          case "thinking.stopped":
            setThinking(false);
            break;
          case "note.delta":
            updateTurn(turnId, (turn) => ({ ...turn, notes: turn.notes + event.data.text }));
            break;
          case "text.delta":
            updateTurn(turnId, (turn) => ({ ...turn, reply: turn.reply + event.data.text }));
            break;
          case "tool.pending":
            updateTurn(turnId, (turn) => ({
              ...turn,
              actions: turn.actions.some((a) => a.callId === event.data.call_id)
                ? turn.actions
                : [
                    ...turn.actions,
                    {
                      callId: event.data.call_id,
                      tool: event.data.tool,
                      input: {},
                      lane: 0,
                      target: null,
                      status: "pending",
                      startedAt: Date.now(),
                    },
                  ],
            }));
            break;
          case "tool.started":
            updateAction(turnId, event.data.call_id, (action) => ({
              ...action,
              input: event.data.input,
              lane: event.data.lane,
              target: event.data.target,
              status: "working",
              startedAt: Date.now(),
            }));
            break;
          case "tool.progress":
            updateAction(turnId, event.data.call_id, (action) => ({ ...action, status: "measuring" }));
            break;
          case "tool.confirm_required":
            updateAction(turnId, event.data.call_id, (action) => ({
              ...action,
              status: "confirm",
              confirm: { summary: event.data.summary, details: event.data.details },
            }));
            break;
          case "tool.confirmed":
            updateAction(turnId, event.data.call_id, (action) => ({
              ...action,
              status: event.data.outcome === "approved" ? "working" : "declined",
              approvedAt: event.data.outcome === "approved" ? Date.now() : undefined,
            }));
            break;
          case "tool.finished":
            updateAction(turnId, event.data.call_id, (action) => ({
              ...action,
              status: event.data.ok ? "done" : event.data.declined ? "declined" : "failed",
              result: event.data.result,
              finishedAt: Date.now(),
            }));
            break;
          case "highlight":
            setHighlights({
              connectionIds: event.data.connection_ids,
              nodeIds: event.data.node_ids,
              caption: event.data.caption,
            });
            break;
          case "reply":
            // The streamed text is the same words; the final event is the
            // authoritative copy, and covers replies the server wrote itself.
            updateTurn(turnId, (turn) => ({ ...turn, reply: event.data.text }));
            break;
          case "run.limit":
            updateTurn(turnId, (turn) => ({ ...turn, status: "limit" }));
            break;
          case "run.error":
            updateTurn(turnId, (turn) => ({ ...turn, status: "error", error: event.data.message }));
            break;
          case "run.finished":
            updateTurn(turnId, (turn) => ({
              ...turn,
              status:
                turn.status === "error" || turn.status === "limit"
                  ? turn.status
                  : event.data.outcome === "cancelled"
                    ? "cancelled"
                    : "done",
            }));
            break;
        }
      };

      try {
        await streamRun(projectId, apiKey, { message: text, session_id: sessionId.current }, onEvent, abort.signal);
      } catch (err) {
        if (!abort.signal.aborted) {
          updateTurn(turnId, (turn) => ({
            ...turn,
            status: "error",
            error: err instanceof Error ? err.message : "The agent could not be reached.",
          }));
        } else {
          updateTurn(turnId, (turn) => ({ ...turn, status: "cancelled" }));
        }
      } finally {
        // Anything still in flight when the stream ends did not finish.
        updateTurn(turnId, (turn) => ({
          ...turn,
          status: turn.status === "running" ? "cancelled" : turn.status,
          actions: turn.actions.map((a) =>
            a.status === "done" || a.status === "failed" || a.status === "declined"
              ? a
              : { ...a, status: "failed", finishedAt: Date.now() },
          ),
        }));
        setThinking(false);
        setBusy(false);
        runId.current = null;
        controller.current = null;
      }
    },
    [apiKey, busy, projectId, updateAction, updateTurn],
  );

  const cancel = useCallback(() => {
    const id = runId.current;
    if (id) void cancelRun(projectId, apiKey, id).catch(() => undefined);
    controller.current?.abort();
  }, [apiKey, projectId]);

  const confirm = useCallback(
    async (callId: string, approved: boolean) => {
      const id = runId.current;
      if (!id) return;
      await confirmAction(projectId, apiKey, id, callId, approved);
    },
    [apiKey, projectId],
  );

  /** A fresh conversation: the server forgets nothing it recorded, only the context. */
  const reset = useCallback(() => {
    if (busy) return;
    sessionId.current = null;
    setTurns([]);
    setHighlights(NO_HIGHLIGHTS);
  }, [busy]);

  const currentTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return { info, turns, currentTurn, busy, thinking, highlights, send, cancel, confirm, reset, subscribe };
}
