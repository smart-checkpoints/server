"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import {
  reportSighting,
  type CheckpointNode,
  type Connection,
  type PathGeometry,
  type SightingResult,
} from "@/lib/api";
import { formatDistance, formatSpeed } from "@/lib/format";
import type { LatLng } from "@/lib/geo";
import {
  buildTrack,
  describeReason,
  planRoute,
  positionAt,
  profileAt,
  randomDemoPlate,
  timetable,
  type Timetable,
} from "@/lib/testdrive";

/** Where the test car is this frame, in both the graph's terms and the map's. */
export type VehicleFrame = {
  fromNodeId: number;
  toNodeId: number;
  t: number;
  position: LatLng;
  label: string;
  violation: boolean;
};

export type TestDriveHandle = {
  /** A checkpoint clicked on the graph or the map while the panel is open. */
  pick: (nodeId: number) => void;
};

type Phase = "start" | "end" | "ready" | "driving" | "done";

type Outcome = SightingResult | { error: string } | null;

type TestDrivePanelProps = {
  apiKey: string;
  nodes: CheckpointNode[];
  connections: Connection[];
  geometry: Record<number, PathGeometry>;
  onVehicle: (vehicle: VehicleFrame | null) => void;
  /** The checkpoints picked so far, for the views to ring and name. */
  onPicks: (picks: { start: number | null; end: number | null }) => void;
  onClose: () => void;
};

const MIN_SPEED = 10;
const MAX_SPEED = 200;

/**
 * Drives a test car between two checkpoints of a demo project.
 *
 * The car is the console's; the verdict is not. Each checkpoint the car passes
 * is reported to `/report-checkpoint` with a plate and a time, which is all a
 * camera ever sends, and the rows below show what the server answered.
 */
