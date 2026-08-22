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

**You do not need an API key to run the app.** The repo ships a synthetic
apartment, so everything except making new captures works out of the box.

```bash
npm install
npm run fixtures    # builds public/sample-room/ — a stand-in apartment
npm run dev         # http://localhost:3000
```

Then open <http://localhost:3000>, click **Sample room**, and you are on the
plan screen.

### Requirements

| | |
|---|---|
| Node | 20 or newer (developed on 24.19) |
| OS | any, to run the app |
| macOS | only for making a capture *from a video* — the frame extractor uses AVFoundation, so nothing needs installing, but it is macOS-only |

### One thing that will confuse you

If the 3D viewport is blank and the badge sits at exactly **"Loading room…
50%"**, the browser tab is backgrounded. Chrome throttles `requestAnimationFrame`
to zero in hidden tabs, so react-three-fiber's canvas never gets a real size and
the scene never mounts. It is not a bug and the splat is not broken — bring the
window to the front and reload. The 2D mini-map keeps working either way.

---

## Making new captures

This part costs money: every generation spends World Labs API credits.

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

### Getting a denser splat for free

Marble keeps several densities of every world it has already made, so density is
a *download* choice, not a generation choice. Re-fetching a world you already
paid for costs nothing:

```bash
npx tsx --env-file=.env scripts/world-densities.ts <world-id>          # what exists, and its size
npx tsx --env-file=.env scripts/render-scene.ts <scene> --world <id>   # re-download, no generation
```

`full_res` is around 1.9M points and 29 MB for a room, against 500k and 7.6 MB —
about four times the splats per square metre, which is what determines how well
a capture holds up as the camera crosses it. World IDs are in each capture's
`scene.json`.

---

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

## Known limitations

**Marble does not honour aspect ratio.** It respects ceiling height, materials,
room count and adjacency, and reliably produces a coherent enclosed interior —
and then builds the plan roughly square whatever the prompt says. A sample
asking for 5.4 × 14.0 m (1:2.6) came back 9.2 × 8.9 m (1:0.97), with the
dimensions stated twice in the prompt. More prompt detail does not fix it.

**Describe every room, or it will not exist.** A scene whose shower room was
never mentioned in the prompt came back with a dead doorway you could not walk
through. The sample scenes' `layoutDescription` fields are exhaustive on
purpose.

**Video is not a Marble input.** A video uploads fine as a media asset and is
accepted as an `image_prompt`, then fails the generation with a server 500.
The working route is extracting frames and sending them as multi-image with
`reconstruct_images`, which is what `render-scene.ts` does — and it is the one
path where geometry comes from evidence rather than from prose.
