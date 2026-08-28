"use client";

import { useEffect, useRef } from "react";
import type { ThumbnailData } from "@/lib/api";
import { readTokens, withAlpha } from "@/lib/tokens";

type ProjectThumbnailProps = {
  data: ThumbnailData | null;
  /** True while the shape is still being fetched. */
  loading?: boolean;
};

const PADDING = 26;
const NODE_RADIUS = 7;

/**
 * The shape of a project, at card size.
 *
 * The server sends geometry only: node positions arrive already projected onto
 * the local tangent plane and rescaled into the unit square, so no camera's
 * GPS position is disclosed here. The fit below maps that square onto the
 * canvas with a single scale for both axes; two would stretch the graph and
 * misrepresent the distances the whole system is built on.
 *
 * Edges are drawn in the accent, not in a spread of hues. Colour means status
 * everywhere else in the system, and a thumbnail is not reporting status.
 */
export default function ProjectThumbnail({ data, loading }: ProjectThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const tokens = readTokens();
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = tokens.bgSubtle;
    ctx.fillRect(0, 0, width, height);

    const nodes = data?.nodes ?? [];
    if (nodes.length === 0) {
      // An empty project still gets the accent, quietly: a ring where the
      // first checkpoint will land.
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, 20, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(tokens.cyan, loading ? 0.05 : 0.09);
      ctx.fill();
      ctx.strokeStyle = withAlpha(tokens.cyan, loading ? 0.12 : 0.25);
      ctx.lineWidth = 2;
      ctx.stroke();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }

    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const scale = Math.min(
      (width - PADDING * 2) / spanX,
      (height - PADDING * 2) / spanY,
    );

    const offsetX = (width - spanX * scale) / 2;
    const offsetY = (height - spanY * scale) / 2;
    const place = (x: number, y: number) => ({
      x: offsetX + (x - minX) * scale,
      y: offsetY + (y - minY) * scale,
    });

    const positions = new Map(nodes.map((node) => [node.id, place(node.x, node.y)]));

    ctx.strokeStyle = withAlpha(tokens.cyanDark, 0.4);
    ctx.lineWidth = 1.5;
    for (const edge of data?.connections ?? []) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;

      const ux = dx / length;
      const uy = dy / length;

      ctx.beginPath();
      ctx.moveTo(from.x + ux * NODE_RADIUS, from.y + uy * NODE_RADIUS);
      ctx.lineTo(to.x - ux * NODE_RADIUS, to.y - uy * NODE_RADIUS);
      ctx.stroke();
    }

    for (const node of nodes) {
      const position = positions.get(node.id);
      if (!position) continue;

      ctx.beginPath();
      ctx.arc(position.x, position.y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = tokens.surface;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = tokens.cyan;
      ctx.stroke();
    }
  }, [data, loading]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="h-full w-full rounded-t-2xl"
    />
  );
}
