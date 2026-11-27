# Sayes

The Smart Checkpoints agent. An operator describes what they want in the
console's Sayes panel; the agent configures the checkpoint network by
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

Configuration is in `.env.example` under "Sayes agent".

## The cursors

Each call with a target gets a `lead_ms` in `tool.started`: when the server
will send it. Calls made together take turns, `AGENT_CURSOR_GAP_MS` apart by
lane, and the gap shrinks with each batch of a run (`…_GAP_DECAY`, down to
`…_GAP_MIN_MS`), so a run starts calm and gets busier. `tool.finished` carries
`sent_after_ms` so the console can check its clicks landed on time.

The console side is `console/src/components/console/agent/cursors/`:
`director.ts` choreographs a cast of up to five cursors (Tram, Taxi, Microbus,
Metro, Tuk-tuk) from those events, planning every click backwards from
`lead_ms`. The shapes in `shapes.ts` are traced from the Vision Cursor Black set
by `console/scripts/trace-cursors.mjs`. Every number they move by is in
`tuning.ts`. The **Cursor Lab** (Alt+Shift+C, or `?cursorlab`) edits them live
in the browser, replays the last run in slow motion, shows the click-to-send
timing, and copies the result as code.

To rehearse without an API key, run `node agent/demo/mock-anthropic.js` and start the server with `ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:3199 npm start`; the mock only answers messages starting with BUILD, MOVE, VIOL or LANES (five cursors at once).
