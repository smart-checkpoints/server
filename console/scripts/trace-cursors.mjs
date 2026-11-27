#!/usr/bin/env node
/**
 * Traces the Vision Cursor Black cursor set into vector shapes for the Sayes
 * cursors, so they can be recoloured, rotated, skewed and morphed without
 * the blur a bitmap would get.
 *
 *   node console/scripts/trace-cursors.mjs [cursor-dir] [--sheet file.html]
 *
 * Reads the 128px frame of each .cur, takes the navy body (the white outline
 * and the shadow are drawn by the console), follows its edge with marching
 * squares at sub-pixel precision, simplifies it, and writes
 * src/components/console/agent/cursors/shapes.ts. That file is committed: the
 * build never needs the cursor files. --sheet also writes a page that shows
 * each original bitmap beside its traced shape, to check the tracing by eye.
 *
 * No dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const sheetAt = args.indexOf("--sheet");
const sheetPath = sheetAt >= 0 ? args[sheetAt + 1] : null;
const positional = args.filter((a, i) => !a.startsWith("--") && i !== sheetAt + 1);
const dir = positional[0] ?? "C:\\Windows\\Cursors\\vision cursor black";
const out = path.join(here, "..", "src", "components", "console", "agent", "cursors", "shapes.ts");

/** Glyph name -> file. */
const FILES = {
  pointer: "pointer.cur",
  link: "link.cur",
  cross: "cross.cur",
  move: "move.cur",
  pen: "handwriting.cur",
  help: "help.cur",
  unavailable: "unavailiable.cur",
  pin: "pin.cur",
};

/** Glyph units are pixels of the 32px cursor, the size the OS draws. */
const UNIT = 32;

/* -------------------------------------------------------------------------
   Reading a .cur
   ------------------------------------------------------------------------- */

function readCursor(file) {
  const d = fs.readFileSync(file);
  const count = d.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const e = 6 + 16 * i;
    const w = d[e] || 256;
    const h = d[e + 1] || 256;
    const entry = { w, h, hx: d.readUInt16LE(e + 4), hy: d.readUInt16LE(e + 6), offset: d.readUInt32LE(e + 12) };
    if (!best || w > best.w) best = entry;
  }
  const { w, h, offset } = best;
  if (d.readUInt16LE(offset + 14) !== 32) throw new Error(`${file}: only 32-bit frames are supported`);
  const pixels = offset + d.readUInt32LE(offset);
  // Bottom-up BGRA rows; the AND mask after them is ignored (alpha is real).
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const s = pixels + ((h - 1 - y) * w + x) * 4;
      const t = (y * w + x) * 4;
      rgba[t] = d[s + 2];
      rgba[t + 1] = d[s + 1];
      rgba[t + 2] = d[s];
      rgba[t + 3] = d[s + 3];
    }
  }
  return { w, h, hx: best.hx, hy: best.hy, rgba };
}

/* -------------------------------------------------------------------------
   Fields: how much each pixel is body, and how much it is cursor at all
   ------------------------------------------------------------------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function bodyField({ w, h, rgba }) {
  const f = new Float32Array((w + 2) * (h + 2));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      // Navy is about 27, the outline 255. The shadow is dark too, but
      // faint: opacity keeps it out of the body.
      const dark = clamp((255 - lum) / (255 - 27), 0, 1);
      const solid = clamp((rgba[i + 3] - 160) / 60, 0, 1);
      f[(y + 1) * (w + 2) + x + 1] = dark * solid;
    }
  }
  return { f, w: w + 2, h: h + 2 };
}

function alphaField({ w, h, rgba }) {
  const f = new Float32Array((w + 2) * (h + 2));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      // The outline is white; the shadow is dark and faint. Count only the
      // light, or the solid.
      f[(y + 1) * (w + 2) + x + 1] = rgba[i + 3] > 200 || lum > 200 ? rgba[i + 3] / 255 : 0;
    }
  }
  return { f, w: w + 2, h: h + 2 };
}

/* -------------------------------------------------------------------------
   Marching squares, linked into closed loops
   ------------------------------------------------------------------------- */

