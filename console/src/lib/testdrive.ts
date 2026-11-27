/**
 * Test drives for demo projects.
 *
 * A test drive is a car the console moves between checkpoints. What it moves
 * along is the road a distance driver stored, and what it produces is a
 * sequence of sightings sent to `/report-checkpoint` - plate, checkpoint, time
 * - exactly as a camera would send them. The server decides whether that was
 * a violation. Nothing in this file computes one.
 *
 * Everything here is pure: routing, the track, the timetable. The panel owns
 * the clock and the requests.
 */
import type { CheckpointNode, Connection, PathGeometry } from "@/lib/api";
import { haversineMeters, type LatLng } from "@/lib/geo";

export type Hop = {
  connection: Connection;
  from: CheckpointNode;
  to: CheckpointNode;
  /** The road distance the server will divide by, or a straight line if none. */
  meters: number;
  straightMeters: number;
  enforced: boolean;
};

export type Route = {
  hops: Hop[];
  meters: number;
  straightMeters: number;
};

const toLatLng = (node: CheckpointNode): LatLng => ({
  lat: node.latitude,
  lng: node.longitude,
});

/**
 * The shortest way from one checkpoint to another over the project's edges.
 *
 * Edges are directed, because the server looks a traversal up by
 * (from, to) and nothing else - a car driven against an edge's direction would
 * be judged against no edge at all.
 */
export function planRoute(
  fromNodeId: number,
  toNodeId: number,
  nodes: CheckpointNode[],
  connections: Connection[],
): Route | null {
  if (fromNodeId === toNodeId) return null;
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  if (!byId.has(fromNodeId) || !byId.has(toNodeId)) return null;

  const weight = (edge: Connection) => {
    if (edge.distance_status === "ok" && edge.distance) return edge.distance;
    const a = byId.get(edge.from_node_id);
    const b = byId.get(edge.to_node_id);
    return a && b ? haversineMeters(toLatLng(a), toLatLng(b)) : Infinity;
  };

  const dist = new Map<number, number>([[fromNodeId, 0]]);
  const via = new Map<number, Connection>();
  const done = new Set<number>();

  for (;;) {
    let current: number | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!done.has(id) && d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null || current === toNodeId) break;
    done.add(current);
    for (const edge of connections) {
      if (edge.from_node_id !== current || !byId.has(edge.to_node_id)) continue;
      const next = best + weight(edge);
      if (next < (dist.get(edge.to_node_id) ?? Infinity)) {
        dist.set(edge.to_node_id, next);
        via.set(edge.to_node_id, edge);
      }
    }
  }

  if (!via.has(toNodeId)) return null;

  const hops: Hop[] = [];
  let cursor = toNodeId;
  while (cursor !== fromNodeId) {
    const edge = via.get(cursor)!;
    const from = byId.get(edge.from_node_id)!;
    const to = byId.get(edge.to_node_id)!;
    hops.unshift({
      connection: edge,
      from,
      to,
      meters: weight(edge),
      straightMeters: haversineMeters(toLatLng(from), toLatLng(to)),
      enforced: edge.distance_status === "ok",
    });
    cursor = edge.from_node_id;
  }

  return {
    hops,
    meters: hops.reduce((sum, hop) => sum + hop.meters, 0),
    straightMeters: hops.reduce((sum, hop) => sum + hop.straightMeters, 0),
  };
}

/* -------------------------------------------------------------------------
   The track: where the car is at a given fraction of the trip
   ------------------------------------------------------------------------- */

type Polyline = { points: LatLng[]; cumulative: number[]; total: number };

export type Track = { route: Route; lines: Polyline[] };

function polyline(points: LatLng[]): Polyline {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + haversineMeters(points[i - 1], points[i]));
  }
  return { points, cumulative, total: cumulative[cumulative.length - 1] };
}

/**
 * One line per hop: the stored road shape when there is one, a straight line
 * when there is not. A stored shape is oriented to start at the hop's own
 * starting checkpoint, whichever way round it was stored.
 */
export function buildTrack(
  route: Route,
  geometry: Record<number, PathGeometry>,
): Track {
  const lines = route.hops.map((hop) => {
    const start = toLatLng(hop.from);
    const end = toLatLng(hop.to);
    const path = geometry[hop.connection.connection_id];
    if (!path || path.coordinates.length < 2) return polyline([start, end]);

    let points = path.coordinates.map(([lng, lat]) => ({ lat, lng }));
    if (
      haversineMeters(points[0], end) < haversineMeters(points[0], start)
    ) {
      points = points.slice().reverse();
    }
    return polyline(points);
  });
  return { route, lines };
}

