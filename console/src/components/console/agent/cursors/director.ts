/**
 * The choreographer for the Sayes cursors.
 *
 * It turns the agent's live event stream into motion for a small, persistent
 * cast: cursors come out of the Sayes mark while the model is still writing
 * its tool calls, park near the edges of the map and idle there, take turns
 * acting (the server spaces their calls, see `lead_ms`), and at the end of a
 * run one of them wraps everything that changed before they all fly home.
 *
 * Every click is planned backwards from the moment the server says it will
 * send that call: depart, fly, settle, click on time. React never sees any of
 * this; `frame()` returns what to draw, once per animation frame.
 */

import type { AgentEvent, AgentTarget } from "@/lib/agent";
import { CURSOR_TOOLS, LANES } from "../labels";
import {
  BADGE_COLOUR,
  bounds,
  capsuleRing,
  dot,
  evaluate,
  glyph,
  glyphPlan,
  mapShape,
  planMorph,
  roundedRectRing,
  single,
  toPaths,
  type MorphPlan,
  type Ring,
  type Shape,
} from "./morph";
import {
  alongCurve,
  between,
  clamp,
  clearance,
  easeDrag,
  easeInOut,
  easeOut,
  flightMs,
  hash,
  lerp,
  noise,
  overshootEase,
  poseMatrix,
  rng,
  sampleCurve,
  Spring,
  transformRing,
  type Bend,
  type Vec,
} from "./motion";
import { OUTLINE_WIDTH, type GlyphName } from "./shapes";
import { calm, paced, tuning, type Tuning } from "./tuning";

export type Rect = { x: number; y: number; w: number; h: number };
type Resolver = () => Vec | null;
type ShapeKey = GlyphName | "dot";

/** What the director needs to know about the page. All in client pixels. */
export type DirectorEnv = {
  resolve(target: AgentTarget, part: "start" | "end"): Vec | null;
  /** A UI target's element box. */
  elementRect(target: AgentTarget): Rect | null;
  /** Both ends of a road, existing or about to be. */
  edgeEnds(target: AgentTarget): { a: Vec; b: Vec } | null;
  /** The map area cursors park around. */
  stage(): Rect;
  /** The Sayes mark, where cursors come from and go back to. */
  home(): Vec;
  /** Boxes a parked cursor should keep off (legend, panels, captions). */
  avoid(): Rect[];
  /** Root font scale: presentation mode makes everything bigger. */
  rootScale(): number;
  reducedMotion(): boolean;
  /** Told the moment a cursor clicks: a replay shows the change landing then. */
  clicked?(callId: string): void;
};

type JobKind = AgentTarget["kind"];

type Job = {
  callId: string;
  tool: string;
  lane: number;
  target: AgentTarget;
  kind: JobKind;
  /** When the server will send the call: the click. */
  pressAt: number;
  /** When the cursor plans to click (pressAt, or later if it cannot make it), and to start drawing. Set by start(). */
  clickAt: number | null;
  drawFrom: number | null;
  /** When the cursor actually clicked (later than pressAt only if it could not make it). */
  pressedAt: number | null;
  /** When the server sent the call, on this clock; known once it is finished. */
  sentAt: number | null;
  synced: boolean;
  announcedAt: number;
  arrived: boolean;
  confirm: boolean;
  dragging: boolean;
  measuring: boolean;
  drawing: boolean;
  done: boolean;
  ok: boolean | null;
};

type Flight = {
  t0: number;
  dur: number;
  from: Resolver;
  to: Resolver;
  bend: Bend;
  ease: (t: number) => number;
  /**
   * The flight this one took over from mid-air, faded out over `blend` ms so
   * the hand carries its speed into the new move instead of stopping dead
   * and lurching off again.
   */
  prev: Flight | null;
  blend: number;
};

type Morph = { from: ShapeKey; to: ShapeKey; t0: number; dur: number };

type Hug = {
  ring: () => Ring | null;
  rect: () => Rect | null;
  t0: number;
  dur: number;
  dir: 1 | -1;
  plan: MorphPlan | null;
};

type Tween = { from: number; to: number; t0: number; dur: number };

type Cursor = {
  lane: number;
  name: string;
  colour: string;
  ink: string;
  rand: () => number;
  swayX: (x: number) => number;
  swayY: (x: number) => number;
  wobble: (x: number) => number;
  idlePhase: number;

  state: "entering" | "parked" | "busy" | "leaving";
  rest: Resolver;
  flight: Flight | null;
  flightPath: Vec[] | null;
  drawn: Vec;
  vel: Vec;
  acc: Vec;
  heading: number;
  idleWeight: Spring;
  lean: Spring;
  stretch: Spring;
  skew: Spring;
  press: Spring;
  pressUntil: number;
  pressDepth: number;
  holdDepth: number;
  size: Tween;
  opacity: Tween;

  morph: Morph;
  hug: Hug | null;
  shimmer: boolean;

  slot: Vec | null;
  nextMicro: number;

  job: Job | null;
  queue: Job[];
  timeline: { at: number; fn: () => void; callId?: string }[];
  ripples: { x: number; y: number; t0: number }[];
  line: { from: Resolver; to: Resolver; until: number } | null;
  ghost: boolean;
};

export type CursorView = {
  lane: number;
  name: string;
  colour: string;
  ink: string;
  opacity: number;
  main: string;
  badge: string;
  badgeColour: string | null;
  /** 0 = a cursor, 1 = fully a highlight around something, by time. */
  hug: number;
  /** The same by size: how far the outline, fill and shadow have turned from a cursor's to a highlight's. */
  look: number;
  /** The body's fill opacity: solid as a cursor, a tint as a highlight. */
  fillOpacity: number;
  strokeWidth: number;
  shimmer: number | null;
  /** Where the name tag hangs from, and what it must not cover. */
  anchor: Vec;
  focus: Rect | null;
  /** The call it is acting on, for the tag's words. Null when parked. */
  callId: string | null;
  acting: boolean;
  line: { x1: number; y1: number; x2: number; y2: number } | null;
  ghost: { x: number; y: number } | null;
  ripples: { x: number; y: number; r: number; opacity: number }[];
  path: Vec[] | null;
  press: Vec | null;
};

export type SyncRecord = { callId: string; lane: number; deltaMs: number; lateMs: number };

const NODE_RADIUS = 22;

/** The server's default lead (AGENT_CURSOR_LEAD_MS), for events that do not carry one. */
export const DEFAULT_LEAD_MS = 2000;

/** The fastest a cursor may cover ground when it is short of time, px per ms (1600 px/s on average). */
const MAX_SPEED = 1.6;

/** Two spots closer than this are the same place: one checkpoint, one button. */
const SAME_SPOT = 30;

/** How far a cursor stands off a spot another one is using. */
const STAND_OFF = 40;

/** Speed and turning are measured this many ms either side of the frame. */
const DERIVATIVE_MS = 16;

