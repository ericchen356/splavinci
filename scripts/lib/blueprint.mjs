/**
 * Floor-plan renderer: a plan in metres -> an SVG drawing -> a PNG.
 *
 * SVG first, raster second, deliberately. The blueprint has to be legible to a
 * person (and to a vision model asked to describe the layout), which means real
 * type, hairline dimension lines and hatching - none of which survive being
 * plotted pixel by pixel into a hand-rolled PNG encoder, which is what the
 * previous version of this file did. Authoring vector and rasterising with a
 * browser that already has a text stack costs nothing and makes room labels
 * actually readable.
 *
 * Everything in a plan is in metres with x right and y down, matching the way
 * the rest of the repo talks about the floor plane. The one conversion to pixels
 * happens in `px()` here, so no caller ever thinks in screen units.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Drawing scale. 88 px/m puts a 12 m flat on a ~1250 px sheet. */
const PPM = 88;

// The bottom strip carries two rows: the title block, then the scale bar and
// legend beneath it. Stacking them rather than sitting them side by side is
// what keeps a narrow plan (8 m wide) from overprinting its own title.
const MARGIN = { left: 104, right: 104, top: 104, bottom: 236 };

const INK = {
  paper: '#f7f8fa',
  poche: '#151d2b',
  room: '#ffffff',
  roomAlt: '#eef2f7',
  label: '#1b2432',
  sub: '#6a7889',
  line: '#98a5b6',
  fixture: '#aab6c6',
  dim: '#7c8b9e',
  accent: '#3d5570',
};

const FONT = "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif";

/* -------------------------------------------------------------------------- */
/* plan authoring helpers                                                     */
/* -------------------------------------------------------------------------- */

/** Horizontal wall segment centred on `y`, from `x0` to `x1`. */
export const hWall = (x0, x1, y, t) => ({ x: x0, y: y - t / 2, w: x1 - x0, h: t });

/** Vertical wall segment centred on `x`, from `y0` to `y1`. */
export const vWall = (x, y0, y1, t) => ({ x: x - t / 2, y: y0, w: t, h: y1 - y0 });

/* -------------------------------------------------------------------------- */
/* svg primitives                                                             */
/* -------------------------------------------------------------------------- */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmt = (n) => (Math.round(n * 100) / 100).toString();

function makeCanvas(plan) {
  const [W, H] = plan.size;
  const width = Math.round(W * PPM) + MARGIN.left + MARGIN.right;
  const height = Math.round(H * PPM) + MARGIN.top + MARGIN.bottom;
  const px = (mx, my) => [MARGIN.left + mx * PPM, MARGIN.top + my * PPM];
  const len = (m) => m * PPM;
  return { width, height, px, len };
}

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Furniture is drawn as thin outlines rather than filled blocks.
 *
 * A plan whose furniture reads as solid as its walls is unreadable - the eye
 * cannot tell what is structure and what is a sofa, which is the one thing a
 * floor plan exists to communicate. Poché stays reserved for walls.
 */