function contours({ f, w, h }, iso = 0.5) {
  const at = (x, y) => f[y * w + x];
  const lerp = (a, b) => (iso - a) / (b - a);
  // Edge keys: "h x y" is the edge from (x,y) to (x+1,y); "v x y" from (x,y) to (x,y+1).
  const point = new Map();
  const links = new Map();
  const edgePoint = (key, x, y, horizontal) => {
    if (!point.has(key)) {
      const t = horizontal ? lerp(at(x, y), at(x + 1, y)) : lerp(at(x, y), at(x, y + 1));
      point.set(key, horizontal ? [x + t, y] : [x, y + t]);
    }
    return key;
  };
  const link = (a, b) => {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a).push(b);
    links.get(b).push(a);
  };

  for (let y = 0; y < h - 1; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const a = at(x, y) > iso;
      const b = at(x + 1, y) > iso;
      const c = at(x + 1, y + 1) > iso;
      const d = at(x, y + 1) > iso;
      const code = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = () => edgePoint(`h ${x} ${y}`, x, y, true);
      const B = () => edgePoint(`h ${x} ${y + 1}`, x, y + 1, true);
      const L = () => edgePoint(`v ${x} ${y}`, x, y, false);
      const R = () => edgePoint(`v ${x + 1} ${y}`, x + 1, y, false);
      const centre = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 > iso;
      switch (code) {
        case 1: case 14: link(L(), B()); break;
        case 2: case 13: link(B(), R()); break;
        case 3: case 12: link(L(), R()); break;
        case 4: case 11: link(T(), R()); break;
        case 6: case 9: link(T(), B()); break;
        case 7: case 8: link(L(), T()); break;
        case 5:
          if (centre) { link(L(), T()); link(B(), R()); } else { link(L(), B()); link(T(), R()); }
          break;
        case 10:
          if (centre) { link(L(), B()); link(T(), R()); } else { link(L(), T()); link(B(), R()); }
          break;
      }
    }
  }

  const seen = new Set();
  const loops = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = null;
    let cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      loop.push(point.get(cur).map((v) => v - 1)); // undo the padding
      const next = links.get(cur).find((k) => k !== prev && !seen.has(k));
      prev = cur;
      cur = next;
    }
    if (loop.length >= 8) loops.push(loop);
  }
  return loops;
}

const area = (ring) => {
  let s = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
};

