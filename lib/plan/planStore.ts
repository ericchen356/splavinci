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
import type {
  CameraPose,
  Comment,
  PathSettings,
  PathStyle,
  Vec3,
  Waypoint,
} from '@/lib/types';
import type { ColliderData } from '@/lib/scene/collider';
import { describeError } from '@/lib/scene/loaders';
import {
  createPathCache,
  generatePath,
  type PathCache,
  type PathResult,
} from '@/lib/path';

/** Non-reactive: holds live THREE curves between generations. */
let pathCache: PathCache = createPathCache();

/**
 * The in-flight generate, if any. Non-reactive because it exists to serialise
 * calls, not to be rendered - `generating` is the flag the UI reads.
 */
let generateRun: Promise<void> | null = null;
/** Newest collider handed to `generate`, read by the run after it yields. */
let generateCollider: ColliderData | null = null;

/**
 * Resolve after the browser has painted.
 *
 * `generatePath` is synchronous, so raising `generating` and running it in the
 * same task collapsed into a single render with the flag already lowered: the
 * pending label could never appear, and the click just froze. The first
 * animation frame runs before the paint that shows the flag, the second after
 * it. The timeout is the escape hatch for a backgrounded tab, where rAF is
 * suspended and the button would otherwise stick on "Generating…" forever.
 */
function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 250);
  });
}

let waypointCounter = 0;
function nextWaypointId(): string {
  waypointCounter += 1;
  return `wp-${waypointCounter}`;
}

/**
 * A newly captured waypoint starts fully automatic - the user opts in to
 * control.
 *
 * The pose is copied field by field rather than spread, so a caller handing in
 * a live object (the capture reads straight off the camera) cannot leave the
 * store holding a reference that keeps changing under it.
 */
export function makeWaypoint(pose: CameraPose): Waypoint {
  return {
    id: nextWaypointId(),
    position: [pose.position[0], pose.position[1], pose.position[2]],
    yaw: pose.yaw,
    pitch: pose.pitch,
    fov: pose.fov,
    // New waypoints start automatic: the user opts in to control.
    mode: 'auto',
    shotType: 'orbit',
    duration: 4,
    emphasis: 1,
    /* Null takes the captured facing. Deliberately not seeded from `yaw` here:
       a stored aim reads as "the user set this", so the dial would open marked
       `set by you` on a bearing nobody typed, and Reset would have nothing to
       go back to. resolveShot derives the same bearing from the pose anyway. */
    aim: null,
    // The collider is trusted until it is caught being wrong about this shot.
    ignoreWalls: false,
    pinned: false,
  };
}

export type PlanStore = {
  waypoints: Waypoint[];
  selectedId: string | null;
  settings: PathSettings;
  path: PathResult | null;
  generating: boolean;
  /** Whatever the last generate threw, so a failure is visible instead of lost. */
  generateError: string | null;
  /** Bumped whenever waypoints change after a generate, so the UI can say "stale". */
  dirty: boolean;

  /** Record the camera exactly as it stands. The capture key's whole job. */
  addWaypoint(pose: CameraPose): string;
  /** Move a waypoint's camera without touching how it is pointed. */
  moveWaypoint(id: string, position: Vec3): void;
  updateWaypoint(id: string, patch: Partial<Omit<Waypoint, 'id'>>): void;
  removeWaypoint(id: string): void;
  reorderWaypoint(id: string, delta: number): void;
  /** Empty the route but keep the comments: same room, so they still point at
   *  places the user can see. Use `resetPlan` when the room itself changes. */
  clearWaypoints(): void;
  /** Throw away everything anchored to the current room's coordinates. */
  resetPlan(): void;

  select(id: string | null): void;
  setStyle(style: PathStyle): void;

  generate(collider: ColliderData | null): Promise<void>;

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
  generateError: null,
  dirty: false,
  comments: [],

  addWaypoint(pose) {
    const wp = makeWaypoint(pose);
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
    set({ waypoints: [], selectedId: null, path: null, dirty: false, generateError: null });
  },

  resetPlan() {
    // Comments go too. They are world coordinates plus a timestamp on a path
    // that no longer exists, so keeping them across a capture switch pins every
    // note to a spot in a room that is not loaded any more - while deleting the
    // waypoints those notes were written about. Everything anchored to the old
    // room leaves together or none of it does.
    pathCache = createPathCache();
    set({
      waypoints: [],
      selectedId: null,
      path: null,
      dirty: false,
      generateError: null,
      comments: [],
    });
  },

  select(id) {
    set({ selectedId: id });
  },

  setStyle(style) {
    set((s) => ({ settings: { ...s.settings, style }, dirty: true }));
  },

  generate(collider) {
    // Calls that land while one is already yielding to the paint are folded
    // into it rather than queued behind it - a slider that fires thirty edits a
    // second must not book thirty rebuilds. Folding is safe because the run
    // reads its inputs AFTER the yield: whatever changed in the meantime is
    // already in `get()` and in `generateCollider` by the time work starts.
    // Nothing can arrive during the work itself - `generatePath` is
    // synchronous, so no handler runs until it returns.
    generateCollider = collider;
    if (generateRun) return generateRun;

    const run = (async () => {
      set({ generating: true, generateError: null });
      await afterPaint();

      const { waypoints, settings } = get();
      try {
        const path = generatePath(
          { collider: generateCollider, waypoints, settings },
          pathCache,
        );
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
        // Rethrowing landed in an onClick handler, where nothing catches it and
        // the user sees the button do nothing at all. The failure is state now,
        // so the screen can say what went wrong.
        set({ generating: false, generateError: describeError(err) });
      }
    })();

    generateRun = run;
    void run.finally(() => {
      if (generateRun === run) generateRun = null;
    });
    return run;
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
