# splavinci

Author a camera flythrough through a Gaussian-splat capture of a room.

You pick a capture, drop waypoints in the 3D view or on the mini-map, choose a
shot for each one, and the app plans a wall-aware camera path between them —
then plays it back so you can scrub, comment and export.

Captures come from the [World Labs Marble](https://www.worldlabs.ai/) API: you
give it photographs and a description of a layout, it returns a splat and a
collision mesh. If you already have those two files, you can upload them
instead.

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

---

## Uploading a capture you already have

**Upload capture** on the home page takes a splat (`.spz` or `.ply`, up to
640 MB) and its collision mesh (`.glb`), and adds it to the library directly.
No generation, no credits. Each file streams to disk under its own request, so
a 300 MB splat never sits in the server's heap.

The two files arrive with no statement of how they relate, and getting that
wrong does not fail — the grid still rasterises, the path still plans, and the
camera flies through a room that is upside down or half the size it should be.
So both are measured first and you confirm the result: the splat is
stride-sampled for a percentile bounding box, the collider is parsed for its
bounds and walk surface, and the splat is scaled onto the room's floor diagonal
and dropped onto its floor.

Which way up the splat was authored is the one thing a bounding box cannot
answer — flipping a room about X leaves every extent identical. Interiors are
bottom-heavy, so the opacity either side of the midline is measured instead and
shown as a ratio: 2.6:1 the right way up on the fixture room, 0.39:1 upside
down. When it comes out near 1:1 the screen says so rather than guessing.

The two captures here whose true transform is known independently come back
right — `sample-room` at scale 0.9993 with a 3 mm lift against an identity
truth, `hobbiton` at 1.088 and 1.04 m against 1.0 and 0.893 m (its collider is
derived at a 4 m cell size, so it is genuinely padded outward).

To see all of it from the command line before uploading anything:

```bash
npx tsx scripts/upload-scan.ts path/to/room.spz path/to/collider.glb
```

---

## Layout

```
app/            Next.js App Router — / (library), /plan, /review, /api
components/     home/ (create + upload forms), plan/ (map, overlay, inspector),
                review/ (player), scene/ (loaders)
lib/
  marble/       the World Labs adapter — the only place that knows the wire format
  path/         grid, A*, splines, shot sampling — the camera path generator
  scene/        splat and collider loading
  upload/       measuring an uploaded splat and collider, and fitting one to the other
  plan/ review/ zustand stores
samples/        one folder per sample scene: blueprint, photos, intake.json
scripts/        capture generation, blueprint drawing, quality measurement
```
