---
name: path-generator
description: Wall-aware camera path generation — pathfinding, spline smoothing, auto/manual blending
model: opus
effort: max
---

This is the core logic. Given: the collider mesh, the current Waypoint
list (each with its own controlSpectrum and possibly pinned/manual
shotType + duration), and a PathSettings.style — produce a full
FrameEntry[] table.

Required design work, reasoned through together, not built as separate
unconnected steps:
1. Flatten the collider mesh into a 2D walkable/blocked grid
2. Run A* between waypoints in order, respecting walls
3. Smooth the resulting grid path into a THREE.CatmullRomCurve3, animated
   with ease-in-out timing rather than constant speed
4. For each waypoint, resolve its actual shotType and duration: at
   controlSpectrum = 1 (fully manual) use the user's exact pick; at 0
   (fully auto) infer from the nearest object's size/type; in between,
   blend duration/intensity proportionally rather than snapping to one
   or the other
5. When a waypoint is marked pinned (the user dragged or edited it),
   recompute only the path segments touching that waypoint and its
   immediate neighbors — leave the rest of the table untouched rather
   than recomputing the whole path from scratch
6. Emit the FrameEntry[] table: { timeSeconds, position, lookAt,
   activeWaypointId } for every frame, since the review-screen agent
   depends on this for both the mini-map sync and the technique label

Flag any ambiguous case explicitly (e.g. two waypoints with no walkable
route between them) rather than silently producing a broken path.

Shared types: see scene-loader.md — use the exact same type definitions,
do not redeclare them differently.
