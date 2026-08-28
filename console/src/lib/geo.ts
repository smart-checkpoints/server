/**
 * Geodesy, shared with `server/geo.js`.
 *
 * All coordinates are WGS84 latitude/longitude in degrees, always. All
 * distances are metres, always. The server, this console and every distance
 * driver use the same two sentences, so keep this file in step with the
 * server copy rather than growing a second convention here.
 */
export const EARTH_RADIUS_M = 6371000;

const DEG = Math.PI / 180;

export type LatLng = { lat: number; lng: number };
export type Point = { x: number; y: number };

export type Projection = {
  /** Degrees to metres east, and metres north flipped so north is up. */
  project(lat: number, lng: number): Point;
  unproject(x: number, y: number): LatLng;
};

/**
 * Local tangent-plane projection. Accurate to well under a metre across a
 * city, which is the only scale this system operates at.
 */
export function makeProjection(originLat: number, originLng: number): Projection {
  const cosLat0 = Math.cos(originLat * DEG);
  return {
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

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * `Number()` alone maps null, "", [] and false to 0, which is a valid-looking
 * position in the Atlantic. A missing coordinate must fail the range check
 * rather than silently become Null Island.
 */
export function parseCoordinate(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

export function isValidLatLng(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}
