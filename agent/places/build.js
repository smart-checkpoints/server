"use strict";

/**
 * Builds places.json, the demo place list the Sayes agent resolves names
 * against.
 *
 * Every coordinate is snapped onto the road it names with OSRM, and checked
 * against the street name OSRM reports there, so a place in the list is a
 * point on that road rather than a guess near it. Rerun this whenever a
 * street, segment or landmark below changes:
 *
 *     node agent/places/build.js
 *
 * OSRM_BASE_URL overrides the public demo server, which is rate limited.
 */

const fs = require("fs");
const path = require("path");

const OSRM = (process.env.OSRM_BASE_URL || "https://router.project-osrm.org").replace(/\/$/, "");

/**
 * Each street is one stretch of road, traced in the direction OSRM routes
 * along it: `from` and `to` are approximate ends, and `osmName` is the name
 * the road carries in OpenStreetMap, which is what the trace is checked
 * against.
 *
 * `layout` and `direction` decide which way checkpoints on it are connected:
 * a camera on one carriageway only sees traffic going that way, so on a
 * `one-way` or `divided` road the trace direction is the only legal one and
 * no reverse edge is created unless the operator asks. `two-way` means an
 * undivided road, where both directions are the default. The layouts below
 * were checked against OSRM: on each, routing the reverse way between two
 * points on the trace took 2-4.5x the forward distance.
 */
const STREETS = [
  {
    id: "fouad",
    name: "Fouad Street (El Horreya Road)",
    aliases: ["fouad", "fouad street", "horreya", "el horreya", "horreya road", "tariq el horreya", "downtown"],
    osmName: "طريق الحرية",
    area: "Downtown",
    from: [31.2011, 29.91429],
    to: [31.19626, 29.90192],
    layout: "one-way",
    direction: "westbound",
    traffic: "one-way, westbound on this stretch",
  },
  {
    id: "geish",
    name: "El Geish Road (the Corniche)",
    aliases: ["el geish", "geish", "el geish road", "corniche", "the corniche", "shatby", "el shatby"],
    osmName: "طريق الجيش",
    area: "El Shatby, by the Bibliotheca Alexandrina",
    from: [31.20655, 29.90559],
    to: [31.21411, 29.9199],
    layout: "divided",
    direction: "eastbound",
    traffic: "divided road; these points are on the eastbound carriageway, on the Bibliotheca side",
  },
  {
    // "Abu Qir Street" is what operators call it; OpenStreetMap names this
    // stretch Gamal Abdel Nasser Street, which is what the trace checks.
    id: "abuqir",
    name: "Abu Qir Street",
    aliases: ["abu qir", "abu qir street", "abu qir road", "abuqir", "abu kir", "gamal abdel nasser", "gamal abdel nasser street", "sidi gaber"],
    osmName: "شارع جمال عبد الناصر",
    area: "Sidi Gaber",
    from: [31.21475, 29.93674],
    to: [31.22393, 29.94648],
    layout: "divided",
    direction: "eastbound",
    traffic: "divided road; these points are on the eastbound carriageway",
  },
];