function fixture(c, f) {
  const [x, y] = c.px(f.x, f.y);
  const w = c.len(f.w);
  const h = c.len(f.h);
  const parts = [];
  const stroke = `fill="none" stroke="${INK.fixture}" stroke-width="1.3"`;
  const soft = `fill="none" stroke="${INK.fixture}" stroke-width="1"`;
  const box = (rx = 2) =>
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${rx}" ${stroke}/>`;

  switch (f.kind) {
    case 'bed': {
      // Pillow band on the head edge tells you which way someone sleeps, which
      // is what makes a rectangle read as a bed rather than a table.
      const head = f.head ?? 'up';
      parts.push(box(3));
      const band = c.len(0.38);
      if (head === 'up') parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + band)}" x2="${fmt(x + w)}" y2="${fmt(y + band)}" ${soft}/>`);
      if (head === 'down') parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + h - band)}" x2="${fmt(x + w)}" y2="${fmt(y + h - band)}" ${soft}/>`);
      if (head === 'left') parts.push(`<line x1="${fmt(x + band)}" y1="${fmt(y)}" x2="${fmt(x + band)}" y2="${fmt(y + h)}" ${soft}/>`);
      if (head === 'right') parts.push(`<line x1="${fmt(x + w - band)}" y1="${fmt(y)}" x2="${fmt(x + w - band)}" y2="${fmt(y + h)}" ${soft}/>`);
      const fold = c.len(0.7);
      if (head === 'up') parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + h - fold)}" x2="${fmt(x + w)}" y2="${fmt(y + h - fold)}" ${soft}/>`);
      if (head === 'down') parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + fold)}" x2="${fmt(x + w)}" y2="${fmt(y + fold)}" ${soft}/>`);
      break;
    }
    case 'sofa': {
      const face = f.face ?? 'down';
      parts.push(box(4));
      const back = c.len(0.22);
      if (face === 'down') parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + back)}" x2="${fmt(x + w)}" y2="${fmt(y + back)}" ${soft}/>`);
      if (face === 'up') parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + h - back)}" x2="${fmt(x + w)}" y2="${fmt(y + h - back)}" ${soft}/>`);
      if (face === 'right') parts.push(`<line x1="${fmt(x + back)}" y1="${fmt(y)}" x2="${fmt(x + back)}" y2="${fmt(y + h)}" ${soft}/>`);
      if (face === 'left') parts.push(`<line x1="${fmt(x + w - back)}" y1="${fmt(y)}" x2="${fmt(x + w - back)}" y2="${fmt(y + h)}" ${soft}/>`);
      break;
    }
    case 'table': {
      parts.push(box(f.round ? Math.min(w, h) / 2 : 3));
      break;
    }
    case 'counter': {
      parts.push(box(1));
      // Worktop line, then sink and hob so a run of cabinets reads as a kitchen.
      for (const s of f.sinks ?? []) {
        const [sx, sy] = c.px(s[0], s[1]);
        parts.push(`<rect x="${fmt(sx - c.len(0.22))}" y="${fmt(sy - c.len(0.18))}" width="${fmt(c.len(0.44))}" height="${fmt(c.len(0.36))}" rx="3" ${soft}/>`);
      }
      for (const s of f.hobs ?? []) {
        const [sx, sy] = c.px(s[0], s[1]);
        const r = c.len(0.09);
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          parts.push(`<circle cx="${fmt(sx + dx * r * 1.2)}" cy="${fmt(sy + dy * r * 1.2)}" r="${fmt(r)}" ${soft}/>`);
        }
      }
      break;
    }
    case 'wardrobe': {
      parts.push(box(1));
      // Crossed diagonals: the standard shorthand for full-height storage.
      parts.push(`<line x1="${fmt(x)}" y1="${fmt(y)}" x2="${fmt(x + w)}" y2="${fmt(y + h)}" ${soft}/>`);
      parts.push(`<line x1="${fmt(x + w)}" y1="${fmt(y)}" x2="${fmt(x)}" y2="${fmt(y + h)}" ${soft}/>`);
      break;
    }
    case 'bath': {
      parts.push(box(6));
      const inset = c.len(0.09);
      parts.push(`<rect x="${fmt(x + inset)}" y="${fmt(y + inset)}" width="${fmt(w - inset * 2)}" height="${fmt(h - inset * 2)}" rx="5" ${soft}/>`);
      break;
    }
    case 'shower': {
      parts.push(box(1));
      parts.push(`<line x1="${fmt(x)}" y1="${fmt(y)}" x2="${fmt(x + w)}" y2="${fmt(y + h)}" ${soft}/>`);
      parts.push(`<line x1="${fmt(x + w)}" y1="${fmt(y)}" x2="${fmt(x)}" y2="${fmt(y + h)}" ${soft}/>`);
      break;
    }
    case 'wc': {
      parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h * 0.32)}" rx="2" ${soft}/>`);
      parts.push(`<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h * 0.66)}" rx="${fmt(w / 2)}" ry="${fmt(h * 0.34)}" ${stroke}/>`);
      break;
    }
    case 'basin': {
      parts.push(box(3));
      parts.push(`<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w * 0.32)}" ry="${fmt(h * 0.3)}" ${soft}/>`);
      break;
    }
    case 'rug': {
      parts.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="2" fill="none" stroke="${INK.fixture}" stroke-width="1" stroke-dasharray="5 4"/>`);
      break;
    }
    case 'stair': {
      // Treads plus a direction arrow; a loft with a mezzanine needs one.
      parts.push(box(1));
      const treads = f.treads ?? 8;
      for (let i = 1; i < treads; i++) {
        const t = i / treads;
        if (f.dir === 'v') parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + h * t)}" x2="${fmt(x + w)}" y2="${fmt(y + h * t)}" ${soft}/>`);
        else parts.push(`<line x1="${fmt(x + w * t)}" y1="${fmt(y)}" x2="${fmt(x + w * t)}" y2="${fmt(y + h)}" ${soft}/>`);
      }
      break;
    }
    default:
      parts.push(box(2));
  }
  return parts.join('');
}

