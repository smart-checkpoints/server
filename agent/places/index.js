"use strict";

/**
 * The demo place list: which streets and landmarks Dispatch can name, and
 * points along them. Built by `build.js`, snapped onto the roads with OSRM.
 * Nothing here calls the network.
 */

const { haversineMeters } = require("../../geo.js");
const data = require("./places.json");

const normalise = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const ll = ([lat, lng]) => ({ lat, lng });

function score(query, names) {
  const q = normalise(query);
  let best = 0;
  for (const name of names) {
    const n = normalise(name);
    if (!n) continue;
    if (n === q) best = Math.max(best, 3);
    else if (q.includes(n) || n.includes(q)) best = Math.max(best, 2);
    else if (n.split(" ").some((word) => word.length > 3 && q.includes(word))) best = Math.max(best, 1);
  }
  return best;
}

function findStreet(query) {
  let best = null;
  for (const street of data.streets) {
    const s = score(query, [street.name, street.id, street.osm_name, ...street.aliases]);
    if (s > 0 && (!best || s > best.s)) best = { s, street };
  }
  return best ? best.street : null;
}

/** How checkpoints on this street are connected by default. */
function connectRule(street) {
  return street.layout === "two-way"
    ? "Two-way undivided road: connect neighbouring checkpoints in both directions."
    : `${street.layout === "one-way" ? "One-way" : "Divided"} road: connect neighbouring checkpoints in the order given (${street.direction}) only. No reverse edges unless the operator explicitly asks for both directions.`;
}

function describeStreet(street) {
  return {
    kind: "street",
    name: street.name,
    area: street.area,
    layout: street.layout,
    direction: street.direction,
    traffic: street.traffic,
    connect: connectRule(street),
    length_m: street.length_m,
    start: { latitude: street.start[0], longitude: street.start[1] },
    end: { latitude: street.end[0], longitude: street.end[1] },
  };
}

/** Every place whose name matches the query, best first. */
function findPlaces(query) {
  const hits = [];
  for (const landmark of data.landmarks) {
    const s = score(query, [landmark.name, ...landmark.aliases]);
    if (s > 0) {
      const street = data.streets.find((candidate) => candidate.id === landmark.street);
      hits.push({
        s: s + 0.5, // a landmark is more specific than the street it is on
        place: {
          kind: "landmark",
          name: landmark.name,
          on_street: street.name,
          latitude: landmark.point[0],
          longitude: landmark.point[1],
        },
      });
    }
  }
  for (const street of data.streets) {
    const s = score(query, [street.name, street.id, street.osm_name, ...street.aliases]);
    if (s > 0) hits.push({ s, place: describeStreet(street) });
  }
  return hits.sort((a, b) => b.s - a.s).map((hit) => hit.place);
}

/**
 * `count` points spread evenly along a street, ends included, in the
 * direction it was traced. One point is the middle of the street.
 */
function pointsAlongStreet(street, count) {
  const line = street.line;
  const cumulative = [0];
  for (let i = 1; i < line.length; i += 1) {
    cumulative.push(cumulative[i - 1] + haversineMeters(ll(line[i - 1]), ll(line[i])));
  }
  const total = cumulative[cumulative.length - 1];
  const targets =
    count === 1 ? [total / 2] : Array.from({ length: count }, (_, i) => (total * i) / (count - 1));

  return targets.map((at) => {
    let i = 1;
    while (i < line.length - 1 && cumulative[i] < at) i += 1;
    const span = cumulative[i] - cumulative[i - 1];
    const t = span === 0 ? 0 : (at - cumulative[i - 1]) / span;
    const lat = line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t;
    const lng = line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t;
    return {
      latitude: Math.round(lat * 1e6) / 1e6,
      longitude: Math.round(lng * 1e6) / 1e6,
      metres_from_start: Math.round(at),
    };
  });
}

/** The demo street a coordinate is on (within `withinM` of its line), or null. */
function streetAt(latitude, longitude, withinM = 60) {
  const k = Math.cos((latitude * Math.PI) / 180);
  let best = null;
  for (const street of data.streets) {
    const line = street.line;
    for (let i = 1; i < line.length; i += 1) {
      const [ay, ax] = [line[i - 1][0], line[i - 1][1] * k];
      const [by, bx] = [line[i][0], line[i][1] * k];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((longitude * k - ax) * dx + (latitude - ay) * dy) / len2));
      const q = { lat: ay + t * dy, lng: (ax + t * dx) / k };
      const d = haversineMeters({ lat: latitude, lng: longitude }, q);
      if (d <= withinM && (!best || d < best.d)) best = { d, name: street.name };
    }
  }
  return best ? best.name : null;
}

/** The best place name for a coordinate, if one is close by: for display. */
function nearestLandmark(latitude, longitude, withinM = 250) {
  let best = null;
  for (const landmark of data.landmarks) {
    const d = haversineMeters({ lat: latitude, lng: longitude }, ll(landmark.point));
    if (d <= withinM && (!best || d < best.d)) best = { d, name: landmark.name };
  }
  return best ? { name: best.name, metres: Math.round(best.d) } : null;
}

module.exports = {
  places: data,
  findStreet,
  findPlaces,
  describeStreet,
  connectRule,
  pointsAlongStreet,
  nearestLandmark,
  streetAt,
};
