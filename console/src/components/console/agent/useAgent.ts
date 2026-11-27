"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  confirmAction,
  getAgentInfo,
  streamRun,
  type AgentApiCall,
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
  /** How the operator answered a confirmation, if one was asked. */
  confirmation?: "approved" | "declined" | "timed-out" | "cancelled";
  /** The REST calls this action made, as the server recorded them. */
  apiCalls?: AgentApiCall[];
  /** Server-side duration of the call. */
  ms?: number;
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
  /** Shown while the API is being retried after an overload or a 5xx. */
  retrying?: string;
  startedAt: number;
  finishedAt?: number;
  model?: string;
  modelTurns?: number;
};

/** One conversation, as kept in this browser. */
export type AgentChat = {
  id: string;
  title: string;
  /** The server's conversation, while it remembers it. */
  sessionId: string | null;
  turns: AgentTurn[];
  updatedAt: number;
};

export type Highlights = { connectionIds: number[]; nodeIds: number[]; caption: string };

const NO_HIGHLIGHTS: Highlights = { connectionIds: [], nodeIds: [], caption: "" };
const MAX_CHATS = 30;

const storageKey = (projectId: number) => `sayes.chats.${projectId}`;

function loadChats(projectId: number): AgentChat[] {
  if (typeof window === "undefined" || !projectId) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    const parsed = raw ? (JSON.parse(raw) as AgentChat[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChats(projectId: number, chats: AgentChat[]) {
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(chats.slice(0, MAX_CHATS)));
  } catch {
    // Storage full or blocked: history is a convenience, not a record. The
    // audit log on the server is the record.
  }
}

const newChatId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());

const settled = (a: AgentAction) => a.status === "done" || a.status === "failed" || a.status === "declined";

/**
 * Sayes conversations: sends the operator's words, folds the event stream
 * into turns and actions, answers confirmations, and keeps past chats in
 * this browser so the operator can go back to one.
 */
export function useAgent(projectId: number, apiKey: string) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [chats, setChats] = useState<AgentChat[]>([]);
  const [chatId, setChatId] = useState<string>(() => newChatId());
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

  // History is per project and lives in this browser.
  useEffect(() => {
    if (!projectId) return;
    // Reading storage once the project is known; nothing to render before.
    setChats(loadChats(projectId));
  }, [projectId]);

  useEffect(() => () => controller.current?.abort(), []);

  // Every settled change to the open chat is written back to the list.
  useEffect(() => {
    if (busy || turns.length === 0 || !projectId) return;
    setChats((current) => {
      const chat: AgentChat = {
        id: chatId,
        title: turns[0].request.slice(0, 80),
        sessionId: sessionId.current,
        turns,
        updatedAt: Date.now(),
      };
      const next = [chat, ...current.filter((c) => c.id !== chatId)];
      saveChats(projectId, next);
      return next;
    });
  }, [busy, turns, chatId, projectId]);

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
    async (message: string, options: { retry?: boolean } = {}) => {
      const text = message.trim();
      if (!text || busy) return;

      turnSeq.current = Math.max(turnSeq.current, ...turns.map((t) => t.id)) + 1;
      const turnId = turnSeq.current;
      setTurns((current) => [
        ...current,
        { id: turnId, request: text, reply: "", notes: "", actions: [], status: "running", startedAt: Date.now() },
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
            updateTurn(turnId, (turn) => ({ ...turn, model: event.data.model }));
            break;
          case "thinking.started":
            setThinking(true);
            updateTurn(turnId, (turn) => (turn.retrying ? { ...turn, retrying: undefined } : turn));
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
          case "run.retrying":
            // The failed attempt streamed nothing that ran: drop its text and
            // the calls it announced but never started.
            updateTurn(turnId, (turn) => ({
              ...turn,
              reply: "",
              retrying: `${event.data.reason} Trying again (${event.data.attempt} of ${event.data.of})…`,
              actions: turn.actions.filter((a) => a.status !== "pending"),
            }));
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
              confirmation: event.data.outcome,
              status: event.data.outcome === "approved" ? "working" : "declined",
              approvedAt: event.data.outcome === "approved" ? Date.now() : undefined,
            }));
            break;
          case "tool.finished":
            updateAction(turnId, event.data.call_id, (action) => ({
              ...action,
              tool: event.data.tool,
              status: event.data.ok ? "done" : event.data.declined ? "declined" : "failed",
              result: event.data.result,
              apiCalls: event.data.api_calls,
              ms: event.data.ms,
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
            updateTurn(turnId, (turn) => ({ ...turn, status: "error", error: event.data.message, retrying: undefined }));
            break;
          case "run.finished":
            updateTurn(turnId, (turn) => ({
              ...turn,
              modelTurns: event.data.turns,
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
        await streamRun(
          projectId,
          apiKey,
          { message: text, session_id: sessionId.current, ...(options.retry ? { retry: true } : {}) },
          onEvent,
          abort.signal,
        );
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
          retrying: undefined,
          finishedAt: Date.now(),
          status: turn.status === "running" ? "cancelled" : turn.status,
          actions: turn.actions.map((a) => (settled(a) ? a : { ...a, status: "failed", finishedAt: Date.now() })),
        }));
        setThinking(false);
        setBusy(false);
        runId.current = null;
        controller.current = null;
      }
    },
    [apiKey, busy, projectId, turns, updateAction, updateTurn],
  );

  /** Runs a failed request again, telling the model some of it may be done. */
  const retry = useCallback(
    (turn: AgentTurn) => {
      if (busy) return;
      void send(turn.request, { retry: true });
    },
    [busy, send],
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

  /** A fresh chat: the server forgets nothing it recorded, only the context. */
  const newChat = useCallback(() => {
    if (busy) return;
    sessionId.current = null;
    setChatId(newChatId());
    setTurns([]);
    setHighlights(NO_HIGHLIGHTS);
  }, [busy]);

  /** Back to an earlier chat. If the server has since forgotten it, the next message starts afresh there. */
  const openChat = useCallback(
    (id: string) => {
      if (busy) return;
      const chat = chats.find((c) => c.id === id);
      if (!chat) return;
      sessionId.current = chat.sessionId;
      setChatId(chat.id);
      setTurns(chat.turns);
      setHighlights(NO_HIGHLIGHTS);
    },
    [busy, chats],
  );

  const deleteChat = useCallback(
    (id: string) => {
      setChats((current) => {
        const next = current.filter((c) => c.id !== id);
        saveChats(projectId, next);
        return next;
      });
      if (id === chatId) newChat();
    },
    [chatId, newChat, projectId],
  );

  const currentTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return {
    info,
    turns,
    currentTurn,
    busy,
    thinking,
    highlights,
    chats,
    chatId,
    send,
    retry,
    cancel,
    confirm,
    newChat,
    openChat,
    deleteChat,
    subscribe,
  };
}

export type AgentState = ReturnType<typeof useAgent>;
