"use strict";

/**
 * Where the console build lives, and how to tell whether it is really there.
 *
 * `public/` is generated: it is the static export of the Next.js app in
 * `console/`, and it is not in version control for the same reason
 * `node_modules` is not. The server, the build script and the start-up check
 * all need to agree on what a finished build looks like, so they agree here
 * rather than each keeping its own idea of it.
 */
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const consoleDir = path.join(rootDir, "console");
const exportDir = path.join(consoleDir, "out");
const publicDir = path.join(rootDir, "public");

/**
 * The entries a finished export always contains.
 *
 * An index.html on its own is not enough to call it built. A half-copied or
 * stale directory has one, and then every page loads with no stylesheet and no
 * script, which looks like a bug in the console rather than a missing build.
 */
const REQUIRED_ENTRIES = [
  "index.html",
  "_next",
  path.join("project", "index.html"),
  path.join("admin", "index.html"),
];

const NOT_BUILT_MESSAGE =
  "The Smart Checkpoints console has not been built.\n\n" +
  "Run this in the server directory, then reload:\n\n" +
  "    npm run build\n\n" +
  "public/ is generated from console/ and is not in version control, so a\n" +
  "fresh clone has to build it once. The REST API and both realtime channels\n" +
  "work without it; only these pages are missing.\n";

/** @returns {{ built: boolean, missing: string[] }} */
function detectConsoleBuild() {
  const missing = REQUIRED_ENTRIES.filter(
    (entry) => !fs.existsSync(path.join(publicDir, entry)),
  );
  return { built: missing.length === 0, missing };
}

module.exports = {
  rootDir,
  consoleDir,
  exportDir,
  publicDir,
  REQUIRED_ENTRIES,
  NOT_BUILT_MESSAGE,
  detectConsoleBuild,
};
