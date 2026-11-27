"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { GraphCanvasHandle } from "@/components/console/GraphCanvas";
import type { AgentAttachment, AgentEffort, AgentUiControl } from "@/lib/agent";
import { cn } from "@/lib/cn";
import { houseEase } from "@/lib/ease";
import CursorLayer from "./CursorLayer";
import { DEFAULT_LEAD_MS } from "./cursors/director";
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
const WIDTH_KEY = "sayes.width";
const EFFORT_KEY = "sayes.effort";
const MIN_WIDTH = 360;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 420;
/** The gap between the panel and the screen edges, in px. */
const GAP = 16;
const NO_ACTIONS: AgentAction[] = [];
const noReplay = () => {};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = () => (isMac() ? "⌘" : "Ctrl");

/** Wide enough to read, never so wide the canvas has no room. */
const clampWidth = (w: number) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w, typeof window === "undefined" ? MAX_WIDTH : window.innerWidth - 480)));

/**
 * Sayes, the whole of it: a panel floating over the right of the canvas,
 * its launcher when it is closed, its cursors over the map, and the keyboard
 * shortcuts. The canvas keeps its full width underneath; the panel publishes
 * how much of the right edge it covers as `--sayes-inset` on <html>, so the
 * page's own overlays and the camera's framing can stay clear of it.
 *
 *   Ctrl/⌘ + .           open or close the panel
 *   Ctrl/⌘ + Shift + .   presentation mode
 *
 * Open or closed, the width (drag the left edge) and the effort are
 * remembered in this browser.
 */
