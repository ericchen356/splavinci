'use client';

/**
 * Drives the R3F camera straight off the FrameEntry table.
 *
 * Time is advanced here, inside the render loop, so playback stays locked to
 * the frames actually being drawn rather than to a separate timer that can
 * drift away from them. The table is sampled with interpolation, so scrubbing
 * between two 30fps entries still moves smoothly.
 *
 * Also registers the live canvas with the review store, which is where the
 * recorder gets its captureStream() source.
 */

import { useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { FrameEntry } from '@/lib/types';
import { sampleAtTime } from '@/lib/path';
import { useReviewStore } from '@/lib/review/reviewStore';

const lookTarget = new THREE.Vector3();

export function PlaybackCamera({ frames }: { frames: readonly FrameEntry[] }) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const setCanvas = useReviewStore((s) => s.setCanvas);

  useEffect(() => {
    setCanvas(gl.domElement);
    return () => setCanvas(null);
  }, [gl, setCanvas]);

  useFrame((_, delta) => {
    const store = useReviewStore.getState();
    // Clamp the step: a backgrounded tab returns a huge delta and would jump
    // the playhead most of the way through the flythrough on the next frame.
    store.advance(Math.min(delta, 0.1));

    const sample = sampleAtTime(frames, store.time);
    if (!sample) return;
    camera.position.set(sample.position[0], sample.position[1], sample.position[2]);
    lookTarget.set(sample.lookAt[0], sample.lookAt[1], sample.lookAt[2]);
    camera.lookAt(lookTarget);
  });

  return null;
}
