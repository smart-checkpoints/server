/**
 * Every number the Sayes cursors move by, in one place.
 *
 * Read at frame time, never through React state, so the Cursor Lab can change
 * any of them while cursors are moving. Lab edits are kept in localStorage
 * under `sc.cursorLab` and override the defaults below; "Copy as code" in the
 * Lab prints a block to paste over DEFAULTS to make them permanent.
 */

import { LANES } from "../labels";

export type PlaceGlyph = "cross" | "pin";

export type Tuning = {
  /**
   * Overall speed: every duration below is divided by it, and the speed-based
   * factors are rescaled to match, so 2 plays the same motion twice as fast.
   */
  speed: number;
  /** Cursor size: 1 is the 32px cursor the OS draws. */
  size: number;

  /* Paths */
  /** Sideways bend of a flight, as a share of its length (seeded between these). */
  curveMin: number;
  curveMax: number;
  /** How far off-centre a cursor may land on a big target (panels, roads), px. */
  jitter: number;

  /* Timing, ms */
  flightBase: number;
  /** Extra flight time per square root of a pixel: longer moves, slower but not proportionally. */
  flightK: number;
  flightMin: number;
  flightMax: number;
  /** Arrive, then settle this long before clicking. */
  settle: number;
  /** After acting, wait this long before leaving. */
  beat: number;

  /* Character */
  /** Lean into travel, degrees at most, and per px/s of sideways speed. */
  leanMax: number;
  leanPerSpeed: number;
  /** The lean's spring: lower damping swings more before it settles. */
  leanStiffness: number;
  leanDamping: number;
  /** Stretch along the direction of travel (0.06 = 6%), at most and per px/s. */
  stretchMax: number;
  stretchPerSpeed: number;
  /** Skew from turning (sideways acceleration), degrees at most and per px/s². */
  skewMax: number;
  skewPerAccel: number;
  /** Long flights pass the target by this many px and come back. */
  overshoot: number;
  overshootMinDistance: number;
  /** The click: scale down to this, for this long, and spring back. */
  pressScale: number;
  pressMs: number;
  /** Before leaving, pull back this many px over this long. */
  anticipation: number;
  anticipationMs: number;

  /* Idle */
  /** Drift while waiting, px, and how long one sway takes, ms. */
  idleAmp: number;
  idlePeriod: number;
  /** Rotation wobble while waiting, degrees. */
  idleWobble: number;
  /** A parked cursor shifts to a nearby spot every so often, ms, within this radius. */
  microMin: number;
  microMax: number;
  microRadius: number;
  /** Parked cursors turn this many degrees toward the one acting. */
  glance: number;
  /** Idle motion is this much livelier while the agent is thinking. */
  thinkingBoost: number;

  /* Morph */
  morphMs: number;
  hugMs: number;
  /** Rounded-rect hug around a panel: padding and corner radius, px. */
  hugPad: number;
  hugRadius: number;
  /** Capsule hug along a road, px wide. */
  edgeHugWidth: number;
  /** One lap of the busy shimmer around the outline, ms. */
  shimmerMs: number;
  /** What the pointer becomes to place a checkpoint. */
  placeGlyph: PlaceGlyph;

  /* Cast */
  castMax: number;
  /** Parking spots sit this far in from the map's edges, px. */
  parkInset: number;
  colours: string[];

  /* Finale */
  wrapPad: number;
  wrapHold: number;
  homeStagger: number;

  /* Playback (replay only) */
  seed: number;
  slowmo: number;
  showPaths: boolean;
};

/**
 * Tuned in the Lab on 2026-11-27: floaty and lively, then sped up 1.35× and
 * folded in here, so `speed: 1` is that pace (times ÷1.35, per-speed factors
 * ÷1.35, per-acceleration ÷1.35², the lean spring stiffened to match, each
 * rounded to its slider step). The Lab's sliders are centred on these.
 */
