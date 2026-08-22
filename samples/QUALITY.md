# Capture quality — measured, not eyeballed

Three scene folders, three Marble worlds, one question: **is this capture good
enough to fly a camera through?**

An earlier capture ("hobbiton") was rejected for being full of holes and looking
unfilled. That is a true observation and a useless bug report — it cannot be
regressed, compared, or argued with. Everything below is a number produced by

```
npx tsx scripts/scene-quality.ts <scene-id>
```

which is in the repo, runs in about a minute per scene, and prints exactly the
figures quoted here.

All numbers are **metric**. `scene.json`'s `splatTransform` is applied to both
the splat and the collider first, the way `lib/scene/loaders.ts` does at
runtime. Skipping that step measures the raw Marble frame, where every distance
is out by the capture's `metric_scale_factor` — 1.58, 1.94 and 1.91 for these
three, which is the difference between a doorway and a cupboard.

**Not assessed: appearance.** No browser was used, so nothing here says whether
the worlds look good — only whether they are structurally sound and navigable.
Colour, style fidelity, and visible artefacts still need a human at the plan
screen. World viewer links are in each `scene.json`.

---

## Verdicts

| scene | verdict | the one number that decides it |
|---|---|---|
| **maple-street** | **usable** | 90.9% floor support, largest hole 1.1 m², 84% of the walkable floor is one routable region |
| **birch-row** | **usable** | 93.4% floor support, largest hole 1.4 m², and the walkable floor breaks into only 3 pieces — the cleanest of the three |
| **foundry-loft** | **marginal** | 77.4% floor support, a single **9.4 m² hole**, and only **43%** of its walkable floor is reachable in one piece |

---

## The table

| | birch-row | maple-street | foundry-loft |
|---|---|---|---|
| world | `709b1b48…` | `316d271a…` | `7a5a4add…` |
| model / photos in | marble-1.1 / 4 | marble-1.1 / 3 | marble-1.1 / 3 |
| plan area, labelled rooms | 43 m² | 84 m² | 120 m² |
| **splat** | | | |
| `room.spz` | 7 625 197 B | 7 645 646 B | 7 724 329 B |
| points | 500 000 | 500 000 | 500 000 |
| opaque (α ≥ 0.12) | 400 507 (80.1%) | 406 645 (81.3%) | 415 050 (83.0%) |
| SPZ parse | v2, layout OK | v2, layout OK | v2, layout OK |
| SH degree | 0 | 0 | 0 |
| fractional bits | 12 | 12 | 12 |
| bytes / point | 15.3 | 15.3 | 15.4 |
| extent, all splats | 9.8 × 11.3 × 15.3 m | 15.3 × 4.7 × 12.4 m | 23.0 × 28.1 × 31.7 m |
| extent, middle 99% | 8.4 × 3.5 × 12.0 m | 10.3 × 3.4 × 11.5 m | 11.9 × 5.7 × 14.2 m |
| opaque splats / m² | 3 982 | 3 432 | 2 446 |
| **collider** | | | |
| `collider.glb` | 2 225 844 B | 5 466 008 B | 7 519 988 B |
| GLTFLoader | **loads** | **loads** | **loads** |
| triangles | 85 378 | 209 286 | 288 793 |
| meshes | 1 (`geometry_0`) | 1 (`geometry_0`) | 1 (`geometry_0`) |
| floor classified by | triangle normal | triangle normal | triangle normal |
| walk grid | 110 × 160 @ 0.082 m | 160 × 132 @ 0.092 m | 141 × 160 @ 0.092 m |
| floor cells | 7 313 → 48.6 m² | 9 370 → 79.6 m² | 10 893 → 91.5 m² |
| blocked cells | 2 086 → 13.9 m² | 1 944 → 16.5 m² | 3 601 → 30.2 m² |
| walkable | 5 472 → 36.3 m² (74.8% of floor) | 7 485 → 63.6 m² (79.9%) | 7 526 → 63.2 m² (69.1%) |
| grid occupancy | 41.6% | 44.4% | 48.3% |
| **coverage / holes** | | | |
| floor support | **93.4%** | **90.9%** | **77.4%** |
| unsupported floor | 2.4 m² | 5.8 m² | **14.3 m²** |
| largest single hole | 1.4 m² | 1.1 m² | **9.4 m²** at x −1.4, z −7.6 |
| enclosure | 91.5% | 95.1% | 98.6% |
| median sightline | 2.0 m | 3.0 m | 3.0 m |
| **routing** | | | |
| regions at r = 0.30 m | 4 | 6 | **23** |
| radius actually used | 0.10 m (relaxed) | 0.10 m (relaxed) | 0.10 m (relaxed) |
| largest routable region | 31.5 m² = **86.5%** of walkable | 53.4 m² = **84.0%** | 27.2 m² = **43.0%** |
| generated path | 702 frames, 23.4 s | 846 frames, 28.2 s | 866 frames, 28.8 s |
| frames inside solid splat | **0** | **0** | **0** |
| frames off the floor | **0** | **0** | **0** |
| warnings | 1 info, 5 shot-clipped | 1 info, 5 shot-clipped | 1 info, 3 shot-clipped |

