"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { GraphCanvasHandle } from "@/components/console/GraphCanvas";
import type { AgentEvent, AgentInfo, AgentTarget } from "@/lib/agent";
import { describeAction, LANES, type CameraOf } from "./labels";
import type { AgentAction } from "./useAgent";
import { Director, type CursorView, type DirectorEnv, type Rect } from "./cursors/director";
import { Spring } from "./cursors/motion";
import { tuning } from "./cursors/tuning";
import CursorLab, { type LabControls } from "./cursors/CursorLab";
import { changesOf, hadCursorWork, maskFor, type ReplayMask } from "./cursors/replayMask";

type CursorLayerProps = {
  /** The current turn's actions: the words on the name tags. Motion comes from `subscribe`. */
  actions: AgentAction[];
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  canvas: RefObject<GraphCanvasHandle | null>;
  /** The Sayes mark: where cursors come from and go back to. */
  origin: RefObject<HTMLElement | null>;
  /** Used only if the server does not say when a call lands (`lead_ms`). */
  leadMs: number;
  cameraOf: CameraOf;
  info: AgentInfo | null;
  presentation: boolean;
  /**
   * While a run is replayed, how the page should draw the graph: as it was
   * before the run, with each change landing as its cursor clicks. Null when
   * no replay is running. Screen only; real data is never touched.
   */
  onReplayMask?: (mask: ReplayMask | null) => void;
};

type Recorded = { t: number; event: AgentEvent };

/** A clock for replays: slowed, paused and stepped from the Lab. */
class VirtualClock {
  private t = 0;
  private last = performance.now();
  rate = 1;
  paused = false;

  now() {
    const real = performance.now();
    if (!this.paused) this.t += (real - this.last) * this.rate;
    this.last = real;
    return this.t;
  }

  step(ms: number) {
    this.t += ms;
  }
}

type Replay = {
  director: Director;
  events: Recorded[];
  next: number;
  clock: VirtualClock;
  start: number;
  /** The actions as they stood at this point of the run, for the name tags. */
  actions: Map<string, AgentAction>;
  changes: ReturnType<typeof changesOf>;
  landed: Set<string>;
};

/** How long a replay lets a cursor wait for an approval, however long the operator took. */
const REPLAY_APPROVAL_MS = 1200;

/**
 * A recorded run with the operator's thinking time cut out: a wait between
 * "needs your OK" and the answer longer than REPLAY_APPROVAL_MS is shortened
 * to it, and everything after moves up. The agent's own pauses are kept.
 */
function withoutApprovalWaits(events: Recorded[]): Recorded[] {
  const asked = new Map<string, number>();
  let cut = 0;
  return events.map((r) => {
    const t = r.t - cut;
    if (r.event.name === "tool.confirm_required") asked.set(r.event.data.call_id, t);
    if (r.event.name === "tool.confirmed") {
      const at = asked.get(r.event.data.call_id);
      if (at !== undefined && t - at > REPLAY_APPROVAL_MS) {
        cut += t - at - REPLAY_APPROVAL_MS;
        return { ...r, t: at + REPLAY_APPROVAL_MS };
      }
    }
    return { ...r, t };
  });
}

/** Folds one event into a replay's actions, the way useAgent does live. */
function foldAction(actions: Map<string, AgentAction>, e: AgentEvent) {
  const update = (id: string, change: Partial<AgentAction>) => {
    const a = actions.get(id);
    if (a) actions.set(id, { ...a, ...change });
  };
  switch (e.name) {
    case "tool.started":
      actions.set(e.data.call_id, {
        callId: e.data.call_id,
        tool: e.data.tool,
        input: e.data.input,
        lane: e.data.lane,
        target: e.data.target,
        status: "working",
        startedAt: 0,
      });
      break;
    case "tool.progress":
      update(e.data.call_id, { status: "measuring" });
      break;
    case "tool.confirm_required":
      update(e.data.call_id, { status: "confirm" });
      break;
    case "tool.confirmed":
      update(e.data.call_id, { status: e.data.outcome === "approved" ? "working" : "declined" });
      break;
    case "tool.finished":
      update(e.data.call_id, {
        status: e.data.ok ? "done" : e.data.declined ? "declined" : "failed",
        result: e.data.result,
      });
      break;
  }
}

