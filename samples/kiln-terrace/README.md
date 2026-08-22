# Kiln Terrace

Victorian end-of-terrace ground floor: 5.4 m wide, 14 m deep, 2.9 m ceilings,
61 m² internal over six labelled spaces. One hallway runs the full depth down
the west side and every room opens off its east side.

It exists to be **topologically unlike** the other three samples. maple-street
is a wide apartment around a central hall, birch-row is a compact flat where
everything touches one small hall, foundry-loft is a single open volume. This
one is long, narrow and corridor-served, which is the layout most likely to
expose a generator that quietly builds a square room and labels it.

| file | what it is |
|---|---|
| `blueprint.png`, `blueprint.svg` | The plan. Drawn by `node scripts/make-blueprint.mjs kiln-terrace`; the geometry lives in that script, not in the image. |
| `intake.json` | Layout prose, keywords, envelope, photo list. Consumed by `scripts/render-scene.ts`. |
| `photos/` | Style references, passed to Marble byte-for-byte. |

Render it with:

```
npx tsx --env-file=.env scripts/render-scene.ts kiln-terrace --dry-run   # prompt only
npx tsx --env-file=.env scripts/render-scene.ts kiln-terrace             # spends credits
```

## Photographs

All Creative Commons Zero, from Wikimedia Commons' mirror of Unsplash. Only the
**first** is sent to Marble — the intake's default `photoRole` is
`inspiration`, which passes one anchor image and carries the rest as words. The
others are kept because they informed the keyword list and because dropping
them would lose the provenance for phrasing that came out of them.

`bright-room.jpg` is the anchor deliberately: it shows floorboards, skirting, a
window and warm raking light, which is what the anchor is *for* under that
setting. It is a guide to material and light, not to geometry — the prompt says
so explicitly, and the architecture comes from the layout prose.

### `bright-room.jpg`
- Source: https://commons.wikimedia.org/wiki/File:Round_table_in_a_bright_room_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/Round_table_in_a_bright_room_%28Unsplash%29.jpg/1280px-Round_table_in_a_bright_room_%28Unsplash%29.jpg
- Author: Nirzar Pangarkar (Unsplash `nirzar`)
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### `dining.jpg`
- Source: https://commons.wikimedia.org/wiki/File:Warm_light_in_the_dining_room_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/2/2a/Warm_light_in_the_dining_room_%28Unsplash%29.jpg/1280px-Warm_light_in_the_dining_room_%28Unsplash%29.jpg
- Author: eberhard grossgasteiger (Unsplash `eberhardgross`)
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### `parlour.jpg`
- Source: https://commons.wikimedia.org/wiki/File:Green_living_room_corner_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/Green_living_room_corner_%28Unsplash%29.jpg/1280px-Green_living_room_corner_%28Unsplash%29.jpg
- Author: Brina Blum (Unsplash `brina_blum`)
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### One image was rejected

`Furnished living room. (Unsplash).jpg` by Stephen Di Donato was downloaded and
then deleted. Commons lists it as CC0, but the file carries an embedded EXIF
`Copyright: Copyright 2016. All rights reserved.` from the photographer's own
processing. The Commons licence is very probably the operative one and the EXIF
very probably stale — but "probably" is not the standard for something we
redistribute, and there were other candidates.
