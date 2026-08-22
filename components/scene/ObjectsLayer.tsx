'use client';

/**
 * The individually meshed objects from objects.json.
 *
 * Each mesh is authored centred on its own origin and the manifest position is
 * its world-space centre, so placement is a straight assignment — no offset
 * correction. Clones again, for the same one-parent reason as ColliderLayer.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { LoadedObject } from '@/lib/scene/assetTypes';

export type ObjectsLayerProps = {
  objects: readonly LoadedObject[];
  visible?: boolean;
  /** Enable pointer events on the object meshes. */
  interactive?: boolean;
  /** Draw an accent box around these object ids. */
  highlightedIds?: readonly string[];
  highlightColor?: string;
  onObjectClick?: (object: LoadedObject, event: ThreeEvent<MouseEvent>) => void;
  /** Fires with the object on enter and with null on leave. */
  onObjectHover?: (object: LoadedObject | null, event: ThreeEvent<PointerEvent>) => void;
};

const DEFAULT_HIGHLIGHT = '#ffb454';

export function ObjectsLayer({
  objects,
  visible = true,
  interactive = false,
  highlightedIds,
  highlightColor = DEFAULT_HIGHLIGHT,
  onObjectClick,
  onObjectHover,
}: ObjectsLayerProps) {
  const clones = useMemo(
    () =>
      objects.map((item) => {
        const clone = item.root.clone(true);
        clone.name = `object:${item.spec.id}`;
        return { item, clone };
      }),
    [objects],
  );

  const highlighted = useMemo(() => new Set(highlightedIds ?? []), [highlightedIds]);

  const highlightMaterial = useMemo(
    () => new THREE.LineBasicMaterial({ color: highlightColor, transparent: true, opacity: 0.9 }),
    [highlightColor],
  );
  useEffect(() => () => highlightMaterial.dispose(), [highlightMaterial]);

  // One edges geometry per object, reused across renders.
  const outlines = useMemo(
    () =>
      objects.map((item) => {
        const geometry = new THREE.EdgesGeometry(
          new THREE.BoxGeometry(item.size[0], item.size[1], item.size[2]),
        );
        return { id: item.spec.id, geometry, center: item.center };
      }),
    [objects],
  );
  useEffect(
    () => () => {
      for (const o of outlines) o.geometry.dispose();
    },
    [outlines],
  );

  return (
    <group name="objects" visible={visible}>
      {clones.map(({ item, clone }) => (
        <primitive
          key={item.spec.id}
          object={clone}
          onClick={
            interactive && onObjectClick
              ? (event: ThreeEvent<MouseEvent>) => {
                  event.stopPropagation();
                  onObjectClick(item, event);
                }
              : undefined
          }
          onPointerOver={
            interactive && onObjectHover
              ? (event: ThreeEvent<PointerEvent>) => {
                  event.stopPropagation();
                  onObjectHover(item, event);
                }
              : undefined
          }
          onPointerOut={
            interactive && onObjectHover
              ? (event: ThreeEvent<PointerEvent>) => onObjectHover(null, event)
              : undefined
          }
        />
      ))}

      {outlines
        .filter((o) => highlighted.has(o.id))
        .map((o) => (
          <lineSegments
            key={`outline:${o.id}`}
            geometry={o.geometry}
            material={highlightMaterial}
            position={o.center}
          />
        ))}
    </group>
  );
}
