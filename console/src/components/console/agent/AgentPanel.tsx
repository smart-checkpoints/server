"use client";

import { forwardRef, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { getAudit, type AgentInfo, type AuditRow } from "@/lib/agent";
import { describeAction, EXAMPLE_PROMPTS, laneColour, type CameraOf } from "./labels";
import type { AgentAction, AgentTurn } from "./useAgent";

type AgentPanelProps = {
  projectId: number;
  apiKey: string;
  info: AgentInfo | null;
  turns: AgentTurn[];
  busy: boolean;
  thinking: boolean;
  cameraOf: CameraOf;
  presentation: boolean;
  onTogglePresentation: () => void;
  onSend: (message: string) => void;
  onCancel: () => void;
  onConfirm: (callId: string, approved: boolean) => Promise<void>;
  onReset: () => void;
};

/**
 * The Dispatch panel: what the operator asked, what the agent is doing about
 * it, the cards that need their approval, and the record of everything it
 * has done. Docked beside the map rather than over it, so the map keeps its
 * whole width for the cursors.
 *
 * The forwarded ref is the agent's mark in the header: where cursors leave
 * from.
 */
const AgentPanel = forwardRef<HTMLSpanElement, AgentPanelProps>(function AgentPanel(props, markRef) {
  const { info, turns, busy, thinking, presentation } = props;
  const [tab, setTab] = useState<"assistant" | "audit">("assistant");
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the conversation as it streams.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);

  const submit = () => {
    if (!draft.trim() || busy) return;
    props.onSend(draft);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const disabled = !info || !info.enabled;

  return (
    <aside
      aria-label="Dispatch"
      className={cn(
        "relative z-20 flex h-full shrink-0 flex-col border-r border-border bg-surface",
        presentation ? "w-[30rem]" : "w-[24rem]",
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            ref={markRef}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan text-surface"
            aria-hidden="true"
          >
            <CursorGlyph className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-base font-bold text-text">Dispatch</h2>
            <p className="truncate font-mono text-xs text-text-dim">
              {disabled ? "Off" : busy ? (thinking ? "Thinking…" : "Working…") : "Ready"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!presentation ? (
            <TabButton active={tab === "audit"} onClick={() => setTab(tab === "audit" ? "assistant" : "audit")}>
              Audit
            </TabButton>
          ) : null}
          <TabButton active={presentation} onClick={props.onTogglePresentation}>
            {presentation ? "Exit presentation" : "Present"}
          </TabButton>
        </div>
      </header>

      {tab === "audit" && !presentation ? (
        <AuditList projectId={props.projectId} apiKey={props.apiKey} refreshKey={turns.length + (busy ? 0.5 : 0)} />
      ) : (
        <>
          <div ref={scroller} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
            {disabled ? (
              <p className="rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-text-dim">
                {info?.reason ?? "The agent is not available on this server."}
              </p>
            ) : turns.length === 0 ? (
              <Welcome onPick={setDraft} presentation={presentation} />
            ) : (
              turns.map((turn, index) => (
                <Turn
                  key={turn.id}
                  turn={turn}
                  live={index === turns.length - 1 && busy}
                  thinking={index === turns.length - 1 && thinking}
                  cameraOf={props.cameraOf}
                  onConfirm={props.onConfirm}
                />
              ))
            )}
          </div>

          <footer className="border-t border-border px-5 py-4">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={disabled}
              rows={presentation ? 2 : 3}
              placeholder="Tell Dispatch what to set up…"
              className="field resize-none leading-relaxed"
              aria-label="Message to Dispatch"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              {!presentation && turns.length > 0 && !busy ? (
                <button
                  type="button"
                  onClick={props.onReset}
                  className="text-xs font-medium text-text-dim transition-colors duration-200 hover:text-cyan-dark"
                >
                  New conversation
                </button>
              ) : (
                <span />
              )}
              {busy ? (
                <button type="button" onClick={props.onCancel} className="btn btn-secondary rounded-full px-5 py-2 text-sm font-semibold">
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={disabled || !draft.trim()}
                  className="btn btn-primary rounded-full px-5 py-2 text-sm font-semibold disabled:pointer-events-none disabled:opacity-50"
                >
                  Send
                </button>
              )}
            </div>
          </footer>
        </>
      )}
    </aside>
  );
});

export default AgentPanel;

/* -------------------------------------------------------------------------
   Pieces
   ------------------------------------------------------------------------- */

export function CursorGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path d="M2.5 1.5 L13 8 L8.2 9.2 L6.2 13.8 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-200",
        active ? "bg-cyan-glow text-cyan-dark" : "text-text-dim hover:bg-surface-hover hover:text-cyan-dark",
      )}
    >
      {children}
    </button>
  );
}