export class Director {
  private env: DirectorEnv;
  private cast = new Map<number, Cursor>();
  private runSeed = 0;
  private thinking = false;
  private pendingCursors = 0;
  private lastNow = 0;
  private touched: AgentTarget[] = [];
  private finaleTimer: number | null = null;
  private rawTuning: Tuning | null = null;
  private pacedTuning: Tuning | null = null;
  /** Clicks against when the server actually sent the call, newest last. */
  readonly sync: SyncRecord[] = [];

  constructor(env: DirectorEnv) {
    this.env = env;
  }

  get size() {
    return this.cast.size;
  }

  private t(): Tuning {
    // The overall speed applied once per change of the values, not every call.
    const raw = tuning();
    if (raw !== this.rawTuning) {
      this.rawTuning = raw;
      this.pacedTuning = paced(raw);
    }
    const t = this.pacedTuning!;
    return this.env.reducedMotion() ? calm(t) : t;
  }

  /* -----------------------------------------------------------------------
     Events
     ----------------------------------------------------------------------- */

  handle(event: AgentEvent, now: number) {
    switch (event.name) {
      case "run.started": {
        this.runSeed = hash(event.data.run_id) ^ (tuning().seed >>> 0);
        this.touched = [];
        this.finaleTimer = null;
        // Cursors still on their way home from the last run come back.
        for (const c of this.cast.values()) {
          if (c.state === "leaving") this.returnToStage(c, now);
          c.queue = [];
        }
        return;
      }
      case "thinking.started":
        this.thinking = true;
        this.pendingCursors = 0;
        return;
      case "thinking.stopped":
        this.thinking = false;
        return;
      case "tool.pending":
        if (!CURSOR_TOOLS.has(event.data.tool)) return;
        this.pendingCursors += 1;
        this.ensureCast(Math.min(this.pendingCursors, this.t().castMax), now);
        return;
      case "tool.started": {
        const { target } = event.data;
        if (!target) return;
        const lead = event.data.lead_ms ?? DEFAULT_LEAD_MS;
        const job: Job = {
          callId: event.data.call_id,
          tool: event.data.tool,
          lane: event.data.lane,
          target,
          kind: target.kind,
          pressAt: now + lead,
          clickAt: null,
          drawFrom: null,
          pressedAt: null,
          sentAt: null,
          synced: false,
          announcedAt: now,
          arrived: false,
          confirm: false,
          dragging: false,
          measuring: false,
          drawing: false,
          done: false,
          ok: null,
        };
        const c = this.ensureLane(this.cursorFor(event.data.lane), now);
        if (c.job && !c.job.done) c.queue.push(job);
        else this.start(c, job, now);
        return;
      }
      case "tool.progress": {
        const found = this.find(event.data.call_id);
        if (found) {
          found.job.measuring = true;
          found.cursor.shimmer = true;
        }
        return;
      }
      case "tool.confirm_required": {
        const found = this.find(event.data.call_id);
        if (!found) return;
        found.job.confirm = true;
        // If it is already there, it asks now; otherwise it asks on arrival.
        if (found.job.arrived && found.cursor.job === found.job) this.ask(found.cursor, now);
        return;
      }
      case "tool.confirmed": {
        const found = this.find(event.data.call_id);
        if (!found) return;
        const { cursor, job } = found;
        job.confirm = false;
        cursor.shimmer = false;
        if (event.data.outcome === "approved") {
          job.announcedAt = now;
          this.drag(cursor, job, now, event.data.lead_ms ?? DEFAULT_LEAD_MS);
        }
        return;
      }
      case "tool.finished": {
        const found = this.find(event.data.call_id);
        if (!found) return;
        const { cursor, job } = found;
        if (typeof event.data.sent_after_ms === "number") {
          job.sentAt = job.announcedAt + event.data.sent_after_ms;
          this.recordSync(job);
        }
        this.finish(cursor, job, event.data.ok, now);
        if (event.data.ok) this.touched.push(job.target);
        return;
      }
      case "run.finished":
        this.finale(event.data.outcome, now);
        return;
      default:
        return;
    }
  }

  /** Once both are known (either can come first): the click against the send. */
  private recordSync(job: Job) {
    if (job.pressedAt === null || job.sentAt === null || job.synced) return;
    job.synced = true;
    this.sync.push({
      callId: job.callId,
      lane: job.lane,
      deltaMs: Math.round(job.sentAt - job.pressedAt),
      lateMs: Math.round(Math.max(0, job.pressedAt - job.pressAt)),
    });
    if (this.sync.length > 40) this.sync.shift();
  }

  private find(callId: string) {
    for (const cursor of this.cast.values()) {
      if (cursor.job?.callId === callId) return { cursor, job: cursor.job };
      const queued = cursor.queue.find((j) => j.callId === callId);
      if (queued) return { cursor, job: queued };
    }
    return null;
  }

  private cursorFor(lane: number) {
    return ((Math.max(1, lane) - 1) % this.t().castMax) + 1;
  }

  /* -----------------------------------------------------------------------
     The cast
     ----------------------------------------------------------------------- */

  private ensureCast(count: number, now: number) {
    let delay = 0;
    for (let lane = 1; lane <= count; lane += 1) {
      if (this.cast.has(lane)) continue;
      this.spawn(lane, now, delay);
      // Out of the mark one by one, far enough apart that their name tags do not pile up.
      delay += 180;
    }
  }

  private ensureLane(lane: number, now: number) {
    return this.cast.get(lane) ?? this.spawn(lane, now, 0);
  }

  private spawn(lane: number, now: number, delay: number): Cursor {
    const t = this.t();
    const info = LANES[(lane - 1) % LANES.length];
    const seed = hash(`${lane}`) ^ this.runSeed;
    const home = this.env.home();
    const c: Cursor = {
      lane,
      name: info.name,
      colour: t.colours[lane - 1] ?? info.colour,
      ink: info.ink,
      rand: rng(seed),
      swayX: noise(seed ^ 0x9e37),
      swayY: noise(seed ^ 0x79b9),
      wobble: noise(seed ^ 0x51ed),
      idlePhase: (seed % 1000) / 100,
      state: "entering",
      rest: () => home,
      flight: null,
      flightPath: null,
      drawn: { ...home },
      vel: { x: 0, y: 0 },
      acc: { x: 0, y: 0 },
      heading: 0,
      idleWeight: new Spring(0),
      lean: new Spring(0),
      stretch: new Spring(1),
      skew: new Spring(0),
      press: new Spring(1),
      pressUntil: 0,
      pressDepth: 1,
      holdDepth: 1,
      size: { from: 0.35, to: 0.35, t0: now, dur: 1 },
      opacity: { from: 0, to: 0, t0: now, dur: 1 },
      morph: { from: "dot", to: "dot", t0: now, dur: 1 },
      hug: null,
      shimmer: false,
      slot: null,
      nextMicro: Infinity,
      job: null,
      queue: [],
      timeline: [],
      ripples: [],
      line: null,
      ghost: false,
    };
    this.cast.set(lane, c);
    this.at(c, now + delay, () => this.emerge(c, now + delay));
    return c;
  }

