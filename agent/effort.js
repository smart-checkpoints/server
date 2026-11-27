"use strict";

/**
 * How hard the model works on one request: the API's `effort` setting.
 *
 * The operator can pick Low, Medium or High, or leave it on Auto, which
 * decides per request from the words and the attachments, here, in a few
 * microseconds: no extra model call. Lower effort answers sooner; higher
 * effort thinks longer between tool calls.
 *
 *   high    research, planning, reports, documents to read, long requests
 *   medium  building or editing the network, imports, restores
 *   low     questions, look-ups and showing things
 *
 * When a request does two kinds of thing, the higher one wins. A request
 * nothing matches gets medium: guessing low on something unclear costs more
 * than a little extra time.
 */

const HIGH = [
  /\breport\b|\bpdf\b|\bsummar|\banaly[sz]|\bcompar|\brecommend|\bsuggest|\bplan\b|\bplanning\b|\bstrateg/i,
  /\bresearch|\bsearch the web|\blook (it )?up online|\bweb\b|\blaw\b|\blegal\b|\bregulation|\bstud(y|ies)\b/i,
  /\bwhy\b|\bwhere should\b|\bwhat would\b|\bhow should\b|\bbest (place|way|spot)|\boptimi[sz]/i,
  /تقرير|تحليل|اقترح|خطة|قانون/,
];
const MEDIUM = [
  /\badd\b|\bplace\b|\bput\b|\bcreate\b|\bset ?up\b|\binstall\b|\bconnect\b|\blink\b|\bjoin\b/i,
  /\bmove\b|\bmoved\b|\bshift\b|\brelocat|\bdelete\b|\bremove\b|\bclear\b|\bretire\b|\bwipe\b/i,
  /\bset\b|\bchange\b|\blower\b|\braise\b|\bincrease\b|\bdecrease\b|\blimit\b|\bsplit\b/i,
  /\bimport\b|\bundo\b|\brestore\b|\bbring (it |them )?back\b|\bput (it |them )?back\b|\bfix\b|\bupdate\b/i,
  /أضف|ضع|احذف|امسح|انقل|غير|اربط|حدد/,
];
const LOW = [
  /^(which|what|how many|how much|where|when|who|is|are|does|do|show|list|count|tell me|give me|open|frame|zoom|switch|highlight)\b/i,
  /\?\s*$/,
  /^(كم|ما|ماذا|أين|اعرض|أظهر)/,
];

/**
 * @param {string} message the operator's words
 * @param {{ kind: string }[]} attachments what came with them
 * @param {"auto"|"low"|"medium"|"high"} chosen the operator's setting
 * @returns {{ level: "low"|"medium"|"high", chosen: string, reason: string }}
 */
function pickEffort(message, attachments, chosen) {
  if (chosen === "low" || chosen === "medium" || chosen === "high") {
    return { level: chosen, chosen, reason: "chosen by the operator" };
  }
  const text = String(message || "").trim();
  const kinds = new Set((attachments || []).map((a) => a.kind));
  if (kinds.has("pdf") || kinds.has("image")) return { level: "high", chosen: "auto", reason: "a document or image to read" };
  if (HIGH.some((re) => re.test(text))) return { level: "high", chosen: "auto", reason: "research, planning or a report" };
  if (text.length > 400) return { level: "high", chosen: "auto", reason: "a long, multi-part request" };
  if (kinds.has("csv")) return { level: "medium", chosen: "auto", reason: "an import" };
  if (MEDIUM.some((re) => re.test(text))) return { level: "medium", chosen: "auto", reason: "building or editing the network" };
  if (LOW.some((re) => re.test(text))) return { level: "low", chosen: "auto", reason: "a question or look-up" };
  return { level: "medium", chosen: "auto", reason: "not clearly a question" };
}

module.exports = { pickEffort };