/* -------------------------------------------------------------------------- */
/* openings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An opening is drawn by erasing the wall and then adding back the convention:
 * jamb ticks always, a leaf and a swing arc for a hinged door, three lines for
 * a window. Erasing beats trying to author walls as pre-split segments - the
 * wall stays one honest rectangle, and a door can be moved without re-cutting
 * its neighbours.
 */
function opening(c, o) {
  const t = o.t;
  const horizontal = o.dir === 'h';
  const [x, y] = horizontal ? c.px(o.x, o.y - t / 2) : c.px(o.x - t / 2, o.y);
  const w = horizontal ? c.len(o.len) : c.len(t);
  const h = horizontal ? c.len(t) : c.len(o.len);

  const parts = [
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${INK.room}"/>`,
  ];
  const jamb = `stroke="${INK.poche}" stroke-width="1.2"`;
  if (horizontal) {
    parts.push(`<line x1="${fmt(x)}" y1="${fmt(y)}" x2="${fmt(x)}" y2="${fmt(y + h)}" ${jamb}/>`);
    parts.push(`<line x1="${fmt(x + w)}" y1="${fmt(y)}" x2="${fmt(x + w)}" y2="${fmt(y + h)}" ${jamb}/>`);
  } else {
    parts.push(`<line x1="${fmt(x)}" y1="${fmt(y)}" x2="${fmt(x + w)}" y2="${fmt(y)}" ${jamb}/>`);
    parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + h)}" x2="${fmt(x + w)}" y2="${fmt(y + h)}" ${jamb}/>`);
  }

  if (o.kind === 'window') {
    const line = `stroke="${INK.accent}" stroke-width="1.2" fill="none"`;
    if (horizontal) {
      const mid = y + h / 2;
      parts.push(`<line x1="${fmt(x)}" y1="${fmt(mid)}" x2="${fmt(x + w)}" y2="${fmt(mid)}" ${line}/>`);
      parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + 1)}" x2="${fmt(x + w)}" y2="${fmt(y + 1)}" ${line}/>`);
      parts.push(`<line x1="${fmt(x)}" y1="${fmt(y + h - 1)}" x2="${fmt(x + w)}" y2="${fmt(y + h - 1)}" ${line}/>`);
    } else {
      const mid = x + w / 2;
      parts.push(`<line x1="${fmt(mid)}" y1="${fmt(y)}" x2="${fmt(mid)}" y2="${fmt(y + h)}" ${line}/>`);
      parts.push(`<line x1="${fmt(x + 1)}" y1="${fmt(y)}" x2="${fmt(x + 1)}" y2="${fmt(y + h)}" ${line}/>`);
      parts.push(`<line x1="${fmt(x + w - 1)}" y1="${fmt(y)}" x2="${fmt(x + w - 1)}" y2="${fmt(y + h)}" ${line}/>`);
    }
    return parts.join('');
  }

  if (o.kind === 'opening') return parts.join('');

  // Hinged door: leaf perpendicular to the wall, arc back to the far jamb.
  const s = o.hinge === 'end' ? -1 : 1;
  const d = o.swing === 'back' ? -1 : 1;
  const span = c.len(o.len);
  const [hx, hy] = horizontal
    ? c.px(o.hinge === 'end' ? o.x + o.len : o.x, o.y)
    : c.px(o.x, o.hinge === 'end' ? o.y + o.len : o.y);
  const tipX = horizontal ? hx : hx + d * span;
  const tipY = horizontal ? hy + d * span : hy;
  const jambX = horizontal ? hx + s * span : hx;
  const jambY = horizontal ? hy : hy + s * span;
  const sweep = (horizontal ? s * d : -s * d) > 0 ? 1 : 0;

  parts.push(
    `<path d="M ${fmt(jambX)} ${fmt(jambY)} A ${fmt(span)} ${fmt(span)} 0 0 ${sweep} ${fmt(tipX)} ${fmt(tipY)}" ` +
      `fill="none" stroke="${INK.line}" stroke-width="1" stroke-dasharray="4 3"/>`,
  );
  parts.push(
    `<line x1="${fmt(hx)}" y1="${fmt(hy)}" x2="${fmt(tipX)}" y2="${fmt(tipY)}" stroke="${INK.label}" stroke-width="2"/>`,
  );
  return parts.join('');
}

