/**
 * Step 2 of path generation: A* between consecutive waypoints, respecting walls.
 *
 * Two things make this more than a textbook A*:
 *
 *  - Clearance is both a gate and a cost. A cell closer to a wall than the
 *    camera's body radius is impassable outright; beyond that, cells still cost
 *    more the closer they are, so the route drifts toward the middle of a room
 *    instead of scraping the skirting board. A camera that clips a doorframe
 *    reads as a bug even when the path is technically valid.
 *  - Diagonals may not cut corners. Moving diagonally requires both orthogonal
 *    neighbours to be passable, otherwise a path can slip through the corner
 *    where two walls meet.
 *
 * The result is a grid path. Smoothing into an actual camera curve is the next
 * step (curve.ts) - this stage only answers "which cells, in what order".
 */

import {
  cellIndex,
  findNearestCell,
  hasLineOfSight,
  isPassable,
  type WalkGrid,
} from './grid';

export type Cell = { col: number; row: number };

export type AStarOptions = {
  /** Camera body radius. Cells with less clearance than this are impassable. */
  radius: number;
  /** How strongly to prefer open space. 0 = shortest path, higher = wider berth. */
  clearanceWeight: number;
  /** Distance beyond which extra clearance stops earning a discount. */
  comfortDistance: number;
  /** Safety valve so a pathological grid cannot spin forever. */
  maxExpansions: number;
};

export const DEFAULT_ASTAR: AStarOptions = {
  radius: 0.3,
  clearanceWeight: 1.4,
  comfortDistance: 1.1,
  maxExpansions: 400_000,
};

export type AStarFailure =
  | 'start-off-grid'
  | 'goal-off-grid'
  | 'start-blocked'
  | 'goal-blocked'
  | 'unreachable'
  | 'expansion-budget';

export type AStarResult = {
  found: boolean;
  /** Grid cells from start to goal inclusive. Empty when `found` is false. */
  cells: Cell[];
  /** The cells actually used after snapping, which may differ from those asked for. */
  start: Cell | null;
  goal: Cell | null;
  /** True when the requested start/goal had to be nudged to a passable cell. */
  snappedStart: boolean;
  snappedGoal: boolean;
  expanded: number;
  failure: AStarFailure | null;
};

/* ------------------------------- binary heap ------------------------------ */

/** Min-heap keyed on f-score, storing cell indices. */
class Heap {
  private items: number[] = [];
  private keys: Float64Array;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
  }

  get size(): number {
    return this.items.length;
  }

  push(index: number, key: number): void {
    this.keys[index] = key;
    this.items.push(index);
    this.up(this.items.length - 1);
  }

  pop(): number {
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.down(0);
    }
    return top;
  }

  /** Re-heapify after a decreased key. Cheaper than a decrease-key index. */
  pushOrUpdate(index: number, key: number): void {
    const at = this.items.indexOf(index);
    this.keys[index] = key;
    if (at === -1) {
      this.items.push(index);
      this.up(this.items.length - 1);
    } else {
      this.up(at);
    }
  }

  private up(i: number): void {
    const items = this.items;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[items[parent]] <= this.keys[items[i]]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  private down(i: number): void {
    const items = this.items;
    const n = items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && this.keys[items[l]] < this.keys[items[smallest]]) smallest = l;
      if (r < n && this.keys[items[r]] < this.keys[items[smallest]]) smallest = r;
      if (smallest === i) break;
      [items[smallest], items[i]] = [items[i], items[smallest]];
      i = smallest;
    }
  }
}

/* ---------------------------------- A* ------------------------------------ */

const SQRT2 = Math.SQRT2;

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/** Octile distance — the exact cost of an unobstructed 8-connected move. */
function octile(dc: number, dr: number): number {
  const a = Math.abs(dc);
  const b = Math.abs(dr);
  return a > b ? a - b + SQRT2 * b : b - a + SQRT2 * a;
}