  /** Out of the mark: a dot that grows into a pointer on its way to a parking spot. */
  private emerge(c: Cursor, now: number) {
    const t = this.t();
    const home = this.env.home();
    c.drawn = { ...home };
    c.opacity = { from: 0, to: 1, t0: now, dur: 160 };
    c.size = { from: 0.35, to: 1, t0: now, dur: 420 };
    this.shapeTo(c, "pointer", now + 60, t.morphMs + 120);
    if (c.job) return; // already given work: start() has sent it there
    const slot = this.pickSlot(c, now);
    this.fly(c, () => home, () => slot, now, flightMs(dist(home, slot), t.flightBase, t.flightK, t.flightMin, t.flightMax) * 1.1, 0);
    c.slot = slot;
    c.rest = () => slot;
    this.at(c, now + 400, () => {
      if (c.state === "entering") this.parkState(c, now + 400);
    });
  }

  private returnToStage(c: Cursor, now: number) {
    c.timeline = c.timeline.filter((e) => e.callId);
    c.opacity = { from: this.tween(c.opacity, now), to: 1, t0: now, dur: 160 };
    c.size = { from: this.tween(c.size, now), to: 1, t0: now, dur: 300 };
    this.shapeTo(c, "pointer", now, this.t().morphMs);
    this.park(c, now);
  }

  /* -----------------------------------------------------------------------
     Parking and idling
     ----------------------------------------------------------------------- */

  private slots(): Vec[] {
    const s = this.env.stage();
    const inset = this.t().parkInset;
    const x0 = s.x + inset;
    const x1 = s.x + s.w - inset;
    const y0 = s.y + inset;
    const y1 = s.y + s.h - inset;
    const xs = [x0, lerp(x0, x1, 1 / 3), lerp(x0, x1, 2 / 3), x1];
    const ys = [y0, lerp(y0, y1, 1 / 3), lerp(y0, y1, 2 / 3), y1];
    const out: Vec[] = [];
    for (const x of xs) out.push({ x, y: y0 }, { x, y: y1 });
    for (const y of ys.slice(1, 3)) out.push({ x: x0, y }, { x: x1, y });
    return out;
  }

  /** Where the action is: every target a cursor is on or going to. */
  private hotspots(except?: Cursor): Vec[] {
    const out: Vec[] = [];
    for (const c of this.cast.values()) {
      if (c === except || !c.job) continue;
      const p = this.env.resolve(c.job.target, "start");
      if (p) out.push(p);
      if (c.job.kind === "edge-new" || c.job.kind === "node-move") {
        const q = this.env.resolve(c.job.target, "end");
        if (q) out.push(q);
      }
    }
    return out;
  }

  private pickSlot(c: Cursor, now: number): Vec {
    const hot = this.hotspots(c);
    const others: Vec[] = [];
    for (const o of this.cast.values()) {
      if (o === c) continue;
      if (o.slot) others.push(o.slot);
      else others.push(this.position(o, now));
    }
    const avoid = this.env.avoid();
    let best: Vec | null = null;
    let bestCost = Infinity;
    for (const s of this.slots()) {
      let cost = dist(s, c.drawn) * 0.6;
      for (const h of hot) cost += Math.max(0, 220 - dist(s, h)) * 6;
      for (const o of others) cost += Math.max(0, 160 - dist(s, o)) * 8;
      for (const r of avoid) if (inRect(s, r, 28)) cost += 2000;
      cost += c.rand() * 40; // a little variety in who parks where
      if (cost < bestCost) {
        bestCost = cost;
        best = s;
      }
    }
    return best ?? { x: this.env.stage().x + 60, y: this.env.stage().y + 60 };
  }

  private park(c: Cursor, now: number) {
    const t = this.t();
    const slot = this.pickSlot(c, now);
    const from = this.position(c, now);
    c.slot = slot;
    c.state = "parked";
    c.job = null;
    c.line = null;
    c.ghost = false;
    // Parking is a minor move: lazier than acting.
    const dur = flightMs(dist(from, slot), t.flightBase, t.flightK, t.flightMin, t.flightMax) * 1.2;
    this.fly(c, () => from, () => slot, now, dur, 0);
    c.rest = () => slot;
    c.nextMicro = now + dur + between(c.rand, t.microMin, t.microMax);
  }

  private parkState(c: Cursor, now: number) {
    c.state = "parked";
    c.nextMicro = now + between(c.rand, this.t().microMin, this.t().microMax);
  }

  /** A parked cursor shifts a little now and then, as a resting hand does. */
  private microMove(c: Cursor, now: number) {
    const t = this.t();
    c.nextMicro = now + between(c.rand, t.microMin, t.microMax);
    if (!c.slot || c.flight) return;
    const a = c.rand() * Math.PI * 2;
    const r = between(c.rand, t.microRadius * 0.4, t.microRadius);
    const s = this.env.stage();
    const to = {
      x: clamp(c.slot.x + Math.cos(a) * r, s.x + 24, s.x + s.w - 24),
      y: clamp(c.slot.y + Math.sin(a) * r, s.y + 24, s.y + s.h - 24),
    };
    const from = this.position(c, now);
    this.fly(c, () => from, () => to, now, between(c.rand, 520, 760), 0, true);
    c.rest = () => to;
  }

  /* -----------------------------------------------------------------------
     Jobs
     ----------------------------------------------------------------------- */

