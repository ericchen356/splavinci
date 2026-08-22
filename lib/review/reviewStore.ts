'use client';

/**
 * Playback state for the review screen.
 *
 * Time is the single scrub position; everything else - the 3D camera, the
 * mini-map dot, the technique label - is derived from it by looking up the
 * FrameEntry table. Nothing here recomputes a path; that is lib/path's job and
 * this screen only reads its output.
 *
 * The capture lives here too, rather than in a component ref: a ref dies with
 * the screen, and a MediaRecorder that outlives its owner keeps its stream
 * tracks running while `recording: true` sits stranded in this module
 * singleton with nothing left able to clear it.
 */

import { create } from 'zustand';
import type { Vec3 } from '@/lib/types';
import { CanvasRecorder, type RecordingResult } from './recorder';

export type DraftComment = {
  timeSeconds: number;
  position: Vec3;
  lookAt: Vec3;
};

export type ReviewStore = {
  time: number;
  /** Length of the path being reviewed; the clamp bound for `time`. */
  duration: number;
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
  /** Publish the current path's length; re-clamps `time` if it shrank. */
  setDuration(duration: number): void;
  advance(delta: number): void;

  /** Begin a real-time capture of `canvas`, from the top. */
  startRecording(canvas: HTMLCanvasElement, fps: number): void;
  /** Close the capture and keep the file. */
  finishRecording(): Promise<void>;
  /** Close the capture and throw the file away. */
  cancelRecording(): void;
  /** The captured canvas is going away: drop the capture, free the tracks. */
  releaseRecorder(): void;
  setRecordError(message: string | null): void;
  setVideo(video: RecordingResult | null): void;

  beginDraft(draft: DraftComment): void;
  cancelDraft(): void;

  editWaypoint(id: string | null): void;
};

/**
 * Non-reactive, deliberately outside the state: a live MediaRecorder has no
 * business triggering re-renders, but it must outlive the component that
 * started it or it cannot be shut down again.
 */
let activeRecorder: CanvasRecorder | null = null;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  time: 0,
  duration: 0,
  playing: false,
  recording: false,
  recordError: null,
  video: null,
  canvas: null,
  draft: null,
  editingWaypointId: null,

  setCanvas(canvas) { set({ canvas }); },

  play() { set({ playing: true, draft: null }); },

  /* A running capture owns the transport. Pausing freezes the canvas and the
     export records a still; seeking cuts to somewhere else mid-shot. Ending a
     capture early is cancelRecording() - an explicit act, never a side effect
     of touching the transport. */
  pause() {
    if (get().recording) return;
    set({ playing: false });
  },
  toggle() {
    if (get().recording) return;
    set((s) => ({ playing: !s.playing, draft: s.playing ? s.draft : null }));
  },

  // Clamped, because duration shrinks under the playhead: trim a shot from the
  // technique panel and an unclamped time reads 0:35.0 / 0:20.0 with the
  // playhead rendered off the end of its own track.
  seek(time) {
    const { duration, recording } = get();
    if (recording) return;
    set({ time: Math.min(Math.max(0, time), Math.max(0, duration)) });
  },

  setDuration(duration) {
    const next = Math.max(0, duration);
    set((s) => ({ duration: next, time: Math.min(s.time, next) }));
  },

  advance(delta) {
    const { time, playing, duration } = get();
    if (!playing) return;
    const next = time + delta;
    if (duration > 0 && next >= duration) {
      set({ time: duration, playing: false });
      // The capture closes when the flythrough ends and at no other moment.
      // Keyed off any playing -> false transition it would treat a pause or a
      // rewind as "done", and hand back a truncated file as the export.
      if (get().recording) void get().finishRecording();
    } else {
      set({ time: next });
    }
  },

  startRecording(canvas, fps) {
    // Never stack captures: a leftover recorder means an earlier one was never
    // closed and its tracks are still holding the canvas.
    activeRecorder?.abort();
    activeRecorder = null;
    try {
      const recorder = new CanvasRecorder(canvas, fps);
      recorder.onError = (error) => {
        activeRecorder = null;
        set({ recording: false, playing: false, recordError: error.message });
      };
      recorder.start();
      activeRecorder = recorder;
      get().setVideo(null);
      set({ recording: true, recordError: null, time: 0, playing: true, draft: null });
    } catch (err) {
      activeRecorder = null;
      set({ recording: false, recordError: messageOf(err) });
    }
  },

  async finishRecording() {
    const recorder = activeRecorder;
    activeRecorder = null;
    if (!recorder) {
      // Still clears the flag. A capture orphaned by a navigation leaves
      // `recording` true with no recorder behind it, and returning early there
      // wedges the transport into a red badge with Record disabled forever.
      set({ recording: false, recordError: null });
      return;
    }
    set({ recording: false });
    try {
      get().setVideo(await recorder.stop());
    } catch (err) {
      set({ recordError: messageOf(err) });
    }
  },

  cancelRecording() {
    const recorder = activeRecorder;
    activeRecorder = null;
    recorder?.abort();
    set({ recording: false, playing: false, recordError: null });
  },

  releaseRecorder() {
    const recorder = activeRecorder;
    if (!recorder) return;
    activeRecorder = null;
    recorder.abort();
    set({
      recording: false,
      playing: false,
      recordError: 'Recording discarded — the review screen was closed mid-capture.',
    });
  },

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