/* -------------------------------------------------------------------------- */
/* annotation                                                                 */
/* -------------------------------------------------------------------------- */

function roomLabel(c, room) {
  const cx = room.labelAt ? room.labelAt[0] : room.x + room.w / 2;
  const cy = room.labelAt ? room.labelAt[1] : room.y + room.h / 2;
  const [x, y] = c.px(cx, cy);
  const area = room.area ?? room.w * room.h;
  const size = room.small ? 14 : 17;
  const name = `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="middle" font-family="${FONT}" ` +
    `font-size="${size}" font-weight="600" letter-spacing="0.03em" fill="${INK.label}">${esc(room.name)}</text>`;
  if (room.noArea) return name;
  const sub = `<text x="${fmt(x)}" y="${fmt(y + size + 4)}" text-anchor="middle" font-family="${FONT}" ` +
    `font-size="${size - 4}" fill="${INK.sub}">${area.toFixed(1)} m²</text>`;
  return name + sub;
}

/** Dimension string with arrow ticks, outside the plan. */
function dimension(c, dim) {
  const parts = [];
  const stroke = `stroke="${INK.dim}" stroke-width="1"`;
  if (dim.dir === 'h') {
    const [x0, y] = c.px(dim.from, dim.at);
    const [x1] = c.px(dim.to, dim.at);
    parts.push(`<line x1="${fmt(x0)}" y1="${fmt(y)}" x2="${fmt(x1)}" y2="${fmt(y)}" ${stroke}/>`);
    for (const x of [x0, x1]) {
      parts.push(`<line x1="${fmt(x)}" y1="${fmt(y - 6)}" x2="${fmt(x)}" y2="${fmt(y + 6)}" ${stroke}/>`);
    }
    parts.push(
      `<text x="${fmt((x0 + x1) / 2)}" y="${fmt(y - 9)}" text-anchor="middle" font-family="${FONT}" ` +
        `font-size="13" fill="${INK.dim}">${(dim.to - dim.from).toFixed(2)} m</text>`,
    );
  } else {
    const [x, y0] = c.px(dim.at, dim.from);
    const [, y1] = c.px(dim.at, dim.to);
    parts.push(`<line x1="${fmt(x)}" y1="${fmt(y0)}" x2="${fmt(x)}" y2="${fmt(y1)}" ${stroke}/>`);
    for (const y of [y0, y1]) {
      parts.push(`<line x1="${fmt(x - 6)}" y1="${fmt(y)}" x2="${fmt(x + 6)}" y2="${fmt(y)}" ${stroke}/>`);
    }
    parts.push(
      `<text x="${fmt(x - 9)}" y="${fmt((y0 + y1) / 2)}" text-anchor="middle" font-family="${FONT}" ` +
        `font-size="13" fill="${INK.dim}" transform="rotate(-90 ${fmt(x - 9)} ${fmt((y0 + y1) / 2)})">` +
        `${(dim.to - dim.from).toFixed(2)} m</text>`,
    );
  }
  return parts.join('');
}

