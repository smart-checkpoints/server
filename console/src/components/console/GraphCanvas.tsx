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
import { houseEase } from "@/lib/ease";
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
  /** Ground metres per screen pixel at the current zoom, for a scale bar. */
  metresPerPixel: () => number;
  /**
   * Drops the preview of a checkpoint that was dragged but not committed.
   *
   * The canvas holds a dropped checkpoint where it was dropped while the
   * confirmation is on screen, so the operator can read the dialog and look at
   * where the thing would land at the same time. Whoever owns that dialog owns
   * putting the preview away.
   */
  clearMove: () => void;

  /* The agent's view of the canvas. Points are in viewport (client) pixels,
     so an overlay positioned over the whole window can use them directly.
     All of them return null when there is nothing to point at yet. */

  /** Where a coordinate is on screen. Creates the projection if none exists. */
  latLngToClient: (lat: number, lng: number) => Point | null;
  nodeToClient: (nodeId: number) => Point | null;
  /** The midpoint of an edge as drawn, two-way offset included. */
  edgeToClient: (connectionId: number) => Point | null;
  /** Both ends of an edge as drawn, two-way offset included. */
  edgeEndsToClient: (connectionId: number) => { a: Point; b: Point } | null;
  /** Whether a coordinate is on screen with `margin` pixels to spare. */
  isVisible: (lat: number, lng: number, margin?: number) => boolean;
  /**
   * Moves the camera, smoothly, to frame every checkpoint plus `extra`
   * coordinates that are about to matter (where checkpoints will appear).
   */
  frame: (extra?: LatLng[], durationMs?: number) => void;
  /** Moves the camera, smoothly, to frame only these coordinates. */
  focus: (points: LatLng[], durationMs?: number) => void;
  /** Called after every repaint: pan, zoom, camera moves, data changes. */
  subscribe: (listener: () => void) => () => void;
  /**
   * Places a demo project's test car, or removes it with null. Imperative
   * because it moves every frame, and a prop would re-render the page to do it.
   */
  setVehicle: (vehicle: CanvasVehicle | null) => void;
};

/** A test car on the straight line of one edge, `t` of the way along it. */
export type CanvasVehicle = {
  fromNodeId: number;
  toNodeId: number;
  t: number;
  label: string;
  violation: boolean;
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
  /** Edges and checkpoints the agent is pointing out. Display only. */
  highlightedConnectionIds?: number[];
  highlightedNodeIds?: number[];
  /** Hover cards off, for screen recording. */
  showHover?: boolean;
  /** A checkpoint clicked without dragging. */
  onClickNode?: (node: CheckpointNode) => void;
  /**
   * A test drive is picking checkpoints: a press on one is a pick, never a
   * move or a new edge.
   */
  pickMode?: boolean;
  /** The checkpoints a test drive has picked, ringed and named on the canvas. */
  picks?: { start: number | null; end: number | null };
  /** The checkpoint open in the inspector: ringed, with its street named under it. */
  selectedNodeId?: number | null;
  /** node_id -> street (and landmark), for hover cards and the selected label. */
  nodeLabels?: Record<number, string>;
  /** A faint OpenStreetMap basemap under the graph. */
  basemap?: boolean;
  /** Right-click: where on the ground (null before the first checkpoint) and where on screen. */
  onContextMenu?: (at: LatLng | null, client: Point) => void;
};

const NO_LABELS: Record<number, string> = {};

/** A stable empty list, so a missing prop does not repaint every render. */
const EMPTY_IDS: number[] = [];

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
/**
 * The part of the canvas the camera frames into. The canvas runs edge to edge
 * under an open drawer on the left (`--drawer-inset`) and Sayes floating on
 * the right (`--sayes-inset`); framing in what they leave keeps no
 * checkpoint under either.
 */