export default function SayesDock(props: SayesDockProps) {
  const agent = useAgent(props.projectId, props.apiKey);
  const { info, turns, busy, thinking } = agent;
  const presentation = props.presentation;
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [effort, setEffort] = useState<AgentEffort>("auto");
  const [view, setView] = useState<"chat" | "history" | "restore">("chat");
  const origin = useRef<HTMLSpanElement>(null);
  const attachments = useAttachments();

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

  // Remembered settings. Read after mount: the page is prerendered.
  const restored = useRef(false);
  useEffect(() => {
    const stored = window.localStorage.getItem(OPEN_KEY);
    const storedWidth = Number(window.localStorage.getItem(WIDTH_KEY));
    const storedEffort = window.localStorage.getItem(EFFORT_KEY);
    restored.current = true;
    /* eslint-disable react-hooks/set-state-in-effect */
    if (stored === "0") setOpen(false);
    if (storedWidth) setWidth(clampWidth(storedWidth));
    if (storedEffort === "auto" || storedEffort === "low" || storedEffort === "medium" || storedEffort === "high") {
      setEffort(storedEffort);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  useEffect(() => {
    if (!restored.current) return;
    try {
      window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
      window.localStorage.setItem(WIDTH_KEY, String(width));
      window.localStorage.setItem(EFFORT_KEY, effort);
    } catch {
      // Not remembered; still works.
    }
  }, [open, width, effort]);

  // How much of the canvas the panel covers, for the page's overlays.
  const panelWidth = presentation ? Math.max(width, 480) : width;
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--sayes-inset", open ? `${panelWidth + GAP}px` : "0px");
    // Along the bottom edge the closed launcher takes room too.
    root.style.setProperty("--sayes-bottom-inset", open ? `${panelWidth + GAP}px` : "88px");
    return () => {
      root.style.removeProperty("--sayes-inset");
      root.style.removeProperty("--sayes-bottom-inset");
    };
  }, [open, panelWidth]);

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

  // Dragging the left edge resizes the panel.
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => setWidth(clampWidth(startWidth + (startX - e.clientX)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const [dragging, setDragging] = useState(false);
  const disabled = !info || !info.enabled;
  const restoreContext = useMemo(
    () => ({ projectId: props.projectId, apiKey: props.apiKey, busy }),
    [props.projectId, props.apiKey, busy],
  );
  const status = disabled ? "Off" : busy ? (thinking ? "Thinking…" : "Working…") : "Ready";

  return (
    <>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.aside
            key="panel"
            aria-label="Sayes"
            // The cursors do not park under the panel.
            data-cursor-avoid
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 12 }}
            transition={{ duration: 0.24, ease: houseEase }}
            style={{ width: panelWidth, top: `calc(4rem + ${GAP}px)`, right: GAP, bottom: GAP, transformOrigin: "100% 100%" }}
            className={cn(
              "fixed z-40 flex flex-col overflow-hidden rounded-2xl border bg-surface shadow-lg",
              dragging ? "border-cyan" : "border-border",
            )}
            onDragOver={(event) => {
              if (disabled || !event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!disabled && event.dataTransfer.files.length) void attachments.add(event.dataTransfer.files);
            }}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the Sayes panel"
              title="Drag to resize"
              onPointerDown={startResize}
              onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
              className="group absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize"
            >
              <span className="absolute inset-y-6 left-0.5 w-0.5 rounded-full bg-transparent transition-colors duration-200 group-hover:bg-cyan" />
            </div>

            <RestoreContext.Provider value={restoreContext}>
              <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
                <span
                  ref={open ? origin : undefined}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan text-surface"
                  aria-hidden="true"
                >
                  <SayesMark size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-base font-bold leading-tight text-text">Sayes</h2>
                  <p className="flex items-center gap-1.5 truncate text-xs text-text-dim" aria-live="polite">
                    <span
                      className={cn("h-1.5 w-1.5 rounded-full", disabled ? "bg-text-dim" : busy ? "agent-pulse bg-cyan" : "bg-cyan")}
                      aria-hidden="true"
                    />
                    {status}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    label={view === "history" ? "Back to the chat" : "Previous chats"}
                    active={view === "history"}
                    onClick={() => setView(view === "history" ? "chat" : "history")}
                  >
                    <path d="M4 5.5h12M4 10h12M4 14.5h7" />
                  </IconButton>
                  <IconButton
                    label={view === "restore" ? "Back to the chat" : "Restore points"}
                    active={view === "restore"}
                    onClick={() => setView(view === "restore" ? "chat" : "restore")}
                  >
                    <path d="M3.5 10a6.5 6.5 0 1 0 2-4.7M3.5 3.5v3.3h3.3M10 6.8V10l2.2 1.4" />
                  </IconButton>
                  <IconButton
                    label="New chat"
                    disabled={busy}
                    onClick={() => {
                      agent.newChat();
                      setView("chat");
                    }}
                  >
                    <path d="M11.5 4H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8.5M9 11l.6-2.6 5.2-5.2a1.3 1.3 0 0 1 1.9 1.9l-5.2 5.2Z" />
                  </IconButton>
                  <IconButton label={`Close (${modKey()} + .)`} align="end" onClick={() => setOpen(false)}>
                    <path d="M5 5l10 10M15 5L5 15" />
                  </IconButton>
                </div>
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
                  onPick={(text) => void agent.send(text, { effort })}
                />
              )}

              <Composer
                disabled={disabled}
                busy={busy}
                attachments={attachments}
                effort={effort}
                onEffort={setEffort}
                onSend={(text, files) => {
                  setView("chat");
                  void agent.send(text, { attachments: files, effort });
                }}
                onStop={agent.cancel}
              />
            </RestoreContext.Provider>

            {dragging ? (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-cyan-glow">
                <p className="rounded-full bg-surface px-4 py-2 text-sm font-semibold text-cyan-dark shadow-md">
                  Drop images, a PDF or a CSV
                </p>
              </div>
            ) : null}
          </motion.aside>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {!open ? (
          <motion.button
            key="launcher"
            type="button"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2, ease: houseEase }}
            onClick={() => setOpen(true)}
            title={`Open Sayes (${modKey()} + .)`}
            aria-label="Open Sayes"
            className="fixed bottom-6 right-6 z-40 inline-flex h-14 w-14 items-center justify-center rounded-full bg-cyan text-surface shadow-lg transition-transform duration-200 hover:scale-105"
          >
            <span ref={origin} className="inline-flex">
              <SayesMark size={30} />
            </span>
            {busy ? <span className="agent-spin absolute inset-0 rounded-full border-2 border-surface/70 border-t-transparent" /> : null}
          </motion.button>
        ) : null}
      </AnimatePresence>

      <CursorLayer
        actions={agent.currentTurn?.actions ?? NO_ACTIONS}
        subscribe={agent.subscribe}
        canvas={props.canvas}
        origin={origin}
        leadMs={info?.cursor_lead_ms ?? DEFAULT_LEAD_MS}
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
  align,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  align?: "center" | "end";
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 disabled:opacity-40",
          active ? "bg-cyan-glow text-cyan-dark" : "text-text-dim hover:bg-surface-hover hover:text-text",
        )}
      >
        <svg viewBox="0 0 20 20" className="h-[1.15rem] w-[1.15rem]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {children}
        </svg>
      </button>
      <Tip align={align}>{label}</Tip>
    </span>
  );
}