### What each measurement is

**Floor support.** For every cell the router will stand on, is there splat mass
in a 0.6 m slab around that cell's own floor height (≥ 0.80 accumulated opacity,
the same "something was observed here" bar `scripts/spz-collider.mjs` uses)? A
walkable cell with nothing under it is a hole you fall through on camera: the
collider believes in a floor the capture never rendered.

**Largest single hole**, not total hole area. A hundred scattered single cells
is a noisy capture; one contiguous 9 m² void is a room with no floor. The sum
cannot tell them apart, so the largest connected component is reported with its
centre, which is enough to find it on the plan.

**Enclosure.** From ~420 walkable points, 16 rays at eye height (floor + 1.6 m).
What fraction meets a surface before running out of the capture? This is the
hobbiton complaint made countable — open sky where a wall should be is a low
number here, and floor support cannot see it, which is why both exist.

**Median sightline.** How far those rays get. A subdivided flat stops them in
two or three metres; an empty box does not.

**Routing.** Waypoints are placed the way the UI places them — snapped into the
reachable region and spread apart — then `generatePath` runs for real. "Frames
inside solid splat" reuses `scripts/path-vs-splat.ts`'s test: a voxel denser
than the 80th percentile of occupied voxels counts as inside geometry.

---

## Per scene

### birch-row — usable

The cleanest capture of the three. Highest floor support (93.4%), least
unsupported area (2.4 m², about half its own shower room, scattered
across a whole flat), and by far the least fragmented: 4 regions at a 0.30 m
camera radius against maple-street's 6 and the loft's 23, and 86.5% of the
walkable floor sits in one routable piece. The router produced 702 frames with
no frame inside geometry and none off the floor.

Two caveats, neither disqualifying.

*It is smaller than it was asked to be.* The plan is 43 m² and the capture's
routable region is 31.5 m². Marble does not read the blueprint and does not take
instruction on absolute size; 43 m² appeared in the keyword list and was not
obeyed. Fine here, because 31.5 m² of one-bedroom flat is still a one-bedroom
flat.

*It is the leakiest of the three.* 8.5% of eye-height rays escaped without
meeting anything — nearly twice maple-street's rate — and the full-splat extent is
11.3 m tall against a 3.5 m core, so there is a halo of stray Gaussians well
above the ceiling. Both point the same way: the shell is not quite closed.

Likely cause, from the input: `window-corner.jpg` is a Breather co-working
interior with black steel factory glazing and sheer curtains, which is the most
loft-like of the four photos and the least like a 2.45 m flat. The dark-floored
Boston kitchen also fights the herringbone parquet in the living room. Neither
is wrong enough to remove, but a fifth photo of an ordinary domestic corner
would tighten it.

### maple-street — usable

The best-shaped capture. 90.9% floor support with the smallest hole of the three
(1.1 m²), and the largest routable region in absolute terms: 53.4 m², 84% of its
walkable floor, connected as a single L. Its full-splat extent (15.3 × 4.7 ×
12.4 m) is also the tightest — 4.7 m of vertical range for a 2.6 m flat, against
birch-row's 11.3 m and the loft's 28.1 m. There is very little junk around this
one.

Its 28 disconnected regions at the relaxed radius sound alarming next to
birch-row's 3, but the largest holds 84% of the walkable floor; the other 27 are
slivers behind furniture, worth nothing to a camera.

This is the render that was already on disk when the scene folders were
finished. It has deliberately not been re-run — see
`maple-street/README.md` — and the current `intake.json` reproduces its prompt
character for character.

### foundry-loft — marginal

It fails on coverage, and it fails in exactly the way hobbiton did.

- **77.4% floor support.** Nearly a quarter of the floor the router will walk on
  has no splats under it.
- **14.3 m² unsupported**, of which **9.4 m² is one contiguous hole** centred at
  x −1.4, z −7.6, at the far end of the main room. That single void is larger
  than birch-row's shower room and entrance hall put together. A camera sent through it renders a floor that
  is not there.
- **43% of the walkable floor is routable.** 23 disconnected regions at a 0.30 m
  camera radius — the space never becomes one piece, even at the 0.10 m floor —
  and the biggest island is 27.2 m² out of a 120 m² plan.
