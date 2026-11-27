/**
 * Continuous shape morphing for the cursors.
 *
 * Every shape is a list of parts; a part is an outer ring with any holes, all
 * resampled to the same number of points so two shapes can be blended point
 * by point. A morph is planned once (which part becomes which, and where each
 * ring starts so it does not twist) and then evaluated every frame against
 * the shapes as they are *now*, so a hug can follow a panel or a road while
 * the camera moves.
 *
 * Parts pair by position: the pointer splits into the four arrows of the
 * cross because each arrow takes the nearest part, and four arrows merge
 * back into one pointer the same way. Badges (the "?" of help, the ⊘ of
 * unavailable) grow from their own centre instead of splitting off the arrow.
 */

import { TRACED, type GlyphName } from "./shapes";

/** Points per ring. */
export const N = 72;

export type Ring = Float64Array;
export type Part = { outer: Ring; holes: Ring[]; badge: boolean };
export type Shape = Part[];

/** Parts from this index on are badges, drawn in the badge colour. */
const BADGE_FROM: Partial<Record<GlyphName, number>> = { help: 1, unavailable: 1, pin: 1 };

/** Badges keep their meaning: a failure is red whichever cursor fails. */
export const BADGE_COLOUR: Partial<Record<GlyphName, string>> = { unavailable: "var(--red)" };

/* -------------------------------------------------------------------------
   Rings
   ------------------------------------------------------------------------- */

function signedArea(r: ArrayLike<number>) {
  let s = 0;
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    s += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return s / 2;
}

/** Resamples a closed ring to `n` points evenly spaced by length. */
export function resample(flat: ArrayLike<number>, n = N): Ring {
  const m = flat.length / 2;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i += 1) {
    const j = (i + 1) % m;
    cum[i + 1] = cum[i] + Math.hypot(flat[j * 2] - flat[i * 2], flat[j * 2 + 1] - flat[i * 2 + 1]);
  }
  const total = cum[m] || 1;
  const out = new Float64Array(n * 2);
  let seg = 0;
  for (let k = 0; k < n; k += 1) {
    const want = (k / n) * total;
    while (seg < m - 1 && cum[seg + 1] < want) seg += 1;
    const len = cum[seg + 1] - cum[seg] || 1;
    const t = (want - cum[seg]) / len;
    const j = (seg + 1) % m;
    out[k * 2] = flat[seg * 2] + (flat[j * 2] - flat[seg * 2]) * t;
    out[k * 2 + 1] = flat[seg * 2 + 1] + (flat[j * 2 + 1] - flat[seg * 2 + 1]) * t;
  }
  return out;
}

/** Outer rings run clockwise on screen (positive area with y down), holes the other way. */
function wound(r: Ring, clockwise: boolean): Ring {
  if (signedArea(r) > 0 === clockwise) return r;
  const out = new Float64Array(r.length);
  const n = r.length / 2;
  for (let i = 0; i < n; i += 1) {
    out[i * 2] = r[(n - 1 - i) * 2];
    out[i * 2 + 1] = r[(n - 1 - i) * 2 + 1];
  }
  return out;
}

export function centroid(r: ArrayLike<number>) {
  let x = 0;
  let y = 0;
  const n = r.length / 2;
  for (let i = 0; i < r.length; i += 2) {
    x += r[i];
    y += r[i + 1];
  }
  return { x: x / n, y: y / n };
}

export function bounds(shape: Shape) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of shape) {
    for (let i = 0; i < p.outer.length; i += 2) {
      x0 = Math.min(x0, p.outer[i]);
      x1 = Math.max(x1, p.outer[i]);
      y0 = Math.min(y0, p.outer[i + 1]);
      y1 = Math.max(y1, p.outer[i + 1]);
    }
  }
  return { x0, y0, x1, y1 };
}

const point = (c: { x: number; y: number }, n = N): Ring => {
  const r = new Float64Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    r[i * 2] = c.x;
    r[i * 2 + 1] = c.y;
  }
  return r;
};

