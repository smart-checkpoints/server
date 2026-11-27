"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentInfo } from "@/lib/agent";
import { LANES } from "../labels";
import type { SyncRecord } from "./director";
import { DEFAULTS, resetTuning, setTuning, subscribeTuning, tuning, tuningAsCode, type Tuning } from "./tuning";

export type LabControls = {
  canReplay: boolean;
  replaying: () => boolean;
  replay: () => void;
  stopReplay: () => void;
  setRate: (rate: number) => void;
  pause: (paused: boolean) => void;
  step: () => void;
  sync: () => SyncRecord[];
  info: AgentInfo | null;
};

type NumberKey = { [K in keyof Tuning]: Tuning[K] extends number ? K : never }[keyof Tuning];
type Slider = { key: NumberKey; label: string; min: number; max: number; step: number; unit?: string };

const SECTIONS: { title: string; sliders: Slider[] }[] = [
  {
    title: "Paths",
    sliders: [
      { key: "size", label: "Cursor size", min: 0.6, max: 2, step: 0.05, unit: "×" },
      { key: "curveMin", label: "Bend, least", min: 0, max: 0.5, step: 0.01 },
      { key: "curveMax", label: "Bend, most", min: 0, max: 0.6, step: 0.01 },
      { key: "jitter", label: "Landing jitter", min: 0, max: 12, step: 0.5, unit: "px" },
    ],
  },
  {
    title: "Timing",
    sliders: [
      { key: "flightBase", label: "Flight, base", min: 0, max: 800, step: 10, unit: "ms" },
      { key: "flightK", label: "Flight per √px", min: 0, max: 60, step: 1, unit: "ms" },
      { key: "flightMin", label: "Flight, shortest", min: 100, max: 800, step: 10, unit: "ms" },
      { key: "flightMax", label: "Flight, longest", min: 300, max: 2500, step: 20, unit: "ms" },
      { key: "settle", label: "Settle before click", min: 0, max: 500, step: 10, unit: "ms" },
      { key: "beat", label: "Beat after acting", min: 0, max: 1000, step: 10, unit: "ms" },
    ],
  },
  {
    title: "Character",
    sliders: [
      { key: "leanMax", label: "Lean, most", min: 0, max: 30, step: 0.5, unit: "°" },
      { key: "leanPerSpeed", label: "Lean per px/s", min: 0, max: 0.05, step: 0.001 },
      { key: "leanStiffness", label: "Lean spring stiffness", min: 20, max: 600, step: 5 },
      { key: "leanDamping", label: "Lean spring damping", min: 2, max: 60, step: 1 },
      { key: "stretchMax", label: "Stretch, most", min: 0, max: 0.25, step: 0.005 },
      { key: "stretchPerSpeed", label: "Stretch per px/s", min: 0, max: 0.0005, step: 0.00001 },
      { key: "skewMax", label: "Skew, most", min: 0, max: 20, step: 0.5, unit: "°" },
      { key: "skewPerAccel", label: "Skew per px/s²", min: 0, max: 0.01, step: 0.0001 },
      { key: "overshoot", label: "Overshoot", min: 0, max: 20, step: 0.5, unit: "px" },
      { key: "overshootMinDistance", label: "Overshoot from", min: 0, max: 1200, step: 20, unit: "px" },
      { key: "pressScale", label: "Click squash", min: 0.5, max: 1, step: 0.01, unit: "×" },
      { key: "pressMs", label: "Click length", min: 20, max: 300, step: 5, unit: "ms" },
      { key: "anticipation", label: "Pull back", min: 0, max: 15, step: 0.5, unit: "px" },
      { key: "anticipationMs", label: "Pull back length", min: 0, max: 300, step: 5, unit: "ms" },
    ],
  },
  {
    title: "Idle",
    sliders: [
      { key: "idleAmp", label: "Drift", min: 0, max: 12, step: 0.25, unit: "px" },
      { key: "idlePeriod", label: "Drift period", min: 300, max: 6000, step: 50, unit: "ms" },
      { key: "idleWobble", label: "Wobble", min: 0, max: 8, step: 0.1, unit: "°" },
      { key: "microMin", label: "Shift every, least", min: 1000, max: 20000, step: 250, unit: "ms" },
      { key: "microMax", label: "Shift every, most", min: 1000, max: 30000, step: 250, unit: "ms" },
      { key: "microRadius", label: "Shift radius", min: 0, max: 120, step: 2, unit: "px" },
      { key: "glance", label: "Glance at the active one", min: 0, max: 15, step: 0.5, unit: "°" },
      { key: "thinkingBoost", label: "Livelier while thinking", min: 1, max: 3, step: 0.05, unit: "×" },
    ],
  },
  {
    title: "Morph",
    sliders: [
      { key: "morphMs", label: "Glyph morph", min: 40, max: 900, step: 10, unit: "ms" },
      { key: "hugMs", label: "Hug morph", min: 40, max: 1200, step: 10, unit: "ms" },
      { key: "hugPad", label: "Hug padding", min: 0, max: 24, step: 1, unit: "px" },
      { key: "hugRadius", label: "Hug corner", min: 0, max: 40, step: 1, unit: "px" },
      { key: "edgeHugWidth", label: "Road hug width", min: 6, max: 48, step: 1, unit: "px" },
      { key: "shimmerMs", label: "Shimmer lap", min: 300, max: 4000, step: 50, unit: "ms" },
    ],
  },
  {
    title: "Cast and finale",
    sliders: [
      { key: "castMax", label: "Cursors at most", min: 1, max: 5, step: 1 },
      { key: "parkInset", label: "Park inset", min: 16, max: 200, step: 2, unit: "px" },
      { key: "wrapPad", label: "Wrap padding", min: 0, max: 80, step: 1, unit: "px" },
      { key: "wrapHold", label: "Wrap hold", min: 0, max: 3000, step: 50, unit: "ms" },
      { key: "homeStagger", label: "Fly-home stagger", min: 0, max: 400, step: 5, unit: "ms" },
    ],
  },
];

