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
import {
  haversineMeters,
  makeProjection,
  type LatLng,
  type Point,
  type Projection,
} from "@/lib/geo";
import {
  congestionColor,
  monoFamily,
  readTokens,
  withAlpha,
  type Tokens,
} from "@/lib/tokens";

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

/**
 * A checkpoint dropped somewhere new, waiting to be confirmed.
 *
 * The graph is geometrically faithful, so a drop point is a real WGS84
 * position and `metres` is how far the camera would actually move. Nothing is
 * written until an operator has seen that number and agreed to it.
 */
export type MoveDraft = {
  node: CheckpointNode;
  to: LatLng;
  metres: number;
};

export type GraphCanvasHandle = {
  /** Frames every checkpoint in the view. */
  fit: () => void;
  zoomBy: (factor: number) => void;
  /**
   * Drops the preview of a checkpoint that was dragged but not committed.
   *
   * The canvas holds a dropped checkpoint where it was dropped while the
   * confirmation is on screen, so the operator can read the dialog and look at
   * where the thing would land at the same time. Whoever owns that dialog owns
   * putting the preview away.
   */
  clearMove: () => void;
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
  /**
   * node_id -> one line saying what is wrong with that checkpoint's position.
   *
   * The canvas marks the checkpoints in here and repeats the line on hover,
   * and knows nothing else about diagnostics: what counts as wrong, and how to
   * say it, belongs with the panel that explains it at length.
   */
  nodeWarnings: Record<number, string>;
  selectedConnectionId: number | null;
  onSelectConnection: (connection: Connection | null) => void;
  onDraftEdge: (draft: EdgeDraft) => void;
  /** A checkpoint was dragged to a new position and wants confirming. */
  onDraftMove: (draft: MoveDraft) => void;
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
      nodeWarnings,
      selectedConnectionId,
      onSelectConnection,
      onDraftEdge,
      onDraftMove,
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
    const data = useRef({
      nodes,
      connections,
      congestionTargets,
      nodeWarnings,
      selectedConnectionId,
    });
    data.current = {
      nodes,
      connections,
      congestionTargets,
      nodeWarnings,
      selectedConnectionId,
    };

    /* Animated values. These move every frame, so they never touch React
       state: a congestion ramp or a flash decaying at 60fps would otherwise
       re-render the whole page for a colour change inside one canvas. */
    const congestionDisplay = useRef<Record<number, number>>({});
    const flashValues = useRef<Record<number, number>>({});
    const lastFlashSeq = useRef<number | null>(null);

    const interaction = useRef<{
      mode: "idle" | "panning" | "linking" | "moving";
      pointerId: number | null;
      originX: number;
      originY: number;
      panX: number;
      panY: number;
      linkFrom: CheckpointNode | null;
      moveNode: CheckpointNode | null;
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
      moveNode: null,
      pointerX: 0,
      pointerY: 0,
      moved: false,
      hoveredNodeId: null,
      hoveredConnectionId: null,
    });

    /* Where a dragged checkpoint currently sits, in world metres. Set while
       the drag is happening and kept afterwards, until the confirmation it
       raised is answered one way or the other. */
    const movePreview = useRef<{ nodeId: number; x: number; y: number } | null>(
      null,
    );

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

    const clearMove = useCallback(() => {
      if (!movePreview.current) return;
      movePreview.current = null;
      paintNow();
    }, [paintNow]);

    useImperativeHandle(
      ref,
      () => ({
        fit,
        zoomBy: (factor: number) =>
          zoomAt(factor, size.current.width / 2, size.current.height / 2),
        clearMove,
      }),
      [fit, zoomAt, clearMove],
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
        const { nodes: list, connections: edges, nodeWarnings: warnings } = data.current;
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

        // A checkpoint being dragged sits where the pointer left it, and every
        // edge touching it follows, so the operator can see what the new
        // geometry would look like before agreeing to it.
        const preview = movePreview.current;
        if (preview && positions.has(preview.nodeId)) {
          positions.set(preview.nodeId, { x: preview.x, y: preview.y });
        }

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
          const enforced = edge.distance_status === "ok";
          const noRoute = edge.distance_status === "no-route";
          const ratio = ratios[edge.connection_id];

          let color: string;
          // Status wins over congestion. An edge that cannot enforce must not
          // be painted as a working road by a ratio left over from before it
          // was downgraded.
          if (!enforced) color = noRoute ? tokens.red : tokens.yellow;
          else if (ratio !== undefined) color = congestionColor(ratio, tokens);
          else color = withAlpha(tokens.cyanDark, selected || hovered ? 1 : 0.55);

          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = (selected ? 4.5 : hovered ? 3.5 : EDGE_WIDTH) / zoom;
          ctx.lineCap = "round";

          // An edge with no resolved distance cannot enforce anything, so it
          // is drawn as an unfinished thing rather than a working one. The two
          // ways of being unresolved get two different strokes, because they
          // need two different fixes: dashes for "nobody has answered yet",
          // dots for "a driver answered, and there is no road there".
          if (!enforced) {
            ctx.setLineDash(
              noRoute ? [2 / zoom, 7 / zoom] : [10 / zoom, 8 / zoom],
            );
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

        /* Where a dragged checkpoint came from, so the move is legible as a
           move rather than as a checkpoint that has always been there. */
        if (preview) {
          const origin = list.find((node) => node.node_id === preview.nodeId);
          if (origin) {
            const from = nodeXY(origin);
            ctx.save();
            ctx.setLineDash([6 / zoom, 6 / zoom]);
            ctx.strokeStyle = withAlpha(tokens.textDim, 0.55);
            ctx.lineWidth = 1.5 / zoom;
            ctx.beginPath();
            ctx.arc(from.x, from.y, nodeRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(preview.x, preview.y);
            ctx.stroke();
            ctx.restore();
          }
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
          ctx.font = `600 ${(NODE_RADIUS * 0.72) / zoom}px ${monoFamily()}`;
          ctx.fillText(String(node.id_in_project), point.x, point.y + 0.5 / zoom);

          // A checkpoint whose position the data says is wrong. Marked rather
          // than recoloured: the node's own colour already means something
          // (it is a checkpoint, and it has just been triggered), and a bad
          // fix is a separate fact about the same thing.
          if (warnings[node.node_id]) {
            drawWarningBadge(ctx, tokens, point, nodeRadius, zoom);
          }
        }

        ctx.restore();

        drawScaleBar(ctx, tokens, view.current, size.current);
      },
      [isBidirectional, nodeXY, toWorld],
    );

    /* Redraw whenever the data behind the frame changes. */
    useEffect(() => {
      paintNow();
    }, [nodes, connections, nodeWarnings, selectedConnectionId, paintNow]);

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
        // Shift picks the checkpoint up; a plain drag draws an edge out of it.
        // Drawing the graph is the frequent action and keeps the unmodified
        // gesture; moving a camera changes what counts as speeding, so it is
        // the deliberate one - and it still has to be confirmed after that.
        if (event.shiftKey) {
          state.mode = "moving";
          state.moveNode = node;
          movePreview.current = {
            nodeId: node.node_id,
            ...nodeXY(node),
          };
        } else {
          state.mode = "linking";
          state.linkFrom = node;
        }
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

      if (state.mode === "moving" && state.moveNode) {
        state.moved = true;
        const world = toWorld(x, y);
        movePreview.current = {
          nodeId: state.moveNode.node_id,
          x: world.x,
          y: world.y,
        };
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
          const warning = nodeWarnings[node.node_id];
          setHover({
            x,
            y,
            lines: [
              `Checkpoint ${node.id_in_project}`,
              `${node.latitude.toFixed(5)}, ${node.longitude.toFixed(5)}`,
              ...(warning ? [warning] : []),
              "Drag to another checkpoint to link",
              "Shift-drag to correct its position",
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
              `${describeDistance(edge)} · ${formatSpeed(edge.speed_limit)}`,
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

      if (state.mode === "moving" && state.moveNode) {
        const node = state.moveNode;
        const proj = projection.current;
        state.moveNode = null;
        state.mode = "idle";

        // A shift-click that never moved is not a move. The preview goes with
        // it, so nothing is left sitting under a dialog that never opened.
        if (!state.moved || !proj) {
          movePreview.current = null;
          paintNow();
          return;
        }

        const to = proj.unproject(world.x, world.y);
        movePreview.current = { nodeId: node.node_id, x: world.x, y: world.y };
        paintNow();
        onDraftMove({
          node,
          to,
          metres: haversineMeters(
            { lat: node.latitude, lng: node.longitude },
            to,
          ),
        });
        return;
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
      // A drag that leaves the canvas is abandoned, and an abandoned move
      // leaves the checkpoint where it was.
      if (state.mode === "moving") movePreview.current = null;
      state.mode = "idle";
      state.linkFrom = null;
      state.moveNode = null;
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
        : state.mode === "moving"
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

/**
 * The distance line in an edge's tooltip.
 *
 * An unresolved edge says which kind of unresolved it is, because that is the
 * whole difference between waiting and fixing something.
 */
function describeDistance(edge: Connection): string {
  if (edge.distance_status === "ok") return formatDistance(edge.distance);
  if (edge.distance_status === "no-route") return "no road found";
  return "no distance resolved";
}

/**
 * The mark on a checkpoint whose position looks wrong.
 *
 * Sized in screen pixels rather than metres, like the checkpoints themselves:
 * it is a piece of interface attached to a position, not a thing on the
 * ground, and it has to stay legible at every zoom. Drawn on the upper right,
 * where an edge is least likely to be underneath it.
 */
function drawWarningBadge(
  ctx: CanvasRenderingContext2D,
  tokens: Tokens,
  point: Point,
  nodeRadius: number,
  zoom: number,
) {
  const diagonal = 0.7071;
  const cx = point.x + nodeRadius * diagonal;
  const cy = point.y - nodeRadius * diagonal;
  const radius = 8 / zoom;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = tokens.yellow;
  ctx.fill();
  // A ring in the page colour, so the badge reads as a badge rather than as
  // part of whatever it happens to overlap.
  ctx.lineWidth = 2 / zoom;
  ctx.strokeStyle = tokens.bg;
  ctx.stroke();

  ctx.fillStyle = tokens.text;
  ctx.font = `700 ${11 / zoom}px ${monoFamily()}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", cx, cy + 0.5 / zoom);
  ctx.restore();
}

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

  ctx.font = `500 11px ${monoFamily()}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(formatDistance(step), x, y - 8);
  ctx.restore();
}
