'use client';

/**
 * The Gaussian splat environment, rendered through Spark.
 *
 * Spark works by putting one SparkRenderer in the scene; it collects every
 * SplatMesh in that scene graph, sorts them and draws them in one pass. The
 * SparkRenderer is added straight to the R3F scene root (not as a child of
 * this component's group) because it is the shared draw surface for all
 * splats and must not inherit a parent transform.
 */

import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { useRoomStore } from '@/lib/scene/roomStore';
import { DEFAULT_SPLAT_TRANSFORM, type SplatTransform } from '@/lib/scene/splat';

export type SplatLayerProps = {
  /** Placement of the splat cloud. Defaults to identity (see lib/scene/splat.ts). */
  transform?: SplatTransform;
  /** 0..1 multiplier on splat opacity — handy for seeing meshes through the cloud. */
  opacity?: number;
  visible?: boolean;
};

export function SplatLayer({
  transform = DEFAULT_SPLAT_TRANSFORM,
  opacity = 1,
  visible = true,
}: SplatLayerProps) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const [mesh, setMesh] = useState<SplatMesh | null>(null);

  const beginSplat = useRoomStore((s) => s.beginSplat);
  const setSplatProgress = useRoomStore((s) => s.setSplatProgress);
  const setSplatLoaded = useRoomStore((s) => s.setSplatLoaded);
  const setSplatFailed = useRoomStore((s) => s.setSplatFailed);

  // One SparkRenderer per WebGL renderer, parented to the scene root.
  useEffect(() => {
    const spark = new SparkRenderer({ renderer: gl });
    scene.add(spark);
    return () => {
      scene.remove(spark);
      spark.dispose();
    };
  }, [gl, scene]);

  // Resolve .spz-then-.ply, then decode. Never throws out of the effect: a
  // missing capture leaves a 'failed' status and an otherwise-working scene.
  useEffect(() => {
    let cancelled = false;
    let created: SplatMesh | null = null;

    void (async () => {
      const url = await beginSplat();
      if (!url || cancelled) return;
      try {
        const splatMesh = new SplatMesh({
          url,
          onProgress: (event) =>
            setSplatProgress(event.total > 0 ? event.loaded / event.total : -1),
        });
        created = splatMesh;
        await splatMesh.initialized;
        if (cancelled) {
          splatMesh.dispose();
          created = null;
          return;
        }
        splatMesh.name = 'splat';
        setMesh(splatMesh);
        setSplatLoaded(splatMesh.numSplats ?? null);
      } catch (err) {
        created?.dispose();
        created = null;
        if (!cancelled) {
          setSplatFailed(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      created?.dispose();
      setMesh(null);
    };
  }, [beginSplat, setSplatProgress, setSplatLoaded, setSplatFailed]);

  useEffect(() => {
    if (mesh) mesh.opacity = opacity;
  }, [mesh, opacity]);

  if (!mesh) return null;

  return (
    <primitive
      object={mesh}
      visible={visible}
      position={transform.position}
      rotation={transform.rotation}
      scale={transform.scale}
    />
  );
}