/**
 * How many metres the scale bar shows.
 *
 * Five, unless the sheet is too narrow to fit the legend beside a five-metre
 * bar - which a 5.4 m frontage drawn at 88 px/m is. Shortening the bar is the
 * cheap fix; the alternative is stacking the legend under it and growing the
 * bottom margin, which moves the title block on every existing plan.
 */
function scaleMetres(c) {
  // Legend block measured from the end of the bar: 56 px gap, three items on a
  // 92 px pitch, and roughly 60 px for the last swatch and its label.
  const legendWidth = 56 + 2 * 92 + 90;
  for (const metres of [5, 4, 3, 2]) {
    if (MARGIN.left + metres * PPM + legendWidth + 24 <= c.width) return metres;
  }
  return 2;
}

/** Alternating 1 m blocks. The one element that makes the drawing measurable. */
function scaleBar(c, plan) {
  const metres = scaleMetres(c);
  const x0 = MARGIN.left;
  const y0 = MARGIN.top + plan.size[1] * PPM + 176;
  const h = 11;
  const parts = [
    `<text x="${fmt(x0)}" y="${fmt(y0 - 13)}" font-family="${FONT}" font-size="12" letter-spacing="0.09em" ` +
      `fill="${INK.sub}">SCALE</text>`,
  ];
  for (let i = 0; i < metres; i++) {
    parts.push(
      `<rect x="${fmt(x0 + i * PPM)}" y="${fmt(y0)}" width="${fmt(PPM)}" height="${h}" ` +
        `fill="${i % 2 ? INK.paper : INK.poche}" stroke="${INK.poche}" stroke-width="1"/>`,
    );
  }
  for (let i = 0; i <= metres; i++) {
    parts.push(
      `<text x="${fmt(x0 + i * PPM)}" y="${fmt(y0 + h + 16)}" text-anchor="middle" font-family="${FONT}" ` +
        `font-size="12" fill="${INK.sub}">${i}</text>`,
    );
  }
  parts.push(
    `<text x="${fmt(x0 + metres * PPM + 14)}" y="${fmt(y0 + h + 16)}" font-family="${FONT}" font-size="12" ` +
      `fill="${INK.sub}">metres</text>`,
  );
  return parts.join('');
}

function northArrow(c, plan) {
  const [x, y] = c.px(plan.size[0] + 0.52, 0.55);
  return (
    `<g transform="translate(${fmt(x)} ${fmt(y)})">` +
    `<circle r="20" fill="none" stroke="${INK.line}" stroke-width="1"/>` +
    `<path d="M 0 -16 L 7 10 L 0 4 L -7 10 Z" fill="${INK.poche}"/>` +
    `<text x="0" y="-24" text-anchor="middle" font-family="${FONT}" font-size="12" ` +
    `font-weight="600" fill="${INK.label}">N</text></g>`
  );
}

