"use strict";

/**
 * What Sayes can learn about a place from OpenStreetMap, beyond the demo
 * place list: geocoding (Nominatim), road attributes and nearby features
 * (Overpass), and snapping a point onto a road (OSRM).
 *
 * These are shared public services with usage policies, so every call here
 * goes through one queue per service, identifies itself, and is cached:
 *   - Nominatim: at most one request a second, a real User-Agent, Egypt only.
 *   - Overpass: one request at a time, a small timeout, results cached.
 *   - OSRM: the public demo server the places list was built with.
 *
 * OSM is volunteer-mapped. A missing tag means nobody mapped it, not that the
 * road has no limit or no lanes, and OSM holds nothing about accidents or
 * traffic. Every result says where it came from and what it does not know.
 */

const { haversineMeters } = require("../geo.js");

const NOMINATIM = (process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org").replace(/\/$/, "");
// The main Overpass instance is often busy; public mirrors are tried in turn.
const OVERPASS = (
  process.env.OVERPASS_URL
    ? [process.env.OVERPASS_URL]
    : [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      ]
).map((url) => url.replace(/\/$/, ""));
const OSRM = (process.env.OSRM_BASE_URL || "https://router.project-osrm.org").replace(/\/$/, "");
const USER_AGENT =
  process.env.OSM_USER_AGENT || "SmartCheckpoints-Sayes/0.1 (+https://github.com/smart-checkpoints/server)";

const TIMEOUT_MS = 12000;
const OVERPASS_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_MAX = 500;

class OsmError extends Error {}

/* -------------------------------------------------------------------------
   Plumbing: a polite queue per service, and a small cache
   ------------------------------------------------------------------------- */

function queue(minGapMs) {
  let tail = Promise.resolve();
  let last = 0;
  return (task) => {
    const run = tail.then(async () => {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        return await task();
      } finally {
        last = Date.now();
      }
    });
    tail = run.catch(() => undefined);
    return run;
  };
}

const nominatimQueue = queue(1100);
const overpassQueue = queue(1000);
const osrmQueue = queue(350);

const cache = new Map();
function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_TTL_MS) return hit.value;
  const value = compute().then(
    (result) => result,
    (err) => {
      cache.delete(key);
      throw err;
    },
  );
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

async function getJson(url, init = {}, timeoutMs = TIMEOUT_MS, cancel = null) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers || {}) },
      signal: cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new OsmError(`${new URL(url).host} could not be reached (${err.name === "TimeoutError" ? "timed out" : err.message}).`);
  }
  if (response.status === 429) throw new OsmError(`${new URL(url).host} is rate limiting requests; try again in a minute.`);
  if (!response.ok) throw new OsmError(`${new URL(url).host} answered HTTP ${response.status}.`);
  return response.json();
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/* -------------------------------------------------------------------------
   Geocoding
   ------------------------------------------------------------------------- */

/** Places in Egypt matching a free-text query, best first, each snapped onto the nearest drivable road. */
function geocode(query) {
  const q = String(query).trim().slice(0, 200);
  return cached(`geocode:${q.toLowerCase()}`, async () => {
    const params = new URLSearchParams({
      q,
      format: "jsonv2",
      countrycodes: "eg",
      limit: "5",
      addressdetails: "1",
      "accept-language": "en,ar",
    });
    const rows = await nominatimQueue(() => getJson(`${NOMINATIM}/search?${params}`));
    const results = [];
    for (const row of rows) {
      const latitude = round6(Number(row.lat));
      const longitude = round6(Number(row.lon));
      const snapped = await snap(latitude, longitude).catch(() => null);
      results.push({
        name: row.name || row.display_name.split(",")[0],
        address: row.display_name,
        kind: `${row.category || row.class}/${row.type}`,
        latitude,
        longitude,
        ...(snapped ? { nearest_road: snapped } : {}),
      });
    }
    return results;
  });
}

