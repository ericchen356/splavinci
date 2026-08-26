'use client';

/**
 * A key that grabs the frame you are looking at.
 *
 * Mount inside a <Canvas>, next to whatever is driving the camera:
 *
 *   <CameraRig />
 *   <PoseCapture onCapture={addWaypoint} />
 *
 * WHY THIS IS A COMPONENT AND NOT A HANDLER ON THE PAGE
 * The pose has to be read from the LIVE camera at the instant the key goes
 * down. The page only sees the camera through CameraTracker, which publishes at
 * 12 Hz and only once the camera has moved far enough to be worth a re-render -
 * so a capture taken from that would be up to 80 ms and a few centimetres stale,
 * and after a small nudge would be the pose from BEFORE the nudge. Reading
 * `useThree().camera` here means the waypoint is the frame that was on screen.
 *
 * Listening on window rather than on the canvas, deliberately: the fly rig does
 * the same, so W-A-S-D and the capture key answer to the same focus rules, and
 * a canvas that has never been clicked is not focused at all.
 */

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import type { CameraPose } from '@/lib/types';
import { poseFromCamera } from '@/lib/pose';

export type PoseCaptureProps = {
  /** `KeyboardEvent.code`, so it is a physical key and not a layout's letter. */
  hotkey?: string;
  onCapture: (pose: CameraPose) => void;
  enabled?: boolean;
};

/** Anything that takes typing, where F is an F. */
function isTyping(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

export function PoseCapture({ hotkey = 'KeyF', onCapture, enabled = true }: PoseCaptureProps) {
  const camera = useThree((s) => s.camera);

  /* The callback through a ref, so re-binding the listener does not depend on
     the page passing a stable function - a page that rebuilds its handler each
     render would otherwise tear down and re-add the listener every frame the
     camera moves. */
  const capture = useRef(onCapture);
  capture.current = onCapture;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== hotkey) return;
      // Held keys must not machine-gun waypoints; a capture is one deliberate
      // act per press.
      if (e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      capture.current(poseFromCamera(camera));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, hotkey, camera]);

  return null;
}