- **Lowest splat density**, 2 446 opaque splats per m² of core against
  birch-row's 3 982, because the same 500 000-splat budget is spread over a much
  larger volume.

The paradox in the table is that its *enclosure* is the best of the three
(98.6%, only 94 escaping rays). It is not full of sky; it is full of walls that
stop rays at a median of 3.0 m. That is the diagnosis: **Marble did not build a
loft.** Asked for one undivided volume 14.4 x 9.8 m at 4.1 m, it produced a normally
proportioned, heavily cluttered room — core extent 11.9 × 5.7 × 14.2 m — plus a
large disconnected sprawl of floor beyond it, which is what pushes the
all-splats extent out to 23 × 28 × 32 m.

Three things in the input explain it.

1. **Only three photos, all of small brick rooms.** Nothing in the references
   shows the kitchen or the dining end, and nothing shows the window wall at
   full height. Marble had no evidence that the space was large, so it built a
   small one. `foundry-loft/README.md` records this gap.
2. **A fourth photo was actively harmful and had to be removed.** `brick-arch.jpg`
   was a Victorian drawing room — chandelier, marble chimneypiece, damask walls —
   filed under a prompt that says "warehouse conversion, reclaimed brick,
   cast-iron columns". It was deleted before the render, so it is not the cause
   here, but it is the reason the loft went in one reference light.
3. **The level change is the fragmenting agent.** The layout sentence asks for a
   sleeping platform five steps up behind a balustrade. Height variation is what
   the walk grid is worst at: a derived floor with relief produces terraces
   separated by cells the camera cannot straddle, which is the 23-regions
   number. `birch-row`, dead flat, gets 4.

**Not re-rendered.** The budget for this exercise was three live generations;
two were spent (birch-row, foundry-loft) and both succeeded first time, so one
remains. Spending it on a re-roll of the loft would be a gamble on the same
inputs producing a different answer, and the inputs are the diagnosed problem.
The cheaper fix is to source a fourth and fifth reference showing the kitchen
end and the full-height window wall, and to drop the sleeping platform from the
layout sentence, before spending anything.

---

## Findings that apply to all three

**1. Every Marble collider arrives as one fused mesh called `geometry_0`.**
Neither the name convention nor the shape heuristic in
`classifyColliderMeshes` finds a floor in it; all three fall through to the
per-triangle-normal split and come out as `floor:derived` / `obstacles:derived`.
That fallback works — every scene ended up with a floor — but "floor" then means
"every triangle that faced up", table tops and window sills included, which is
part of why the walkable masks are lumpy.

**2. All three needed the camera radius relaxed from 0.30 m to the 0.10 m floor,
and none became a single region even then.** This is the largest systematic
problem in the pipeline, and it is not the splat's fault: the derived obstacle
mask leaves sub-30 cm gaps throughout. The router reports the relaxation rather
than hiding it, and still returned a coherent timeline every time — but a 0.10 m
camera can slip through cracks a real camera could not.

**3. Where the router runs, it runs in clean air.** Across 2 414 generated
frames in three scenes, **zero** were inside solid splat density and **zero**
were over a cell with no floor. The path generator is not the weak link.

**4. Every shot came back clipped.** 13 of the 15 inferred shots were tightened
to 10–14% intensity to clear the walls. The scenes are cluttered at eye height,
so push-ins have almost nowhere to push. A capture with more open floor would
get livelier camera work for free.

**5. The layout sentence steers content, not architecture.** All three prompts
named specific rooms; maple-street's returned caption even recites "two bedrooms
open off a short central hallway" back. The colliders show no continuous
internal partitions on the walk plane in either flat — the reachable area is one
open region, not rooms joined by doorways. Write `layoutDescription` for tone,
scale and what belongs in the space; do not expect it to lay out a plan.

**6. `metric_scale_factor` varies per capture** — 1.58, 1.94, 1.91 — so nothing
downstream may assume the raw Marble frame is metres. Both assets take the same
transform, so anything comparing them in the raw frame is self-consistent and
wrong in absolute terms.

---

## Reproducing this

```bash
npx tsx scripts/scene-quality.ts birch-row       # everything in the table
npx tsx scripts/scene-quality.ts foundry-loft --json
node scripts/spz-tools.mjs info public/generated/birch-row/room.spz
npx tsx scripts/path-lab.ts public/generated/birch-row/collider.glb
npx tsx scripts/path-vs-splat.ts \
  public/generated/birch-row/collider.glb public/generated/birch-row/room.spz
```

`scene-quality.ts` is the one that applies `splatTransform` before measuring;
`path-lab.ts` and `path-vs-splat.ts` read the raw frame, which is fine for
checking topology and wrong for reading distances off.
