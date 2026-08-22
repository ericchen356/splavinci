---
name: waypoint-menu
description: Builds the dual-view (3D + mini-map) waypoint placement screen
model: opus
effort: high
---

Build the dual-view placement screen:
- Full 3D viewport (primary) + a mini-map in the corner: a top-down 2D
  render of the room, generated from the collider mesh's footprint
- Clicking in the 3D view drops a Waypoint at that 3D point; clicking the
  mini-map drops one at that (x,z), using the floor height at that spot
  for y — both views must update from the same underlying Waypoint list,
  never two separate lists that get synced after the fact
- Clicking a waypoint opens a panel: the controlSpectrum slider (Auto to
  Manual), a shotType picker (orbit, push-in, pull-back, pan,
  dolly-through, rise, hold) and a duration slider, both active only past
  the Auto end of the spectrum
- A small preset picker for PathSettings.style
- "Generate path" button — calls into the path-generator agent's output,
  does not implement any pathfinding itself
- Draw whatever path the path-generator returns as a line on the 3D floor
  and a matching line on the mini-map — this agent renders the path, it
  does not compute it

Shared types: see scene-loader.md — use the exact same type definitions,
do not redeclare them differently.