  private start(c: Cursor, job: Job, now: number) {
    const t = this.t();
    // A new job can arrive while the last one is still being wrapped up (the
    // nod, the morph back, the walk to a parking spot): that wrap-up is
    // dropped, and anything it was holding is let go now.
    c.timeline = c.timeline.filter((e) => !e.callId?.startsWith("done:"));
    if (c.hug) c.hug = { ...c.hug, t0: now, dur: t.hugMs, dir: -1, plan: null };
    c.line = null;
    c.ghost = false;
    c.holdDepth = 1;
    c.job = job;
    c.state = "busy";
    c.slot = null;
    c.nextMicro = Infinity;
    c.shimmer = false;

    const env = this.env;
    const A: Resolver = () => env.resolve(job.target, "start");
    const B: Resolver = () => env.resolve(job.target, "end");
    const here = this.position(c, now);
    const a = A() ?? here;
    // Big targets need not be hit dead centre.
    const jitter = job.kind === "ui" || job.kind === "edge" ? t.jitter : 0;
    const jx = (c.rand() * 2 - 1) * jitter;
    const jy = (c.rand() * 2 - 1) * jitter;
    const aim: Resolver = jitter ? () => add(A(), jx, jy) : A;

    let settle = t.settle;
    let draw = 0;
    let feeder: Job | null = null;
    if (job.kind === "edge-new") {
      const b = B() ?? a;
      // Drawing goes at the pace the flights are tuned to, a little brisker.
      draw = clamp(0.4 * flightMs(dist(a, b), t.flightBase, t.flightK, t.flightMin, t.flightMax), 300, 1000);
      // A road that carries on from one another cursor is drawing: set off
      // just after that pen does, so both draw together and this one is well
      // on its way when the other lands. Waiting on the checkpoint for it to
      // arrive reads as one cursor in a relay.
      feeder = this.feeder(c, a, now);
      if (feeder && feeder.clickAt !== null && feeder.drawFrom !== null) {
        const together = feeder.drawFrom + (feeder.clickAt - feeder.drawFrom) * 0.15;
        draw = clamp(job.pressAt - together, draw, Math.max(draw * 1.8, 900));
      }
    }
    const distance = dist(here, a);
    let flight = flightMs(distance, t.flightBase, t.flightK, t.flightMin, t.flightMax);
    const confirmFlow = job.kind === "node-move";

    // Short of time (the server sends the call `lead_ms` after announcing
    // it): first the pause before the click shrinks, then the flight and the
    // drawing together, never faster than a hand could move. Past that it
    // clicks late: a late click looks better than a cursor that teleports.
    let over = flight + settle + draw - (job.pressAt - now);
    if (over > 0) {
      const cut = Math.min(over, settle - Math.min(settle, Math.max(90, settle * 0.4)));
      settle -= cut;
      over -= cut;
    }
    if (over > 0) {
      const flightRoom = flight - Math.min(flight, Math.max(260, distance / MAX_SPEED));
      const drawRoom = draw - Math.min(draw, 260);
      const k = flightRoom + drawRoom > 0 ? Math.min(1, over / (flightRoom + drawRoom)) : 0;
      flight -= flightRoom * k;
      draw -= drawRoom * k;
      over -= (flightRoom + drawRoom) * k;
    }
    const press = job.pressAt + Math.max(0, over);
    const drawStart = press - draw;
    const depart = Math.max(now, drawStart - settle - flight);
    const arrive = depart + flight;
    job.clickAt = press;
    job.drawFrom = drawStart;

    // Someone else is on this spot while this one waits: wait beside it and
    // step on just in time, so two cursors never sit on top of each other.
    const stepOn = job.kind === "edge-new" ? drawStart : press - Math.min(settle, 120);
    const offset = job.kind === "edge-new" || job.kind === "point" ? this.standOff(c, a, arrive - 300, stepOn + 200, feeder) : null;
    const wait: Resolver = offset ? () => add(A(), offset.x, offset.y) : aim;

    // Anticipation: a small pull back before it goes, if there is time for it.
    if (depart - t.anticipationMs >= now && t.anticipation > 0 && distance > 40) {
      this.at(c, depart - t.anticipationMs, () => {
        const from = this.position(c, depart - t.anticipationMs);
        const to = A() ?? a;
        const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const back = { x: from.x - ((to.x - from.x) / d) * t.anticipation, y: from.y - ((to.y - from.y) / d) * t.anticipation };
        this.fly(c, () => from, () => back, depart - t.anticipationMs, t.anticipationMs, 0, true);
        c.rest = () => back;
      }, job.callId);
    }

    if (offset) {
      const hop = Math.max(arrive, stepOn - 220);
      this.at(c, hop, () => {
        const from = this.position(c, hop);
        this.fly(c, () => from, aim, hop, Math.max(120, stepOn - hop), 0, true);
        c.rest = aim;
      }, job.callId);
    }

    this.at(c, depart, () => {
      const from = this.position(c, depart);
      this.fly(c, () => from, wait, depart, flight, this.pickBend(c, from, A() ?? a, now));
      c.rest = wait;
      // Become the tool on the way in, so it is ready when it lands.
      const tool = this.toolGlyph(job.kind);
      if (tool !== "pointer") {
        const start = depart + flight * 0.6;
        this.shapeTo(c, tool, start, Math.max(120, Math.min(t.morphMs, arrive + settle - start)));
      } else {
        this.shapeTo(c, "pointer", depart, t.morphMs);
      }
    }, job.callId);

    this.at(c, arrive, () => {
      job.arrived = true;
      if (job.confirm) this.ask(c, arrive);
    }, job.callId);
    if (confirmFlow) return;

    if (job.kind === "edge-new") {
      // Drawing the road: the pen goes from one checkpoint to the other, the
      // line following its tip, and clicks on the far one.
      this.shapeTo(c, "pen", arrive - 40, Math.min(t.morphMs, settle + 40));
      this.at(c, drawStart, () => {
        job.drawing = true;
        this.fly(c, A, B, drawStart, draw, 0, false, easeDrag);
        c.rest = B;
        c.line = { from: A, to: () => this.position(c, this.lastNow), until: Infinity };
      }, job.callId);
      this.at(c, press, () => {
        c.line = { from: A, to: B, until: Infinity };
        this.click(c, job, press, B);
      }, job.callId);
      return;
    }

    const clickAt = Math.max(arrive, press);
    this.at(c, clickAt, () => {
      this.click(c, job, clickAt, A);
      const hugAt = clickAt + 110;
      if (job.kind === "ui") this.hugIn(c, () => this.elementRing(job.target), () => env.elementRect(job.target), hugAt, undefined, `hug:${job.callId}`);
      if (job.kind === "edge") this.hugIn(c, () => this.edgeRing(job.target), () => this.edgeRect(job.target), hugAt, undefined, `hug:${job.callId}`);
    }, job.callId);
  }

  /** Where a job ends up: the far checkpoint of a new road, a moved checkpoint's new place, otherwise where it clicks. */
  private endOf(job: Job): Vec | null {
    return this.env.resolve(job.target, job.kind === "edge-new" || job.kind === "node-move" ? "end" : "start");
  }

  /** Another cursor drawing a road into `spot` that has not got there yet. */
  private feeder(c: Cursor, spot: Vec, now: number): Job | null {
    for (const o of this.cast.values()) {
      const j = o.job;
      if (o === c || !j || j.done || j.kind !== "edge-new" || j.clickAt === null || j.clickAt <= now) continue;
      const end = this.endOf(j);
      if (end && dist(end, spot) < SAME_SPOT) return j;
    }
    return null;
  }

  /**
   * If another cursor is on `spot`, or clicks there, between `from` and
   * `to` (other than the pen this one is drawing alongside): which way to
   * stand off it (an offset from the spot), else null.
   */
  private standOff(c: Cursor, spot: Vec, from: number, to: number, drawingAlong: Job | null): Vec | null {
    let away: Vec | null = null;
    for (const o of this.cast.values()) {
      if (o === c) continue;
      const j = o.job;
      // The pen this one draws alongside lands after it has left: no clash.
      if (j && j === drawingAlong) continue;
      const clicksThere = j && j.clickAt !== null && j.clickAt >= from && j.clickAt <= to && (() => {
        const end = this.endOf(j);
        return end !== null && dist(end, spot) < SAME_SPOT;
      })();
      const sitting = dist(this.position(o, from), spot) < SAME_SPOT && (!j || j.done);
      if (!clicksThere && !sitting) continue;
      // Stand on the side away from where the other one comes from.
      const p = this.position(o, from);
      const dx = spot.x - p.x;
      const dy = spot.y - p.y;
      const d = Math.hypot(dx, dy);
      away = d > 4 ? { x: dx / d, y: dy / d } : { x: 0.6, y: -0.8 };
      break;
    }
    if (!away) return null;
    // A little off the straight line, so it stands beside the spot rather than in the next one's path.
    const s = this.env.stage();
    let x = away.x * 0.8 - away.y * 0.6;
    let y = away.y * 0.8 + away.x * 0.6;
    const out = { x: spot.x + x * STAND_OFF, y: spot.y + y * STAND_OFF };
    if (out.x < s.x + 20 || out.x > s.x + s.w - 20) x = -x;
    if (out.y < s.y + 20 || out.y > s.y + s.h - 20) y = -y;
    return { x: x * STAND_OFF, y: y * STAND_OFF };
  }