/** The nearest point on a drivable road, by OSRM. */
function snap(latitude, longitude) {
  const key = `snap:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  return cached(key, async () => {
    const body = await osrmQueue(() => getJson(`${OSRM}/nearest/v1/driving/${longitude},${latitude}?number=1`));
    const hit = body && body.waypoints && body.waypoints[0];
    if (!hit) throw new OsmError("No road found near that point.");
    return {
      latitude: round6(hit.location[1]),
      longitude: round6(hit.location[0]),
      road: hit.name || null,
      moved_m: Math.round(hit.distance),
    };
  });
}

/* -------------------------------------------------------------------------
   Overpass
   ------------------------------------------------------------------------- */

function overpass(query, key) {
  return cached(`overpass:${key}`, () =>
    overpassQueue(async () => {
      // All mirrors at once, first good answer wins: a busy instance can take
      // half a minute to fail, and an operator is watching. The others are
      // cancelled as soon as one answers.
      const stop = new AbortController();
      const attempts = OVERPASS.map((url) =>
        getJson(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ data: query }).toString(),
          },
          OVERPASS_TIMEOUT_MS,
          stop.signal,
        ),
      );
      try {
        return await Promise.any(attempts);
      } catch (err) {
        const reasons = (err.errors || []).map((e) => e.message).join("; ");
        throw new OsmError(`No Overpass server answered in time (${reasons}).`);
      } finally {
        stop.abort();
      }
    }),
  );
}

const DRIVABLE =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|service";

/** Distance from a point to the nearest vertex-to-vertex segment of a way's geometry. */
function distanceToWay(point, geometry) {
  let best = Infinity;
  const k = Math.cos((point.lat * Math.PI) / 180);
  for (let i = 1; i < geometry.length; i += 1) {
    const a = geometry[i - 1];
    const b = geometry[i];
    const ax = a.lon * k;
    const bx = b.lon * k;
    const px = point.lng * k;
    const dx = bx - ax;
    const dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (point.lat - a.lat) * dy) / len2));
    const q = { lat: a.lat + t * dy, lng: (ax + t * dx) / k };
    best = Math.min(best, haversineMeters(point, q));
  }
  return best;
}

function bearing(a, b) {
  const k = Math.cos((a.lat * Math.PI) / 180);
  const deg = (Math.atan2((b.lon - a.lon) * k, b.lat - a.lat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const COMPASS = ["northbound", "north-eastbound", "eastbound", "south-eastbound", "southbound", "south-westbound", "westbound", "north-westbound"];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

/**
 * The road at a point and what OSM records about it: class, one-way,
 * whether it is mapped as a divided road, lanes and speed limit.
 */
async function roadAt(latitude, longitude) {
  const point = { lat: latitude, lng: longitude };
  const query = `[out:json][timeout:10];way(around:80,${latitude},${longitude})[highway~"^(${DRIVABLE})$"];out tags geom;`;
  const body = await overpass(query, `road:${latitude.toFixed(5)},${longitude.toFixed(5)}`);
  const ways = (body.elements || [])
    .filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length > 1)
    .map((e) => ({ way: e, distance: distanceToWay(point, e.geometry) }))
    .sort((a, b) => a.distance - b.distance);
  if (ways.length === 0 || ways[0].distance > 40) {
    return { found: false, note: "OpenStreetMap has no drivable road within 40 m of this point." };
  }

  const nearest = ways[0].way;
  const tags = nearest.tags || {};
  const name = tags["name:en"] || tags.name || null;
  const oneway = tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "-1" || tags.junction === "roundabout";
  const g = nearest.geometry;
  let heading = bearing(g[0], g[g.length - 1]);
  if (tags.oneway === "-1") heading = (heading + 180) % 360;

  // A divided road is mapped as two one-way ways, one each way, with the same
  // name, a few tens of metres apart.
  const twin = oneway
    ? ways.slice(1).find(({ way, distance }) => {
        const t = way.tags || {};
        if (distance > 80 || !(t.oneway === "yes" || t.oneway === "1")) return false;
        if ((t.name || null) !== (tags.name || null)) return false;
        const h = bearing(way.geometry[0], way.geometry[way.geometry.length - 1]);
        // Running the other way: about 180 degrees from this one.
        const diff = Math.abs(((h - heading + 540) % 360) - 180);
        return diff > 135;
      })
    : null;

  const layout = twin ? "divided" : oneway ? "one-way" : "two-way";
  const missing = ["maxspeed", "lanes"].filter((t) => !tags[t]);
  return {
    found: true,
    source: "OpenStreetMap via Overpass",
    osm_way_id: nearest.id,
    name,
    name_ar: tags["name:ar"] || (tags.name && /[؀-ۿ]/.test(tags.name) ? tags.name : null),
    road_class: tags.highway,
    layout,
    ...(oneway ? { direction_of_travel: compass(heading) } : {}),
    lanes: tags.lanes ? Number(tags.lanes) || tags.lanes : null,
    maxspeed_kmh: tags.maxspeed ? Number.parseInt(tags.maxspeed, 10) || tags.maxspeed : null,
    surface: tags.surface || null,
    lit: tags.lit || null,
    distance_m: Math.round(ways[0].distance),
    not_in_osm: missing.length
      ? `OSM has no ${missing.join(" or ")} tag for this road. That means nobody mapped it, not that there is none; do not assume a value.`
      : null,
  };
}

const NEARBY = [
  { kind: "school", filter: '["amenity"~"^(school|kindergarten|college|university)$"]' },
  { kind: "hospital", filter: '["amenity"~"^(hospital|clinic)$"]' },
  { kind: "traffic signals", filter: '["highway"="traffic_signals"]' },
  { kind: "pedestrian crossing", filter: '["highway"="crossing"]' },
  { kind: "speed bump", filter: '["traffic_calming"]' },
  { kind: "fuel station", filter: '["amenity"="fuel"]' },
  { kind: "bus stop", filter: '["highway"="bus_stop"]' },
];

/** Schools, hospitals, signals, crossings and the like near a point, nearest first. */
async function nearby(latitude, longitude, radius) {
  const r = Math.max(50, Math.min(1000, Math.round(radius)));
  const parts = NEARBY.map((n) => `nwr(around:${r},${latitude},${longitude})${n.filter};`).join("");
  const query = `[out:json][timeout:15];(${parts});out tags center;`;
  const body = await overpass(query, `near:${latitude.toFixed(4)},${longitude.toFixed(4)}:${r}`);
  const point = { lat: latitude, lng: longitude };
  const found = { };
  for (const e of body.elements || []) {
    const at = e.type === "node" ? { lat: e.lat, lng: e.lon } : e.center ? { lat: e.center.lat, lng: e.center.lon } : null;
    if (!at) continue;
    const tags = e.tags || {};
    const kind =
      NEARBY.find((n) => {
        if (n.kind === "school") return /^(school|kindergarten|college|university)$/.test(tags.amenity || "");
        if (n.kind === "hospital") return /^(hospital|clinic)$/.test(tags.amenity || "");
        if (n.kind === "traffic signals") return tags.highway === "traffic_signals";
        if (n.kind === "pedestrian crossing") return tags.highway === "crossing";
        if (n.kind === "speed bump") return Boolean(tags.traffic_calming);
        if (n.kind === "fuel station") return tags.amenity === "fuel";
        if (n.kind === "bus stop") return tags.highway === "bus_stop";
        return false;
      }) || null;
    if (!kind) continue;
    (found[kind.kind] = found[kind.kind] || []).push({
      name: tags["name:en"] || tags.name || null,
      distance_m: Math.round(haversineMeters(point, at)),
    });
  }
  const summary = {};
  for (const n of NEARBY) {
    const list = (found[n.kind] || []).sort((a, b) => a.distance_m - b.distance_m);
    summary[n.kind] = { count: list.length, nearest: list.slice(0, 3) };
  }
  return {
    source: "OpenStreetMap via Overpass",
    radius_m: r,
    features: summary,
    not_in_osm:
      "OSM has no accident, crash or traffic-volume data. Counts are what volunteers mapped; a zero can mean unmapped, not absent.",
  };
}

/** The street at a point, from Nominatim's reverse geocoder. Cached. */
function reverseStreet(latitude, longitude) {
  const key = `reverse:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  return cached(key, async () => {
    const params = new URLSearchParams({
      lat: String(latitude),
      lon: String(longitude),
      format: "jsonv2",
      zoom: "17",
      "accept-language": "en,ar",
    });
    const row = await nominatimQueue(() => getJson(`${NOMINATIM}/reverse?${params}`));
    const address = (row && row.address) || {};
    return address.road || address.pedestrian || address.neighbourhood || address.suburb || null;
  });
}

module.exports = { geocode, snap, roadAt, nearby, reverseStreet, OsmError };
