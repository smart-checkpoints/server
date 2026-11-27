"use strict";

/**
 * Sayes's PDF reports: the network, its violations over a period and its
 * data-quality flags, written server-side and kept in memory for an hour for
 * the console to download.
 *
 * Plates are personal data. A report lists them only when the operator
 * explicitly asked; otherwise it gives counts and speeds per edge.
 */

const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const places = require("./places");

const KEEP_MS = 60 * 60 * 1000;
const MAX_KEPT = 30;
const reports = new Map(); // id -> { projectId, title, filename, buffer, at }

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, r] of reports) if (r.at < cutoff) reports.delete(id);
  while (reports.size > MAX_KEPT) reports.delete(reports.keys().next().value);
}

function getReport(projectId, id) {
  prune();
  const r = reports.get(id);
  return r && r.projectId === projectId ? r : null;
}

// The built-in PDF fonts have no "→", so edges are written "1 › 2".
const INK = "#1e2628";
const DIM = "#6b7679";
const RULE = "#dde3e5";

/** Builds the report from what the REST API returns. Resolves to { id, title, filename, pages }. */
async function buildReport(api, projectId, { title, days, includePlates, notes }) {
  const [nodes, edges, violations, diagnostics, driver] = await Promise.all([
    api.getNodes(),
    api.getConnections(),
    api.getViolations(),
    api.getDiagnostics().catch(() => null),
    api.getDistanceDriverStatus().catch(() => ({ connected: false })),
  ]);
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const inWindow = violations.filter((v) => new Date(v.timestamp) >= from);
  const camera = new Map(nodes.map((n) => [n.node_id, n]));
  const cam = (id) => (camera.get(id) ? camera.get(id).id_in_project : "?");
  const streetOf = (edge) => {
    const n = camera.get(edge.from_node_id);
    return (n && places.streetAt(n.latitude, n.longitude)) || "";
  };

  const perEdge = edges
    .map((edge) => {
      const list = inWindow.filter((v) => v.connection_id === edge.connection_id);
      const speeds = list.map((v) => v.car_speed);
      return {
        edge,
        count: list.length,
        max: speeds.length ? Math.round(Math.max(...speeds)) : null,
        mean: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
      };
    })
    .sort((a, b) => b.count - a.count);

  const flagged = diagnostics
    ? (diagnostics.connections || []).filter((c) => c.flags && c.flags.length).map((c) => ({ id: c.connection_id, flags: c.flags.map((f) => f.type || f) }))
    : [];
  const flaggedNodes = diagnostics
    ? (diagnostics.nodes || []).filter((n) => n.flags && n.flags.length).map((n) => ({ id: n.node_id, flags: n.flags.map((f) => f.type || f) }))
    : [];

  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: { Title: title, Author: "Smart Checkpoints · Sayes" } });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", resolve));
  const width = doc.page.width - 100;

  const heading = (text) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(1.2).font("Helvetica-Bold").fontSize(13).fillColor(INK).text(text);
    doc.moveTo(50, doc.y + 3).lineTo(50 + width, doc.y + 3).strokeColor(RULE).lineWidth(1).stroke();
    doc.moveDown(0.6);
  };
  const para = (text, color = INK) => doc.font("Helvetica").fontSize(10).fillColor(color).text(text, { width });

  /** A simple table: columns are [label, width fraction, align]. */
  const table = (columns, rows) => {
    const xs = [];
    let x = 50;
    for (const [, frac] of columns) {
      xs.push(x);
      x += frac * width;
    }
    const row = (cells, bold) => {
      if (doc.y > doc.page.height - 70) doc.addPage();
      const y = doc.y;
      let h = 0;
      cells.forEach((cell, i) => {
        const [, frac, align] = columns[i];
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(bold ? DIM : INK);
        const opts = { width: frac * width - 6, align: align || "left" };
        doc.text(String(cell ?? ""), xs[i], y, opts);
        h = Math.max(h, doc.heightOfString(String(cell ?? ""), opts));
      });
      doc.x = 50;
      doc.y = y + h + 5;
    };
    row(columns.map(([label]) => label), true);
    for (const r of rows) row(r, false);
    doc.x = 50;
  };

  // Title block
  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(title, { width });
  doc.moveDown(0.3);
  para(
    `Generated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC by Sayes. Violations from the last ${days} day${days === 1 ? "" : "s"} (since ${from.toISOString().slice(0, 10)}).`,
    DIM,
  );
  if (notes) {
    doc.moveDown(0.5);
    para(notes);
  }

  heading("Summary");
  const measured = edges.filter((e) => e.distance_status === "ok").length;
  table(
    [["Figure", 0.6], ["Value", 0.4, "right"]],
    [
      ["Cameras", nodes.length],
      ["Edges", edges.length],
      ["Edges measured and enforcing", `${measured} of ${edges.length}`],
      ["Distance driver connected", driver && driver.connected ? "yes" : "no"],
      [`Violations, last ${days} days`, inWindow.length],
      ["Violations, all time", violations.length],
      ["Data-quality flags", flagged.length + flaggedNodes.length],
    ],
  );

  heading(`Violations by edge, last ${days} days`);
  const withViolations = perEdge.filter((p) => p.count > 0);
  if (withViolations.length === 0) para("No violations in this period.", DIM);
  else {
    table(
      [["Edge", 0.16], ["Street", 0.38], ["Limit", 0.12, "right"], ["Violations", 0.12, "right"], ["Fastest", 0.11, "right"], ["Mean", 0.11, "right"]],
      withViolations.map((p) => [
        `${cam(p.edge.from_node_id)} › ${cam(p.edge.to_node_id)}`,
        streetOf(p.edge),
        `${p.edge.speed_limit} km/h`,
        p.count,
        `${p.max} km/h`,
        `${p.mean} km/h`,
      ]),
    );
  }

  heading("Network");
  table(
    [["Edge", 0.16], ["Street", 0.4], ["Limit", 0.14, "right"], ["Distance", 0.15, "right"], ["Status", 0.15, "right"]],
    edges.map((e) => [
      `${cam(e.from_node_id)} › ${cam(e.to_node_id)}`,
      streetOf(e),
      `${e.speed_limit} km/h`,
      e.distance == null ? "—" : `${Math.round(e.distance)} m`,
      e.distance_status === "ok" ? "measured" : e.distance_status === "no-route" ? "no route" : "not measured",
    ]),
  );

  heading("Data quality");
  if (!diagnostics) para("The quality check could not be run.", DIM);
  else if (flagged.length + flaggedNodes.length === 0) para("No flags: every camera and edge passed the quality check.", DIM);
  else {
    const byId = new Map(edges.map((e) => [e.connection_id, e]));
    table(
      [["Item", 0.3], ["Flags", 0.7]],
      [
        ...flagged.map((f) => {
          const e = byId.get(f.id);
          return [e ? `Edge ${cam(e.from_node_id)} › ${cam(e.to_node_id)}` : `Edge ${f.id}`, f.flags.join(", ")];
        }),
        ...flaggedNodes.map((n) => [`Camera ${cam(n.id)}`, n.flags.join(", ")]),
      ],
    );
  }

  if (includePlates) {
    heading(`Violation records, last ${days} days`);
    para("Included at the operator's request. Plates are personal data: handle this page accordingly.", DIM);
    doc.moveDown(0.4);
    const byId = new Map(edges.map((e) => [e.connection_id, e]));
    const rows = [...inWindow]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 500)
      .map((v) => {
        const e = byId.get(v.connection_id);
        return [
          v.timestamp.slice(0, 16).replace("T", " "),
          e ? `${cam(e.from_node_id)} › ${cam(e.to_node_id)}` : "—",
          v.car_plate,
          `${Math.round(v.car_speed)} km/h`,
          e ? `${e.speed_limit} km/h` : "—",
        ];
      });
    table([["Time (UTC)", 0.26], ["Edge", 0.16], ["Plate", 0.24], ["Speed", 0.17, "right"], ["Limit", 0.17, "right"]], rows);
  }

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // The footer sits in the bottom margin; without this PDFKit would start a
    // new page for it.
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor(DIM).text(`Smart Checkpoints · ${title} · page ${i + 1} of ${range.count}`, 50, doc.page.height - 35, {
      width,
      align: "center",
      lineBreak: false,
    });
  }
  doc.end();
  await done;

  prune();
  const id = crypto.randomUUID();
  const filename = `${title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "report"}-${now.toISOString().slice(0, 10)}.pdf`;
  reports.set(id, { projectId, title, filename, buffer: Buffer.concat(chunks), at: Date.now() });
  return { id, title, filename, pages: range.count };
}

module.exports = { buildReport, getReport };
