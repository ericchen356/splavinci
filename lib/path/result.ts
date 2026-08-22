/**
 * THE LOCKED OUTPUT CONTRACT of the path generator.
 *
 * The plan screen draws `polyline`; the review screen scrubs `frames` and reads
 * `segments` + `shots` for its technique label. Both bind to the shapes here,
 * so treat this file as an interface: add fields freely, change or remove one
 * only by updating every consumer.
 */

import type { FrameEntry, Vec3 } from '@/lib/types';
import type { ShotIntent } from './shots';

export type PathWarningCode =
  | 'no-collider'
  | 'no-waypoints'
  | 'single-waypoint'
  | 'waypoint-snapped'
  | 'unreachable'
  | 'curve-clips-wall'
  | 'shot-clipped'
  | 'degenerate-segment';

export type PathWarning = {
  code: PathWarningCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** Waypoints the reader should go look at. */
  waypointIds: string[];
};

export type PathSegmentInfo = {
  id: string;
  kind: 'shot' | 'travel';
  /** Waypoint whose shot governs this segment. Travel is attributed to the
   *  waypoint it is heading TOWARD - the approach belongs to the shot it sets
   *  up, so the review label names the shot you are about to see. */
  waypointId: string;
  fromWaypointId: string | null;
  toWaypointId: string | null;
  startTime: number;
  endTime: number;
  /** Index of this segment's first frame in `frames`. */
  frameStart: number;
  frameCount: number;
  /** True when this segment came from cache instead of being recomputed. */
  reused: boolean;
};

export type PathStats = {
  gridCols: number;
  gridRows: number;
  cellSize: number;
  recomputedSegments: number;
  reusedSegments: number;
  /** Frames whose view rotation hit the turn-rate ceiling. */
  turnRateClampedFrames: number;
  /** Milliseconds spent in generation, excluding grid construction. */
  generateMs: number;
  gridMs: number;
};

export type PathResult = {
  /** The full sampled camera table. Monotonic in timeSeconds, starting at 0. */
  frames: FrameEntry[];
  fps: number;
  /** Total length in seconds. */
  duration: number;
  segments: PathSegmentInfo[];
  /** Resolved shot per waypoint, in waypoint order. */
  shots: ShotIntent[];
  /** Travelled floor route, for drawing in 3D and on the mini-map. */
  polyline: Vec3[];
  warnings: PathWarning[];
  stats: PathStats;
};

export const EMPTY_PATH: PathResult = {
  frames: [],
  fps: 30,
  duration: 0,
  segments: [],
  shots: [],
  polyline: [],
  warnings: [],
  stats: {
    gridCols: 0, gridRows: 0, cellSize: 0,
    recomputedSegments: 0, reusedSegments: 0, turnRateClampedFrames: 0,
    generateMs: 0, gridMs: 0,
  },
};

/**
 * Index of the frame at or just before `time`. Binary search; frames are
 * time-ordered. Returns -1 for an empty table.
 *
 * The index, not the frame, is the primitive: sampleAtTime needs the next
 * frame too, and recovering the position with indexOf turned an O(log n)
 * lookup into an O(n) scan run twice per rendered frame.
 */
export function frameIndexAtTime(frames: readonly FrameEntry[], time: number): number {
  if (frames.length === 0) return -1;
  if (time <= frames[0].timeSeconds) return 0;
  if (time >= frames[frames.length - 1].timeSeconds) return frames.length - 1;

  let lo = 0;
  let hi = frames.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timeSeconds <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Frame at or just before `time`. */
export function frameAtTime(frames: readonly FrameEntry[], time: number): FrameEntry | null {
  const i = frameIndexAtTime(frames, time);
  return i < 0 ? null : frames[i];
}

/** Interpolated camera state at `time`, for smooth scrubbing between frames. */
export function sampleAtTime(
  frames: readonly FrameEntry[],
  time: number,
): { position: Vec3; lookAt: Vec3; activeWaypointId: string } | null {
  const i = frameIndexAtTime(frames, time);
  if (i < 0) return null;
  const a = frames[i];
  const b = i + 1 < frames.length ? frames[i + 1] : a;
  const span = b.timeSeconds - a.timeSeconds;
  const t = span > 1e-6 ? Math.min(1, Math.max(0, (time - a.timeSeconds) / span)) : 0;
  const mix = (p: Vec3, q: Vec3): Vec3 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
  ];
  return {
    position: mix(a.position, b.position),
    lookAt: mix(a.lookAt, b.lookAt),
    activeWaypointId: a.activeWaypointId,
  };
}

/** Which segment owns `time`. */
export function segmentAtTime(
  segments: readonly PathSegmentInfo[],
  time: number,
): PathSegmentInfo | null {
  for (const s of segments) {
    if (time >= s.startTime && time < s.endTime) return s;
  }
  return segments.length > 0 ? segments[segments.length - 1] : null;
}
