"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { GraphCanvasHandle } from "@/components/console/GraphCanvas";
import { houseEase } from "@/lib/ease";
import type { AgentEvent, AgentTarget } from "@/lib/agent";
import { describeAction, laneColour, type CameraOf } from "./labels";
import type { AgentAction } from "./useAgent";
import { CursorGlyph } from "./AgentPanel";

type Point = { x: number; y: number };
type Resolver = () => Point | null;
type Segment = { from: Resolver; to: Resolver; t0: number; dur: number };

type Track = {
  segments: Segment[];
  last: Point | null;
  arrived: boolean;
  dragging: boolean;
  /** Edge creation draws the road it is measuring. */
  edge?: { from: Resolver; to: Resolver };
  settled: boolean;
  approved: boolean;
  target: AgentTarget;
};

type Shown = { callId: string; lane: number; kind: AgentTarget["kind"]; fading: boolean };

type Elements = { cursor?: HTMLDivElement | null; line?: SVGLineElement | null; ghost?: SVGCircleElement | null };

type CursorLayerProps = {
  /** The current turn's actions: labels only. Motion comes from `subscribe`. */
  actions: AgentAction[];
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  canvas: RefObject<GraphCanvasHandle | null>;
  origin: RefObject<HTMLElement | null>;
  /** The server's lead time: the change lands this long after the cursor leaves. */
  leadMs: number;
  cameraOf: CameraOf;
};

const HOLD_DONE_MS = 900;
const HOLD_OTHER_MS = 1600;
const FADE_MS = 320;
const NODE_RADIUS_PX = 22;
const EDGE_DRAW_MS = 450;