function inside(pt, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Ramer-Douglas-Peucker on a closed ring. */
function simplify(ring, eps) {
  const n = ring.length;
  // Split at the two points furthest apart so both halves are open polylines.
  let far = 0;
  let farD = -1;
  for (let i = 0; i < n; i += 1) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) (farD = d), (far = i);
  }
  const rdp = (pts) => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0];
    const [bx, by] = pts[pts.length - 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = 0;
    let index = 0;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > worst) (worst = d), (index = i);
    }
    if (worst <= eps) return [pts[0], pts[pts.length - 1]];
    return [...rdp(pts.slice(0, index + 1)).slice(0, -1), ...rdp(pts.slice(index))];
  };
  const a = rdp(ring.slice(0, far + 1));
  const b = rdp([...ring.slice(far), ring[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Groups loops into parts: outer boundaries with the holes inside them. */
function parts(loops) {
  const withArea = loops.map((ring) => ({ ring, a: area(ring) }));
  const biggest = withArea.reduce((m, l) => (Math.abs(l.a) > Math.abs(m.a) ? l : m), withArea[0]);
  const outerSign = Math.sign(biggest.a);
  // Outer rings and holes come out of the tracer with opposite windings.
  const outers = withArea.filter((l) => Math.sign(l.a) === outerSign).map((l) => ({ outer: l.ring, holes: [] }));
  for (const l of withArea.filter((x) => Math.sign(x.a) !== outerSign)) {
    const owner = outers.find((o) => inside(l.ring[0], o.outer));
    if (owner) owner.holes.push(l.ring);
  }
  return outers;
}

/** Median distance from each body-edge point to the nearest edge of the whole cursor. */
function outlineWidth(body, whole) {
  const pts = whole.flat();
  const ds = [];
  for (const ring of body) {
    for (let i = 0; i < ring.length; i += 4) {
      let best = Infinity;
      for (const q of pts) best = Math.min(best, Math.hypot(q[0] - ring[i][0], q[1] - ring[i][1]));
      ds.push(best);
    }
  }
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)];
}

/* -------------------------------------------------------------------------
   Run
   ------------------------------------------------------------------------- */

const glyphs = {};
const sheet = [];
const outlines = [];

for (const [name, file] of Object.entries(FILES)) {
  const cur = readCursor(path.join(dir, file));
  const scale = cur.w / UNIT;
  const loops = contours(bodyField(cur)).map((ring) => simplify(ring, 0.3));
  const grouped = parts(loops);
  const toUnits = (ring) => {
    // Outer rings clockwise on screen (y down) means positive shoelace area.
    const pts = ring.map(([x, y]) => [(x + 0.5 - cur.hx) / scale, (y + 0.5 - cur.hy) / scale]);
    return pts;
  };
  const shaped = grouped.map((p) => {
    let outer = toUnits(p.outer);
    if (area(outer) < 0) outer = outer.reverse();
    const holes = p.holes.map((h) => {
      let r = toUnits(h);
      if (area(r) > 0) r = r.reverse();
      return r;
    });
    return { outer, holes };
  });
  // Biggest part first: it is the one a morph keeps.
  shaped.sort((a, b) => Math.abs(area(b.outer)) - Math.abs(area(a.outer)));
  const whole = contours(alphaField(cur)).map((ring) => simplify(ring, 0.3));
  outlines.push(outlineWidth(grouped.map((p) => p.outer), whole) / scale);
  glyphs[name] = shaped;
  sheet.push({ name, cur, shaped });
  console.log(`${name.padEnd(12)} ${shaped.length} part(s), ${shaped.reduce((n, p) => n + p.outer.length + p.holes.reduce((m, h) => m + h.length, 0), 0)} points`);
}

outlines.sort((a, b) => a - b);
const outline = outlines[Math.floor(outlines.length / 2)];
console.log(`outline      ${outline.toFixed(2)} px at ${UNIT}px`);

const flat = (ring) => ring.flatMap(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
const body = Object.entries(glyphs)
  .map(([name, ps]) => {
    const partText = ps
      .map((p) => {
        const holes = p.holes.length ? `[${p.holes.map((h) => `[${flat(h).join(",")}]`).join(",")}]` : "[]";
        return `{ outer: [${flat(p.outer).join(",")}], holes: ${holes} }`;
      })
      .join(",\n    ");
    return `  ${name}: [\n    ${partText},\n  ],`;
  })
  .join("\n");

const ts = `// Generated by console/scripts/trace-cursors.mjs from the Vision Cursor Black
// set. Do not edit by hand: re-run the script.
//
// Units are pixels of the 32px cursor, measured from the hotspot. Each glyph
// is a list of parts, biggest first; a part is an outer ring (clockwise on
// screen) with any holes (anticlockwise), as flat [x0, y0, x1, y1, ...] lists.

export type TracedPart = { outer: readonly number[]; holes: readonly (readonly number[])[] };

/** The white outline's width around the body, in the same units. */
export const OUTLINE_WIDTH = ${outline.toFixed(3)};

/** The body colour of the original set. */
export const VISION_NAVY = "#0c1e35";

export const TRACED = {
${body}
} satisfies Record<string, readonly TracedPart[]>;

export type GlyphName = keyof typeof TRACED;
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ts);
console.log(`wrote ${path.relative(process.cwd(), out)}`);

/* -------------------------------------------------------------------------
   The comparison sheet
   ------------------------------------------------------------------------- */

function png({ w, h, rgba }) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (sheetPath) {
  const S = 4; // sheet pixels per glyph unit: 128px, like the source frame
  const pathOf = (ps) =>
    ps
      .map((p) => [p.outer, ...p.holes].map((r) => `M${r.map(([x, y]) => `${(x * S).toFixed(2)},${(y * S).toFixed(2)}`).join("L")}Z`).join(""))
      .join("");
  const cells = sheet
    .map(({ name, cur, shaped }) => {
      const img = `data:image/png;base64,${png(cur).toString("base64")}`;
      const ox = cur.hx;
      const oy = cur.hy;
      const d = pathOf(shaped);
      return `<figure><div class="pair">
<img src="${img}" width="${cur.w}" height="${cur.h}">
<svg width="${cur.w}" height="${cur.h}" viewBox="${-ox} ${-oy} ${cur.w} ${cur.h}"><path d="${d}" fill="#0c1e35" fill-rule="evenodd" stroke="#fff" stroke-width="${(outline * S * 2).toFixed(2)}" stroke-linejoin="round" paint-order="stroke" style="filter:drop-shadow(0 2px 3px rgb(0 0 0/.35))"/><circle r="2" fill="#e74c5e"/></svg>
<div class="over"><img src="${img}" width="${cur.w}" height="${cur.h}"><svg width="${cur.w}" height="${cur.h}" viewBox="${-ox} ${-oy} ${cur.w} ${cur.h}"><path d="${d}" fill="none" fill-rule="evenodd" stroke="#e74c5e" stroke-width="1"/></svg></div>
</div><figcaption>${name}</figcaption></figure>`;
    })
    .join("\n");
  fs.writeFileSync(
    sheetPath,
    `<!doctype html><meta charset="utf-8"><title>Traced cursors</title><style>
body{font:13px system-ui;background:#eceff0;margin:24px;display:flex;flex-wrap:wrap;gap:24px}
figure{margin:0}.pair{display:flex;gap:12px;background:#d5dbdd;padding:12px;border-radius:10px}
.over{position:relative;width:128px;height:128px}.over>*{position:absolute;inset:0}
figcaption{margin-top:6px;font-family:ui-monospace,monospace}</style>
<p style="width:100%">Each row: original bitmap · traced shape drawn the way the console draws it (red dot = hotspot) · traced edge in red over the original.</p>
${cells}`,
  );
  console.log(`wrote ${sheetPath}`);
}
