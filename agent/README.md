# Dispatch

The Smart Checkpoints agent. An operator describes what they want in the
console's Dispatch panel; the agent configures the checkpoint network by
calling this server's own REST API over loopback, and streams every step to
the console (Server-Sent Events) so it can be shown as cursors on the map.

- `index.js` the routes: `GET /project/:id/agent`, `POST …/agent/runs`
  (SSE), `POST …/runs/:runId/confirm`, `POST …/runs/:runId/cancel`,
  `GET …/agent/audit`
- `runner.js` the Messages API loop, limits, confirmations, audit rows
- `tools.js` the tools; forbidden actions have no tool at all
- `prompt.js` the system prompt
- `places/` the demo place list, snapped to roads with OSRM (`build.js`)
- `demo/seed.js` resets and seeds the demo project: `npm run demo:1|2|3`
- `demo/mock-anthropic.js` a scripted stand-in for the Messages API

Configuration is in `.env.example` under "Dispatch agent".

To rehearse without an API key, run `node agent/demo/mock-anthropic.js` and start the server with `ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:3199 npm start`; the mock only answers messages starting with BUILD, MOVE or VIOL.
