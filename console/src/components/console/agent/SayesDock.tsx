"use client";

import { motion } from "framer-motion";
import {
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { GraphCanvasHandle } from "@/components/console/GraphCanvas";
import type { AgentAttachment, AgentUiControl } from "@/lib/agent";
import { cn } from "@/lib/cn";
import { houseEase } from "@/lib/ease";
import CursorLayer from "./CursorLayer";
import type { ReplayMask } from "./cursors/replayMask";
import Markdown from "./Markdown";
import { ReportCard, RestoreButton, RestoreContext, RestorePointList } from "./RestorePoints";
import SayesMark from "./SayesMark";
import { describeAction, EXAMPLE_PROMPTS, laneColour, type CameraOf } from "./labels";
import { useAgent, type AgentAction, type AgentChat, type AgentTurn, type Highlights } from "./useAgent";

export type SayesDockProps = {
  projectId: number;
  apiKey: string;
  /** The map the cursors move over. */
  canvas: RefObject<GraphCanvasHandle | null>;
  cameraOf: CameraOf;
  presentation: boolean;
  onTogglePresentation: () => void;
  /** What Sayes highlighted on the map, for the page to draw. */
  onHighlights: (highlights: Highlights) => void;
  /** Whether the open chat has any messages. */
  onActiveChange?: (active: boolean) => void;
  /** Carries out what Sayes asked the console to show: framing, the view, a panel. */
  onControl?: (control: AgentUiControl) => void;
  /** While the last run is replayed, how the page should draw the graph (see CursorLayer). */
  onReplayMask?: (mask: ReplayMask | null) => void;
};

const OPEN_KEY = "sayes.open";
const NO_ACTIONS: AgentAction[] = [];
const noReplay = () => {};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = () => (isMac() ? "⌘" : "Ctrl");

/**
 * Sayes, the whole of it: the panel docked on the right of the console, its
 * cursors over the map, and the keyboard shortcuts. A page mounts this one
 * component beside its canvas, in a flex row, and the canvas gives up the
 * panel's width when it opens.
 *
 *   Ctrl/⌘ + .           open or close the panel (remembered in this browser)
 *   Ctrl/⌘ + Shift + .   presentation mode
 */
export default function SayesDock(props: SayesDockProps) {
  const agent = useAgent(props.projectId, props.apiKey);
  const { info, turns, busy, thinking } = agent;
  const presentation = props.presentation;
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<"chat" | "history" | "restore">("chat");
  const origin = useRef<HTMLSpanElement>(null);

  const { onHighlights, onTogglePresentation, cameraOf } = props;
  useEffect(() => onHighlights(agent.highlights), [agent.highlights, onHighlights]);
  const { onActiveChange, onControl } = props;
  const { subscribe } = agent;
  useEffect(
    () =>
      subscribe((event) => {
        if (event.name === "ui.control") onControl?.(event.data);
      }),
    [subscribe, onControl],
  );
  const active = turns.length > 0;
  useEffect(() => onActiveChange?.(active), [active, onActiveChange]);

  // Remembered open or closed. Read after mount: the page is prerendered.
  const restored = useRef(false);
  // The remembered state is applied without animating, so a reload does not
  // show the panel closing.
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const stored = window.localStorage.getItem(OPEN_KEY);
    restored.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored === "0") setOpen(false);
    const frame = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    try {
      window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // Not remembered; still works.
    }
  }, [open]);
  const setOpenSaved = setOpen;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // By position first (any keyboard layout), by character as a fallback.
      const period = event.code === "Period" || event.key === "." || event.key === ">";
      if (!(event.ctrlKey || event.metaKey) || !period) return;
      event.preventDefault();
      if (event.shiftKey) onTogglePresentation();
      else setOpen((was) => !was);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTogglePresentation]);

  // A card waiting for the operator must be seen: open the panel for it.
  const waiting = agent.currentTurn?.actions.some((a) => a.status === "confirm") ?? false;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (waiting) setOpen(true);
  }, [waiting]);

  const disabled = !info || !info.enabled;
  const restoreContext = useMemo(
    () => ({ projectId: props.projectId, apiKey: props.apiKey, busy }),
    [props.projectId, props.apiKey, busy],
  );
  const status = disabled ? "Off" : busy ? (thinking ? "Thinking…" : "Working…") : "Ready";
  const width = presentation ? 480 : 400;

  return (
    <>
      <motion.aside
        aria-label="Sayes"
        initial={false}
        animate={{ width: open ? width : 0 }}
        transition={{ duration: animated ? 0.32 : 0, ease: houseEase }}
        className="relative z-20 h-full shrink-0 overflow-hidden border-l border-border bg-surface"
        style={{ borderLeftWidth: open ? 1 : 0 }}
      >
        <RestoreContext.Provider value={restoreContext}>
        <div className="flex h-full flex-col" style={{ width }}>
          <header className="flex items-center gap-3 border-b border-border px-4 py-3">
            <span
              ref={open ? origin : undefined}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan text-surface"
              aria-hidden="true"
            >
              <SayesMark size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="flex items-baseline gap-2 font-display text-base font-bold text-text">
                Sayes
                <span lang="ar" dir="rtl" className="font-sans text-sm font-medium text-text-dim">
                  سايس
                </span>
              </h2>
              <p className="truncate font-mono text-xs text-text-dim" aria-live="polite">
                {status}
              </p>
            </div>
            <IconButton
              label={view === "history" ? "Back to the chat" : "Previous chats"}
              active={view === "history"}
              onClick={() => setView(view === "history" ? "chat" : "history")}
            >
              <path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 3v2.5H6M8 5.5V8l1.8 1.2" />
            </IconButton>
            <IconButton
              label={view === "restore" ? "Back to the chat" : "Restore points"}
              active={view === "restore"}
              onClick={() => setView(view === "restore" ? "chat" : "restore")}
            >
              <path d="M3 8a5 5 0 1 0 1.5-3.6M3 3v2.6h2.6M8 5.2V8" />
            </IconButton>
            <IconButton
              label="New chat"
              disabled={busy}
              onClick={() => {
                agent.newChat();
                setView("chat");
              }}
            >
              <path d="M8 3.5v9M3.5 8h9" />
            </IconButton>
            <IconButton label={`Close Sayes (${modKey()} + .)`} onClick={() => setOpenSaved(false)}>
              <path d="M6 4l4 4-4 4" />
            </IconButton>
          </header>

          {view === "restore" ? (
            <RestorePointList />
          ) : view === "history" ? (
            <History
              chats={agent.chats}
              current={agent.chatId}
              busy={busy}
              onOpen={(id) => {
                agent.openChat(id);
                setView("chat");
              }}
              onDelete={agent.deleteChat}
            />
          ) : (
            <Thread
              disabled={disabled}
              reason={info?.reason}
              turns={turns}
              busy={busy}
              thinking={thinking}
              presentation={presentation}
              cameraOf={cameraOf}
              onConfirm={agent.confirm}
              onRetry={agent.retry}
              onPick={(text) => void agent.send(text)}
            />
          )}

          <Composer
            disabled={disabled}
            busy={busy}
            onSend={(text, attachments) => {
              setView("chat");
              void agent.send(text, { attachments });
            }}
            onStop={agent.cancel}
          />
        </div>
        </RestoreContext.Provider>
      </motion.aside>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpenSaved(true)}
          title={`Open Sayes (${modKey()} + .)`}
          aria-label="Open Sayes"
          className="fixed bottom-6 right-6 z-30 inline-flex h-12 w-12 items-center justify-center rounded-full bg-cyan text-surface shadow-lg transition-transform duration-200 hover:scale-105"
        >
          <span ref={origin} className="inline-flex">
            <SayesMark size={26} />
          </span>
          {busy ? <span className="agent-spin absolute inset-0 rounded-full border-2 border-surface/70 border-t-transparent" /> : null}
        </button>
      ) : null}

      <CursorLayer
        actions={agent.currentTurn?.actions ?? NO_ACTIONS}
        subscribe={agent.subscribe}
        canvas={props.canvas}
        origin={origin}
        leadMs={info?.cursor_lead_ms ?? 850}
        cameraOf={cameraOf}
        info={info}
        presentation={presentation}
        onReplayMask={props.onReplayMask ?? noReplay}
      />
    </>
  );
}