/** A small label under its trigger on hover or keyboard focus. The trigger must be in a `group`. */
function Tip({ children, side = "below", align = "center" }: { children: ReactNode; side?: "below" | "above"; align?: "center" | "end" }) {
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-50 whitespace-nowrap rounded-lg bg-text px-2.5 py-1 text-xs font-medium text-surface opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
        side === "below" ? "top-full mt-2" : "bottom-full mb-2",
        align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
      )}
    >
      {children}
    </span>
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
        {turn.effort ? ` · ${turn.effort.level} effort` : ""}
        {turn.modelTurns ? ` · ${turn.modelTurns} model turn${turn.modelTurns === 1 ? "" : "s"}` : ""}
      </button>
      {open ? (
        <ol className="mt-2 space-y-2">
          {turn.actions.map((action) => (
            <TraceRow key={action.callId} action={action} />
          ))}
          {turn.model ? (
            <li className="font-mono text-[0.6875rem] text-text-dim">
              model {turn.model}
              {turn.effort
                ? ` · effort ${turn.effort.level}${turn.effort.chosen === "auto" ? ` (auto: ${turn.effort.reason})` : " (chosen)"}`
                : ""}
            </li>
          ) : null}
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
  "image/png": { label: "Image", maxBytes: 5 * 1024 * 1024 },
  "image/jpeg": { label: "Image", maxBytes: 5 * 1024 * 1024 },
  "image/webp": { label: "Image", maxBytes: 5 * 1024 * 1024 },
  "image/gif": { label: "Image", maxBytes: 5 * 1024 * 1024 },
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

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 1 : 0)} MB`;

/** Files waiting to go with the next message: picked, dropped anywhere on the panel, or pasted. */
function useAttachments() {
  const [files, setFiles] = useState<(AgentAttachment & { preview?: string })[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const add = useCallback(async (list: FileList | File[]) => {
    setProblem(null);
    const incoming = Array.from(list);
    const read: (AgentAttachment & { preview?: string })[] = [];
    const problems: string[] = [];
    for (const file of incoming) {
      const type = typeOf(file);
      const rule = ACCEPT[type];
      if (!rule) {
        problems.push(`${file.name} is not an image, PDF or CSV.`);
        continue;
      }
      if (file.size > rule.maxBytes) {
        problems.push(`${file.name} is ${megabytes(file.size)}; ${rule.label === "Image" ? "images" : rule.label + "s"} can be up to ${megabytes(rule.maxBytes)}.`);
        continue;
      }
      const data = await readBase64(file);
      read.push({ name: file.name, type, data, ...(rule.label === "Image" ? { preview: `data:${type};base64,${data}` } : {}) });
    }
    setFiles((current) => {
      const room = MAX_FILES - current.length;
      if (read.length > room) problems.push(`At most ${MAX_FILES} files per message.`);
      return [...current, ...read.slice(0, Math.max(0, room))];
    });
    if (problems.length) setProblem(problems.join(" "));
  }, []);

  const remove = useCallback((index: number) => setFiles((current) => current.filter((_, i) => i !== index)), []);
  const clear = useCallback(() => {
    setFiles([]);
    setProblem(null);
  }, []);

  return { files, problem, add, remove, clear };
}

type Attachments = ReturnType<typeof useAttachments>;

const EFFORTS: { id: AgentEffort; label: string; note: string }[] = [
  { id: "auto", label: "Auto", note: "Picks per request" },
  { id: "low", label: "Low", note: "Quick reads and lookups" },
  { id: "medium", label: "Medium", note: "Building and editing" },
  { id: "high", label: "High", note: "Research, planning, reports" },
];

function EffortPicker({ value, onChange, disabled }: { value: AgentEffort; onChange: (effort: AgentEffort) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const current = EFFORTS.find((e) => e.id === value) ?? EFFORTS[0];
  return (
    <div ref={box} className="group relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Effort: ${current.label}`}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-text-dim transition-colors duration-200 hover:bg-surface-hover hover:text-text disabled:opacity-40"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <path d="M3 12.5V10M6.3 12.5V7.5M9.7 12.5V5M13 12.5V3" />
        </svg>
        {current.label}
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </button>
      {!open ? <Tip side="above">Effort</Tip> : null}
      {open ? (
        <ul role="listbox" aria-label="Effort" className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg">
          {EFFORTS.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={option.id === value}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover",
                  option.id === value && "text-cyan-dark",
                )}
              >
                <span>
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="block text-xs text-text-dim">{option.note}</span>
                </span>
                {option.id === value ? (
                  <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                  </svg>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Composer({
  disabled,
  busy,
  attachments,
  effort,
  onEffort,
  onSend,
  onStop,
}: {
  disabled: boolean;
  busy: boolean;
  attachments: Attachments;
  effort: AgentEffort;
  onEffort: (effort: AgentEffort) => void;
  onSend: (text: string, attachments: AgentAttachment[]) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { files, problem, add, remove, clear } = attachments;

  // Grows with the text, up to about eight lines, then scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const submit = () => {
    if ((!draft.trim() && files.length === 0) || busy || disabled) return;
    onSend(
      draft,
      files.map(({ name, type, data }) => ({ name, type, data })),
    );
    setDraft("");
    clear();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <footer className="px-4 pb-4 pt-2">
      <div className="rounded-2xl border border-border-strong bg-surface shadow-sm transition-colors duration-200 focus-within:border-cyan">
        {files.length > 0 ? (
          <ul className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="group relative flex max-w-[13rem] items-center gap-2 rounded-xl border border-border bg-bg-subtle py-1.5 pl-1.5 pr-7"
              >
                {file.preview ? (
                  // A local data: URL of the file itself; there is nothing for next/image to optimise.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={file.preview} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-glow font-mono text-[0.625rem] font-bold text-cyan-dark">
                    {ACCEPT[file.type]?.label}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-text">{file.name}</span>
                  <span className="block font-mono text-[0.625rem] text-text-dim">{megabytes((file.data.length * 3) / 4)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={`Remove ${file.name}`}
                  className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-text-dim hover:bg-surface hover:text-text"
                >
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

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
          className="sayes-input block max-h-[200px] min-h-[3rem] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[0.9375rem] leading-relaxed text-text outline-none placeholder:text-text-dim"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
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
          <span className="group relative inline-flex">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={disabled}
              aria-label="Attach images, a PDF or a CSV"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-dim transition-colors duration-200 hover:bg-surface-hover hover:text-text disabled:opacity-40"
            >
              <svg viewBox="0 0 20 20" className="h-[1.15rem] w-[1.15rem]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13.2 5.6 7.4 11.4a1.7 1.7 0 0 0 2.4 2.4l6-6a3.4 3.4 0 0 0-4.8-4.8l-6 6a5.1 5.1 0 0 0 7.2 7.2l5.3-5.3" />
              </svg>
            </button>
            <Tip side="above">Attach images, a PDF or a CSV</Tip>
          </span>
          <EffortPicker value={effort} onChange={onEffort} disabled={disabled} />
          <span className="flex-1" />
          {busy ? (
            <span className="group relative inline-flex">
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-text text-surface"
              >
                <span className="h-3 w-3 rounded-[3px] bg-surface" />
              </button>
              <Tip side="above" align="end">Stop</Tip>
            </span>
          ) : (
            <span className="group relative inline-flex">
              <button
                type="button"
                onClick={submit}
                disabled={disabled || (!draft.trim() && files.length === 0)}
                aria-label="Send"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan text-surface transition-opacity duration-200 disabled:opacity-40"
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
                </svg>
              </button>
              <Tip side="above" align="end">Send · Shift + Enter for a new line</Tip>
            </span>
          )}
        </div>
      </div>
      {problem ? <p className="mt-2 px-1 text-xs text-text">{problem}</p> : null}
    </footer>
  );
}