/** Landmarks are snapped onto the street they are on, not to whatever road is nearest. */
const LANDMARKS = [
  { name: "Bibliotheca Alexandrina", aliases: ["bibliotheca", "library", "the library"], street: "geish", near: [31.2089, 29.9092] },
  { name: "El Shatby", aliases: ["shatby", "el shatby"], street: "geish", near: [31.2135, 29.9175] },
  { name: "Alexandria National Museum", aliases: ["national museum", "museum"], street: "fouad", near: [31.2006, 29.9131] },
  { name: "Sidi Gaber", aliases: ["sidi gaber", "sidi gaber station"], street: "abuqir", near: [31.2186, 29.9425] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function osrm(pathAndQuery) {
  const response = await fetch(`${OSRM}${pathAndQuery}`, {
    headers: { "User-Agent": "smart-checkpoints-places-builder" },
  });
  const body = await response.json();
  if (body.code !== "Ok") throw new Error(`OSRM ${pathAndQuery}: ${body.code} ${body.message || ""}`);
  await sleep(350); // the public server is shared; be polite
  return body;
}

const round = (value) => Math.round(value * 1e6) / 1e6;

function haversine(a, b) {
  const R = 6371008.8;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The point on a polyline of [lat, lng] closest to `p`, on a local flat projection. */
function closestPointOnLine(p, line) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  let best = null;
  for (let i = 1; i < line.length; i += 1) {
    const [ay, ax] = [line[i - 1][0], line[i - 1][1] * k];
    const [by, bx] = [line[i][0], line[i][1] * k];
    const [py, px] = [p[0], p[1] * k];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const q = [ay + t * dy, (ax + t * dx) / k];
    const d = haversine(p, q);
    if (!best || d < best.d) best = { d, q };
  }
  return best.q;
}

/** The nearest point on a road carrying `osmName`, or an error naming what was found instead. */
async function snapTo(near, osmName) {
  const body = await osrm(`/nearest/v1/driving/${near[1]},${near[0]}?number=12`);
  const hit = body.waypoints.find((w) => (w.name || "").includes(osmName));
  if (!hit) {
    const seen = [...new Set(body.waypoints.map((w) => w.name || "(unnamed)"))].join(", ");
    throw new Error(`no road named ${osmName} near ${near}: found ${seen}`);
  }
  return { point: [round(hit.location[1]), round(hit.location[0])], offset: hit.distance };
}

async function traceStreet(street) {
  const start = await snapTo(street.from, street.osmName);
  const end = await snapTo(street.to, street.osmName);
  const body = await osrm(
    `/route/v1/driving/${start.point[1]},${start.point[0]};${end.point[1]},${end.point[0]}` +
      "?steps=true&geometries=geojson&overview=false",
  );

  const coordinates = [];
  const offRoad = [];
  for (const step of body.routes[0].legs[0].steps) {
    if (step.distance === 0) continue;
    if (!(step.name || "").includes(street.osmName)) {
      offRoad.push(`${step.name || "(unnamed)"} ${step.distance.toFixed(0)} m`);
      continue;
    }
    for (const [lng, lat] of step.geometry.coordinates) {
      const last = coordinates[coordinates.length - 1];
      if (!last || last[0] !== round(lat) || last[1] !== round(lng)) coordinates.push([round(lat), round(lng)]);
    }
  }
  if (offRoad.length > 0) {
    throw new Error(`${street.name}: the trace leaves ${street.osmName} via ${offRoad.join(", ")}`);
  }

  let length = 0;
  for (let i = 1; i < coordinates.length; i += 1) length += haversine(coordinates[i - 1], coordinates[i]);
  return { coordinates, length: Math.round(length) };
}

(async () => {
  const streets = [];
  for (const street of STREETS) {
    const { coordinates, length } = await traceStreet(street);
    streets.push({
      id: street.id,
      name: street.name,
      aliases: street.aliases,
      osm_name: street.osmName,
      area: street.area,
      layout: street.layout,
      direction: street.direction,
      traffic: street.traffic,
      length_m: length,
      start: coordinates[0],
      end: coordinates[coordinates.length - 1],
      line: coordinates,
    });
    console.log(`${street.name}: ${length} m, ${coordinates.length} points, ${coordinates[0]} -> ${coordinates[coordinates.length - 1]}`);
  }

  // A landmark goes onto the traced carriageway first, so it lands on the same
  // side of a divided road as the street's checkpoints, and is then snapped
  // with OSRM like everything else.
  const landmarks = [];
  for (const landmark of LANDMARKS) {
    const street = streets.find((s) => s.id === landmark.street);
    const onLine = closestPointOnLine(landmark.near, street.line);
    const snapped = await snapTo(onLine, street.osm_name);
    const moved = Math.round(haversine(landmark.near, snapped.point));
    landmarks.push({
      name: landmark.name,
      aliases: landmark.aliases,
      street: landmark.street,
      point: snapped.point,
      snapped_from: landmark.near,
      snap_distance_m: moved,
    });
    console.log(`${landmark.name}: ${snapped.point} (moved ${moved} m onto ${street.name})`);
  }

  const out = {
    generated_by: "agent/places/build.js",
    generated_at: new Date().toISOString(),
    source: `OSRM ${OSRM}, road data (c) OpenStreetMap contributors`,
    streets,
    landmarks,
  };
  fs.writeFileSync(path.join(__dirname, "places.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("wrote agent/places/places.json");
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
