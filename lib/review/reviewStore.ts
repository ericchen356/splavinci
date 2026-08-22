'use client';

/**
 * Playback state for the review screen.
 *
 * Time is the single scrub position; everything else - the 3D camera, the
 * mini-map dot, the technique label - is derived from it by looking up the
 * FrameEntry table. Nothing here recomputes a path; that is lib/path's job and
 * this screen only reads its output.
 */

import { create } from 'zustand';
import type { Vec3 } from '@/lib/types';
import type { RecordingResult } from './recorder';

export type DraftComment = {
  timeSeconds: number;
  position: Vec3;
  lookAt: Vec3;
};

export type ReviewStore = {
  time: number;
  playing: boolean;
  /** True while a real-time capture is running. */
  recording: boolean;
  recordError: string | null;
  video: RecordingResult | null;
  /** The live canvas, registered from inside the R3F tree. */
  canvas: HTMLCanvasElement | null;
  /** Pending comment being typed, or null. */
  draft: DraftComment | null;
  /** Waypoint whose panel the technique label opened, or null. */
  editingWaypointId: string | null;

  setCanvas(canvas: HTMLCanvasElement | null): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(time: number): void;
  advance(delta: number, duration: number): void;

  setRecording(recording: boolean): void;
  setRecordError(message: string | null): void;
  setVideo(video: RecordingResult | null): void;

  beginDraft(draft: DraftComment): void;
  cancelDraft(): void;

  editWaypoint(id: string | null): void;
};

export const useReviewStore = create<ReviewStore>((set, get) => ({
  time: 0,
  playing: false,
  recording: false,
  recordError: null,
  video: null,
  canvas: null,
  draft: null,
  editingWaypointId: null,

  setCanvas(canvas) { set({ canvas }); },

  play() { set({ playing: true, draft: null }); },
  pause() { set({ playing: false }); },
  toggle() { set((s) => ({ playing: !s.playing, draft: s.playing ? s.draft : null })); },

  seek(time) { set({ time: Math.max(0, time) }); },

  advance(delta, duration) {
    const { time, playing } = get();
    if (!playing) return;
    const next = time + delta;
    if (duration > 0 && next >= duration) {
      set({ time: duration, playing: false });
    } else {
      set({ time: next });
    }
  },

  setRecording(recording) { set({ recording }); },
  setRecordError(message) { set({ recordError: message }); },
  setVideo(video) {
    // Release the previous object URL; these are not garbage collected.
    const previous = get().video;
    if (previous) URL.revokeObjectURL(previous.url);
    set({ video });
  },

  beginDraft(draft) { set({ draft, playing: false }); },
  cancelDraft() { set({ draft: null }); },

  editWaypoint(id) { set({ editingWaypointId: id }); },
}));
