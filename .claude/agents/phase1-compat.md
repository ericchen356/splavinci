---
name: phase1-compat
description: Updates the already-built phase 1 agents to remove their dependency on an object manifest
model: opus
effort: high
---

Phase 1 was built assuming an objects.json manifest of individually
meshed objects. That no longer exists. Update these two already-built
pieces to work without it:

1. scene-loader: remove the objects.json loading step entirely. Load
   only room.spz and collider.glb.

2. path-generator: this agent already understands the room's walls
   through the collider mesh — that mechanism does not change, and is
   the actual answer to "how does the camera navigate the interior
   properly": flatten collider.glb into a 2D walkable/blocked grid, run
   A* between waypoints on that grid, then smooth the result into a
   cinematic curve. That part stays exactly as built. What DOES change:
   remove the "infer technique from nearest object's size/type" rule at
   the Auto end of the controlSpectrum, since there are no object types
   left to infer from. Replace it with a wall-distance rule instead —
   measure the waypoint's distance to the nearest wall in the collider
   mesh; close to a wall, default to push-in toward it; near the room's
   center, default to a wide pan or a hold. Also remove targetObjectId
   from the Waypoint type — a waypoint now targets a raw 3D point
   (wherever the user clicked on the splat), not an object reference.

Confirm both files still compile and the existing waypoint-menu and
review-screen agents' contracts (the FrameEntry[] shape especially)
are unchanged by this edit — this should be a subtraction, not a
redesign of anything else.