function pointOn(line: Polyline, t: number): LatLng {
  if (line.total === 0) return line.points[0];
  const target = Math.min(1, Math.max(0, t)) * line.total;
  let i = 1;
  while (i < line.cumulative.length - 1 && line.cumulative[i] < target) i += 1;
  const a = line.points[i - 1];
  const b = line.points[i];
  const span = line.cumulative[i] - line.cumulative[i - 1];
  const k = span === 0 ? 0 : (target - line.cumulative[i - 1]) / span;
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
}

export type TrackPosition = {
  hopIndex: number;
  /** Fraction of the way along this hop, 0 to 1. */
  hopT: number;
  position: LatLng;
};

/** Where the car is once `fraction` of the trip's distance has been driven. */
export function positionAt(track: Track, fraction: number): TrackPosition {
  const { hops } = track.route;
  const driven = Math.min(1, Math.max(0, fraction)) * track.route.meters;
  let before = 0;
  for (let i = 0; i < hops.length; i += 1) {
    const length = hops[i].meters;
    if (driven <= before + length || i === hops.length - 1) {
      const hopT = length === 0 ? 1 : Math.min(1, (driven - before) / length);
      return { hopIndex: i, hopT, position: pointOn(track.lines[i], hopT) };
    }
    before += length;
  }
  return { hopIndex: 0, hopT: 0, position: toLatLng(hops[0].from) };
}

/* -------------------------------------------------------------------------
   The driver: a speed for every metre of the trip
   ------------------------------------------------------------------------- */

export type DriverOptions = {
  /** The speed the driver holds on an open road. */
  cruiseKmh: number;
  /**
   * Kangaroo driving: brake hard to `cameraKmh` before every checkpoint, pass
   * it at that speed, then floor it back up to cruise once past.
   */
  kangaroo: boolean;
  cameraKmh: number;
};

/** The drive sampled along its length: distance, real time and speed. */
export type SpeedProfile = {
  meters: Float64Array;
  seconds: Float64Array;
  kmh: Float64Array;
};

/** How long, either side of a checkpoint, a kangaroo driver holds camera speed. */
const CAMERA_HOLD_METERS = 25;

/** A small seeded random, so one drive's wobble is the same all the way. */
function seeded(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/**
 * How fast the car goes at every point of the trip.
 *
 * A human driver, not a cruise control: the speed drifts a few per cent
 * around cruise, and every change of speed is limited by how hard the car can
 * accelerate and brake. The car passes the first and last checkpoints rolling,
 * the way a camera sees real traffic. A kangaroo driver also has a target of
 * `cameraKmh` around each checkpoint, and accelerates and brakes harder.
 */
export function speedProfile(
  route: Route,
  options: DriverOptions,
  seed = Date.now(),
): SpeedProfile {
  const total = route.meters;
  const count = Math.max(2, Math.min(20000, Math.ceil(total / 2)) + 1);
  const ds = total / (count - 1);
  const random = seeded(seed);

  const cruise = Math.max(1, options.cruiseKmh) / 3.6;
  const camera = Math.max(1, Math.min(options.cameraKmh, options.cruiseKmh)) / 3.6;
  const accel = options.kangaroo ? 3.2 : 1.8; // m/s²
  const brake = options.kangaroo ? 5.5 : 2.8; // m/s²

  // Two slow waves of a few per cent: the foot is never quite still.
  const waves = [
    { amp: 0.035, length: 700 + random() * 600, phase: random() * Math.PI * 2 },
    { amp: 0.02, length: 220 + random() * 200, phase: random() * Math.PI * 2 },
  ];

  const cameras = [0];
  for (const hop of route.hops) cameras.push(cameras[cameras.length - 1] + hop.meters);

  const meters = new Float64Array(count);
  const v = new Float64Array(count);
  let next = 0;
  for (let i = 0; i < count; i += 1) {
    const s = i * ds;
    meters[i] = s;
    let target = cruise;
    for (const w of waves) target *= 1 + w.amp * Math.sin((2 * Math.PI * s) / w.length + w.phase);
    if (options.kangaroo) {
      while (next < cameras.length - 1 && cameras[next] < s - CAMERA_HOLD_METERS) next += 1;
      if (Math.abs(cameras[next] - s) <= CAMERA_HOLD_METERS) target = Math.min(target, camera);
    }
    v[i] = target;
  }

  // The car cannot change speed faster than its engine and brakes allow.
  for (let i = 1; i < count; i += 1) {
    v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * accel * ds));
  }
  for (let i = count - 2; i >= 0; i -= 1) {
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * brake * ds));
  }

  const seconds = new Float64Array(count);
  const kmh = new Float64Array(count);
  kmh[0] = v[0] * 3.6;
  for (let i = 1; i < count; i += 1) {
    seconds[i] = seconds[i - 1] + (2 * ds) / (v[i - 1] + v[i]);
    kmh[i] = v[i] * 3.6;
  }
  return { meters, seconds, kmh };
}

