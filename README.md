# splavinci

Author a camera flythrough through a Gaussian-splat capture of a room.

You pick a capture, fly the camera to a frame you like and press **F** to
record it as a waypoint, choose a shot for each one, and the app plans a
wall-aware camera path that flies between them — then plays it back so you can
scrub, comment and export.

A waypoint is the whole frame you captured: where the camera was, which way it
was pointing, how far up, and how much it had in shot. So the path is a flight
through the space rather than a route across the floor, and each waypoint is
drawn where it stands as a camera you can see.

Captures come from the [World Labs Marble](https://www.worldlabs.ai/) API: you
give it photographs and a description of a layout, it returns a splat and a
collision mesh. If you already have a splat and a mesh, you can upload them
instead — see [Uploading a capture you already have](#uploading-a-capture-you-already-have).

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
plan screen. Fly with `W A S D`, `Q`/`E` for down and up, drag to look, and
press `F` to capture the frame you are looking at.

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

## Uploading a capture you already have

Generation is not the only way in. If you have a splat and the collision mesh
that goes with it — from Marble, from a 3DGS trainer, from Blender — **Upload
capture** on the home page adds it to the library directly. It spends no
credits and takes as long as the transfer does.

```
splat        .spz or .ply, up to 640 MB
collider     .glb only (a .gltf points at sibling .bin files that cannot come with it)
still        optional, for the library row
```

Each file is streamed straight to disk and read as it lands, so a 300 MB splat
never sits in the server's heap and the progress bar is the real one.

### The part that is not obvious

Two files arrive with no statement anywhere of how they relate, and getting
that wrong does not fail — the walk grid still rasterises, the path still
plans, the flythrough still plays, and the camera flies through a room that is
upside down or half the size it should be. So both files are measured before
anything is written, and you confirm the result:

- The splat is sampled at an even stride (250k points, whatever the file size)
  for a 1st-to-99th-percentile bounding box — its size without the floaters.
- The collider is parsed with the same GLTFLoader the app uses, for its bounds,
  its triangle count and where its walk surface is.
- The splat is then **scaled so the two agree on the room's floor diagonal** and
  dropped so its floor sits on the collider's. The screen shows both sizes, the
  scale, the lift, and how far apart the two footprints still are.

Which way up the file was authored is the one thing no bounding box can answer:
flipping a room about X leaves every extent identical. What does distinguish
them is that interiors are bottom-heavy — furniture, clutter and floor detail
below the midline, mostly bare ceiling above — so the opacity-weighted mass
either side of the midline is measured and reported as a ratio. On the fixture
room it reads 2.6:1 the right way up and 0.39:1 upside down. When it comes out
near 1:1 the screen says so rather than guessing quietly.

It is a default for a control you can change, and the numbers move as you
change it. To see all of this from the command line before uploading anything:

```bash
npx tsx scripts/upload-scan.ts path/to/room.spz path/to/collider.glb
```

### How well it does

Both captures in this repo whose true transform is known independently come
back right:

| capture | truth | measured |
|---|---|---|
| `sample-room` (authored Y-up, identity) | scale 1, no lift | Y-up, scale 0.9993, lift 3 mm, footprints 0.0% apart |
| `hobbiton` (Y-down, collider derived from the splat) | scale 1, lift 0.893 m | Y-down, scale 1.088, lift 1.04 m, footprints 1.7% apart |

The hobbiton scale runs about 8% high because its collider is derived at a 4 m
cell size and is padded outward by roughly half a cell on every side — the fit
is matching the room it was actually given.

An uploaded capture lands in `public/generated/<id>/` like a generated one, with
a `scene.json` that records the transform **and the measurements it came from**,
so a capture whose alignment is questioned later has somewhere to answer from.

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

## Scripts worth knowing

| | |
|---|---|
| `scripts/render-scene.ts` | generate a capture from a `samples/` folder (`--dry-run` first) |
| `scripts/upload-scan.ts` | measure a splat/collider pair and print the alignment, without uploading |
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
