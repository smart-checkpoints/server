"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
/** `lo` is the natural floor; the top mirrors it round the default (or is fixed at `hi`). */
type Slider = { key: NumberKey; label: string; lo: number; hi?: number; step: number; unit?: string; hint: string };

/**
 * A slider's range with its default in the middle, so the built-in value
 * sits at the centre with room to push either way. Follows DEFAULTS: bake new
 * values into tuning.ts and the sliders centre on those.
 */
function range(s: Slider) {
  const d = DEFAULTS[s.key];
  if (s.hi !== undefined) return { min: s.lo, max: s.hi };
  // The floor, moved onto the default's step grid so the default is a value the slider can land on.
  let half = Math.round((d - s.lo) / s.step) * s.step;
  if (half < s.step * 4) half = s.step * 20; // a default at the floor: a usable range above it
  const min = Math.max(s.lo, d - half);
  return { min: Number(min.toFixed(6)), max: Number((d + half).toFixed(6)) };
}

/** What the rows outside the sliders do, shown on hover. */
const HINTS = {
  replay: "Plays the last run Sayes acted in again, on screen only, with your current settings. The best way to judge a change.",
  stop: "Stops the replay and puts the map back.",
  pause: "Freezes the replay so you can look at a pose. Use Step to move one frame at a time.",
  step: "Moves a paused replay forward one frame.",
  speed: "Slow motion for the replay only. Real runs always play at 1×.",
  seed: "The random choices (which way a path bends, drift, small timing offsets) come from the run plus this number. Same seed = same replay every time; Re-roll to see another take of the same run.",
  paths: "Draws each flight's path and a dot where it will click. For checking curves and aim; nobody else sees it.",
  sync: "For each click: when the server sent the change minus when the cursor clicked. + means the change appeared after the click, − before it. Near 0 the map changes exactly as the cursor clicks. “late” = the cursor clicked this much later than planned, because the trip was too long.",
  pacing: "These live on the server, not in this browser. Change them in server/.env and restart the server.",
  lead: "How long the server waits after announcing an action before doing it, so the cursor has time to fly there. Raise it if clicks show up late; lower it if cursors sit waiting.",
  gap: "When Sayes does several things at once, they land this far apart so the cursors take turns instead of all clicking together.",
  gapMin: "The gap never shrinks below this, however busy the run gets.",
  gapDecay: "Each later batch in a run multiplies the gap by this (0 to 1), so a run starts calm and gets busier. 1 = always the same gap.",
  colour: "This cursor's colour. “tag” = how readable the name tag text is on it (aim for 4.5 or more; red means too low). “map” = how much it stands out from the map.",
  placeGlyph: "The shape a cursor becomes when it is about to place a new checkpoint.",
  section: "Click to open or close this group.",
  reset: "Throws away every change you made here and goes back to the built-in values.",
  copy: "Copies all current values as code. Paste it over DEFAULTS in tuning.ts to make your settings the built-in ones for everyone.",
} as const;

