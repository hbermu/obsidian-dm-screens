import { blocksSight, visibilityPolygon } from "./los";
import type { MapVision, MapWall } from "./types";

// Fully revealed out to sizeFt (bright zone); dim zone from sizeFt to sizeFt+dimFt
// is revealed but darkened; alpha fades to 0 across the feather band beyond
// the outermost zone.
export function eraseVision(
  ctx: CanvasRenderingContext2D,
  vision: MapVision,
  scale: number,
  pxPerSquare: number
): void {
  const ftToPx = (pxPerSquare / 5) * scale;
  const cx = vision.x * scale;
  const cy = vision.y * scale;
  const brightR = Math.max(0, vision.sizeFt) * ftToPx;
  const dimR = Math.max(0, vision.dimFt) * ftToPx;
  const feather = Math.max(0, vision.featherFt) * ftToPx;
  const outerR = brightR + dimR;

  ctx.save();
  ctx.globalCompositeOperation = "destination-out";

  if (vision.shape === "circle") {
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.beginPath();
    ctx.arc(cx, cy, brightR, 0, Math.PI * 2);
    ctx.fill();

    if (dimR > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.arc(cx, cy, brightR, 0, Math.PI * 2, true);
      ctx.fill("evenodd");
    }

    if (feather > 0) {
      const outer = Math.max(1, outerR + feather);
      const g = ctx.createRadialGradient(cx, cy, outerR, cx, cy, outer);
      g.addColorStop(0, "rgba(0,0,0,0.5)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, outer, 0, Math.PI * 2);
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2, true);
      ctx.fill("evenodd");
    }
  } else {
    const brightHalf = brightR;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.fillRect(cx - brightHalf, cy - brightHalf, brightHalf * 2, brightHalf * 2);

    if (dimR > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      const outerHalf = outerR;
      ctx.beginPath();
      ctx.rect(cx - outerHalf, cy - outerHalf, outerHalf * 2, outerHalf * 2);
      ctx.rect(cx - brightHalf, cy - brightHalf, brightHalf * 2, brightHalf * 2);
      ctx.fill("evenodd");
    }

    if (feather > 0) {
      ctx.filter = `blur(${feather / 2}px)`;
      const featherHalf = feather / 2;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.rect(cx - (outerR + featherHalf), cy - (outerR + featherHalf), (outerR + featherHalf) * 2, (outerR + featherHalf) * 2);
      ctx.rect(cx - outerR, cy - outerR, outerR * 2, outerR * 2);
      ctx.fill("evenodd");
      ctx.filter = "none";
    }
  }

  ctx.restore();
}

export function eraseVisionWithWalls(
  ctx: CanvasRenderingContext2D,
  vision: MapVision,
  scale: number,
  pxPerSquare: number,
  walls: MapWall[],
  mapWidth: number,
  mapHeight: number
): void {
  if (!walls.some(blocksSight)) {
    eraseVision(ctx, vision, scale, pxPerSquare);
    return;
  }
  const poly = visibilityPolygon(vision.x, vision.y, walls, { x: 0, y: 0, w: mapWidth, h: mapHeight });
  if (poly.length < 3) return;
  const path = new Path2D();
  path.moveTo(poly[0].x * scale, poly[0].y * scale);
  for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x * scale, poly[i].y * scale);
  path.closePath();
  ctx.save();
  ctx.clip(path);
  eraseVision(ctx, vision, scale, pxPerSquare);
  ctx.restore();
}