  /** Another cursor that is about to start on `spot` and has not got there yet. */
  private incoming(c: Cursor, spot: Vec, now: number): Cursor | null {
    for (const o of this.cast.values()) {
      const j = o.job;
      if (o === c || !j || j.done || j.drawing || j.pressedAt !== null) continue;
      if ((j.drawFrom ?? j.pressAt) < now - 50) continue;
      const start = this.env.resolve(j.target, "start");
      if (start && dist(start, spot) < SAME_SPOT) return o;
    }
    return null;
  }

  private toolGlyph(kind: JobKind): GlyphName {
    switch (kind) {
      case "point":
        return this.t().placeGlyph;
      case "node-move":
        return "move";
      case "ui":
        return "link";
      case "edge-new":
        return "pointer"; // becomes the pen once it is on the checkpoint
      default:
        return "pointer";
    }
  }

  private click(c: Cursor, job: Job, at: number, where: Resolver) {
    const t = this.t();
    job.pressedAt = at;
    this.recordSync(job);
    this.env.clicked?.(job.callId);
    c.pressUntil = at + t.pressMs;
    // The cross's arrows close right in on the spot; a pointer just dips.
    c.pressDepth = job.kind === "point" && t.placeGlyph === "cross" ? Math.min(t.pressScale, 0.72) : t.pressScale;
    const p = where() ?? this.position(c, at);
    c.ripples.push({ x: p.x, y: p.y, t0: at });
  }

  private ask(c: Cursor, now: number) {
    this.shapeTo(c, "help", now, this.t().morphMs);
    c.shimmer = true;
  }

  private drag(c: Cursor, job: Job, now: number, lead: number) {
    const t = this.t();
    const A: Resolver = () => this.env.resolve(job.target, "start");
    const B: Resolver = () => this.env.resolve(job.target, "end");
    this.cancel(c, job.callId);
    job.pressAt = now + lead;
    job.clickAt = job.pressAt;
    this.shapeTo(c, "move", now, Math.min(t.morphMs, 200));
    const grab = now + Math.min(200, lead * 0.25);
    job.drawFrom = grab;
    const dragDur = Math.max(240, job.pressAt - grab - 60);
    this.at(c, grab, () => {
      // Pick it up: a press held for the whole carry.
      c.holdDepth = 0.94;
      c.pressUntil = grab + t.pressMs;
      c.pressDepth = t.pressScale;
      job.dragging = true;
      c.ghost = true;
      const from = A() ?? this.position(c, grab);
      const to = B() ?? from;
      this.fly(c, A, B, grab, dragDur, this.pickBend(c, from, to, grab) * 0.5, false, easeDrag);
      c.rest = B;
    }, job.callId);
    this.at(c, job.pressAt, () => {
      c.holdDepth = 1;
      this.click(c, job, job.pressAt, B);
    }, job.callId);
  }

  private finish(c: Cursor, job: Job, ok: boolean, now: number) {
    const t = this.t();
    job.done = true;
    job.ok = ok;
    if (c.job !== job) {
      // Finished while still queued (it never got its turn): drop it.
      c.queue = c.queue.filter((j) => j !== job);
      return;
    }
    c.shimmer = false;
    c.holdDepth = 1;
    job.dragging = false;

    // Every wrap-up step is tagged, so a new job can drop the lot.
    const done = `done:${job.callId}`;
    let leaveAt: number;
    if (ok) {
      // A success can be reported a moment before the click it answers was
      // drawn (the call is that fast): everything below waits for the click.
      const clicked = job.pressedAt ?? job.pressAt;
      const after = Math.max(now, clicked) + 40;
      this.at(c, after, () => {
        c.ghost = false;
        job.drawing = false;
        if (c.line) c.line.until = after + (job.kind === "edge-new" ? 500 : 0);
      }, done);
      if (job.kind === "ui" || job.kind === "edge") {
        // Hold the highlight long enough to be seen, then let go of it.
        const out = Math.max(after + 200, clicked + 110 + t.hugMs + 600);
        this.hugOut(c, out, done);
        this.shapeTo(c, "pointer", out, t.morphMs, done);
        leaveAt = out + Math.max(t.hugMs, t.morphMs) + t.beat;
      } else {
        // Someone is about to start from this very spot: make way first, so
        // the hand-over has a gap and two cursors, not one cursor jumping.
        this.at(c, after, () => {
          const spot = this.position(c, after);
          const next = this.incoming(c, spot, after);
          if (!next) return;
          const p = this.position(next, after);
          const end = next.job ? this.endOf(next.job) : null;
          // Away from where it comes from and from where it is going next.
          const dp = Math.hypot(spot.x - p.x, spot.y - p.y) || 1;
          let dx = (spot.x - p.x) / dp;
          let dy = (spot.y - p.y) / dp;
          if (end) {
            const de = Math.hypot(spot.x - end.x, spot.y - end.y) || 1;
            dx += (spot.x - end.x) / de;
            dy += (spot.y - end.y) / de;
          }
          const d = Math.hypot(dx, dy);
          if (d < 0.2) {
            // The two cancel out (it comes in and goes back the same way): step sideways.
            dx = -(spot.y - p.y) / dp;
            dy = (spot.x - p.x) / dp;
          }
          const n = Math.hypot(dx, dy) || 1;
          const aside = { x: spot.x + (dx / n) * STAND_OFF, y: spot.y + (dy / n) * STAND_OFF };
          this.fly(c, () => spot, () => aside, after, 300, 0, true);
          c.rest = () => aside;
        }, done);
        // A small nod, then back to a pointer.
        this.at(c, after, () => c.press.kick(0.9), done);
        this.shapeTo(c, "pointer", after + 120, t.morphMs, done);
        leaveAt = after + 120 + t.morphMs + t.beat;
      }
    } else {
      // No: the badge, a shake of the head, then back to a pointer.
      this.cancel(c, job.callId);
      this.cancel(c, `hug:${job.callId}`);
      job.drawing = false;
      c.ghost = false;
      if (c.line) c.line.until = now;
      if (c.hug) this.hugOut(c, now, done);
      this.shapeTo(c, "unavailable", now, t.morphMs, done);
      this.at(c, now + t.morphMs * 0.6, () => c.lean.kick(-140), done);
      this.at(c, now + t.morphMs * 0.6 + 150, () => c.lean.kick(220), done);
      this.at(c, now + t.morphMs * 0.6 + 300, () => c.lean.kick(-120), done);
      this.shapeTo(c, "pointer", now + 900, t.morphMs, done);
      leaveAt = now + 900 + t.morphMs + t.beat;
    }
    this.at(c, leaveAt, () => {
      if (c.job !== job) return; // already on to something else
      const next = c.queue.shift();
      if (next) this.start(c, next, leaveAt);
      else if (c.state === "busy") this.park(c, leaveAt);
    }, done);
  }

