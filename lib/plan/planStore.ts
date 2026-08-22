'use client';

/**
 * The authoring store: waypoints, style, and the generated path.
 *
 * ONE waypoint list, shared by the 3D viewport and the mini-map. Both views
 * read this array and write back through these actions - there is deliberately
 * no second copy anywhere and no sync step, because two lists reconciled after
 * the fact is exactly how a click in one view ends up silently disagreeing with
 * the other. The mini-map is a different projection of this state, not a
 * different model of it.
 *
 * The path generator's cache lives outside the reactive state (a Map of live
 * THREE curves has no business triggering re-renders), so editing one waypoint
 * recomputes only the legs touching it. See lib/path/generate.ts.
 */

import { create } from 'zustand';
import type { Comment, PathSettings, PathStyle, Vec3, Waypoint } from '@/lib/types';
import type { ColliderData } from '@/lib/scene/collider';
import {
  createPathCache,
  generatePath,
  type PathCache,
  type PathResult,
} from '@/lib/path';

/** Non-reactive: holds live THREE curves between generations. */
let pathCache: PathCache = createPathCache();

let waypointCounter = 0;
function nextWaypointId(): string {
  waypointCounter += 1;
  return `wp-${waypointCounter}`;
}

/** A newly dropped waypoint starts fully automatic - the user opts in to control. */
export function makeWaypoint(position: Vec3): Waypoint {
  return {
    id: nextWaypointId(),
    position,
    shotType: 'orbit',
    controlSpectrum: 0,
    duration: 4,
    pinned: false,
  };
}

export type PlanStore = {
  waypoints: Waypoint[];
  selectedId: string | null;
  settings: PathSettings;
  path: PathResult | null;
  generating: boolean;
  /** Bumped whenever waypoints change after a generate, so the UI can say "stale". */
  dirty: boolean;

  addWaypoint(position: Vec3): string;
  moveWaypoint(id: string, position: Vec3): void;
  updateWaypoint(id: string, patch: Partial<Omit<Waypoint, 'id'>>): void;
  removeWaypoint(id: string): void;
  reorderWaypoint(id: string, delta: number): void;
  clearWaypoints(): void;

  select(id: string | null): void;
  setStyle(style: PathStyle): void;

  generate(collider: ColliderData | null): void;

  /* comments live here too so the review screen and the mini-map share one list */
  comments: Comment[];
  addComment(comment: Omit<Comment, 'id'>): string;
  removeComment(id: string): void;
};

let commentCounter = 0;

export const usePlanStore = create<PlanStore>((set, get) => ({
  waypoints: [],
  selectedId: null,
  settings: { style: 'realEstate' },
  path: null,
  generating: false,
  dirty: false,
  comments: [],

  addWaypoint(position) {
    const wp = makeWaypoint(position);
    set((s) => ({ waypoints: [...s.waypoints, wp], selectedId: wp.id, dirty: true }));
    return wp.id;
  },

  moveWaypoint(id, position) {
    // A drag is an explicit edit, so the waypoint is pinned: the generator will
    // rebuild this leg and its neighbours and reuse the rest of the table.
    set((s) => ({
      waypoints: s.waypoints.map((w) => (w.id === id ? { ...w, position, pinned: true } : w)),
      dirty: true,
    }));
  },

  updateWaypoint(id, patch) {
    set((s) => ({
      waypoints: s.waypoints.map((w) => (w.id === id ? { ...w, ...patch, pinned: true } : w)),
      dirty: true,
    }));
  },

  removeWaypoint(id) {
    set((s) => ({
      waypoints: s.waypoints.filter((w) => w.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      dirty: true,
    }));
  },

  reorderWaypoint(id, delta) {
    set((s) => {
      const index = s.waypoints.findIndex((w) => w.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= s.waypoints.length) return {};
      const next = s.waypoints.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, { ...moved, pinned: true });
      return { waypoints: next, dirty: true };
    });
  },

  clearWaypoints() {
    pathCache = createPathCache();
    set({ waypoints: [], selectedId: null, path: null, dirty: false });
  },

  select(id) {
    set({ selectedId: id });
  },

  setStyle(style) {
    set((s) => ({ settings: { ...s.settings, style }, dirty: true }));
  },

  generate(collider) {
    const { waypoints, settings } = get();
    set({ generating: true });
    try {
      const path = generatePath({ collider, waypoints, settings }, pathCache);
      // Generation consumes the pins: they have done their job of scoping the
      // recompute, and leaving them set would force the same legs to rebuild
      // on every subsequent generate.
      set({
        path,
        generating: false,
        dirty: false,
        waypoints: waypoints.map((w) => (w.pinned ? { ...w, pinned: false } : w)),
      });
    } catch (err) {
      set({ generating: false });
      throw err;
    }
  },

  addComment(comment) {
    commentCounter += 1;
    const full: Comment = { ...comment, id: `c-${commentCounter}` };
    set((s) => ({ comments: [...s.comments, full] }));
    return full.id;
  },

  removeComment(id) {
    set((s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
  },
}));

/** Read the selected waypoint without subscribing to the whole list. */
export function useSelectedWaypoint(): Waypoint | null {
  return usePlanStore((s) => s.waypoints.find((w) => w.id === s.selectedId) ?? null);
}
