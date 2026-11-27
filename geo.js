"use strict";

/**
 * Geodesy on node coordinates.
 *
 * All coordinates in Smart Checkpoints are WGS84 latitude/longitude, always.
 * Distances are always metres. This module is the only place the server does
 * arithmetic on coordinates; it never touches route geometry, which is a
 * driver concern.
 *
 * `console/src/lib/geo.ts` is the browser copy of this file. It is fifteen
 * lines of maths and duplicating it is cheaper than a build step; keep the two
 * in sync by hand.
 */

const EARTH_RADIUS_M = 6371000;
const DEG = Math.PI / 180;

// Local tangent-plane projection. Accurate to well under a metre across a
// city, which is the only scale this system operates at.
function makeProjection(originLat, originLng) {
  const cosLat0 = Math.cos(originLat * DEG);
  return {
    // -> metres east, and metres north flipped so north is up on screen
    project(lat, lng) {
      return {
        x: EARTH_RADIUS_M * (lng - originLng) * DEG * cosLat0,
        y: -EARTH_RADIUS_M * (lat - originLat) * DEG,
      };
    },
    unproject(x, y) {
      return {
        lat: originLat - y / (EARTH_RADIUS_M * DEG),
        lng: originLng + x / (EARTH_RADIUS_M * DEG * cosLat0),
      };
    },
  };
}

function haversineMeters(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Coerces a request-body value to a coordinate, returning NaN for anything
 * that is not really a number.
 *
 * `Number()` alone is not enough: it maps null, "", [] and false to 0, which
 * is a valid-looking position in the Atlantic. A missing coordinate must fail
 * the range check, not silently become Null Island.
 */
function parseCoordinate(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

/**
 * True when the pair is a usable WGS84 position: both finite, latitude within
 * +/-90 and longitude within +/-180.
 */
function isValidLatLng(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/**
 * Where point `p` lies relative to the straight segment from `a` to `b`:
 * `distance` is metres from p to the nearest point of the segment, and `t`
 * how far along it that point is, 0 at a and 1 at b. All three are
 * { lat, lng }. Flat projection around a, which is exact enough for the few
 * kilometres an edge spans.
 */
function segmentOffsetMeters(p, a, b) {
  const proj = makeProjection(a.lat, a.lng);
  const P = proj.project(p.lat, p.lng);
  const B = proj.project(b.lat, b.lng);
  const len2 = B.x * B.x + B.y * B.y;
  const raw = len2 === 0 ? 0 : (P.x * B.x + P.y * B.y) / len2;
  const t = Math.max(0, Math.min(1, raw));
  return { distance: Math.hypot(P.x - t * B.x, P.y - t * B.y), t: raw };
}

module.exports = {
  EARTH_RADIUS_M,
  makeProjection,
  haversineMeters,
  segmentOffsetMeters,
  parseCoordinate,
  isValidLatLng,
};