/** Where the driver is, and how fast, `seconds` into the real trip. */
export function profileAt(
  profile: SpeedProfile,
  seconds: number,
): { meters: number; kmh: number } {
  const { meters, kmh } = profile;
  const times = profile.seconds;
  const last = times.length - 1;
  if (seconds <= 0) return { meters: 0, kmh: kmh[0] };
  if (seconds >= times[last]) return { meters: meters[last], kmh: kmh[last] };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= seconds) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  const k = span === 0 ? 0 : (seconds - times[lo]) / span;
  return {
    meters: meters[lo] + (meters[hi] - meters[lo]) * k,
    kmh: kmh[lo] + (kmh[hi] - kmh[lo]) * k,
  };
}

function secondsAtMeters(profile: SpeedProfile, at: number): number {
  const { meters, seconds } = profile;
  const last = meters.length - 1;
  if (at <= 0) return 0;
  if (at >= meters[last]) return seconds[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (meters[mid] <= at) lo = mid;
    else hi = mid;
  }
  const span = meters[hi] - meters[lo];
  const k = span === 0 ? 0 : (at - meters[lo]) / span;
  return seconds[lo] + (seconds[hi] - seconds[lo]) * k;
}

/* -------------------------------------------------------------------------
   The timetable
   ------------------------------------------------------------------------- */

export type Timetable = {
  /** ISO time the car passes each checkpoint: hops.length + 1 entries. */
  sightings: string[];
  /** Fraction of the trip at which each checkpoint is passed. */
  fractions: number[];
  /** The speed the car is doing as it passes each checkpoint, km/h. */
  passKmh: number[];
  /** The average speed over each hop, km/h: what the server should find. */
  hopAverageKmh: number[];
  profile: SpeedProfile;
  realSeconds: number;
  playSeconds: number;
  /** How much faster than real time the drive is played. */
  timeLapse: number;
};

/**
 * When the car passes each checkpoint, driven by `options`.
 *
 * Backdated: the last checkpoint is passed at `now`, so no sighting the
 * server is sent is ever in the future. Played back compressed to between 4
 * and 10 seconds, and the panel says by how much.
 */
export function timetable(route: Route, options: DriverOptions, now: number): Timetable {
  const profile = speedProfile(route, options);
  const realSeconds = profile.seconds[profile.seconds.length - 1];
  const start = now - realSeconds * 1000;

  const sightings = [new Date(start).toISOString()];
  const fractions = [0];
  const passKmh = [profileAt(profile, 0).kmh];
  const hopAverageKmh: number[] = [];
  let driven = 0;
  let previous = 0;
  for (const hop of route.hops) {
    driven += hop.meters;
    const at = secondsAtMeters(profile, driven);
    sightings.push(new Date(start + at * 1000).toISOString());
    fractions.push(route.meters === 0 ? 1 : driven / route.meters);
    passKmh.push(profileAt(profile, at).kmh);
    hopAverageKmh.push(at - previous > 0 ? (hop.meters / (at - previous)) * 3.6 : 0);
    previous = at;
  }

  const playSeconds = Math.min(realSeconds, Math.max(4, Math.min(10, realSeconds / 10)));
  return {
    sightings,
    fractions,
    passKmh,
    hopAverageKmh,
    profile,
    realSeconds,
    playSeconds,
    timeLapse: playSeconds === 0 ? 1 : realSeconds / playSeconds,
  };
}

/**
 * A fresh plate for every drive. The server remembers a car's last sighting
 * by plate, so reusing one would join two drives into a single trip.
 */
export function randomDemoPlate(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "DEMO-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** What the server's `reason` means, for the hop rows. */
export function describeReason(reason: string | null | undefined): string {
  switch (reason) {
    case "first-sighting":
      return "First sighting";
    case "no-edge":
      return "No edge between these checkpoints";
    case "out-of-order":
      return "Arrived out of order";
    case "distance-not-resolved":
      return "Not enforced: road distance not resolved";
    default:
      return "Within the limit";
  }
}
