# Sample scenes

Three hand-authored inputs for the Marble pipeline, and the record of what each
one produced. Not part of the product — nothing under `samples/` is served or
imported at runtime — but they are the only place the pipeline's inputs are
written down, so a render can be reproduced without the shell history that made
it the first time.

| scene | shape | why it exists |
|---|---|---|
| [`birch-row/`](birch-row/README.md) | 43 m², one bed, 2.45 m ceiling | Every room behind a door. A camera has to use doorways. |
| [`maple-street/`](maple-street/README.md) | 84 m², two beds, 2.60 m ceiling | Hallway spine with an open-plan end. The common case. |
| [`foundry-loft/`](foundry-loft/README.md) | 120 m², one volume, 4.10 m ceiling | Almost no walls, a level change, height that matters. |

They are deliberately unlike each other. When a render comes out badly, the
first question is whether the layout or the renderer is at fault, and three
copies of the same flat cannot answer it.

Measured results for all three: [`QUALITY.md`](QUALITY.md).

## Folder contract

Every scene folder is `samples/<scene-id>/` and holds exactly this:

```
samples/<scene-id>/
  blueprint.svg        drawn by scripts/make-blueprint.mjs
  blueprint.png        rasterised from the svg by the same script
  intake.json          the experiment: layout sentence, keywords, anchor, photos
  photos/*.jpg         interior references, byte-for-byte what Marble receives
  README.md            what the scene is + source URL and licence per photo
```

Four rules hold it together.

**The blueprint is never parsed.** `lib/marble/intake.ts` refuses to invent a
reading of an image it cannot see; the layout arrives as a sentence of English
in `intake.json` and the image path is carried for provenance only. The drawing
exists for the human — or the vision model — who writes that sentence. Its
geometry lives in `scripts/make-blueprint.mjs`, so edit the script and re-run it
rather than editing the SVG.

**The photos are never edited.** They reach Marble as the exact bytes on disk.
Nothing in the pipeline decodes, resizes or re-encodes them, so whatever is
committed is what was generated from. They were downloaded at Wikimedia Commons'
1280 px thumbnail size and are not touched again.

**Every photo's licence is recorded in the scene's own README**, with the
Commons page URL, the exact file URL fetched, the author, the licence and a link
to it. There is no central credits file: one lived here, went stale, and covered
three of the eleven photos. A photo whose provenance is one directory away from
the photo is a photo that gets separated from it.

One of the eleven — `maple-street/photos/living-3.jpg` — is CC BY 2.0 and
carries a real attribution requirement. Its README spells out the notice that
has to travel with it. The other ten are CC0.

**Paths inside `intake.json` are relative to the scene folder**, not to the repo
root, so a scene folder can be copied elsewhere and still render.

### `intake.json`

```jsonc
{
  "id": "birch-row",                  // also the output folder name
  "name": "Birch Row",                // label in the render list
  "description": "…",                 // one line, subtitle in the render list
  "blueprint": {
    "path": "blueprint.png",          // provenance only; never opened
    "layoutDescription": "…"          // room count + adjacency, plain English
  },
  "photos": ["photos/living-room.jpg", …],   // max 8; order preserved
  "keywords": ["…", "…"],             // materials, era, light, mood
  "anchor": "Interior of a home, photographed at standing eye level",
  "generation": { "model": "marble-1.1", "spz": "500k", "tags": [] },
  "provenance": { }                   // free-form, lands in scene.json
}
```

`layoutDescription` is the highest-leverage field in the repo. It is room count
and rough adjacency in one or two sentences — not a schedule of areas, not
dimensions. `anchor` is the clause that keeps Marble generating an interior at
eye level instead of drifting to an exterior or a stylised render; set it to
`null` to drop it.

## Re-running a render

```bash
# free: compose the prompt and print the exact request body, send nothing
npx tsx scripts/render-scene.ts <scene-id> --dry-run

# live: uploads the photos, generates, downloads and verifies the assets
npx tsx --env-file=.env scripts/render-scene.ts <scene-id>
```

`WORLD_LABS_API_KEY` must be in `.env` for the second one. **Each live run is
billed in World Labs API credits.** Dry-run first and read the composed prompt;
that is the only free chance to notice that the layout sentence and the photos
are describing different buildings.

Output lands in `public/generated/<scene-id>/`:

```
public/generated/<scene-id>/
  room.spz       the splat, at the density named in intake.json's generation.spz
  collider.glb   the walls; the only thing that says where the camera may go
  scene.json     world id, prompt, provenance, transform, file hashes
```

`lib/renders.ts` enumerates `public/generated/*/scene.json` on the server, so a
new folder appears in the app's render list with no code change. The directory
is gitignored — captures are large and are not committed.

The collider is downloaded and parsed with the app's own `GLTFLoader` before it
is allowed to take its final filename; a run that reports success has a collider
that at minimum loads and contains triangles. Everything beyond that — coverage,
holes, whether a camera can route the space — is measured separately:

```bash
npx tsx scripts/scene-quality.ts <scene-id>     # the numbers in QUALITY.md
node scripts/spz-tools.mjs info public/generated/<scene-id>/room.spz
npx tsx scripts/path-lab.ts public/generated/<scene-id>/collider.glb
```

## Editing a blueprint

```bash
node scripts/make-blueprint.mjs             # all three
node scripts/make-blueprint.mjs birch-row   # one
```

Geometry is in metres, x right and y down, matching `lib/path`'s floor plane.
If you change a plan, change the scene's `layoutDescription` in the same edit —
they describe the same building, and only the sentence reaches Marble.
