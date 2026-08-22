/**
 * The design tokens, for the two renderers that cannot read CSS.
 *
 * Canvas 2D takes colour as a string on `fillStyle`, and three.js takes it
 * through `THREE.Color` — neither resolves a custom property, so the mini-map
 * and every scene material used to carry their own hardcoded hexes. Restyling
 * the panels and leaving those behind is what makes an app look half-finished:
 * the chrome moves and the drawing on it does not.
 *
 * app/globals.css stays the single source of truth. This reads the token block
 * off the document once and caches it, so the CSS and the canvas cannot drift.
 * FALLBACK exists only for the render that happens before a document does
 * (Next renders these modules on the server) and mirrors the same block; if the
 * two disagree the CSS wins the moment the browser has painted.
 *
 * Tokens read here must be plain hex. THREE.Color parses hex and rgb() and
 * silently mangles rgba(), so the map group in globals.css is kept opaque and
 * transparency is applied at the draw site instead.
 */

export type ThemeTokens = {
  /* the map, drawn as a floor plan */
  mapGround: string;
  mapFloor: string;
  mapFloorCut: string;
  mapWall: string;
  mapWallLine: string;
  mapOpenLine: string;
  mapRoute: string;
  mapAim: string;
  mapCamera: string;
  mapKeyline: string;
  /* markers, in the map and in the scene graph */
  marker: string;
  markerSelected: string;
  markerInk: string;
  markerInkInverse: string;
  markerFill: string;
  /* scene lighting */
  sceneSky: string;
  sceneBounce: string;
  /* chrome, for canvas-drawn labels */
  ink: string;
  muted: string;
};

/** Custom-property name for each field. Kept next to the type so a token
 *  renamed in one place fails to compile rather than silently reading ''. */
const VARS: Record<keyof ThemeTokens, string> = {
  mapGround: '--map-ground',
  mapFloor: '--map-floor',
  mapFloorCut: '--map-floor-cut',
  mapWall: '--map-wall',
  mapWallLine: '--map-wall-line',
  mapOpenLine: '--map-open-line',
  mapRoute: '--map-route',
  mapAim: '--map-aim',
  mapCamera: '--map-camera',
  mapKeyline: '--map-keyline',
  marker: '--marker',
  markerSelected: '--marker-selected',
  markerInk: '--marker-ink',
  markerInkInverse: '--marker-ink-inverse',
  markerFill: '--marker-fill',
  sceneSky: '--scene-sky',
  sceneBounce: '--scene-bounce',
  ink: '--ink',
  muted: '--muted',
};

/** Mirrors the token block in app/globals.css. Used before a document exists. */
const FALLBACK: ThemeTokens = {
  mapGround: '#00000000',
  mapFloor: '#2b2f36',
  mapFloorCut: '#4c4a55',
  mapWall: '#00000000',
  mapWallLine: '#00000000',
  mapOpenLine: '#6aa5ff',
  mapRoute: '#7cb2ff',
  mapAim: '#ffb84d',
  mapCamera: '#ffffff',
  mapKeyline: '#0b0d11',
  marker: '#2e6ecb',
  markerSelected: '#2e6ecb',
  markerInk: '#1b4f9c',
  markerInkInverse: '#ffffff',
  markerFill: '#f5f7fa',
  sceneSky: '#dfe7f5',
  sceneBounce: '#2a2620',
  ink: '#16161a',
  muted: '#5c6069',
};

let cached: ThemeTokens | null = null;

/**
 * The token block, read from the document.
 *
 * Cached: the app has one fixed theme (see the note at the top of globals.css
 * about why there is no light palette), so a second read can only ever return
 * the same strings, and this is called from inside a canvas redraw that already
 * runs on every camera move.
 */
export function theme(): ThemeTokens {
  if (cached) return cached;
  if (typeof document === 'undefined') return FALLBACK;

  const computed = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = computed.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };

  const resolved = {} as ThemeTokens;
  for (const key of Object.keys(VARS) as (keyof ThemeTokens)[]) {
    resolved[key] = read(VARS[key], FALLBACK[key]);
  }
  cached = resolved;
  return resolved;
}

/**
 * A token with an alpha applied, as an `rgba()` string for canvas.
 *
 * The aim wedges and the route casing are the same colour at several
 * strengths; expressing that as `alpha(t.mapAim, 0.3)` keeps one value in the
 * token block instead of four near-identical hexes scattered through the draw
 * code.
 */
export function alpha(colour: string, a: number): string {
  const [r, g, b] = toRgb(colour);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Parse `#rgb`, `#rrggbb` or `rgb()/rgba()` into channel bytes. */
export function toRgb(colour: string): [number, number, number] {
  const value = colour.trim();

  if (value.startsWith('#')) {
    const h = value.slice(1);
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
    const n = Number.parseInt(full.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const parts = value.match(/-?[\d.]+/g);
  if (parts && parts.length >= 3) {
    return [Number(parts[0]) | 0, Number(parts[1]) | 0, Number(parts[2]) | 0];
  }
  return [0, 0, 0];
}
