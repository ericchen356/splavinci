/**
 * Blueprint-style rendering of a walk grid.
 *
 * The previous mini-map painted floor at #1b2129 on a #0d0f12 background -
 * a difference you cannot actually see - so the walkable area was invisible
 * and only scattered wall cells showed. That reads as random fragments rather
 * than as rooms and hallways.
 *
 * A floor plan is legible because of two things this now does deliberately:
 * open space is a filled region with real contrast against the page, and the
 * boundary between open space and everything else is drawn as a line. The
 * outline is what makes a wall read as a wall instead of as a row of squares,
 * so it is stroked as vector segments along actual cell edges rather than
 * left to the fill.
 */

import { cellIndex, reachableMask, type WalkGrid } from '@/lib/path';
import { theme, toRgb } from '@/components/theme';

export type PlanColours = {
  /** Open floor the camera can actually get to. */
  floor: string;
  /** Open floor cut off from the rest by gaps narrower than the camera. */
  unreachable: string;
  wall: string;
  outline: string;
  wallOutline: string;
};

/**
 * The plan palette, from the app's own token block.
 *
 * These were five hardcoded hexes, and the values in them did not actually do
 * what the comment above claims: the old floor (#1d2b3d) sat at 1.35:1 against
 * the old page colour, which is not "real contrast against the page" — it is
 * the same invisible fill the rewrite was meant to fix, a shade lighter.
 *
 * The token block carries measured values instead: open floor clears 3.13:1
 * against unsurveyed space, the wall outline clears 3.77:1 against the floor it
 * bounds, and wall mass is a step DARKER than the floor rather than lighter, so
 * the map reads the way a floor plan does — solid is dark, open is light — and
 * the route and aim strokes drawn on top land on dark mass instead of competing
 * with a light fill.
 */
export function planColours(): PlanColours {
  const t = theme();
  return {
    floor: t.mapFloor,
    // Visibly surveyed, visibly not somewhere you can send the camera. Left
    // unpainted it would look identical to unsurveyed space, which is the thing
    // that made the map read as vague blobs in the first place. It is also the
    // only region without the accent outline, so the distinction is not
    // carried by colour alone.
    unreachable: t.mapFloorCut,
    wall: t.mapWall,
    outline: t.mapOpenLine,
    wallOutline: t.mapWallLine,
  };
}

export type PlanProjection = {
  toScreen(x: number, z: number): { sx: number; sy: number };
  scale: number;
  offsetX: number;
  offsetY: number;
};

const walkable = (grid: WalkGrid, c: number, r: number): boolean => {
  if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) return false;
  const i = cellIndex(grid, c, r);
  return grid.floor[i] === 1 && grid.blocked[i] === 0;
};

const solid = (grid: WalkGrid, c: number, r: number): boolean => {
  if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) return false;
  return grid.blocked[cellIndex(grid, c, r)] === 1;
};

/** Cell range and world box that actually contain geometry. */
/** Opacity of the walkable fill, so the render stays visible beneath it. */
const MAP_FILL_ALPHA = 0.82;

/**
 * Enclosed gaps smaller than this are drawn as floor. Square metres.
 *
 * DISPLAY ONLY - the routing grid is untouched, so the camera still avoids
 * every one of them. A chair leg or a stray obstacle cell punches a hole a few
 * centimetres across in the silhouette, and at map scale a scatter of those
 * reads as dirt on the screen rather than as furniture: it buries the
 * structure a plan exists to show. Anything you could actually fly around
 * survives.
 *
 * In square metres and not in cells, because cell size is derived per capture
 * (grid.ts sizes the grid to roughly 160 cells across the longer axis), so the
 * same cell count means a dinner plate in a studio flat and a dining table
 * across a 37 m outdoor capture.
 */
const MAP_MIN_HOLE_AREA = 0.35;

/**
 * Marooned floor smaller than this is not drawn at all. Square metres.
 *
 * Also display only. Floor the camera cannot route to is worth showing, greyed,
 * when it is a room you might wonder why you cannot enter. Below about a small
 * bathroom it is the far side of a doorway the clearance radius would not fit
 * through, and drawing it just stipples the margins of the plan.
 */
const MAP_MIN_CUTOFF_AREA = 2;

/** Cells drawn as floor, and cells drawn as floor the camera cannot get to. */
export type DisplayMasks = {
  shown: Uint8Array;
  cutOff: Uint8Array;
};

/**
 * 4-connected components of a mask, with whether each one touches the border.
 *
 * Border contact is the test for "enclosed": a gap that runs off the edge of
 * the surveyed area is open to somewhere, and might be a doorway or a branch
 * nobody walked down. That is exactly the thing the map must not paper over.
 */
