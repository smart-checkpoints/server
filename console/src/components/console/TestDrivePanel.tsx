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
    { apiKey, nodes, connections, geometry, onVehicle, onClose },
    ref,
  ) {
    const [phase, setPhase] = useState<Phase>("start");
    const [startId, setStartId] = useState<number | null>(null);
    const [endId, setEndId] = useState<number | null>(null);
    const [speed, setSpeed] = useState(80);
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
    }, [stop, onVehicle]);

    useImperativeHandle(
      ref,
      () => ({
        pick: (nodeId: number) => {
          if (phase === "driving") return;
          if (phase === "end") {
            if (nodeId === startId) return;
            setEndId(nodeId);
            setPhase("ready");
            const planned =
              startId === null ? null : planRoute(startId, nodeId, nodes, connections);
            if (planned) {
              const limit = Math.max(...planned.hops.map((hop) => hop.connection.speed_limit));
              setSpeed(Math.min(MAX_SPEED, Math.round((limit + 20) / 10) * 10));
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
        },
      }),
      [phase, startId, nodes, connections, onVehicle],
    );

    const drive = useCallback(() => {
      if (!route) return;
      stop();
      cancelled.current = false;

      const carPlate = randomDemoPlate();
      const plan = timetable(route, speed, Date.now());
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

      const vehicleAt = (fraction: number): VehicleFrame => {
        const at = positionAt(track, fraction);
        const hop = route.hops[at.hopIndex];
        return {
          fromNodeId: hop.from.node_id,
          toNodeId: hop.to.node_id,
          t: at.hopT,
          position: at.position,
          label: `${carPlate} · ${speed} km/h`,
          violation,
        };
      };

      report(0);
      let reported = 1;
      const began = performance.now();
      const playMs = plan.playSeconds * 1000;

      const step = (now: number) => {
        if (cancelled.current) return;
        const fraction = playMs <= 0 ? 1 : Math.min(1, (now - began) / playMs);
        while (
          reported < plan.fractions.length &&
          plan.fractions[reported] <= fraction + 1e-9
        ) {
          report(reported);
          reported += 1;
        }
        onVehicle(vehicleAt(fraction));
        setProgress(fraction);

        if (fraction < 1) {
          frame.current = requestAnimationFrame(step);
          return;
        }
        frame.current = null;
        void chain.then(() => {
          if (cancelled.current) return;
          onVehicle(vehicleAt(1));
          setPhase("done");
        });
      };

      frame.current = requestAnimationFrame(step);
    }, [route, speed, geometry, apiKey, onVehicle, stop]);

    const close = () => {
      stop();
      onVehicle(null);
      onClose();
    };

    const instruction =
      phase === "start"
        ? "Click the checkpoint the car starts from."
        : phase === "end"
          ? `From checkpoint ${label(startId)}. Click where it drives to.`
          : null;

    return (
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
                      {plate} · {speed} km/h · real trip{" "}
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
    );
  },
);

function HopRow({
  from,
  to,
  meters,
  limit,
  outcome,
}: {
  from: number;
  to: number;
  meters: number;
  limit: number;
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
        </span>
      </span>
      {verdict}
    </li>
  );
}

export default TestDrivePanel;