function usableSpan(fullWidth: number) {
  if (typeof document === "undefined") return { left: 0, width: fullWidth };
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  const left = read("--drawer-inset");
  const right = read("--sayes-inset");
  const width = fullWidth - left - right;
  // A window too narrow for both keeps the whole canvas rather than a sliver.
  return width < fullWidth * 0.35 ? { left: 0, width: fullWidth } : { left, width };
}

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
      highlightedConnectionIds = EMPTY_IDS,
      highlightedNodeIds = EMPTY_IDS,
      showHover = true,
      onClickNode,
      pickMode = false,
      picks,
      selectedNodeId = null,
      nodeLabels = NO_LABELS,
      basemap = false,
      onContextMenu,
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
      highlightedConnectionIds,
      highlightedNodeIds,
      picks,
      pickMode,
      selectedNodeId,
      nodeLabels,
      basemap,
    });
    data.current = {
      nodes,
      connections,
      congestionTargets,
      nodeWarnings,
      selectedConnectionId,
      highlightedConnectionIds,
      highlightedNodeIds,
      picks,
      pickMode,
      selectedNodeId,
      nodeLabels,
      basemap,
    };

    /* OSM tiles, kept between frames; a loaded tile repaints the canvas. */
    const tiles = useRef(new Map<string, HTMLImageElement>());

    /* Whoever is drawing over the canvas, told after each repaint. */
    const listeners = useRef(new Set<() => void>());
    /* The camera animation in flight, if any. */
    const cameraFrame = useRef<number | null>(null);

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

    /** The view that frames `points` (world metres), or null with no room yet. */
    const viewFor = useCallback((points: Point[]) => {
      const { width: fullWidth, height } = size.current;
      const { left, width } = usableSpan(fullWidth);
      if (points.length === 0 || width === 0) return null;
      const minX = Math.min(...points.map((p) => p.x));
      const maxX = Math.max(...points.map((p) => p.x));
      const minY = Math.min(...points.map((p) => p.y));
      const maxY = Math.max(...points.map((p) => p.y));
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
      return {
        zoom,
        panX: left + width / 2 - ((minX + maxX) / 2) * zoom,
        panY: height / 2 - ((minY + maxY) / 2) * zoom,
      };
    }, []);

    const fit = useCallback(() => {
      ensureProjection();
      const { width: fullWidth, height } = size.current;
      const { left, width } = usableSpan(fullWidth);
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
        panX: left + width / 2 - ((minX + maxX) / 2) * zoom,
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

    const vehicle = useRef<CanvasVehicle | null>(null);

    useImperativeHandle(
      ref,
      () => {
        // Moves the camera, smoothly, so every one of `points` is in view.
        function glide(points: Point[], durationMs: number) {
            const target = viewFor(points);
            if (!target) return;
            // Framing is now somebody's decision; the first-load fit must not
            // undo it when the checkpoints arrive.
            framed.current = true;
            if (cameraFrame.current !== null) cancelAnimationFrame(cameraFrame.current);

            const { width, height } = size.current;
            const start = { ...view.current };
            const centre = (v: typeof start) => ({
              x: (width / 2 - v.panX) / v.zoom,
              y: (height / 2 - v.panY) / v.zoom,
            });
            const c0 = centre(start);
            const c1 = centre(target);
            const t0 = performance.now();

            const step = (now: number) => {
              const k = houseEase(Math.min(1, (now - t0) / Math.max(1, durationMs)));
              // Zoom moves geometrically and the centre linearly, so the
              // camera glides rather than swooping.
              const zoom = start.zoom * Math.pow(target.zoom / start.zoom, k);
              const cx = c0.x + (c1.x - c0.x) * k;
              const cy = c0.y + (c1.y - c0.y) * k;
              view.current = { zoom, panX: width / 2 - cx * zoom, panY: height / 2 - cy * zoom };
              paintNow();
              cameraFrame.current = k < 1 ? requestAnimationFrame(step) : null;
            };
            cameraFrame.current = requestAnimationFrame(step);
        }

        const toClient = (world: Point): Point | null => {
          const canvas = canvasRef.current;
          if (!canvas) return null;
          const rect = canvas.getBoundingClientRect();
          const { panX, panY, zoom } = view.current;
          return { x: rect.left + world.x * zoom + panX, y: rect.top + world.y * zoom + panY };
        };
        const projectLatLng = (lat: number, lng: number): Point => {
          ensureProjection();
          // An empty project has no projection until its first checkpoint;
          // the first place the agent points at becomes the origin instead.
          if (!projection.current) projection.current = makeProjection(lat, lng);
          return projection.current.project(lat, lng);
        };
        const findNode = (nodeId: number) =>
          data.current.nodes.find((node) => node.node_id === nodeId) ?? null;
        /** An edge's two ends as drawn, in world units, two-way offset included. */
        const edgeEnds = (connectionId: number) => {
          const edge = data.current.connections.find((e) => e.connection_id === connectionId);
          const from = edge && findNode(edge.from_node_id);
          const to = edge && findNode(edge.to_node_id);
          if (!edge || !from || !to) return null;
          const a = nodeXY(from);
          const b = nodeXY(to);
          const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const twoWay = data.current.connections.some(
            (e) => e.from_node_id === edge.to_node_id && e.to_node_id === edge.from_node_id,
          );
          const offset = twoWay ? EDGE_OFFSET / view.current.zoom : 0;
          const ox = (-(b.y - a.y) / length) * offset;
          const oy = ((b.x - a.x) / length) * offset;
          return { a: { x: a.x + ox, y: a.y + oy }, b: { x: b.x + ox, y: b.y + oy } };
        };

        return {
          fit,
          zoomBy: (factor: number) => {
            // Around the middle of the part of the canvas nothing covers.
            const { left, width } = usableSpan(size.current.width);
            zoomAt(factor, left + width / 2, size.current.height / 2);
          },
          metresPerPixel: () => 1 / view.current.zoom,
          clearMove,
          setVehicle: (next: CanvasVehicle | null) => {
            vehicle.current = next;
            paintNow();
          },

          latLngToClient: (lat, lng) => toClient(projectLatLng(lat, lng)),

          nodeToClient: (nodeId) => {
            const node = findNode(nodeId);
            return node ? toClient(nodeXY(node)) : null;
          },

          edgeToClient: (connectionId) => {
            const ends = edgeEnds(connectionId);
            return ends ? toClient({ x: (ends.a.x + ends.b.x) / 2, y: (ends.a.y + ends.b.y) / 2 }) : null;
          },

          edgeEndsToClient: (connectionId) => {
            const ends = edgeEnds(connectionId);
            const a = ends && toClient(ends.a);
            const b = ends && toClient(ends.b);
            return a && b ? { a, b } : null;
          },

          isVisible: (lat, lng, margin = 60) => {
            // Until something has framed the view it is a placeholder that the
            // first checkpoint to arrive will replace, so nothing counts as
            // on screen yet: whoever asks frames what they need.
            if (!framed.current) return false;
            const canvas = canvasRef.current;
            const point = toClient(projectLatLng(lat, lng));
            if (!canvas || !point) return false;
            const rect = canvas.getBoundingClientRect();
            // Under the drawer or Sayes is not on screen.
            const span = usableSpan(rect.width);
            return (
              point.x >= rect.left + span.left + margin &&
              point.x <= rect.left + span.left + span.width - margin &&
              point.y >= rect.top + margin &&
              point.y <= rect.bottom - margin
            );
          },

          frame: (extra = [], durationMs = 600) => {
            glide(
              [...extra.map((p) => projectLatLng(p.lat, p.lng)), ...data.current.nodes.map(nodeXY)],
              durationMs,
            );
          },

          focus: (points, durationMs = 600) => {
            glide(points.map((p) => projectLatLng(p.lat, p.lng)), durationMs);
          },

          subscribe: (listener) => {
            listeners.current.add(listener);
            return () => listeners.current.delete(listener);
          },
        };
      },
      [fit, zoomAt, clearMove, ensureProjection, nodeXY, viewFor, paintNow],
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

      painter.current = () => {
        paint(ctx, tokens);
        for (const listener of listeners.current) listener();
      };

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

        const proj = projection.current;
        const mapDrawn = data.current.basemap && proj ? drawBasemap(ctx, proj, view.current, size.current, tiles.current, paintNow) : false;
        if (!mapDrawn) drawGrid(ctx, tokens, view.current, size.current);

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

          // An edge the agent is pointing out gets a wide accent underlay, so
          // its own colour - which says whether it enforces - still shows.
          if (data.current.highlightedConnectionIds.includes(edge.connection_id)) {
            ctx.save();
            ctx.strokeStyle = withAlpha(tokens.cyan, 0.3);
            ctx.lineWidth = 16 / zoom;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(tipX, tipY);
            ctx.stroke();
            ctx.restore();
          }

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
        if (state.mode === "linking" && state.linkFrom && !data.current.pickMode) {
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

          const chosen = data.current.selectedNodeId === node.node_id;
          if (chosen || data.current.highlightedNodeIds.includes(node.node_id)) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, nodeRadius + 8 / zoom, 0, Math.PI * 2);
            ctx.fillStyle = withAlpha(tokens.cyan, chosen ? 0.3 : 0.22);
            ctx.fill();
          }

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

          // The checkpoint in the inspector says which street it is on.
          const label = chosen ? data.current.nodeLabels[node.node_id] : undefined;
          if (label) {
            ctx.save();
            ctx.font = `600 ${12 / zoom}px ${monoFamily()}`;
            const textWidth = ctx.measureText(label).width;
            const padX = 8 / zoom;
            const boxH = 22 / zoom;
            const top = point.y + nodeRadius + 8 / zoom;
            const boxW = textWidth + padX * 2;
            // Kept inside the part of the canvas the drawer and Sayes leave.
            const span = usableSpan(size.current.width);
            const minX = (span.left - panX) / zoom + 8 / zoom;
            const maxX = (span.left + span.width - panX) / zoom - boxW - 8 / zoom;
            const boxX = Math.max(minX, Math.min(maxX, point.x - boxW / 2));
            ctx.fillStyle = tokens.surface;
            ctx.strokeStyle = tokens.cyan;
            ctx.lineWidth = 1 / zoom;
            ctx.beginPath();
            ctx.roundRect(boxX, top, boxW, boxH, 6 / zoom);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = tokens.text;
            ctx.fillText(label, boxX + boxW / 2, top + boxH / 2 + 0.5 / zoom);
            ctx.restore();
          }

          const pick =
            data.current.picks?.start === node.node_id
              ? "START"
              : data.current.picks?.end === node.node_id
                ? "END"
                : null;
          if (pick) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, nodeRadius + 7 / zoom, 0, Math.PI * 2);
            ctx.lineWidth = 3 / zoom;
            ctx.strokeStyle = tokens.cyan;
            ctx.stroke();
            ctx.font = `700 ${11 / zoom}px ${monoFamily()}`;
            ctx.lineWidth = 3 / zoom;
            ctx.strokeStyle = tokens.bg;
            ctx.strokeText(pick, point.x, point.y + nodeRadius + 18 / zoom);
            ctx.fillStyle = tokens.cyanDark;
            ctx.fillText(pick, point.x, point.y + nodeRadius + 18 / zoom);
            ctx.font = `600 ${(NODE_RADIUS * 0.72) / zoom}px ${monoFamily()}`;
          }
        }

        /* A demo project's test car, above everything it drives past. */
        const car = vehicle.current;
        const carFrom = car ? positions.get(car.fromNodeId) : undefined;
        const carTo = car ? positions.get(car.toNodeId) : undefined;
        if (car && carFrom && carTo) {
          const cx = carFrom.x + (carTo.x - carFrom.x) * car.t;
          const cy = carFrom.y + (carTo.y - carFrom.y) * car.t;
          const colour = car.violation ? tokens.red : tokens.text;

          ctx.beginPath();
          ctx.arc(cx, cy, 13 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = withAlpha(colour, 0.18);
          ctx.fill();

          ctx.beginPath();
          ctx.arc(cx, cy, 7 / zoom, 0, Math.PI * 2);
          ctx.fillStyle = colour;
          ctx.fill();
          ctx.lineWidth = 2.5 / zoom;
          ctx.strokeStyle = tokens.surface;
          ctx.stroke();

          ctx.font = `600 ${11 / zoom}px ${monoFamily()}`;
          ctx.lineWidth = 3 / zoom;
          ctx.strokeStyle = tokens.bg;
          ctx.strokeText(car.label, cx, cy - 20 / zoom);
          ctx.fillStyle = colour;
          ctx.fillText(car.label, cx, cy - 20 / zoom);
        }

        ctx.restore();

        // The scale is in the console status bar, beside zoom and fit.
      },
      [isBidirectional, nodeXY, toWorld, paintNow],
    );

    /* Redraw whenever the data behind the frame changes. */
    useEffect(() => {
      paintNow();
    }, [
      nodes,
      connections,
      nodeWarnings,
      selectedConnectionId,
      highlightedConnectionIds,
      highlightedNodeIds,
      picks,
      selectedNodeId,
      nodeLabels,
      basemap,
      paintNow,
    ]);

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
      // A hand on the canvas beats a camera move in flight.
      if (cameraFrame.current !== null) {
        cancelAnimationFrame(cameraFrame.current);
        cameraFrame.current = null;
      }
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
      state.originX = x;
      state.originY = y;
      state.moved = false;

      // Middle button always pans, whatever is under it.
      const node = event.button === 1 ? null : nodeAt(world.x, world.y);
      if (node) {
        // Shift picks the checkpoint up; a plain drag draws an edge out of it.
        // Drawing the graph is the frequent action and keeps the unmodified
        // gesture; moving a camera changes what counts as speeding, so it is
        // the deliberate one - and it still has to be confirmed after that.
        if (event.shiftKey && !pickMode) {
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
        // A few pixels of jitter is still a click on the checkpoint.
        if (Math.hypot(x - state.originX, y - state.originY) > 4) {
          state.moved = true;
        }
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
              `Camera ${node.id_in_project}${nodeLabels[node.node_id] ? ` · ${nodeLabels[node.node_id]}` : ""}`,
              `${node.latitude.toFixed(5)}, ${node.longitude.toFixed(5)}`,
              ...(warning ? [warning] : []),
              ...(pickMode
                ? ["Click to pick it for the test drive"]
                : [
                    "Click to inspect · drag to another to link",
                    "Shift-drag to correct its position",
                  ]),
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
        if (pickMode) {
          // A test drive picks the checkpoint the press started on.
          if (!state.moved && target?.node_id === state.linkFrom.node_id) {
            onClickNode?.(target);
          }
        } else if (target && target.node_id !== state.linkFrom.node_id) {
          onDraftEdge({ from: state.linkFrom, to: target });
        } else if (target && !state.moved) {
          // Pressed and released on the same checkpoint: a click, not a link.
          onClickNode?.(target);
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
          onContextMenu={(event) => {
            event.preventDefault();
            if (!onContextMenu) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const world = toWorld(event.clientX - rect.left, event.clientY - rect.top);
            const proj = projection.current;
            onContextMenu(proj ? proj.unproject(world.x, world.y) : null, { x: event.clientX, y: event.clientY });
          }}
        />

        {basemap ? (
          <p
            className="sayes-clear pointer-events-none absolute bottom-1 z-10 rounded bg-surface/80 px-1.5 text-[0.625rem] text-text-dim"
            style={{ right: "calc(0.5rem + var(--sayes-bottom-inset, 0px))" }}
          >
            Basemap ©{" "}
            <a className="pointer-events-auto underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap
            </a>{" "}
            contributors
          </p>
        ) : null}

        {hover && showHover ? (
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

/* -------------------------------------------------------------------------
   Basemap: OpenStreetMap raster tiles under the graph
   ------------------------------------------------------------------------- */

const TILE_URL = "https://tile.openstreetmap.org";
const MAX_TILES_PER_FRAME = 90;
const MAX_CACHED_TILES = 600;

/** Web Mercator tile -> the latitude and longitude of its north-west corner. */
function tileCorner(x: number, y: number, z: number): LatLng {
  const n = 2 ** z;
  const lng = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lng };
}

function tileXY(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  };
}

/**
 * Draws the tiles under the visible part of the canvas, faint and grey, so
 * the network stays the figure. Tiles are Web Mercator and the canvas is a
 * local tangent plane; each tile is placed by its own projected corners,
 * which at city scale lines up to well under a pixel. Returns false while
 * there is nothing to draw on, so the grid can stand in.
 */
function drawBasemap(
  ctx: CanvasRenderingContext2D,
  projection: Projection,
  view: { panX: number; panY: number; zoom: number },
  size: { width: number; height: number },
  cache: Map<string, HTMLImageElement>,
  repaint: () => void,
): boolean {
  const { panX, panY, zoom } = view;
  const nw = projection.unproject((0 - panX) / zoom, (0 - panY) / zoom);
  const se = projection.unproject((size.width - panX) / zoom, (size.height - panY) / zoom);
  const midLat = (nw.lat + se.lat) / 2;
  // The tile zoom whose pixels are closest to the screen's.
  const metresPerScreenPx = 1 / zoom;
  const z = Math.max(3, Math.min(19, Math.round(Math.log2((156543.03392 * Math.cos((midLat * Math.PI) / 180)) / metresPerScreenPx))));
  const a = tileXY(nw.lat, nw.lng, z);
  const b = tileXY(se.lat, se.lng, z);
  const count = (b.x - a.x + 1) * (b.y - a.y + 1);
  if (count <= 0 || count > MAX_TILES_PER_FRAME) return false;

  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);
  ctx.globalAlpha = 0.34;
  ctx.filter = "grayscale(1) contrast(0.75) brightness(1.1)";
  let drawn = 0;
  const wanted = new Set<string>();
  for (let x = a.x; x <= b.x; x += 1) {
    for (let y = a.y; y <= b.y; y += 1) {
      const key = `${z}/${x}/${y}`;
      wanted.add(key);
      let image = cache.get(key);
      if (!image) {
        image = new Image();
        // Tiles allow CORS, and asking for it keeps the canvas readable.
        image.crossOrigin = "anonymous";
        image.onload = repaint;
        // A tile that fails is dropped after a pause, so a later paint asks
        // for it again instead of leaving a hole for the rest of the session.
        const failed = image;
        image.onerror = () =>
          setTimeout(() => {
            if (cache.get(key) === failed) cache.delete(key);
            repaint();
          }, 3000);
        image.src = `${TILE_URL}/${key}.png`;
        cache.set(key, image);
        if (cache.size > MAX_CACHED_TILES) cache.delete(cache.keys().next().value as string);
      }
      const p = projection.project(tileCorner(x, y, z).lat, tileCorner(x, y, z).lng);
      const q = projection.project(tileCorner(x + 1, y + 1, z).lat, tileCorner(x + 1, y + 1, z).lng);
      // A hair of overlap hides the seams between neighbouring tiles.
      const pad = 0.6 / zoom;
      if (image.complete && image.naturalWidth > 0) {
        ctx.drawImage(image, p.x - pad, p.y - pad, q.x - p.x + pad * 2, q.y - p.y + pad * 2);
        drawn += 1;
        continue;
      }
      // Until it arrives, the quarter of the loaded tile one zoom out.
      const parent = cache.get(`${z - 1}/${x >> 1}/${y >> 1}`);
      if (parent && parent.complete && parent.naturalWidth > 0) {
        const half = parent.naturalWidth / 2;
        ctx.drawImage(parent, (x & 1) * half, (y & 1) * half, half, half, p.x - pad, p.y - pad, q.x - p.x + pad * 2, q.y - p.y + pad * 2);
        drawn += 1;
      }
    }
  }
  ctx.restore();

  // Tiles still loading that this view no longer shows are cancelled, so a
  // glide across zoom levels does not queue the final view behind them.
  for (const [key, image] of cache) {
    if (wanted.has(key) || image.complete || key.startsWith(`${z - 1}/`)) continue;
    image.onload = null;
    image.onerror = null;
    image.src = "";
    cache.delete(key);
  }
  return drawn > 0;
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