/* -------------------------------------------------------------------------
   Header pieces
   ------------------------------------------------------------------------- */

function IconButton({
  label,
  onClick,
  children,
  active,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 disabled:opacity-40",
        active ? "bg-cyan-glow text-cyan-dark" : "text-text-dim hover:bg-surface-hover hover:text-cyan-dark",
      )}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function History({
  chats,
  current,
  busy,
  onOpen,
  onDelete,
}: {
  chats: AgentChat[];
  current: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <p className="px-3 pb-2 text-xs text-text-dim">Chats are kept in this browser. Every action is also in the server&apos;s audit log.</p>
      {chats.length === 0 ? <p className="px-3 text-sm text-text-dim">No previous chats yet.</p> : null}
      <ul>
        {chats.map((chat) => (
          <li key={chat.id} className="group flex items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpen(chat.id)}
              className={cn(
                "min-w-0 flex-1 rounded-xl px-3 py-2.5 text-left transition-colors duration-200 disabled:opacity-50",
                chat.id === current ? "bg-cyan-glow" : "hover:bg-surface-hover",
              )}
            >
              <span className="block truncate text-sm text-text">{chat.title}</span>
              <span className="block font-mono text-[0.6875rem] text-text-dim">
                {ago(chat.updatedAt)} · {chat.turns.length} message{chat.turns.length === 1 ? "" : "s"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(chat.id)}
              aria-label={`Remove "${chat.title}" from this browser`}
              title="Remove from this browser"
              className="mr-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-text-dim opacity-0 transition-opacity duration-200 hover:text-text group-hover:opacity-100 focus:opacity-100"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------
   The conversation
   ------------------------------------------------------------------------- */

function Thread({
  disabled,
  reason,
  turns,
  busy,
  thinking,
  presentation,
  cameraOf,
  onConfirm,
  onRetry,
  onPick,
}: {
  disabled: boolean;
  reason?: string;
  turns: AgentTurn[];
  busy: boolean;
  thinking: boolean;
  presentation: boolean;
  cameraOf: CameraOf;
  onConfirm: (callId: string, approved: boolean) => Promise<void>;
  onRetry: (turn: AgentTurn) => void;
  onPick: (text: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-5">
      {disabled ? (
        <p className="rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-text-dim">
          {reason ?? "The agent is not available on this server."}
        </p>
      ) : turns.length === 0 ? (
        <Welcome onPick={onPick} presentation={presentation} />
      ) : (
        turns.map((turn, index) => {
          const last = index === turns.length - 1;
          return (
            <Turn
              key={turn.id}
              turn={turn}
              live={last && busy}
              thinking={last && thinking}
              canRetry={last && !busy && turn.status === "error"}
              presentation={presentation}
              cameraOf={cameraOf}
              onConfirm={onConfirm}
              onRetry={onRetry}
            />
          );
        })
      )}
    </div>
  );
}

function Welcome({ onPick, presentation }: { onPick: (text: string) => void; presentation: boolean }) {
  return (
    <div>
      <p className="text-sm text-text">Say what you want set up, in plain words. Each step happens on the map as Sayes does it.</p>
      {!presentation ? (
        <ul className="mt-4 space-y-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => onPick(prompt)}
                className="w-full rounded-xl border border-border px-4 py-3 text-left text-sm text-text-dim transition-colors duration-200 hover:border-cyan hover:text-text"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-6 font-mono text-[0.6875rem] text-text-dim">
        {modKey()} + . hides this panel · {modKey()} + Shift + . presents
      </p>
    </div>
  );
}

function Turn({
  turn,
  live,
  thinking,
  canRetry,
  presentation,
  cameraOf,
  onConfirm,
  onRetry,
}: {
  turn: AgentTurn;
  live: boolean;
  thinking: boolean;
  canRetry: boolean;
  presentation: boolean;
  cameraOf: CameraOf;
  onConfirm: (callId: string, approved: boolean) => Promise<void>;
  onRetry: (turn: AgentTurn) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-bg-subtle px-4 py-2.5 text-sm text-text">
          {turn.attachments?.length ? (
            <ul className="mb-1.5 flex flex-wrap gap-1">
              {turn.attachments.map((file) => (
                <li key={file.name} className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[0.6875rem] text-text-dim">
                  {file.name}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="whitespace-pre-wrap">{turn.request}</p>
        </div>
      </div>

      {turn.notes ? <p className="text-sm italic text-text-dim">{turn.notes.trim()}</p> : null}

      {turn.actions.length > 0 ? (
        <ol className="space-y-1.5">
          {turn.actions.map((action) => (
            <ActionRow key={action.callId} action={action} cameraOf={cameraOf} onConfirm={onConfirm} />
          ))}
        </ol>
      ) : null}

      {turn.retrying ? <p className="font-mono text-xs text-text-dim">{turn.retrying}</p> : null}
      {live && thinking ? <Working /> : null}

      {turn.reply ? <Markdown text={turn.reply} className="space-y-2 text-sm leading-relaxed text-text" /> : null}
      {turn.reports?.map((report) => <ReportCard key={report.id} report={report} />)}
      {turn.error ? (
        <div className="rounded-xl border border-red/40 px-4 py-3 text-sm text-text">
          <p>{turn.error}</p>
          {canRetry ? (
            <button
              type="button"
              onClick={() => onRetry(turn)}
              className="btn btn-secondary mt-3 rounded-full px-4 py-1.5 text-xs font-semibold"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      {turn.status === "cancelled" ? <p className="font-mono text-xs text-text-dim">Stopped.</p> : null}

      {!live && turn.restorePoint && turn.actions.some((a) => a.status === "done") ? (
        <RestoreButton id={turn.restorePoint.id} label="Undo this" />
      ) : null}

      {!live && !presentation && turn.actions.length > 0 ? <Trace turn={turn} /> : null}
    </section>
  );
}

function Working() {
  return (
    <p className="flex items-center gap-2 font-mono text-xs text-text-dim" aria-live="polite">
      <span className="agent-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      Thinking
    </p>
  );
}

function ActionRow({
  action,
  cameraOf,
  onConfirm,
}: {
  action: AgentAction;
  cameraOf: CameraOf;
  onConfirm: (callId: string, approved: boolean) => Promise<void>;
}) {
  const { title, outcome } = describeAction(action, cameraOf);
  const settled = action.status === "done" || action.status === "failed" || action.status === "declined";
  return (
    <li>
      <div className="flex items-start gap-2.5 text-sm">
        <StatusMark action={action} />
        <span className={cn("min-w-0 flex-1", action.status === "failed" || action.status === "declined" ? "text-text-dim" : "text-text")}>
          {settled ? outcome : title}
          {action.status === "measuring" ? <span className="ml-1 text-text-dim">…</span> : null}
        </span>
      </div>
      {action.status === "confirm" && action.confirm ? <ConfirmCard action={action} onConfirm={onConfirm} /> : null}
    </li>
  );
}

function StatusMark({ action }: { action: AgentAction }) {
  const colour = action.target ? laneColour(action.lane) : "var(--text-dim)";
  if (action.status === "done") {
    return (
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-label="Done">
        <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" fill="none" stroke="var(--cyan-dark)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (action.status === "failed") {
    return (
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-label="Failed">
        <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" fill="none" stroke="var(--red)" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    );
  }
  if (action.status === "declined") {
    return (
      <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0" aria-label="Declined">
        <path d="M4 8 L12 8" fill="none" stroke="var(--text-dim)" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-label="In progress">
      <span
        className={cn("h-3 w-3 rounded-full border-2", action.status === "confirm" ? "" : "agent-spin")}
        style={{ borderColor: colour, borderTopColor: action.status === "confirm" ? colour : "transparent" }}
      />
    </span>
  );
}

function ConfirmCard({ action, onConfirm }: { action: AgentAction; onConfirm: (callId: string, approved: boolean) => Promise<void> }) {
  const [sending, setSending] = useState(false);
  const answer = async (approved: boolean) => {
    setSending(true);
    try {
      await onConfirm(action.callId, approved);
    } catch {
      setSending(false);
    }
  };
  return (
    <div className="agent-confirm mt-2 ml-6 rounded-xl border border-cyan bg-surface p-4 shadow-md" role="alertdialog" aria-label="Confirm action">
      <p className="font-display text-sm font-bold text-text">{action.confirm?.summary}</p>
      <ul className="mt-2 space-y-1">
        {action.confirm?.details.map((line) => (
          <li key={line} className="text-xs text-text-dim">
            {line}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={sending} onClick={() => void answer(true)} className="btn btn-primary rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
          Approve
        </button>
        <button type="button" disabled={sending} onClick={() => void answer(false)} className="btn btn-secondary rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
          Decline
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Trace: every call behind one reply, read-only
   ------------------------------------------------------------------------- */

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

function Trace({ turn }: { turn: AgentTurn }) {
  const [open, setOpen] = useState(false);
  const total = turn.finishedAt ? turn.finishedAt - turn.startedAt : 0;
  const calls = turn.actions.length;
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 font-mono text-[0.6875rem] text-text-dim transition-colors duration-200 hover:text-cyan-dark"
      >
        <svg viewBox="0 0 16 16" className={cn("h-3 w-3 transition-transform duration-200", open && "rotate-90")} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
        Trace · {calls} call{calls === 1 ? "" : "s"} · {seconds(total)}
        {turn.modelTurns ? ` · ${turn.modelTurns} model turn${turn.modelTurns === 1 ? "" : "s"}` : ""}
      </button>
      {open ? (
        <ol className="mt-2 space-y-2">
          {turn.actions.map((action) => (
            <TraceRow key={action.callId} action={action} />
          ))}
          {turn.model ? <li className="font-mono text-[0.6875rem] text-text-dim">model {turn.model}</li> : null}
        </ol>
      ) : null}
    </div>
  );
}

function TraceRow({ action }: { action: AgentAction }) {
  const [open, setOpen] = useState(false);
  const error = action.result && typeof action.result.error === "string" ? (action.result.error as string) : null;
  const state =
    action.status === "done" ? "ok" : action.status === "declined" ? "declined" : action.status === "failed" ? "failed" : action.status;
  return (
    <li className="rounded-lg border border-border">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-baseline gap-2 px-3 py-2 text-left">
        <span className="font-mono text-xs font-semibold text-text">{action.tool}</span>
        <span className={cn("font-mono text-[0.6875rem]", state === "failed" ? "text-red" : "text-text-dim")}>{state}</span>
        <span className="ml-auto font-mono text-[0.6875rem] text-text-dim">{action.ms !== undefined ? `${action.ms} ms` : ""}</span>
      </button>
      {action.apiCalls && action.apiCalls.length > 0 ? (
        <ul className="px-3 pb-2">
          {action.apiCalls.map((call, index) => (
            <li key={index} className="font-mono text-[0.6875rem] text-text-dim">
              {call.method} {call.path} <span className={call.status >= 400 || call.status === 0 ? "text-red" : ""}>{call.status || "no answer"}</span> · {call.ms} ms
            </li>
          ))}
        </ul>
      ) : null}
      {action.confirmation ? <p className="px-3 pb-2 font-mono text-[0.6875rem] text-text-dim">confirmation: {action.confirmation}</p> : null}
      {error ? <p className="px-3 pb-2 text-xs text-text">{error}</p> : null}
      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <Json label="Input" value={action.input} />
          <Json label="Result" value={action.result ?? null} />
        </div>
      ) : null}
    </li>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="font-mono text-[0.6875rem] font-semibold text-text-dim">{label}</p>
      <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-bg-subtle p-2 font-mono text-[0.6875rem] leading-relaxed text-text">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Composer
   ------------------------------------------------------------------------- */

const ACCEPT: Record<string, { label: string; maxBytes: number }> = {
  "image/png": { label: "image", maxBytes: 5 * 1024 * 1024 },
  "image/jpeg": { label: "image", maxBytes: 5 * 1024 * 1024 },
  "image/webp": { label: "image", maxBytes: 5 * 1024 * 1024 },
  "image/gif": { label: "image", maxBytes: 5 * 1024 * 1024 },
  "application/pdf": { label: "PDF", maxBytes: 10 * 1024 * 1024 },
  "text/csv": { label: "CSV", maxBytes: 512 * 1024 },
};
const MAX_FILES = 5;

/** Windows reports CSV files as Excel, or as nothing at all. */
function typeOf(file: File) {
  if (/\.csv$/i.test(file.name)) return "text/csv";
  return file.type;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function Composer({
  disabled,
  busy,
  onSend,
  onStop,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string, attachments: AgentAttachment[]) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AgentAttachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Grows with the text, up to about eight lines, then scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const add = async (list: FileList | File[]) => {
    setProblem(null);
    const next = [...files];
    for (const file of Array.from(list)) {
      const type = typeOf(file);
      const rule = ACCEPT[type];
      if (!rule) {
        setProblem(`${file.name}: only images (PNG, JPEG, WebP, GIF), PDFs and CSV files can be attached.`);
        continue;
      }
      if (file.size > rule.maxBytes) {
        setProblem(`${file.name} is larger than ${rule.maxBytes / 1024 / 1024} MB.`);
        continue;
      }
      if (next.length >= MAX_FILES) {
        setProblem(`At most ${MAX_FILES} files per message.`);
        break;
      }
      next.push({ name: file.name, type, data: await readBase64(file) });
    }
    setFiles(next);
  };

  const submit = () => {
    if ((!draft.trim() && files.length === 0) || busy || disabled) return;
    onSend(draft, files);
    setDraft("");
    setFiles([]);
    setProblem(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <footer
      className="border-t border-border p-3"
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled && event.dataTransfer.files.length) void add(event.dataTransfer.files);
      }}
    >
      {files.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-bg-subtle py-1 pl-3 pr-1 text-xs text-text"
            >
              <span className="font-mono text-[0.6875rem] text-text-dim">{ACCEPT[file.type]?.label}</span>
              <span className="truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => setFiles(files.filter((_, i) => i !== index))}
                aria-label={`Remove ${file.name}`}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-text-dim hover:text-text"
              >
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? <p className="mb-2 text-xs text-text-dim">{problem}</p> : null}
      <div
        className={cn(
          "flex items-end gap-2 rounded-2xl border bg-surface px-2 py-2 focus-within:border-cyan",
          dragging ? "border-cyan bg-cyan-glow" : "border-border-strong",
        )}
      >
        <input
          ref={picker}
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.csv,image/png,image/jpeg,image/webp,image/gif,application/pdf,text/csv"
          className="hidden"
          onChange={(event) => {
            if (event.target.files) void add(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={disabled}
          aria-label="Attach images, a PDF or a CSV"
          title="Attach images, a PDF or a CSV (or drop them here)"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-dim transition-colors duration-200 hover:bg-surface-hover hover:text-cyan-dark disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2" />
          </svg>
        </button>
        <textarea
          ref={box}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              void add(event.clipboardData.files);
            }
          }}
          disabled={disabled}
          rows={1}
          dir="auto"
          placeholder="Tell Sayes what to set up…"
          aria-label="Message to Sayes"
          className="sayes-input max-h-[200px] min-h-[1.75rem] flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-text outline-none placeholder:text-text-dim"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text text-surface"
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-surface" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || (!draft.trim() && files.length === 0)}
            aria-label="Send"
            title="Send (Enter). New line: Shift + Enter"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan text-surface transition-opacity duration-200 disabled:opacity-40"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </div>
    </footer>
  );
}
