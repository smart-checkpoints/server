"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { CheckpointNode, Connection } from "@/lib/api";
import { formatDistance, formatSpeed } from "@/lib/format";
import { makeProjection, type Point, type Projection } from "@/lib/geo";
import { congestionColor, readTokens, withAlpha, type Tokens } from "@/lib/tokens";

/* ---------------------------------------------------------------------------
   Screen constants.

   World units are metres, and a real project spans kilometres of them, while
   everything an operator points at is measured in pixels. Each of these is
   divided by `zoom` inside the transform so a checkpoint stays the same size,
   and stays as clickable, whether the view holds one junction or a whole city.
   --------------------------------------------------------------------------- */
const NODE_RADIUS = 22;
const NODE_STROKE = 3;
const ARROW_LENGTH = 11;
const ARROW_HALF_WIDTH = 5;
const EDGE_WIDTH = 2.5;
const EDGE_HIT_SLOP = 9;
/** Perpendicular separation for a pair of edges running both ways. */
const EDGE_OFFSET = 7;

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 8;

export type EdgeDraft = {
  from: CheckpointNode;
  to: CheckpointNode;
};

export type GraphCanvasHandle = {
  /** Frames every checkpoint in the view. */
  fit: () => void;
  zoomBy: (factor: number) => void;
};

type HoverInfo = {
  x: number;
  y: number;
  lines: string[];
};

/**
 * A checkpoint that has just been triggered. The sequence number is what makes
 * two sightings at the same checkpoint two separate flashes.
 */
export type FlashSignal = {
  idInProject: number;
  seq: number;
};

type GraphCanvasProps = {
  nodes: CheckpointNode[];
  connections: Connection[];
  /** connection_id -> congestion ratio C, where 1 is free-flowing. */
  congestionTargets: Record<number, number>;
  /** The most recent checkpoint sighting, or null before the first one. */
  flash: FlashSignal | null;
  selectedConnectionId: number | null;
  onSelectConnection: (connection: Connection | null) => void;
  onDraftEdge: (draft: EdgeDraft) => void;
};

/** How fast a congestion colour moves toward its new value, per frame. */
const CONGESTION_LERP = 0.12;
/** A flash is a second and a bit at 60fps. */
const FLASH_DECAY = 0.016;

/**
 * The checkpoint graph.
 *
 * Nodes carry WGS84 degrees; the canvas works in metres on a local tangent
 * plane. The origin is the centroid of the checkpoints present when the
 * project loads and stays fixed for the session; recomputing it as nodes
 * arrive would make the whole view jump under the operator mid-drag.
 *
 * Colour follows the same rule as the rest of the system. The accent draws
 * structure: checkpoints and the edges between them. The status colours are
 * reserved for things that are actually wrong or actually measured: an edge
 * with no resolved distance, and live congestion.
 */
