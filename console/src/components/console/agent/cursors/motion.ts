/**
 * How a cursor moves: seeded randomness, noise for idling, curved flights
 * with an eased (and on long moves, slightly overshooting) speed profile,
 * springs, and the 2D matrix that leans, stretches and skews the pointer.
 */

import { cubicBezier } from "@/lib/ease";

export type Vec = { x: number; y: number };

/* -------------------------------------------------------------------------
   Randomness: the same seed always gives the same run
   ------------------------------------------------------------------------- */

/** FNV-1a, 32-bit. */
export function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast, seeded generator in [0, 1). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

/** Smooth 1D value noise in [-1, 1], one unit per sway. */
export function noise(seed: number) {
  const r = rng(seed);
  const lattice = Array.from({ length: 64 }, () => r() * 2 - 1);
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = lattice[((i % 64) + 64) % 64];
    const b = lattice[(((i + 1) % 64) + 64) % 64];
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    return a + (b - a) * u;
  };
}

/* -------------------------------------------------------------------------
   Easing
   ------------------------------------------------------------------------- */

/** Accelerate gently, land long: a hand reaching for something. */
export const easeInOut = cubicBezier(0.45, 0, 0.18, 1);
/** Dragging: a firmer start, the weight of what is carried. */
export const easeDrag = cubicBezier(0.55, 0, 0.25, 1);
/** The house curve: for things that appear, not things that travel. */
export const easeOut = cubicBezier(0.22, 1, 0.36, 1);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * `easeInOut` plus a late bump that carries the cursor past the end by
 * `amount` (a share of the flight's length) and back, arriving at rest:
 * smooth all the way, no kink at the end.
 */
const bump = (t: number) => t ** 4 * (1 - t) ** 2;
const overshootCache = new Map<number, number>();

function bumpWeight(amount: number) {
  const key = Math.round(amount * 1e4);
  const hit = overshootCache.get(key);
  if (hit !== undefined) return hit;
  const peak = (w: number) => {
    let max = 0;
    for (let i = 0; i <= 200; i += 1) {
      const t = i / 200;
      max = Math.max(max, easeInOut(t) + w * bump(t) - 1);
    }
    return max;
  };
  let lo = 0;
  let hi = 400;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (peak(mid) < amount) lo = mid;
    else hi = mid;
  }
  overshootCache.set(key, lo);
  return lo;
}

export function overshootEase(amount: number) {
  if (amount <= 0) return easeInOut;
  const w = bumpWeight(amount);
  return (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : easeInOut(t) + w * bump(t));
}

/** How long a move of `distance` px takes: longer, but not proportionally. */
export function flightMs(distance: number, base: number, k: number, min: number, max: number) {
  return clamp(base + k * Math.sqrt(Math.max(0, distance)), min, max);
}

/* -------------------------------------------------------------------------
   Curved flights
   ------------------------------------------------------------------------- */

/**
 * A cubic Bézier from `a` to `b`, bent sideways. The bends are shares of the
 * length along the left-hand normal, fixed when the flight is planned; the
 * ends are read again every frame, so a flight follows its target while the
 * camera moves.
 */
export type Bend = { b1: number; b2: number };

export function controlPoints(a: Vec, b: Vec, bend: Bend) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  const nx = L ? -dy / L : 0;
  const ny = L ? dx / L : 0;
  return {
    p0: a,
    p1: { x: a.x + dx * 0.28 + nx * bend.b1 * L, y: a.y + dy * 0.28 + ny * bend.b1 * L },
    p2: { x: a.x + dx * 0.72 + nx * bend.b2 * L, y: a.y + dy * 0.72 + ny * bend.b2 * L },
    p3: b,
    length: L,
  };
}

function cubic(p: ReturnType<typeof controlPoints>, t: number): Vec {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p.p0.x + w1 * p.p1.x + w2 * p.p2.x + w3 * p.p3.x,
    y: w0 * p.p0.y + w1 * p.p1.y + w2 * p.p2.y + w3 * p.p3.y,
  };
}

/**
 * The point `s` of the way along the curve by distance travelled, not by
 * the curve's own parameter, so the speed is the easing's and nothing else.
 * Past 1 it carries on along the final tangent (the overshoot).
 */
