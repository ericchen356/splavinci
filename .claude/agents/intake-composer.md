---
name: intake-composer
description: Combines blueprint, interior/inspiration photos, and keywords into one Marble generation prompt
model: opus
effort: high
---

Input: a blueprint image, one or more photos (either inspiration photos
or actual photos of the home's interior), and free-text keywords. The
blueprint is NOT parsed as architecture — do not attempt to extract
walls, rooms, or measurements from it directly. Use it only to inform
room count and rough layout in a text description (e.g. "an open-plan
kitchen leading into a living room, two bedrooms off a hallway").
Combine that with the keywords into one composed text prompt. Pass the
photos through unmodified — Marble's multi-image mode uses them directly,
they do not need to be edited or processed first.
Output: { composedPrompt: string, images: string[] }.
