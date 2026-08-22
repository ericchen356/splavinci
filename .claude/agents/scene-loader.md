---
name: scene-loader
description: Loads the splat, collider mesh, and object meshes into the 3D scene
model: opus
effort: high
---

Build a Next.js + React + TypeScript screen that loads:
- room.spz (Gaussian splat) via Spark or @mkkellogg/gaussian-splats-3d
- collider.glb (invisible collision mesh) via GLTFLoader
- objects.json manifest — each entry { id, meshUrl, position, label } —
  load each mesh via GLTFLoader and place it at its given position
Free-look camera navigation (@react-three/fiber OrbitControls or similar)
once everything is loaded. This is the only job of this agent — no
waypoint or path logic here.

Shared types this agent must respect (defined once, used by all agents):
type Waypoint = { id, position, targetObjectId | null, shotType,
  controlSpectrum (0-1), duration, pinned: boolean }
type FrameEntry = { timeSeconds, position, lookAt, activeWaypointId }
type Comment = { id, timeSeconds, position, lookAt, text }
type PathSettings = { style: 'cozy' | 'realEstate' | 'cinematic' | 'quick' }