function titleBlock(c, plan) {
  const right = c.width - MARGIN.right;
  const y0 = MARGIN.top + plan.size[1] * PPM + 66;
  const total = plan.rooms.reduce((sum, r) => sum + (r.area ?? r.w * r.h), 0);
  const lines = [
    [plan.name, 19, 600, INK.label],
    [plan.subtitle, 13, 400, INK.sub],
    [
      `${total.toFixed(0)} m² internal · ${plan.ceiling.toFixed(2)} m clear ceiling · ` +
        `${plan.rooms.length} labelled spaces`,
      12,
      400,
      INK.sub,
    ],
    [`Scene id ${plan.id} · drawn 1:50 · dimensions to structure`, 12, 400, INK.sub],
  ];
  const parts = [
    `<line x1="${fmt(right - 470)}" y1="${fmt(y0 - 22)}" x2="${fmt(right)}" y2="${fmt(y0 - 22)}" ` +
      `stroke="${INK.line}" stroke-width="1"/>`,
  ];
  let y = y0;
  for (const [text, size, weight, fill] of lines) {
    parts.push(
      `<text x="${fmt(right)}" y="${fmt(y)}" text-anchor="end" font-family="${FONT}" font-size="${size}" ` +
        `font-weight="${weight}" fill="${fill}">${esc(text)}</text>`,
    );
    y += size + 8;
  }
  return parts.join('');
}

function legend(c, plan) {
  const x = MARGIN.left + scaleMetres(c) * PPM + 56;
  const y = MARGIN.top + plan.size[1] * PPM + 176;
  const items = [
    ['Wall', `<rect x="0" y="2" width="22" height="8" fill="${INK.poche}"/>`],
    ['Door', `<path d="M 0 10 A 14 14 0 0 1 14 -4" fill="none" stroke="${INK.line}" stroke-width="1" stroke-dasharray="4 3"/><line x1="0" y1="10" x2="0" y2="-4" stroke="${INK.label}" stroke-width="2"/>`],
    ['Window', `<line x1="0" y1="6" x2="22" y2="6" stroke="${INK.accent}" stroke-width="1.2"/><line x1="0" y1="2" x2="22" y2="2" stroke="${INK.accent}" stroke-width="1.2"/><line x1="0" y1="10" x2="22" y2="10" stroke="${INK.accent}" stroke-width="1.2"/>`],
  ];
  const parts = [
    `<text x="${fmt(x)}" y="${fmt(y - 13)}" font-family="${FONT}" font-size="12" letter-spacing="0.09em" ` +
      `fill="${INK.sub}">LEGEND</text>`,
  ];
  let dx = 0;
  for (const [label, art] of items) {
    parts.push(`<g transform="translate(${fmt(x + dx)} ${fmt(y)})">${art}</g>`);
    parts.push(
      `<text x="${fmt(x + dx + 30)}" y="${fmt(y + 11)}" font-family="${FONT}" font-size="12" ` +
        `fill="${INK.sub}">${esc(label)}</text>`,
    );
    dx += 92;
  }
  return parts.join('');
}

/* -------------------------------------------------------------------------- */
/* the drawing                                                                */
/* -------------------------------------------------------------------------- */

