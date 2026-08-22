# Foundry Loft

A warehouse conversion, 14.40 × 9.80 m, 4.10 m to the underside of the roof.
One undivided volume holds the kitchen, dining table, living area and studio
corner, with cast-iron columns on a 3.4 m grid; a sleeping platform sits five
steps up behind a balustrade at one end, and the only real rooms in the place —
a shower room and a utility room — are a small block in the opposite corner.

This is the hard case of the three. There are almost no walls to route a camera
around, the interesting geometry is vertical (a level change and 4 m of ceiling),
and the dashed zones on the plan are furniture arrangements rather than
partitions. `birch-row` is the opposite extreme — every room behind a door — and
`maple-street` sits between them.

## Files

| file | what it is |
|---|---|
| `blueprint.png`, `blueprint.svg` | The floor plan. Drawn by `node scripts/make-blueprint.mjs foundry-loft`; the geometry lives in that script, not in the image. |
| `intake.json` | The whole experiment: layout sentence, keywords, anchor, photo list. Consumed by `scripts/render-scene.ts`. |
| `photos/` | Interior references, passed to Marble byte-for-byte. |

The pipeline never opens `blueprint.png`. `lib/marble/intake.ts` takes the
layout as a sentence of English and carries the image path for provenance only.

## Photo credits

All three are from Wikimedia Commons, downloaded at the 1280 px thumbnail size
and otherwise unmodified. All three are **CC0 1.0** (public domain dedication),
which imposes no attribution requirement; the authors are credited anyway.

### `photos/brick-living.jpg`
- Title: *Budapest Apartment (Unsplash)*
- Source: https://commons.wikimedia.org/wiki/File:Budapest_Apartment_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Budapest_Apartment_%28Unsplash%29.jpg/1280px-Budapest_Apartment_%28Unsplash%29.jpg
- Author: Justin Schüler (Unsplash `blacktakeover`), originally https://unsplash.com/photos/dAAk8Aqd_-I
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### `photos/loft-living.jpg`
- Title: *Furnished living room. (Unsplash)*
- Source: https://commons.wikimedia.org/wiki/File:Furnished_living_room._(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/b/b3/Furnished_living_room._%28Unsplash%29.jpg/1280px-Furnished_living_room._%28Unsplash%29.jpg
- Author: Stephen Di Donato (Unsplash `sdidonato`), originally https://unsplash.com/photos/OrhRN2yhlos
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

### `photos/loft-bedroom.jpg`
- Title: *NY loft bedroom (Unsplash)*
- Source: https://commons.wikimedia.org/wiki/File:NY_loft_bedroom_(Unsplash).jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/NY_loft_bedroom_%28Unsplash%29.jpg/1280px-NY_loft_bedroom_%28Unsplash%29.jpg
- Author: Gabriel Beaudry (Unsplash `gbeaudry`), originally https://unsplash.com/photos/WuQME0I_oZA
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/

Licences were re-checked against the Commons `imageinfo` API rather than copied
forward from an earlier note. If you swap a photo, re-check the new one the same
way and edit this file in the same commit.

### Two photos that were fixed or removed before the first render

`loft-living.jpg` arrived truncated — 241 664 bytes, no `FFD9` end-of-image
marker, the lower two-thirds decoding as grey — because it was fetched in a
parallel `curl` batch that lost the race. It has been re-fetched serially and
verified whole (665 020 bytes). Marble is billed per generation, so a corrupt
input is not something to discover from the output.

`brick-arch.jpg` (*Flaunter - Interior*, CC0, Sydney) has been **deleted**. Its
name promised a brick arch; the photograph is a Victorian drawing room with a
crystal chandelier, a marble chimneypiece, damask walls and large floral
arrangements. Against a prompt that says "warehouse conversion, reclaimed brick,
cast-iron columns" it is a direct contradiction, and Marble reconciles
contradictions by inventing something that satisfies neither. Three coherent
references beat four that argue.

The scene is still one reference short of ideal: nothing here shows the kitchen
or dining end, and nothing shows the full height of the window wall. If someone
adds a fourth, that is the gap to fill.

## Re-rendering

```
npx tsx --env-file=.env scripts/render-scene.ts foundry-loft --dry-run   # free
npx tsx --env-file=.env scripts/render-scene.ts foundry-loft             # costs credits
```

Output lands in `public/generated/foundry-loft/`. See `samples/README.md` for
the folder contract and `samples/QUALITY.md` for how the current capture
measured.