  /* -----------------------------------------------------------------------
     The finale
     ----------------------------------------------------------------------- */

  private finale(outcome: string, now: number) {
    const t = this.t();
    const cursors = [...this.cast.values()].sort((a, b) => a.lane - b.lane);
    if (cursors.length === 0) return;
    // Whatever is still mid-action finishes first.
    const busyUntil = Math.max(now, ...cursors.flatMap((c) => c.timeline.map((e) => e.at)));
    const start = busyUntil + 120;
    const rect = outcome === "completed" ? this.touchedRect() : null;

    if (!rect) {
      this.flyHome(cursors, start);
      return;
    }
    const lead = cursors[0];
    const corner = { x: rect.x, y: rect.y };
    const ring = () => {
      const r = this.touchedRect();
      return r ? roundedRectRing(r.x, r.y, r.w, r.h, 18) : null;
    };
    this.at(lead, start, () => {
      lead.state = "busy";
      lead.slot = null;
      const from = this.position(lead, start);
      const dur = flightMs(dist(from, corner), t.flightBase, t.flightK, t.flightMin, t.flightMax);
      this.fly(lead, () => from, () => corner, start, dur, this.pickBend(lead, from, corner, start));
      lead.rest = () => corner;
      this.hugIn(lead, ring, () => this.touchedRect(), start + dur + 40, t.hugMs * 1.5);
      const end = start + dur + 40 + t.hugMs * 1.5 + t.wrapHold;
      this.hugOut(lead, end);
      // Everyone else gathers round while the wrap holds.
      for (const c of cursors.slice(1)) {
        this.at(c, start + 120, () => {
          const r = this.touchedRect() ?? rect;
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          const p = this.position(c, start + 120);
          const ang = Math.atan2(p.y - cy, p.x - cx);
          const reach = Math.hypot(r.w, r.h) / 2 + 70;
          const s = this.env.stage();
          const spot = {
            x: clamp(cx + Math.cos(ang) * reach, s.x + 30, s.x + s.w - 30),
            y: clamp(cy + Math.sin(ang) * reach, s.y + 30, s.y + s.h - 30),
          };
          const from = this.position(c, start + 120);
          this.fly(c, () => from, () => spot, start + 120, 700, this.pickBend(c, from, spot, start), true);
          c.rest = () => spot;
          c.slot = spot;
        });
      }
      this.at(lead, end + t.hugMs, () => this.flyHome(cursors, end + t.hugMs));
    });
  }

