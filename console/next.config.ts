import path from "node:path";
import type { NextConfig } from "next";

/**
 * The console ships as a static site.
 *
 * `next build` writes the site into `out/`, and the server's Express process
 * serves that directory where it stands. Nothing here runs on a Next.js
 * server: every page talks to the Smart Checkpoints REST API and Socket.IO
 * channel from the browser, on the same origin.
 */
const nextConfig: NextConfig = {
  output: "export",

  // Static export has no image optimiser behind it.
  images: { unoptimized: true },

  // `/project` and `/admin` become directories with an index.html, which is
  // what `express.static` resolves without any rewrite rules.
  trailingSlash: true,

  // The console is an npm workspace of the server package, so its dependencies
  // are hoisted into the server's node_modules. That directory is the workspace
  // root, and Turbopack has to be told so or it will not resolve `next` at all.
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
