# splavinci

Author a camera flythrough through a Gaussian-splat capture of a room.

You pick a capture, drop waypoints in the 3D view or on the mini-map, choose a
shot for each one, and the app plans a wall-aware camera path between them —
then plays it back so you can scrub, comment and export.

Captures come from the [World Labs Marble](https://www.worldlabs.ai/) API: you
give it photographs and a description of a layout, it returns a splat and a
collision mesh.

---

## Running it locally

```bash
npm install
npm run fixtures    # builds public/sample-room/ — a stand-in apartment
npm run dev         # http://localhost:3000
```

### Requirements

| | |
|---|---|
| Node | 20 or newer (developed on 24.19) |
| OS | any, to run the app |
| macOS | only for making a capture *from a video* — the frame extractor uses AVFoundation, so nothing needs installing, but it is macOS-only |

---

## Making new captures

```bash
cp .env.example .env        # then fill in WORLD_LABS_API_KEY
```

Get a key at <https://platform.worldlabs.ai/api-keys>. Note that API credits are
billed separately from Marble app credits.

Two ways in:

**From the app** — the home page takes photos and/or a video, an optional floor
plan and a short description, and runs the generation as a background job with
live progress.

**From the command line**, driven by a folder under `samples/`:

```bash
# See the exact prompt and request without sending anything — always do this first
npx tsx --env-file=.env scripts/render-scene.ts birch-row --dry-run

# Actually generate. Minutes, and billable.
npx tsx --env-file=.env scripts/render-scene.ts birch-row
```

Output lands in `public/generated/<scene-id>/` as `room.spz`, `collider.glb` and
`scene.json`, and the home page picks it up on the next load with no code
change.


## Layout

```
app/            Next.js App Router — / (library), /plan, /review, /api
components/     plan/ (map, overlay, inspector), review/ (player), scene/ (loaders)
lib/
  marble/       the World Labs adapter — the only place that knows the wire format
  path/         grid, A*, splines, shot sampling — the camera path generator
  scene/        splat and collider loading
  plan/ review/ zustand stores
samples/        one folder per sample scene: blueprint, photos, intake.json
scripts/        capture generation, blueprint drawing, quality measurement
```

## Scripts worth knowing

| | |
|---|---|
| `scripts/render-scene.ts` | generate a capture from a `samples/` folder (`--dry-run` first) |
| `scripts/scene-quality.ts` | measure a capture — coverage, holes, whether a camera can route it |
| `scripts/make-blueprint.mjs` | draw the sample floor plans; the geometry lives here, not in the PNGs |
| `scripts/world-densities.ts` | list a finished world's splat densities and their sizes |
| `scripts/video-frames.swift` | pull evenly spaced stills out of a video (macOS) |

`npm run typecheck` and `npm run build` are the gates. Both should be clean.

---
