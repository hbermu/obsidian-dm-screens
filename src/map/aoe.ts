import type { MapAoe } from "./types";

const CONE_ANGLE_RAD = (53 * Math.PI) / 180;

// The stage renders as `translate(tx,ty) scale(s)`, so a map point lands at
// T + s·p. The DM previews ride a CSS-rotated stage, which carries the shape
// with them; nothing here has to know their angle.
export function renderAoe(
  ctx: CanvasRenderingContext2D,
  aoe: MapAoe,
  scale: number,
  tx: number,
  ty: number,
  pxPerSquare: number
): void {
  const ftToPx = pxPerSquare / 5;
  const screenX = tx + aoe.x * scale;
  const screenY = ty + aoe.y * scale;
  const rot = (aoe.rotation * Math.PI) / 180;

  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.rotate(rot);

  ctx.beginPath();
  buildPath(ctx, aoe.shape, aoe.sizeFt, aoe.widthFt, ftToPx * scale);
  ctx.closePath();

  ctx.fillStyle = aoe.color;
  ctx.globalAlpha = aoe.opacity;
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.strokeStyle = aoe.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();
}

function buildPath(
  ctx: CanvasRenderingContext2D,
  shape: MapAoe["shape"],
  sizeFt: number,
  widthFt: number,
  ftScale: number
): void {
  switch (shape) {
    case "circle": {
      ctx.arc(0, 0, sizeFt * ftScale, 0, Math.PI * 2);
      break;
    }
    case "ring": {
      // Hollow band: outer radius = sizeFt, inner radius = sizeFt − widthFt.
      // The two arcs run in opposite directions so the default nonzero
      // winding rule leaves the hole; stroking both draws each band edge.
      const outer = sizeFt * ftScale;
      const inner = Math.max(0, sizeFt - widthFt) * ftScale;
      ctx.arc(0, 0, outer, 0, Math.PI * 2, false);
      ctx.moveTo(inner, 0);
      ctx.arc(0, 0, inner, 0, Math.PI * 2, true);
      break;
    }
    case "square": {
      const half = (sizeFt * ftScale) / 2;
      ctx.rect(-half, -half, half * 2, half * 2);
      break;
    }
    case "cone": {
      const halfAngle = CONE_ANGLE_RAD / 2;
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, sizeFt * ftScale, -halfAngle, halfAngle);
      break;
    }
    case "line": {
      const halfW = (widthFt * ftScale) / 2;
      ctx.rect(0, -halfW, sizeFt * ftScale, halfW * 2);
      break;
    }
  }
}
