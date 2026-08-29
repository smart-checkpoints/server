/**
 * Every number the operator reads passes through here.
 *
 * Distances are metres and speeds are km/h everywhere in the system. The
 * REST API, the driver protocol and the database all agree on that, so the
 * only job left is presenting them the same way on every surface.
 */

/** Metres under a kilometre, kilometres to one decimal above it. */
export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) {
    return "-";
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatSpeed(kmh: number | null | undefined): string {
  if (kmh === null || kmh === undefined || !Number.isFinite(kmh)) return "-";
  return `${Math.round(kmh)} km/h`;
}

/**
 * Parses a timestamp from the server.
 *
 * Everything written from now on is ISO 8601 UTC. Databases created before
 * that also hold violation timestamps as epoch milliseconds stringified by
 * SQLite, such as "1787905380236.0", which `new Date()` reads as invalid.
 * Those rows are real enforcement records, so they are read rather than shown
 * as a dash.
 */
function parseTimestamp(timestamp: string | number | Date): Date | null {
  if (typeof timestamp === "string" && /^\d+(\.\d+)?$/.test(timestamp)) {
    return new Date(Number(timestamp));
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A calendar date. Used where the day matters and the second does not. */
export function formatDate(timestamp: string | number | Date): string {
  const date = parseTimestamp(timestamp);
  if (!date) return "-";
  return date.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Wall-clock time, 24 hour, to the second: violations are read as a sequence. */
export function formatTime(timestamp: string | number | Date): string {
  const date = parseTimestamp(timestamp);
  if (!date) return "-";
  return date.toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "1 node", "4 nodes". Counts are read at a glance, so they read as English. */
export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/**
 * An API key is a bearer credential. Anywhere it is shown next to other data
 * it is shown masked, and revealing it is a deliberate act.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}
