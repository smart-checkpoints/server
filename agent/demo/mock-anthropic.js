// A scripted stand-in for POST /v1/messages (streaming), to exercise the agent
// loop and the console without an API key or credits. It only understands
// messages that start with BUILD, MOVE, VIOL, LANES, LIMIT or BAD; anything else gets
// "Hello.". Optional first argument: a file to log each request's settings to.
//
//   node agent/demo/mock-anthropic.js [log-file]   (listens on 127.0.0.1:3199)
const http = require("http");
const fs = require("fs");
const LOG = process.argv[2];

let n = 0;
function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function message(blocks, stopReason) {
  n += 1;
  const events = [
    { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 80 } } },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
    } else if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${n}_${index}`, name: b.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } });
  events.push({ type: "message_stop" });
  return events;
}

const lastResults = (messages) => {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return [];
  return last.content.filter((c) => c.type === "tool_result").map((c) => ({ ...c, data: JSON.parse(c.content) }));
};

function script(body) {
  const msgs = body.messages;
  const firstUser = typeof msgs[msgs.length - 1].content === "string" ? msgs[msgs.length - 1].content : null;
  const results = lastResults(msgs);
  const userTexts = msgs.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content);
  const current = userTexts[userTexts.length - 1];

  if (current.startsWith("BUILD")) {
    if (firstUser) return message([{ type: "thinking", thinking: "Placing three checkpoints on the Corniche." }, { type: "tool_use", name: "points_along_street", input: { street: "El Geish Road", count: 3 } }], "tool_use");
    const tool = results[0] && results[0].data;
    if (tool && tool.points) {
      return message(tool.points.map((p) => ({ type: "tool_use", name: "create_checkpoint", input: { latitude: p.latitude, longitude: p.longitude } })), "tool_use");
    }
    if (results.length === 3 && results.every((r) => r.data.node_id)) {
      // Divided road: neighbours in the order given, forward only.
      const ids = results.map((r) => r.data.node_id);
      const pairs = [[ids[0], ids[1]], [ids[1], ids[2]]];
      return message(pairs.map(([a, b]) => ({ type: "tool_use", name: "create_edge", input: { from_node_id: a, to_node_id: b, speed_limit_kmh: 50 } })), "tool_use");
    }
    if (results.length === 2 && results.every((r) => r.data.connection_id)) {
      return message([{ type: "tool_use", name: "get_diagnostics", input: {} }], "tool_use");
    }
    return message([{ type: "text", text: "Done: three cameras on the Corniche, connected eastbound at 50 km/h." }], "end_turn");
  }
  if (current.startsWith("LANES")) {
    // Five checkpoints at once: one cursor in each of the five lanes.
    if (firstUser) return message([{ type: "tool_use", name: "points_along_street", input: { street: "Abu Qir Street", count: 5 } }], "tool_use");
    const tool = results[0] && results[0].data;
    if (tool && tool.points) return message(tool.points.map((p) => ({ type: "tool_use", name: "create_checkpoint", input: { latitude: p.latitude, longitude: p.longitude } })), "tool_use");
    return message([{ type: "text", text: "Placed five cameras along Abu Qir Street." }], "end_turn");
  }
  if (current.startsWith("MOVE")) {
    if (firstUser) return message([{ type: "tool_use", name: "get_network", input: {} }], "tool_use");
    const tool = results[0] && results[0].data;
    if (tool && tool.checkpoints) return message([{ type: "tool_use", name: "move_checkpoint_by", input: { node_id: tool.checkpoints[1].node_id, east_m: 200, north_m: 0 } }], "tool_use");
    if (tool && tool.edges_being_remeasured) return message([{ type: "tool_use", name: "await_remeasure", input: { connection_ids: tool.edges_being_remeasured, timeout_s: 20 } }], "tool_use");
    if (tool && tool.declined) return message([{ type: "text", text: "OK, I left it where it is." }], "end_turn");
    return message([{ type: "text", text: "Moved camera 1 by 200 m east; its edges are re-measured." }], "end_turn");
  }
  if (current.startsWith("VIOL")) {
    if (firstUser) return message([{ type: "tool_use", name: "get_network", input: {} }, { type: "tool_use", name: "get_violation_summary", input: { days: 7 } }], "tool_use");
    const net = results.find((r) => r.data.edges && r.data.checkpoints);
    if (net) return message([{ type: "tool_use", name: "highlight", input: { connection_ids: net.data.edges.map((e) => e.connection_id), node_ids: [], caption: "Most violations this week" } }], "tool_use");
    return message([{ type: "text", text: "These edges had the most violations this week." }], "end_turn");
  }
  if (current.startsWith("LIMIT")) {
    if (firstUser || results.length) return message([{ type: "tool_use", name: "get_driver_status", input: {} }, { type: "tool_use", name: "find_place", input: { query: "Sidi Gaber" } }, { type: "tool_use", name: "get_violation_summary", input: { days: 7 } }, { type: "tool_use", name: "highlight", input: { connection_ids: [1], node_ids: [], caption: "top edge" } }], "tool_use");
  }
  if (current.startsWith("BAD")) {
    if (firstUser) return message([{ type: "tool_use", name: "create_edge", input: { from_node_id: 1, to_node_id: 1, speed_limit_kmh: 50 } }, { type: "tool_use", name: "delete_edge", input: { connection_id: 1 } }, { type: "tool_use", name: "set_speed_limit", input: { connection_id: 9999, speed_limit_kmh: 60 } }], "tool_use");
    return message([{ type: "text", text: "Those did not work." }], "end_turn");
  }
  return message([{ type: "text", text: "Hello." }], "end_turn");
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (LOG) fs.appendFileSync(LOG, JSON.stringify({
        url: req.url,
        beta: req.headers["anthropic-beta"],
        model: body.model, thinking: body.thinking, output_config: body.output_config, fallbacks: body.fallbacks,
        cache_control: body.cache_control, tools: body.tools.map((t) => `${t.name}${t.strict ? "*" : ""}`).join(","),
        messages: body.messages.length,
      }) + "\n");
      sse(res, script(body));
    });
  })
  .listen(3199, "127.0.0.1", () => console.log("mock on 3199"));