function Welcome({ onPick, presentation }: { onPick: (text: string) => void; presentation: boolean }) {
  return (
    <div>
      <p className="text-sm text-text">
        Describe what you want set up in plain words. You will see each step happen on the map.
      </p>
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
    </div>
  );
}

function Turn({
  turn,
  live,
  thinking,
  cameraOf,
  onConfirm,
}: {
  turn: AgentTurn;
  live: boolean;
  thinking: boolean;
  cameraOf: CameraOf;
  onConfirm: (callId: string, approved: boolean) => Promise<void>;
}) {
  return (
    <section className="space-y-3">
      <p className="ml-8 rounded-2xl rounded-tr-md bg-bg-subtle px-4 py-3 text-sm text-text">{turn.request}</p>

      {turn.notes ? <p className="text-sm italic text-text-dim">{turn.notes.trim()}</p> : null}

      {turn.actions.length > 0 ? (
        <ol className="space-y-1.5">
          {turn.actions.map((action) => (
            <ActionRow key={action.callId} action={action} cameraOf={cameraOf} onConfirm={onConfirm} />
          ))}
        </ol>
      ) : null}

      {live && thinking ? <Working /> : null}

      {turn.reply ? <p className="text-sm leading-relaxed text-text">{turn.reply}</p> : null}
      {turn.error ? (
        <p className="rounded-xl border border-red/40 px-4 py-3 text-sm text-text">{turn.error}</p>
      ) : null}
      {turn.status === "cancelled" ? <p className="font-mono text-xs text-text-dim">Stopped.</p> : null}
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
        <span
          className={cn(
            "min-w-0 flex-1",
            action.status === "failed" || action.status === "declined" ? "text-text-dim" : "text-text",
          )}
        >
          {settled ? outcome : title}
          {action.status === "measuring" ? <span className="ml-1 text-text-dim">…</span> : null}
        </span>
      </div>
      {action.status === "confirm" && action.confirm ? (
        <ConfirmCard action={action} onConfirm={onConfirm} />
      ) : null}
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
  // In progress: a ring in the lane's colour, turning while it works.
  return (
    <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-label="In progress">
      <span
        className={cn("h-3 w-3 rounded-full border-2", action.status === "confirm" ? "" : "agent-spin")}
        style={{ borderColor: colour, borderTopColor: action.status === "confirm" ? colour : "transparent" }}
      />
    </span>
  );
}

function ConfirmCard({
  action,
  onConfirm,
}: {
  action: AgentAction;
  onConfirm: (callId: string, approved: boolean) => Promise<void>;
}) {
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
        <button
          type="button"
          disabled={sending}
          onClick={() => void answer(true)}
          className="btn btn-primary rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => void answer(false)}
          className="btn btn-secondary rounded-full px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Audit
   ------------------------------------------------------------------------- */

function AuditList({ projectId, apiKey, refreshKey }: { projectId: number; apiKey: string; refreshKey: number }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getAudit(projectId, apiKey, 200)
      .then((data) => {
        setRows(data);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the audit log"));
  }, [apiKey, projectId]);

  useEffect(load, [load, refreshKey]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center justify-between px-5 py-3">
        <p className="text-xs text-text-dim">Every action Dispatch took, newest first. Read-only.</p>
        <button type="button" onClick={load} className="text-xs font-semibold text-cyan-dark">
          Refresh
        </button>
      </div>
      {error ? <p className="px-5 text-sm text-text-dim">{error}</p> : null}
      {rows && rows.length === 0 ? <p className="px-5 text-sm text-text-dim">Nothing yet.</p> : null}
      <ol>
        {(rows ?? []).map((row) => (
          <li key={row.action_id} className="border-t border-border px-5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-xs font-semibold text-text">{row.tool}</span>
              <span className="font-mono text-[0.6875rem] text-text-dim">
                {new Date(row.started_at).toLocaleTimeString()}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-text-dim">“{row.user_request}”</p>
            <p className="mt-1 font-mono text-[0.6875rem] text-text-dim">
              {row.ok === null ? "unfinished" : row.ok ? "ok" : row.confirmation === "declined" ? "declined" : "failed"}
              {row.confirmation ? ` · confirmation ${row.confirmation}` : ""}
            </p>
            {row.api_calls.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {row.api_calls.map((call, index) => (
                  <li key={index} className="font-mono text-[0.6875rem] text-text-dim">
                    {call.method} {call.path} {call.status} · {call.ms} ms
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
