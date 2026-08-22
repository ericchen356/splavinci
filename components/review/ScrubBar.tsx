'use client';

/**
 * Scrub bar with segment ticks and comment marks.
 *
 * A plain range input cannot carry the marks, so the track is drawn and hit
 * tested directly. Comment marks are clickable targets in their own right and
 * are checked before a scrub, so clicking a mark jumps to that comment rather
 * than seeking to wherever the pointer happened to land.
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
};

const HEIGHT = 34;

export function ScrubBar({
  time, duration, segments = [], comments = [], onSeek, onCommentClick,
}: ScrubBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

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
      if (!el || duration <= 0) return;
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;

      // A comment mark under the pointer wins over a seek.
      for (const c of comments) {
        const cx = (c.timeSeconds / duration) * rect.width;
        if (Math.abs(cx - x) <= 6) {
          onCommentClick?.(c);
          return;
        }
      }

      dragging.current = true;
      el.setPointerCapture(event.pointerId);
      seekFromEvent(event.clientX);
    },
    [comments, duration, onCommentClick, seekFromEvent],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragging.current) seekFromEvent(event.clientX);
    },
    [seekFromEvent],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    trackRef.current?.releasePointerCapture(event.pointerId);
  }, []);

  const pct = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'relative', height: HEIGHT, cursor: duration > 0 ? 'pointer' : 'default',
        background: 'var(--panel-2)', border: '1px solid var(--line)',
        borderRadius: 'var(--radius)', overflow: 'hidden', touchAction: 'none',
      }}
    >
      {/* shot segments, alternating so the rhythm of the edit is visible */}
      {duration > 0 && segments.map((s, i) => (
        <div
          key={s.id}
          title={`${s.kind}: ${s.waypointId}`}
          style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${(s.startTime / duration) * 100}%`,
            width: `${((s.endTime - s.startTime) / duration) * 100}%`,
            background: s.kind === 'shot'
              ? 'rgba(110,168,254,0.16)'
              : 'rgba(110,168,254,0.05)',
            borderLeft: i === 0 ? 'none' : '1px solid rgba(110,168,254,0.28)',
          }}
        />
      ))}

      {/* elapsed */}
      <div
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 0, width: `${pct}%`,
          background: 'rgba(110,168,254,0.28)', pointerEvents: 'none',
        }}
      />

      {/* comment marks */}
      {duration > 0 && comments.map((c) => (
        <div
          key={c.id}
          title={c.text}
          style={{
            position: 'absolute', top: 0, bottom: 0,
            left: `${(c.timeSeconds / duration) * 100}%`,
            width: 2, marginLeft: -1, background: 'var(--warn)', pointerEvents: 'none',
          }}
        />
      ))}

      {/* playhead */}
      <div
        style={{
          position: 'absolute', top: 0, bottom: 0, left: `${pct}%`,
          width: 2, marginLeft: -1, background: 'var(--text)', pointerEvents: 'none',
        }}
      />
    </div>
  );
}
