'use client';

/**
 * Scrub bar with segment ticks and comment marks.
 *
 * A plain range input cannot carry the marks, so the track is drawn and hit
 * tested directly. Comment marks are clickable targets in their own right and
 * are checked before a scrub, so clicking a mark jumps to that comment rather
 * than seeking to wherever the pointer happened to land.
 *
 * Drawing the track by hand means the semantics have to be supplied by hand
 * too: it is a slider, so it says so, takes the arrow keys a slider takes, and
 * reports its position as a timecode rather than as a float. Without that it
 * is a div that only a mouse can operate - and the playhead is the one control
 * on this screen with no keyboard equivalent anywhere else.
 */

import { useCallback, useRef } from 'react';
import type { Comment } from '@/lib/types';
import type { PathSegmentInfo } from '@/lib/path';

export type ScrubBarProps = {
  time: number;
  duration: number;
  segments?: readonly PathSegmentInfo[];
  comments?: readonly Comment[];
  onSeek: (time: number) => void;
  onCommentClick?: (comment: Comment) => void;
  /** Read-only track: still drawn, but it cannot be scrubbed or clicked. */
  disabled?: boolean;
};

/** Arrow-key step, and the bigger step Shift asks for. Seconds, not frames:
 *  the user is looking for a moment in a flythrough, not editing a cut. */
const STEP = 1;
const STEP_COARSE = 5;

/** Pointer slop around a comment mark. The mark is 2px wide and is the only
 *  target on the track that is not the track itself. */
const MARK_GRAB_PX = 6;

/**
 * Shared by the whole screen so one clock formats every timecode - the badge,
 * the transport, the comment list and this bar's own spoken position had four
 * copies of it, and they had already drifted to three different precisions.
 */
export function timecode(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

export function ScrubBar({
  time, duration, segments = [], comments = [], onSeek, onCommentClick, disabled = false,
}: ScrubBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const interactive = duration > 0 && !disabled;

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || duration <= 0) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(ratio * duration);
    },
    [duration, onSeek],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const el = trackRef.current;
      if (!el || !interactive) return;
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;

      // A comment mark under the pointer wins over a seek.
      for (const c of comments) {
        const cx = (c.timeSeconds / duration) * rect.width;
        if (Math.abs(cx - x) <= MARK_GRAB_PX) {
          onCommentClick?.(c);
          return;
        }
      }

      dragging.current = true;
      el.setPointerCapture(event.pointerId);
      seekFromEvent(event.clientX);
    },
    [comments, duration, interactive, onCommentClick, seekFromEvent],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragging.current) seekFromEvent(event.clientX);
    },
    [seekFromEvent],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    // Guarded: releasing a pointer that is no longer captured - the browser
    // took it back, the gesture was cancelled - throws NotFoundError.
    const el = trackRef.current;
    if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  }, []);

  // A cancelled or stolen gesture never reports pointerup, and a drag flag
  // left set turns every subsequent hover over the track into a seek.
  const onLostPointerCapture = useCallback(() => {
    dragging.current = false;
  }, []);

  /* The keys a slider is expected to answer to. Space is deliberately absent:
     it belongs to the transport, and the review screen binds it there so that
     it means the same thing wherever focus happens to be. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const step = event.shiftKey ? STEP_COARSE : STEP;
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown': onSeek(time - step); break;
        case 'ArrowRight':
        case 'ArrowUp': onSeek(time + step); break;
        case 'PageDown': onSeek(time - STEP_COARSE); break;
        case 'PageUp': onSeek(time + STEP_COARSE); break;
        case 'Home': onSeek(0); break;
        case 'End': onSeek(duration); break;
        default: return;
      }
      // Only for keys actually handled above: the arrows scroll the sidebar
      // otherwise, and Tab must stay Tab.
      event.preventDefault();
    },
    [duration, interactive, onSeek, time],
  );

  const pct = duration > 0 ? (Math.min(time, duration) / duration) * 100 : 0;

  return (
    <div
      ref={trackRef}
      className={`review__scrub${duration > 0 ? '' : ' review__scrub--idle'}`}
      role="slider"
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, duration)}
      aria-valuenow={Math.min(time, Math.max(0, duration))}
      /* A float of seconds read aloud is not a position in a video. */
      aria-valuetext={`${timecode(time)} of ${timecode(duration)}`}
      aria-disabled={disabled || duration <= 0}
      // Reachable only while there is something to scrub: a slider that
      // cannot move is a stop on the tab route that answers to nothing.
      tabIndex={interactive ? 0 : -1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={onLostPointerCapture}
    >
      {/* shot segments, washed so the rhythm of the edit is visible */}
      {duration > 0 && segments.map((s, i) => (
        <div
          key={s.id}
          title={`${s.kind}: ${s.waypointId}`}
          className={
            `review__seg${s.kind === 'travel' ? ' review__seg--travel' : ''}` +
            `${i === 0 ? '' : ' review__seg--split'}`
          }
          style={{
            left: `${(s.startTime / duration) * 100}%`,
            width: `${((s.endTime - s.startTime) / duration) * 100}%`,
          }}
        />
      ))}

      {/* elapsed */}
      <div className="review__elapsed" style={{ width: `${pct}%` }} />

      {/* comment marks */}
      {duration > 0 && comments.map((c) => (
        <div
          key={c.id}
          title={c.text}
          className="review__mark"
          style={{ left: `${(c.timeSeconds / duration) * 100}%` }}
        />
      ))}

      {/* playhead */}
      <div className="review__head" style={{ left: `${pct}%` }} />
    </div>
  );
}