const SLOTS = LANES.length;
const RIPPLES = [0, 1, 2];

type Slot = {
  group: SVGGElement | null;
  main: SVGPathElement | null;
  badge: SVGPathElement | null;
  shimmer: SVGPathElement | null;
  line: SVGLineElement | null;
  ghost: SVGCircleElement | null;
  ripples: (SVGCircleElement | null)[];
  path: SVGPolylineElement | null;
  press: SVGCircleElement | null;
  tag: HTMLDivElement | null;
  tagText: HTMLSpanElement | null;
  tagX: Spring;
  tagY: Spring;
  quad: number;
  text: string;
  placed: boolean;
};

const emptySlot = (): Slot => ({
  group: null,
  main: null,
  badge: null,
  shimmer: null,
  line: null,
  ghost: null,
  ripples: [null, null, null],
  path: null,
  press: null,
  tag: null,
  tagText: null,
  tagX: new Spring(0),
  tagY: new Spring(0),
  quad: 0,
  text: "",
  placed: false,
});

/** Name tag corners: below-right, below-left, above-right, above-left. */
const QUADS = [
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: -1 },
];

function rectOf(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function makeEnv(canvas: RefObject<GraphCanvasHandle | null>, origin: RefObject<HTMLElement | null>): DirectorEnv {
  let rootScale = 1;
  let rootRead = -Infinity;
  let reduced = false;
  let reducedRead = false;
  const target = (element: string) => document.querySelector(`[data-agent-target="${element}"]`);
  return {
    resolve: (t: AgentTarget, part: "start" | "end") => {
      const c = canvas.current;
      if (!c) return null;
      switch (t.kind) {
        case "point":
          return c.latLngToClient(t.latitude, t.longitude);
        case "edge":
          return c.edgeToClient(t.connection_id);
        case "edge-new":
          return part === "start" ? c.nodeToClient(t.from_node_id) : c.nodeToClient(t.to_node_id);
        case "node-move":
          return part === "start" ? c.nodeToClient(t.node_id) : c.latLngToClient(t.to.latitude, t.to.longitude);
        case "ui": {
          const r = rectOf(target(t.element));
          return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null;
        }
      }
    },
    elementRect: (t) => (t.kind === "ui" ? rectOf(target(t.element)) : null),
    edgeEnds: (t) => {
      const c = canvas.current;
      if (!c) return null;
      if (t.kind === "edge") return c.edgeEndsToClient(t.connection_id);
      if (t.kind === "edge-new") {
        const a = c.nodeToClient(t.from_node_id);
        const b = c.nodeToClient(t.to_node_id);
        return a && b ? { a, b } : null;
      }
      return null;
    },
    stage: () =>
      rectOf(document.querySelector("[data-cursor-stage]")) ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
    home: () => {
      const r = rectOf(origin.current);
      return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 48, y: window.innerHeight - 48 };
    },
    avoid: () => [...document.querySelectorAll("[data-cursor-avoid]")].map(rectOf).filter((r): r is Rect => r !== null),
    rootScale: () => {
      const now = performance.now();
      if (now - rootRead > 1000) {
        rootRead = now;
        rootScale = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;
      }
      return rootScale;
    },
    reducedMotion: () => {
      if (!reducedRead) {
        reducedRead = true;
        const q = window.matchMedia("(prefers-reduced-motion: reduce)");
        reduced = q.matches;
        q.addEventListener("change", (e) => (reduced = e.matches));
      }
      return reduced;
    },
  };
}