export function planToSvg(plan) {
  const c = makeCanvas(plan);
  const layers = [];

  layers.push(`<rect width="${c.width}" height="${c.height}" fill="${INK.paper}"/>`);
  layers.push(
    `<rect x="18" y="18" width="${c.width - 36}" height="${c.height - 36}" fill="none" ` +
      `stroke="${INK.line}" stroke-width="1"/>`,
  );

  // Room floors under everything, so walls and furniture sit on top of them.
  for (const room of plan.rooms) {
    const [x, y] = c.px(room.x, room.y);
    layers.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(c.len(room.w))}" height="${fmt(c.len(room.h))}" ` +
        `fill="${room.tint ? INK.roomAlt : INK.room}"/>`,
    );
  }

  // Dashed zone outlines: how an open-plan space is divided in use rather than
  // by structure. Only a loft needs them, but nothing breaks if a plan has none.
  for (const zone of plan.zones ?? []) {
    const [x, y] = c.px(zone.x, zone.y);
    layers.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(c.len(zone.w))}" height="${fmt(c.len(zone.h))}" ` +
        `fill="none" stroke="${INK.line}" stroke-width="1" stroke-dasharray="7 6"/>`,
    );
  }

  for (const wall of plan.walls) {
    const [x, y] = c.px(wall.x, wall.y);
    layers.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(c.len(wall.w))}" height="${fmt(c.len(wall.h))}" ` +
        `fill="${INK.poche}"/>`,
    );
  }

  // Half-height partitions read as structure but must not read as full walls,
  // or the plan says "separate room" where the brief says "open plan".
  for (const low of plan.lowWalls ?? []) {
    const [x, y] = c.px(low.x, low.y);
    layers.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(c.len(low.w))}" height="${fmt(c.len(low.h))}" ` +
        `fill="${INK.roomAlt}" stroke="${INK.poche}" stroke-width="1.4"/>`,
    );
  }

  for (const o of plan.openings) layers.push(opening(c, o));
  for (const f of plan.fixtures ?? []) layers.push(fixture(c, f));

  for (const [cx, cy] of plan.columns ?? []) {
    const [x, y] = c.px(cx, cy);
    layers.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(c.len(0.17))}" fill="${INK.poche}"/>`);
  }

  for (const room of plan.rooms) layers.push(roomLabel(c, room));

  for (const note of plan.notes ?? []) {
    const [x, y] = c.px(note.x, note.y);
    layers.push(
      `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${note.anchor ?? 'middle'}" font-family="${FONT}" ` +
        `font-size="12" font-style="italic" fill="${INK.sub}">${esc(note.text)}</text>`,
    );
  }

  for (const dim of plan.dimensions ?? []) layers.push(dimension(c, dim));

  layers.push(northArrow(c, plan));
  layers.push(scaleBar(c, plan));
  layers.push(legend(c, plan));
  layers.push(titleBlock(c, plan));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}" ` +
    `viewBox="0 0 ${c.width} ${c.height}">\n${layers.join('\n')}\n</svg>\n`
  );
}

export function svgSize(svg) {
  const w = /width="(\d+)"/.exec(svg);
  const h = /height="(\d+)"/.exec(svg);
  return { width: Number(w?.[1] ?? 0), height: Number(h?.[1] ?? 0) };
}

/* -------------------------------------------------------------------------- */
/* rasterise                                                                  */
/* -------------------------------------------------------------------------- */

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function which(bin) {
  try {
    return execFileSync('command', ['-v', bin], { shell: '/bin/sh', encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * SVG -> PNG with whatever this machine has.
 *
 * Returns the tool used, or null if none was found. A missing rasteriser is not
 * fatal: the SVG is the authored artefact and the PNG is a convenience, so the
 * caller warns rather than failing a fixture build on a machine without a
 * browser installed.
 */
export function rasterise(svgPath, pngPath, { width, height, scale = 2 }) {
  const chrome = CHROME_PATHS.find((p) => existsSync(p));
  if (chrome) {
    // Chrome writes the screenshot next to nothing predictable when the output
    // path contains spaces, so it renders into a temp dir and is moved after.
    const work = mkdtempSync(join(tmpdir(), 'blueprint-'));
    const shot = join(work, 'out.png');
    try {
      execFileSync(
        chrome,
        [
          '--headless',
          '--disable-gpu',
          '--no-sandbox',
          '--hide-scrollbars',
          `--force-device-scale-factor=${scale}`,
          `--screenshot=${shot}`,
          `--window-size=${width},${height}`,
          `file://${svgPath}`,
        ],
        { stdio: 'ignore' },
      );
      renameSync(shot, pngPath);
      return 'chrome';
    } catch {
      return null;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  for (const [bin, args] of [
    ['rsvg-convert', ['-w', String(width * scale), '-o', pngPath, svgPath]],
    ['inkscape', [`--export-filename=${pngPath}`, `--export-width=${width * scale}`, svgPath]],
  ]) {
    if (!which(bin)) continue;
    try {
      execFileSync(bin, args, { stdio: 'ignore' });
      return bin;
    } catch {
      /* try the next one */
    }
  }
  return null;
}
