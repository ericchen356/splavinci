# Birch Row

A compact one-bedroom flat, 8.00 × 6.40 m, 43 m² internal, 2.45 m clear ceiling.
Five labelled spaces — kitchen, living room, entrance hall, shower room, bedroom
— and the thing that makes it a distinct test case: **every room opens off one
small hall**. Nothing is open-plan except the kitchen's serving gap, so a camera
crossing this flat has to go through doorways rather than around furniture.

Contrast with the other two scenes: `maple-street` is a mid-size flat with a
hallway spine, `foundry-loft` is one undivided volume. The three exist so a
difference in a render can be attributed to the layout rather than to the
renderer having drawn the same flat three times.

## Files

| file | what it is |
|---|---|
| `blueprint.png`, `blueprint.svg` | The floor plan. Drawn by `node scripts/make-blueprint.mjs birch-row`; the geometry lives in that script, not in the image. |
| `intake.json` | The whole experiment: layout sentence, keywords, anchor, photo list. Consumed by `scripts/render-scene.ts`. |
| `photos/` | Interior references, passed to Marble byte-for-byte. |

The pipeline never opens `blueprint.png`. `lib/marble/intake.ts` takes the
layout as a sentence of English and carries the image path for provenance only.
The drawing exists for the human who writes that sentence.

## Photo credits

All four are from Wikimedia Commons, downloaded at the 1280 px thumbnail size
and otherwise unmodified. All four are **CC0 1.0** (public domain dedication),
which imposes no attribution requirement; the authors are credited anyway.

### `photos/living-room.jpg`
- Title: *Living room (Unsplash)*
- Source: https://commons.wikimedia.org/wiki/File:Living_room_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Living_room_%28Unsplash%29.jpg/1280px-Living_room_%28Unsplash%29.jpg
- Author: Jarosław Ceborski (Unsplash `jarson`), originally https://unsplash.com/photos/jn7uVeCdf6U
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### `photos/kitchen.jpg`
- Title: *Kitchen (Unsplash)*
- Source: https://commons.wikimedia.org/wiki/File:Kitchen_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Kitchen_%28Unsplash%29.jpg/1280px-Kitchen_%28Unsplash%29.jpg
- Author: Naomi Hébert (Unsplash `naomish`), originally https://unsplash.com/photos/MP0bgaS_d1c
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### `photos/hall.jpg`
- Title: *Home Sweet Home Pt. 4 (Unsplash)*
- Source: https://commons.wikimedia.org/wiki/File:Home_Sweet_Home_Pt._4_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/Home_Sweet_Home_Pt._4_%28Unsplash%29.jpg/1280px-Home_Sweet_Home_Pt._4_%28Unsplash%29.jpg
- Author: Kari Shea (Unsplash `karishea`), originally https://unsplash.com/photos/MfJ9g64-WxQ
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### `photos/window-corner.jpg`
- Title: *Breather Montreal interior (Unsplash)*
- Source: https://commons.wikimedia.org/wiki/File:Breather_Montreal_interior_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/Breather_Montreal_interior_%28Unsplash%29.jpg/1280px-Breather_Montreal_interior_%28Unsplash%29.jpg
- Author: Breather (Unsplash `breather`), originally https://unsplash.com/photos/Y_wz_QfQI-g
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

Licences were re-checked against the Commons `imageinfo` API rather than copied
forward from an earlier note. If you swap a photo, re-check the new one the same
way and edit this file in the same commit — a photo whose licence lives only in
somebody's memory is a photo that cannot ship.

## Re-rendering

```
npx tsx --env-file=.env scripts/render-scene.ts birch-row --dry-run   # free
npx tsx --env-file=.env scripts/render-scene.ts birch-row             # costs credits
```

Output lands in `public/generated/birch-row/`. See `samples/README.md` for the
folder contract and `samples/QUALITY.md` for how the current capture measured.