  private touchedRect(): Rect | null {
    const pts: Vec[] = [];
    for (const target of this.touched) {
      if (target.kind === "ui") continue;
      if (target.kind === "edge" || target.kind === "edge-new") {
        const ends = this.env.edgeEnds(target);
        if (ends) pts.push(ends.a, ends.b);
        continue;
      }
      const p = this.env.resolve(target, target.kind === "node-move" ? "end" : "start");
      if (p) pts.push(p);
    }
    if (pts.length === 0) return null;
    const pad = this.t().wrapPad + NODE_RADIUS;
    // Kept inside the map: a wrap that runs off it reads as a glitch.
    const s = this.env.stage();
    const x0 = Math.max(s.x + 6, Math.min(...pts.map((p) => p.x)) - pad);
    const y0 = Math.max(s.y + 6, Math.min(...pts.map((p) => p.y)) - pad);
    const x1 = Math.min(s.x + s.w - 6, Math.max(...pts.map((p) => p.x)) + pad);
    const y1 = Math.min(s.y + s.h - 6, Math.max(...pts.map((p) => p.y)) + pad);
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  private flyHome(cursors: Cursor[], now: number) {
    const t = this.t();
    cursors.forEach((c, i) => {
      const at = now + i * t.homeStagger;
      this.at(c, at, () => {
        c.state = "leaving";
        c.slot = null;
        c.job = null;
        const from = this.position(c, at);
        const home = this.env.home();
        const dur = flightMs(dist(from, home), t.flightBase, t.flightK, t.flightMin, t.flightMax) * 1.05;
        this.fly(c, () => from, () => this.env.home(), at, dur, this.pickBend(c, from, home, at));
        c.rest = () => this.env.home();
        this.shapeTo(c, "dot", at + dur * 0.5, dur * 0.5);
        c.size = { from: 1, to: 0.45, t0: at + dur * 0.45, dur: dur * 0.55 };
        c.opacity = { from: 1, to: 0, t0: at + dur * 0.8, dur: dur * 0.2 + 60 };
        this.at(c, at + dur + 80, () => {
          if (c.state === "leaving") this.cast.delete(c.lane);
        });
      });
    });
  }

  /* -----------------------------------------------------------------------
     Motion primitives
     ----------------------------------------------------------------------- */

  private at(c: Cursor, at: number, fn: () => void, callId?: string) {
    c.timeline.push({ at, fn, callId });
  }

  private cancel(c: Cursor, callId: string) {
    c.timeline = c.timeline.filter((e) => e.callId !== callId);
  }

  private fly(
    c: Cursor,
    from: Resolver,
    to: Resolver,
    t0: number,
    dur: number,
    bendAmount: number,
    minor = false,
    ease?: (t: number) => number,
  ) {
    const t = this.t();
    const a = from() ?? c.drawn;
    const b = to() ?? a;
    const L = dist(a, b);
    const bend: Bend = { b1: bendAmount, b2: bendAmount * between(c.rand, 0.35, 0.9) };
    const overshoot = !minor && !ease && L > t.overshootMinDistance && t.overshoot > 0 ? t.overshoot / L : 0;
    // Taking over a flight still under way: fade from it rather than cut.
    const old = c.flight;
    const midAir = old !== null && t0 > old.t0 && t0 < old.t0 + old.dur;
    if (old) old.prev = old.prev && t0 < old.t0 + old.blend ? old.prev : null;
    c.flight = {
      t0,
      dur: Math.max(1, dur),
      from,
      to,
      bend,
      ease: ease ?? (overshoot ? overshootEase(overshoot) : easeInOut),
      prev: midAir ? old : null,
      blend: midAir ? Math.min(320, Math.max(1, dur) * 0.45) : 0,
    };
    c.flightPath = minor ? c.flightPath : sampleCurve(a, b, bend, 24);
  }

  /** A seeded bend, on whichever side keeps clear of the other cursors. */
  private pickBend(c: Cursor, from: Vec, to: Vec, now: number) {
    const t = this.t();
    const amount = between(c.rand, t.curveMin, t.curveMax);
    if (amount === 0) return 0;
    const others = [...this.cast.values()].filter((o) => o !== c).map((o) => this.position(o, now));
    const left = clearance(from, to, { b1: amount, b2: amount * 0.6 }, others);
    const right = clearance(from, to, { b1: -amount, b2: -amount * 0.6 }, others);
    if (Math.abs(left - right) < 30) return c.rand() < 0.5 ? amount : -amount;
    return left > right ? amount : -amount;
  }

  private shapeTo(c: Cursor, to: ShapeKey, at: number, dur: number, callId?: string) {
    this.at(c, at, () => {
      // Already becoming (or become) this shape: nothing to do.
      if (c.morph.to === to) return;
      c.morph = { from: this.settledShape(c, at), to, t0: at, dur: Math.max(1, dur) };
    }, callId);
  }

  /** The glyph a cursor is closest to right now: where a new morph starts from. */
  private settledShape(c: Cursor, now: number): ShapeKey {
    return this.morphProgress(c, now) >= 0.5 ? c.morph.to : c.morph.from;
  }

  private morphProgress(c: Cursor, now: number) {
    return clamp((now - c.morph.t0) / c.morph.dur, 0, 1);
  }

  private hugIn(c: Cursor, ring: () => Ring | null, rect: () => Rect | null, at: number, dur?: number, callId?: string) {
    this.at(c, at, () => {
      c.hug = { ring, rect, t0: at, dur: dur ?? this.t().hugMs, dir: 1, plan: null };
    }, callId);
  }

  private hugOut(c: Cursor, at: number, callId?: string) {
    this.at(c, at, () => {
      if (!c.hug || c.hug.dir === -1) return;
      c.hug = { ...c.hug, t0: at, dur: this.t().hugMs, dir: -1, plan: null };
    }, callId);
  }

  private elementRing(target: AgentTarget): Ring | null {
    const r = this.env.elementRect(target);
    const t = this.t();
    if (!r) return null;
    return roundedRectRing(r.x - t.hugPad, r.y - t.hugPad, r.w + t.hugPad * 2, r.h + t.hugPad * 2, t.hugRadius);
  }

  private edgeRing(target: AgentTarget): Ring | null {
    const ends = this.env.edgeEnds(target);
    if (!ends) return null;
    // Stop short of the checkpoints so the hug reads as the road, not the nodes.
    const { a, b } = ends;
    const L = dist(a, b) || 1;
    const k = Math.min(0.45, NODE_RADIUS / L);
    return capsuleRing(lerp(a.x, b.x, k), lerp(a.y, b.y, k), lerp(b.x, a.x, k), lerp(b.y, a.y, k), this.t().edgeHugWidth);
  }

  private edgeRect(target: AgentTarget): Rect | null {
    const ends = this.env.edgeEnds(target);
    if (!ends) return null;
    const w = this.t().edgeHugWidth / 2;
    const x0 = Math.min(ends.a.x, ends.b.x) - w;
    const y0 = Math.min(ends.a.y, ends.b.y) - w;
    return { x: x0, y: y0, w: Math.abs(ends.a.x - ends.b.x) + 2 * w, h: Math.abs(ends.a.y - ends.b.y) + 2 * w };
  }

  private tween(tw: Tween, now: number) {
    const k = clamp((now - tw.t0) / tw.dur, 0, 1);
    return lerp(tw.from, tw.to, easeOut(k));
  }

  /** Where a cursor's hotspot is at `now`, before idle drift. */
  private position(c: Cursor, now: number): Vec {
    const f = c.flight;
    if (f && now >= f.t0) return this.along(c, f, now);
    if (f && now < f.t0) {
      if (f.prev) return this.along(c, f.prev, now);
      const a = f.from();
      if (a) return a;
    }
    return c.rest() ?? c.drawn;
  }

  /** Where a flight has got to at `now`, faded in from the one it took over. */
  private along(c: Cursor, f: Flight, now: number): Vec {
    const k = clamp((now - f.t0) / f.dur, 0, 1);
    const a = f.from() ?? c.drawn;
    const b = f.to() ?? a;
    const p = alongCurve(a, b, f.bend, f.ease(k));
    if (!f.prev || now >= f.t0 + f.blend) return p;
    const w = smooth(clamp((now - f.t0) / f.blend, 0, 1));
    const q = this.along(c, f.prev, now);
    return { x: lerp(q.x, p.x, w), y: lerp(q.y, p.y, w) };
  }

  /* -----------------------------------------------------------------------
     Every frame
     ----------------------------------------------------------------------- */

  frame(now: number): CursorView[] {
    const dt = this.lastNow ? clamp((now - this.lastNow) / 1000, 0, 0.1) : 1 / 60;
    this.lastNow = now;
    const t = this.t();
    const unit = t.size * this.env.rootScale();
    const views: CursorView[] = [];
    const spotlight = [...this.cast.values()].find((c) => c.job && !c.job.done);
    const spot = spotlight ? spotlight.drawn : null;

    for (const c of [...this.cast.values()]) {
      // Run what is due, in order. A step may schedule more steps.
      for (let guard = 0; guard < 50; guard += 1) {
        c.timeline.sort((a, b) => a.at - b.at);
        const due = c.timeline[0];
        if (!due || due.at > now) break;
        c.timeline.shift();
        due.fn();
      }
      if (!this.cast.has(c.lane)) continue;

      if (c.state === "parked" && !c.flight && now >= c.nextMicro) this.microMove(c, now);

      // Position: the flight, or where it rests.
      let p = this.position(c, now);
      if (c.flight && now >= c.flight.t0 + c.flight.dur) {
        p = c.flight.to() ?? p;
        c.flight = null;
      }
      const flying = Boolean(c.flight && now >= c.flight.t0);

      // Idle drift: full when parked, faint while holding, none in flight or at a click.
      const clicking = now < c.pressUntil + 120 || Boolean(c.job?.dragging) || Boolean(c.job?.drawing && flying);
      const idleTarget = flying || clicking ? 0 : c.state === "parked" ? 1 : c.state === "leaving" ? 0 : 0.35;
      const iw = c.idleWeight.step(idleTarget, dt, 60, 15);
      const boost = this.thinking ? t.thinkingBoost : 1;
      const phase = now / Math.max(200, t.idlePeriod) + c.idlePhase;
      const drift = (time: number) => {
        const ph = time / Math.max(200, t.idlePeriod) + c.idlePhase;
        return { x: c.swayX(ph) * t.idleAmp * iw * boost, y: c.swayY(ph * 0.9 + 7) * t.idleAmp * iw * boost };
      };
      const d0 = drift(now);
      p = { x: p.x + d0.x, y: p.y + d0.y };

      // Velocity and acceleration from the motion itself, a few ms either
      // side of now. Differencing drawn frames instead is noisy whenever
      // frames come unevenly, and the lean, stretch and skew shook with it.
      const at = (time: number) => {
        const q = this.position(c, time);
        const d = drift(time);
        return { x: q.x + d.x, y: q.y + d.y };
      };
      const before = at(now - DERIVATIVE_MS);
      const after = at(now + DERIVATIVE_MS);
      const vx = ((after.x - before.x) / (2 * DERIVATIVE_MS)) * 1000;
      const vy = ((after.y - before.y) / (2 * DERIVATIVE_MS)) * 1000;
      const ax = ((after.x - 2 * p.x + before.x) / DERIVATIVE_MS ** 2) * 1e6;
      const ay = ((after.y - 2 * p.y + before.y) / DERIVATIVE_MS ** 2) * 1e6;
      const follow = 1 - Math.exp(-dt / 0.03);
      c.vel = { x: lerp(c.vel.x, vx, follow), y: lerp(c.vel.y, vy, follow) };
      c.acc = { x: lerp(c.acc.x, ax, follow), y: lerp(c.acc.y, ay, follow) };
      c.drawn = p;
      const speed = Math.hypot(c.vel.x, c.vel.y);
      if (speed > 30) c.heading = (Math.atan2(c.vel.y, c.vel.x) * 180) / Math.PI;

      // The pose: lean into travel, stretch along it, skew through turns.
      let glance = 0;
      if (spot && c !== spotlight && c.state === "parked") glance = clamp((spot.x - p.x) / 300, -1, 1) * t.glance;
      const wobble = c.wobble(phase * 0.7 + 3) * t.idleWobble * iw;
      const leanTarget = clamp(c.vel.x * t.leanPerSpeed, -t.leanMax, t.leanMax) + glance + wobble;
      const lean = c.lean.step(leanTarget, dt, t.leanStiffness, t.leanDamping);
      const stretch = c.stretch.step(1 + Math.min(t.stretchMax, speed * t.stretchPerSpeed), dt, 260, 26);
      const lateral = speed > 30 ? (c.vel.x * c.acc.y - c.vel.y * c.acc.x) / speed : 0;
      const skew = c.skew.step(clamp(lateral * t.skewPerAccel, -t.skewMax, t.skewMax), dt, 220, 24);
      const pressTarget = now < c.pressUntil ? c.pressDepth : c.holdDepth;
      const press = c.press.step(pressTarget, dt, 700, 22);
      const size = this.tween(c.size, now);
      const opacity = this.tween(c.opacity, now);

      const m = poseMatrix({
        x: p.x,
        y: p.y,
        lean: clamp(lean, -t.leanMax * 2 - 6, t.leanMax * 2 + 6),
        stretch,
        heading: c.heading,
        skew,
        scale: unit * press * size,
      });

      // The shape: a glyph, or a blend of two, in screen space.
      const k = easeInOut(this.morphProgress(c, now));
      const local: Shape =
        k >= 1 ? shapeOf(c.morph.to) : evaluate(glyphPlan(c.morph.from, c.morph.to), shapeOf(c.morph.from), shapeOf(c.morph.to), k);
      let screen = mapShape(local, (ring, out) => transformRing(m, ring, out));

      // A hug: the cursor melts into a highlight round its target.
      let hugAmount = 0;
      let hugFill = 0.14;
      let look = 0;
      let focus: Rect | null = null;
      if (c.hug) {
        const ring = c.hug.ring();
        if (ring) {
          const target = single(ring);
          if (!c.hug.plan) c.hug.plan = planMorph(screen, target);
          const raw = clamp((now - c.hug.t0) / c.hug.dur, 0, 1);
          hugAmount = c.hug.dir === 1 ? easeInOut(raw) : 1 - easeInOut(raw);
          const own = area(bounds(screen));
          const full = area(bounds(target));
          screen = evaluate(c.hug.plan, screen, target, hugAmount);
          // How much it looks like a highlight rather than a cursor goes by
          // its size now, not by the time: the fill only turns solid once
          // the outline is cursor-sized, so a big shape is never a solid block.
          look = full > own * 1.5 ? clamp(Math.log(area(bounds(screen)) / own) / Math.log(full / own), 0, 1) : hugAmount;
          if (hugAmount >= 1) look = 1;
          focus = c.hug.rect();
          // A highlight round a button is a clear tint; one round half the
          // map is a whisper of one, like a multi-select box.
          if (focus) hugFill = clamp(0.14 * Math.sqrt(6000 / Math.max(1, focus.w * focus.h)), 0.035, 0.14);
          if (c.hug.dir === -1 && raw >= 1) c.hug = null;
        }
      }
      if (!focus && c.job) focus = this.focusOf(c.job);

      const paths = toPaths(screen);
      const badgeName = k >= 0.5 ? c.morph.to : c.morph.from;
      const b = bounds(screen);
      const anchor = hugAmount > 0.5 ? { x: b.x1, y: b.y1 } : p;

      const outline = OUTLINE_WIDTH * unit * press * size * 2;
      const job = c.job;
      views.push({
        lane: c.lane,
        name: c.name,
        colour: t.colours[c.lane - 1] ?? c.colour,
        ink: c.ink,
        opacity,
        main: paths.main,
        badge: paths.badge,
        badgeColour: badgeName === "dot" ? null : (BADGE_COLOUR[badgeName] ?? null),
        hug: hugAmount,
        look,
        fillOpacity: hugFill ** look,
        strokeWidth: lerp(outline, 2, look),
        shimmer: c.shimmer ? -(((now / Math.max(200, t.shimmerMs)) % 1) * 100) : null,
        anchor,
        focus,
        callId: c.state === "busy" && job ? job.callId : null,
        acting: c.state === "busy",
        line: this.lineOf(c, now),
        ghost: c.ghost ? { x: p.x, y: p.y } : null,
        ripples: this.ripplesOf(c, now),
        path: t.showPaths ? c.flightPath : null,
        press: t.showPaths && c.job ? this.env.resolve(c.job.target, c.job.kind === "edge-new" || c.job.kind === "node-move" ? "end" : "start") : null,
      });
    }
    return views;
  }

  private focusOf(job: Job): Rect | null {
    if (job.kind === "ui") return this.env.elementRect(job.target);
    if (job.kind === "edge" || job.kind === "edge-new") return this.edgeRect(job.target);
    const p = this.env.resolve(job.target, job.kind === "node-move" && job.dragging ? "end" : "start");
    return p ? { x: p.x - NODE_RADIUS, y: p.y - NODE_RADIUS, w: NODE_RADIUS * 2, h: NODE_RADIUS * 2 } : null;
  }

  private lineOf(c: Cursor, now: number) {
    if (!c.line || now > c.line.until) {
      if (c.line && now > c.line.until) c.line = null;
      return null;
    }
    const a = c.line.from();
    const b = c.line.to();
    return a && b ? { x1: a.x, y1: a.y, x2: b.x, y2: b.y } : null;
  }

  private ripplesOf(c: Cursor, now: number) {
    c.ripples = c.ripples.filter((r) => now - r.t0 < 560);
    return c.ripples
      .filter((r) => now >= r.t0)
      .map((r) => {
        const k = (now - r.t0) / 560;
        return { x: r.x, y: r.y, r: 6 + 24 * easeOut(k), opacity: 0.55 * (1 - k) };
      });
  }

  /** True while anything is on screen or about to be. */
  get active() {
    return this.cast.size > 0;
  }

  clear() {
    this.cast.clear();
    this.touched = [];
  }
}

function shapeOf(key: ShapeKey): Shape {
  return key === "dot" ? dot() : glyph(key);
}

function area(b: { x0: number; y0: number; x1: number; y1: number }) {
  return Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
}

/** Smoothstep: 0 to 1 with no jolt at either end. */
function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function dist(a: Vec, b: Vec) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function add(p: Vec | null, x: number, y: number): Vec | null {
  return p ? { x: p.x + x, y: p.y + y } : null;
}

function inRect(p: Vec, r: Rect, pad: number) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}