function eachComponent(
  mask: Uint8Array,
  want: 0 | 1,
  cols: number,
  rows: number,
  fn: (cells: number[], touchesEdge: boolean) => void,
): void {
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== want || seen[start]) continue;
    const cells: number[] = [];
    let touchesEdge = false;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      cells.push(cur);
      const cx = cur % cols;
      const cz = (cur / cols) | 0;
      if (cx === 0 || cz === 0 || cx === cols - 1 || cz === rows - 1) touchesEdge = true;
      if (cx > 0 && mask[cur - 1] === want && !seen[cur - 1]) { seen[cur - 1] = 1; stack.push(cur - 1); }
      if (cx < cols - 1 && mask[cur + 1] === want && !seen[cur + 1]) { seen[cur + 1] = 1; stack.push(cur + 1); }
      if (cz > 0 && mask[cur - cols] === want && !seen[cur - cols]) { seen[cur - cols] = 1; stack.push(cur - cols); }
      if (cz < rows - 1 && mask[cur + cols] === want && !seen[cur + cols]) { seen[cur + cols] = 1; stack.push(cur + cols); }
    }
    fn(cells, touchesEdge);
  }
}

/**
 * What the map paints, as distinct from what the router uses.
 *
 * DISPLAY ONLY - the routing grid is untouched, so the camera still avoids
 * every obstacle and still cannot reach anything it could not reach before.
 * Two things get cleaned up, both for the same reason: at map scale a scatter
 * of single cells reads as dirt on the screen rather than as information, and
 * it buries the structure a plan exists to show.
 *
 *   - Enclosed gaps under MAP_MIN_HOLE_CELLS are filled. A chair leg punching
 *     a two-cell hole in the floor is not something you can act on.
 *   - Marooned floor under MAP_MIN_CUTOFF_CELLS is dropped. A whole room the
 *     camera cannot enter is worth showing, greyed; six cells behind a sofa
 *     is not.
 */
export function displayMasks(grid: WalkGrid, reachable: Uint8Array | null): DisplayMasks {
  const cellArea = grid.cellSize * grid.cellSize;
  const minHoleCells = Math.max(1, Math.round(MAP_MIN_HOLE_AREA / cellArea));
  const minCutOffCells = Math.max(1, Math.round(MAP_MIN_CUTOFF_AREA / cellArea));
  const total = grid.cols * grid.rows;
  const open = new Uint8Array(total);
  const shown = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (grid.floor[i] !== 1 || grid.blocked[i] !== 0) continue;
    open[i] = 1;
    if (!reachable || reachable[i]) shown[i] = 1;
  }

  eachComponent(shown, 0, grid.cols, grid.rows, (cells, touchesEdge) => {
    if (touchesEdge || cells.length > minHoleCells) return;
    for (const cell of cells) shown[cell] = 1;
  });

  const cutOff = new Uint8Array(total);
  if (reachable) {
    const marooned = new Uint8Array(total);
    for (let i = 0; i < total; i++) if (open[i] && !shown[i]) marooned[i] = 1;
    eachComponent(marooned, 1, grid.cols, grid.rows, (cells) => {
      if (cells.length < minCutOffCells) return;
      for (const cell of cells) cutOff[cell] = 1;
    });
  }

  return { shown, cutOff };
}

export type ContentExtent = {
  c0: number; c1: number; r0: number; r1: number;
  minX: number; minZ: number; maxX: number; maxZ: number;
  empty: boolean;
};

/**
 * The sub-rectangle of the grid holding any floor or wall.
 *
 * A derived collider rarely fills its own bounding box - the grid is sized to
 * the whole capture while the building occupies a corner of it. Framing the
 * mini-map on the full bounds wastes most of the panel on blank margin and
 * shrinks the part anyone wants to read.
 */
export function contentExtent(grid: WalkGrid): ContentExtent {
  let c0 = grid.cols, c1 = -1, r0 = grid.rows, r1 = -1;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = cellIndex(grid, c, r);
      if (!grid.floor[i] && !grid.blocked[i]) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
  }
  if (c1 < 0) {
    return {
      c0: 0, c1: grid.cols - 1, r0: 0, r1: grid.rows - 1,
      minX: grid.bounds.min.x, minZ: grid.bounds.min.z,
      maxX: grid.bounds.max.x, maxZ: grid.bounds.max.z,
      empty: true,
    };
  }
  return {
    c0, c1, r0, r1,
    minX: grid.bounds.min.x + c0 * grid.cellSize,
    minZ: grid.bounds.min.z + r0 * grid.cellSize,
    maxX: grid.bounds.min.x + (c1 + 1) * grid.cellSize,
    maxZ: grid.bounds.min.z + (r1 + 1) * grid.cellSize,
    empty: false,
  };
}

/**
 * Raster of the filled regions, cropped to the content extent.
 *
 * Built once per grid and blitted on redraw, rather than drawn cell-by-cell,
 * because the mini-map redraws on every camera move and a grid this size is
 * tens of thousands of rectangles.
 */
