import path from "node:path";
import type { NextConfig } from "next";

/**
 * The console ships as a static site.
 *
 * `next build` writes plain HTML/CSS/JS into `out/`, which the server repo's
 * build step copies into `server/public` for Express to serve. Nothing here
 * runs on a Next.js server: every page talks to the Smart Checkpoints REST
 * API and Socket.IO channel from the browser, on the same origin.
 */
const nextConfig: NextConfig = {
  output: "export",

  // Static export has no image optimiser behind it.
  images: { unoptimized: true },

  // `/project` and `/admin` become directories with an index.html, which is
  // what `express.static` resolves without any rewrite rules.
  trailingSlash: true,

  // Pin the workspace root here. Without it Turbopack walks up looking for a
  // lockfile and can settle on the server repo's own package-lock.json.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