function resolver(canvas: RefObject<GraphCanvasHandle | null>, target: AgentTarget, part: "start" | "end"): Resolver {
  const c = () => canvas.current;
  switch (target.kind) {
    case "point":
      return () => c()?.latLngToClient(target.latitude, target.longitude) ?? null;
    case "edge":
      return () => c()?.edgeToClient(target.connection_id) ?? null;
    case "edge-new":
      return part === "start"
        ? () => c()?.nodeToClient(target.from_node_id) ?? null
        : () => c()?.nodeToClient(target.to_node_id) ?? null;
    case "node-move":
      return part === "start"
        ? () => c()?.nodeToClient(target.node_id) ?? null
        : () => c()?.latLngToClient(target.to.latitude, target.to.longitude) ?? null;
    case "ui":
      return () => {
        const el = document.querySelector(`[data-agent-target="${target.element}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
  }
}

function originResolver(origin: RefObject<HTMLElement | null>): Resolver {
  return () => {
    const el = origin.current;
    if (!el) return { x: 48, y: window.innerHeight - 48 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
}

/** Flight time: by distance, and never longer than the server's lead. */
function flight(leadMs: number, from: Point | null, to: Point | null) {
  const max = Math.max(380, leadMs - 80);
  if (!from || !to) return max;
  return Math.max(380, Math.min(max, Math.hypot(to.x - from.x, to.y - from.y) * 0.7));
}

/**
 * The agent's cursors.
 *
 * Each one is a real tool call: it leaves the Dispatch mark when the server
 * says a call is starting, reaches its target as the call is sent, waits
 * while it runs, and leaves when it is done. Calls running at once are
 * separate cursors, numbered and shaded by lane.
 *
 * Positions are worked out every frame from the canvas rather than fixed at
 * the start, so a cursor stays on its checkpoint while the camera moves.
 * Motion is the house curve, and nothing overshoots.
 */
export default function CursorLayer({ actions, subscribe, canvas, origin, leadMs, cameraOf }: CursorLayerProps) {
  const tracks = useRef(new Map<string, Track>());
  const elements = useRef(new Map<string, Elements>());
  const lead = useRef(leadMs);
  const [shown, setShown] = useState<Shown[]>([]);

  useEffect(() => {
    lead.current = leadMs;
  }, [leadMs]);

  /* Agent events become tracks. */
  useEffect(() => {
    let runPoints: { lat: number; lng: number }[] = [];
    let frameTimer: number | null = null;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    const retire = (callId: string, ok: boolean) => {
      later(() => {
        setShown((list) => list.map((s) => (s.callId === callId ? { ...s, fading: true } : s)));
        later(() => {
          tracks.current.delete(callId);
          elements.current.delete(callId);
          setShown((list) => list.filter((s) => s.callId !== callId));
        }, FADE_MS);
      }, ok ? HOLD_DONE_MS : HOLD_OTHER_MS);
    };

    const onEvent = (event: AgentEvent) => {
      if (event.name === "run.started") {
        tracks.current.clear();
        elements.current.clear();
        runPoints = [];
        setShown([]);
        return;
      }

      if (event.name === "tool.started" && event.data.target) {
        const target = event.data.target;
        const now = performance.now();
        const start = originResolver(origin);
        const first = resolver(canvas, target, "start");

        // Every place this run is about to put something is kept in frame:
        // calls that start together can arrive in separate chunks, and a
        // later frame must not drop the points of an earlier one.
        if (target.kind === "point" || target.kind === "node-move") {
          const at = target.kind === "point" ? target : target.to;
          runPoints.push({ lat: at.latitude, lng: at.longitude });
          if (frameTimer === null) {
            frameTimer = window.setTimeout(() => {
              frameTimer = null;
              const offScreen = runPoints.some((p) => !canvas.current?.isVisible(p.lat, p.lng, 80));
              if (offScreen) canvas.current?.frame([...runPoints], 600);
            }, 30);
          }
        }

        const d1 = flight(lead.current, start(), first());
        const track: Track = {
          segments: [{ from: start, to: first, t0: now, dur: d1 }],
          last: start(),
          arrived: false,
          dragging: false,
          settled: false,
          approved: false,
          target,
        };
        if (target.kind === "edge-new") {
          const second = resolver(canvas, target, "end");
          track.segments.push({ from: first, to: second, t0: now + d1, dur: EDGE_DRAW_MS });
          track.edge = { from: first, to: second };
        }
        tracks.current.set(event.data.call_id, track);
        setShown((list) => [
          ...list.filter((s) => s.callId !== event.data.call_id),
          { callId: event.data.call_id, lane: event.data.lane, kind: target.kind, fading: false },
        ]);
        return;
      }

      if (event.name === "tool.confirmed") {
        const track = tracks.current.get(event.data.call_id);
        if (!track || event.data.outcome !== "approved" || track.target.kind !== "node-move") return;
        // An approved move is carried out by dragging the checkpoint across.
        track.approved = true;
        track.arrived = false;
        elements.current.get(event.data.call_id)?.cursor?.removeAttribute("data-arrived");
        track.segments.push({
          from: resolver(canvas, track.target, "start"),
          to: resolver(canvas, track.target, "end"),
          t0: performance.now(),
          dur: Math.max(300, lead.current * 0.9),
        });
        return;
      }

      if (event.name === "tool.finished") {
        const track = tracks.current.get(event.data.call_id);
        if (!track || track.settled) return;
        track.settled = true;
        retire(event.data.call_id, event.data.ok);
      }
    };

    const unsubscribe = subscribe(onEvent);
    return () => {
      unsubscribe();
      if (frameTimer !== null) window.clearTimeout(frameTimer);
      for (const id of timers) window.clearTimeout(id);
    };
  }, [subscribe, canvas, origin]);

  /* One animation loop for every cursor, running only while there are any. */
  const anyShown = shown.length > 0;
  useEffect(() => {
    if (!anyShown) return;
    let id = 0;
    const step = () => {
      const now = performance.now();
      for (const [callId, track] of tracks.current) {
        const els = elements.current.get(callId);
        let active: Segment | null = null;
        for (const segment of track.segments) if (segment.t0 <= now) active = segment;
        if (active) {
          const k = houseEase(Math.min(1, (now - active.t0) / active.dur));
          const a = active.from() ?? track.last;
          const b = active.to() ?? a;
          if (a && b) track.last = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
          const final = active === track.segments[track.segments.length - 1];
          if (final && k >= 1 && !track.arrived) {
            track.arrived = true;
            els?.cursor?.setAttribute("data-arrived", "1");
          }
          track.dragging = track.approved && final && k < 1;
        }
        const p = track.last;
        if (!p || !els?.cursor) continue;
        els.cursor.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
        // Near the right edge the label opens to the left instead.
        const flip = p.x > window.innerWidth - 300;
        if (flip !== (els.cursor.dataset.flip === "1")) {
          if (flip) els.cursor.dataset.flip = "1";
          else delete els.cursor.dataset.flip;
        }

        if (els.line && track.edge) {
          const start = track.edge.from();
          // While the cursor draws the edge out, the line follows it; once it
          // is at the far checkpoint, the line spans the whole road.
          const drawing = track.segments.length > 1 && now >= track.segments[1].t0;
          const end = track.arrived ? track.edge.to() : drawing ? p : null;
          if (start && end && !track.settled) {
            els.line.setAttribute("x1", String(start.x));
            els.line.setAttribute("y1", String(start.y));
            els.line.setAttribute("x2", String(end.x));
            els.line.setAttribute("y2", String(end.y));
            els.line.style.opacity = "1";
          } else {
            els.line.style.opacity = "0";
          }
        }
        if (els.ghost) {
          els.ghost.setAttribute("cx", String(p.x));
          els.ghost.setAttribute("cy", String(p.y));
          els.ghost.style.opacity = track.dragging ? "1" : "0";
        }
      }
      id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [anyShown]);

  const register = (callId: string, part: keyof Elements) => (el: HTMLDivElement | SVGLineElement | SVGCircleElement | null) => {
    const entry = elements.current.get(callId) ?? {};
    (entry as Record<string, unknown>)[part] = el;
    elements.current.set(callId, entry);
  };

  const byId = new Map(actions.map((a) => [a.callId, a]));

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]" aria-hidden="true">
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        {shown.map((s) => (
          <g key={s.callId} style={{ opacity: s.fading ? 0 : 1, transition: `opacity ${FADE_MS}ms` }}>
            {s.kind === "edge-new" ? (
              <line
                ref={register(s.callId, "line")}
                className="agent-measuring"
                stroke={laneColour(s.lane)}
                strokeWidth={3}
                strokeLinecap="round"
                style={{ opacity: 0 }}
              />
            ) : null}
            {s.kind === "node-move" ? (
              <circle
                ref={register(s.callId, "ghost")}
                r={NODE_RADIUS_PX}
                fill="color-mix(in oklab, var(--cyan) 14%, transparent)"
                stroke={laneColour(s.lane)}
                strokeWidth={3}
                strokeDasharray="6 5"
                style={{ opacity: 0 }}
              />
            ) : null}
          </g>
        ))}
      </svg>

      {shown.map((s) => {
        const action = byId.get(s.callId);
        const colour = laneColour(s.lane);
        const status = action?.status ?? "working";
        let label = "Working";
        if (action) {
          const { title, outcome } = describeAction(action, cameraOf);
          const settled = status === "done" || status === "failed" || status === "declined";
          label =
            status === "confirm"
              ? "Waiting for your OK"
              : status === "measuring"
                ? "Measuring road distance…"
                : settled
                  ? outcome
                  : title;
        }
        return (
          <div
            key={s.callId}
            ref={register(s.callId, "cursor")}
            className="agent-cursor absolute left-0 top-0"
            data-status={status}
            style={{
              opacity: s.fading ? 0 : 1,
              transition: `opacity ${FADE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
              color: colour,
              transform: "translate3d(-100px, -100px, 0)",
            }}
          >
            <span className="agent-cursor-ring" style={{ borderColor: colour }} />
            <CursorGlyph className="agent-cursor-glyph h-5 w-5" />
            <span
              className="agent-cursor-label absolute left-5 top-5 flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1.5 font-medium text-surface shadow-md"
              style={{ backgroundColor: colour }}
            >
              <span className="font-mono text-[0.6875rem] opacity-80">{s.lane}</span>
              <span className="text-xs">{label}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
