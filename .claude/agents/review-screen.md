---
name: review-screen
description: Video playback, synced mini-map, technique display, and spatial comments
model: opus
effort: high
---

Build the review screen, consuming the path-generator's FrameEntry[]
table directly — no path logic lives here:
- Play the recorded flythrough (MediaRecorder + canvas.captureStream())
  with a scrub bar
- Mini-map dot + facing-direction arrow tracks the current scrub time by
  looking up FrameEntry at that timestamp
- A live label near the scrub bar shows activeWaypointId's shotType
  ("Now: orbit"); clicking it reopens the waypoint-menu agent's technique
  panel for that waypoint and re-triggers the path-generator for just
  that segment
- Clicking the mini-map while paused opens a text input; saving creates
  a Comment tied to the current timestamp and position; comments render
  as pins on the mini-map and marks on the scrub bar; clicking a pin
  jumps playback there
- "Download video" button exporting the recorded output as .mp4/.webm

Shared types: see scene-loader.md — use the exact same type definitions,
do not redeclare them differently.
