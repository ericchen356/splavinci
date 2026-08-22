# Maple Street

A two-bedroom apartment, 12.00 × 8.00 m, 2.60 m clear ceiling. An open-plan
living room with a dining area along one wall and a galley kitchen behind a
half-height partition fills the west half; a short central hallway off the east
half serves the primary bedroom, a second bedroom and a bathroom.

It is the middle case of the three: `birch-row` puts every room behind a door,
`foundry-loft` has almost no doors at all, and this one has a hallway spine with
an open-plan end — which is what most real flats look like, and what a camera
path has to handle most often.

## Files

| file | what it is |
|---|---|
| `blueprint.png`, `blueprint.svg` | The floor plan. Drawn by `node scripts/make-blueprint.mjs maple-street`; the geometry lives in that script, not in the image. |
| `intake.json` | The whole experiment: layout description, envelope, keywords, anchor, photo list. Consumed by `scripts/render-scene.ts`. |
| `photos/` | Interior references, passed to Marble byte-for-byte. |

The pipeline never opens `blueprint.png`. `lib/marble/intake.ts` takes the
layout as a sentence of English and carries the image path for provenance only.

## The capture on disk predates this folder — and now predates the prompt too

`public/generated/maple-street/` was rendered before the scene folders existed.
It used these exact keywords and these exact three photos, but it was composed
against `samples/blueprint.png`, an earlier and cruder drawing of the same flat,
which `blueprint.png` here replaces — and, more importantly, against a
one-sentence layout description that `intake.json` no longer carries.

That sentence has been replaced by an exhaustive one, on the contract
`birch-row`, `foundry-loft` and `kiln-terrace` are already rendered against:
every room named, sized, placed in compass terms, connected through a stated
kind of opening and furnished, plus an `envelope` field so the drawing and the
prompt cannot disagree about 12.00 × 8.00 m and a 2.60 m ceiling. The reason is
a failure worth remembering: an undescribed room is an unbuilt room — an earlier
scene's shower room went unmentioned in its prompt and Marble simply did not
build it, leaving a dead entrance you could not walk into.

So `intake.json` here no longer reproduces the capture's prompt. The capture
still measures well (see `samples/QUALITY.md`), but it is the last sample on the
old contract; re-render it with the command below to bring it into line, and
expect a different world, because Marble is not seeded here.

## Photo credits

All three are from Wikimedia Commons, downloaded at the 1280 px thumbnail size
and otherwise unmodified.

### `photos/living-1.jpg`
- Title: *Living room in apartment of Condomínio do Edifício Zaher, Le Blond, Rio de Janeiro, Brazil*
- Source: https://commons.wikimedia.org/wiki/File:Living_room_in_apartment_of_Condom%C3%ADnio_do_Edif%C3%ADcio_Zaher,_Le_Blond,_Rio_de_Janeiro,_Brazil.jpg
- Author: Wilfredor (own work)
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ — no attribution required; credited anyway.

### `photos/living-2.jpg`
- Title: *The living room that needs houseplants*
- Source: https://commons.wikimedia.org/wiki/File:The_living_room_that_needs_houseplants.jpg
- Author: Lo
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/ — no attribution required; credited anyway.

### `photos/living-3.jpg` — CC BY 2.0, attribution required

This is the one photo in `samples/` whose licence imposes a condition. CC BY 2.0
requires the author, the licence, a link to the licence, and an indication of
whether the work was changed. The required notice, in full:

> *"Modern living room with stylish furniture and a view of the outdoors in a
> cozy apartment setting"* by **Shixart1985**, via Wikimedia Commons, licensed
> under **CC BY 2.0** (https://creativecommons.org/licenses/by/2.0/).
> **Modified**: downscaled from 7360 × 4912 to 1280 × 854.

- Source: https://commons.wikimedia.org/wiki/File:Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg
- File used: https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg/1280px-Modern_living_room_with_stylish_furniture_and_a_view_of_the_outdoors_in_a_cozy_apartment_setting.jpg

Anywhere this photo is shown — a slide, a demo, a screenshot of the intake
screen — that notice has to travel with it. Recording the string "CC BY 2.0" in
a table is not attribution; the block quoted above is.

Licences were re-checked against the Commons `imageinfo` API rather than copied
forward from an earlier note. If you swap a photo, re-check the new one the same
way and edit this file in the same commit.

## Re-rendering

```
npx tsx --env-file=.env scripts/render-scene.ts maple-street --dry-run   # free
npx tsx --env-file=.env scripts/render-scene.ts maple-street             # costs credits
```

This overwrites `public/generated/maple-street/`. Read the section above first.