/** The name tag's words for an action, as the panel words it. */
function tagText(action: AgentAction | undefined, cameraOf: CameraOf) {
  if (!action) return "";
  const { title, outcome } = describeAction(action, cameraOf);
  const status = action.status;
  if (status === "confirm") return "Waiting for your OK";
  if (status === "measuring") return "Measuring road distance…";
  return status === "done" || status === "failed" || status === "declined" ? outcome : title;
}

/**
 * The agent's cursors: a cast of up to five Vision pointers, one per lane,
 * choreographed by `Director` from the live event stream and drawn here
 * every frame without going through React.
 */
export default function CursorLayer({
  actions,
  subscribe,
  canvas,
  origin,
  leadMs,
  cameraOf,
  info,
  presentation,
  onReplayMask,
}: CursorLayerProps) {
  const slots = useRef<Slot[]>(Array.from({ length: SLOTS }, emptySlot));
  const labels = useRef({ actions, cameraOf });
  const lead = useRef(leadMs);
  const env = useRef<DirectorEnv | null>(null);
  const director = useRef<Director | null>(null);
  const replay = useRef<Replay | null>(null);
  const recording = useRef<{ start: number; events: Recorded[] } | null>(null);
  const lastRun = useRef<Recorded[] | null>(null);
  const raf = useRef(0);
  const loopRef = useRef<() => void>(() => undefined);
  const lastFrame = useRef<number | null>(null);
  const [labOpen, setLabOpen] = useState(false);
  const [hasRun, setHasRun] = useState(false);

  useEffect(() => {
    labels.current = { actions, cameraOf };
  }, [actions, cameraOf]);

  useEffect(() => {
    lead.current = leadMs;
  }, [leadMs]);

  const maskSink = useRef(onReplayMask);
  useEffect(() => {
    maskSink.current = onReplayMask;
  }, [onReplayMask]);

  /** Ends a replay and gives the page its real graph back. */
  const endReplay = useCallback(() => {
    if (!replay.current) return;
    replay.current = null;
    maskSink.current?.(null);
  }, []);

  const live = useCallback(() => {
    if (!env.current) env.current = makeEnv(canvas, origin);
    if (!director.current) director.current = new Director(env.current);
    return director.current;
  }, [canvas, origin]);

  /* Drawing one frame from the director's views; `dt` is this frame's length in seconds. */
  const paint = useCallback((views: CursorView[], dt: number) => {
    const { cameraOf: camOf } = labels.current;
    // A replay's tags say what was happening at that point, not how it ended.
    const list = replay.current ? [...replay.current.actions.values()] : labels.current.actions;
    const byId = new Map(list.map((a) => [a.callId, a]));
    const placed: Rect[] = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (let i = 0; i < SLOTS; i += 1) {
      const s = slots.current[i];
      const v = views.find((view) => view.lane === i + 1);
      if (!s.group || !s.tag) continue;
      if (!v) {
        s.group.style.display = "none";
        s.tag.style.display = "none";
        s.placed = false;
        continue;
      }
      s.group.style.display = "";
      s.group.style.opacity = String(v.opacity);

      const stroke = v.hug > 0 ? `color-mix(in oklab, ${v.colour} ${Math.round(v.hug * 100)}%, white)` : "white";
      if (s.main) {
        s.main.setAttribute("d", v.main);
        s.main.style.fill = v.colour;
        s.main.style.fillOpacity = String(1 - v.hug * (1 - v.hugFill));
        s.main.style.stroke = stroke;
        s.main.style.strokeWidth = String(v.strokeWidth);
        s.main.style.filter = v.hug > 0.4 ? "none" : "";
      }
      if (s.badge) {
        s.badge.setAttribute("d", v.badge);
        s.badge.style.fill = v.badgeColour ?? v.colour;
        s.badge.style.strokeWidth = String(v.strokeWidth);
      }
      if (s.shimmer) {
        if (v.shimmer !== null) {
          s.shimmer.setAttribute("d", v.main);
          s.shimmer.style.display = "";
          s.shimmer.style.strokeDashoffset = String(v.shimmer);
          s.shimmer.style.strokeWidth = String(v.strokeWidth * 0.5);
          s.shimmer.style.stroke = `color-mix(in oklab, ${v.colour} 45%, white)`;
        } else {
          s.shimmer.style.display = "none";
        }
      }
      if (s.line) {
        if (v.line) {
          s.line.style.display = "";
          s.line.setAttribute("x1", v.line.x1.toFixed(1));
          s.line.setAttribute("y1", v.line.y1.toFixed(1));
          s.line.setAttribute("x2", v.line.x2.toFixed(1));
          s.line.setAttribute("y2", v.line.y2.toFixed(1));
          s.line.style.stroke = v.colour;
        } else {
          s.line.style.display = "none";
        }
      }
      if (s.ghost) {
        if (v.ghost) {
          s.ghost.style.display = "";
          s.ghost.setAttribute("cx", v.ghost.x.toFixed(1));
          s.ghost.setAttribute("cy", v.ghost.y.toFixed(1));
          s.ghost.style.stroke = v.colour;
          s.ghost.style.fill = `color-mix(in oklab, ${v.colour} 14%, transparent)`;
        } else {
          s.ghost.style.display = "none";
        }
      }
      s.ripples.forEach((el, k) => {
        if (!el) return;
        const r = v.ripples[k];
        if (!r) {
          el.style.display = "none";
          return;
        }
        el.style.display = "";
        el.setAttribute("cx", r.x.toFixed(1));
        el.setAttribute("cy", r.y.toFixed(1));
        el.setAttribute("r", r.r.toFixed(1));
        el.style.stroke = v.colour;
        el.style.opacity = r.opacity.toFixed(3);
      });
      if (s.path) {
        if (v.path) {
          s.path.style.display = "";
          s.path.setAttribute("points", v.path.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
          s.path.style.stroke = v.colour;
        } else {
          s.path.style.display = "none";
        }
      }
      if (s.press) {
        if (v.press) {
          s.press.style.display = "";
          s.press.setAttribute("cx", v.press.x.toFixed(1));
          s.press.setAttribute("cy", v.press.y.toFixed(1));
          s.press.style.stroke = v.colour;
        } else {
          s.press.style.display = "none";
        }
      }

      /* The name tag: its words, then where it hangs. */
      const text = v.acting && v.callId ? tagText(byId.get(v.callId), camOf) : "";
      if (s.tagText && text !== s.text) {
        if (text) s.tagText.textContent = text;
        s.tag.dataset.acting = text ? "1" : "0";
        s.text = text;
      }
      s.tag.style.display = "";
      s.tag.style.opacity = String(v.opacity);
      s.tag.style.backgroundColor = v.colour;
      s.tag.style.color = v.ink;

      const w = s.tag.offsetWidth;
      const h = s.tag.offsetHeight;
      const box = (q: number): Rect => {
        const d = QUADS[q];
        return {
          x: d.x > 0 ? v.anchor.x + 14 : v.anchor.x - 14 - w,
          y: d.y > 0 ? v.anchor.y + 18 : v.anchor.y - 10 - h,
          w,
          h,
        };
      };
      const cost = (q: number) => {
        const b = box(q);
        let c = 0;
        if (v.focus) c += overlap(b, { x: v.focus.x - 4, y: v.focus.y - 4, w: v.focus.w + 8, h: v.focus.h + 8 }) * 4;
        for (const other of placed) c += overlap(b, other) * 2;
        if (b.x < 8) c += (8 - b.x) * 400;
        if (b.y < 8) c += (8 - b.y) * 400;
        if (b.x + b.w > vw - 8) c += (b.x + b.w - vw + 8) * 400;
        if (b.y + b.h > vh - 8) c += (b.y + b.h - vh + 8) * 400;
        return c + (q === s.quad ? 0 : 60); // stay put unless moving clearly helps
      };
      let best = s.quad;
      for (let q = 0; q < 4; q += 1) if (cost(q) < cost(best)) best = q;
      s.quad = best;
      const goal = box(best);
      if (!s.placed) {
        s.tagX.set(goal.x);
        s.tagY.set(goal.y);
        s.placed = true;
      }
      // A stiff, critically damped follow on real frame time: a hair of
      // lag, never a wobble, and never left behind on a slow machine.
      const x = s.tagX.step(goal.x, dt, 1600, 80);
      const y = s.tagY.step(goal.y, dt, 1600, 80);
      s.tag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      placed.push({ x, y, w, h });
    }
  }, []);

  /* One loop for everything, running only while there is something to draw. */
  const loop = useCallback(() => {
    const r = replay.current;
    let views: CursorView[];
    let more: boolean;
    let now: number;
    if (r) {
      now = r.clock.now();
      while (r.next < r.events.length && r.start + r.events[r.next].t <= now) {
        const e = r.events[r.next];
        foldAction(r.actions, e.event);
        r.director.handle(e.event, r.start + e.t);
        r.next += 1;
      }
      views = r.director.frame(now);
      more = r.next < r.events.length || r.director.active;
      if (!more) endReplay();
    } else {
      const d = live();
      now = performance.now();
      views = d.frame(now);
      more = d.active;
    }
    // Frame length on the clock being drawn (a replay's clock may be slowed).
    const dt = lastFrame.current === null ? 1 / 60 : Math.min(0.1, Math.max(0, (now - lastFrame.current) / 1000));
    lastFrame.current = now;
    paint(views, dt);
    if (more || replay.current) {
      raf.current = requestAnimationFrame(() => loopRef.current());
    } else {
      paint([], dt);
      raf.current = 0;
      lastFrame.current = null;
    }
  }, [paint, live, endReplay]);

  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);

  const kick = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(() => loopRef.current());
  }, []);

  /* Elements are handed to the slots as React mounts them. */
  const bind = useCallback((i: number, part: Exclude<keyof Slot, "ripples" | "tagX" | "tagY" | "quad" | "text" | "placed">) => {
    return (el: Element | null) => {
      (slots.current[i] as Record<string, unknown>)[part] = el;
    };
  }, []);
  const bindRipple = useCallback((i: number, k: number) => {
    return (el: SVGCircleElement | null) => {
      slots.current[i].ripples[k] = el;
    };
  }, []);

  /* Agent events drive the live director, are recorded for replay, and frame the camera. */
  useEffect(() => {
    let runPoints: { lat: number; lng: number }[] = [];
    let frameTimer: number | null = null;

    const onEvent = (incoming: AgentEvent) => {
      let event = incoming;
      const now = performance.now();
      if (event.name === "run.started") {
        endReplay();
        runPoints = [];
        recording.current = { start: now, events: [] };
      }

      if (event.name === "tool.started" && event.data.target) {
        // An older server without per-call timing: fall back to the one lead.
        if (event.data.lead_ms === undefined) event = { ...event, data: { ...event.data, lead_ms: lead.current } };
        // Every place this run is about to put something is kept in frame.
        const target = event.data.target!;
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
      }

      const rec = recording.current;
      if (rec) rec.events.push({ t: now - rec.start, event });
      if (event.name === "run.finished" && rec) {
        // Only a run a cursor took part in is worth replaying; a reply with
        // no actions keeps the last one that had some.
        if (hadCursorWork(rec.events.map((r) => r.event))) {
          lastRun.current = rec.events;
          setHasRun(true);
        }
        recording.current = null;
      }

      live().handle(event, now);
      kick();
    };

    const unsubscribe = subscribe(onEvent);
    return () => {
      unsubscribe();
      if (frameTimer !== null) window.clearTimeout(frameTimer);
    };
  }, [subscribe, canvas, kick, live, endReplay]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /* The Lab: Alt+Shift+C, or ?cursorlab in the address. Never while presenting. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === "KeyC") {
        e.preventDefault();
        setLabOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    const fromUrl = new URLSearchParams(window.location.search).has("cursorlab");
    const timer = fromUrl ? window.setTimeout(() => setLabOpen(true), 0) : null;
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const controls: LabControls = {
    canReplay: hasRun,
    replaying: () => Boolean(replay.current),
    replay: () => {
      const recorded = lastRun.current;
      if (!recorded) return;
      const events = withoutApprovalWaits(recorded);
      live().clear();
      const clock = new VirtualClock();
      clock.rate = tuning().slowmo;
      const changes = changesOf(events.map((r) => r.event));
      const landed = new Set<string>();
      // The replay's director tells us each click, so its change lands then.
      const replayEnv: DirectorEnv = {
        ...env.current!,
        clicked: (callId) => {
          if (!changes.has(callId) || landed.has(callId)) return;
          landed.add(callId);
          maskSink.current?.(maskFor(changes, landed));
        },
      };
      replay.current = {
        director: new Director(replayEnv),
        events,
        next: 0,
        clock,
        start: clock.now() + 50,
        actions: new Map(),
        changes,
        landed,
      };
      // Back to the screen as it was before the run.
      maskSink.current?.(maskFor(changes, landed));
      kick();
    },
    stopReplay: () => {
      endReplay();
      kick();
    },
    setRate: (rate) => {
      if (replay.current) replay.current.clock.rate = rate;
    },
    pause: (paused) => {
      if (replay.current) replay.current.clock.paused = paused;
    },
    step: () => {
      if (replay.current) replay.current.clock.step(1000 / 60);
    },
    sync: () => (replay.current?.director ?? director.current)?.sync ?? [],
    info,
  };

  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-[60]" aria-hidden="true">
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          {LANES.map((lane, i) => (
            <g key={lane.name} ref={bind(i, "group")} style={{ display: "none" }}>
              <polyline ref={bind(i, "path")} className="sayes-debug-path" fill="none" />
              <circle ref={bind(i, "press")} className="sayes-debug-press" r={7} fill="none" />
              <line ref={bind(i, "line")} className="agent-measuring" strokeWidth={3} strokeLinecap="round" />
              <circle ref={bind(i, "ghost")} r={22} strokeWidth={3} strokeDasharray="6 5" />
              {RIPPLES.map((k) => (
                <circle key={k} ref={bindRipple(i, k)} fill="none" strokeWidth={2} />
              ))}
              <path ref={bind(i, "main")} className="sayes-cursor-body" fillRule="evenodd" strokeLinejoin="round" paintOrder="stroke" />
              <path ref={bind(i, "badge")} className="sayes-cursor-body" fillRule="evenodd" strokeLinejoin="round" paintOrder="stroke" />
              <path ref={bind(i, "shimmer")} className="sayes-shimmer" fill="none" pathLength={100} strokeLinecap="round" />
            </g>
          ))}
        </svg>
        {LANES.map((lane, i) => (
          <div
            key={lane.name}
            ref={bind(i, "tag")}
            className="sayes-tag absolute left-0 top-0 flex items-center whitespace-nowrap rounded-full px-2.5 py-1 font-medium shadow-md"
            data-acting="0"
            style={{ display: "none" }}
          >
            <span className="font-mono text-[0.6875rem] font-semibold">{lane.name}</span>
            <span ref={bind(i, "tagText")} className="sayes-tag-text text-xs" />
          </div>
        ))}
      </div>
      {labOpen && !presentation ? <CursorLab controls={controls} onClose={() => setLabOpen(false)} /> : null}
    </>
  );
}