/** The start offset into `b` that best lines it up with `a`, both centred. */
function bestOffset(a: Ring, b: Ring) {
  const ca = centroid(a);
  const cb = centroid(b);
  const n = a.length / 2;
  let best = 0;
  let bestCost = Infinity;
  for (let k = 0; k < n; k += 1) {
    let cost = 0;
    for (let i = 0; i < n && cost < bestCost; i += 1) {
      const j = ((i + k) % n) * 2;
      const dx = a[i * 2] - ca.x - (b[j] - cb.x);
      const dy = a[i * 2 + 1] - ca.y - (b[j + 1] - cb.y);
      cost += dx * dx + dy * dy;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = k;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------
   Shapes
   ------------------------------------------------------------------------- */

const glyphCache = new Map<GlyphName, Shape>();

/** A traced glyph, in cursor units from its hotspot. */
export function glyph(name: GlyphName): Shape {
  const hit = glyphCache.get(name);
  if (hit) return hit;
  const from = BADGE_FROM[name] ?? Infinity;
  const shape = (TRACED[name] as readonly { outer: readonly number[]; holes: readonly (readonly number[])[] }[]).map(
    (p, i) => ({
      outer: wound(resample(p.outer), true),
      holes: p.holes.map((h) => wound(resample(h), false)),
      badge: i >= from,
    }),
  );
  glyphCache.set(name, shape);
  return shape;
}

/** A small round dot: what a cursor is as it leaves or reaches the Sayes mark. */
export function dot(r = 3): Shape {
  return [{ outer: circleRing(0, 0, r), holes: [], badge: false }];
}

export function circleRing(cx: number, cy: number, r: number): Ring {
  const out = new Float64Array(N * 2);
  for (let i = 0; i < N; i += 1) {
    const a = -Math.PI / 2 + (i / N) * Math.PI * 2;
    out[i * 2] = cx + Math.cos(a) * r;
    out[i * 2 + 1] = cy + Math.sin(a) * r;
  }
  return out;
}

/** A rounded rectangle, clockwise from its top-left corner. */
export function roundedRectRing(x: number, y: number, w: number, h: number, radius: number): Ring {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const pts: number[] = [];
  const arc = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 6; i += 1) {
      const a = from + (i / 6) * (Math.PI / 2);
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  arc(x + r, y + r, Math.PI);
  arc(x + w - r, y + r, -Math.PI / 2);
  arc(x + w - r, y + h - r, 0);
  arc(x + r, y + h - r, Math.PI / 2);
  return wound(resample(pts), true);
}

/** A capsule around the segment a-b, `width` across. */
export function capsuleRing(ax: number, ay: number, bx: number, by: number, width: number): Ring {
  const r = width / 2;
  const angle = Math.atan2(by - ay, bx - ax);
  const pts: number[] = [];
  for (let i = 0; i <= 12; i += 1) {
    const a = angle - Math.PI / 2 + (i / 12) * Math.PI;
    pts.push(bx + Math.cos(a) * r, by + Math.sin(a) * r);
  }
  for (let i = 0; i <= 12; i += 1) {
    const a = angle + Math.PI / 2 + (i / 12) * Math.PI;
    pts.push(ax + Math.cos(a) * r, ay + Math.sin(a) * r);
  }
  return wound(resample(pts), true);
}

export const single = (outer: Ring): Shape => [{ outer, holes: [], badge: false }];

/* -------------------------------------------------------------------------
   Planning and evaluating a morph
   ------------------------------------------------------------------------- */

type HoleTrack = { from: number; to: number; offset: number };
type Track = { from: number; to: number; offset: number; holes: HoleTrack[]; badge: boolean };
export type MorphPlan = { tracks: Track[] };

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function nearest(c: { x: number; y: number }, parts: Shape, candidates: number[]) {
  let best = -1;
  let bestD = Infinity;
  for (const i of candidates) {
    const d = dist(c, centroid(parts[i].outer));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function pairHoles(a: Part | null, b: Part | null): HoleTrack[] {
  const ha = a?.holes ?? [];
  const hb = b?.holes ?? [];
  const tracks: HoleTrack[] = [];
  for (let i = 0; i < Math.max(ha.length, hb.length); i += 1) {
    const from = i < ha.length ? i : -1;
    const to = i < hb.length ? i : -1;
    tracks.push({ from, to, offset: from >= 0 && to >= 0 ? bestOffset(ha[from], hb[to]) : 0 });
  }
  return tracks;
}

/** Decides which part becomes which. Shapes must be in the same space. */
export function planMorph(from: Shape, to: Shape): MorphPlan {
  const idx = (s: Shape, badge: boolean) => s.map((p, i) => (p.badge === badge ? i : -1)).filter((i) => i >= 0);
  const fromMain = idx(from, false);
  const toMain = idx(to, false);
  const fromBadge = idx(from, true);
  const toBadge = idx(to, true);
  const tracks: Track[] = [];
  const used = new Set<number>();

  const track = (f: number, t: number, badge: boolean): Track => ({
    from: f,
    to: t,
    offset: f >= 0 && t >= 0 ? bestOffset(from[f].outer, to[t].outer) : 0,
    holes: pairHoles(f >= 0 ? from[f] : null, t >= 0 ? to[t] : null),
    badge,
  });

  // Each target part comes from the nearest source part: one-to-many splits.
  for (const t of toMain) {
    const f = fromMain.length ? nearest(centroid(to[t].outer), from, fromMain) : -1;
    if (f >= 0) used.add(f);
    tracks.push(track(f, t, false));
  }
  // Source parts nobody took go to the nearest target part: many-to-one merges.
  for (const f of fromMain) {
    if (used.has(f)) continue;
    const t = toMain.length ? nearest(centroid(from[f].outer), to, toMain) : -1;
    tracks.push(track(f, t, false));
  }
  // Badges pair in order; the rest grow from or shrink to their own centre.
  for (let i = 0; i < Math.max(fromBadge.length, toBadge.length); i += 1) {
    tracks.push(track(fromBadge[i] ?? -1, toBadge[i] ?? -1, true));
  }
  return { tracks };
}

function rotateRing(r: Ring, offset: number, out: Ring) {
  const n = r.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = ((i + offset) % n) * 2;
    out[i * 2] = r[j];
    out[i * 2 + 1] = r[j + 1];
  }
  return out;
}

function blend(a: Ring, b: Ring, t: number): Ring {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/**
 * The shape `t` of the way from `from` to `to` under `plan`. A part with no
 * counterpart grows from (or shrinks to) the centre of the part it pairs with.
 */
export function evaluate(plan: MorphPlan, from: Shape, to: Shape, t: number): Shape {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const scratch = new Float64Array(N * 2);
  const out: Shape = [];
  for (const tr of plan.tracks) {
    const fp = tr.from >= 0 ? from[tr.from] : null;
    const tp = tr.to >= 0 ? to[tr.to] : null;
    if (!fp && !tp) continue;
    const a = fp ? fp.outer : point(centroid(tp!.outer));
    const b = tp ? rotateRing(tp.outer, tr.offset, scratch) : point(centroid(fp!.outer));
    const outer = blend(a, b, t);
    const holes: Ring[] = [];
    for (const h of tr.holes) {
      const ha = h.from >= 0 && fp ? fp.holes[h.from] : null;
      const hb = h.to >= 0 && tp ? tp.holes[h.to] : null;
      if (!ha && !hb) continue;
      const hs = new Float64Array(N * 2);
      const ra = ha ?? point(centroid(hb!));
      const rb = hb ? rotateRing(hb, h.offset, hs) : point(centroid(ha!));
      holes.push(blend(ra, rb, t));
    }
    out.push({ outer, holes, badge: tr.badge });
  }
  return out;
}

const planCache = new Map<string, MorphPlan>();

/** Plans between two glyphs are fixed, so they are worked out once. */
export function glyphPlan(a: GlyphName | "dot", b: GlyphName | "dot") {
  const key = `${a}>${b}`;
  let plan = planCache.get(key);
  if (!plan) {
    plan = planMorph(a === "dot" ? dot() : glyph(a), b === "dot" ? dot() : glyph(b));
    planCache.set(key, plan);
  }
  return plan;
}

/* -------------------------------------------------------------------------
   To SVG
   ------------------------------------------------------------------------- */

function ringPath(r: ArrayLike<number>) {
  let d = `M${r[0].toFixed(1)} ${r[1].toFixed(1)}`;
  for (let i = 2; i < r.length; i += 2) d += `L${r[i].toFixed(1)} ${r[i + 1].toFixed(1)}`;
  return `${d}Z`;
}

/** Parts smaller than this (px across) are not drawn: a vanishing badge is gone, not a speck. */
const MIN_SIZE = 0.6;

function size(r: Ring) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]);
    x1 = Math.max(x1, r[i]);
    y0 = Math.min(y0, r[i + 1]);
    y1 = Math.max(y1, r[i + 1]);
  }
  return Math.max(x1 - x0, y1 - y0);
}

/** SVG path data for the main parts and the badge parts of a shape in screen space. */
export function toPaths(shape: Shape) {
  let main = "";
  let badge = "";
  for (const p of shape) {
    if (size(p.outer) < MIN_SIZE) continue;
    let d = ringPath(p.outer);
    for (const h of p.holes) if (size(h) >= MIN_SIZE) d += ringPath(h);
    if (p.badge) badge += d;
    else main += d;
  }
  return { main, badge };
}

/** Static path data for a glyph at a scale, for places that do not animate (the Sayes mark). */
export function glyphPathData(name: GlyphName, s = 1) {
  return toPaths(
    glyph(name).map((p) => ({
      ...p,
      outer: p.outer.map((v) => v * s) as Ring,
      holes: p.holes.map((h) => h.map((v) => v * s) as Ring),
    })),
  ).main;
}

/** Maps every ring of a shape through `fn`, which writes into its second argument. */
export function mapShape(shape: Shape, fn: (ring: Ring, out: Ring) => Ring): Shape {
  return shape.map((p) => ({
    outer: fn(p.outer, new Float64Array(p.outer.length)),
    holes: p.holes.map((h) => fn(h, new Float64Array(h.length))),
    badge: p.badge,
  }));
}