const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvas(
    {
      nodes,
      connections,
      congestionTargets,
      flash,
      selectedConnectionId,
      onSelectConnection,
      onDraftEdge,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const [hover, setHover] = useState<HoverInfo | null>(null);

    /* The view. Held in refs, not state: panning redraws every frame and must
       not re-render React on the way. */
    const view = useRef({ panX: 0, panY: 0, zoom: 1 });
    const size = useRef({ width: 0, height: 0 });
    const projection = useRef<Projection | null>(null);
    const framed = useRef(false);

    /* Live props for the draw loop, which is not re-created per render. */
    const data = useRef({ nodes, connections, congestionTargets, selectedConnectionId });
    data.current = { nodes, connections, congestionTargets, selectedConnectionId };

    /* Animated values. These move every frame, so they never touch React
       state: a congestion ramp or a flash decaying at 60fps would otherwise
       re-render the whole page for a colour change inside one canvas. */
    const congestionDisplay = useRef<Record<number, number>>({});
    const flashValues = useRef<Record<number, number>>({});
    const lastFlashSeq = useRef<number | null>(null);

    const interaction = useRef<{
      mode: "idle" | "panning" | "linking";
      pointerId: number | null;
      originX: number;
      originY: number;
      panX: number;
      panY: number;
      linkFrom: CheckpointNode | null;
      pointerX: number;
      pointerY: number;
      moved: boolean;
      hoveredNodeId: number | null;
      hoveredConnectionId: number | null;
    }>({
      mode: "idle",
      pointerId: null,
      originX: 0,
      originY: 0,
      panX: 0,
      panY: 0,
      linkFrom: null,
      pointerX: 0,
      pointerY: 0,
      moved: false,
      hoveredNodeId: null,
      hoveredConnectionId: null,
    });

    /* The painter, published by the setup effect once it has a context.
       Everything that changes what is on screen calls it directly: a canvas
       has no render tree to diff, so there is nothing to gain by deferring a
       repaint to the next frame, and a permanent animation loop would burn a
       frame every 16ms redrawing a graph that is not moving. */
    const painter = useRef<(() => void) | null>(null);
    const paintNow = useCallback(() => {
      painter.current?.();
    }, []);

    /* Animation frames are asked for only while congestion colours are moving
       or a flash is fading, and stop as soon as everything has settled. */
    const frameRef = useRef<number | null>(null);

    /* ---------------------------------------------------------------------
       Projection and coordinate transforms
       --------------------------------------------------------------------- */

    const ensureProjection = useCallback(() => {
      if (projection.current || data.current.nodes.length === 0) return;
      let sumLat = 0;
      let sumLng = 0;
      for (const node of data.current.nodes) {
        sumLat += node.latitude;
        sumLng += node.longitude;
      }
      const count = data.current.nodes.length;
      projection.current = makeProjection(sumLat / count, sumLng / count);
    }, []);

    const nodeXY = useCallback(
      (node: CheckpointNode): Point => {
        ensureProjection();
        if (!projection.current) return { x: 0, y: 0 };
        return projection.current.project(node.latitude, node.longitude);
      },
      [ensureProjection],
    );

    const toWorld = useCallback((sx: number, sy: number): Point => {
      const { panX, panY, zoom } = view.current;
      return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
    }, []);

    const fit = useCallback(() => {
      ensureProjection();
      const { width, height } = size.current;
      const list = data.current.nodes;
      if (!projection.current || list.length === 0 || width === 0) return;

      const points = list.map(nodeXY);
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minY = Math.min(...points.map((p) => p.y));
      const maxY = Math.max(...points.map((p) => p.y));

      // Room for the circles, which are drawn at a screen-constant radius
      // outside the bounding box of the centres.
      const padding = NODE_RADIUS * 3.5;
      const spanX = maxX - minX;
      const spanY = maxY - minY;
      const fitZoom =
        spanX === 0 && spanY === 0
          ? 1
          : Math.min(
              (width - padding * 2) / (spanX || 1),
              (height - padding * 2) / (spanY || 1),
            );

      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
      view.current = {
        zoom,
        panX: width / 2 - ((minX + maxX) / 2) * zoom,
        panY: height / 2 - ((minY + maxY) / 2) * zoom,
      };
      paintNow();
    }, [ensureProjection, nodeXY, paintNow]);

    const zoomAt = useCallback(
      (factor: number, sx: number, sy: number) => {
        const { panX, panY, zoom } = view.current;
        const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
        view.current = {
          zoom: next,
          panX: sx - (sx - panX) * (next / zoom),
          panY: sy - (sy - panY) * (next / zoom),
        };
        paintNow();
      },
      [paintNow],
    );

    useImperativeHandle(
      ref,
      () => ({
        fit,
        zoomBy: (factor: number) =>
          zoomAt(factor, size.current.width / 2, size.current.height / 2),
      }),
      [fit, zoomAt],
    );

    /* ---------------------------------------------------------------------
       Hit testing, in world metres
       --------------------------------------------------------------------- */

    const nodeAt = useCallback(
      (wx: number, wy: number): CheckpointNode | null => {
        const radius = NODE_RADIUS / view.current.zoom;
        const list = data.current.nodes;
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const point = nodeXY(list[i]);
          if (Math.hypot(wx - point.x, wy - point.y) <= radius) return list[i];
        }
        return null;
      },
      [nodeXY],
    );

    const isBidirectional = useCallback((from: number, to: number) => {
      return data.current.connections.some(
        (candidate) =>
          candidate.from_node_id === to && candidate.to_node_id === from,
      );
    }, []);

    const connectionAt = useCallback(
      (wx: number, wy: number): Connection | null => {
        const threshold = EDGE_HIT_SLOP / view.current.zoom;
        const offsetStep = EDGE_OFFSET / view.current.zoom;
        const list = data.current.connections;

        for (let i = list.length - 1; i >= 0; i -= 1) {
          const edge = list[i];
          const from = data.current.nodes.find((n) => n.node_id === edge.from_node_id);
          const to = data.current.nodes.find((n) => n.node_id === edge.to_node_id);
          if (!from || !to) continue;

          const a = nodeXY(from);
          const b = nodeXY(to);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy);
          if (length === 0) continue;

          const offset = isBidirectional(edge.from_node_id, edge.to_node_id)
            ? offsetStep
            : 0;
          const px = (-dy / length) * offset;
          const py = (dx / length) * offset;

          if (
            distanceToSegment(wx, wy, a.x + px, a.y + py, b.x + px, b.y + py) <=
            threshold
          ) {
            return edge;
          }
        }
        return null;
      },
      [isBidirectional, nodeXY],
    );

    /* ---------------------------------------------------------------------
       Drawing
       --------------------------------------------------------------------- */

    useEffect(() => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const tokens = readTokens();

      const resize = () => {
        const ratio = window.devicePixelRatio || 1;
        const width = wrap.clientWidth;
        const height = wrap.clientHeight;
        const firstSizing = size.current.width === 0;

        size.current = { width, height };
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

        if (firstSizing) {
          view.current.panX = width / 2;
          view.current.panY = height / 2;
        }
        paintNow();
      };

      painter.current = () => paint(ctx, tokens);

      const observer = new ResizeObserver(resize);
      observer.observe(wrap);
      resize();

      // Draw once here rather than waiting for anything. A tab that mounts in
      // the background is given no animation frames at all, and the graph
      // should already be on screen the moment that tab is looked at.
      painter.current();

      return () => {
        painter.current = null;
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        observer.disconnect();
      };
      // `paint` reads everything it needs from refs, so the context is set up
      // once and never torn down by a prop change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paintNow]);

    /**
     * Moves congestion colours toward their targets and lets flashes fade.
     * Returns true while anything is still moving, which is what decides
     * whether another frame is worth asking for.
     */
    const advanceAnimation = useCallback((): boolean => {
      let moving = false;

      const targets = data.current.congestionTargets;
      for (const key of Object.keys(targets)) {
        const id = Number(key);
        const target = targets[id];
        const current = congestionDisplay.current[id];
        if (current === undefined) {
          congestionDisplay.current[id] = target;
          moving = true;
        } else if (Math.abs(current - target) > 0.005) {
          congestionDisplay.current[id] = current + (target - current) * CONGESTION_LERP;
          moving = true;
        }
      }

      for (const key of Object.keys(flashValues.current)) {
        const id = Number(key);
        const next = flashValues.current[id] - FLASH_DECAY;
        if (next <= 0) delete flashValues.current[id];
        else flashValues.current[id] = next;
        moving = true;
      }

      return moving;
    }, []);

    /** Runs frames until nothing is moving any more, then stops asking. */
    const animate = useCallback(() => {
      if (frameRef.current !== null) return;

      const step = () => {
        frameRef.current = null;
        if (!advanceAnimation()) return;
        painter.current?.();
        frameRef.current = requestAnimationFrame(step);
      };

      frameRef.current = requestAnimationFrame(step);
    }, [advanceAnimation]);

    /* A new sighting lights its checkpoint. Same checkpoint twice is two
       flashes, which is what the sequence number is for. */
    useEffect(() => {
      if (!flash || flash.seq === lastFlashSeq.current) return;
      lastFlashSeq.current = flash.seq;
      flashValues.current[flash.idInProject] = 1;
      animate();
    }, [flash, animate]);

    /** One frame. Reads refs only. */
    const paint = useCallback(
      (ctx: CanvasRenderingContext2D, tokens: Tokens) => {
        const { width, height } = size.current;
        const { panX, panY, zoom } = view.current;
        const { nodes: list, connections: edges } = data.current;
        const ratios = congestionDisplay.current;
        const pulses = flashValues.current;
        const state = interaction.current;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = tokens.bg;
        ctx.fillRect(0, 0, width, height);

        drawGrid(ctx, tokens, view.current, size.current);

        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);

        const positions = new Map<number, Point>();
        for (const node of list) positions.set(node.node_id, nodeXY(node));

        /* Edges under nodes, so a checkpoint is never covered by its own road. */
        const nodeRadius = NODE_RADIUS / zoom;
        const arrowLength = ARROW_LENGTH / zoom;
        const arrowHalf = ARROW_HALF_WIDTH / zoom;
        const offsetStep = EDGE_OFFSET / zoom;

        for (const edge of edges) {
          const a = positions.get(edge.from_node_id);
          const b = positions.get(edge.to_node_id);
          if (!a || !b) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.hypot(dx, dy);
          if (length === 0) continue;

          const ux = dx / length;
          const uy = dy / length;
          const offset = isBidirectional(edge.from_node_id, edge.to_node_id)
            ? offsetStep
            : 0;
          const px = -uy * offset;
          const py = ux * offset;

          const startX = a.x + px + ux * nodeRadius;
          const startY = a.y + py + uy * nodeRadius;
          const tipX = b.x + px - ux * nodeRadius;
          const tipY = b.y + py - uy * nodeRadius;
          const shaftX = tipX - ux * arrowLength;
          const shaftY = tipY - uy * arrowLength;

          const selected = data.current.selectedConnectionId === edge.connection_id;
          const hovered = state.hoveredConnectionId === edge.connection_id;
          const unresolved = !edge.distance || edge.distance <= 0;
          const ratio = ratios[edge.connection_id];

          let color: string;
          if (ratio !== undefined) color = congestionColor(ratio, tokens);
          else if (unresolved) color = tokens.yellow;
          else color = withAlpha(tokens.cyanDark, selected || hovered ? 1 : 0.55);

          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = (selected ? 4.5 : hovered ? 3.5 : EDGE_WIDTH) / zoom;
          ctx.lineCap = "round";

          // An edge with no resolved distance cannot enforce anything, so it
          // is drawn as an unfinished thing rather than a working one.
          if (unresolved && ratio === undefined) {
            ctx.setLineDash([10 / zoom, 8 / zoom]);
          }

          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(shaftX, shaftY);
          ctx.stroke();
          ctx.setLineDash([]);

          // The head is a triangle on the shaft's own perpendicular, so it
          // stays square to the edge at every angle and every zoom.
          const headX = -uy * arrowHalf;
          const headY = ux * arrowHalf;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(shaftX - headX, shaftY - headY);
          ctx.lineTo(shaftX + headX, shaftY + headY);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        /* The edge being drawn out of a checkpoint. */
        if (state.mode === "linking" && state.linkFrom) {
          const from = positions.get(state.linkFrom.node_id);
          if (from) {
            const to = toWorld(state.pointerX, state.pointerY);
            ctx.save();
            ctx.setLineDash([9 / zoom, 7 / zoom]);
            ctx.strokeStyle = withAlpha(tokens.cyan, 0.75);
            ctx.lineWidth = 2.5 / zoom;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
            ctx.restore();
          }
        }

        /* Checkpoints. */
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        for (const node of list) {
          const point = positions.get(node.node_id);
          if (!point) continue;

          const hovered = state.hoveredNodeId === node.node_id;
          const linking = state.linkFrom?.node_id === node.node_id;
          const pulse = pulses[node.id_in_project] ?? 0;

          if (pulse > 0) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, nodeRadius + (12 * pulse) / zoom, 0, Math.PI * 2);
            ctx.fillStyle = withAlpha(tokens.red, 0.3 * pulse);
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(point.x, point.y, nodeRadius, 0, Math.PI * 2);
          ctx.fillStyle =
            pulse > 0
              ? withAlpha(tokens.red, 0.12 + 0.25 * pulse)
              : linking || hovered
                ? tokens.surfaceHover
                : tokens.surface;
          ctx.fill();

          ctx.lineWidth = NODE_STROKE / zoom;
          ctx.strokeStyle =
            pulse > 0 ? tokens.red : hovered || linking ? tokens.cyanHover : tokens.cyan;
          ctx.stroke();

          ctx.fillStyle = pulse > 0 ? tokens.red : tokens.cyanDark;
          ctx.font = `600 ${(NODE_RADIUS * 0.72) / zoom}px var(--font-jetbrains-mono), monospace`;
          ctx.fillText(String(node.id_in_project), point.x, point.y + 0.5 / zoom);
        }

        ctx.restore();

        drawScaleBar(ctx, tokens, view.current, size.current);
      },
      [isBidirectional, nodeXY, toWorld],
    );

    /* Redraw whenever the data behind the frame changes. */
    useEffect(() => {
      paintNow();
    }, [nodes, connections, selectedConnectionId, paintNow]);

    /* New congestion figures do not snap: the colour walks to them. */
    useEffect(() => {
      animate();
    }, [congestionTargets, animate]);

    /* Frame the graph the first time checkpoints arrive. */
    useEffect(() => {
      if (framed.current || nodes.length === 0) return;
      framed.current = true;
      fit();
    }, [nodes, fit]);

    /* ---------------------------------------------------------------------
       Pointer interaction
       --------------------------------------------------------------------- */

    const localPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const state = interaction.current;
      const { x, y } = localPoint(event);
      const world = toWorld(x, y);

      // Capture keeps a drag alive when the pointer leaves the canvas. It
      // throws if the pointer is already gone by the time this runs, which is
      // not a reason to drop the interaction.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        state.pointerId = event.pointerId;
      } catch {
        state.pointerId = null;
      }

      state.pointerX = x;
      state.pointerY = y;
      state.moved = false;

      // Middle button always pans, whatever is under it.
      const node = event.button === 1 ? null : nodeAt(world.x, world.y);
      if (node) {
        state.mode = "linking";
        state.linkFrom = node;
        paintNow();
        return;
      }

      state.mode = "panning";
      state.originX = x;
      state.originY = y;
      state.panX = view.current.panX;
      state.panY = view.current.panY;
    };

    const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const state = interaction.current;
      const { x, y } = localPoint(event);
      state.pointerX = x;
      state.pointerY = y;

      if (state.mode === "panning") {
        state.moved = true;
        view.current.panX = state.panX + (x - state.originX);
        view.current.panY = state.panY + (y - state.originY);
        paintNow();
        return;
      }

      if (state.mode === "linking") {
        state.moved = true;
        paintNow();
        return;
      }

      const world = toWorld(x, y);
      const node = nodeAt(world.x, world.y);
      const edge = node ? null : connectionAt(world.x, world.y);

      const changed =
        state.hoveredNodeId !== (node?.node_id ?? null) ||
        state.hoveredConnectionId !== (edge?.connection_id ?? null);

      state.hoveredNodeId = node?.node_id ?? null;
      state.hoveredConnectionId = edge?.connection_id ?? null;

      if (changed) {
        if (node) {
          setHover({
            x,
            y,
            lines: [
              `Checkpoint ${node.id_in_project}`,
              `${node.latitude.toFixed(5)}, ${node.longitude.toFixed(5)}`,
              "Drag to another checkpoint to link",
            ],
          });
        } else if (edge) {
          const from = nodes.find((n) => n.node_id === edge.from_node_id);
          const to = nodes.find((n) => n.node_id === edge.to_node_id);
          setHover({
            x,
            y,
            lines: [
              `Checkpoint ${from?.id_in_project ?? "?"} to ${to?.id_in_project ?? "?"}`,
              `${
                edge.distance > 0
                  ? formatDistance(edge.distance)
                  : "no distance resolved"
              } · ${formatSpeed(edge.speed_limit)}`,
            ],
          });
        } else {
          setHover(null);
        }
        paintNow();
      } else if (hover) {
        setHover({ ...hover, x, y });
      }
    };

    const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const state = interaction.current;
      const { x, y } = localPoint(event);
      const world = toWorld(x, y);

      if (state.pointerId !== null) {
        try {
          event.currentTarget.releasePointerCapture(state.pointerId);
        } catch {
          // Already released, which is the outcome we wanted.
        }
        state.pointerId = null;
      }

      if (state.mode === "linking" && state.linkFrom) {
        const target = nodeAt(world.x, world.y);
        if (target && target.node_id !== state.linkFrom.node_id) {
          onDraftEdge({ from: state.linkFrom, to: target });
        }
        state.linkFrom = null;
        state.mode = "idle";
        paintNow();
        return;
      }

      if (state.mode === "panning" && !state.moved) {
        // A click that did not drag is a selection.
        onSelectConnection(connectionAt(world.x, world.y));
      }

      state.mode = "idle";
      paintNow();
    };

    const onPointerLeave = () => {
      const state = interaction.current;
      state.mode = "idle";
      state.linkFrom = null;
      state.hoveredNodeId = null;
      state.hoveredConnectionId = null;
      setHover(null);
      paintNow();
    };

    /* Wheel is registered by hand: React's synthetic wheel listener is passive
       and cannot preventDefault, which would let the page scroll under a zoom. */
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        zoomAt(
          event.deltaY < 0 ? 1.1 : 0.9,
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      };

      canvas.addEventListener("wheel", onWheel, { passive: false });
      return () => canvas.removeEventListener("wheel", onWheel);
    }, [zoomAt]);

    const state = interaction.current;
    const cursor =
      state.mode === "panning"
        ? "grabbing"
        : state.mode === "linking"
          ? "crosshair"
          : state.hoveredNodeId !== null || state.hoveredConnectionId !== null
            ? "pointer"
            : "grab";

    return (
      <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
        <canvas
          ref={canvasRef}
          className="block h-full w-full touch-none"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerLeave}
          onPointerLeave={onPointerLeave}
          onContextMenu={(event) => event.preventDefault()}
        />

        {hover ? (
          <div
            className="pointer-events-none absolute z-20 max-w-64 rounded-xl border border-border bg-surface px-3 py-2 shadow-md"
            style={{
              left: Math.min(hover.x + 16, Math.max(0, size.current.width - 260)),
              top: Math.min(hover.y + 16, Math.max(0, size.current.height - 96)),
            }}
          >
            <p className="font-display text-xs font-bold text-text">
              {hover.lines[0]}
            </p>
            {hover.lines.slice(1).map((line) => (
              <p key={line} className="mt-1 font-mono text-xs text-text-dim">
                {line}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
);

export default GraphCanvas;

/* ---------------------------------------------------------------------------
   Canvas helpers
   --------------------------------------------------------------------------- */

function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared),
  );
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * The step for the grid and the scale bar: 1, 2 or 5 times a power of ten
 * metres, chosen so one square is somewhere between 70 and 180 pixels at the
 * current zoom. Rounded steps are what make the grid readable as distance.
 */
function gridStepMeters(zoom: number): number {
  const target = 110 / zoom;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const multiple of [1, 2, 5, 10]) {
    if (magnitude * multiple >= target) return magnitude * multiple;
  }
  return magnitude * 10;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  tokens: Tokens,
  view: { panX: number; panY: number; zoom: number },
  size: { width: number; height: number },
) {
  const { panX, panY, zoom } = view;
  const step = gridStepMeters(zoom);
  const pixelStep = step * zoom;
  if (pixelStep < 8) return;

  const startX = Math.floor(-panX / pixelStep) * pixelStep + panX;
  const startY = Math.floor(-panY / pixelStep) * pixelStep + panY;

  ctx.save();
  ctx.lineWidth = 1;

  for (let x = startX; x <= size.width; x += pixelStep) {
    // Every fifth line is the stronger one, so the eye can count squares.
    const index = Math.round((x - panX) / pixelStep);
    ctx.strokeStyle = withAlpha(tokens.borderStrong, index % 5 === 0 ? 0.5 : 0.25);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, size.height);
    ctx.stroke();
  }

  for (let y = startY; y <= size.height; y += pixelStep) {
    const index = Math.round((y - panY) / pixelStep);
    ctx.strokeStyle = withAlpha(tokens.borderStrong, index % 5 === 0 ? 0.5 : 0.25);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(size.width, Math.round(y) + 0.5);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * The scale bar. This system enforces speed over real driving distance, so the
 * view says out loud how far a screen length actually is.
 */
function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  tokens: Tokens,
  view: { zoom: number },
  size: { width: number; height: number },
) {
  const step = gridStepMeters(view.zoom);
  const pixels = step * view.zoom;
  if (!Number.isFinite(pixels) || pixels < 8) return;

  const x = 24;
  const y = size.height - 28;

  ctx.save();
  ctx.strokeStyle = tokens.textDim;
  ctx.fillStyle = tokens.textDim;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "butt";

  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + pixels, y);
  ctx.lineTo(x + pixels, y - 5);
  ctx.stroke();

  ctx.font = "500 11px var(--font-jetbrains-mono), monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(formatDistance(step), x, y - 8);
  ctx.restore();
}