const TestDrivePanel = forwardRef<TestDriveHandle, TestDrivePanelProps>(
  function TestDrivePanel(
    { apiKey, nodes, connections, geometry, onVehicle, onPicks, onClose },
    ref,
  ) {
    const [phase, setPhase] = useState<Phase>("start");
    const [startId, setStartId] = useState<number | null>(null);
    const [endId, setEndId] = useState<number | null>(null);
    const [speed, setSpeed] = useState(80);
    const [kangaroo, setKangaroo] = useState(false);
    const [cameraSpeed, setCameraSpeed] = useState(40);
    const [liveSpeed, setLiveSpeed] = useState(0);
    const [plate, setPlate] = useState<string | null>(null);
    const [table, setTable] = useState<Timetable | null>(null);
    const [outcomes, setOutcomes] = useState<Outcome[]>([]);
    const [progress, setProgress] = useState(0);

    const frame = useRef<number | null>(null);
    const cancelled = useRef(false);

    const route = useMemo(
      () =>
        startId !== null && endId !== null
          ? planRoute(startId, endId, nodes, connections)
          : null,
      [startId, endId, nodes, connections],
    );

    const label = (id: number | null) =>
      nodes.find((node) => node.node_id === id)?.id_in_project ?? "?";

    const stop = useCallback(() => {
      cancelled.current = true;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    }, []);

    useEffect(
      () => () => {
        stop();
        onVehicle(null);
      },
      [stop, onVehicle],
    );

    const reset = useCallback(() => {
      stop();
      onVehicle(null);
      setPhase("start");
      setStartId(null);
      setEndId(null);
      setOutcomes([]);
      setTable(null);
      setPlate(null);
      setProgress(0);
      onPicks({ start: null, end: null });
    }, [stop, onVehicle, onPicks]);

    useImperativeHandle(
      ref,
      () => ({
        pick: (nodeId: number) => {
          if (phase === "driving") return;
          if (phase === "end") {
            if (nodeId === startId) return;
            setEndId(nodeId);
            setPhase("ready");
            onPicks({ start: startId, end: nodeId });
            const planned =
              startId === null ? null : planRoute(startId, nodeId, nodes, connections);
            if (planned) {
              const limit = Math.max(...planned.hops.map((hop) => hop.connection.speed_limit));
              setSpeed(Math.min(MAX_SPEED, Math.round((limit + 20) / 10) * 10));
              const lowest = Math.min(...planned.hops.map((hop) => hop.connection.speed_limit));
              setCameraSpeed(Math.max(MIN_SPEED, Math.round((lowest - 20) / 5) * 5));
            }
            return;
          }
          // Anything else starts a new drive from here.
          onVehicle(null);
          setStartId(nodeId);
          setEndId(null);
          setOutcomes([]);
          setTable(null);
          setPlate(null);
          setProgress(0);
          setPhase("end");
          onPicks({ start: nodeId, end: null });
        },
      }),
      [phase, startId, nodes, connections, onVehicle, onPicks],
    );

    const drive = useCallback(() => {
      if (!route) return;
      stop();
      cancelled.current = false;

      const carPlate = randomDemoPlate();
      const plan = timetable(
        route,
        { cruiseKmh: speed, kangaroo, cameraKmh: cameraSpeed },
        Date.now(),
      );
      const track = buildTrack(route, geometry);
      const checkpoints = [route.hops[0].from, ...route.hops.map((hop) => hop.to)];

      setPlate(carPlate);
      setTable(plan);
      setOutcomes(checkpoints.map(() => null));
      setProgress(0);
      setPhase("driving");

      // One request at a time, in order. The server judges a sighting against
      // the car's previous one, so a later checkpoint must never overtake.
      let chain = Promise.resolve();
      let violation = false;
      const report = (index: number) => {
        chain = chain.then(async () => {
          let outcome: Outcome;
          try {
            const result = await reportSighting(apiKey, {
              plate: carPlate,
              idInProject: checkpoints[index].id_in_project,
              timestamp: plan.sightings[index],
            });
            if (result.status) violation = true;
            outcome = result;
          } catch (err) {
            outcome = {
              error: err instanceof Error ? err.message : "The report failed",
            };
          }
          if (cancelled.current) return;
          setOutcomes((current) => {
            const next = current.slice();
            next[index] = outcome;
            return next;
          });
        });
      };

      const vehicleAt = (fraction: number, kmh: number): VehicleFrame => {
        const at = positionAt(track, fraction);
        const hop = route.hops[at.hopIndex];
        return {
          fromNodeId: hop.from.node_id,
          toNodeId: hop.to.node_id,
          t: at.hopT,
          position: at.position,
          label: `${carPlate} · ${Math.round(kmh)} km/h`,
          violation,
        };
      };

      report(0);
      let reported = 1;
      const began = performance.now();
      const playMs = plan.playSeconds * 1000;

      const step = (now: number) => {
        if (cancelled.current) return;
        const played = playMs <= 0 ? 1 : Math.min(1, (now - began) / playMs);
        const at = profileAt(plan.profile, played * plan.realSeconds);
        const fraction =
          played >= 1 || route.meters === 0 ? 1 : Math.min(1, at.meters / route.meters);
        while (
          reported < plan.fractions.length &&
          plan.fractions[reported] <= fraction + 1e-9
        ) {
          report(reported);
          reported += 1;
        }
        onVehicle(vehicleAt(fraction, at.kmh));
        setProgress(fraction);
        setLiveSpeed(at.kmh);

        if (played < 1) {
          frame.current = requestAnimationFrame(step);
          return;
        }
        frame.current = null;
        void chain.then(() => {
          if (cancelled.current) return;
          onVehicle(vehicleAt(1, plan.passKmh[plan.passKmh.length - 1]));
          setPhase("done");
        });
      };

      frame.current = requestAnimationFrame(step);
    }, [route, speed, kangaroo, cameraSpeed, geometry, apiKey, onVehicle, stop]);

    const close = () => {
      stop();
      onVehicle(null);
      onPicks({ start: null, end: null });
      onClose();
    };

    const instruction =
      phase === "start"
        ? "Click the checkpoint the car starts from."
        : phase === "end"
          ? `From checkpoint ${label(startId)}. Click where it drives to.`
          : null;

    const violations = outcomes.filter(
      (outcome) => outcome !== null && "status" in outcome && outcome.status,
    ).length;
    const step = phase === "start" ? 1 : phase === "end" ? 2 : 3;
    const banner =
      phase === "start"
        ? "Click the checkpoint the car starts from"
        : phase === "end"
          ? `Starting at checkpoint ${label(startId)} · click where it drives to`
          : phase === "ready"
            ? route
              ? "Choose a speed, then press Drive"
              : "No road leads there · click another checkpoint"
            : phase === "driving"
              ? `Driving ${plate ?? ""} at ${Math.round(liveSpeed)} km/h${kangaroo ? " · kangaroo" : ""} · reporting each checkpoint to the server`
              : violations > 0
                ? `Done · the server recorded ${violations} violation${violations === 1 ? "" : "s"}`
                : "Done · the server recorded no violation";

    return (
      <>
        {/* Clicks pass through, so a checkpoint under the banner can still be
            picked; only Exit takes them. */}
        <div className="pointer-events-none absolute left-1/2 top-16 z-10 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-4 rounded-2xl border-2 border-cyan bg-surface/90 px-5 py-3 shadow-lg backdrop-blur-sm">
          <span className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-[0.14em] text-cyan-dark">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyan" />
            Test drive
          </span>
          <span className="flex items-center gap-1" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={
                  "h-1.5 w-5 rounded-full " + (n <= step ? "bg-cyan" : "bg-border")
                }
              />
            ))}
          </span>
          <span className="text-sm font-semibold text-text">{banner}</span>
          <button
            type="button"
            onClick={close}
            className="pointer-events-auto rounded-full border border-border px-3 py-1 font-mono text-xs text-text-dim transition-colors hover:border-cyan hover:text-text"
          >
            Exit
          </button>
        </div>

      <div className="pointer-events-auto w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface p-5 shadow-lg">
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-cyan-dark">
            Demo · Test drive
          </p>
          <button
            type="button"
            onClick={close}
            className="font-mono text-xs text-text-dim hover:text-text"
          >
            Close
          </button>
        </div>

        {instruction ? (
          <p className="mt-3 text-sm text-text">{instruction}</p>
        ) : null}

        {phase !== "start" && phase !== "end" ? (
          <>
            <h2 className="mt-2 font-display text-lg font-bold text-text">
              Checkpoint {label(startId)} to {label(endId)}
            </h2>

            {!route ? (
              <p className="mt-3 text-sm text-text-dim">
                No connected road leads from checkpoint {label(startId)} to{" "}
                {label(endId)}. Edges are one-way; click another checkpoint to
                start over.
              </p>
            ) : (
              <>
                <div className="mt-3 space-y-1 font-mono text-xs text-text-dim">
                  <p>
                    By road{" "}
                    <span className="text-text">{formatDistance(route.meters)}</span>
                    {" · "}straight line{" "}
                    <span className="text-text">
                      {formatDistance(route.straightMeters)}
                    </span>
                  </p>
                  <p>
                    Via checkpoints{" "}
                    {[route.hops[0].from, ...route.hops.map((hop) => hop.to)]
                      .map((node) => node.id_in_project)
                      .join(" → ")}
                  </p>
                </div>

                {phase === "ready" || phase === "done" ? (
                  <div className="mt-4">
                    <label className="flex items-baseline justify-between font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
                      Speed
                      <span className="text-base text-text">{speed} km/h</span>
                    </label>
                    <input
                      type="range"
                      min={MIN_SPEED}
                      max={MAX_SPEED}
                      step={5}
                      value={speed}
                      onChange={(event) => setSpeed(Number(event.target.value))}
                      className="mt-2 w-full accent-[var(--color-cyan)]"
                    />

                    <label className="mt-4 flex cursor-pointer items-center justify-between gap-3">
                      <span>
                        <span className="block font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
                          Kangaroo driving
                        </span>
                        <span className="block text-xs text-text-dim">
                          Brakes before every camera, speeds up between them.
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={kangaroo}
                        onChange={(event) => setKangaroo(event.target.checked)}
                        className="h-4 w-4 accent-[var(--color-cyan)]"
                      />
                    </label>

                    {kangaroo ? (
                      <div className="mt-3">
                        <label className="flex items-baseline justify-between font-mono text-xs font-semibold uppercase tracking-[0.14em] text-text-dim">
                          Speed at cameras
                          <span className="text-base text-text">
                            {Math.min(cameraSpeed, speed)} km/h
                          </span>
                        </label>
                        <input
                          type="range"
                          min={MIN_SPEED}
                          max={MAX_SPEED}
                          step={5}
                          value={cameraSpeed}
                          onChange={(event) => setCameraSpeed(Number(event.target.value))}
                          className="mt-2 w-full accent-[var(--color-cyan)]"
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {plate && table ? (
                  <div className="mt-4 space-y-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full bg-cyan"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                    <p className="font-mono text-xs text-text-dim">
                      {plate} · now {Math.round(liveSpeed)} km/h · cruise {speed} km/h
                      {kangaroo ? ` · kangaroo, ${Math.min(cameraSpeed, speed)} at cameras` : ""}
                      {" "}· real trip{" "}
                      {Math.round(table.realSeconds)} s · time-lapse ×
                      {table.timeLapse.toFixed(1)}
                    </p>
                    <ul className="space-y-2 pt-1">
                      {route.hops.map((hop, index) => (
                        <HopRow
                          key={hop.connection.connection_id}
                          from={hop.from.id_in_project}
                          to={hop.to.id_in_project}
                          meters={hop.meters}
                          limit={hop.connection.speed_limit}
                          passKmh={table.passKmh[index + 1]}
                          outcome={outcomes[index + 1] ?? null}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}

                <p className="mt-4 text-xs leading-relaxed text-text-dim">
                  Each checkpoint the car passes is sent to the server as a
                  camera sighting. The server decides the violation.
                </p>
              </>
            )}

            <div className="mt-5 flex items-center justify-end gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={reset}
                disabled={phase === "driving"}
              >
                New drive
              </Button>
              {route ? (
                <Button
                  size="sm"
                  arrow
                  onClick={drive}
                  disabled={phase === "driving"}
                >
                  {phase === "done" ? "Drive again" : "Drive"}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      </>
    );
  },
);

function HopRow({
  from,
  to,
  meters,
  limit,
  passKmh,
  outcome,
}: {
  from: number;
  to: number;
  meters: number;
  limit: number;
  /** How fast the car went past the camera at the end of this hop. */
  passKmh: number;
  outcome: Outcome;
}) {
  let verdict: React.ReactNode = (
    <span className="font-mono text-xs text-text-dim">Driving…</span>
  );
  if (outcome && "error" in outcome) {
    verdict = <span className="font-mono text-xs text-red">{outcome.error}</span>;
  } else if (outcome && outcome.status) {
    verdict = (
      <Badge tone="red" mono>
        Violation {formatSpeed(outcome.carSpeed)}
      </Badge>
    );
  } else if (outcome && outcome.reason === null) {
    verdict = (
      <Badge tone="green" mono>
        OK {formatSpeed(outcome.carSpeed)}
      </Badge>
    );
  } else if (outcome) {
    verdict = (
      <Badge tone="yellow" mono>
        {describeReason(outcome.reason)}
      </Badge>
    );
  }

  return (
    <li className="flex items-center justify-between gap-3 border-t border-border pt-2">
      <span className="font-mono text-xs text-text">
        {from} → {to}
        <span className="text-text-dim">
          {" "}
          · {formatDistance(meters)} · limit {formatSpeed(limit)}
          {outcome ? ` · passed camera at ${formatSpeed(passKmh)}` : ""}
        </span>
      </span>
      {verdict}
    </li>
  );
}

export default TestDrivePanel;