export const DEFAULTS: Tuning = {
  speed: 1,
  size: 1.15,

  curveMin: 0.08,
  curveMax: 0.22,
  jitter: 3,

  flightBase: 590,
  flightK: 44,
  flightMin: 290,
  flightMax: 1860,
  settle: 220,
  beat: 610,

  leanMax: 30,
  leanPerSpeed: 0.037,
  leanStiffness: 90,
  leanDamping: 11,
  stretchMax: 0.25,
  stretchPerSpeed: 0.00007,
  skewMax: 4,
  skewPerAccel: 0.0007,
  overshoot: 3,
  overshootMinDistance: 300,
  pressScale: 0.73,
  pressMs: 65,
  anticipation: 3,
  anticipationMs: 135,

  idleAmp: 12,
  idlePeriod: 2100,
  idleWobble: 8,
  microMin: 3750,
  microMax: 6750,
  microRadius: 70,
  glance: 15,
  thinkingBoost: 1.5,

  morphMs: 310,
  hugMs: 390,
  hugPad: 6,
  hugRadius: 14,
  edgeHugWidth: 20,
  shimmerMs: 550,
  placeGlyph: "cross",

  castMax: 5,
  parkInset: 56,
  colours: LANES.map((l) => l.colour),

  wrapPad: 24,
  wrapHold: 900,
  homeStagger: 70,

  seed: 0,
  slowmo: 1,
  showPaths: false,
};

const KEY = "sc.cursorLab";

let current: Tuning = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  loaded = true;
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Tuning>;
    // Only keys that still exist, with the type they have now.
    const merged: Record<string, unknown> = { ...DEFAULTS };
    for (const [k, v] of Object.entries(saved)) {
      const d = (DEFAULTS as Record<string, unknown>)[k];
      if (d === undefined) continue;
      if (Array.isArray(d) ? Array.isArray(v) : typeof v === typeof d) merged[k] = v;
    }
    current = merged as Tuning;
  } catch {
    current = DEFAULTS;
  }
}

/** The live values. Cheap: call it every frame. */
export function tuning(): Tuning {
  if (!loaded) load();
  return current;
}

export function setTuning(change: Partial<Tuning>) {
  current = { ...tuning(), ...change };
  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    if (JSON.stringify(v) !== JSON.stringify((DEFAULTS as Record<string, unknown>)[k])) diff[k] = v;
  }
  try {
    if (Object.keys(diff).length) window.localStorage.setItem(KEY, JSON.stringify(diff));
    else window.localStorage.removeItem(KEY);
  } catch {
    // Private mode or full storage: the change still applies to this page.
  }
  for (const fn of listeners) fn();
}

export function resetTuning() {
  current = DEFAULTS;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to remove.
  }
  for (const fn of listeners) fn();
}

export function subscribeTuning(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The current values as a DEFAULTS block, for pasting into this file. */
export function tuningAsCode() {
  const t = tuning();
  const lines = Object.entries(t).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`);
  return `export const DEFAULTS: Tuning = {\n${lines.join("\n")}\n};\n`;
}

/**
 * The values with `speed` applied: the same motion, faster or slower. Times
 * divide by the speed; anything per px/s divides by it too (and per px/s² by
 * its square), and the lean spring is stiffened to match, so the balance of
 * lean, stretch and skew stays exactly as tuned.
 */
export function paced(t: Tuning): Tuning {
  const k = t.speed > 0 ? t.speed : 1;
  if (k === 1) return t;
  return {
    ...t,
    flightBase: t.flightBase / k,
    flightK: t.flightK / k,
    flightMin: t.flightMin / k,
    flightMax: t.flightMax / k,
    settle: t.settle / k,
    beat: t.beat / k,
    leanPerSpeed: t.leanPerSpeed / k,
    leanStiffness: t.leanStiffness * k * k,
    leanDamping: t.leanDamping * k,
    stretchPerSpeed: t.stretchPerSpeed / k,
    skewPerAccel: t.skewPerAccel / (k * k),
    pressMs: t.pressMs / k,
    anticipationMs: t.anticipationMs / k,
    idlePeriod: t.idlePeriod / k,
    microMin: t.microMin / k,
    microMax: t.microMax / k,
    morphMs: t.morphMs / k,
    hugMs: t.hugMs / k,
    shimmerMs: t.shimmerMs / k,
    wrapHold: t.wrapHold / k,
    homeStagger: t.homeStagger / k,
  };
}

/** What reduced motion keeps: the timing and the clicks, none of the flourish. */
export function calm(t: Tuning): Tuning {
  return {
    ...t,
    curveMin: 0,
    curveMax: 0,
    jitter: 0,
    leanMax: 0,
    stretchMax: 0,
    skewMax: 0,
    overshoot: 0,
    anticipation: 0,
    idleAmp: 0,
    idleWobble: 0,
    microMin: Infinity,
    microMax: Infinity,
    glance: 0,
    morphMs: 120,
    hugMs: 120,
  };
}
