// Canvas plumbing shared by the map client and the DM-side previews. It lives
// next to transform.ts because the map screen is built as its own browser
// bundle and must not reach into src/views.

// Assigning canvas.width or .height reallocates the backing store and re-uploads
// a GPU texture even when the value is unchanged. Both the map client's grid
// overlay and the preview's AoE overlay repaint on every incoming message or
// pointer move, so the assignment is guarded.
export function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): boolean {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

export interface RepaintScheduler {
  schedule: () => void;
  cancel: () => void;
}

// Messages and pointer moves arrive faster than frames. Coalescing into one
// repaint per frame also keeps every measurement ahead of the style writes it
// feeds, which is what stops the read-after-write layout thrashing.
export function createRepaintScheduler(repaint: () => void): RepaintScheduler {
  let frame: number | null = null;
  return {
    schedule: () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    },
    cancel: () => {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