/** WCAG contrast between two #rrggbb colours. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, bl] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return null;
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const fmt = (v: number, step: number) => (step < 0.001 ? v.toFixed(5) : step < 0.01 ? v.toFixed(3) : step < 1 ? v.toFixed(2) : String(Math.round(v)));

/**
 * The Cursor Lab: every number the cursors move by, live. Opens with
 * Alt+Shift+C or ?cursorlab. Changes are kept in this browser until reset;
 * "Copy as code" gives a block to paste into tuning.ts to keep them for good.
 */
export default function CursorLab({ controls, onClose }: { controls: LabControls; onClose: () => void }) {
  const t = useSyncExternalStore(subscribeTuning, tuning, () => DEFAULTS);
  const [open, setOpen] = useState<string>("Character");
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sync, setSync] = useState<SyncRecord[]>([]);

  // The sync list and replay state are not React state; look again twice a second.
  useEffect(() => {
    const id = window.setInterval(() => setSync([...controls.sync()]), 500);
    return () => window.clearInterval(id);
  }, [controls]);

  const gap = controls.info?.cursor_gap;
  const mapBg = "#eceff0";

  return (
    <aside
      data-cursor-avoid
      className="sayes-lab fixed right-4 top-20 z-[70] flex max-h-[calc(100vh-6rem)] w-[22rem] flex-col overflow-hidden rounded-2xl border border-border bg-surface text-text shadow-lg"
      aria-label="Cursor Lab"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="font-display text-sm font-bold">Cursor Lab</h2>
          <p className="font-mono text-[0.6875rem] text-text-dim">Alt+Shift+C · kept in this browser</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-full px-2 py-1 text-xs font-semibold text-text-dim hover:text-cyan-dark">
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
        <section className="space-y-2 pb-3">
          <h3 className="font-display text-xs font-bold">Playback</h3>
          <p className="text-text-dim">
            Replays the last run Sayes acted in, from the map as it was before it; each change lands as its cursor
            clicks. On screen only: nothing is changed or sent.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50" disabled={!controls.canReplay} onClick={() => { setPaused(false); controls.replay(); }}>
              Replay last run
            </button>
            <button type="button" className="btn btn-secondary rounded-full px-3 py-1 text-xs font-semibold" onClick={() => controls.stopReplay()}>
              Stop
            </button>
            <button
              type="button"
              className="btn btn-secondary rounded-full px-3 py-1 text-xs font-semibold"
              onClick={() => {
                controls.pause(!paused);
                setPaused(!paused);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="btn btn-secondary rounded-full px-3 py-1 text-xs font-semibold" onClick={() => controls.step()} title="One frame forward (paused replay)">
              Step
            </button>
          </div>
          <label className="flex items-center justify-between gap-2">
            <span className="text-text-dim">Speed (replay only)</span>
            <select
              className="field w-auto py-1 text-xs"
              value={t.slowmo}
              onChange={(e) => {
                const rate = Number(e.target.value);
                setTuning({ slowmo: rate });
                controls.setRate(rate);
              }}
            >
              <option value={1}>1×</option>
              <option value={0.5}>0.5×</option>
              <option value={0.25}>0.25×</option>
              <option value={0.1}>0.1×</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-text-dim">Seed</span>
            <span className="flex items-center gap-2">
              <span className="font-mono">{t.seed}</span>
              <button type="button" className="font-semibold text-cyan-dark" onClick={() => setTuning({ seed: Math.floor(Math.random() * 1e6) })}>
                Re-roll
              </button>
            </span>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-text-dim">Show paths and click points</span>
            <input type="checkbox" checked={t.showPaths} onChange={(e) => setTuning({ showPaths: e.target.checked })} />
          </label>
        </section>

        <section className="space-y-1 border-t border-border py-3">
          <h3 className="font-display text-xs font-bold">Sync</h3>
          <p className="text-text-dim">Click vs. when the server sent the call. Aim for under 50 ms.</p>
          {sync.length === 0 ? <p className="text-text-dim">No clicks yet.</p> : null}
          <ul className="space-y-0.5 font-mono">
            {sync.slice(-8).map((r) => (
              <li key={r.callId} className="flex justify-between">
                <span>{LANES[(r.lane - 1) % LANES.length].name}</span>
                <span className={Math.abs(r.deltaMs) > 50 ? "text-red" : ""}>
                  Δ {r.deltaMs > 0 ? "+" : ""}
                  {r.deltaMs} ms{r.lateMs > 0 ? ` · late ${r.lateMs}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-1 border-t border-border py-3">
          <h3 className="font-display text-xs font-bold">Pacing (server)</h3>
          <p className="text-text-dim">Set in the server&apos;s .env; shown here to read.</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 font-mono">
            <dt className="text-text-dim">AGENT_CURSOR_LEAD_MS</dt>
            <dd>{controls.info?.cursor_lead_ms ?? "?"}</dd>
            <dt className="text-text-dim">AGENT_CURSOR_GAP_MS</dt>
            <dd>{gap?.ms ?? "?"}</dd>
            <dt className="text-text-dim">AGENT_CURSOR_GAP_MIN_MS</dt>
            <dd>{gap?.min_ms ?? "?"}</dd>
            <dt className="text-text-dim">AGENT_CURSOR_GAP_DECAY</dt>
            <dd>{gap?.decay ?? "?"}</dd>
          </dl>
        </section>

        <section className="space-y-2 border-t border-border py-3">
          <h3 className="font-display text-xs font-bold">Colours</h3>
          {LANES.map((lane, i) => {
            const colour = t.colours[i] ?? lane.colour;
            const tag = contrast(colour, lane.ink);
            const body = contrast(colour, mapBg);
            return (
              <label key={lane.name} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    value={colour}
                    onChange={(e) => {
                      const colours = [...t.colours];
                      colours[i] = e.target.value;
                      setTuning({ colours });
                    }}
                    className="h-6 w-8 cursor-pointer rounded border border-border"
                  />
                  <span className="font-semibold">{lane.name}</span>
                </span>
                <span className="font-mono text-text-dim">
                  tag <span className={tag !== null && tag < 4.5 ? "text-red" : ""}>{tag?.toFixed(1) ?? "?"}</span> · map {body?.toFixed(1) ?? "?"}
                </span>
              </label>
            );
          })}
          <label className="flex items-center justify-between gap-2">
            <span className="text-text-dim">Placing a checkpoint becomes</span>
            <select className="field w-auto py-1 text-xs" value={t.placeGlyph} onChange={(e) => setTuning({ placeGlyph: e.target.value as Tuning["placeGlyph"] })}>
              <option value="cross">Crosshair</option>
              <option value="pin">Hand with pin</option>
            </select>
          </label>
        </section>

        {SECTIONS.map((section) => (
          <section key={section.title} className="border-t border-border py-2">
            <button
              type="button"
              className="flex w-full items-center justify-between py-1 font-display text-xs font-bold"
              onClick={() => setOpen(open === section.title ? "" : section.title)}
            >
              {section.title}
              <span className="text-text-dim">{open === section.title ? "−" : "+"}</span>
            </button>
            {open === section.title ? (
              <div className="space-y-2 pt-1">
                {section.sliders.map((s) => {
                  const value = t[s.key];
                  const changed = value !== DEFAULTS[s.key];
                  return (
                    <label key={s.key} className="block">
                      <span className="flex justify-between">
                        <span className={changed ? "font-semibold text-cyan-dark" : "text-text-dim"}>{s.label}</span>
                        <span className="font-mono">
                          {fmt(value, s.step)}
                          {s.unit ?? ""}
                        </span>
                      </span>
                      <input
                        type="range"
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        value={value}
                        onChange={(e) => setTuning({ [s.key]: Number(e.target.value) } as Partial<Tuning>)}
                        className="w-full accent-[var(--cyan)]"
                      />
                    </label>
                  );
                })}
              </div>
            ) : null}
          </section>
        ))}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <button type="button" className="text-xs font-semibold text-text-dim hover:text-red" onClick={() => resetTuning()}>
          Reset all
        </button>
        <button
          type="button"
          className="btn btn-primary rounded-full px-4 py-1.5 text-xs font-semibold"
          onClick={() => {
            void navigator.clipboard.writeText(tuningAsCode()).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy as code"}
        </button>
      </footer>
    </aside>
  );
}
