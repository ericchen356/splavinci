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

export type PlanColours = {
  /** Open floor the camera can actually get to. */
  floor: string;
  /** Open floor cut off from the rest by gaps narrower than the camera. */
  unreachable: string;
  wall: string;
  outline: string;
  wallOutline: string;
};

export const DEFAULT_PLAN_COLOURS: PlanColours = {
  // Reads clearly against --bg (#0d0f12) instead of vanishing into it.
  floor: '#1d2b3d',
  // Visibly surveyed, visibly not somewhere you can send the camera. Left
  // unpainted it would look identical to unsurveyed space, which is the thing
  // that made the map read as vague blobs in the first place.
  unreachable: '#241f2b',
  wall: '#5b6b80',
  outline: '#6ea8fe',
  wallOutline: '#93a7bf',
};

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
  colours = DEFAULT_PLAN_COLOURS,
  /** Cells the camera can reach. Everything else open is drawn as cut off. */
  reachable?: Uint8Array | null,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const w = extent.c1 - extent.c0 + 1;
  const h = extent.r1 - extent.r0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const image = ctx.createImageData(w, h);
  const floorRgb = hexToRgb(colours.floor);
  const wallRgb = hexToRgb(colours.wall);
  const cutOffRgb = hexToRgb(colours.unreachable);

  for (let r = extent.r0; r <= extent.r1; r++) {
    for (let c = extent.c0; c <= extent.c1; c++) {
      const i = cellIndex(grid, c, r);
      const p = ((r - extent.r0) * w + (c - extent.c0)) * 4;
      if (grid.blocked[i]) {
        image.data[p] = wallRgb[0]; image.data[p + 1] = wallRgb[1];
        image.data[p + 2] = wallRgb[2]; image.data[p + 3] = 255;
      } else if (grid.floor[i]) {
        const rgb = !reachable || reachable[i] ? floorRgb : cutOffRgb;
        image.data[p] = rgb[0]; image.data[p + 1] = rgb[1];
        image.data[p + 2] = rgb[2]; image.data[p + 3] = 255;
      } else {
        image.data[p + 3] = 0;
      }
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
  colours = DEFAULT_PLAN_COLOURS,
  /** Camera radius. Omit to treat every open cell as reachable. */
  radius?: number,
): PlanLayer {
  const extent = contentExtent(grid);
  const reach = radius === undefined ? null : reachableMask(grid, radius);
  const reachable = reach?.mask ?? null;
  return {
    fill: renderPlanFill(grid, extent, colours, reachable),
    extent,
    // Outline the REACHABLE region when we know it: the line is what reads as
    // the edge of the space, and drawing it around pockets you cannot fly to
    // advertises rooms that are not on offer.
    openOutline: planOutline(grid, reachable
      ? (g, c, r) => walkable(g, c, r) && reachable[cellIndex(g, c, r)] === 1
      : walkable),
    wallOutline: planOutline(grid, solid),
    reachable,
    reachableCells: reach?.cells ?? 0,
    regions: reach?.regions ?? 0,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
