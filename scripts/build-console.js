#!/usr/bin/env node
"use strict";

/**
 * Builds the operator console and installs it as the server's static root.
 *
 * The console is a Next.js app in `console/`, exported to plain HTML, CSS and
 * JavaScript. Nothing about it runs on a Next.js server: every page talks to
 * this server's REST API and Socket.IO channel from the browser, on the same
 * origin. This script runs that export and copies the result into `public/`,
 * which is the directory `server.js` hands to `express.static`.
 *
 * `public/` is generated, and is in .gitignore for the same reason
 * `node_modules` is. Run `npm run build` after cloning, and after any change
 * under `console/`.
 */
const { existsSync, rmSync, cpSync, mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const consoleDir = path.join(root, "console");
const exportDir = path.join(consoleDir, "out");
const publicDir = path.join(root, "public");

/**
 * Runs one npm command in a directory.
 *
 * npm is a shell script on POSIX and a .cmd shim on Windows, and recent Node
 * refuses to spawn a .cmd without a shell at all. So the command is handed
 * over as a single string for the shell to parse. Every caller below passes a
 * fixed literal; nothing here interpolates anything a user typed.
 */
function run(command, cwd) {
  const result = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (result.error) {
    console.error(`Could not run "${command}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

if (!existsSync(path.join(consoleDir, "node_modules"))) {
  console.log("Installing console dependencies...");
  run("npm install", consoleDir);
}

console.log("Building the console...");
run("npm run build", consoleDir);

if (!existsSync(exportDir)) {
  console.error(
    `The console build produced no export at ${exportDir}. ` +
      'Check that console/next.config.ts still sets output: "export".',
  );
  process.exit(1);
}

// Replace rather than merge: a file deleted from the console must not survive
// in public/ and keep being served.
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
cpSync(exportDir, publicDir, { recursive: true });

console.log(`Console installed at ${publicDir}`);