export function alongCurve(a: Vec, b: Vec, bend: Bend, s: number): Vec {
  const p = controlPoints(a, b, bend);
  if (p.length < 0.5) return b;
  if (s >= 1) {
    const tx = p.p3.x - p.p2.x;
    const ty = p.p3.y - p.p2.y;
    const tl = Math.hypot(tx, ty) || 1;
    const extra = (s - 1) * p.length;
    return { x: p.p3.x + (tx / tl) * extra, y: p.p3.y + (ty / tl) * extra };
  }
  if (s <= 0) return a;
  const N = 24;
  const lengths = [0];
  let prev = p.p0;
  for (let i = 1; i <= N; i += 1) {
    const q = cubic(p, i / N);
    lengths.push(lengths[i - 1] + Math.hypot(q.x - prev.x, q.y - prev.y));
    prev = q;
  }
  const want = s * lengths[N];
  let i = 1;
  while (i < N && lengths[i] < want) i += 1;
  const span = lengths[i] - lengths[i - 1] || 1;
  const t = (i - 1 + (want - lengths[i - 1]) / span) / N;
  return cubic(p, t);
}

/** Samples a flight's curve, for the Lab's path overlay. */
export function sampleCurve(a: Vec, b: Vec, bend: Bend, n = 20): Vec[] {
  return Array.from({ length: n + 1 }, (_, i) => alongCurve(a, b, bend, i / n));
}

/** Minimum distance from a curve to a set of points: picks the bend side. */
export function clearance(a: Vec, b: Vec, bend: Bend, others: Vec[]) {
  if (others.length === 0) return Infinity;
  let min = Infinity;
  for (const q of sampleCurve(a, b, bend, 8)) {
    for (const o of others) min = Math.min(min, Math.hypot(q.x - o.x, q.y - o.y));
  }
  return min;
}

/* -------------------------------------------------------------------------
   Springs
   ------------------------------------------------------------------------- */

export class Spring {
  value: number;
  velocity = 0;

  constructor(value = 0) {
    this.value = value;
  }

  /** Semi-implicit Euler in small steps; `dt` in seconds. */
  step(target: number, dt: number, stiffness: number, damping: number) {
    let left = Math.min(dt, 0.1);
    while (left > 0) {
      const h = Math.min(left, 1 / 240);
      const accel = -stiffness * (this.value - target) - damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      left -= h;
    }
    return this.value;
  }

  set(value: number) {
    this.value = value;
    this.velocity = 0;
  }

  kick(velocity: number) {
    this.velocity += velocity;
  }
}

/* -------------------------------------------------------------------------
   The pose: a 2D affine matrix about the hotspot
   ------------------------------------------------------------------------- */

/** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const rad = (deg: number) => (deg * Math.PI) / 180;
export const rotate = (deg: number): Mat => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [c, s, -s, c, 0, 0];
};
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export const skewX = (deg: number): Mat => [1, 0, Math.tan(rad(deg)), 1, 0, 0];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];

export type Pose = {
  x: number;
  y: number;
  /** Degrees, clockwise on screen. */
  lean: number;
  /** Stretch along `heading` (1 = none); squeezed across it to keep the area. */
  stretch: number;
  /** Direction of travel, degrees. */
  heading: number;
  /** Skew along the direction of travel, degrees. */
  skew: number;
  scale: number;
};

export function poseMatrix(p: Pose): Mat {
  let m = translate(p.x, p.y);
  m = mul(m, rotate(p.lean));
  if (p.stretch !== 1 || p.skew !== 0) {
    m = mul(m, rotate(p.heading));
    m = mul(m, scale(p.stretch, 1 / p.stretch));
    m = mul(m, skewX(p.skew));
    m = mul(m, rotate(-p.heading));
  }
  return mul(m, scale(p.scale));
}

/** Applies a matrix to a flat [x0, y0, x1, y1, ...] ring. */
export function transformRing(m: Mat, ring: ArrayLike<number>, out: Float64Array = new Float64Array(ring.length)): Float64Array {
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i];
    const y = ring[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
}