export function renderPlanFill(
  grid: WalkGrid,
  extent: ContentExtent,
  colours = planColours(),
  /** Cells the camera can reach. Everything else open is drawn as cut off. */
  reachable?: Uint8Array | null,
  /** Drawing masks. Recomputed if not supplied; routing is untouched either way. */
  masks?: DisplayMasks | null,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const w = extent.c1 - extent.c0 + 1;
  const h = extent.r1 - extent.r0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const { shown, cutOff } = masks ?? displayMasks(grid, reachable ?? null);
  const image = ctx.createImageData(w, h);
  const floorRgb = toRgb(colours.floor);
  const cutOffRgb = toRgb(colours.unreachable);
  const floorAlpha = Math.round(255 * MAP_FILL_ALPHA);

  for (let r = extent.r0; r <= extent.r1; r++) {
    for (let c = extent.c0; c <= extent.c1; c++) {
      const i = cellIndex(grid, c, r);
      const p = ((r - extent.r0) * w + (c - extent.c0)) * 4;
      // Wall mass and unsurveyed space are NOT painted.
      //
      // Filling them put a field of dark cells across the map - speckle that
      // read as noise rather than as structure, and which the walkable
      // region's own outline already describes far more clearly. Leaving them
      // clear also lets the render show through, so the map sits on the scene
      // as a silhouette of the space instead of as an opaque card.
      if (!shown[i]) {
        // A room the camera cannot route to still shows, greyed. Wall mass,
        // unsurveyed space and marooned scraps are not painted at all.
        if (!cutOff[i]) continue;
        image.data[p] = cutOffRgb[0];
        image.data[p + 1] = cutOffRgb[1];
        image.data[p + 2] = cutOffRgb[2];
        image.data[p + 3] = Math.round(255 * MAP_FILL_ALPHA * 0.6);
        continue;
      }
      const rgb = floorRgb;
      image.data[p] = rgb[0];
      image.data[p + 1] = rgb[1];
      image.data[p + 2] = rgb[2];
      image.data[p + 3] = floorAlpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export type EdgeSegment = { x0: number; z0: number; x1: number; z1: number };

/**
 * Cell edges where open space meets anything else.
 *
 * Only the four orthogonal neighbours are tested, so every segment is a real
 * cell boundary and the result is axis-aligned line work rather than a
 * staircase of outlined squares.
 */
export function planOutline(
  grid: WalkGrid,
  test: (grid: WalkGrid, c: number, r: number) => boolean = walkable,
): EdgeSegment[] {
  const out: EdgeSegment[] = [];
  const size = grid.cellSize;
  const ox = grid.bounds.min.x;
  const oz = grid.bounds.min.z;

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (!test(grid, c, r)) continue;
      const x0 = ox + c * size;
      const z0 = oz + r * size;
      const x1 = x0 + size;
      const z1 = z0 + size;
      if (!test(grid, c, r - 1)) out.push({ x0, z0, x1, z1: z0 });
      if (!test(grid, c, r + 1)) out.push({ x0, z0: z1, x1, z1 });
      if (!test(grid, c - 1, r)) out.push({ x0, z0, x1: x0, z1 });
      if (!test(grid, c + 1, r)) out.push({ x0: x1, z0, x1, z1 });
    }
  }
  return out;
}

/** Stroke a set of world-space segments through a projection. */
export function strokeSegments(
  ctx: CanvasRenderingContext2D,
  segments: readonly EdgeSegment[],
  proj: PlanProjection,
  colour: string,
  width: number,
): void {
  if (segments.length === 0) return;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const s of segments) {
    const a = proj.toScreen(s.x0, s.z0);
    const b = proj.toScreen(s.x1, s.z1);
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
  }
  ctx.stroke();
}

/** Everything the plan layer needs, computed once per grid. */
export type PlanLayer = {
  fill: HTMLCanvasElement | null;
  extent: ContentExtent;
  openOutline: EdgeSegment[];
  wallOutline: EdgeSegment[];
  /** Cells the camera can reach, if the caller supplied a radius. */
  reachable: Uint8Array | null;
  reachableCells: number;
  regions: number;
};

export function buildPlanLayer(
  grid: WalkGrid,
  colours = planColours(),
  /** Camera radius. Omit to treat every open cell as reachable. */
  radius?: number,
): PlanLayer {
  const extent = contentExtent(grid);
  const reach = radius === undefined ? null : reachableMask(grid, radius);
  const reachable = reach?.mask ?? null;
  // One mask for the fill and the outline. If they disagree, every closed hole
  // gets an outline drawn around floor that is painted as floor - the speckle
  // comes back as rings instead of dots.
  const masks = displayMasks(grid, reachable);
  const inShown = (g: WalkGrid, c: number, r: number) =>
    c >= 0 && r >= 0 && c < g.cols && r < g.rows && masks.shown[cellIndex(g, c, r)] === 1;
  return {
    fill: renderPlanFill(grid, extent, colours, reachable, masks),
    extent,
    // Outline the REACHABLE region when we know it: the line is what reads as
    // the edge of the space, and drawing it around pockets you cannot fly to
    // advertises rooms that are not on offer.
    openOutline: planOutline(grid, inShown),
    wallOutline: planOutline(grid, solid),
    reachable,
    reachableCells: reach?.cells ?? 0,
    regions: reach?.regions ?? 0,
  };
}
