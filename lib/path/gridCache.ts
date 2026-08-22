/**
 * One walk grid per collider, shared by everything that needs it.
 *
 * The generator rasterises a grid to route on; the mini-map draws the same
 * footprint. Building it twice would waste the work and, worse, let the two
 * drift apart if their options ever diverged - the map would then show a
 * doorway the router does not believe in. A WeakMap keyed on the parsed
 * collider keeps them identical and lets the grid be collected with it.
 */

import type { ColliderData } from '@/lib/scene/collider';
import { buildWalkGrid, type GridOptions, type WalkGrid } from './grid';

type Entry = { key: string; grid: WalkGrid };

const cache = new WeakMap<ColliderData, Entry>();

function optionsKey(options?: GridOptions): string {
  return options ? JSON.stringify(options) : 'default';
}

export function getWalkGrid(collider: ColliderData, options?: GridOptions): WalkGrid {
  const key = optionsKey(options);
  const hit = cache.get(collider);
  if (hit && hit.key === key) return hit.grid;
  const grid = buildWalkGrid(collider, options);
  cache.set(collider, { key, grid });
  return grid;
}