export function findPath(
  grid: WalkGrid,
  from: Cell,
  to: Cell,
  options: Partial<AStarOptions> = {},
): AStarResult {
  const opts = { ...DEFAULT_ASTAR, ...options };
  const passable = (c: number, r: number) => isPassable(grid, c, r, opts.radius);

  const base: AStarResult = {
    found: false, cells: [], start: null, goal: null,
    snappedStart: false, snappedGoal: false, expanded: 0, failure: null,
  };

  // Rescue waypoints dropped inside a wall or just off the floor. Snapping is
  // reported so the caller can warn rather than silently relocating the shot.
  const snapRadius = Math.max(8, Math.ceil(1.5 / grid.cellSize));
  const start = findNearestCell(grid, from.col, from.row, passable, snapRadius);
  if (!start) return { ...base, failure: 'start-blocked' };
  const goal = findNearestCell(grid, to.col, to.row, passable, snapRadius);
  if (!goal) return { ...base, failure: 'goal-blocked' };

  const snappedStart = start.col !== from.col || start.row !== from.row;
  const snappedGoal = goal.col !== to.col || goal.row !== to.row;

  const count = grid.cols * grid.rows;
  const gScore = new Float64Array(count).fill(Infinity);
  const cameFrom = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const open = new Heap(count);

  const startIdx = cellIndex(grid, start.col, start.row);
  const goalIdx = cellIndex(grid, goal.col, goal.row);

  gScore[startIdx] = 0;
  open.push(startIdx, octile(goal.col - start.col, goal.row - start.row));

  let expanded = 0;

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    expanded++;

    if (current === goalIdx) {
      const cells: Cell[] = [];
      for (let i: number = current; i !== -1; i = cameFrom[i]) {
        cells.push({ col: i % grid.cols, row: Math.floor(i / grid.cols) });
      }
      cells.reverse();
      return {
        found: true, cells, start, goal,
        snappedStart, snappedGoal, expanded, failure: null,
      };
    }

    if (expanded > opts.maxExpansions) {
      return { ...base, start, goal, snappedStart, snappedGoal, expanded, failure: 'expansion-budget' };
    }

    const cc = current % grid.cols;
    const cr = Math.floor(current / grid.cols);

    for (const [dc, dr, step] of NEIGHBOURS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (!passable(nc, nr)) continue;

      // No corner cutting: a diagonal needs both orthogonal sides open, or the
      // camera clips the corner where two walls meet.
      if (dc !== 0 && dr !== 0) {
        if (!passable(cc + dc, cr) || !passable(cc, cr + dr)) continue;
      }

      const nIdx = cellIndex(grid, nc, nr);
      if (closed[nIdx]) continue;

      // Soft cost: squeeze past a wall and you pay for it.
      const clearance = grid.clearance[nIdx];
      const tightness = Math.max(0, 1 - Math.min(clearance, opts.comfortDistance) / opts.comfortDistance);
      const moveCost = step * (1 + opts.clearanceWeight * tightness * tightness);

      const tentative = gScore[current] + moveCost;
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = current;
        open.pushOrUpdate(nIdx, tentative + octile(goal.col - nc, goal.row - nr));
      }
    }
  }

  return { ...base, start, goal, snappedStart, snappedGoal, expanded, failure: 'unreachable' };
}

/* ------------------------------ string pulling ---------------------------- */

/**
 * Drop cells the path does not need.
 *
 * A raw grid path staircases along diagonals; feeding that straight into a
 * spline produces visible ripple. Keeping only the cells where line-of-sight
 * actually breaks gives the spline honest corners to round off, and leaves long
 * straight runs genuinely straight.
 */
export function simplifyPath(grid: WalkGrid, cells: Cell[], radius: number): Cell[] {
  if (cells.length <= 2) return cells.slice();

  const out: Cell[] = [cells[0]];
  let anchor = 0;

  while (anchor < cells.length - 1) {
    let furthest = anchor + 1;
    for (let probe = cells.length - 1; probe > anchor; probe--) {
      const a = cells[anchor];
      const b = cells[probe];
      if (hasLineOfSight(grid, a.col, a.row, b.col, b.row, radius)) {
        furthest = probe;
        break;
      }
    }
    out.push(cells[furthest]);
    anchor = furthest;
  }

  return out;
}