const SECTIONS: { title: string; sliders: Slider[] }[] = [
  {
    title: "Paths",
    sliders: [
      { key: "size", label: "Cursor size", lo: 0.3, step: 0.05, unit: "×", hint: "How big the cursors are. 1× is the normal 32 px cursor your OS draws." },
      { key: "curveMin", label: "Bend, least", lo: 0, step: 0.01, hint: "Flights are arcs, not straight lines. Each flight picks a random bend between “least” and “most”, as a share of its length. 0 = dead straight." },
      { key: "curveMax", label: "Bend, most", lo: 0, step: 0.01, hint: "The widest bend a flight may take (0.2 = bulges sideways by a fifth of the distance). Higher = loopier, more hand-drawn arcs." },
      { key: "jitter", label: "Landing jitter", lo: 0, step: 0.5, unit: "px", hint: "When aiming at a big target (a panel or a road), the cursor lands up to this far off-centre, so it looks hand-aimed. 0 = always the exact middle." },
    ],
  },
  {
    title: "Timing",
    sliders: [
      { key: "flightBase", label: "Flight, base", lo: 0, step: 10, unit: "ms", hint: "Fixed time every flight takes before distance is added. Flight time = base + (per √px × √distance), then kept between shortest and longest." },
      { key: "flightK", label: "Flight per √px", lo: 0, step: 1, unit: "ms", hint: "Extra time per √pixel of distance. Square root means a trip 4× as far takes only 2× the extra time. Higher = slower long trips." },
      { key: "flightMin", label: "Flight, shortest", lo: 100, step: 10, unit: "ms", hint: "No flight is quicker than this, even a tiny hop." },
      { key: "flightMax", label: "Flight, longest", lo: 500, step: 20, unit: "ms", hint: "No flight takes longer than this, even across the whole map." },
      { key: "settle", label: "Settle before click", lo: 0, step: 10, unit: "ms", hint: "After arriving, the cursor sits still this long before it clicks: the “aiming” moment. Too low feels robotic, too high feels hesitant." },
      { key: "beat", label: "Beat after acting", lo: 0, step: 10, unit: "ms", hint: "After acting, the cursor waits this long before it leaves for its parking spot." },
    ],
  },
  {
    title: "Character",
    sliders: [
      { key: "leanMax", label: "Lean, most", lo: 0, step: 0.5, unit: "°", hint: "Cursors tilt toward the way they are moving sideways, like leaning into a turn. This caps the tilt, in degrees. 0 = never tilt." },
      { key: "leanPerSpeed", label: "Lean per px/s", lo: 0, step: 0.001, hint: "How much tilt per px/s of sideways speed. Higher = leans further at the same speed (still capped by “Lean, most”)." },
      { key: "leanStiffness", label: "Lean spring stiffness", lo: 10, step: 5, hint: "How fast the tilt chases its target. Higher = snappy, lower = lazy and floaty." },
      { key: "leanDamping", label: "Lean spring damping", lo: 2, step: 1, hint: "How quickly the tilt stops swinging. Low = it rocks back and forth past upright before settling; high = settles with no wobble." },
      { key: "stretchMax", label: "Stretch, most", lo: 0, step: 0.005, hint: "Fast cursors stretch along their direction of travel, like a motion smear. 0.06 = up to 6% longer. 0 = off." },
      { key: "stretchPerSpeed", label: "Stretch per px/s", lo: 0, step: 0.00001, hint: "How much stretch per px/s of speed. Higher = stretches sooner, at lower speeds." },
      { key: "skewMax", label: "Skew, most", lo: 0, step: 0.5, unit: "°", hint: "When a flight curves, the cursor shears sideways into the turn. This caps the shear, in degrees. 0 = off." },
      { key: "skewPerAccel", label: "Skew per px/s²", lo: 0, step: 0.0001, hint: "How much shear per unit of turning (sideways acceleration). Higher = sharper curves shear more." },
      { key: "overshoot", label: "Overshoot", lo: 0, step: 0.5, unit: "px", hint: "Long flights sail past the target by this many px and ease back, like a real hand. 0 = off." },
      { key: "overshootMinDistance", label: "Overshoot from", lo: 0, step: 20, unit: "px", hint: "Only flights longer than this overshoot; short hops always land straight on." },
      { key: "pressScale", label: "Click squash", lo: 0.46, step: 0.01, unit: "×", hint: "On a click the cursor squashes to this size and springs back. 0.88 = shrinks to 88%. Lower = deeper, punchier press." },
      { key: "pressMs", label: "Click length", lo: 20, step: 5, unit: "ms", hint: "How long the click squash lasts." },
      { key: "anticipation", label: "Pull back", lo: 0, step: 0.5, unit: "px", hint: "Before leaving, the cursor pulls back this many px away from where it is going, like a wind-up. Only for trips over 40 px. 0 = off." },
      { key: "anticipationMs", label: "Pull back length", lo: 0, step: 5, unit: "ms", hint: "How long that wind-up takes." },
    ],
  },
  {
    title: "Idle",
    sliders: [
      { key: "idleAmp", label: "Drift", lo: 0, step: 0.25, unit: "px", hint: "Parked cursors float gently around their spot by up to this many px, so they look alive. 0 = dead still." },
      { key: "idlePeriod", label: "Drift period", lo: 300, step: 50, unit: "ms", hint: "How long one float sway takes. Low = restless and jittery; high = slow, like breathing." },
      { key: "idleWobble", label: "Wobble", lo: 0, step: 0.1, unit: "°", hint: "Parked cursors also rock a little, by up to this many degrees." },
      { key: "microMin", label: "Shift every, least", lo: 1000, step: 250, unit: "ms", hint: "Every so often a parked cursor shuffles to a new spot nearby. The wait is random between “least” and “most”; this is the shortest wait." },
      { key: "microMax", label: "Shift every, most", lo: 1000, step: 250, unit: "ms", hint: "The longest a parked cursor waits before shuffling to a new nearby spot." },
      { key: "microRadius", label: "Shift radius", lo: 0, step: 2, unit: "px", hint: "How far that shuffle can go from its parking spot. 0 = never shuffles anywhere." },
      { key: "glance", label: "Glance at the active one", lo: 0, step: 0.5, unit: "°", hint: "Parked cursors tilt toward whichever cursor is acting, as if watching it. Degrees. 0 = they ignore each other." },
      { key: "thinkingBoost", label: "Livelier while thinking", lo: 1, step: 0.05, unit: "×", hint: "While Sayes is thinking (before it acts), idle float is multiplied by this, so the cast looks restless. 1× = no change." },
    ],
  },
  {
    title: "Morph",
    sliders: [
      { key: "morphMs", label: "Glyph morph", lo: 40, step: 10, unit: "ms", hint: "How long a cursor takes to morph between shapes: pointer → pen, crosshair, hand, move and back." },
      { key: "hugMs", label: "Hug morph", lo: 40, step: 10, unit: "ms", hint: "How long a cursor takes to melt into an outline wrapped around the panel or road it is working on (and to come back out)." },
      { key: "hugPad", label: "Hug padding", lo: 0, step: 1, unit: "px", hint: "Gap between a panel and the outline hugging it." },
      { key: "hugRadius", label: "Hug corner", lo: 0, step: 1, unit: "px", hint: "Corner roundness of that panel outline. 0 = sharp corners." },
      { key: "edgeHugWidth", label: "Road hug width", lo: 6, step: 1, unit: "px", hint: "When a cursor hugs a road, it becomes a capsule this many px thick along it." },
      { key: "shimmerMs", label: "Shimmer lap", lo: 200, step: 50, unit: "ms", hint: "While a cursor waits for its action to finish, a light runs around its outline. This is one lap. Lower = faster shimmer." },
    ],
  },
  {
    title: "Cast and finale",
    sliders: [
      { key: "castMax", label: "Cursors at most", lo: 1, hi: 5, step: 1, hint: "The most cursors on the map at once. When Sayes does more things in parallel than this, cursors are shared." },
      { key: "parkInset", label: "Park inset", lo: 16, step: 2, unit: "px", hint: "Idle cursors park around the edges of the map; this is how far in from the edge they sit." },
      { key: "wrapPad", label: "Wrap padding", lo: 0, step: 1, unit: "px", hint: "At the end of a run, one cursor draws an outline around everything that changed. This is the padding around it." },
      { key: "wrapHold", label: "Wrap hold", lo: 0, step: 50, unit: "ms", hint: "How long that final outline stays up before everyone flies home." },
      { key: "homeStagger", label: "Fly-home stagger", lo: 0, step: 5, unit: "ms", hint: "At the end, cursors fly home into the logo one after another, this far apart. 0 = all at once." },
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
  const [tip, setTip] = useState<{ text: string; top: number; right: number } | null>(null);
  const panel = useRef<HTMLElement>(null);

  // One shared tooltip: anything inside with data-hint shows it, beside the panel so it never covers a control.
  const showTip = (target: EventTarget | null) => {
    const el = target instanceof Element ? target.closest<HTMLElement>("[data-hint]") : null;
    const box = panel.current?.getBoundingClientRect();
    if (!el || !box) return setTip(null);
    const row = el.getBoundingClientRect();
    setTip({ text: el.dataset.hint ?? "", top: Math.max(8, Math.min(row.top, window.innerHeight - 160)), right: window.innerWidth - box.left + 8 });
  };

  // The sync list and replay state are not React state; look again twice a second.
  useEffect(() => {
    const id = window.setInterval(() => setSync([...controls.sync()]), 500);
    return () => window.clearInterval(id);
  }, [controls]);

  const gap = controls.info?.cursor_gap;
  const mapBg = "#eceff0";

  return (
    <>
    <aside
      ref={panel}
      onPointerOver={(e) => showTip(e.target)}
      onPointerLeave={() => setTip(null)}
      onFocus={(e) => showTip(e.target)}
      onBlur={() => setTip(null)}
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
            <button type="button" className="btn btn-primary rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50" data-hint={HINTS.replay} disabled={!controls.canReplay} onClick={() => { setPaused(false); controls.replay(); }}>
              Replay last run
            </button>
            <button type="button" className="btn btn-secondary rounded-full px-3 py-1 text-xs font-semibold" data-hint={HINTS.stop} onClick={() => controls.stopReplay()}>
              Stop
            </button>
            <button
              type="button"
              className="btn btn-secondary rounded-full px-3 py-1 text-xs font-semibold"
              data-hint={HINTS.pause}
              onClick={() => {
                controls.pause(!paused);
                setPaused(!paused);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="btn btn-secondary rounded-full px-3 py-1 text-xs font-semibold" onClick={() => controls.step()} data-hint={HINTS.step}>
              Step
            </button>
          </div>
          <label className="flex items-center justify-between gap-2" data-hint={HINTS.speed}>
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
          <label className="flex items-center justify-between gap-2" data-hint={HINTS.seed}>
            <span className="text-text-dim">Seed</span>
            <span className="flex items-center gap-2">
              <span className="font-mono">{t.seed}</span>
              <button type="button" className="font-semibold text-cyan-dark" onClick={() => setTuning({ seed: Math.floor(Math.random() * 1e6) })}>
                Re-roll
              </button>
            </span>
          </label>
          <label className="flex items-center justify-between gap-2" data-hint={HINTS.paths}>
            <span className="text-text-dim">Show paths and click points</span>
            <input type="checkbox" checked={t.showPaths} onChange={(e) => setTuning({ showPaths: e.target.checked })} />
          </label>
        </section>

        <section className="space-y-1 border-t border-border py-3" data-hint={HINTS.sync}>
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
          <p className="text-text-dim" data-hint={HINTS.pacing}>Set in the server&apos;s .env; shown here to read.</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 font-mono">
            <dt className="text-text-dim" data-hint={HINTS.lead}>AGENT_CURSOR_LEAD_MS</dt>
            <dd>{controls.info?.cursor_lead_ms ?? "?"}</dd>
            <dt className="text-text-dim" data-hint={HINTS.gap}>AGENT_CURSOR_GAP_MS</dt>
            <dd>{gap?.ms ?? "?"}</dd>
            <dt className="text-text-dim" data-hint={HINTS.gapMin}>AGENT_CURSOR_GAP_MIN_MS</dt>
            <dd>{gap?.min_ms ?? "?"}</dd>
            <dt className="text-text-dim" data-hint={HINTS.gapDecay}>AGENT_CURSOR_GAP_DECAY</dt>
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
              <label key={lane.name} className="flex items-center justify-between gap-2" data-hint={HINTS.colour}>
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
          <label className="flex items-center justify-between gap-2" data-hint={HINTS.placeGlyph}>
            <span className="text-text-dim">Placing a checkpoint becomes</span>
            <select className="field w-auto py-1 text-xs" value={t.placeGlyph} onChange={(e) => setTuning({ placeGlyph: e.target.value as Tuning["placeGlyph"] })}>
              <option value="cross">Crosshair</option>
              <option value="pin">Hand with pin</option>
            </select>
          </label>
        </section>

        <section className="border-t border-border py-3">
          <label
            className="block"
            data-hint={`Speeds up or slows down everything at once (flights, pauses, morphs, idling) while keeping the balance between them, so the motion looks the same, just faster or slower. 2× = twice as fast.\n\nSlower than about 1× can run out of the server's time to reach a click (AGENT_CURSOR_LEAD_MS); then the flights get squeezed.\n\nBuilt-in value: ${DEFAULTS.speed}×`}
          >
            <span className="flex justify-between">
              <span className={`cursor-help font-display font-bold underline decoration-dotted underline-offset-2 ${t.speed !== DEFAULTS.speed ? "text-cyan-dark" : ""}`}>Overall speed</span>
              <span className="font-mono">{t.speed.toFixed(2)}×</span>
            </span>
            <span className="relative block">
              <input
                type="range"
                min={0.25}
                max={DEFAULTS.speed * 2 - 0.25}
                step={0.05}
                value={t.speed}
                onChange={(e) => setTuning({ speed: Number(e.target.value) })}
                className="w-full accent-[var(--cyan)]"
              />
              <span aria-hidden="true" className="pointer-events-none absolute -bottom-0.5 left-1/2 h-1.5 w-px -translate-x-1/2 bg-text-dim opacity-60" />
            </span>
          </label>
        </section>

        {SECTIONS.map((section) => (
          <section key={section.title} className="border-t border-border py-2">
            <button
              type="button"
              className="flex w-full items-center justify-between py-1 font-display text-xs font-bold"
              data-hint={HINTS.section}
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
                  const { min, max } = range(s);
                  const home = max > min ? ((DEFAULTS[s.key] - min) / (max - min)) * 100 : 50;
                  return (
                    <label key={s.key} className="block" data-hint={`${s.hint}\n\nBuilt-in value: ${fmt(DEFAULTS[s.key], s.step)}${s.unit ?? ""}`}>
                      <span className="flex justify-between">
                        <span className={`cursor-help underline decoration-dotted underline-offset-2 ${changed ? "font-semibold text-cyan-dark" : "text-text-dim"}`}>{s.label}</span>
                        <span className="font-mono">
                          {fmt(value, s.step)}
                          {s.unit ?? ""}
                        </span>
                      </span>
                      <span className="relative block">
                        <input
                          type="range"
                          min={min}
                          max={max}
                          step={s.step}
                          value={value}
                          onChange={(e) => setTuning({ [s.key]: Number(e.target.value) } as Partial<Tuning>)}
                          className="w-full accent-[var(--cyan)]"
                        />
                        {/* The built-in value: a tick under the track, in the middle. */}
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -bottom-0.5 h-1.5 w-px -translate-x-1/2 bg-text-dim opacity-60"
                          style={{ left: `${home}%` }}
                        />
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </section>
        ))}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <button type="button" className="text-xs font-semibold text-text-dim hover:text-red" data-hint={HINTS.reset} onClick={() => resetTuning()}>
          Reset all
        </button>
        <button
          type="button"
          className="btn btn-primary rounded-full px-4 py-1.5 text-xs font-semibold"
          data-hint={HINTS.copy}
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
    {tip ? (
      <div
        role="tooltip"
        data-cursor-avoid
        className="pointer-events-none fixed z-[71] w-64 whitespace-pre-line rounded-xl border border-border bg-surface px-3 py-2 text-xs leading-snug text-text shadow-lg"
        style={{ top: tip.top, right: tip.right }}
      >
        {tip.text}
      </div>
    ) : null}
    </>
  );
}
