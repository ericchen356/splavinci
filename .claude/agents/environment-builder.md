---
name: environment-builder
description: Sends the composed prompt and photos to Marble, retrieves the splat and collider mesh
model: opus
effort: high
---

Input: composedPrompt and images from intake-composer. Call the World
Labs Marble API in multi-image mode if more than one photo is provided,
otherwise single-image mode. Poll until done.
Output: room.spz and collider.glb, saved to the project's asset
directory. The collider.glb is not cosmetic — it is the ONLY source of
truth for where the walls are, and phase 1's path-generator depends on
it entirely to keep the camera from cutting through a wall. Confirm it
downloads successfully and is non-empty before marking this stage done.
